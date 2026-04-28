#Requires -Version 5.1
<#
.SYNOPSIS
    PULSE GPU Setup — DEV/TEST version (no GPU required)
.DESCRIPTION
    Identical to pulse-setup.ps1 but skips all NVIDIA/GPU checks and jumps
    straight to Phase 2 so the Clore install + init-token flow can be tested
    on any machine. Not for production use.

    Before running, set your real init token:
      $CLOREAI_INIT_TOKEN = "your-real-token-here"
#>

# ── Edit these before running ─────────────────────────────────────────────────
$PULSE_USER_TOKEN   = "{{PULSE_USER_TOKEN}}"
$PULSE_APP_ID       = "{{PULSE_APP_ID}}"
$CLOREAI_INIT_TOKEN = "{{CLOREAI_INIT_TOKEN}}"
$PULSE_API_BASE     = "https://api.base44.app/api/apps/$PULSE_APP_ID/functions"
# ─────────────────────────────────────────────────────────────────────────────

# Fake GPU so registration/watchdog code has something to work with
$FAKE_GPU_NAME = "TEST-GPU (no-gpu test mode)"
$FAKE_VRAM_GB  = 8

$PULSE_DIR      = "$env:LOCALAPPDATA\Pulse"
$LOG_FILE       = "$PULSE_DIR\setup-test.log"
$WATCHDOG_TASK  = "PulseGPUWatchdog"
$AUTOSTART_TASK = "PulseAutoStart"
$TASK_NAME      = "PulseSetupResume"

$CLORE_MGMT_PORTS     = @(22, 8080)
$CLORE_APP_PORT_START = 3000
$CLORE_APP_PORT_END   = 4000

# ── Helpers ───────────────────────────────────────────────────────────────────

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
    Write-Host "  ██████╗ ██╗   ██╗██╗     ███████╗███████╗" -ForegroundColor Yellow
    Write-Host "  ██╔══██╗██║   ██║██║     ██╔════╝██╔════╝" -ForegroundColor Yellow
    Write-Host "  ██████╔╝██║   ██║██║     ███████╗█████╗  " -ForegroundColor Yellow
    Write-Host "  ██╔═══╝ ██║   ██║██║     ╚════██║██╔══╝  " -ForegroundColor Yellow
    Write-Host "  ██║     ╚██████╔╝███████╗███████║███████╗" -ForegroundColor Yellow
    Write-Host "  ╚═╝      ╚═════╝ ╚══════╝╚══════╝╚══════╝" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  GPU Setup — DEV/TEST MODE (GPU checks skipped)" -ForegroundColor Yellow
    if ($subtitle) { Write-Host "  $subtitle" -ForegroundColor DarkGray }
    Write-Host ""
}

function Assert-Admin {
    if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Host "  Relaunching as Administrator..." -ForegroundColor Yellow
        Start-Process powershell "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
        exit
    }
}

function Wait-ForKey {
    Write-Host ""
    Read-Host "  Press Enter to close this window"
}

$script:Steps = [ordered]@{}

function Register-Step {
    param([string]$name, [string]$fix = "")
    $script:Steps[$name] = @{ Status = "PENDING"; Detail = ""; Fix = $fix }
}

function Set-Step {
    param([string]$name, [string]$status, [string]$detail = "")
    if ($script:Steps.Contains($name)) {
        $script:Steps[$name].Status = $status
        if ($detail) { $script:Steps[$name].Detail = $detail }
    }
}

