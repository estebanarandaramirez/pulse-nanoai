#Requires -Version 5.1
<#
.SYNOPSIS
    PULSE GPU Provider Setup — Windows Installer
.DESCRIPTION
    Phase 1: Enables WSL2, schedules Phase 2 to run after reboot.
    Phase 2: Installs Ubuntu, Clore.ai host client, sets up networking
             (UPnP port mapping), GPU gaming detection, and auto-start.

    Embedded at download time by Pulse's generateSetupScript function:
      PULSE_USER_TOKEN    — user's session token for Pulse API callback
      PULSE_APP_ID        — base44 app ID
      CLOREAI_FLEET_TOKEN — Clore.ai fleet token (base64 blob from Mass Onboard page,
                            shared across all machines on the account)
#>

# ── Embedded by server at download time ──────────────────────────────────────
$PULSE_USER_TOKEN    = "{{PULSE_USER_TOKEN}}"
$PULSE_APP_ID        = "{{PULSE_APP_ID}}"
$CLOREAI_FLEET_TOKEN = "{{CLOREAI_FLEET_TOKEN}}"
$PULSE_API_BASE     = "https://api.base44.app/api/apps/$PULSE_APP_ID/functions"
# ─────────────────────────────────────────────────────────────────────────────

$PULSE_DIR       = "$env:LOCALAPPDATA\Pulse"
$PHASE_FILE      = "$PULSE_DIR\setup_phase"
$LOG_FILE        = "$PULSE_DIR\setup.log"
$TASK_NAME       = "PulseSetupResume"
$WATCHDOG_TASK   = "PulseGPUWatchdog"
$AUTOSTART_TASK  = "PulseAutoStart"

# Clore.ai ports — management (SSH + Jupyter) and container application range
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

# ── Diagnostics checklist ─────────────────────────────────────────────────────
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
        Write-Host "  Share with Pulse support at pulsenanoai.com" -ForegroundColor DarkGray
        Write-Host ""
    }
}
# ─────────────────────────────────────────────────────────────────────────────

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

# ── Phase 1: Enable WSL2 + schedule Phase 2 after reboot ─────────────────────

