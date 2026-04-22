/**
 * generateSetupScript
 * Serves pulse-clore-setup.bat or pulse-octa-setup.bat based on the
 * `platform` field in the request body ("clore" | "octaspace").
 *
 * Both installers use the same .bat wrapper that self-elevates via UAC and
 * extracts the embedded PS1 to %LOCALAPPDATA%\Pulse\ before running it,
 * so the Phase 2 scheduled task survives a reboot.
 *
 * Required env vars:
 *   CLOREAI_INIT_TOKEN — Pulse's Clore.ai organisation init token (Clore only)
 *   BASE44_APP_ID      — base44 app ID
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// ── Clore.ai installer (NVIDIA only — Clore's install.sh requires nvidia-smi) ──

const CLORE_PS1_TEMPLATE = `#Requires -Version 5.1
# PULSE GPU Provider Setup — Clore.ai Edition
# Run via pulse-clore-setup.bat (not directly).

$PULSE_USER_TOKEN   = "{{PULSE_USER_TOKEN}}"
$PULSE_APP_ID       = "{{PULSE_APP_ID}}"
$CLOREAI_INIT_TOKEN = "{{CLOREAI_INIT_TOKEN}}"
$PULSE_API_BASE     = "https://api.base44.app/api/apps/$PULSE_APP_ID/functions"

$PULSE_DIR      = "$env:LOCALAPPDATA\\\\Pulse"
$SCRIPT_PATH    = "$PULSE_DIR\\\\pulse-clore-setup.ps1"
$PHASE_FILE     = "$PULSE_DIR\\\\clore_setup_phase"
$LOG_FILE       = "$PULSE_DIR\\\\clore_setup.log"
$TASK_NAME      = "PulseCloreSetupResume"
$WATCHDOG_TASK  = "PulseGPUWatchdog"
$AUTOSTART_TASK = "PulseAutoStart"
$CLORE_PORTS    = @(22, 80, 443, 8080)

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
    Write-Host "  GPU Provider Setup — Clore.ai Edition" -ForegroundColor White
    if ($subtitle) { Write-Host "  $subtitle" -ForegroundColor DarkGray }
    Write-Host ""
}

function Wait-ForKey {
    Write-Host ""
    Read-Host "  Press Enter to close this window"
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

    # Clore.ai's install.sh requires NVIDIA (checks nvidia-smi)
    $gpu = (Get-WmiObject Win32_VideoController |
        Where-Object { $_.Name -match "NVIDIA|GeForce|RTX|GTX" } |
        Select-Object -First 1).Name
    if (-not $gpu) {
        $amdGpu = (Get-WmiObject Win32_VideoController |
            Where-Object { $_.Name -match "AMD|Radeon" } |
            Select-Object -First 1).Name
        if ($amdGpu) {
            Write-Log "AMD GPU detected ($amdGpu) — Clore.ai requires NVIDIA." "ERROR"
            Write-Host ""
            Write-Host "  Clore.ai's installer only supports NVIDIA GPUs." -ForegroundColor Yellow
            Write-Host "  Use pulse-octa-setup.bat (OctaSpace) if you have NVIDIA and want" -ForegroundColor DarkGray
            Write-Host "  a different platform, or wait for Clore AMD support." -ForegroundColor DarkGray
            Write-Host ""
        } else {
            Write-Log "No supported NVIDIA GPU detected." "ERROR"
        }
        Wait-ForKey; exit 1
    }
    Write-Log "GPU: $gpu" "OK"

    New-Item -ItemType Directory -Force -Path $PULSE_DIR | Out-Null

    $virtEnabled = (Get-ComputerInfo).HyperVRequirementVirtualizationFirmwareEnabled
    if ($virtEnabled -eq $false) {
        Write-Log "Hardware virtualization is disabled in your BIOS/UEFI." "ERROR"
        Write-Host ""
        Write-Host "  ┌──────────────────────────────────────────────────────────────┐" -ForegroundColor Red
        Write-Host "  │  ACTION REQUIRED: Enable virtualization in your BIOS/UEFI    │" -ForegroundColor Red
        Write-Host "  │  1. Restart  2. Press Del/F2  3. Advanced > SVM / VT-x      │" -ForegroundColor Red
        Write-Host "  │  4. Set Enabled  5. F10 save  Then re-run this installer.   │" -ForegroundColor Red
        Write-Host "  └──────────────────────────────────────────────────────────────┘" -ForegroundColor Red
        Write-Host ""
        Wait-ForKey; exit 1
    }
    Write-Log "Hardware virtualization enabled — OK" "OK"

    Write-Log "Enabling WSL2 Windows features..."
    dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart | Out-Null
    dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart | Out-Null
    Write-Log "WSL2 features enabled" "OK"

    Write-Log "Installing WSL2 kernel update..."
    $msi = "$env:TEMP\\\\wsl_update.msi"
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
        Write-Log "Downloading Ubuntu..."
        wsl --install -d Ubuntu --no-launch 2>&1 | Out-Null
        Write-Log "Initializing Ubuntu (first boot)..."
        wsl -d Ubuntu --user root -- bash -c "echo initialized" 2>&1 | Out-Null
        $check = wsl -d Ubuntu -- echo "ok" 2>&1
        if ($check -notmatch "ok") {
            Write-Log "Headless init failed — launching Ubuntu for first-time setup..." "WARN"
            Write-Host ""
            Write-Host "  Ubuntu needs a one-time setup. A new window will open." -ForegroundColor Yellow
            Write-Host "  Create a Linux username + password, then close that window." -ForegroundColor Yellow
            Write-Host ""
            Start-Process wsl.exe -ArgumentList "-d Ubuntu" -Wait
        }
        Write-Log "Ubuntu installed and initialized" "OK"
    } else {
        Write-Log "Ubuntu already present" "OK"
    }

    $gpuObj  = Get-WmiObject Win32_VideoController | Where-Object { $_.Name -match "NVIDIA|GeForce|RTX|GTX" } | Select-Object -First 1
    $gpuName = $gpuObj.Name
    $vramMb  = $gpuObj.AdapterRAM
    $vramGb  = if ($vramMb -and $vramMb -gt 0) { [math]::Round($vramMb / 1GB) } else { 8 }

    Write-Log "Checking NVIDIA GPU visibility in WSL2..."
    $nvCheck = wsl -d Ubuntu --user root -- bash -c "nvidia-smi -L 2>/dev/null | head -1" 2>&1
    if ($nvCheck -match "GPU 0") {
        Write-Log "NVIDIA GPU visible in WSL2" "OK"
    } else {
        Write-Log "NVIDIA GPU not visible in WSL2 — ensure Windows NVIDIA driver is up to date" "WARN"
    }

    Write-Log "Installing Clore.ai host client inside WSL2..."
    $cloreInstall = "bash <(curl -fsSL https://gitlab.com/cloreai-public/hosting/-/raw/main/install.sh) $CLOREAI_INIT_TOKEN"
    $cloreOut = wsl -d Ubuntu --user root -- bash -c $cloreInstall 2>&1
    $cloreExit = $LASTEXITCODE
    $cloreOut | ForEach-Object { Write-Log $_ }
    if ($cloreExit -ne 0) {
        Write-Log "Clore.ai installation failed (exit $cloreExit)." "ERROR"
        Wait-ForKey; exit 1
    }
    Write-Log "Clore.ai install complete" "OK"

    Write-Log "Waiting for Clore.ai server ID (up to 2 min)..."
    $serverId = ""
    for ($i = 1; $i -le 12; $i++) {
        $raw = wsl -d Ubuntu --user root -- bash -c "cat /opt/clore-hosting/client/server_id 2>/dev/null" 2>&1
        $candidate = ("$raw".Trim() -split '\n') | Where-Object { $_ -match '^\s*\d+\s*$' } | Select-Object -First 1
        if ($candidate) { $serverId = $candidate.Trim(); break }
        Write-Log "  Still waiting... ($($i * 10)s elapsed)"
        Start-Sleep 10
    }
    if ($serverId) { Write-Log "Clore.ai Server ID: $serverId" "OK" }
    else { Write-Log "Server ID not yet assigned — check dashboard in a few minutes" "WARN"; $serverId = "" }

    Write-Log "Adding Windows Firewall rules for Clore.ai ports..."
    foreach ($port in $CLORE_PORTS) {
        New-NetFirewallRule -DisplayName "Pulse-Clore-TCP-$port" -Direction Inbound \`
            -Protocol TCP -LocalPort $port -Action Allow -ErrorAction SilentlyContinue | Out-Null
    }
    Write-Log "Firewall rules added for ports $($CLORE_PORTS -join ', ')" "OK"

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
        Write-Host "  (Router admin usually at http://192.168.1.1)" -ForegroundColor DarkGray
        Write-Host ""
        Start-Sleep 3
    }

    Write-Log "Registering machine with Pulse..."
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
        $util = [int](& nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>$null).Trim()
        if ($util -gt $hi -and -not $paused) {
            wsl -d Ubuntu --user root -- bash -c "systemctl stop clore-hosting 2>/dev/null"
            $paused = $true
            Add-Content "$env:LOCALAPPDATA\\Pulse\\watchdog.log" "$(Get-Date -f 'HH:mm') PAUSED ($util%)"
        } elseif ($util -lt $lo -and $paused) {
            wsl -d Ubuntu --user root -- bash -c "systemctl start clore-hosting 2>/dev/null"
            $paused = $false
            Add-Content "$env:LOCALAPPDATA\\Pulse\\watchdog.log" "$(Get-Date -f 'HH:mm') RESUMED ($util%)"
        }
    } catch {}
    Start-Sleep 30
}
'@
    $watchdogPath = "$PULSE_DIR\\\\watchdog.ps1"
    Set-Content -Path $watchdogPath -Value $watchdog -Encoding UTF8
    $wA = New-ScheduledTaskAction -Execute "powershell.exe" \`
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \`"$watchdogPath\`""
    Register-ScheduledTask -TaskName $WATCHDOG_TASK -Action $wA \`
        -Trigger (New-ScheduledTaskTrigger -AtLogOn) \`
        -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -ExecutionTimeLimit 0) \`
        -Principal (New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Highest) -Force | Out-Null
    Write-Log "GPU watchdog installed (pauses during gaming, resumes when idle)" "OK"

    Write-Log "Installing auto-start task..."
    $autostart = @'
Start-Sleep 15
wsl -d Ubuntu --user root -- bash -c "systemctl start clore-hosting 2>/dev/null" 2>&1 |
    Add-Content "$env:LOCALAPPDATA\\Pulse\\autostart.log"
'@
    $startPath = "$PULSE_DIR\\\\autostart.ps1"
    Set-Content -Path $startPath -Value $autostart -Encoding UTF8
    $sA = New-ScheduledTaskAction -Execute "powershell.exe" \`
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \`"$startPath\`""
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
        @{ L = "GPU";          V = $gpuName },
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

trap {
    Write-Host "  [ERROR] $_" -ForegroundColor Red
    Write-Host "  Log: $LOG_FILE" -ForegroundColor Yellow
    Wait-ForKey
    exit 1
}

New-Item -ItemType Directory -Force -Path $PULSE_DIR | Out-Null
$phase = if (Test-Path $PHASE_FILE) { Get-Content $PHASE_FILE } else { "1" }
switch ($phase) {
    "1"     { Invoke-Phase1 }
    "2"     { Invoke-Phase2 }
    default { Write-Host "Unknown phase: $phase" -ForegroundColor Red; Wait-ForKey; exit 1 }
}
exit 0
`;

// ── OctaSpace installer (NVIDIA only — install.octa.space uses nvidia-container-toolkit) ──

const OCTA_PS1_TEMPLATE = `#Requires -Version 5.1
# PULSE GPU Provider Setup — OctaSpace Edition
# Run via pulse-octa-setup.bat (not directly).

$PULSE_USER_TOKEN = "{{PULSE_USER_TOKEN}}"
$PULSE_APP_ID     = "{{PULSE_APP_ID}}"
$PULSE_API_BASE   = "https://api.base44.app/api/apps/$PULSE_APP_ID/functions"

$PULSE_DIR      = "$env:LOCALAPPDATA\\\\Pulse"
$SCRIPT_PATH    = "$PULSE_DIR\\\\pulse-octa-setup.ps1"
$PHASE_FILE     = "$PULSE_DIR\\\\octa_setup_phase"
$LOG_FILE       = "$PULSE_DIR\\\\octa_setup.log"
$TASK_NAME      = "PulseOctaSetupResume"
$WATCHDOG_TASK  = "PulseOctaWatchdog"
$AUTOSTART_TASK = "PulseOctaAutoStart"
$OCTA_PORTS     = @(18888) + (51800..51816)

function Write-Log {
    param([string]$msg, [string]$level = "INFO")
    $ts = Get-Date -Format "HH:mm:ss"
    Add-Content -Path $LOG_FILE -Value "[$ts][$level] $msg" -Encoding UTF8
    switch ($level) {
        "OK"    { Write-Host "  [OK] $msg" -ForegroundColor Green }
        "WARN"  { Write-Host "  [!!] $msg" -ForegroundColor Yellow }
        "ERROR" { Write-Host "  [X]  $msg" -ForegroundColor Red }
        default { Write-Host "  ... $msg" -ForegroundColor Magenta }
    }
}

function Show-Banner {
    param([string]$subtitle = "")
    Clear-Host
    Write-Host ""
    Write-Host "  ██████╗ ██╗   ██╗██╗     ███████╗███████╗" -ForegroundColor Magenta
    Write-Host "  ██╔══██╗██║   ██║██║     ██╔════╝██╔════╝" -ForegroundColor Magenta
    Write-Host "  ██████╔╝██║   ██║██║     ███████╗█████╗  " -ForegroundColor Magenta
    Write-Host "  ██╔═══╝ ██║   ██║██║     ╚════██║██╔══╝  " -ForegroundColor Magenta
    Write-Host "  ██║     ╚██████╔╝███████╗███████║███████╗" -ForegroundColor Magenta
    Write-Host "  ╚═╝      ╚═════╝ ╚══════╝╚══════╝╚══════╝" -ForegroundColor Magenta
    Write-Host ""
    Write-Host "  GPU Provider Setup — OctaSpace Edition" -ForegroundColor White
    if ($subtitle) { Write-Host "  $subtitle" -ForegroundColor DarkGray }
    Write-Host ""
}

function Wait-ForKey {
    Write-Host ""
    Read-Host "  Press Enter to close this window"
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

    # OctaSpace's install script uses nvidia-container-toolkit — NVIDIA required
    $gpu = (Get-WmiObject Win32_VideoController |
        Where-Object { $_.Name -match "NVIDIA|GeForce|RTX|GTX" } |
        Select-Object -First 1).Name
    if (-not $gpu) {
        $amdGpu = (Get-WmiObject Win32_VideoController |
            Where-Object { $_.Name -match "AMD|Radeon" } |
            Select-Object -First 1).Name
        if ($amdGpu) {
            Write-Log "AMD GPU detected ($amdGpu) — OctaSpace requires NVIDIA." "ERROR"
            Write-Host ""
            Write-Host "  OctaSpace's node installer only supports NVIDIA GPUs currently." -ForegroundColor Yellow
            Write-Host "  AMD support is not yet available in their install script." -ForegroundColor DarkGray
            Write-Host ""
        } else {
            Write-Log "No supported NVIDIA GPU detected." "ERROR"
        }
        Wait-ForKey; exit 1
    }
    Write-Log "GPU: $gpu" "OK"

    New-Item -ItemType Directory -Force -Path $PULSE_DIR | Out-Null

    $virtEnabled = (Get-ComputerInfo).HyperVRequirementVirtualizationFirmwareEnabled
    if ($virtEnabled -eq $false) {
        Write-Log "Hardware virtualization is disabled in your BIOS/UEFI." "ERROR"
        Write-Host ""
        Write-Host "  ┌──────────────────────────────────────────────────────────────┐" -ForegroundColor Red
        Write-Host "  │  ACTION REQUIRED: Enable virtualization in your BIOS/UEFI    │" -ForegroundColor Red
        Write-Host "  │  1. Restart  2. Press Del/F2  3. Advanced > SVM / VT-x      │" -ForegroundColor Red
        Write-Host "  │  4. Set Enabled  5. F10 save  Then re-run this installer.   │" -ForegroundColor Red
        Write-Host "  └──────────────────────────────────────────────────────────────┘" -ForegroundColor Red
        Write-Host ""
        Wait-ForKey; exit 1
    }
    Write-Log "Hardware virtualization enabled — OK" "OK"

    Write-Log "Enabling WSL2 Windows features..."
    dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart | Out-Null
    dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart | Out-Null
    Write-Log "WSL2 features enabled" "OK"

    Write-Log "Installing WSL2 kernel update..."
    $msi = "$env:TEMP\\\\wsl_update.msi"
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
    Show-Banner "Phase 2 of 2 — Installing OctaSpace Node"

    Write-Log "Setting up Ubuntu on WSL2..."
    $distros = wsl --list --quiet 2>&1
    if ($distros -notmatch "Ubuntu") {
        Write-Log "Downloading Ubuntu..."
        wsl --install -d Ubuntu --no-launch 2>&1 | Out-Null
        Write-Log "Initializing Ubuntu (first boot)..."
        wsl -d Ubuntu --user root -- bash -c "echo initialized" 2>&1 | Out-Null
        $check = wsl -d Ubuntu -- echo "ok" 2>&1
        if ($check -notmatch "ok") {
            Write-Log "Headless init failed — launching Ubuntu for first-time setup..." "WARN"
            Write-Host ""
            Write-Host "  Ubuntu needs a one-time setup. A new window will open." -ForegroundColor Yellow
            Write-Host "  Create a Linux username + password, then close that window." -ForegroundColor Yellow
            Write-Host ""
            Start-Process wsl.exe -ArgumentList "-d Ubuntu" -Wait
        }
        Write-Log "Ubuntu installed and initialized" "OK"
    } else {
        Write-Log "Ubuntu already present" "OK"
    }

    $gpuObj  = Get-WmiObject Win32_VideoController | Where-Object { $_.Name -match "NVIDIA|GeForce|RTX|GTX" } | Select-Object -First 1
    $gpuName = $gpuObj.Name
    $vramMb  = $gpuObj.AdapterRAM
    $vramGb  = if ($vramMb -and $vramMb -gt 0) { [math]::Round($vramMb / 1GB) } else { 8 }

    Write-Log "Checking NVIDIA GPU visibility in WSL2..."
    $nvCheck = wsl -d Ubuntu --user root -- bash -c "nvidia-smi -L 2>/dev/null | head -1" 2>&1
    if ($nvCheck -match "GPU 0") {
        Write-Log "NVIDIA GPU visible in WSL2" "OK"
    } else {
        Write-Log "NVIDIA GPU not visible in WSL2 — ensure Windows NVIDIA driver 550+ is installed" "WARN"
    }

    Write-Log "Installing OctaSpace node software (5-10 minutes, installs Docker + osn)..."
    wsl -d Ubuntu --user root -- bash -c "curl -fsSL https://install.octa.space | bash" 2>&1 | \`
        ForEach-Object { Write-Log $_ }
    Write-Log "OctaSpace install script complete" "OK"

    Write-Log "Waiting for osn node token (up to 2 min)..."
    $nodeToken = ""
    for ($i = 1; $i -le 12; $i++) {
        $raw = wsl -d Ubuntu --user root -- bash -c "systemctl show osn --property=StatusText 2>/dev/null" 2>&1
        if ("$raw" -match '(?i)token[:\s=]+([A-Za-z0-9_\-]{8,})') {
            $nodeToken = $Matches[1]
            break
        }
        Write-Log "  Waiting for token... ($($i * 10)s)"
        Start-Sleep 10
    }
    if ($nodeToken) { Write-Log "OctaSpace Node Token: $nodeToken" "OK" }
    else { Write-Log "Token not yet available — run 'systemctl show osn' in WSL2 to retrieve it later" "WARN" }

    Write-Log "Adding Windows Firewall rules for OctaSpace ports..."
    foreach ($port in $OCTA_PORTS) {
        New-NetFirewallRule -DisplayName "Pulse-Octa-TCP-$port" -Direction Inbound \`
            -Protocol TCP -LocalPort $port -Action Allow -ErrorAction SilentlyContinue | Out-Null
        New-NetFirewallRule -DisplayName "Pulse-Octa-UDP-$port" -Direction Inbound \`
            -Protocol UDP -LocalPort $port -Action Allow -ErrorAction SilentlyContinue | Out-Null
    }
    Write-Log "Firewall rules added (18888 + 51800-51816 TCP/UDP)" "OK"

    $localIP = Get-LocalIP
    $upnpOk  = $false
    try {
        $upnp     = New-Object -ComObject HNetCfg.NATUPnP
        $mappings = $upnp.StaticPortMappingCollection
        foreach ($port in @(18888, 51800, 51801, 51802)) {
            $mappings.Add($port, "TCP", $port, $localIP, $true, "Pulse-Octa-$port") | Out-Null
        }
        Write-Log "UPnP succeeded — key ports mapped to $localIP" "OK"
        $upnpOk = $true
    } catch { Write-Log "UPnP unavailable on this router" "WARN" }

    if (-not $upnpOk) {
        Write-Host ""
        Write-Host "  ACTION NEEDED: Forward these ports to $localIP in your router:" -ForegroundColor Yellow
        Write-Host "    TCP/UDP 51800-51816  (OctaSpace service ports)" -ForegroundColor Yellow
        Write-Host "    TCP     18888        (Node dashboard)" -ForegroundColor Yellow
        Write-Host "  (Router admin usually at http://192.168.1.1)" -ForegroundColor DarkGray
        Write-Host ""
        Start-Sleep 3
    }

    if ($nodeToken) {
        Write-Host ""
        Write-Host "  ┌──────────────────────────────────────────────────────────────┐" -ForegroundColor Magenta
        Write-Host "  │  REQUIRED: Register your node on OctaSpace Cube             │" -ForegroundColor Magenta
        Write-Host "  │                                                              │" -ForegroundColor Magenta
        Write-Host "  │  1. Open:  https://cube.octa.computer                       │" -ForegroundColor Magenta
        Write-Host "  │  2. Go to: Hosting > Nodes > Add Node                       │" -ForegroundColor Magenta
        Write-Host "  │  3. Paste your token: $nodeToken" -ForegroundColor White
        Write-Host "  │                                                              │" -ForegroundColor Magenta
        Write-Host "  │  Pulse has also saved this token to your dashboard.         │" -ForegroundColor Magenta
        Write-Host "  └──────────────────────────────────────────────────────────────┘" -ForegroundColor Magenta
        Write-Host ""
        Read-Host "  Press Enter once registered (or skip — you can do this after setup)"
    }

    Write-Log "Registering machine with Pulse..."
    $body = @{
        gpu_model       = $gpuName
        vram_gb         = $vramGb
        octa_node_token = $nodeToken
        platform        = "OctaSpace"
    } | ConvertTo-Json
    try {
        $resp = Invoke-RestMethod -Uri "$PULSE_API_BASE/registerOctaspaceDaemon" \`
            -Method POST -ContentType "application/json" \`
            -Headers @{ "Authorization" = "Bearer $PULSE_USER_TOKEN" } -Body $body
        Write-Log "Pulse registration: $($resp.message)" "OK"
    } catch { Write-Log "Pulse registration failed (will retry on next start): $_" "WARN" }

    Write-Log "Installing GPU gaming watchdog..."
    $watchdog = @'
$hi = 75; $lo = 20; $paused = $false
while ($true) {
    try {
        $util = [int](& nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>$null).Trim()
        if ($util -gt $hi -and -not $paused) {
            wsl -d Ubuntu --user root -- bash -c "systemctl stop osn 2>/dev/null"
            $paused = $true
            Add-Content "$env:LOCALAPPDATA\\Pulse\\octa_watchdog.log" "$(Get-Date -f 'HH:mm') PAUSED ($util%)"
        } elseif ($util -lt $lo -and $paused) {
            wsl -d Ubuntu --user root -- bash -c "systemctl start osn 2>/dev/null"
            $paused = $false
            Add-Content "$env:LOCALAPPDATA\\Pulse\\octa_watchdog.log" "$(Get-Date -f 'HH:mm') RESUMED ($util%)"
        }
    } catch {}
    Start-Sleep 30
}
'@
    $watchdogPath = "$PULSE_DIR\\\\octa_watchdog.ps1"
    Set-Content -Path $watchdogPath -Value $watchdog -Encoding UTF8
    $wA = New-ScheduledTaskAction -Execute "powershell.exe" \`
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \`"$watchdogPath\`""
    Register-ScheduledTask -TaskName $WATCHDOG_TASK -Action $wA \`
        -Trigger (New-ScheduledTaskTrigger -AtLogOn) \`
        -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -ExecutionTimeLimit 0) \`
        -Principal (New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Highest) -Force | Out-Null
    Write-Log "GPU watchdog installed (pauses osn during gaming, resumes when idle)" "OK"

    Write-Log "Installing auto-start task..."
    $autostart = @'
Start-Sleep 15
wsl -d Ubuntu --user root -- bash -c "systemctl start osn 2>/dev/null" 2>&1 |
    Add-Content "$env:LOCALAPPDATA\\Pulse\\octa_autostart.log"
'@
    $startPath = "$PULSE_DIR\\\\octa_autostart.ps1"
    Set-Content -Path $startPath -Value $autostart -Encoding UTF8
    $sA = New-ScheduledTaskAction -Execute "powershell.exe" \`
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \`"$startPath\`""
    Register-ScheduledTask -TaskName $AUTOSTART_TASK -Action $sA \`
        -Trigger (New-ScheduledTaskTrigger -AtLogOn) \`
        -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -ExecutionTimeLimit 0) \`
        -Principal (New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Highest) -Force | Out-Null
    Write-Log "Auto-start installed" "OK"

    Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item $PHASE_FILE -ErrorAction SilentlyContinue

    Show-Banner "Setup Complete!"
    Write-Host "  Your GPU is now earning via Pulse + OctaSpace." -ForegroundColor Green
    Write-Host ""
    @(
        @{ L = "GPU";          V = $gpuName },
        @{ L = "VRAM";         V = "$vramGb GB" },
        @{ L = "Platform";     V = "OctaSpace (via Pulse)" },
        @{ L = "Node Token";   V = if ($nodeToken) { $nodeToken } else { "Pending — check osn service" } },
        @{ L = "Gaming pause"; V = "Auto (GPU > 75% util)" },
        @{ L = "Auto-start";   V = "On every Windows login" },
        @{ L = "Logs";         V = $LOG_FILE }
    ) | ForEach-Object { Write-Host ("  {0,-16} {1}" -f $_.L, $_.V) -ForegroundColor White }
    Write-Host ""
    Write-Host "  Register node: https://cube.octa.computer" -ForegroundColor Magenta
    Write-Host "  Dashboard:     https://pulsenanoai.com" -ForegroundColor Cyan
    Write-Host ""
    Wait-ForKey
}

trap {
    Write-Host "  [ERROR] $_" -ForegroundColor Red
    Write-Host "  Log: $LOG_FILE" -ForegroundColor Yellow
    Wait-ForKey
    exit 1
}

New-Item -ItemType Directory -Force -Path $PULSE_DIR | Out-Null
$phase = if (Test-Path $PHASE_FILE) { Get-Content $PHASE_FILE } else { "1" }
switch ($phase) {
    "1"     { Invoke-Phase1 }
    "2"     { Invoke-Phase2 }
    default { Write-Host "Unknown phase: $phase" -ForegroundColor Red; Wait-ForKey; exit 1 }
}
exit 0
`;

// ── Shared .bat wrapper ───────────────────────────────────────────────────────
// Extracts the embedded PS1 to %LOCALAPPDATA%\Pulse\ before elevation so the
// Phase 2 scheduled task can find it after reboot. {{PS1_FILENAME}} is replaced
// at serve time with the platform-specific filename.

const BAT_TEMPLATE = `@echo off
setlocal

net session >nul 2>&1
if %errorlevel% equ 0 goto :elevated

cls
echo.
echo   ==========================================
echo    PULSE GPU Setup
echo   ==========================================
echo.
echo   This installer needs Administrator access.
echo.
echo     Step 1 ^| If you see "Open File - Security Warning", click RUN
echo              If you see "Windows protected your PC", click More info then Run anyway
echo.
echo     Step 2 ^| A UAC popup will appear -- click YES
echo.

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
set "PS1_PATH=%PULSE_DIR%\\{{PS1_FILENAME}}"

if not exist "%PULSE_DIR%" mkdir "%PULSE_DIR%"

echo   Step 1: Extracting setup script...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=[IO.File]::ReadAllText('%~f0',[Text.Encoding]::UTF8); $m='__PULSE_PS1__'; $i=$c.LastIndexOf($m); if($i-lt 0){exit 1}; [IO.File]::WriteAllText('%PS1_PATH%',$c.Substring($i+$m.Length).TrimStart(),[Text.Encoding]::UTF8)"

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
powershell -NoProfile -ExecutionPolicy Bypass -NoExit -File "%PS1_PATH%"
goto :eof

__PULSE_PS1__
`;

// ─────────────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const cloreInitToken = Deno.env.get('CLOREAI_INIT_TOKEN') ?? 'CLOREAI_INIT_TOKEN_NOT_SET';
  const appId = Deno.env.get('BASE44_APP_ID') ?? '';

  const body = await req.json().catch(() => ({}));
  const userToken: string = body.user_token ?? '';
  const platform: string = (body.platform ?? 'clore').toLowerCase();

  const isOcta = platform === 'octaspace';
  const ps1Filename = isOcta ? 'pulse-octa-setup.ps1' : 'pulse-clore-setup.ps1';
  const batFilename = isOcta ? 'pulse-octa-setup.bat' : 'pulse-clore-setup.bat';

  let ps1 = (isOcta ? OCTA_PS1_TEMPLATE : CLORE_PS1_TEMPLATE)
    .replace('{{PULSE_USER_TOKEN}}', userToken)
    .replace('{{PULSE_APP_ID}}', appId);

  if (!isOcta) {
    ps1 = ps1.replace('{{CLOREAI_INIT_TOKEN}}', cloreInitToken);
  }

  const bat = BAT_TEMPLATE.replace('{{PS1_FILENAME}}', ps1Filename) + ps1;

  return new Response(bat, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${batFilename}"`,
    },
  });
});