function Show-Diagnostics {
    param([switch]$LogOnly)
    $sep    = "  " + ("─" * 65)
    $logSep = "─" * 67
    $ts     = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

    if (-not $LogOnly) {
        Write-Host ""
        Write-Host $sep -ForegroundColor DarkGray
        Write-Host "  INSTALL DIAGNOSTICS" -ForegroundColor White
        Write-Host $sep -ForegroundColor DarkGray
    }

    Add-Content -Path $LOG_FILE -Value "" -Encoding UTF8
    Add-Content -Path $LOG_FILE -Value $logSep -Encoding UTF8
    Add-Content -Path $LOG_FILE -Value "INSTALL DIAGNOSTICS  $ts" -Encoding UTF8
    Add-Content -Path $LOG_FILE -Value $logSep -Encoding UTF8

    foreach ($name in $script:Steps.Keys) {
        $s     = $script:Steps[$name]
        $icon  = switch ($s.Status) { "PASS" {"[OK]"} "FAIL" {"[X] "} "WARN" {"[!!]"} "SKIP" {"[--]"} default {"[  ]"} }
        $color = switch ($s.Status) { "PASS" {"Green"} "FAIL" {"Red"} "WARN" {"Yellow"} "SKIP" {"DarkGray"} default {"DarkGray"} }

        if ($s.Status -eq "PENDING") {
            if (-not $LogOnly) { Write-Host ("  {0} {1,-55} {2}" -f $icon, $name, "(not reached)") -ForegroundColor DarkGray }
            Add-Content -Path $LOG_FILE -Value ("  $icon $name  (not reached)") -Encoding UTF8
        } else {
            if (-not $LogOnly) {
                Write-Host "  $icon $name" -ForegroundColor $color
                if ($s.Detail) { Write-Host "       $($s.Detail)" -ForegroundColor DarkGray }
                if ($s.Status -eq "FAIL" -and $s.Fix) { Write-Host "       Fix: $($s.Fix)" -ForegroundColor Yellow }
            }
            Add-Content -Path $LOG_FILE -Value "  $icon $name" -Encoding UTF8
            if ($s.Detail) { Add-Content -Path $LOG_FILE -Value "       $($s.Detail)" -Encoding UTF8 }
            if ($s.Status -eq "FAIL" -and $s.Fix) { Add-Content -Path $LOG_FILE -Value "       Fix: $($s.Fix)" -Encoding UTF8 }
        }
    }

    Add-Content -Path $LOG_FILE -Value $logSep -Encoding UTF8

    if (-not $LogOnly) {
        Write-Host $sep -ForegroundColor DarkGray
        Write-Host "  Full log: $LOG_FILE" -ForegroundColor DarkGray
        Write-Host ""
    }
}

function Get-LocalIP {
    (Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.InterfaceAlias -notmatch "Loopback|WSL|vEthernet" } |
        Select-Object -First 1).IPAddress
}