function Invoke-Phase1 {
    Show-Banner "Phase 1 of 2 — Enabling WSL2"

    $script:Steps = [ordered]@{}
    Register-Step "Windows compatibility (build 19041+)"
    Register-Step "GPU detected"
    Register-Step "Virtualization enabled in BIOS"
    Register-Step "WSL2 features enabled"
    Register-Step "WSL2 kernel update"
    Register-Step "Phase 2 resume task"

    # Windows version check (WSL2 requires build 19041+)
    $build = [System.Environment]::OSVersion.Version.Build
    if ($build -lt 19041) {
        Set-Step "Windows compatibility (build 19041+)" "FAIL" "Build $build — requires 19041 (Windows 10 2004+)"
        Write-Log "Windows build $build is too old. WSL2 requires build 19041+ (Windows 10 2004+)." "ERROR"
        Show-Diagnostics; Wait-ForKey; exit 1
    }
    Write-Log "Windows build $build — OK" "OK"
    Set-Step "Windows compatibility (build 19041+)" "PASS" "Build $build"

    # GPU check (NVIDIA or AMD)
    $gpu = (Get-WmiObject Win32_VideoController |
        Where-Object { $_.Name -match "NVIDIA|GeForce|RTX|GTX|AMD|Radeon" } |
        Select-Object -First 1).Name
    if (-not $gpu) {
        Set-Step "GPU detected" "FAIL" "No NVIDIA/AMD GPU found"
        Write-Log "No supported GPU detected. Pulse requires an NVIDIA or AMD GPU." "ERROR"
        Show-Diagnostics; Wait-ForKey; exit 1
    }
    Write-Log "GPU: $gpu" "OK"
    Set-Step "GPU detected" "PASS" $gpu

    New-Item -ItemType Directory -Force -Path $PULSE_DIR | Out-Null

    # Virtualization check — WSL2 requires AMD-V/SVM or Intel VT-x enabled in BIOS
    $virtEnabled = (Get-ComputerInfo).HyperVRequirementVirtualizationFirmwareEnabled
    if ($virtEnabled -eq $false) {
        Set-Step "Virtualization enabled in BIOS" "FAIL" "Disabled — see BIOS instructions below"
        Write-Log "Hardware virtualization is disabled in your BIOS/UEFI." "ERROR"
        Write-Host ""
        Write-Host "  ┌──────────────────────────────────────────────────────────────┐" -ForegroundColor Red
        Write-Host "  │  ACTION REQUIRED: Enable virtualization in your BIOS/UEFI    │" -ForegroundColor Red
        Write-Host "  │                                                              │" -ForegroundColor Red
        Write-Host "  │  1. Restart your PC                                          │" -ForegroundColor Red
        Write-Host "  │  2. Press Delete or F2 during boot to open BIOS             │" -ForegroundColor Red
        Write-Host "  │  3. Find: Advanced > CPU Configuration > SVM Mode           │" -ForegroundColor Red
        Write-Host "  │     (Intel boards: look for 'Intel Virtualization' or VT-x) │" -ForegroundColor Red
        Write-Host "  │  4. Set it to Enabled                                        │" -ForegroundColor Red
        Write-Host "  │  5. Press F10 to save and exit                              │" -ForegroundColor Red
        Write-Host "  │                                                              │" -ForegroundColor Red
        Write-Host "  │  Then re-run this installer.                                 │" -ForegroundColor Red
        Write-Host "  └──────────────────────────────────────────────────────────────┘" -ForegroundColor Red
        Write-Host ""
        Show-Diagnostics; Wait-ForKey; exit 1
    }
    Write-Log "Hardware virtualization enabled in BIOS — OK" "OK"
    Set-Step "Virtualization enabled in BIOS" "PASS"

    # Enable WSL2 features
    Write-Log "Enabling WSL2 Windows features..."
    dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart | Out-Null
    dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart | Out-Null
    Write-Log "WSL2 features enabled" "OK"
    Set-Step "WSL2 features enabled" "PASS"

    # WSL2 kernel update
    Write-Log "Installing WSL2 kernel update..."
    $msi = "$env:TEMP\wsl_update.msi"
    try {
        Invoke-WebRequest "https://wslstorestorage.blob.core.windows.net/wslblob/wsl_update_x64.msi" `
            -OutFile $msi -UseBasicParsing
        Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /quiet /norestart" -Wait
        Write-Log "WSL2 kernel updated" "OK"
    } catch {
        Write-Log "WSL2 kernel already up to date" "OK"
    }
    Set-Step "WSL2 kernel update" "PASS"

    wsl --set-default-version 2 2>&1 | Out-Null

    # Mark phase 2 and register resume task
    Set-Content -Path $PHASE_FILE -Value "2" -Encoding UTF8

    # Copy self to a stable location so Phase 2 works even if the user moves
    # or deletes the original file after rebooting.
    $stablePath = "$PULSE_DIR\pulse-setup.ps1"
    if ($PSCommandPath -ne $stablePath) {
        Copy-Item -Path $PSCommandPath -Destination $stablePath -Force
    }

    $action    = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Normal -File `"$stablePath`""
    $trigger   = New-ScheduledTaskTrigger -AtLogOn
    $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Highest
    Register-ScheduledTask -TaskName $TASK_NAME -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Force | Out-Null
    Write-Log "Phase 2 resume task registered" "OK"
    Set-Step "Phase 2 resume task" "PASS"

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

# ── Phase 2: Ubuntu + Clore.ai + Networking + Auto-start ─────────────────────

function Invoke-Phase2 {
    Show-Banner "Phase 2 of 2 — Installing Clore.ai Provider Stack"

    $script:Steps = [ordered]@{}
    Register-Step "Ubuntu on WSL2"
    Register-Step "systemd in WSL2"
    Register-Step "WSL2 networking"
    Register-Step "GPU compute in WSL2" "Update Windows NVIDIA driver at nvidia.com/drivers"
    Register-Step "Build tools (gcc, python3-dev)" "wsl -d Ubuntu-22.04 -- bash -c 'apt-get update && apt-get install -y build-essential python3-dev'"
    Register-Step "Clore.ai host client" "Check gitlab.com/cloreai-public/hosting for install.sh status"
    Register-Step "Clore fleet onboarding" "Re-download installer from Pulse dashboard to get a fresh fleet token"
    Register-Step "Clore server ID"
    Register-Step "Windows Firewall rules"
    Register-Step "UPnP port forwarding"
    Register-Step "WSL2 port proxy"
    Register-Step "Pulse registration"
    Register-Step "GPU watchdog task"
    Register-Step "Auto-start task"
    Register-Step "Auto-login"

    # Install Ubuntu
    Write-Log "Setting up Ubuntu on WSL2..."
    $distros = wsl --list --quiet 2>&1
    if ($distros -notmatch "Ubuntu-22.04") {
        Write-Log "Downloading Ubuntu 22.04..."
        wsl --install -d Ubuntu-22.04 --no-launch 2>&1 | Out-Null

        # --no-launch downloads but doesn't initialize. Force a headless first-boot
        # so the distro registers as usable (creates root fs, default user = root).
        Write-Log "Initializing Ubuntu (first boot)..."
        wsl -d Ubuntu-22.04 --user root -- bash -c "echo initialized" 2>&1 | Out-Null

        # If the distro still isn't ready, fall back to wsl --install without --no-launch
        $check = wsl -d Ubuntu-22.04 -- echo "ok" 2>&1
        if ($check -notmatch "ok") {
            Write-Log "Headless init failed — launching Ubuntu for first-time setup..." "WARN"
            Write-Host ""
            Write-Host "  Ubuntu needs a one-time setup. A new window will open." -ForegroundColor Yellow
            Write-Host "  Create a Linux username + password, then close that window." -ForegroundColor Yellow
            Write-Host "  This installer will continue automatically." -ForegroundColor Yellow
            Write-Host ""
            Start-Process wsl.exe -ArgumentList "-d Ubuntu-22.04" -Wait
        }

        Write-Log "Ubuntu installed and initialized" "OK"
    } else {
        Write-Log "Ubuntu already present" "OK"
    }
    Set-Step "Ubuntu on WSL2" "PASS"

    # Enable systemd — clore-hosting is a systemd service; without this it silently
    # fails to start after every reboot.
    Write-Log "Enabling systemd in WSL2 (required for clore-hosting service)..."
    wsl -d Ubuntu-22.04 --user root -- bash -c "grep -q 'systemd=true' /etc/wsl.conf 2>/dev/null || printf '[boot]\nsystemd=true\n' > /etc/wsl.conf"

    # WSL2 mirrored networking (Windows 11 22H2+): WSL2 shares the Windows host IP,
    # eliminating portproxy rules entirely and fixing the dynamic-IP problem.
    $osBuild = [System.Environment]::OSVersion.Version.Build
    $mirroredNetworking = $false
    $wslConfigPath = "$env:USERPROFILE\.wslconfig"
    if ($osBuild -ge 22621) {
        Write-Log "Windows 11 22H2+ detected — enabling WSL2 mirrored networking..."
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
        Write-Log "WSL2 mirrored networking configured — portproxy not required" "OK"
        Set-Step "WSL2 networking" "PASS" "Mirrored (Windows 11 22H2+) — stable IP, portproxy not needed"
    } else {
        Write-Log "Windows build ${osBuild}: mirrored networking needs 22H2 (22621+) — will use portproxy" "WARN"
        Set-Step "WSL2 networking" "WARN" "Portproxy mode (build $osBuild) — WSL2 IP refreshed on each login"
    }

    wsl --shutdown
    Start-Sleep 20
    $sdCheck = wsl -d Ubuntu-22.04 --user root -- bash -c "[ -d /run/systemd/system ] && echo yes || echo no" 2>&1
    if ($sdCheck -match "yes") {
        Write-Log "systemd running in WSL2" "OK"
        Set-Step "systemd in WSL2" "PASS"
    } else {
        Write-Log "systemd may not be active — clore-hosting may not auto-start on reboot" "WARN"
        Set-Step "systemd in WSL2" "WARN" "systemd not detected — service may not persist across reboots"
    }

    # ── Detect GPU vendor (needed for driver pre-install and registration) ───────
    $gpuObj    = Get-WmiObject Win32_VideoController | Where-Object { $_.Name -match "NVIDIA|GeForce|RTX|GTX|AMD|Radeon" } | Select-Object -First 1
    $gpuName   = $gpuObj.Name
    $vramMb    = $gpuObj.AdapterRAM
    $vramGb    = if ($vramMb -and $vramMb -gt 0) { [math]::Round($vramMb / 1GB) } else { 8 }
    $gpuVendor = if ($gpuName -match "NVIDIA|GeForce|RTX|GTX") { "NVIDIA" } else { "AMD" }

    # ── Pre-install GPU compute drivers inside WSL2 ───────────────────────────
    # Clore.ai's install.sh checks for GPU drivers and exits if absent.
    # NVIDIA: WSL2 auto-exposes the Windows driver; just verify it's visible.
    # AMD: ROCm userspace must be installed explicitly (no kernel module needed).
    Write-Log "Checking GPU compute environment in WSL2 ($gpuVendor)..."
    if ($gpuVendor -eq "NVIDIA") {
        $nvCheck = wsl -d Ubuntu-22.04 --user root -- bash -c "nvidia-smi -L 2>/dev/null | head -1" 2>&1
        if ($nvCheck -match "GPU 0") {
            Write-Log "NVIDIA GPU visible in WSL2" "OK"
            Set-Step "GPU compute in WSL2" "PASS" "nvidia-smi OK — $gpuName"
        } else {
            Write-Log "NVIDIA GPU not yet visible in WSL2 — ensure Windows NVIDIA driver is up to date" "WARN"
            Set-Step "GPU compute in WSL2" "WARN" "nvidia-smi returned no output — Clore.ai may fail without GPU access"
        }
    } else {
        Write-Log "Installing ROCm for AMD GPU in WSL2 (this takes a few minutes)..."
        $ubuntuVer = wsl -d Ubuntu-22.04 --user root -- bash -c "lsb_release -cs 2>/dev/null" 2>&1
        $ubuntuVer = $ubuntuVer.Trim()
        if ($ubuntuVer -notin @("jammy","focal","noble")) { $ubuntuVer = "jammy" }
        $rocmScript = @"
set -e
apt-get update -qq 2>&1 | tail -2
apt-get install -y -qq wget gnupg ca-certificates 2>&1 | tail -2
mkdir -p /etc/apt/keyrings
wget -qO - https://repo.radeon.com/rocm/rocm.gpg.key | gpg --dearmor -o /etc/apt/keyrings/rocm.gpg
echo 'deb [arch=amd64 signed-by=/etc/apt/keyrings/rocm.gpg] https://repo.radeon.com/rocm/apt/6.2 $ubuntuVer main' > /etc/apt/sources.list.d/rocm.list
apt-get update -qq 2>&1 | tail -2
apt-get install -y -qq rocm-opencl-runtime 2>&1 | tail -5
"@
        wsl -d Ubuntu-22.04 --user root -- bash -c $rocmScript 2>&1 | ForEach-Object { Write-Log $_ }
        if ($LASTEXITCODE -eq 0) {
            Write-Log "ROCm installed" "OK"
            Set-Step "GPU compute in WSL2" "PASS" "ROCm opencl-runtime installed — $gpuName"
        } else {
            Write-Log "ROCm install encountered errors — Clore.ai may have limited AMD support" "WARN"
            Set-Step "GPU compute in WSL2" "WARN" "ROCm install had errors — AMD support may be limited"
        }
    }

    # ── Install Clore.ai host client inside WSL2 ─────────────────────────────
    Write-Log "Installing build tools required by Clore.ai (gcc, python3-dev, python3-pip)..."
    wsl -d Ubuntu-22.04 --user root -- bash -c "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq 2>&1 | tail -2 && apt-get install -y -qq build-essential python3-dev python3-pip 2>&1 | tail -3" 2>&1 | ForEach-Object { Write-Log $_ }
    if ($LASTEXITCODE -eq 0) {
        Set-Step "Build tools (gcc, python3-dev)" "PASS"
    } else {
        Set-Step "Build tools (gcc, python3-dev)" "WARN" "apt-get exit $LASTEXITCODE — Clore.ai will attempt install anyway"
    }

    Write-Log "Installing Clore.ai host client inside WSL2..."
    $cloreInstall = "bash <(curl -fsSL https://gitlab.com/cloreai-public/hosting/-/raw/main/install.sh)"
    $cloreOutput = wsl -d Ubuntu-22.04 --user root -- bash -c $cloreInstall 2>&1
    $cloreExit = $LASTEXITCODE
    $cloreOutput | ForEach-Object { Write-Log $_ }
    if ($cloreExit -ne 0) {
        Set-Step "Clore.ai host client" "FAIL" "install.sh exited $cloreExit — see log for details"
        Write-Log "Clore.ai installation failed (exit $cloreExit). Check the output above." "ERROR"
        Show-Diagnostics; Wait-ForKey; exit 1
    }
    Write-Log "Clore.ai install complete" "OK"
    Set-Step "Clore.ai host client" "PASS"

    # ── Decode fleet token and write /opt/clore-hosting/onboarding.json ─────────
    # The fleet token is a base64-encoded JSON blob from clore.ai Mass Onboard.
    # clore-onboarding.service reads this file, calls machine_onboarding, gets auth
    # tokens, writes the auth file, and starts clore-hosting automatically.
    Write-Log "Decoding Clore fleet token..."
    try {
        $ftPad = 4 - ($CLOREAI_FLEET_TOKEN.Length % 4)
        $ftPadded = if ($ftPad -ne 4) { $CLOREAI_FLEET_TOKEN + ("=" * $ftPad) } else { $CLOREAI_FLEET_TOKEN }
        $fleetCfg = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($ftPadded)) | ConvertFrom-Json
    } catch {
        Set-Step "Clore fleet onboarding" "FAIL" "Could not decode fleet token — re-download installer from Pulse dashboard"
        Write-Log "Fleet token decode failed: $_" "ERROR"
        Show-Diagnostics; Wait-ForKey; exit 1
    }

    $onboardingObj = [ordered]@{ auth = $fleetCfg.auth; mrl = $fleetCfg.mrl }
    foreach ($k in @("on_demand_bitcoin","on_demand_clore","spot_bitcoin","spot_clore","on_demand_usd_blockchain","spot_usd_blockchain","keep_params")) {
        if ($null -ne $fleetCfg.$k) { $onboardingObj[$k] = $fleetCfg.$k }
    }
    $onboardingJson = ($onboardingObj | ConvertTo-Json -Depth 2) -replace "`r`n", "`n"

    Write-Log "Writing onboarding.json to WSL2..."
    wsl -d Ubuntu-22.04 --user root -- bash -c "mkdir -p /opt/clore-hosting"
    $onboardingB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($onboardingJson))
    wsl -d Ubuntu-22.04 --user root -- bash -c "echo '$onboardingB64' | base64 -d > /opt/clore-hosting/onboarding.json"
    Write-Log "onboarding.json written (mrl=$($fleetCfg.mrl)h)" "OK"

    # ── Install clore-onboarding service ─────────────────────────────────────
    Write-Log "Installing Clore fleet onboarding service..."

    $onboardingUnit = @"
[Unit]
Description=Clore Fleet Onboarding Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/clore-onboarding
ExecStart=/usr/bin/python3 /opt/clore-onboarding/clore_onboarding.py --mode linux
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
"@ -replace "`r`n", "`n"

    $unitB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($onboardingUnit))
    wsl -d Ubuntu-22.04 --user root -- bash -c "echo '$unitB64' | base64 -d > /etc/systemd/system/clore-onboarding.service"

    $setupOnboarding = (@'
pip3 install -q requests 2>&1 | tail -1
mkdir -p /opt/clore-onboarding
curl -fsSL "https://gitlab.com/api/v4/projects/cloreai-public%2Fonboarding/repository/files/clore_onboarding.py/raw?ref=main" -o /opt/clore-onboarding/clore_onboarding.py || { echo "ERROR: clore_onboarding.py download failed"; exit 1; }
curl -fsSL "https://gitlab.com/api/v4/projects/cloreai-public%2Fonboarding/repository/files/specs.py/raw?ref=main" -o /opt/clore-onboarding/specs.py || { echo "ERROR: specs.py download failed"; exit 1; }
systemctl daemon-reload
systemctl enable clore-hosting
systemctl enable clore-onboarding
echo "Starting clore-onboarding — registering machine with Clore.ai..."
systemctl start clore-onboarding
echo "Waiting 75s for onboarding to write auth config..."
sleep 75
echo "Starting clore-hosting..."
systemctl start clore-hosting || true
echo "onboarding=$(systemctl is-active clore-onboarding 2>&1)"
echo "hosting=$(systemctl is-active clore-hosting 2>&1)"
'@) -replace "`r`n", "`n"
    $setupB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($setupOnboarding))
    wsl -d Ubuntu-22.04 --user root -- bash -c "echo '$setupB64' | base64 -d > /tmp/setup_onboarding.sh"
    $onboardOutput = wsl -d Ubuntu-22.04 --user root -- bash /tmp/setup_onboarding.sh 2>&1
    $onboardExit = $LASTEXITCODE
    $onboardOutput | ForEach-Object { Write-Log $_ }
    if ($onboardExit -ne 0) {
        Set-Step "Clore fleet onboarding" "FAIL" "Service setup exited $onboardExit — see log"
        Write-Log "Fleet onboarding service setup failed (exit $onboardExit)." "ERROR"
        Show-Diagnostics; Wait-ForKey; exit 1
    }
    Write-Log "Clore fleet onboarding service started" "OK"
    Set-Step "Clore fleet onboarding" "PASS"

    # The bash onboarding script already waited 75s for registration — just let logs settle
    Write-Log "Checking service status after onboarding..."
    Start-Sleep 5

    # ── Poll for server ID — Clore.ai takes 2-5 min to assign after first connect ────
    Write-Log "Waiting for Clore.ai to assign server ID (up to 5 min)..."
    $serverId = ""
    for ($i = 1; $i -le 30; $i++) {
        # Search all likely locations — install.sh may use different subdirs
        $raw = wsl -d Ubuntu-22.04 --user root -- bash -c "cat /opt/clore-hosting/client/server_id 2>/dev/null; cat /opt/clore-hosting/server_id 2>/dev/null; find /opt/clore-hosting -name server_id 2>/dev/null | head -3 | xargs -r cat 2>/dev/null" 2>&1
        $candidate = ($raw | Where-Object { $_ -match '^\s*\d+\s*$' }) | Select-Object -First 1
        if ($candidate) { $serverId = $candidate.Trim(); break }
        # Every 60s log service health to aid debugging
        if ($i % 6 -eq 0) {
            $stat = wsl -d Ubuntu-22.04 --user root -- bash -c "echo hosting=`$(systemctl is-active clore-hosting 2>&1); echo onboarding=`$(systemctl is-active clore-onboarding 2>&1); journalctl -u clore-hosting --no-pager -n 3 2>/dev/null | tail -3" 2>&1
            Write-Log "  Status: $($stat -join ' | ')"
        }
        Write-Log "  Still waiting... ($($i * 10)s elapsed)"
        Start-Sleep 10
    }
    if ($serverId) {
        Write-Log "Clore.ai Server ID: $serverId" "OK"
        Set-Step "Clore server ID" "PASS" "ID: $serverId"
    } else {
        # Capture final service state for log
        $finalStat = wsl -d Ubuntu-22.04 --user root -- bash -c "systemctl status clore-hosting --no-pager -l 2>&1 | head -15; echo '---'; systemctl status clore-onboarding --no-pager -l 2>&1 | head -15" 2>&1
        $finalStat | ForEach-Object { Write-Log $_ }
        Write-Log "Server ID not yet assigned after 5 min — services running; ID will appear in Pulse dashboard once Clore.ai confirms registration" "WARN"
        Set-Step "Clore server ID" "WARN" "Not yet assigned — service running, check dashboard in ~5 min"
        $serverId = ""
    }

    # ── Networking: Windows Firewall + UPnP ──────────────────────────────────
    # Always add Windows Firewall inbound rules so traffic is allowed at the OS level.
    Write-Log "Adding Windows Firewall inbound rules..."
    $allPorts = $CLORE_MGMT_PORTS + ($CLORE_APP_PORT_START..$CLORE_APP_PORT_END)
    foreach ($port in $allPorts) {
        New-NetFirewallRule -DisplayName "Pulse-Clore-TCP-$port" -Direction Inbound `
            -Protocol TCP -LocalPort $port -Action Allow -ErrorAction SilentlyContinue | Out-Null
    }
    Write-Log "Firewall rules added for ports $($CLORE_MGMT_PORTS -join ', ') + $CLORE_APP_PORT_START-$CLORE_APP_PORT_END" "OK"
    Set-Step "Windows Firewall rules" "PASS" "TCP $($CLORE_MGMT_PORTS -join ', '), $CLORE_APP_PORT_START-$CLORE_APP_PORT_END"

    Write-Log "Attempting UPnP automatic port forwarding..."
    $localIP = Get-LocalIP
    $upnpOk  = $false
    try {
        $upnp     = New-Object -ComObject HNetCfg.NATUPnP
        $mappings = $upnp.StaticPortMappingCollection
        $allPorts = $CLORE_MGMT_PORTS + ($CLORE_APP_PORT_START..$CLORE_APP_PORT_END)
        foreach ($port in $allPorts) {
            $mappings.Add($port, "TCP", $port, $localIP, $true, "Pulse-Clore-$port") | Out-Null
        }
        Write-Log "UPnP succeeded — ports $($CLORE_MGMT_PORTS -join ', '), $CLORE_APP_PORT_START-$CLORE_APP_PORT_END forwarded to $localIP" "OK"
        Set-Step "UPnP port forwarding" "PASS" "Auto-forwarded → $localIP"
        $upnpOk = $true
    } catch {
        Write-Log "UPnP unavailable on this router" "WARN"
        Set-Step "UPnP port forwarding" "WARN" "UPnP unavailable — manual router setup required (see above)"
    }

    if (-not $upnpOk) {
        Write-Host ""
        Write-Host "  ┌──────────────────────────────────────────────────────────────┐" -ForegroundColor Yellow
        Write-Host "  │  ROUTER SETUP REQUIRED (one-time, ~2 minutes)                │" -ForegroundColor Yellow
        Write-Host "  │                                                              │" -ForegroundColor Yellow
        Write-Host "  │  Your router doesn't support auto-forwarding (UPnP off).    │" -ForegroundColor Yellow
        Write-Host "  │  Without this, Clore.ai renters can't connect to your GPU.  │" -ForegroundColor Yellow
        Write-Host "  │                                                              │" -ForegroundColor Yellow
        Write-Host "  │  1. Open your router admin page (usually http://192.168.1.1)│" -ForegroundColor Yellow
        Write-Host "  │  2. Find 'Port Forwarding' or 'Virtual Server'              │" -ForegroundColor Yellow
        Write-Host "  │  3. Add these TCP rules → $localIP :                        │" -ForegroundColor Yellow
        foreach ($p in $CLORE_MGMT_PORTS) {
        Write-Host "  │       TCP $p → $localIP`:$p                                 │" -ForegroundColor Yellow
        }
        Write-Host "  │       TCP $CLORE_APP_PORT_START-$CLORE_APP_PORT_END → $localIP`:$CLORE_APP_PORT_START-$CLORE_APP_PORT_END      │" -ForegroundColor Yellow
        Write-Host "  │                                                              │" -ForegroundColor Yellow
        Write-Host "  │  Press Enter once done (you can also finish this later via  │" -ForegroundColor Yellow
        Write-Host "  │  the Pulse dashboard — but jobs won't land until it's done) │" -ForegroundColor Yellow
        Write-Host "  └──────────────────────────────────────────────────────────────┘" -ForegroundColor Yellow
        Read-Host "  Press Enter to continue"
    }

    # ── WSL2 Port Proxy: bridge Windows host → WSL2 internal IP ──────────────
    # Skipped on Windows 11 22H2+ where mirrored networking means WSL2 IS the host IP.
    if (-not $mirroredNetworking) {
        Write-Log "Configuring WSL2 port proxy (Windows host → WSL2 bridge)..."
        $wslIP = (wsl -d Ubuntu-22.04 --user root -- bash -c "hostname -I 2>/dev/null").Trim().Split()[0]
        if ($wslIP) {
            Set-WSL2PortProxy -WslIP $wslIP
            Set-Content -Path "$PULSE_DIR\last_wsl_ip" -Value $wslIP -Encoding UTF8
            Set-Step "WSL2 port proxy" "PASS" "→ $wslIP"
        } else {
            Write-Log "Could not determine WSL2 IP — portproxy skipped; will retry on next login" "WARN"
            Set-Step "WSL2 port proxy" "WARN" "WSL2 IP not found — will retry on next login"
        }
    } else {
        Write-Log "Mirrored networking active — portproxy not needed" "OK"
        Set-Step "WSL2 port proxy" "SKIP" "Not needed — mirrored networking active"
    }

    # ── Register with Pulse ───────────────────────────────────────────────────
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
        Write-Log "Pulse registration failed (will retry on next start): $_" "WARN"
        Set-Step "Pulse registration" "WARN" "Will retry automatically on next login"
    }

    # ── GPU Watchdog: pause Clore.ai during gaming ────────────────────────────
    Write-Log "Installing GPU gaming watchdog..."
    $watchdog = @'
