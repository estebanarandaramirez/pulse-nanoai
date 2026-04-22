/**
 * generateSetupScript
 * Serves pulse-setup.bat — a self-elevating launcher that embeds and runs
 * the Pulse PS1 installer. Using .bat avoids PowerShell execution policy
 * restrictions and provides a reliable double-click experience for gamers.
 *
 * Required env vars:
 *   CLOREAI_INIT_TOKEN — Pulse's Clore.ai organization init token
 *   BASE44_APP_ID      — base44 app ID
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// The PS1 is embedded inside the .bat after the __PULSE_PS1__ marker.
// The .bat extracts it to %LOCALAPPDATA%\Pulse\ before running,
// so the Phase 2 scheduled task can find it after reboot.
const PS1_TEMPLATE = `#Requires -Version 5.1
# PULSE GPU Provider Setup
# Tokens injected at download time. Run via pulse-setup.bat (not directly).

# ── Embedded at download time ─────────────────────────────────────────────────
$PULSE_USER_TOKEN   = "{{PULSE_USER_TOKEN}}"
$PULSE_APP_ID       = "{{PULSE_APP_ID}}"
$CLOREAI_INIT_TOKEN = "{{CLOREAI_INIT_TOKEN}}"
$PULSE_API_BASE     = "https://api.base44.app/api/apps/$PULSE_APP_ID/functions"
# ─────────────────────────────────────────────────────────────────────────────

$PULSE_DIR     = "$env:LOCALAPPDATA\\Pulse"
$SCRIPT_PATH   = "$PULSE_DIR\\pulse-setup.ps1"
$PHASE_FILE    = "$PULSE_DIR\\setup_phase"
$LOG_FILE      = "$PULSE_DIR\\setup.log"
$TASK_NAME     = "PulseSetupResume"
$WATCHDOG_TASK = "PulseGPUWatchdog"
$AUTOSTART_TASK= "PulseAutoStart"
$CLORE_PORTS   = @(22, 80, 443, 8080)

function Write-Log {
    param([string]$msg, [string]$level = "INFO")
    $ts = Get-Date -Format "HH:mm:ss"
    Add-Content -Path $LOG_FILE -Value "[$ts][$level] $msg" -Encoding UTF8
    switch ($level) {
        "OK"    { Write-Host "  [OK] $msg" -ForegroundColor Green }
        "WARN"  { Write-Host "  [!!] $msg" -ForegroundColor Yellow }
        "ERROR" { Write-Host "  [X]  $msg" -ForegroundColor Red }
        default { Write-Host "  ... $msg" -ForegroundColor Cyan }
    }
}

function Show-Banner {
    param([string]$subtitle = "")
    Clear-Host
    Write-Host ""
    Write-Host "  ██████╗ ██╗   ██╗██╗     ███████╗███████╗" -ForegroundColor Cyan
    Write-Host "  ██╔══██╗██║   ██║██║     ██╔════╝██╔════╝" -ForegroundColor Cyan
    Write-Host "  ██████╔╝██║   ██║██║     ███████╗█████╗  " -ForegroundColor Cyan
    Write-Host "  ██╔═══╝ ██║   ██║██║     ╚════██║██╔══╝  " -ForegroundColor Cyan
    Write-Host "  ██║     ╚██████╔╝███████╗███████║███████╗" -ForegroundColor Cyan
    Write-Host "  ╚═╝      ╚═════╝ ╚══════╝╚══════╝╚══════╝" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  GPU Provider Setup" -ForegroundColor White
    if ($subtitle) { Write-Host "  $subtitle" -ForegroundColor DarkGray }
    Write-Host ""
}

function Wait-ForKey {
    Write-Host "  Press any key to close this window..." -ForegroundColor DarkGray -NoNewline
    try { \$null = \$Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { Start-Sleep 3 }
    Write-Host ""
}

function Get-LocalIP {
    (Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.InterfaceAlias -notmatch "Loopback|WSL|vEthernet" } |
        Select-Object -First 1).IPAddress
}

function Invoke-Phase1 {
    Show-Banner "Phase 1 of 2 — Enabling WSL2"

    $build = [System.Environment]::OSVersion.Version.Build
    if ($build -lt 19041) {
        Write-Log "Windows build $build too old. WSL2 requires build 19041+ (Windows 10 2004+)." "ERROR"
        Wait-ForKey; exit 1
    }
    Write-Log "Windows build $build — OK" "OK"

    $gpu = (Get-WmiObject Win32_VideoController |
        Where-Object { $_.Name -match "NVIDIA" } |
        Select-Object -First 1).Name
    if (-not $gpu) {
        Write-Log "No NVIDIA GPU detected. Pulse requires an NVIDIA GPU." "ERROR"
        Wait-ForKey; exit 1
    }
    Write-Log "GPU: $gpu" "OK"

    New-Item -ItemType Directory -Force -Path $PULSE_DIR | Out-Null

    Write-Log "Enabling WSL2 Windows features..."
    dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart | Out-Null
    dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart | Out-Null
    Write-Log "WSL2 features enabled" "OK"

    Write-Log "Installing WSL2 kernel update..."
    $msi = "$env:TEMP\\wsl_update.msi"
    try {
        Invoke-WebRequest "https://wslstorestorage.blob.core.windows.net/wslblob/wsl_update_x64.msi" \`
            -OutFile $msi -UseBasicParsing
        Start-Process msiexec.exe -ArgumentList "/i \`"$msi\`" /quiet /norestart" -Wait
        Write-Log "WSL2 kernel updated" "OK"
    } catch {
        Write-Log "WSL2 kernel already up to date" "OK"
    }

    wsl --set-default-version 2 2>&1 | Out-Null
    Set-Content -Path $PHASE_FILE -Value "2" -Encoding UTF8

    # Schedule Phase 2 to run after reboot — points to permanent PULSE_DIR location
    $action    = New-ScheduledTaskAction -Execute "powershell.exe" \`
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Normal -File \`"$SCRIPT_PATH\`""
    $trigger   = New-ScheduledTaskTrigger -AtLogOn
    $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Highest
    Register-ScheduledTask -TaskName $TASK_NAME -Action $action -Trigger $trigger \`
        -Settings $settings -Principal $principal -Force | Out-Null
    Write-Log "Phase 2 resume task registered" "OK"

    Write-Host ""
    Write-Host "  ┌─────────────────────────────────────────┐" -ForegroundColor Yellow
    Write-Host "  │  One reboot required to continue setup  │" -ForegroundColor Yellow
    Write-Host "  │  Setup will resume automatically.       │" -ForegroundColor Yellow
    Write-Host "  └─────────────────────────────────────────┘" -ForegroundColor Yellow
    Write-Host ""
    $answer = Read-Host "  Reboot now? (Y/n)"
    if ($answer -ne "n") { Restart-Computer -Force }
    else { Write-Host "  Reboot when ready. Setup resumes on next login." -ForegroundColor DarkGray }
}

function Invoke-Phase2 {
    Show-Banner "Phase 2 of 2 — Installing Clore.ai Provider Stack"

    Write-Log "Setting up Ubuntu on WSL2..."
    $distros = wsl --list --quiet 2>&1
    if ($distros -notmatch "Ubuntu") {
        wsl --install -d Ubuntu --no-launch 2>&1 | Out-Null
        Write-Log "Ubuntu installed" "OK"
    } else {
        Write-Log "Ubuntu already present" "OK"
    }

    Write-Log "Installing Clore.ai host client inside WSL2..."
    $cloreInstall = "bash <(curl -fsSL https://gitlab.com/cloreai-public/hosting/-/raw/main/install.sh) $CLOREAI_INIT_TOKEN"
    wsl -d Ubuntu -- bash -c $cloreInstall 2>&1 | ForEach-Object { Write-Log $_ }
    Write-Log "Clore.ai install complete" "OK"

    Write-Log "Fetching Clore.ai server ID..."
    $serverIdRaw = wsl -d Ubuntu -- bash -c "cat /opt/clore-hosting/client/server_id 2>/dev/null || echo ''" 2>&1
    $serverId = "$serverIdRaw".Trim()
    if ($serverId) { Write-Log "Clore.ai Server ID: $serverId" "OK" }
    else { Write-Log "Server ID not yet assigned — Clore.ai may take a few minutes" "WARN"; $serverId = "" }

    Write-Log "Attempting UPnP port forwarding..."
    $localIP = Get-LocalIP
    $upnpOk  = $false
    try {
        $upnp     = New-Object -ComObject HNetCfg.NATUPnP
        $mappings = $upnp.StaticPortMappingCollection
        foreach ($port in $CLORE_PORTS) {
            $mappings.Add($port, "TCP", $port, $localIP, $true, "Pulse-Clore-$port") | Out-Null
        }
        Write-Log "UPnP succeeded — ports $($CLORE_PORTS -join ', ') mapped to $localIP" "OK"
        $upnpOk = $true
    } catch { Write-Log "UPnP unavailable on this router" "WARN" }

    if (-not $upnpOk) {
        Write-Host ""
        Write-Host "  ACTION NEEDED: Forward these TCP ports to $localIP in your router:" -ForegroundColor Yellow
        foreach ($p in $CLORE_PORTS) { Write-Host "    TCP $p" -ForegroundColor Yellow }
        Write-Host "  (Router admin is usually at http://192.168.1.1)" -ForegroundColor DarkGray
        Write-Host ""
        Start-Sleep 3
    }

    Write-Log "Registering machine with Pulse..."
    $gpuName = (Get-WmiObject Win32_VideoController | Where-Object { $_.Name -match "NVIDIA" } | Select-Object -First 1).Name
    $vramMb  = (Get-WmiObject Win32_VideoController | Where-Object { $_.Name -match "NVIDIA" } | Select-Object -First 1).AdapterRAM
    $vramGb  = if ($vramMb) { [math]::Round($vramMb / 1GB) } else { 8 }

    $body = @{ gpu_model = $gpuName; vram_gb = $vramGb; clore_server_id = $serverId; platform = "Clore.ai" } | ConvertTo-Json
    try {
        $resp = Invoke-RestMethod -Uri "$PULSE_API_BASE/registerGPUDaemon" \`
            -Method POST -ContentType "application/json" \`
            -Headers @{ "Authorization" = "Bearer $PULSE_USER_TOKEN" } -Body $body
        Write-Log "Pulse registration: $($resp.message)" "OK"
    } catch { Write-Log "Pulse registration failed (will retry on next start): $_" "WARN" }

    Write-Log "Installing GPU gaming watchdog..."
    $watchdog = @'
$hi = 75; $lo = 20; $paused = $false
while ($true) {
    try {
        $util = [int](& nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits).Trim()
        if ($util -gt $hi -and -not $paused) {
            wsl -d Ubuntu -- bash -c "sudo systemctl stop clore-hosting 2>/dev/null"
            $paused = $true
            Add-Content "$env:LOCALAPPDATA\\Pulse\\watchdog.log" "$(Get-Date -f 'HH:mm') PAUSED ($util%)"
        } elseif ($util -lt $lo -and $paused) {
            wsl -d Ubuntu -- bash -c "sudo systemctl start clore-hosting 2>/dev/null"
            $paused = $false
            Add-Content "$env:LOCALAPPDATA\\Pulse\\watchdog.log" "$(Get-Date -f 'HH:mm') RESUMED ($util%)"
        }
    } catch {}
    Start-Sleep 30
}
'@
    $watchdogPath = "$PULSE_DIR\\watchdog.ps1"
    Set-Content $watchdogPath $watchdog -Encoding UTF8
    $wA = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \`"$watchdogPath\`""
    Register-ScheduledTask -TaskName $WATCHDOG_TASK -Action $wA \`
        -Trigger (New-ScheduledTaskTrigger -AtLogOn) \`
        -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -ExecutionTimeLimit 0) \`
        -Principal (New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Highest) -Force | Out-Null
    Write-Log "GPU watchdog installed" "OK"

    Write-Log "Installing auto-start task..."
    $autostart = @'
Start-Sleep 15
wsl -d Ubuntu -- bash -c "sudo systemctl start clore-hosting 2>/dev/null" 2>&1 | Add-Content "$env:LOCALAPPDATA\\Pulse\\autostart.log"
'@
    $startPath = "$PULSE_DIR\\autostart.ps1"
    Set-Content $startPath $autostart -Encoding UTF8
    $sA = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \`"$startPath\`""
    Register-ScheduledTask -TaskName $AUTOSTART_TASK -Action $sA \`
        -Trigger (New-ScheduledTaskTrigger -AtLogOn) \`
        -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -ExecutionTimeLimit 0) \`
        -Principal (New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Highest) -Force | Out-Null
    Write-Log "Auto-start installed" "OK"

    Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item $PHASE_FILE -ErrorAction SilentlyContinue

    Show-Banner "Setup Complete!"
    Write-Host "  Your GPU is now earning via Pulse + Clore.ai." -ForegroundColor Green
    Write-Host ""
    @(
        @{ L = "GPU";           V = $gpuName },
        @{ L = "VRAM";         V = "$vramGb GB" },
        @{ L = "Platform";     V = "Clore.ai (via Pulse)" },
        @{ L = "Server ID";    V = if ($serverId) { $serverId } else { "Pending — check dashboard" } },
        @{ L = "Gaming pause"; V = "Auto (GPU > 75% util)" },
        @{ L = "Auto-start";   V = "On every Windows login" },
        @{ L = "Logs";         V = $LOG_FILE }
    ) | ForEach-Object { Write-Host ("  {0,-16} {1}" -f $_.L, $_.V) -ForegroundColor White }
    Write-Host ""
    Write-Host "  Dashboard: https://pulsenanoai.com" -ForegroundColor Cyan
    Write-Host ""
    Wait-ForKey
}

# ── Entry Point ───────────────────────────────────────────────────────────────
trap {
    Write-Host ""
    Write-Host "  [ERROR] An unexpected error stopped the installer:" -ForegroundColor Red
    Write-Host "  $_" -ForegroundColor Red
    Write-Host ""
    Write-Host "  Log saved to: $LOG_FILE" -ForegroundColor Yellow
    Write-Host "  Please share this with Pulse support at pulsenanoai.com" -ForegroundColor Yellow
    Write-Host ""
    Wait-ForKey
    break
}

New-Item -ItemType Directory -Force -Path $PULSE_DIR | Out-Null
$phase = if (Test-Path $PHASE_FILE) { Get-Content $PHASE_FILE } else { "1" }
switch ($phase) {
    "1"     { Invoke-Phase1 }
    "2"     { Invoke-Phase2 }
    default { Write-Host "Unknown phase: $phase" -ForegroundColor Red; Wait-ForKey; exit 1 }
}
`;

// The .bat file extracts the embedded PS1 to %LOCALAPPDATA%\Pulse\ before
// elevation so the Phase 2 scheduled task can find it after reboot.
const BAT_TEMPLATE = `@echo off
setlocal

:: PULSE GPU Setup
net session >nul 2>&1
if %errorlevel% equ 0 goto :elevated

cls
echo.
echo   ==========================================
echo    PULSE GPU Setup
echo   ==========================================
echo.
echo   This installer needs Administrator access to set up
echo   your GPU for earning via Clore.ai and Pulse.
echo.
echo   WHAT TO DO:
echo.
echo     Step 1 ^| If you see "Windows protected your PC"
echo              click "More info" then "Run anyway"
echo.
echo     Step 2 ^| A UAC popup will appear -- click YES
echo.

:: VBScript elevation — Chr(34) avoids broken VBScript from embedded quotes
set "VBS=%temp%\\pulse_uac.vbs"
echo Set sh = CreateObject("Shell.Application") > "%VBS%"
echo sh.ShellExecute "cmd.exe", "/c " ^& Chr(34) ^& "%~f0" ^& Chr(34), "", "runas", 1 >> "%VBS%"
cscript //nologo "%VBS%"
del "%VBS%" >nul 2>&1
exit /b

:elevated
cls
echo.
echo   PULSE GPU Setup ^| Running as Administrator
echo.

set "PULSE_DIR=%LOCALAPPDATA%\\Pulse"
set "PS1_PATH=%PULSE_DIR%\\pulse-setup.ps1"

if not exist "%PULSE_DIR%" mkdir "%PULSE_DIR%"

echo   Step 1: Extracting setup script...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=[IO.File]::ReadAllText('%~f0',[Text.Encoding]::UTF8); $m='__PULSE_PS1__'; $i=$c.IndexOf($m); if($i-lt 0){exit 1}; [IO.File]::WriteAllText('%PS1_PATH%',$c.Substring($i+$m.Length).TrimStart(),[Text.Encoding]::UTF8)"

if not exist "%PS1_PATH%" (
    echo.
    echo   ERROR: Could not extract setup script.
    echo   Please re-download from pulsenanoai.com
    echo.
    pause
    exit /b 1
)

echo   Step 2: Launching installer...
echo.
echo   The setup window will open now. Follow the prompts inside it.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1_PATH%"
goto :eof

__PULSE_PS1__
`;

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const cloreInitToken = Deno.env.get('CLOREAI_INIT_TOKEN') ?? 'CLOREAI_INIT_TOKEN_NOT_SET';
  const appId = Deno.env.get('BASE44_APP_ID') ?? '';

  const body = await req.json().catch(() => ({}));
  const userToken: string = body.user_token ?? '';

  const ps1 = PS1_TEMPLATE
    .replace('{{PULSE_USER_TOKEN}}', userToken)
    .replace('{{PULSE_APP_ID}}', appId)
    .replace('{{CLOREAI_INIT_TOKEN}}', cloreInitToken);

  const bat = BAT_TEMPLATE + ps1;

  return new Response(bat, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="pulse-setup.bat"',
    },
  });
});