function Set-WSL2PortProxy {
    param([string]$WslIP)
    $allPorts = $CLORE_MGMT_PORTS + ($CLORE_APP_PORT_START..$CLORE_APP_PORT_END)
    foreach ($p in $allPorts) {
        netsh interface portproxy delete v4tov4 listenport=$p listenaddress=0.0.0.0 | Out-Null
        netsh interface portproxy add v4tov4 listenport=$p listenaddress=0.0.0.0 `
            connectport=$p connectaddress=$WslIP | Out-Null
    }
    Write-Log "WSL2 portproxy: $($CLORE_MGMT_PORTS -join ',') + $CLORE_APP_PORT_START-$CLORE_APP_PORT_END → $WslIP" "OK"
}

# ── Phase 2 only (WSL2 assumed already installed) ─────────────────────────────

function Invoke-Phase2 {
    Show-Banner "Testing Clore.ai install + token flow"

    $script:Steps = [ordered]@{}
    Register-Step "Ubuntu on WSL2"
    Register-Step "systemd in WSL2"
    Register-Step "WSL2 networking"
    Register-Step "GPU compute in WSL2"
    Register-Step "Build tools (gcc, python3-dev)"
    Register-Step "Clore.ai host client"
    Register-Step "Clore.ai init token" "Check that CLOREAI_INIT_TOKEN is set and not already used"
    Register-Step "Clore server ID"
    Register-Step "Windows Firewall rules"
    Register-Step "UPnP port forwarding"
    Register-Step "WSL2 port proxy"
    Register-Step "Pulse registration"
    Register-Step "GPU watchdog task"
    Register-Step "Auto-start task"

    Write-Log "TEST MODE: GPU checks skipped — using fake GPU '$FAKE_GPU_NAME'" "WARN"
    Set-Step "GPU compute in WSL2" "SKIP" "Test mode — GPU check skipped"

    $gpuName  = $FAKE_GPU_NAME
    $vramGb   = $FAKE_VRAM_GB

    # ── Ubuntu ────────────────────────────────────────────────────────────────
    Write-Log "Checking Ubuntu on WSL2..."
    $distros = wsl --list --quiet 2>&1
    if ($distros -notmatch "Ubuntu") {
        Write-Log "Ubuntu not found — installing..."
        wsl --install -d Ubuntu --no-launch 2>&1 | Out-Null
        wsl -d Ubuntu --user root -- bash -c "echo initialized" 2>&1 | Out-Null
        $check = wsl -d Ubuntu -- echo "ok" 2>&1
        if ($check -notmatch "ok") {
            Write-Host "  Ubuntu needs a one-time setup. A new window will open." -ForegroundColor Yellow
            Write-Host "  Create a Linux username + password, then close that window." -ForegroundColor Yellow
            Start-Process wsl.exe -ArgumentList "-d Ubuntu" -Wait
        }
        Write-Log "Ubuntu installed" "OK"
    } else {
        Write-Log "Ubuntu already present" "OK"
    }
    Set-Step "Ubuntu on WSL2" "PASS"

    # ── systemd ───────────────────────────────────────────────────────────────
    Write-Log "Enabling systemd in WSL2..."
    wsl -d Ubuntu --user root -- bash -c "grep -q 'systemd=true' /etc/wsl.conf 2>/dev/null || printf '[boot]\nsystemd=true\n' > /etc/wsl.conf"

    # ── Networking ────────────────────────────────────────────────────────────
    $osBuild = [System.Environment]::OSVersion.Version.Build
    $mirroredNetworking = $false
    $wslConfigPath = "$env:USERPROFILE\.wslconfig"
    if ($osBuild -ge 22621) {
        $wslConfigContent = if (Test-Path $wslConfigPath) { Get-Content $wslConfigPath -Raw } else { "" }
        if ($wslConfigContent -notmatch 'networkingMode') {
            if ($wslConfigContent -match '\[wsl2\]') {
                $wslConfigContent = $wslConfigContent -replace '(\[wsl2\])', "`$1`nnetworkingMode=mirrored"
            } else {
                $wslConfigContent += "`n[wsl2]`nnetworkingMode=mirrored`n"
            }
            Set-Content -Path $wslConfigPath -Value $wslConfigContent -Encoding UTF8
        }
        $mirroredNetworking = $true
        Write-Log "WSL2 mirrored networking configured" "OK"
        Set-Step "WSL2 networking" "PASS" "Mirrored (Windows 11 22H2+)"
    } else {
        Write-Log "Build $osBuild — portproxy mode" "WARN"
        Set-Step "WSL2 networking" "WARN" "Portproxy mode (build $osBuild)"
    }

    wsl --shutdown
    Start-Sleep 20
    $sdCheck = wsl -d Ubuntu --user root -- bash -c "[ -d /run/systemd/system ] && echo yes || echo no" 2>&1
    if ($sdCheck -match "yes") {
        Write-Log "systemd running in WSL2" "OK"
        Set-Step "systemd in WSL2" "PASS"
    } else {
        Write-Log "systemd not active — service may not auto-start on reboot" "WARN"
        Set-Step "systemd in WSL2" "WARN" "systemd not detected"
    }

    # ── Build tools ───────────────────────────────────────────────────────────
    Write-Log "Installing build tools (gcc, python3-dev)..."
    wsl -d Ubuntu --user root -- bash -c "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq 2>&1 | tail -2 && apt-get install -y -qq build-essential python3-dev 2>&1 | tail -3" 2>&1 | ForEach-Object { Write-Log $_ }
    if ($LASTEXITCODE -eq 0) {
        Set-Step "Build tools (gcc, python3-dev)" "PASS"
    } else {
        Set-Step "Build tools (gcc, python3-dev)" "WARN" "apt-get exit $LASTEXITCODE — Clore.ai will attempt install anyway"
    }

    # ── Clore.ai install ──────────────────────────────────────────────────────
    Write-Log "Installing Clore.ai host client inside WSL2..."
    $cloreInstall = "bash <(curl -fsSL https://gitlab.com/cloreai-public/hosting/-/raw/main/install.sh) --init-token $CLOREAI_INIT_TOKEN"
    $cloreOutput = wsl -d Ubuntu --user root -- bash -c $cloreInstall 2>&1
    $cloreExit = $LASTEXITCODE
    $cloreOutput | ForEach-Object { Write-Log $_ }
    if ($cloreExit -ne 0) {
        Set-Step "Clore.ai host client" "FAIL" "install.sh exited $cloreExit"
        Write-Log "Clore.ai install failed (exit $cloreExit)." "ERROR"
        Show-Diagnostics; Wait-ForKey; exit 1
    }
    Write-Log "Clore.ai install complete" "OK"
    Set-Step "Clore.ai host client" "PASS"

    # ── Init token registration ───────────────────────────────────────────────
    Write-Log "Registering machine with Clore.ai init token..."
    $initOutput = wsl -d Ubuntu --user root -- bash -c "bash /opt/clore-hosting/clore.sh --init-token $CLOREAI_INIT_TOKEN" 2>&1
    $initExit = $LASTEXITCODE
    $initOutput | ForEach-Object { Write-Log $_ }
    if ($initExit -ne 0) {
        Set-Step "Clore.ai init token" "FAIL" "hosting.py --init-token exited $initExit — token may be single-use or expired"
        Write-Log "Init token registration failed (exit $initExit)." "ERROR"
        Show-Diagnostics; Wait-ForKey; exit 1
    }
    Write-Log "Clore.ai init token accepted — auth file created" "OK"
    Set-Step "Clore.ai init token" "PASS"

    # ── Start service + poll for server ID ────────────────────────────────────
    Write-Log "Enabling and starting clore-hosting service..."
    wsl -d Ubuntu --user root -- bash -c "systemctl enable clore-hosting 2>/dev/null; systemctl start clore-hosting 2>/dev/null"
    Start-Sleep 10

    Write-Log "Waiting for Clore.ai to assign server ID (up to 3 min)..."
    $serverId = ""
    for ($i = 1; $i -le 18; $i++) {
        $raw = wsl -d Ubuntu --user root -- bash -c "
for f in /opt/clore-hosting/client/server_id \$(find /opt/clore-hosting/client -name 'server_id' 2>/dev/null | head -1); do
    [ -f ""\$f"" ] && cat ""\$f"" && break
done" 2>&1
        $candidate = ($raw | Where-Object { $_ -match '^\s*\d+\s*$' }) | Select-Object -First 1
        if ($candidate) { $serverId = $candidate.Trim(); break }
        Write-Log "  Still waiting... ($($i * 10)s elapsed)"
        Start-Sleep 10
    }
    if ($serverId) {
        Write-Log "Clore.ai Server ID: $serverId" "OK"
        Set-Step "Clore server ID" "PASS" "ID: $serverId"
    } else {
        Write-Log "Server ID not yet assigned — service is running; check dashboard in ~5 min" "WARN"
        Set-Step "Clore server ID" "WARN" "Not yet assigned — check dashboard"
    }

    # ── Firewall ──────────────────────────────────────────────────────────────
    Write-Log "Adding Windows Firewall inbound rules..."
    $allPorts = $CLORE_MGMT_PORTS + ($CLORE_APP_PORT_START..$CLORE_APP_PORT_END)
    foreach ($port in $allPorts) {
        New-NetFirewallRule -DisplayName "Pulse-Clore-TCP-$port" -Direction Inbound `
            -Protocol TCP -LocalPort $port -Action Allow -ErrorAction SilentlyContinue | Out-Null
    }
    Write-Log "Firewall rules added" "OK"
    Set-Step "Windows Firewall rules" "PASS"

    # ── UPnP ──────────────────────────────────────────────────────────────────
    $localIP = Get-LocalIP
    $upnpOk  = $false
    try {
        $upnp     = New-Object -ComObject HNetCfg.NATUPnP
        $mappings = $upnp.StaticPortMappingCollection
        foreach ($port in $allPorts) {
            $mappings.Add($port, "TCP", $port, $localIP, $true, "Pulse-Clore-$port") | Out-Null
        }
        Write-Log "UPnP succeeded — ports forwarded to $localIP" "OK"
        Set-Step "UPnP port forwarding" "PASS" "Auto-forwarded → $localIP"
        $upnpOk = $true
    } catch {
        Write-Log "UPnP unavailable on this router" "WARN"
        Set-Step "UPnP port forwarding" "WARN" "UPnP unavailable — manual router setup required"
    }

    # ── WSL2 port proxy ───────────────────────────────────────────────────────
    if (-not $mirroredNetworking) {
        $wslIP = (wsl -d Ubuntu --user root -- bash -c "hostname -I 2>/dev/null").Trim().Split()[0]
        if ($wslIP) {
            Set-WSL2PortProxy -WslIP $wslIP
            Set-Content -Path "$PULSE_DIR\last_wsl_ip" -Value $wslIP -Encoding UTF8
            Set-Step "WSL2 port proxy" "PASS" "→ $wslIP"
        } else {
            Write-Log "Could not determine WSL2 IP — portproxy skipped" "WARN"
            Set-Step "WSL2 port proxy" "WARN" "WSL2 IP not found"
        }
    } else {
        Write-Log "Mirrored networking — portproxy not needed" "OK"
        Set-Step "WSL2 port proxy" "SKIP" "Not needed — mirrored networking active"
    }

    # ── Pulse registration ────────────────────────────────────────────────────
    Write-Log "Registering machine with Pulse..."
    $body = @{
        gpu_model       = $gpuName
        vram_gb         = $vramGb
        clore_server_id = $serverId
        platform        = "Clore.ai"
    } | ConvertTo-Json
    try {
        $resp = Invoke-RestMethod -Uri "$PULSE_API_BASE/registerGPUDaemon" `
            -Method POST `
            -ContentType "application/json" `
            -Headers @{ "Authorization" = "Bearer $PULSE_USER_TOKEN" } `
            -Body $body
        Write-Log "Pulse registration: $($resp.message)" "OK"
        Set-Step "Pulse registration" "PASS"
    } catch {
        Write-Log "Pulse registration failed: $_" "WARN"
        Set-Step "Pulse registration" "WARN" "Will retry automatically on next login"
    }

    # ── Watchdog ──────────────────────────────────────────────────────────────
    Write-Log "Installing GPU watchdog (test mode — always idle)..."
    $watchdog = @'
while ($true) {
    # Test mode: GPU utilization always treated as 0 — service never paused
    Start-Sleep 60
}
'@
    $watchdogPath = "$PULSE_DIR\watchdog.ps1"
    Set-Content -Path $watchdogPath -Value $watchdog -Encoding UTF8
    $wA = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdogPath`""
    $wT = New-ScheduledTaskTrigger -AtLogOn
    $wS = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -ExecutionTimeLimit 0
    $wP = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Highest
    Register-ScheduledTask -TaskName $WATCHDOG_TASK -Action $wA -Trigger $wT `
        -Settings $wS -Principal $wP -Force | Out-Null
    Write-Log "Watchdog installed (test mode — no-op)" "OK"
    Set-Step "GPU watchdog task" "PASS"

    # ── Auto-start ────────────────────────────────────────────────────────────
    Write-Log "Installing auto-start task..."
    $autostart = @'
Start-Sleep 15
wsl -d Ubuntu -- bash -c 'sudo systemctl start clore-hosting 2>/dev/null' 2>&1 |
    Add-Content "$env:LOCALAPPDATA\Pulse\autostart.log"
'@
    $startPath = "$PULSE_DIR\autostart.ps1"
    Set-Content -Path $startPath -Value $autostart -Encoding UTF8
    $sA = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startPath`""
    $sT = New-ScheduledTaskTrigger -AtLogOn
    $sS = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -ExecutionTimeLimit 0
    $sP = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Highest
    Register-ScheduledTask -TaskName $AUTOSTART_TASK -Action $sA -Trigger $sT `
        -Settings $sS -Principal $sP -Force | Out-Null
    Write-Log "Auto-start installed" "OK"
    Set-Step "Auto-start task" "PASS"

    # ── Summary ───────────────────────────────────────────────────────────────
    Show-Diagnostics -LogOnly

    Show-Banner "Test Run Complete"
    Write-Host "  TEST MODE — results below:" -ForegroundColor Yellow
    Write-Host ""
    @(
        @{ L = "GPU (fake)";   V = $gpuName },
        @{ L = "Server ID";    V = if ($serverId) { $serverId } else { "Pending — check dashboard" } },
        @{ L = "Auth file";    V = (wsl -d Ubuntu --user root -- bash -c "test -f /opt/clore-hosting/client/auth && echo EXISTS || echo MISSING" 2>&1) },
        @{ L = "Log";          V = $LOG_FILE }
    ) | ForEach-Object { Write-Host ("  {0,-16} {1}" -f $_.L, $_.V) -ForegroundColor White }
    Write-Host ""
    Show-Diagnostics
    Wait-ForKey
}

# ── Entry Point ───────────────────────────────────────────────────────────────

trap {
    Write-Host ""
    Write-Host "  [ERROR] Unexpected error:" -ForegroundColor Red
    Write-Host "  $_" -ForegroundColor Red
    Show-Diagnostics
    Read-Host "  Press Enter to close"
    exit 1
}

Assert-Admin
New-Item -ItemType Directory -Force -Path $PULSE_DIR | Out-Null

Invoke-Phase2