$hi = 75; $lo = 20; $paused = $false
$vendor = if (Get-WmiObject Win32_VideoController | Where-Object { $_.Name -match 'NVIDIA|GeForce|RTX|GTX' } | Select-Object -First 1) { 'NVIDIA' } else { 'AMD' }
while ($true) {
    try {
        $util = if ($vendor -eq 'NVIDIA') {
            [int](& nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>$null).Trim()
        } else {
            $s = Get-Counter '\GPU Engine(*engtype_3D)\Utilization Percentage' -ErrorAction SilentlyContinue
            if ($s) { [int]($s.CounterSamples | Measure-Object -Property CookedValue -Maximum).Maximum } else { 0 }
        }
        if ($util -gt $hi -and -not $paused) {
            wsl -d Ubuntu-22.04 --user root -- bash -c "systemctl stop clore-hosting 2>/dev/null"
            $paused = $true
            Add-Content "$env:LOCALAPPDATA\Pulse\watchdog.log" "$(Get-Date -f 'HH:mm') PAUSED (GPU $util%)"
        } elseif ($util -lt $lo -and $paused) {
            wsl -d Ubuntu-22.04 --user root -- bash -c "systemctl start clore-hosting 2>/dev/null"
            $paused = $false
            Add-Content "$env:LOCALAPPDATA\Pulse\watchdog.log" "$(Get-Date -f 'HH:mm') RESUMED (GPU $util%)"
        }
    } catch {}
    Start-Sleep 30
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
    Write-Log "GPU watchdog installed (pauses during gaming, resumes when idle)" "OK"
    Set-Step "GPU watchdog task" "PASS"

    # ── Auto-start: Clore.ai on every login ──────────────────────────────────
    Write-Log "Installing auto-start task..."
    $autostart = if ($mirroredNetworking) {
        # Mirrored networking: WSL2 IP is stable, no portproxy refresh needed
        @'
Start-Sleep 15
wsl -d Ubuntu-22.04 --user root -- bash -c 'systemctl start clore-onboarding 2>/dev/null; systemctl start clore-hosting 2>/dev/null' 2>&1 |
    Add-Content "$env:LOCALAPPDATA\Pulse\autostart.log"
'@
    } else {
        # Portproxy: WSL2 gets a new IP on each restart — only refresh when it changes
        @"
Start-Sleep 15
`$wslIP = (wsl -d Ubuntu-22.04 --user root -- bash -c 'hostname -I 2>/dev/null').Trim().Split()[0]
`$lastIPFile = "`$env:LOCALAPPDATA\Pulse\last_wsl_ip"
`$lastIP = if (Test-Path `$lastIPFile) { (Get-Content `$lastIPFile).Trim() } else { '' }
if (`$wslIP -and `$wslIP -ne `$lastIP) {
    (@(22, 8080) + ($CLORE_APP_PORT_START..$CLORE_APP_PORT_END)) | ForEach-Object {
        netsh interface portproxy delete v4tov4 listenport=`$_ listenaddress=0.0.0.0 | Out-Null
        netsh interface portproxy add v4tov4 listenport=`$_ listenaddress=0.0.0.0 connectport=`$_ connectaddress=`$wslIP | Out-Null
    }
    Set-Content -Path `$lastIPFile -Value `$wslIP
}
wsl -d Ubuntu-22.04 --user root -- bash -c 'systemctl start clore-onboarding 2>/dev/null; systemctl start clore-hosting 2>/dev/null' 2>&1 |
    Add-Content "`$env:LOCALAPPDATA\Pulse\autostart.log"
"@
    }
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

    # ── Auto-login: survive unattended reboots ────────────────────────────────
    Write-Host ""
    Write-Host "  ┌──────────────────────────────────────────────────────────────┐" -ForegroundColor Yellow
    Write-Host "  │  AUTO-LOGIN (recommended for dedicated GPU servers)          │" -ForegroundColor Yellow
    Write-Host "  │                                                              │" -ForegroundColor Yellow
    Write-Host "  │  Without this, Clore goes OFFLINE after any unattended      │" -ForegroundColor Yellow
    Write-Host "  │  reboot (power cut, Windows Update) until someone logs in.  │" -ForegroundColor Yellow
    Write-Host "  │                                                              │" -ForegroundColor Yellow
    Write-Host "  │  Trade-off: stores your Windows password in the registry.   │" -ForegroundColor Yellow
    Write-Host "  │  Only enable if this machine is in a physically secure spot.│" -ForegroundColor Yellow
    Write-Host "  │  To undo later: run netplwiz and re-enable password prompt. │" -ForegroundColor Yellow
    Write-Host "  └──────────────────────────────────────────────────────────────┘" -ForegroundColor Yellow
    Write-Host ""
    $doAutoLogin = Read-Host "  Enable auto-login? (y/N)"
    if ($doAutoLogin -match '^[Yy]') {
        $securePass = Read-Host "  Enter your Windows login password" -AsSecureString
        $bstr      = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePass)
        $plainPass = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)

        $regPath = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
        Set-ItemProperty -Path $regPath -Name "AutoAdminLogon"    -Value "1"              -Type String
        Set-ItemProperty -Path $regPath -Name "DefaultUsername"    -Value $env:USERNAME    -Type String
        Set-ItemProperty -Path $regPath -Name "DefaultDomainName"  -Value $env:USERDOMAIN  -Type String
        Set-ItemProperty -Path $regPath -Name "DefaultPassword"    -Value $plainPass       -Type String
        $plainPass = $null; [System.GC]::Collect()

        Write-Log "Auto-login enabled for $env:USERNAME — Clore resumes automatically after any reboot" "OK"
        Write-Log "To disable: run netplwiz and re-check 'Users must enter a username and password'" "INFO"
        Set-Step "Auto-login" "PASS" "Enabled for $env:USERNAME"
    } else {
        Write-Log "Auto-login skipped — machine will need a manual login after reboot to resume Clore" "WARN"
        Set-Step "Auto-login" "SKIP" "Skipped — GPU goes offline after unattended reboots"
    }

    # ── Cleanup ───────────────────────────────────────────────────────────────
    Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item $PHASE_FILE -ErrorAction SilentlyContinue

    # Write final diagnostics snapshot to log (screen output is the clean summary below)
    Show-Diagnostics -LogOnly

    # ── Summary ───────────────────────────────────────────────────────────────
    Show-Banner "Setup Complete"
    Write-Host "  Your GPU is now earning via Pulse + Clore.ai." -ForegroundColor Green
    Write-Host ""
    @(
        @{ L = "GPU";          V = $gpuName },
        @{ L = "VRAM";         V = "${vramGb} GB" },
        @{ L = "Platform";     V = "Clore.ai (via Pulse)" },
        @{ L = "Server ID";    V = if ($serverId) { $serverId } else { "Pending — check dashboard" } },
        @{ L = "Gaming pause"; V = "Auto (GPU > 75% util)" },
        @{ L = "Auto-start";   V = "On every Windows login" }
    ) | ForEach-Object { Write-Host ("  {0,-16} {1}" -f $_.L, $_.V) -ForegroundColor White }
    Write-Host ""
    Write-Host "  Dashboard: https://beneficial-deep-work-flow.base44.app" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  ┌──────────────────────────────────────────────────────────────┐" -ForegroundColor DarkGray
    Write-Host "  │  INSTALL LOG                                                 │" -ForegroundColor DarkGray
    Write-Host "  │                                                              │" -ForegroundColor DarkGray
    Write-Host "  │  A full log of every install step was saved to:              │" -ForegroundColor DarkGray
    Write-Host "  │                                                              │" -ForegroundColor DarkGray
    Write-Host ("  │    {0,-60}│" -f $LOG_FILE) -ForegroundColor White
    Write-Host "  │                                                              │" -ForegroundColor DarkGray
    Write-Host "  │  To open it:   notepad `"$LOG_FILE`"" -ForegroundColor DarkGray
    Write-Host "  │  To browse:    Run → %LOCALAPPDATA%\Pulse                    │" -ForegroundColor DarkGray
    Write-Host "  │                                                              │" -ForegroundColor DarkGray
    Write-Host "  │  Share it with Pulse support if anything looks wrong.        │" -ForegroundColor DarkGray
    Write-Host "  └──────────────────────────────────────────────────────────────┘" -ForegroundColor DarkGray
    Write-Host ""
    Wait-ForKey
}

# ── Entry Point ───────────────────────────────────────────────────────────────

trap {
    Write-Host ""
    Write-Host "  [ERROR] An unexpected error stopped the installer:" -ForegroundColor Red
    Write-Host "  $_" -ForegroundColor Red
    Show-Diagnostics
    Read-Host "  Press Enter to close this window"
    exit 1
}

Assert-Admin
New-Item -ItemType Directory -Force -Path $PULSE_DIR | Out-Null

$phase = if (Test-Path $PHASE_FILE) { Get-Content $PHASE_FILE } else { "1" }
switch ($phase) {
    "1"     { Invoke-Phase1 }
    "2"     { Invoke-Phase2 }
    default { Write-Host "Unknown phase: $phase" -ForegroundColor Red; Wait-ForKey; exit 1 }
}
