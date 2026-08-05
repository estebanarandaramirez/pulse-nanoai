/**
 * generateSetupScript v2
 * Returns a platform-specific PowerShell installer (.ps1 or .bat wrapper)
 * with the user's session token, app ID, and Clore fleet token embedded.
 *
 * Input: { platform: "clore" | "octaspace", format?: "ps1" | "bat" }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// The fleet token is stored as a secret (shared across all machines)
const CLOREAI_FLEET_TOKEN = Deno.env.get('CLOREAI_FLEET_TOKEN') ?? '';
const OCTASPACE_API_KEY   = Deno.env.get('OCTASPACE_API_KEY') ?? '';

// ── Clore.ai PS1 ─────────────────────────────────────────────────────────────
// Full installer script for Clore.ai — WSL2 + clore-hosting + fleet onboarding
const CLORE_PS1 = `#Requires -Version 5.1
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

$PULSE_DIR       = "$env:LOCALAPPDATA\\Pulse"
$PHASE_FILE      = "$PULSE_DIR\\setup_phase"
$LOG_FILE        = "$PULSE_DIR\\setup.log"
$TASK_NAME       = "PulseSetupResume"
$COORDINATOR_TASK = "PulseCoordinator"
$AUTOSTART_TASK  = "PulseAutoStart"

$CLORE_MGMT_PORTS     = @(22, 8080)
$CLORE_APP_PORT_START = 3000
$CLORE_APP_PORT_END   = 4000

function Write-Log {
    param([string]$msg, [string]$level = "INFO")
    $ts = Get-Date -Format "HH:mm:ss"
    Add-Content -Path $LOG_FILE -Value "[$ts][$level] $msg" -Encoding UTF8 -ErrorAction SilentlyContinue
    switch ($level) {
        "OK"    { Write-Host "  [OK] $msg" -ForegroundColor Green }
        "WARN"  { Write-Host "  [!!] $msg" -ForegroundColor Yellow }
        "ERROR" { Write-Host "  [X]  $msg" -ForegroundColor Red }
        default { Write-Host "  ... $msg" -ForegroundColor Cyan }
    }
}

function Upload-InstallLog {
    param([string]$Step)
    try {
        $lc = if (Test-Path $LOG_FILE) { [System.IO.File]::ReadAllText($LOG_FILE, [System.Text.Encoding]::UTF8) } else { "(no log file)" }
        $payload = [System.Text.Encoding]::UTF8.GetBytes((@{platform="clore";error_step=$Step;log_content=$lc} | ConvertTo-Json -Compress -Depth 2))
        Invoke-RestMethod -Method POST -Uri "$PULSE_API_BASE/reportInstallIssue" -Headers @{"Authorization"="Bearer $PULSE_USER_TOKEN";"Content-Type"="application/json"} -Body $payload -TimeoutSec 30 | Out-Null
        Write-Log "Install report uploaded to Pulse support" "OK"
    } catch { Write-Log "Could not upload install report (non-fatal): $_" "WARN" }
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
        Start-Process powershell "-NoProfile -ExecutionPolicy Bypass -File \`"$PSCommandPath\`"" -Verb RunAs
        exit
    }
}

function Wait-ForKey {
    Write-Host ""
    Read-Host "  Press Enter to close this window"
}

function Get-LocalIP {
    # Use the interface that actually has a default gateway (i.e. internet-facing adapter)
    $cfg = Get-NetIPConfiguration |
        Where-Object { $_.IPv4DefaultGateway -ne $null -and $_.NetAdapter.Status -eq "Up" } |
        Select-Object -First 1
    if ($cfg) { return $cfg.IPv4Address.IPAddress }
    # Fallback: first non-loopback/WSL/vEthernet address
    (Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.InterfaceAlias -notmatch "Loopback|WSL|vEthernet" -and $_.IPAddress -notmatch "^169\\.254\\." } |
        Select-Object -First 1).IPAddress
}

function Set-WSL2PortProxy {
    param([string]$WslIP)
    $allPorts = $CLORE_MGMT_PORTS + ($CLORE_APP_PORT_START..$CLORE_APP_PORT_END)
    foreach ($p in $allPorts) {
        netsh interface portproxy delete v4tov4 listenport=$p listenaddress=0.0.0.0 | Out-Null
        netsh interface portproxy add v4tov4 listenport=$p listenaddress=0.0.0.0 \`
            connectport=$p connectaddress=$WslIP | Out-Null
    }
    Write-Log "WSL2 portproxy configured → $WslIP" "OK"
}

function Invoke-Phase1 {
    Show-Banner "Phase 1 of 2 — Enabling WSL2"

    $build = [System.Environment]::OSVersion.Version.Build
    if ($build -lt 19041) {
        Write-Log "Windows build $build is too old. WSL2 requires build 19041+ (Windows 10 2004+)." "ERROR"
        Upload-InstallLog "windows_too_old"
        Wait-ForKey; exit 1
    }
    Write-Log "Windows build $build — OK" "OK"

    $gpu = (Get-WmiObject Win32_VideoController |
        Where-Object { $_.Name -match "NVIDIA|GeForce|RTX|GTX|AMD|Radeon" } |
        Select-Object -First 1).Name
    if (-not $gpu) {
        Write-Log "No supported GPU detected. Pulse requires an NVIDIA or AMD GPU." "ERROR"
        Upload-InstallLog "no_gpu_detected"
        Wait-ForKey; exit 1
    }
    Write-Log "GPU: $gpu" "OK"

    New-Item -ItemType Directory -Force -Path $PULSE_DIR | Out-Null

    $virtEnabled = (Get-ComputerInfo).HyperVRequirementVirtualizationFirmwareEnabled
    if ($virtEnabled -eq $false) {
        Write-Log "Hardware virtualization is disabled in your BIOS/UEFI." "ERROR"
        Write-Host ""
        Write-Host "  ACTION REQUIRED: Enable virtualization (SVM/VT-x) in your BIOS, then re-run." -ForegroundColor Red
        Write-Host ""
        Upload-InstallLog "virtualization_disabled"
        Wait-ForKey; exit 1
    }
    Write-Log "Hardware virtualization enabled — OK" "OK"

    dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart | Out-Null
    dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart | Out-Null
    Write-Log "WSL2 features enabled" "OK"

    $msi = "$env:TEMP\\wsl_update.msi"
    try {
        Invoke-WebRequest "https://wslstorestorage.blob.core.windows.net/wslblob/wsl_update_x64.msi" \`
            -OutFile $msi -UseBasicParsing
        Start-Process msiexec.exe -ArgumentList "/i \`"$msi\`" /quiet /norestart" -Wait
    } catch {}
    Write-Log "WSL2 kernel update applied" "OK"

    wsl --set-default-version 2 2>&1 | Out-Null

    Set-Content -Path $PHASE_FILE -Value "2" -Encoding UTF8
    $stablePath = "$PULSE_DIR\\pulse-setup.ps1"
    if ($PSCommandPath -ne $stablePath) { Copy-Item -Path $PSCommandPath -Destination $stablePath -Force }

    $action    = New-ScheduledTaskAction -Execute "powershell.exe" \`
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Normal -File \`"$stablePath\`""
    $trigger   = New-ScheduledTaskTrigger -AtLogOn
    $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Highest
    Register-ScheduledTask -TaskName $TASK_NAME -Action $action -Trigger $trigger \`
        -Settings $settings -Principal $principal -Force | Out-Null
    Write-Log "Phase 2 resume task registered" "OK"

    Write-Host ""
    Write-Host "  One reboot required. Setup will resume automatically." -ForegroundColor Yellow
    Write-Host ""
    $answer = Read-Host "  Reboot now? (Y/n)"
    if ($answer -ne "n") { Restart-Computer -Force }
    else { Write-Host "  Reboot when ready." -ForegroundColor DarkGray }
}

function Invoke-Phase2 {
    Show-Banner "Phase 2 of 2 — Installing Clore.ai Provider Stack"

    # wsl --list outputs UTF-16 with null bytes — regex never matches even with Out-String.
    # Read the registry directly instead; distro names are plain ASCII there.
    function Test-Ubuntu {
        try {
            return [bool](Get-ChildItem "HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Lxss" -ErrorAction Stop |
                ForEach-Object { (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).DistributionName } |
                Where-Object { $_ -eq "Ubuntu-22.04" })
        } catch { return $false }
    }

    if (-not (Test-Ubuntu)) {
        Write-Log "Installing Ubuntu 22.04..."
        wsl --install -d Ubuntu-22.04 --no-launch 2>&1 | ForEach-Object { Write-Log $_ }

        # Wait up to 30s for the distro to appear (registration can be slow)
        $registered = $false
        for ($t = 1; $t -le 6; $t++) {
            Start-Sleep 5
            if (Test-Ubuntu) { $registered = $true; break }
            Write-Log "  Waiting for Ubuntu registration... ($($t * 5)s)"
        }

        if (-not $registered) {
            Write-Log "First install attempt did not register distro. Retrying..." "WARN"
            Write-Host "  If an Ubuntu window appears, create any username/password, then close it." -ForegroundColor Yellow
            wsl --install -d Ubuntu-22.04 2>&1 | ForEach-Object { Write-Log $_ }
            Start-Sleep 15
            $registered = Test-Ubuntu
        }

        if (-not $registered) {
            Write-Log "Ubuntu 22.04 installation failed — install it from the Microsoft Store, complete setup, then re-run." "ERROR"
            Upload-InstallLog "ubuntu_install_failed"
            Wait-ForKey; exit 1
        }
    } else {
        Write-Log "Ubuntu 22.04 already present" "OK"
    }

    # Initialize Ubuntu headlessly — use ubuntu2204.exe install --root to bypass OOBE
    $rootOk = (wsl -d Ubuntu-22.04 --user root -- bash -c "echo ok" 2>&1 | Out-String) -match "ok"
    if (-not $rootOk) {
        Write-Log "Running Ubuntu headless init (no GUI required)..."
        $ubuntuExe = Get-ChildItem "$env:LOCALAPPDATA\\Microsoft\\WindowsApps" -Filter "ubuntu*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($ubuntuExe) {
            & $ubuntuExe.FullName install --root 2>&1 | Out-Null
        } else {
            wsl -d Ubuntu-22.04 --user root -- bash -c "echo ok" 2>&1 | Out-Null
        }
        Start-Sleep 5
        $rootOk = (wsl -d Ubuntu-22.04 --user root -- bash -c "echo ok" 2>&1 | Out-String) -match "ok"
        if (-not $rootOk) {
            Write-Log "Cannot access Ubuntu 22.04 as root — re-run installer." "ERROR"
            Upload-InstallLog "ubuntu_root_access_failed"
            Wait-ForKey; exit 1
        }
    }
    Write-Log "Ubuntu 22.04 ready" "OK"

    wsl -d Ubuntu-22.04 --user root -- bash -c "grep -q 'systemd=true' /etc/wsl.conf 2>/dev/null || printf '[boot]\nsystemd=true\n' > /etc/wsl.conf"

    $osBuild = [System.Environment]::OSVersion.Version.Build
    $mirroredNetworking = $false
    $wslConfigPath = "$env:USERPROFILE\\.wslconfig"
    if ($osBuild -ge 22621) {
        $wslConfigContent = if (Test-Path $wslConfigPath) { Get-Content $wslConfigPath -Raw } else { "" }
        $changed = $false
        if ($wslConfigContent -notmatch 'networkingMode') {
            if ($wslConfigContent -match '\[wsl2\]') {
                $wslConfigContent = $wslConfigContent -replace '(\[wsl2\])', "\`$1\`nnetworkingMode=mirrored"
            } else {
                $wslConfigContent += "\`n[wsl2]\`nnetworkingMode=mirrored\`n"
            }
            $changed = $true
        }
        if ($wslConfigContent -notmatch 'vmIdleTimeout') {
            if ($wslConfigContent -match '\[wsl2\]') {
                $wslConfigContent = $wslConfigContent -replace '(\[wsl2\])', "\`$1\`nvmIdleTimeout=-1"
            } else {
                $wslConfigContent += "\`n[wsl2]\`nvmIdleTimeout=-1\`n"
            }
            $changed = $true
        }
        if ($changed) { Set-Content -Path $wslConfigPath -Value $wslConfigContent -Encoding UTF8 }
        $mirroredNetworking = $true
        Write-Log "WSL2 networking configured (mirrored, vmIdleTimeout=-1)" "OK"
    } else {
        $wslConfigContent = if (Test-Path $wslConfigPath) { Get-Content $wslConfigPath -Raw } else { "" }
        if ($wslConfigContent -notmatch 'vmIdleTimeout') {
            if ($wslConfigContent -match '\[wsl2\]') {
                $wslConfigContent = $wslConfigContent -replace '(\[wsl2\])', "\`$1\`nvmIdleTimeout=-1"
            } else {
                $wslConfigContent += "\`n[wsl2]\`nvmIdleTimeout=-1\`n"
            }
            Set-Content -Path $wslConfigPath -Value $wslConfigContent -Encoding UTF8
        }
    }

    wsl --shutdown
    Start-Sleep 20

    $gpuObj    = Get-WmiObject Win32_VideoController | Where-Object { $_.Name -match "NVIDIA|GeForce|RTX|GTX" } | Select-Object -First 1
    if (-not $gpuObj) { $gpuObj = Get-WmiObject Win32_VideoController | Where-Object { $_.Name -match "AMD|Radeon" } | Select-Object -First 1 }
    $gpuName   = $gpuObj.Name
    $vramMb    = $gpuObj.AdapterRAM
    $vramGb    = if ($vramMb -and $vramMb -gt 0) { [math]::Round($vramMb / 1GB) } else { 8 }
    $gpuVendor = if ($gpuName -match "NVIDIA|GeForce|RTX|GTX") { "NVIDIA" } else { "AMD" }

    if ($gpuVendor -eq "NVIDIA") {
        $nvCheck = wsl -d Ubuntu-22.04 --user root -- bash -c "nvidia-smi -L 2>/dev/null | head -1" 2>&1
        if ($nvCheck -match "GPU 0") { Write-Log "NVIDIA GPU visible in WSL2" "OK" }
        else { Write-Log "NVIDIA GPU not yet visible in WSL2 — ensure Windows NVIDIA driver is up to date" "WARN" }
    }

    Write-Log "Installing build tools..."
    wsl -d Ubuntu-22.04 --user root -- bash -c "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq 2>&1 | tail -1 && apt-get install -y -qq build-essential python3-dev python3-pip 2>&1 | tail -2" 2>&1 | ForEach-Object { Write-Log $_ }

    Write-Log "Installing Clore.ai host client..."
    $cloreAlready = (wsl -d Ubuntu-22.04 --user root -- bash -c "[ -f /etc/systemd/system/clore-hosting.service ] && echo yes || echo no" 2>&1 | Out-String) -match "yes"
    if ($cloreAlready) {
        Write-Log "Clore.ai host client already installed" "OK"
    } else {
        # Remove any partial /opt/clore-hosting so install.sh sees a clean slate
        wsl -d Ubuntu-22.04 --user root -- bash -c "rm -rf /opt/clore-hosting 2>/dev/null; true"
        $cloreOutput = wsl -d Ubuntu-22.04 --user root -- bash -c "bash <(curl -fsSL https://gitlab.com/cloreai-public/hosting/-/raw/main/install.sh)" 2>&1
        $cloreExit = $LASTEXITCODE
        $cloreOutput | ForEach-Object { Write-Log $_ }
        if ($cloreExit -ne 0) {
            Write-Log "Clore.ai installation failed (exit $cloreExit)." "ERROR"
            Upload-InstallLog "cloreai_install_failed"
            Wait-ForKey; exit 1
        }
        Write-Log "Clore.ai install complete" "OK"
    }

    Write-Log "Capping NVIDIA HugePages at 256 (512MB) to prevent RAM starvation..."
    wsl -d Ubuntu-22.04 --user root -- bash -c "echo vm.nr_hugepages=256 > /etc/sysctl.d/90-wsl.conf && sysctl -p /etc/sysctl.d/90-wsl.conf" 2>&1 | ForEach-Object { Write-Log $_ }
    Write-Log "HugePages capped — NVIDIA driver limited to 512MB kernel pages" "OK"

    # Decode fleet token and write onboarding.json
    Write-Log "Decoding Clore fleet token..."
    try {
        $ftPad = 4 - ($CLOREAI_FLEET_TOKEN.Length % 4)
        $ftPadded = if ($ftPad -ne 4) { $CLOREAI_FLEET_TOKEN + ("=" * $ftPad) } else { $CLOREAI_FLEET_TOKEN }
        $fleetCfg = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($ftPadded)) | ConvertFrom-Json
    } catch {
        Write-Log "Fleet token decode failed: $_" "ERROR"
        Upload-InstallLog "fleet_token_decode_failed"
        Wait-ForKey; exit 1
    }

    $onboardingObj = [ordered]@{ auth = $fleetCfg.auth; mrl = $fleetCfg.mrl }
    foreach ($k in @("on_demand_bitcoin","on_demand_clore","spot_bitcoin","spot_clore","on_demand_usd_blockchain","spot_usd_blockchain","keep_params")) {
        if ($null -ne $fleetCfg.$k) { $onboardingObj[$k] = $fleetCfg.$k }
    }
    $onboardingJson = ($onboardingObj | ConvertTo-Json -Depth 2) -replace "\`r\`n", "\`n"
    wsl -d Ubuntu-22.04 --user root -- bash -c "mkdir -p /opt/clore-hosting /opt/clore-onboarding"
    $onboardingB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($onboardingJson))
    wsl -d Ubuntu-22.04 --user root -- bash -c "echo '$onboardingB64' | base64 -d | tee /opt/clore-hosting/onboarding.json /opt/clore-onboarding/onboarding.json > /dev/null"
    Write-Log "onboarding.json written" "OK"

    # Install clore-onboarding service
    # Fix: nvidia-smi lives in /usr/lib/wsl/lib/ which is NOT in systemd service PATH,
    # so clore_onboarding.py (which calls nvidia-smi to detect GPU) always crashed.
    # Symlinking into /usr/local/bin/ makes it accessible to all services.
    $setupOnboarding = @'
rm -f /usr/local/bin/nvidia-smi; NV=/usr/lib/wsl/lib/nvidia-smi; [ ! -f "$NV" ] && NV=$(find /usr/lib/wsl -name nvidia-smi 2>/dev/null | head -1); [ -f "$NV" ] && ln -sf "$NV" /usr/local/bin/nvidia-smi && echo 'nvidia-smi symlinked OK' || echo 'WARNING: nvidia-smi not found'; pip3 install -q requests 2>&1 | tail -1; mkdir -p /opt/clore-onboarding; curl -fsSL 'https://gitlab.com/api/v4/projects/cloreai-public%2Fonboarding/repository/files/clore_onboarding.py/raw?ref=main' -o /opt/clore-onboarding/clore_onboarding.py || { echo 'ERROR: clore_onboarding.py download failed'; exit 1; }; curl -fsSL 'https://gitlab.com/api/v4/projects/cloreai-public%2Fonboarding/repository/files/specs.py/raw?ref=main' -o /opt/clore-onboarding/specs.py || { echo 'ERROR: specs.py download failed'; exit 1; }; printf '[Unit]\nDescription=Clore Fleet Onboarding Service\n\n[Service]\nType=simple\nWorkingDirectory=/opt/clore-onboarding\nExecStart=/usr/bin/python3 /opt/clore-onboarding/clore_onboarding.py --mode linux\nRestart=always\nRestartSec=10\n\n[Install]\nWantedBy=multi-user.target\n' > /etc/systemd/system/clore-onboarding.service; update-alternatives --set iptables /usr/sbin/iptables-legacy 2>/dev/null || true; update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy 2>/dev/null || true; mkdir -p /etc/docker; echo eyJpcHRhYmxlcyI6ZmFsc2UsImRlZmF1bHQtcnVudGltZSI6Im52aWRpYSIsInJ1bnRpbWVzIjp7Im52aWRpYSI6eyJwYXRoIjoibnZpZGlhLWNvbnRhaW5lci1ydW50aW1lIiwicnVudGltZUFyZ3MiOltdfX19 | base64 -d > /etc/docker/daemon.json; echo br_netfilter > /etc/modules-load.d/clore.conf; modprobe br_netfilter 2>/dev/null || true; systemctl restart docker 2>/dev/null || true; docker network prune -f 2>/dev/null; true; printf '#!/bin/bash\nuntil curl -sf --max-time 5 https://api.clore.ai/server-config.json > /dev/null 2>&1; do\n    echo "$(date) | Waiting for network (api.clore.ai not reachable)..."\n    sleep 5\ndone\necho "$(date) | Network ready, starting hosting.py"\n\ncd /opt/clore-hosting/hosting\nwhile true; do\n    setsid -w /opt/clore-hosting/.miniconda-env/bin/python3 hosting.py --service\n    echo "hosting.py restarting in 5s..."\n    sleep 5\ndone\n' > /opt/clore-hosting/pulse-hosting-loop.sh; chmod +x /opt/clore-hosting/pulse-hosting-loop.sh; mkdir -p /etc/systemd/system/clore-hosting.service.d; printf '[Unit]\nAfter=docker.service\n\n[Service]\nEnvironment="PYTHONUNBUFFERED=1"\nEnvironment="PATH=/opt/clore-hosting/.miniconda-env/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"\nExecStartPre=/bin/rm -f /opt/clore-hosting/.clore-partner/host_facts/partner_interface.socket\nExecStartPre=/bin/bash -c "iptables -t nat -C POSTROUTING -s 172.16.0.0/12 ! -d 172.16.0.0/12 -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s 172.16.0.0/12 ! -d 172.16.0.0/12 -j MASQUERADE"\nExecStart=\nExecStart=/opt/clore-hosting/pulse-hosting-loop.sh\n' > /etc/systemd/system/clore-hosting.service.d/override.conf; systemctl daemon-reload; systemctl enable clore-hosting; systemctl enable clore-onboarding; echo 'Starting clore-onboarding...'; systemctl start clore-onboarding; echo 'Waiting 75s for onboarding to register...'; sleep 75; echo 'Starting clore-hosting...'; systemctl start clore-hosting || true; echo 'Disabling clore-onboarding - registration complete'; systemctl stop clore-onboarding; systemctl disable clore-onboarding; echo 'clore-onboarding disabled'
'@
    $setupB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($setupOnboarding))
    wsl -d Ubuntu-22.04 --user root -- bash -c "echo '$setupB64' | base64 -d | bash"
    Write-Log "Clore fleet onboarding service started" "OK"

    Write-Log "Waiting for clore-hosting to start (up to 2 min)..."
    for ($i = 1; $i -le 12; $i++) {
        $svcOk = (wsl -d Ubuntu-22.04 --user root -- bash -c "systemctl is-active clore-hosting 2>/dev/null && echo ok" 2>&1 | Out-String) -match "ok"
        if ($svcOk) { Write-Log "clore-hosting running" "OK"; break }
        if ($i % 3 -eq 0) {
            $stat = wsl -d Ubuntu-22.04 --user root -- bash -c "systemctl is-active clore-hosting 2>&1" 2>&1
            Write-Log "  Service status: $stat"
        }
        Write-Log "  Waiting for clore-hosting... ($($i * 10)s)"
        Start-Sleep 10
    }

    Write-Log "Waiting for Clore.ai to assign server ID (up to 5 min)..."
    $serverId = ""
    for ($i = 1; $i -le 30; $i++) {
        $raw = wsl -d Ubuntu-22.04 --user root -- bash -c "cat /opt/clore-hosting/client/server_id 2>/dev/null; cat /opt/clore-hosting/server_id 2>/dev/null; find /opt/clore-hosting -name server_id 2>/dev/null | head -3 | xargs -r cat 2>/dev/null" 2>&1
        $candidate = ($raw | Where-Object { $_ -match '^\\s*\\d+\\s*$' }) | Select-Object -First 1
        if ($candidate) { $serverId = $candidate.Trim(); break }
        if ($i % 6 -eq 0) {
            $stat = wsl -d Ubuntu-22.04 --user root -- bash -c "systemctl is-active clore-hosting 2>&1; systemctl is-active clore-onboarding 2>&1" 2>&1
            Write-Log "  Service status: $($stat -join ' / ')"
        }
        Write-Log "  Still waiting... ($($i * 10)s)"
        Start-Sleep 10
    }
    if ($serverId) { Write-Log "Clore.ai Server ID: $serverId" "OK" }
    else { Write-Log "Server ID not yet assigned — check dashboard in ~5 min" "WARN" }

    # Set competitive pricing — 5% below median for our GPU model on Clore.ai marketplace
    Write-Log "Setting competitive pricing..."
    $cloreAuth = $fleetCfg.auth
    try {
        $mktResp = Invoke-RestMethod -Uri "https://api.clore.ai/v1/marketplace" \`
            -Headers @{ "auth" = $cloreAuth } -Method GET -ErrorAction Stop
        $gpuTag = if ($gpuName -match "RTX\\s*(\\d+\\s*Ti?)") { $Matches[0].Trim() } \`
                  elseif ($gpuName -match "GTX\\s*(\\d+\\s*Ti?)") { $Matches[0].Trim() } \`
                  else { ($gpuName -split " " | Select-Object -Last 1) }
        $gpuListings = @($mktResp.servers | Where-Object {
            ($_.gpu_array -join " ") -match [regex]::Escape($gpuTag)
        })
        $targetDay = 0.08
        if ($gpuListings.Count -gt 0) {
            $hrs = $gpuListings | ForEach-Object {
                $p = $_.price.usd.on_demand_usd; if ($p) { [float]$p }
            } | Where-Object { $_ -gt 0 }
            if ($hrs) {
                $med = ($hrs | Sort-Object)[[math]::Floor($hrs.Count / 2)]
                $targetDay = [math]::Round($med * 24 * 0.95, 4)
            }
        }
        $spotDay = [math]::Round($targetDay * 0.8, 4)
        $idNum = if ($serverId) { [int]$serverId } else { 0 }
        $priceBody = @{ id = $idNum; name = "Pulse-$idNum"; availability = $true; mrl = 96; on_demand = $targetDay; spot = $spotDay } | ConvertTo-Json
        $priceResp = Invoke-RestMethod -Uri "https://api.clore.ai/v1/set_server_settings" \`
            -Method POST -Headers @{ "auth" = $cloreAuth; "Content-Type" = "application/json" } \`
            -Body $priceBody -ErrorAction Stop
        if ($priceResp.code -eq 0) {
            Write-Log "Pricing set — on-demand: \`$$targetDay/day | spot: \`$$spotDay/day" "OK"
        } else {
            Write-Log "Pricing API returned code $($priceResp.code) — set manually in Clore dashboard" "WARN"
        }
    } catch {
        Write-Log "Auto-pricing skipped (set manually in Clore dashboard): $_" "WARN"
    }

    Write-Log "Adding Windows Firewall rules..."
    Remove-NetFirewallRule -DisplayName "Pulse-Clore-*" -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName "Pulse-Clore-Mgmt" -Direction Inbound \`
        -Protocol TCP -LocalPort @(22, 8080) -Action Allow -ErrorAction SilentlyContinue | Out-Null
    New-NetFirewallRule -DisplayName "Pulse-Clore-Apps" -Direction Inbound \`
        -Protocol TCP -LocalPort "3000-4000" -Action Allow -ErrorAction SilentlyContinue | Out-Null
    Write-Log "Firewall rules added" "OK"

    if (-not $mirroredNetworking) {
        $localIP = Get-LocalIP
        if (-not $localIP -or $localIP -match "^169\\.254\\.") {
            Write-Log "Could not detect a valid LAN IP (got: $localIP). Run 'ipconfig' to find your IP." "WARN"
            $localIP = Read-Host "  Enter your PC's LAN IP (e.g. 192.168.1.50)"
        }
        $upnpPorts = $CLORE_MGMT_PORTS + ($CLORE_APP_PORT_START..$CLORE_APP_PORT_END)
        try {
            $upnp = New-Object -ComObject HNetCfg.NATUPnP
            $mappings = $upnp.StaticPortMappingCollection
            foreach ($port in $upnpPorts) { $mappings.Add($port, "TCP", $port, $localIP, $true, "Pulse-Clore-$port") | Out-Null }
            Write-Log "UPnP port forwarding succeeded → $localIP" "OK"
        } catch {
            Write-Log "UPnP unavailable — manually forward TCP 22, 8080, 3000-4000 to $localIP on your router" "WARN"
        }
    }

    if (-not $mirroredNetworking) {
        $wslIP = (wsl -d Ubuntu-22.04 --user root -- bash -c "hostname -I 2>/dev/null").Trim().Split()[0]
        if ($wslIP) {
            Set-WSL2PortProxy -WslIP $wslIP
            Set-Content -Path "$PULSE_DIR\\last_wsl_ip" -Value $wslIP -Encoding UTF8
        } else { Write-Log "Could not determine WSL2 IP — portproxy skipped" "WARN" }
    }

    Write-Log "Registering machine with Pulse..."
    $regBody = @{ gpu_model = $gpuName; vram_gb = $vramGb; clore_server_id = $serverId; platform = "Clore.ai" } | ConvertTo-Json
    try {
        $resp = Invoke-RestMethod -Uri "$PULSE_API_BASE/registerGPUDaemon" -Method POST \`
            -ContentType "application/json" -Headers @{ "Authorization" = "Bearer $PULSE_USER_TOKEN" } -Body $regBody
        Write-Log "Pulse registration: $($resp.message)" "OK"
    } catch { Write-Log "Pulse registration failed (will retry on next start): $_" "WARN" }

    $coordTemplate = @'
$coordLog = "$env:LOCALAPPDATA\\Pulse\\coordinator.log"
$PULSE_API_BASE = "##API_BASE##"
$PULSE_USER_TOKEN = "##USER_TOKEN##"
$keepalivePid = $null

function Ensure-WSLAlive {
    if ($null -eq $keepalivePid -or -not (Get-Process -Id $keepalivePid -ErrorAction SilentlyContinue)) {
        $p = Start-Process "wsl.exe" -ArgumentList "-d Ubuntu-22.04 --user root -- bash -c 'while true; do sleep 3600; done'" -PassThru -WindowStyle Hidden -ErrorAction SilentlyContinue
        if ($p) { $script:keepalivePid = $p.Id; Add-Content $coordLog "$(Get-Date -f 'yyyy-MM-dd HH:mm') WSL keepalive (PID $($p.Id))" }
    }
}
function wsl-svc([string]$cmd) { (wsl -d Ubuntu-22.04 --user root -- bash -c $cmd 2>&1 | Out-String).Trim() }

Ensure-WSLAlive
Add-Content $coordLog "$(Get-Date -f 'yyyy-MM-dd HH:mm') Coordinator started"

while ($true) {
    try {
        Ensure-WSLAlive
        $octaExists  = [int](wsl-svc "systemctl list-unit-files osn.service 2>/dev/null | grep -c osn") -gt 0
        $cloreExists = [int](wsl-svc "systemctl list-unit-files clore-hosting.service 2>/dev/null | grep -c clore-hosting") -gt 0
        if ($octaExists -and $cloreExists) {
            $cloreRented = [int](wsl-svc "docker ps -q 2>/dev/null | wc -l") -gt 0
            $octaRented  = $false
            $nodeFile = "$env:LOCALAPPDATA\\Pulse\\octa_node_name.txt"
            if (Test-Path $nodeFile) {
                $nodeName = (Get-Content $nodeFile -Raw).Trim()
                try {
                    $r = Invoke-RestMethod "$PULSE_API_BASE/getOctaNodeInfo" -Headers @{Authorization="Bearer $PULSE_USER_TOKEN"} -TimeoutSec 15 -ErrorAction Stop
                    $n = $r.nodes | Where-Object { $_.name -eq $nodeName } | Select-Object -First 1
                    $octaRented = $n -and $n.availability -eq "busy"
                } catch { }
            }
            if ($cloreRented -and -not $octaRented) {
                if ((wsl-svc "systemctl is-active osn 2>/dev/null") -eq "active") {
                    wsl -d Ubuntu-22.04 --user root -- bash -c "systemctl stop osn 2>/dev/null" | Out-Null
                    Add-Content $coordLog "$(Get-Date -f 'yyyy-MM-dd HH:mm') Clore rental -- paused osn"
                }
            } elseif ($octaRented -and -not $cloreRented) {
                if ((wsl-svc "systemctl is-active clore-hosting 2>/dev/null") -eq "active") {
                    wsl -d Ubuntu-22.04 --user root -- bash -c "systemctl stop clore-hosting 2>/dev/null" | Out-Null
                    Add-Content $coordLog "$(Get-Date -f 'yyyy-MM-dd HH:mm') OctaSpace rental -- paused clore-hosting"
                }
            } else {
                if ((wsl-svc "systemctl is-active osn 2>/dev/null") -ne "active") {
                    wsl -d Ubuntu-22.04 --user root -- bash -c "systemctl start osn 2>/dev/null" | Out-Null
                    Add-Content $coordLog "$(Get-Date -f 'yyyy-MM-dd HH:mm') Started osn"
                }
                if ((wsl-svc "systemctl is-active clore-hosting 2>/dev/null") -ne "active") {
                    wsl -d Ubuntu-22.04 --user root -- bash -c "systemctl start clore-hosting 2>/dev/null" | Out-Null
                    Add-Content $coordLog "$(Get-Date -f 'yyyy-MM-dd HH:mm') Started clore-hosting"
                }
            }
        } elseif ($octaExists) {
            if ((wsl-svc "systemctl is-active osn 2>/dev/null") -ne "active") {
                wsl -d Ubuntu-22.04 --user root -- bash -c "systemctl start osn 2>/dev/null" | Out-Null
                Add-Content $coordLog "$(Get-Date -f 'yyyy-MM-dd HH:mm') Restarted osn"
            }
        } elseif ($cloreExists) {
            if ((wsl-svc "systemctl is-active clore-hosting 2>/dev/null") -ne "active") {
                wsl -d Ubuntu-22.04 --user root -- bash -c "systemctl start clore-hosting 2>/dev/null" | Out-Null
                Add-Content $coordLog "$(Get-Date -f 'yyyy-MM-dd HH:mm') Restarted clore-hosting"
            }
        }
    } catch { }
    Start-Sleep 300
}
'@
    $coordinator = $coordTemplate.Replace("##API_BASE##", $PULSE_API_BASE).Replace("##USER_TOKEN##", $PULSE_USER_TOKEN)
    $coordPath = "$PULSE_DIR\\coordinator.ps1"
    Set-Content -Path $coordPath -Value $coordinator -Encoding UTF8
    $cA = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \`"$coordPath\`""
    $cT = New-ScheduledTaskTrigger -AtLogOn
    $cS = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -ExecutionTimeLimit 0
    $cP = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Highest
    Register-ScheduledTask -TaskName $COORDINATOR_TASK -Action $cA -Trigger $cT -Settings $cS -Principal $cP -Force | Out-Null
    Write-Log "Platform coordinator installed" "OK"

    $autostart = if ($mirroredNetworking) {
@'
Start-Sleep 15
wsl -d Ubuntu-22.04 --user root -- bash -c 'systemctl start clore-hosting 2>/dev/null' 2>&1 | Add-Content "$env:LOCALAPPDATA\\Pulse\\autostart.log"
'@
    } else {
@"
Start-Sleep 15
\$wslIP = (wsl -d Ubuntu-22.04 --user root -- bash -c 'hostname -I 2>/dev/null').Trim().Split()[0]
\$lastIPFile = "\$env:LOCALAPPDATA\\Pulse\\last_wsl_ip"
\$lastIP = if (Test-Path \$lastIPFile) { (Get-Content \$lastIPFile).Trim() } else { '' }
if (\$wslIP -and \$wslIP -ne \$lastIP) {
    (@(22, 8080) + (3000..4000)) | ForEach-Object {
        netsh interface portproxy delete v4tov4 listenport=\$_ listenaddress=0.0.0.0 | Out-Null
        netsh interface portproxy add v4tov4 listenport=\$_ listenaddress=0.0.0.0 connectport=\$_ connectaddress=\$wslIP | Out-Null
    }
    Set-Content -Path \$lastIPFile -Value \$wslIP
}
wsl -d Ubuntu-22.04 --user root -- bash -c 'systemctl start clore-hosting 2>/dev/null' 2>&1 | Add-Content "\$env:LOCALAPPDATA\\Pulse\\autostart.log"
"@
    }
    $startPath = "$PULSE_DIR\\autostart.ps1"
    Set-Content -Path $startPath -Value $autostart -Encoding UTF8
    $sA = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \`"$startPath\`""
    $sT = New-ScheduledTaskTrigger -AtLogOn
    $sS = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -ExecutionTimeLimit 0
    $sP = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Highest
    Register-ScheduledTask -TaskName $AUTOSTART_TASK -Action $sA -Trigger $sT -Settings $sS -Principal $sP -Force | Out-Null
    Write-Log "Auto-start installed" "OK"

    Write-Host ""
    $doAutoLogin = Read-Host "  Enable auto-login for unattended reboots? (y/N)"
    if ($doAutoLogin -match '^[Yy]') {
        $securePass = Read-Host "  Enter your Windows login password" -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePass)
        $plainPass = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        $regPath = "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon"
        Set-ItemProperty -Path $regPath -Name "AutoAdminLogon"   -Value "1"             -Type String
        Set-ItemProperty -Path $regPath -Name "DefaultUsername"   -Value $env:USERNAME   -Type String
        Set-ItemProperty -Path $regPath -Name "DefaultDomainName" -Value $env:USERDOMAIN -Type String
        Set-ItemProperty -Path $regPath -Name "DefaultPassword"   -Value $plainPass      -Type String
        $plainPass = $null; [System.GC]::Collect()
        Write-Log "Auto-login enabled for $env:USERNAME" "OK"
    } else {
        Write-Log "Auto-login skipped" "WARN"
    }

    Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item $PHASE_FILE -ErrorAction SilentlyContinue

    Show-Banner "Setup Complete"
    Write-Host "  Your GPU is now earning via Pulse + Clore.ai." -ForegroundColor Green
    Write-Host ""
    @(
        @{ L = "GPU";       V = $gpuName },
        @{ L = "VRAM";      V = "\${vramGb} GB" },
        @{ L = "Platform";  V = "Clore.ai (via Pulse)" },
        @{ L = "Server ID"; V = if ($serverId) { $serverId } else { "Pending — check dashboard" } },
        @{ L = "Log";       V = $LOG_FILE }
    ) | ForEach-Object { Write-Host ("  {0,-16} {1}" -f $_.L, $_.V) -ForegroundColor White }
    Write-Host ""
    Write-Host "  Dashboard: https://beneficial-deep-work-flow.base44.app" -ForegroundColor Cyan
    Write-Host ""
    Read-Host "  Press Enter to close this window"
}

trap {
    Write-Host "  [ERROR] $_" -ForegroundColor Red
    Read-Host "  Press Enter to close this window"
    exit 1
}

Assert-Admin
New-Item -ItemType Directory -Force -Path $PULSE_DIR | Out-Null
$phase = if (Test-Path $PHASE_FILE) { Get-Content $PHASE_FILE } else { "1" }
switch ($phase) {
    "1"     { Invoke-Phase1 }
    "2"     { Invoke-Phase2 }
    default { Write-Host "Unknown phase: $phase" -ForegroundColor Red; exit 1 }
}
`;

function b64ToStr(b64: string): string { return new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0))); }

// ── OctaSpace PS1 ─────────────────────────────────────────────────────────────
const OCTA_PS1_B64 = 'I1JlcXVpcmVzIC1WZXJzaW9uIDUuMQo8IwouU1lOT1BTSVMKICAgIFBVTFNFIEdQVSBQcm92aWRlciBTZXR1cCDigJQgT2N0YVNwYWNlIEluc3RhbGxlcgouREVTQ1JJUFRJT04KICAgIFBoYXNlIDE6IEVuYWJsZXMgV1NMMiwgc2NoZWR1bGVzIFBoYXNlIDIgdG8gcnVuIGFmdGVyIHJlYm9vdC4KICAgIFBoYXNlIDI6IEluc3RhbGxzIFVidW50dSwgT2N0YVNwYWNlIG5vZGUgKG9zbiksIHNldHMgdXAgbmV0d29ya2luZwogICAgICAgICAgICAgKFVQblAgKyBwb3J0cHJveHkgZm9yIFRDUCwgbWlycm9yZWQgbmV0d29ya2luZyByZWNvbW1lbmRlZCBmb3IgVURQKSwKICAgICAgICAgICAgIEdQVSBnYW1pbmcgZGV0ZWN0aW9uLCBhbmQgYXV0by1zdGFydC4KCiAgICBFbWJlZGRlZCBhdCBkb3dubG9hZCB0aW1lIGJ5IFB1bHNlJ3MgZ2VuZXJhdGVTZXR1cFNjcmlwdCBmdW5jdGlvbjoKICAgICAgUFVMU0VfVVNFUl9UT0tFTiDigJQgdXNlcidzIHNlc3Npb24gdG9rZW4gZm9yIFB1bHNlIEFQSSBjYWxsYmFjawogICAgICBQVUxTRV9BUFBfSUQgICAgIOKAlCBiYXNlNDQgYXBwIElECiM+CgojIOKUgOKUgCBFbWJlZGRlZCBieSBzZXJ2ZXIgYXQgZG93bmxvYWQgdGltZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKJFBVTFNFX1VTRVJfVE9LRU4gPSAie3tQVUxTRV9VU0VSX1RPS0VOfX0iCiRQVUxTRV9BUFBfSUQgICAgID0gInt7UFVMU0VfQVBQX0lEfX0iCiRQVUxTRV9BUElfQkFTRSAgID0gImh0dHBzOi8vYXBpLmJhc2U0NC5hcHAvYXBpL2FwcHMvJFBVTFNFX0FQUF9JRC9mdW5jdGlvbnMiCiMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgokUFVMU0VfRElSICAgICAgPSAiJGVudjpMT0NBTEFQUERBVEFcUHVsc2UiCiRQSEFTRV9GSUxFICAgICA9ICIkUFVMU0VfRElSXG9jdGFfc2V0dXBfcGhhc2UiCiRMT0dfRklMRSAgICAgICA9ICIkUFVMU0VfRElSXG9jdGFfc2V0dXAubG9nIgokVEFTS19OQU1FICAgICAgPSAiUHVsc2VPY3RhU2V0dXBSZXN1bWUiCiRDT09SRElOQVRPUl9UQVNLID0gIlB1bHNlQ29vcmRpbmF0b3IiCiRBVVRPU1RBUlRfVEFTSyA9ICJQdWxzZU9jdGFBdXRvU3RhcnQiCgojIE9jdGFTcGFjZSBwb3J0cyDigJQgbWFuYWdlbWVudCAoQVBJKSBhbmQgZW5jcnlwdGVkIHR1bm5lbCByYW5nZSAoVENQK1VEUCkKJE9DVEFfTUdNVF9QT1JUUyAgICAgPSBAKDE4ODg4KQokT0NUQV9BUFBfUE9SVF9TVEFSVCA9IDUxODAwCiRPQ1RBX0FQUF9QT1JUX0VORCAgID0gNTE4MTYKCiMg4pSA4pSAIEhlbHBlcnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgpmdW5jdGlvbiBXcml0ZS1Mb2cgewogICAgcGFyYW0oW3N0cmluZ10kbXNnLCBbc3RyaW5nXSRsZXZlbCA9ICJJTkZPIikKICAgICR0cyA9IEdldC1EYXRlIC1Gb3JtYXQgIkhIOm1tOnNzIgogICAgQWRkLUNvbnRlbnQgLVBhdGggJExPR19GSUxFIC1WYWx1ZSAiWyR0c11bJGxldmVsXSAkbXNnIiAtRW5jb2RpbmcgVVRGOAogICAgc3dpdGNoICgkbGV2ZWwpIHsKICAgICAgICAiT0siICAgIHsgV3JpdGUtSG9zdCAiICBbT0tdICRtc2ciIC1Gb3JlZ3JvdW5kQ29sb3IgR3JlZW4gfQogICAgICAgICJXQVJOIiAgeyBXcml0ZS1Ib3N0ICIgIFshIV0gJG1zZyIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cgfQogICAgICAgICJFUlJPUiIgeyBXcml0ZS1Ib3N0ICIgIFtYXSAgJG1zZyIgLUZvcmVncm91bmRDb2xvciBSZWQgfQogICAgICAgIGRlZmF1bHQgeyBXcml0ZS1Ib3N0ICIgIC4uLiAkbXNnIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4gfQogICAgfQp9CgpmdW5jdGlvbiBVcGxvYWQtSW5zdGFsbExvZyB7CiAgICBwYXJhbShbc3RyaW5nXSRTdGVwKQogICAgdHJ5IHsKICAgICAgICAkbGMgPSBpZiAoVGVzdC1QYXRoICRMT0dfRklMRSkgeyBbU3lzdGVtLklPLkZpbGVdOjpSZWFkQWxsVGV4dCgkTE9HX0ZJTEUsIFtTeXN0ZW0uVGV4dC5FbmNvZGluZ106OlVURjgpIH0gZWxzZSB7ICIobm8gbG9nIGZpbGUpIiB9CiAgICAgICAgJHBheWxvYWQgPSBbU3lzdGVtLlRleHQuRW5jb2RpbmddOjpVVEY4LkdldEJ5dGVzKChAe3BsYXRmb3JtPSJvY3Rhc3BhY2UiO2Vycm9yX3N0ZXA9JFN0ZXA7bG9nX2NvbnRlbnQ9JGxjfSB8IENvbnZlcnRUby1Kc29uIC1Db21wcmVzcyAtRGVwdGggMikpCiAgICAgICAgSW52b2tlLVJlc3RNZXRob2QgLU1ldGhvZCBQT1NUIC1VcmkgIiRQVUxTRV9BUElfQkFTRS9yZXBvcnRJbnN0YWxsSXNzdWUiIGAKICAgICAgICAgICAgLUhlYWRlcnMgQHsiQXV0aG9yaXphdGlvbiI9IkJlYXJlciAkUFVMU0VfVVNFUl9UT0tFTiI7IkNvbnRlbnQtVHlwZSI9ImFwcGxpY2F0aW9uL2pzb24ifSBgCiAgICAgICAgICAgIC1Cb2R5ICRwYXlsb2FkIC1UaW1lb3V0U2VjIDMwIHwgT3V0LU51bGwKICAgICAgICBXcml0ZS1Mb2cgIkluc3RhbGwgcmVwb3J0IHVwbG9hZGVkIHRvIFB1bHNlIHN1cHBvcnQiICJPSyIKICAgIH0gY2F0Y2ggeyBXcml0ZS1Mb2cgIkNvdWxkIG5vdCB1cGxvYWQgaW5zdGFsbCByZXBvcnQgKG5vbi1mYXRhbCk6ICRfIiAiV0FSTiIgfQp9CgpmdW5jdGlvbiBTaG93LUJhbm5lciB7CiAgICBwYXJhbShbc3RyaW5nXSRzdWJ0aXRsZSA9ICIiKQogICAgQ2xlYXItSG9zdAogICAgV3JpdGUtSG9zdCAiIgogICAgV3JpdGUtSG9zdCAiICDilojilojilojilojilojilojilZcg4paI4paI4pWXICAg4paI4paI4pWX4paI4paI4pWXICAgICDilojilojilojilojilojilojilojilZfilojilojilojilojilojilojilojilZciIC1Gb3JlZ3JvdW5kQ29sb3IgTWFnZW50YQogICAgV3JpdGUtSG9zdCAiICDilojilojilZTilZDilZDilojilojilZfilojilojilZEgICDilojilojilZHilojilojilZEgICAgIOKWiOKWiOKVlOKVkOKVkOKVkOKVkOKVneKWiOKWiOKVlOKVkOKVkOKVkOKVkOKVnSIgLUZvcmVncm91bmRDb2xvciBNYWdlbnRhCiAgICBXcml0ZS1Ib3N0ICIgIOKWiOKWiOKWiOKWiOKWiOKWiOKVlOKVneKWiOKWiOKVkSAgIOKWiOKWiOKVkeKWiOKWiOKVkSAgICAg4paI4paI4paI4paI4paI4paI4paI4pWX4paI4paI4paI4paI4paI4pWXICAiIC1Gb3JlZ3JvdW5kQ29sb3IgTWFnZW50YQogICAgV3JpdGUtSG9zdCAiICDilojilojilZTilZDilZDilZDilZ0g4paI4paI4pWRICAg4paI4paI4pWR4paI4paI4pWRICAgICDilZrilZDilZDilZDilZDilojilojilZHilojilojilZTilZDilZDilZ0gICIgLUZvcmVncm91bmRDb2xvciBNYWdlbnRhCiAgICBXcml0ZS1Ib3N0ICIgIOKWiOKWiOKVkSAgICAg4pWa4paI4paI4paI4paI4paI4paI4pWU4pWd4paI4paI4paI4paI4paI4paI4paI4pWX4paI4paI4paI4paI4paI4paI4paI4pWR4paI4paI4paI4paI4paI4paI4paI4pWXIiAtRm9yZWdyb3VuZENvbG9yIE1hZ2VudGEKICAgIFdyaXRlLUhvc3QgIiAg4pWa4pWQ4pWdICAgICAg4pWa4pWQ4pWQ4pWQ4pWQ4pWQ4pWdIOKVmuKVkOKVkOKVkOKVkOKVkOKVkOKVneKVmuKVkOKVkOKVkOKVkOKVkOKVkOKVneKVmuKVkOKVkOKVkOKVkOKVkOKVkOKVnSIgLUZvcmVncm91bmRDb2xvciBNYWdlbnRhCiAgICBXcml0ZS1Ib3N0ICIiCiAgICBXcml0ZS1Ib3N0ICIgIEdQVSBQcm92aWRlciBTZXR1cCDigJQgT2N0YVNwYWNlIiAtRm9yZWdyb3VuZENvbG9yIFdoaXRlCiAgICBpZiAoJHN1YnRpdGxlKSB7IFdyaXRlLUhvc3QgIiAgJHN1YnRpdGxlIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5IH0KICAgIFdyaXRlLUhvc3QgIiIKfQoKZnVuY3Rpb24gQXNzZXJ0LUFkbWluIHsKICAgIGlmICgtbm90IChbU2VjdXJpdHkuUHJpbmNpcGFsLldpbmRvd3NQcmluY2lwYWxdW1NlY3VyaXR5LlByaW5jaXBhbC5XaW5kb3dzSWRlbnRpdHldOjpHZXRDdXJyZW50KCkpLklzSW5Sb2xlKAogICAgICAgIFtTZWN1cml0eS5QcmluY2lwYWwuV2luZG93c0J1aWx0SW5Sb2xlXTo6QWRtaW5pc3RyYXRvcikpIHsKICAgICAgICBXcml0ZS1Ib3N0ICIgIFJlbGF1bmNoaW5nIGFzIEFkbWluaXN0cmF0b3IuLi4iIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICAgICAgU3RhcnQtUHJvY2VzcyBwb3dlcnNoZWxsICItTm9Qcm9maWxlIC1FeGVjdXRpb25Qb2xpY3kgQnlwYXNzIC1GaWxlIGAiJFBTQ29tbWFuZFBhdGhgIiIgLVZlcmIgUnVuQXMKICAgICAgICBleGl0CiAgICB9Cn0KCmZ1bmN0aW9uIFdhaXQtRm9yS2V5IHsKICAgIFdyaXRlLUhvc3QgIiIKICAgIFJlYWQtSG9zdCAiICBQcmVzcyBFbnRlciB0byBjbG9zZSB0aGlzIHdpbmRvdyIKfQoKIyDilIDilIAgRGlhZ25vc3RpY3MgY2hlY2tsaXN0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAokc2NyaXB0OlN0ZXBzID0gW29yZGVyZWRdQHt9CgpmdW5jdGlvbiBSZWdpc3Rlci1TdGVwIHsKICAgIHBhcmFtKFtzdHJpbmddJG5hbWUsIFtzdHJpbmddJGZpeCA9ICIiKQogICAgJHNjcmlwdDpTdGVwc1skbmFtZV0gPSBAeyBTdGF0dXMgPSAiUEVORElORyI7IERldGFpbCA9ICIiOyBGaXggPSAkZml4IH0KfQoKZnVuY3Rpb24gU2V0LVN0ZXAgewogICAgcGFyYW0oW3N0cmluZ10kbmFtZSwgW3N0cmluZ10kc3RhdHVzLCBbc3RyaW5nXSRkZXRhaWwgPSAiIikKICAgIGlmICgkc2NyaXB0OlN0ZXBzLkNvbnRhaW5zKCRuYW1lKSkgewogICAgICAgICRzY3JpcHQ6U3RlcHNbJG5hbWVdLlN0YXR1cyA9ICRzdGF0dXMKICAgICAgICBpZiAoJGRldGFpbCkgeyAkc2NyaXB0OlN0ZXBzWyRuYW1lXS5EZXRhaWwgPSAkZGV0YWlsIH0KICAgIH0KfQoKZnVuY3Rpb24gU2hvdy1EaWFnbm9zdGljcyB7CiAgICBwYXJhbShbc3dpdGNoXSRMb2dPbmx5KQogICAgJHNlcCAgICA9ICIgICIgKyAoIuKUgCIgKiA2NSkKICAgICRsb2dTZXAgPSAi4pSAIiAqIDY3CiAgICAkdHMgICAgID0gR2V0LURhdGUgLUZvcm1hdCAieXl5eS1NTS1kZCBISDptbTpzcyIKCiAgICBpZiAoLW5vdCAkTG9nT25seSkgewogICAgICAgIFdyaXRlLUhvc3QgIiIKICAgICAgICBXcml0ZS1Ib3N0ICRzZXAgLUZvcmVncm91bmRDb2xvciBEYXJrR3JheQogICAgICAgIFdyaXRlLUhvc3QgIiAgSU5TVEFMTCBESUFHTk9TVElDUyIgLUZvcmVncm91bmRDb2xvciBXaGl0ZQogICAgICAgIFdyaXRlLUhvc3QgJHNlcCAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5CiAgICB9CgogICAgQWRkLUNvbnRlbnQgLVBhdGggJExPR19GSUxFIC1WYWx1ZSAiIiAtRW5jb2RpbmcgVVRGOAogICAgQWRkLUNvbnRlbnQgLVBhdGggJExPR19GSUxFIC1WYWx1ZSAkbG9nU2VwIC1FbmNvZGluZyBVVEY4CiAgICBBZGQtQ29udGVudCAtUGF0aCAkTE9HX0ZJTEUgLVZhbHVlICJJTlNUQUxMIERJQUdOT1NUSUNTICAkdHMiIC1FbmNvZGluZyBVVEY4CiAgICBBZGQtQ29udGVudCAtUGF0aCAkTE9HX0ZJTEUgLVZhbHVlICRsb2dTZXAgLUVuY29kaW5nIFVURjgKCiAgICBmb3JlYWNoICgkbmFtZSBpbiAkc2NyaXB0OlN0ZXBzLktleXMpIHsKICAgICAgICAkcyAgICAgPSAkc2NyaXB0OlN0ZXBzWyRuYW1lXQogICAgICAgICRpY29uICA9IHN3aXRjaCAoJHMuU3RhdHVzKSB7ICJQQVNTIiB7IltPS10ifSAiRkFJTCIgeyJbWF0gIn0gIldBUk4iIHsiWyEhXSJ9ICJTS0lQIiB7IlstLV0ifSBkZWZhdWx0IHsiWyAgXSJ9IH0KICAgICAgICAkY29sb3IgPSBzd2l0Y2ggKCRzLlN0YXR1cykgeyAiUEFTUyIgeyJHcmVlbiJ9ICJGQUlMIiB7IlJlZCJ9ICJXQVJOIiB7IlllbGxvdyJ9ICJTS0lQIiB7IkRhcmtHcmF5In0gZGVmYXVsdCB7IkRhcmtHcmF5In0gfQoKICAgICAgICBpZiAoJHMuU3RhdHVzIC1lcSAiUEVORElORyIpIHsKICAgICAgICAgICAgaWYgKC1ub3QgJExvZ09ubHkpIHsgV3JpdGUtSG9zdCAoIiAgezB9IHsxLC01NX0gezJ9IiAtZiAkaWNvbiwgJG5hbWUsICIobm90IHJlYWNoZWQpIikgLUZvcmVncm91bmRDb2xvciBEYXJrR3JheSB9CiAgICAgICAgICAgIEFkZC1Db250ZW50IC1QYXRoICRMT0dfRklMRSAtVmFsdWUgKCIgICRpY29uICRuYW1lICAobm90IHJlYWNoZWQpIikgLUVuY29kaW5nIFVURjgKICAgICAgICB9IGVsc2UgewogICAgICAgICAgICBpZiAoLW5vdCAkTG9nT25seSkgewogICAgICAgICAgICAgICAgV3JpdGUtSG9zdCAiICAkaWNvbiAkbmFtZSIgLUZvcmVncm91bmRDb2xvciAkY29sb3IKICAgICAgICAgICAgICAgIGlmICgkcy5EZXRhaWwpIHsgV3JpdGUtSG9zdCAiICAgICAgICQoJHMuRGV0YWlsKSIgLUZvcmVncm91bmRDb2xvciBEYXJrR3JheSB9CiAgICAgICAgICAgICAgICBpZiAoJHMuU3RhdHVzIC1lcSAiRkFJTCIgLWFuZCAkcy5GaXgpIHsgV3JpdGUtSG9zdCAiICAgICAgIEZpeDogJCgkcy5GaXgpIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdyB9CiAgICAgICAgICAgIH0KICAgICAgICAgICAgQWRkLUNvbnRlbnQgLVBhdGggJExPR19GSUxFIC1WYWx1ZSAiICAkaWNvbiAkbmFtZSIgLUVuY29kaW5nIFVURjgKICAgICAgICAgICAgaWYgKCRzLkRldGFpbCkgeyBBZGQtQ29udGVudCAtUGF0aCAkTE9HX0ZJTEUgLVZhbHVlICIgICAgICAgJCgkcy5EZXRhaWwpIiAtRW5jb2RpbmcgVVRGOCB9CiAgICAgICAgICAgIGlmICgkcy5TdGF0dXMgLWVxICJGQUlMIiAtYW5kICRzLkZpeCkgeyBBZGQtQ29udGVudCAtUGF0aCAkTE9HX0ZJTEUgLVZhbHVlICIgICAgICAgRml4OiAkKCRzLkZpeCkiIC1FbmNvZGluZyBVVEY4IH0KICAgICAgICB9CiAgICB9CgogICAgQWRkLUNvbnRlbnQgLVBhdGggJExPR19GSUxFIC1WYWx1ZSAkbG9nU2VwIC1FbmNvZGluZyBVVEY4CgogICAgaWYgKC1ub3QgJExvZ09ubHkpIHsKICAgICAgICBXcml0ZS1Ib3N0ICRzZXAgLUZvcmVncm91bmRDb2xvciBEYXJrR3JheQogICAgICAgIFdyaXRlLUhvc3QgIiAgRnVsbCBsb2c6ICRMT0dfRklMRSIgLUZvcmVncm91bmRDb2xvciBEYXJrR3JheQogICAgICAgIFdyaXRlLUhvc3QgIiAgU2hhcmUgd2l0aCBQdWxzZSBzdXBwb3J0IGF0IHB1bHNlbmFub2FpLmNvbSIgLUZvcmVncm91bmRDb2xvciBEYXJrR3JheQogICAgICAgIFdyaXRlLUhvc3QgIiIKICAgIH0KfQojIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKZnVuY3Rpb24gR2V0LUxvY2FsSVAgewogICAgKEdldC1OZXRJUEFkZHJlc3MgLUFkZHJlc3NGYW1pbHkgSVB2NCB8CiAgICAgICAgV2hlcmUtT2JqZWN0IHsgJF8uSW50ZXJmYWNlQWxpYXMgLW5vdG1hdGNoICJMb29wYmFja3xXU0x8dkV0aGVybmV0IiB9IHwKICAgICAgICBTZWxlY3QtT2JqZWN0IC1GaXJzdCAxKS5JUEFkZHJlc3MKfQoKZnVuY3Rpb24gU2V0LVdTTDJQb3J0UHJveHkgewogICAgcGFyYW0oW3N0cmluZ10kV3NsSVApCiAgICAjIFRDUCBvbmx5IOKAlCBwb3J0cHJveHkgZG9lcyBub3Qgc3VwcG9ydCBVRFAuIFVEUCB0dW5uZWwgcG9ydHMgKDUxODAwLTUxODE2KQogICAgIyByZXF1aXJlIG1pcnJvcmVkIG5ldHdvcmtpbmcgb24gV2luZG93cyAxMSAyMkgyKyB0byBmdW5jdGlvbiBjb3JyZWN0bHkuCiAgICAkYWxsUG9ydHMgPSAkT0NUQV9NR01UX1BPUlRTICsgKCRPQ1RBX0FQUF9QT1JUX1NUQVJULi4kT0NUQV9BUFBfUE9SVF9FTkQpCiAgICBmb3JlYWNoICgkcCBpbiAkYWxsUG9ydHMpIHsKICAgICAgICBuZXRzaCBpbnRlcmZhY2UgcG9ydHByb3h5IGRlbGV0ZSB2NHRvdjQgbGlzdGVucG9ydD0kcCBsaXN0ZW5hZGRyZXNzPTAuMC4wLjAgfCBPdXQtTnVsbAogICAgICAgIG5ldHNoIGludGVyZmFjZSBwb3J0cHJveHkgYWRkIHY0dG92NCBsaXN0ZW5wb3J0PSRwIGxpc3RlbmFkZHJlc3M9MC4wLjAuMCBgCiAgICAgICAgICAgIGNvbm5lY3Rwb3J0PSRwIGNvbm5lY3RhZGRyZXNzPSRXc2xJUCB8IE91dC1OdWxsCiAgICB9CiAgICBXcml0ZS1Mb2cgIldTTDIgcG9ydHByb3h5IChUQ1ApOiAkKCRPQ1RBX01HTVRfUE9SVFMgLWpvaW4gJywnKSArICRPQ1RBX0FQUF9QT1JUX1NUQVJULSRPQ1RBX0FQUF9QT1JUX0VORCDihpIgJFdzbElQIiAiT0siCiAgICBXcml0ZS1Mb2cgIk5PVEU6IFVEUCBwb3J0cyAkT0NUQV9BUFBfUE9SVF9TVEFSVC0kT0NUQV9BUFBfUE9SVF9FTkQgbmVlZCBtaXJyb3JlZCBuZXR3b3JraW5nIGZvciBmdWxsIHR1bm5lbCBzdXBwb3J0IiAiV0FSTiIKfQoKIyDilIDilIAgUGhhc2UgMTogRW5hYmxlIFdTTDIgKyBzY2hlZHVsZSBQaGFzZSAyIGFmdGVyIHJlYm9vdCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCmZ1bmN0aW9uIEludm9rZS1QaGFzZTEgewogICAgU2hvdy1CYW5uZXIgIlBoYXNlIDEgb2YgMiDigJQgRW5hYmxpbmcgV1NMMiIKCiAgICAkc2NyaXB0OlN0ZXBzID0gW29yZGVyZWRdQHt9CiAgICBSZWdpc3Rlci1TdGVwICJXaW5kb3dzIGNvbXBhdGliaWxpdHkgKGJ1aWxkIDE5MDQxKykiCiAgICBSZWdpc3Rlci1TdGVwICJHUFUgZGV0ZWN0ZWQiCiAgICBSZWdpc3Rlci1TdGVwICJWaXJ0dWFsaXphdGlvbiBlbmFibGVkIGluIEJJT1MiCiAgICBSZWdpc3Rlci1TdGVwICJXU0wyIGZlYXR1cmVzIGVuYWJsZWQiCiAgICBSZWdpc3Rlci1TdGVwICJXU0wyIGtlcm5lbCB1cGRhdGUiCiAgICBSZWdpc3Rlci1TdGVwICJQaGFzZSAyIHJlc3VtZSB0YXNrIgoKICAgICRidWlsZCA9IFtTeXN0ZW0uRW52aXJvbm1lbnRdOjpPU1ZlcnNpb24uVmVyc2lvbi5CdWlsZAogICAgaWYgKCRidWlsZCAtbHQgMTkwNDEpIHsKICAgICAgICBTZXQtU3RlcCAiV2luZG93cyBjb21wYXRpYmlsaXR5IChidWlsZCAxOTA0MSspIiAiRkFJTCIgIkJ1aWxkICRidWlsZCDigJQgcmVxdWlyZXMgMTkwNDEgKFdpbmRvd3MgMTAgMjAwNCspIgogICAgICAgIFdyaXRlLUxvZyAiV2luZG93cyBidWlsZCAkYnVpbGQgaXMgdG9vIG9sZC4gV1NMMiByZXF1aXJlcyBidWlsZCAxOTA0MSsgKFdpbmRvd3MgMTAgMjAwNCspLiIgIkVSUk9SIgogICAgICAgIFVwbG9hZC1JbnN0YWxsTG9nICJ3aW5kb3dzX3Rvb19vbGQiOyBTaG93LURpYWdub3N0aWNzOyBXYWl0LUZvcktleTsgZXhpdCAxCiAgICB9CiAgICBXcml0ZS1Mb2cgIldpbmRvd3MgYnVpbGQgJGJ1aWxkIOKAlCBPSyIgIk9LIgogICAgU2V0LVN0ZXAgIldpbmRvd3MgY29tcGF0aWJpbGl0eSAoYnVpbGQgMTkwNDErKSIgIlBBU1MiICJCdWlsZCAkYnVpbGQiCgogICAgJGdwdSA9IChHZXQtV21pT2JqZWN0IFdpbjMyX1ZpZGVvQ29udHJvbGxlciB8CiAgICAgICAgV2hlcmUtT2JqZWN0IHsgJF8uTmFtZSAtbWF0Y2ggIk5WSURJQXxHZUZvcmNlfFJUWHxHVFh8QU1EfFJhZGVvbiIgfSB8CiAgICAgICAgU2VsZWN0LU9iamVjdCAtRmlyc3QgMSkuTmFtZQogICAgaWYgKC1ub3QgJGdwdSkgewogICAgICAgIFNldC1TdGVwICJHUFUgZGV0ZWN0ZWQiICJGQUlMIiAiTm8gTlZJRElBL0FNRCBHUFUgZm91bmQiCiAgICAgICAgV3JpdGUtTG9nICJObyBzdXBwb3J0ZWQgR1BVIGRldGVjdGVkLiBQdWxzZSByZXF1aXJlcyBhbiBOVklESUEgb3IgQU1EIEdQVS4iICJFUlJPUiIKICAgICAgICBVcGxvYWQtSW5zdGFsbExvZyAibm9fZ3B1X2RldGVjdGVkIjsgU2hvdy1EaWFnbm9zdGljczsgV2FpdC1Gb3JLZXk7IGV4aXQgMQogICAgfQogICAgV3JpdGUtTG9nICJHUFU6ICRncHUiICJPSyIKICAgIFNldC1TdGVwICJHUFUgZGV0ZWN0ZWQiICJQQVNTIiAkZ3B1CgogICAgTmV3LUl0ZW0gLUl0ZW1UeXBlIERpcmVjdG9yeSAtRm9yY2UgLVBhdGggJFBVTFNFX0RJUiB8IE91dC1OdWxsCgogICAgJHZpcnRFbmFibGVkID0gKEdldC1Db21wdXRlckluZm8pLkh5cGVyVlJlcXVpcmVtZW50VmlydHVhbGl6YXRpb25GaXJtd2FyZUVuYWJsZWQKICAgIGlmICgkdmlydEVuYWJsZWQgLWVxICRmYWxzZSkgewogICAgICAgIFNldC1TdGVwICJWaXJ0dWFsaXphdGlvbiBlbmFibGVkIGluIEJJT1MiICJGQUlMIiAiRGlzYWJsZWQg4oCUIHNlZSBCSU9TIGluc3RydWN0aW9ucyBiZWxvdyIKICAgICAgICBXcml0ZS1Mb2cgIkhhcmR3YXJlIHZpcnR1YWxpemF0aW9uIGlzIGRpc2FibGVkIGluIHlvdXIgQklPUy9VRUZJLiIgIkVSUk9SIgogICAgICAgIFVwbG9hZC1JbnN0YWxsTG9nICJ2aXJ0dWFsaXphdGlvbl9kaXNhYmxlZCIKICAgICAgICBXcml0ZS1Ib3N0ICIiCiAgICAgICAgV3JpdGUtSG9zdCAiICDilIzilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilJAiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkCiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgIEFDVElPTiBSRVFVSVJFRDogRW5hYmxlIHZpcnR1YWxpemF0aW9uIGluIHlvdXIgQklPUy9VRUZJICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBSZWQKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFJlZAogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICAxLiBSZXN0YXJ0IHlvdXIgUEMgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkCiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgIDIuIFByZXNzIERlbGV0ZSBvciBGMiBkdXJpbmcgYm9vdCB0byBvcGVuIEJJT1MgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFJlZAogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICAzLiBGaW5kOiBBZHZhbmNlZCA+IENQVSBDb25maWd1cmF0aW9uID4gU1ZNIE1vZGUgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBSZWQKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgKEludGVsIGJvYXJkczogbG9vayBmb3IgJ0ludGVsIFZpcnR1YWxpemF0aW9uJyBvciBWVC14KSDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkCiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgIDQuIFNldCBpdCB0byBFbmFibGVkICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBSZWQKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgNS4gUHJlc3MgRjEwIHRvIHNhdmUgYW5kIGV4aXQgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkCiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBSZWQKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgVGhlbiByZS1ydW4gdGhpcyBpbnN0YWxsZXIuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFJlZAogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSU4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSYIiAtRm9yZWdyb3VuZENvbG9yIFJlZAogICAgICAgIFdyaXRlLUhvc3QgIiIKICAgICAgICBTaG93LURpYWdub3N0aWNzOyBXYWl0LUZvcktleTsgZXhpdCAxCiAgICB9CiAgICBXcml0ZS1Mb2cgIkhhcmR3YXJlIHZpcnR1YWxpemF0aW9uIGVuYWJsZWQgaW4gQklPUyDigJQgT0siICJPSyIKICAgIFNldC1TdGVwICJWaXJ0dWFsaXphdGlvbiBlbmFibGVkIGluIEJJT1MiICJQQVNTIgoKICAgIFdyaXRlLUxvZyAiRW5hYmxpbmcgV1NMMiBXaW5kb3dzIGZlYXR1cmVzLi4uIgogICAgZGlzbS5leGUgL29ubGluZSAvZW5hYmxlLWZlYXR1cmUgL2ZlYXR1cmVuYW1lOk1pY3Jvc29mdC1XaW5kb3dzLVN1YnN5c3RlbS1MaW51eCAvYWxsIC9ub3Jlc3RhcnQgfCBPdXQtTnVsbAogICAgZGlzbS5leGUgL29ubGluZSAvZW5hYmxlLWZlYXR1cmUgL2ZlYXR1cmVuYW1lOlZpcnR1YWxNYWNoaW5lUGxhdGZvcm0gL2FsbCAvbm9yZXN0YXJ0IHwgT3V0LU51bGwKICAgIFdyaXRlLUxvZyAiV1NMMiBmZWF0dXJlcyBlbmFibGVkIiAiT0siCiAgICBTZXQtU3RlcCAiV1NMMiBmZWF0dXJlcyBlbmFibGVkIiAiUEFTUyIKCiAgICBXcml0ZS1Mb2cgIkluc3RhbGxpbmcgV1NMMiBrZXJuZWwgdXBkYXRlLi4uIgogICAgJG1zaSA9ICIkZW52OlRFTVBcd3NsX3VwZGF0ZS5tc2kiCiAgICB0cnkgewogICAgICAgIEludm9rZS1XZWJSZXF1ZXN0ICJodHRwczovL3dzbHN0b3Jlc3RvcmFnZS5ibG9iLmNvcmUud2luZG93cy5uZXQvd3NsYmxvYi93c2xfdXBkYXRlX3g2NC5tc2kiIGAKICAgICAgICAgICAgLU91dEZpbGUgJG1zaSAtVXNlQmFzaWNQYXJzaW5nCiAgICAgICAgU3RhcnQtUHJvY2VzcyBtc2lleGVjLmV4ZSAtQXJndW1lbnRMaXN0ICIvaSBgIiRtc2lgIiAvcXVpZXQgL25vcmVzdGFydCIgLVdhaXQKICAgICAgICBXcml0ZS1Mb2cgIldTTDIga2VybmVsIHVwZGF0ZWQiICJPSyIKICAgIH0gY2F0Y2ggewogICAgICAgIFdyaXRlLUxvZyAiV1NMMiBrZXJuZWwgYWxyZWFkeSB1cCB0byBkYXRlIiAiT0siCiAgICB9CiAgICBTZXQtU3RlcCAiV1NMMiBrZXJuZWwgdXBkYXRlIiAiUEFTUyIKCiAgICB3c2wgLS1zZXQtZGVmYXVsdC12ZXJzaW9uIDIgMj4mMSB8IE91dC1OdWxsCgogICAgU2V0LUNvbnRlbnQgLVBhdGggJFBIQVNFX0ZJTEUgLVZhbHVlICIyIiAtRW5jb2RpbmcgVVRGOAoKICAgICRzdGFibGVQYXRoID0gIiRQVUxTRV9ESVJccHVsc2Utb2N0YS1zZXR1cC5wczEiCiAgICBpZiAoJFBTQ29tbWFuZFBhdGggLW5lICRzdGFibGVQYXRoKSB7CiAgICAgICAgQ29weS1JdGVtIC1QYXRoICRQU0NvbW1hbmRQYXRoIC1EZXN0aW5hdGlvbiAkc3RhYmxlUGF0aCAtRm9yY2UKICAgIH0KCiAgICAkYWN0aW9uICAgID0gTmV3LVNjaGVkdWxlZFRhc2tBY3Rpb24gLUV4ZWN1dGUgInBvd2Vyc2hlbGwuZXhlIiBgCiAgICAgICAgLUFyZ3VtZW50ICItTm9Qcm9maWxlIC1FeGVjdXRpb25Qb2xpY3kgQnlwYXNzIC1XaW5kb3dTdHlsZSBOb3JtYWwgLUZpbGUgYCIkc3RhYmxlUGF0aGAiIgogICAgJHRyaWdnZXIgICA9IE5ldy1TY2hlZHVsZWRUYXNrVHJpZ2dlciAtQXRMb2dPbgogICAgJHNldHRpbmdzICA9IE5ldy1TY2hlZHVsZWRUYXNrU2V0dGluZ3NTZXQgLUFsbG93U3RhcnRJZk9uQmF0dGVyaWVzIC1Eb250U3RvcElmR29pbmdPbkJhdHRlcmllcwogICAgJHByaW5jaXBhbCA9IE5ldy1TY2hlZHVsZWRUYXNrUHJpbmNpcGFsIC1Vc2VySWQgJGVudjpVU0VSTkFNRSAtUnVuTGV2ZWwgSGlnaGVzdAogICAgUmVnaXN0ZXItU2NoZWR1bGVkVGFzayAtVGFza05hbWUgJFRBU0tfTkFNRSAtQWN0aW9uICRhY3Rpb24gLVRyaWdnZXIgJHRyaWdnZXIgYAogICAgICAgIC1TZXR0aW5ncyAkc2V0dGluZ3MgLVByaW5jaXBhbCAkcHJpbmNpcGFsIC1Gb3JjZSB8IE91dC1OdWxsCiAgICBXcml0ZS1Mb2cgIlBoYXNlIDIgcmVzdW1lIHRhc2sgcmVnaXN0ZXJlZCIgIk9LIgogICAgU2V0LVN0ZXAgIlBoYXNlIDIgcmVzdW1lIHRhc2siICJQQVNTIgoKICAgIFdyaXRlLUhvc3QgIiIKICAgIFdyaXRlLUhvc3QgIiAg4pSM4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSQIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgV3JpdGUtSG9zdCAiICDilIIgIE9uZSByZWJvb3QgcmVxdWlyZWQgdG8gY29udGludWUgc2V0dXAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgIFdyaXRlLUhvc3QgIiAg4pSCICBTZXR1cCB3aWxsIHJlc3VtZSBhdXRvbWF0aWNhbGx5LiAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICBXcml0ZS1Ib3N0ICIgIOKUlOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUmCIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgIFdyaXRlLUhvc3QgIiIKICAgICRhbnN3ZXIgPSBSZWFkLUhvc3QgIiAgUmVib290IG5vdz8gKFkvbikiCiAgICBpZiAoJGFuc3dlciAtbmUgIm4iKSB7IFJlc3RhcnQtQ29tcHV0ZXIgLUZvcmNlIH0KICAgIGVsc2UgeyBXcml0ZS1Ib3N0ICIgIFJlYm9vdCB3aGVuIHJlYWR5LiBTZXR1cCByZXN1bWVzIG9uIG5leHQgbG9naW4uIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5IH0KfQoKIyDilIDilIAgUGhhc2UgMjogVWJ1bnR1ICsgT2N0YVNwYWNlIChvc24pICsgTmV0d29ya2luZyArIEF1dG8tc3RhcnQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgpmdW5jdGlvbiBJbnZva2UtUGhhc2UyIHsKICAgIFNob3ctQmFubmVyICJQaGFzZSAyIG9mIDIg4oCUIEluc3RhbGxpbmcgT2N0YVNwYWNlIFByb3ZpZGVyIFN0YWNrIgoKICAgICRzY3JpcHQ6U3RlcHMgPSBbb3JkZXJlZF1Ae30KICAgIFJlZ2lzdGVyLVN0ZXAgIlVidW50dSBvbiBXU0wyIgogICAgUmVnaXN0ZXItU3RlcCAic3lzdGVtZCBpbiBXU0wyIgogICAgUmVnaXN0ZXItU3RlcCAiV1NMMiBuZXR3b3JraW5nIgogICAgUmVnaXN0ZXItU3RlcCAiR1BVIGNvbXB1dGUgaW4gV1NMMiIgIlVwZGF0ZSBXaW5kb3dzIE5WSURJQSBkcml2ZXIgYXQgbnZpZGlhLmNvbS9kcml2ZXJzIgogICAgUmVnaXN0ZXItU3RlcCAiQnVpbGQgdG9vbHMgKGN1cmwsIGJhc2gpIiAid3NsIC1kIFVidW50dS0yMi4wNCAtLSBiYXNoIC1jICdhcHQtZ2V0IHVwZGF0ZSAmJiBhcHQtZ2V0IGluc3RhbGwgLXkgY3VybCBiYXNoJyIKICAgIFJlZ2lzdGVyLVN0ZXAgIk9jdGFTcGFjZSBvc24gaW5zdGFsbGVkIiAiQ2hlY2sgaW5zdGFsbC5vY3RhLnNwYWNlIG9yIE9jdGFTcGFjZSBkb2NzIgogICAgUmVnaXN0ZXItU3RlcCAiSHVnZVBhZ2VzIGNhcCAoUkFNIGZpeCkiCiAgICBSZWdpc3Rlci1TdGVwICJPU04gYWxhcm0gdGhyZXNob2xkcyIKICAgIFJlZ2lzdGVyLVN0ZXAgIm9zbiBzZXJ2aWNlIHN0YXJ0ZWQiCiAgICBSZWdpc3Rlci1TdGVwICJPY3RhU3BhY2Ugbm9kZSB0b2tlbiIKICAgIFJlZ2lzdGVyLVN0ZXAgIldpbmRvd3MgRmlyZXdhbGwgcnVsZXMiCiAgICBSZWdpc3Rlci1TdGVwICJVUG5QIHBvcnQgZm9yd2FyZGluZyIKICAgIFJlZ2lzdGVyLVN0ZXAgIldTTDIgcG9ydCBwcm94eSIKICAgIFJlZ2lzdGVyLVN0ZXAgIlB1bHNlIHJlZ2lzdHJhdGlvbiIKICAgIFJlZ2lzdGVyLVN0ZXAgIkdQVSB3YXRjaGRvZyB0YXNrIgogICAgUmVnaXN0ZXItU3RlcCAiQXV0by1zdGFydCB0YXNrIgogICAgUmVnaXN0ZXItU3RlcCAiQXV0by1sb2dpbiIKCiAgICBXcml0ZS1Mb2cgIlNldHRpbmcgdXAgVWJ1bnR1LTIyLjA0IG9uIFdTTDIuLi4iCiAgICAjIFRlc3QgdGhlIGRpc3RybyBkaXJlY3RseSDigJQgd3NsIC0tbGlzdCAtLXF1aWV0IG91dHB1dHMgVVRGLTE2IHdoaWNoIGNhbiBjb3JydXB0IHN0cmluZyBtYXRjaGluZwogICAgJGRpc3Ryb09rID0gKHdzbCAtZCBVYnVudHUtMjIuMDQgLS11c2VyIHJvb3QgLS0gYmFzaCAtYyAiZWNobyBvayIgMj4mMSkgLW1hdGNoICJvayIKICAgIGlmICgtbm90ICRkaXN0cm9PaykgewogICAgICAgIHdzbCAtLXVucmVnaXN0ZXIgVWJ1bnR1LTIyLjA0IDI+JjEgfCBPdXQtTnVsbAogICAgICAgIFdyaXRlLUxvZyAiRG93bmxvYWRpbmcgVWJ1bnR1LTIyLjA0Li4uIgogICAgICAgIHdzbCAtLWluc3RhbGwgLWQgVWJ1bnR1LTIyLjA0IC0tbm8tbGF1bmNoIDI+JjEgfCBPdXQtTnVsbAoKICAgICAgICBXcml0ZS1Mb2cgIkluaXRpYWxpemluZyBVYnVudHUtMjIuMDQgaGVhZGxlc3NseSAobm8gR1VJIHJlcXVpcmVkKS4uLiIKICAgICAgICAkdWJ1bnR1RXhlID0gR2V0LUNoaWxkSXRlbSAiJGVudjpMT0NBTEFQUERBVEFcTWljcm9zb2Z0XFdpbmRvd3NBcHBzIiAtRmlsdGVyICJ1YnVudHUyMjA0Ki5leGUiIC1FcnJvckFjdGlvbiBTaWxlbnRseUNvbnRpbnVlIHwgU2VsZWN0LU9iamVjdCAtRmlyc3QgMQogICAgICAgIGlmICgtbm90ICR1YnVudHVFeGUpIHsKICAgICAgICAgICAgJHVidW50dUV4ZSA9IEdldC1DaGlsZEl0ZW0gIiRlbnY6TE9DQUxBUFBEQVRBXE1pY3Jvc29mdFxXaW5kb3dzQXBwcyIgLUZpbHRlciAidWJ1bnR1Ki5leGUiIC1FcnJvckFjdGlvbiBTaWxlbnRseUNvbnRpbnVlIHwgU2VsZWN0LU9iamVjdCAtRmlyc3QgMQogICAgICAgIH0KICAgICAgICBpZiAoJHVidW50dUV4ZSkgewogICAgICAgICAgICAmICR1YnVudHVFeGUuRnVsbE5hbWUgaW5zdGFsbCAtLXJvb3QgMj4mMSB8IE91dC1OdWxsCiAgICAgICAgfQogICAgICAgIFN0YXJ0LVNsZWVwIDUKCiAgICAgICAgJGNoZWNrID0gd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICJlY2hvIG9rIiAyPiYxCiAgICAgICAgaWYgKCRjaGVjayAtbm90bWF0Y2ggIm9rIikgewogICAgICAgICAgICBXcml0ZS1Mb2cgIlVidW50dS0yMi4wNCByb290IGFjY2VzcyBmYWlsZWQg4oCUIHJlLXJ1biBpbnN0YWxsZXIuIiAiRVJST1IiCiAgICAgICAgICAgIFVwbG9hZC1JbnN0YWxsTG9nICJ1YnVudHVfcm9vdF9hY2Nlc3NfZmFpbGVkIjsgU2hvdy1EaWFnbm9zdGljczsgV2FpdC1Gb3JLZXk7IGV4aXQgMQogICAgICAgIH0KICAgICAgICBXcml0ZS1Mb2cgIlVidW50dS0yMi4wNCBpbnN0YWxsZWQgYW5kIGluaXRpYWxpemVkIiAiT0siCiAgICB9IGVsc2UgewogICAgICAgIFdyaXRlLUxvZyAiVWJ1bnR1LTIyLjA0IGFscmVhZHkgcHJlc2VudCBhbmQgd29ya2luZyIgIk9LIgogICAgfQogICAgU2V0LVN0ZXAgIlVidW50dSBvbiBXU0wyIiAiUEFTUyIKCiAgICAjIEVuYWJsZSBzeXN0ZW1kIOKAlCBvc24gaXMgYSBzeXN0ZW1kIHNlcnZpY2UKICAgIFdyaXRlLUxvZyAiRW5hYmxpbmcgc3lzdGVtZCBpbiBXU0wyIChyZXF1aXJlZCBmb3Igb3NuIHNlcnZpY2UpLi4uIgogICAgd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICJncmVwIC1xICdzeXN0ZW1kPXRydWUnIC9ldGMvd3NsLmNvbmYgMj4vZGV2L251bGwgfHwgcHJpbnRmICdbYm9vdF1cbnN5c3RlbWQ9dHJ1ZVxuJyA+IC9ldGMvd3NsLmNvbmYiCgogICAgIyBXU0wyIG1pcnJvcmVkIG5ldHdvcmtpbmcg4oCUIGVzcGVjaWFsbHkgaW1wb3J0YW50IGZvciBPY3RhU3BhY2UgYmVjYXVzZSB0aGUKICAgICMgdHVubmVsIHBvcnRzIDUxODAwLTUxODE2IHVzZSBVRFAsIGFuZCBwb3J0cHJveHkgaXMgVENQLW9ubHkuCiAgICAkb3NCdWlsZCA9IFtTeXN0ZW0uRW52aXJvbm1lbnRdOjpPU1ZlcnNpb24uVmVyc2lvbi5CdWlsZAogICAgJG1pcnJvcmVkTmV0d29ya2luZyA9ICRmYWxzZQogICAgJHdzbENvbmZpZ1BhdGggPSAiJGVudjpVU0VSUFJPRklMRVwud3NsY29uZmlnIgogICAgIyB2bUlkbGVUaW1lb3V0PS0xIHN0b3BzIFdpbmRvd3MgZnJvbSB0ZWFyaW5nIGRvd24gdGhlIFdTTDIgdXRpbGl0eSBWTSBhZnRlcgogICAgIyBpdCBsb29rcyBpZGxlLiBXaXRob3V0IGl0LCB0aGUgVk0gKGFuZCB0aGUgb3NuIGRhZW1vbiBydW5uaW5nIGluc2lkZSBpdCkgY2FuCiAgICAjIGZyZWV6ZSBzaWxlbnRseSBmb3IgaG91cnMgd2l0aCB6ZXJvIGxvZyBvdXRwdXQg4oCUIG5vIGhlYXJ0YmVhdCB0aW1lb3V0LCBubwogICAgIyBlcnJvciwganVzdCBhIGdhcCDigJQgdW50aWwgc29tZXRoaW5nIHRvdWNoZXMgV1NMIGFnYWluIGFuZCBpdCByZWNvbm5lY3RzLgogICAgIyBUaGlzIGlzIHRoZSBzYW1lIGZpeCBhbHJlYWR5IGFwcGxpZWQgdG8gdGhlIENsb3JlIGluc3RhbGxlciAoQ0xPUkVfUFMxKS4KICAgIGlmICgkb3NCdWlsZCAtZ2UgMjI2MjEpIHsKICAgICAgICBXcml0ZS1Mb2cgIldpbmRvd3MgMTEgMjJIMisgZGV0ZWN0ZWQg4oCUIGVuYWJsaW5nIFdTTDIgbWlycm9yZWQgbmV0d29ya2luZy4uLiIKICAgICAgICAkd3NsQ29uZmlnQ29udGVudCA9IGlmIChUZXN0LVBhdGggJHdzbENvbmZpZ1BhdGgpIHsgR2V0LUNvbnRlbnQgJHdzbENvbmZpZ1BhdGggLVJhdyB9IGVsc2UgeyAiIiB9CiAgICAgICAgJGNoYW5nZWQgPSAkZmFsc2UKICAgICAgICBpZiAoJHdzbENvbmZpZ0NvbnRlbnQgLW5vdG1hdGNoICduZXR3b3JraW5nTW9kZScpIHsKICAgICAgICAgICAgaWYgKCR3c2xDb25maWdDb250ZW50IC1tYXRjaCAnXFt3c2wyXF0nKSB7CiAgICAgICAgICAgICAgICAkd3NsQ29uZmlnQ29udGVudCA9ICR3c2xDb25maWdDb250ZW50IC1yZXBsYWNlICcoXFt3c2wyXF0pJywgImAkMWBubmV0d29ya2luZ01vZGU9bWlycm9yZWQiCiAgICAgICAgICAgIH0gZWxzZSB7CiAgICAgICAgICAgICAgICAkd3NsQ29uZmlnQ29udGVudCArPSAiYG5bd3NsMl1gbm5ldHdvcmtpbmdNb2RlPW1pcnJvcmVkYG4iCiAgICAgICAgICAgIH0KICAgICAgICAgICAgJGNoYW5nZWQgPSAkdHJ1ZQogICAgICAgIH0KICAgICAgICBpZiAoJHdzbENvbmZpZ0NvbnRlbnQgLW5vdG1hdGNoICd2bUlkbGVUaW1lb3V0JykgewogICAgICAgICAgICBpZiAoJHdzbENvbmZpZ0NvbnRlbnQgLW1hdGNoICdcW3dzbDJcXScpIHsKICAgICAgICAgICAgICAgICR3c2xDb25maWdDb250ZW50ID0gJHdzbENvbmZpZ0NvbnRlbnQgLXJlcGxhY2UgJyhcW3dzbDJcXSknLCAiYCQxYG52bUlkbGVUaW1lb3V0PS0xIgogICAgICAgICAgICB9IGVsc2UgewogICAgICAgICAgICAgICAgJHdzbENvbmZpZ0NvbnRlbnQgKz0gImBuW3dzbDJdYG52bUlkbGVUaW1lb3V0PS0xYG4iCiAgICAgICAgICAgIH0KICAgICAgICAgICAgJGNoYW5nZWQgPSAkdHJ1ZQogICAgICAgIH0KICAgICAgICBpZiAoJGNoYW5nZWQpIHsgU2V0LUNvbnRlbnQgLVBhdGggJHdzbENvbmZpZ1BhdGggLVZhbHVlICR3c2xDb25maWdDb250ZW50IC1FbmNvZGluZyBVVEY4IH0KICAgICAgICAkbWlycm9yZWROZXR3b3JraW5nID0gJHRydWUKICAgICAgICBXcml0ZS1Mb2cgIldTTDIgbmV0d29ya2luZyBjb25maWd1cmVkIChtaXJyb3JlZCwgdm1JZGxlVGltZW91dD0tMSkg4oCUIFVEUCB0dW5uZWxzIHdpbGwgd29yayBjb3JyZWN0bHkiICJPSyIKICAgICAgICBTZXQtU3RlcCAiV1NMMiBuZXR3b3JraW5nIiAiUEFTUyIgIk1pcnJvcmVkIChXaW5kb3dzIDExIDIySDIrKSwgdm1JZGxlVGltZW91dD0tMSDigJQgVURQIHR1bm5lbHMgZnVsbHkgZnVuY3Rpb25hbCIKICAgIH0gZWxzZSB7CiAgICAgICAgV3JpdGUtTG9nICJXaW5kb3dzIGJ1aWxkICR7b3NCdWlsZH06IG1pcnJvcmVkIG5ldHdvcmtpbmcgbmVlZHMgMjJIMiAoMjI2MjErKSDigJQgcG9ydHByb3h5IG9ubHkgY292ZXJzIFRDUDsgVURQIHR1bm5lbHMgd2lsbCBiZSBsaW1pdGVkIiAiV0FSTiIKICAgICAgICAkd3NsQ29uZmlnQ29udGVudCA9IGlmIChUZXN0LVBhdGggJHdzbENvbmZpZ1BhdGgpIHsgR2V0LUNvbnRlbnQgJHdzbENvbmZpZ1BhdGggLVJhdyB9IGVsc2UgeyAiIiB9CiAgICAgICAgaWYgKCR3c2xDb25maWdDb250ZW50IC1ub3RtYXRjaCAndm1JZGxlVGltZW91dCcpIHsKICAgICAgICAgICAgaWYgKCR3c2xDb25maWdDb250ZW50IC1tYXRjaCAnXFt3c2wyXF0nKSB7CiAgICAgICAgICAgICAgICAkd3NsQ29uZmlnQ29udGVudCA9ICR3c2xDb25maWdDb250ZW50IC1yZXBsYWNlICcoXFt3c2wyXF0pJywgImAkMWBudm1JZGxlVGltZW91dD0tMSIKICAgICAgICAgICAgfSBlbHNlIHsKICAgICAgICAgICAgICAgICR3c2xDb25maWdDb250ZW50ICs9ICJgblt3c2wyXWBudm1JZGxlVGltZW91dD0tMWBuIgogICAgICAgICAgICB9CiAgICAgICAgICAgIFNldC1Db250ZW50IC1QYXRoICR3c2xDb25maWdQYXRoIC1WYWx1ZSAkd3NsQ29uZmlnQ29udGVudCAtRW5jb2RpbmcgVVRGOAogICAgICAgIH0KICAgICAgICBXcml0ZS1Mb2cgInZtSWRsZVRpbWVvdXQ9LTEgc2V0IChwcmV2ZW50cyBzaWxlbnQgV1NMMiBWTSBpZGxlLWZyZWV6ZSkiICJPSyIKICAgICAgICBTZXQtU3RlcCAiV1NMMiBuZXR3b3JraW5nIiAiV0FSTiIgIlBvcnRwcm94eSBvbmx5IChidWlsZCAkb3NCdWlsZCksIHZtSWRsZVRpbWVvdXQ9LTEg4oCUIFVEUCB0dW5uZWwgcG9ydHMgbGltaXRlZDsgdXBncmFkZSB0byBXaW4gMTEgMjJIMisgcmVjb21tZW5kZWQiCiAgICB9CgogICAgd3NsIC0tc2h1dGRvd24KICAgIFN0YXJ0LVNsZWVwIDIwCiAgICAkc2RDaGVjayA9IHdzbCAtZCBVYnVudHUtMjIuMDQgLS11c2VyIHJvb3QgLS0gYmFzaCAtYyAiWyAtZCAvcnVuL3N5c3RlbWQvc3lzdGVtIF0gJiYgZWNobyB5ZXMgfHwgZWNobyBubyIgMj4mMQogICAgaWYgKCRzZENoZWNrIC1tYXRjaCAieWVzIikgewogICAgICAgIFdyaXRlLUxvZyAic3lzdGVtZCBydW5uaW5nIGluIFdTTDIiICJPSyIKICAgICAgICBTZXQtU3RlcCAic3lzdGVtZCBpbiBXU0wyIiAiUEFTUyIKICAgIH0gZWxzZSB7CiAgICAgICAgV3JpdGUtTG9nICJzeXN0ZW1kIG1heSBub3QgYmUgYWN0aXZlIOKAlCBvc24gbWF5IG5vdCBhdXRvLXN0YXJ0IG9uIHJlYm9vdCIgIldBUk4iCiAgICAgICAgU2V0LVN0ZXAgInN5c3RlbWQgaW4gV1NMMiIgIldBUk4iICJzeXN0ZW1kIG5vdCBkZXRlY3RlZCDigJQgb3NuIHNlcnZpY2UgbWF5IG5vdCBwZXJzaXN0IGFjcm9zcyByZWJvb3RzIgogICAgfQoKICAgICMg4pSA4pSAIERldGVjdCBHUFUgdmVuZG9yIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogICAgJGdwdU9iaiAgICA9IEdldC1XbWlPYmplY3QgV2luMzJfVmlkZW9Db250cm9sbGVyIHwgV2hlcmUtT2JqZWN0IHsgJF8uTmFtZSAtbWF0Y2ggIk5WSURJQXxHZUZvcmNlfFJUWHxHVFh8QU1EfFJhZGVvbiIgfSB8IFNlbGVjdC1PYmplY3QgLUZpcnN0IDEKICAgICRncHVOYW1lICAgPSAkZ3B1T2JqLk5hbWUKICAgICR2cmFtTWIgICAgPSAkZ3B1T2JqLkFkYXB0ZXJSQU0KICAgICR2cmFtR2IgICAgPSBpZiAoJHZyYW1NYiAtYW5kICR2cmFtTWIgLWd0IDApIHsgW21hdGhdOjpSb3VuZCgkdnJhbU1iIC8gMUdCKSB9IGVsc2UgeyA4IH0KICAgICRncHVWZW5kb3IgPSBpZiAoJGdwdU5hbWUgLW1hdGNoICJOVklESUF8R2VGb3JjZXxSVFh8R1RYIikgeyAiTlZJRElBIiB9IGVsc2UgeyAiQU1EIiB9CgogICAgIyDilIDilIAgUHJlLWluc3RhbGwgR1BVIGNvbXB1dGUgZHJpdmVycyBpbnNpZGUgV1NMMiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAgIFdyaXRlLUxvZyAiQ2hlY2tpbmcgR1BVIGNvbXB1dGUgZW52aXJvbm1lbnQgaW4gV1NMMiAoJGdwdVZlbmRvcikuLi4iCiAgICBpZiAoJGdwdVZlbmRvciAtZXEgIk5WSURJQSIpIHsKICAgICAgICAkbnZDaGVjayA9IHdzbCAtZCBVYnVudHUtMjIuMDQgLS11c2VyIHJvb3QgLS0gYmFzaCAtYyAibnZpZGlhLXNtaSAtTCAyPi9kZXYvbnVsbCB8IGhlYWQgLTEiIDI+JjEKICAgICAgICBpZiAoJG52Q2hlY2sgLW1hdGNoICJHUFUgMCIpIHsKICAgICAgICAgICAgV3JpdGUtTG9nICJOVklESUEgR1BVIHZpc2libGUgaW4gV1NMMiIgIk9LIgogICAgICAgICAgICBTZXQtU3RlcCAiR1BVIGNvbXB1dGUgaW4gV1NMMiIgIlBBU1MiICJudmlkaWEtc21pIE9LIOKAlCAkZ3B1TmFtZSIKICAgICAgICB9IGVsc2UgewogICAgICAgICAgICBXcml0ZS1Mb2cgIk5WSURJQSBHUFUgbm90IHlldCB2aXNpYmxlIGluIFdTTDIg4oCUIGVuc3VyZSBXaW5kb3dzIE5WSURJQSBkcml2ZXIgaXMgdXAgdG8gZGF0ZSIgIldBUk4iCiAgICAgICAgICAgIFNldC1TdGVwICJHUFUgY29tcHV0ZSBpbiBXU0wyIiAiV0FSTiIgIm52aWRpYS1zbWkgcmV0dXJuZWQgbm8gb3V0cHV0IOKAlCBvc24gbWF5IGZhaWwgd2l0aG91dCBHUFUgYWNjZXNzIgogICAgICAgIH0KICAgIH0gZWxzZSB7CiAgICAgICAgV3JpdGUtTG9nICJJbnN0YWxsaW5nIFJPQ20gZm9yIEFNRCBHUFUgaW4gV1NMMiAodGhpcyB0YWtlcyBhIGZldyBtaW51dGVzKS4uLiIKICAgICAgICAkdWJ1bnR1VmVyID0gd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICJsc2JfcmVsZWFzZSAtY3MgMj4vZGV2L251bGwiIDI+JjEKICAgICAgICAkdWJ1bnR1VmVyID0gJHVidW50dVZlci5UcmltKCkKICAgICAgICBpZiAoJHVidW50dVZlciAtbm90aW4gQCgiamFtbXkiLCJmb2NhbCIsIm5vYmxlIikpIHsgJHVidW50dVZlciA9ICJqYW1teSIgfQogICAgICAgICRyb2NtU2NyaXB0ID0gInNldCAtZWBuZXhwb3J0IERFQklBTl9GUk9OVEVORD1ub25pbnRlcmFjdGl2ZWBuYXB0LWdldCB1cGRhdGUgLXFxYG5hcHQtZ2V0IGluc3RhbGwgLXkgLXFxIHdnZXQgZ251cGcgY2EtY2VydGlmaWNhdGVzYG5ta2RpciAtcCAvZXRjL2FwdC9rZXlyaW5nc2Bucm0gLWYgL2V0Yy9hcHQva2V5cmluZ3Mvcm9jbS5ncGdgbndnZXQgLXFPIC0gaHR0cHM6Ly9yZXBvLnJhZGVvbi5jb20vcm9jbS9yb2NtLmdwZy5rZXkgfCBncGcgLS1kZWFybW9yIC1vIC9ldGMvYXB0L2tleXJpbmdzL3JvY20uZ3BnYG5lY2hvICdkZWIgW2FyY2g9YW1kNjQgc2lnbmVkLWJ5PS9ldGMvYXB0L2tleXJpbmdzL3JvY20uZ3BnXSBodHRwczovL3JlcG8ucmFkZW9uLmNvbS9yb2NtL2FwdC82LjIgJHVidW50dVZlciBtYWluJyA+IC9ldGMvYXB0L3NvdXJjZXMubGlzdC5kL3JvY20ubGlzdGBuYXB0LWdldCB1cGRhdGUgLXFxYG5hcHQtZ2V0IGluc3RhbGwgLXkgLXFxIHJvY20tb3BlbmNsLXJ1bnRpbWUiCiAgICAgICAgIyBQaXBlIHZpYSBzdGRpbiB0byBhdm9pZCBDUkxGIGlzc3VlcyB3aXRoIGJhc2ggLWMgb24gV2luZG93cwogICAgICAgICRyb2NtU2NyaXB0IHwgd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIDI+JjEgfCBGb3JFYWNoLU9iamVjdCB7IFdyaXRlLUxvZyAkXyB9CiAgICAgICAgaWYgKCRMQVNURVhJVENPREUgLWVxIDApIHsKICAgICAgICAgICAgV3JpdGUtTG9nICJST0NtIGluc3RhbGxlZCIgIk9LIgogICAgICAgICAgICBTZXQtU3RlcCAiR1BVIGNvbXB1dGUgaW4gV1NMMiIgIlBBU1MiICJST0NtIG9wZW5jbC1ydW50aW1lIGluc3RhbGxlZCDigJQgJGdwdU5hbWUiCiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgICAgV3JpdGUtTG9nICJST0NtIGluc3RhbGwgZW5jb3VudGVyZWQgZXJyb3JzIOKAlCBPY3RhU3BhY2UgbWF5IGhhdmUgbGltaXRlZCBBTUQgc3VwcG9ydCIgIldBUk4iCiAgICAgICAgICAgIFNldC1TdGVwICJHUFUgY29tcHV0ZSBpbiBXU0wyIiAiV0FSTiIgIlJPQ20gaW5zdGFsbCBoYWQgZXJyb3JzIOKAlCBBTUQgc3VwcG9ydCBtYXkgYmUgbGltaXRlZCIKICAgICAgICB9CiAgICB9CgogICAgIyDilIDilIAgSW5zdGFsbCBPY3RhU3BhY2Ugbm9kZSAob3NuKSBpbnNpZGUgV1NMMiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAgIFdyaXRlLUxvZyAiSW5zdGFsbGluZyBvc24gcHJlcmVxdWlzaXRlcyAoY3VybCwgYmFzaCwgZ3VtKS4uLiIKICAgIHdzbCAtZCBVYnVudHUtMjIuMDQgLS11c2VyIHJvb3QgLS0gYmFzaCAtYyAiZXhwb3J0IERFQklBTl9GUk9OVEVORD1ub25pbnRlcmFjdGl2ZTsgYXB0LWdldCB1cGRhdGUgLXFxICYmIGFwdC1nZXQgaW5zdGFsbCAteSAtcXEgY3VybCBiYXNoIiAyPiYxIHwgRm9yRWFjaC1PYmplY3QgeyBXcml0ZS1Mb2cgJF8gfQogICAgaWYgKCRMQVNURVhJVENPREUgLWVxIDApIHsKICAgICAgICBTZXQtU3RlcCAiQnVpbGQgdG9vbHMgKGN1cmwsIGJhc2gpIiAiUEFTUyIKICAgIH0gZWxzZSB7CiAgICAgICAgU2V0LVN0ZXAgIkJ1aWxkIHRvb2xzIChjdXJsLCBiYXNoKSIgIldBUk4iICJhcHQtZ2V0IGV4aXQgJExBU1RFWElUQ09ERSDigJQgb3NuIGluc3RhbGxlciB3aWxsIGF0dGVtcHQgdG8gY29udGludWUgYW55d2F5IgogICAgfQoKICAgIFdyaXRlLUxvZyAiSW5zdGFsbGluZyBndW0gKHJlcXVpcmVkIGJ5IE9jdGFTcGFjZSBpbnN0YWxsZXIpLi4uIgogICAgIyBybSAtZiBiZWZvcmUgZGVhcm1vcjogZ3BnIHByb21wdHMgIm92ZXJ3cml0ZT8iIGlmIHRoZSBrZXlyaW5nIGFscmVhZHkgZXhpc3RzIChlLmcuIGEKICAgICMgcHJpb3IgaW50ZXJydXB0ZWQgcnVuKSwgYW5kIHRoYXQgcHJvbXB0IGhhbmdzIGZvcmV2ZXIgd2l0aCBubyBpbnRlcmFjdGl2ZSBzdGRpbiByZWFjaGluZyBpdC4KICAgICRndW1JbnN0YWxsID0gImV4cG9ydCBERUJJQU5fRlJPTlRFTkQ9bm9uaW50ZXJhY3RpdmUgJiYgbWtkaXIgLXAgL2V0Yy9hcHQva2V5cmluZ3MgJiYgcm0gLWYgL2V0Yy9hcHQva2V5cmluZ3MvY2hhcm0uZ3BnICYmIGN1cmwgLWZzU0wgaHR0cHM6Ly9yZXBvLmNoYXJtLnNoL2FwdC9ncGcua2V5IHwgZ3BnIC0tZGVhcm1vciAtbyAvZXRjL2FwdC9rZXlyaW5ncy9jaGFybS5ncGcgJiYgZWNobyAnZGViIFtzaWduZWQtYnk9L2V0Yy9hcHQva2V5cmluZ3MvY2hhcm0uZ3BnXSBodHRwczovL3JlcG8uY2hhcm0uc2gvYXB0LyAqIConIHwgdGVlIC9ldGMvYXB0L3NvdXJjZXMubGlzdC5kL2NoYXJtLmxpc3QgPiAvZGV2L251bGwgJiYgYXB0LWdldCB1cGRhdGUgLXFxICYmIGFwdC1nZXQgaW5zdGFsbCAteSAtcXEgZ3VtIgogICAgd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICRndW1JbnN0YWxsIDI+JjEgfCBGb3JFYWNoLU9iamVjdCB7IFdyaXRlLUxvZyAkXyB9CiAgICBpZiAoJExBU1RFWElUQ09ERSAtbmUgMCkgewogICAgICAgIFdyaXRlLUxvZyAiZ3VtIGluc3RhbGwgZmFpbGVkIOKAlCBPY3RhU3BhY2UgaW5zdGFsbGVyIG1heSBmYWlsIiAiV0FSTiIKICAgIH0gZWxzZSB7CiAgICAgICAgV3JpdGUtTG9nICJndW0gaW5zdGFsbGVkIiAiT0siCiAgICB9CgogICAgV3JpdGUtTG9nICJJbnN0YWxsaW5nIE9jdGFTcGFjZSBub2RlIChvc24pIGluc2lkZSBXU0wyLi4uIgogICAgJG9jdGFPdXRwdXQgPSB3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tdXNlciByb290IC0tIGJhc2ggLWMgImN1cmwgLWZzU0wgaHR0cHM6Ly9pbnN0YWxsLm9jdGEuc3BhY2UgfCBiYXNoIiAyPiYxCiAgICAkb2N0YUV4aXQgPSAkTEFTVEVYSVRDT0RFCiAgICAkb2N0YU91dHB1dCB8IEZvckVhY2gtT2JqZWN0IHsgV3JpdGUtTG9nICRfIH0KICAgIGlmICgkb2N0YUV4aXQgLW5lIDApIHsKICAgICAgICBTZXQtU3RlcCAiT2N0YVNwYWNlIG9zbiBpbnN0YWxsZWQiICJGQUlMIiAiaW5zdGFsbC5vY3RhLnNwYWNlIHNjcmlwdCBleGl0ZWQgJG9jdGFFeGl0IOKAlCBzZWUgbG9nIGZvciBkZXRhaWxzIgogICAgICAgIFdyaXRlLUxvZyAiT2N0YVNwYWNlIGluc3RhbGxhdGlvbiBmYWlsZWQgKGV4aXQgJG9jdGFFeGl0KS4gQ2hlY2sgdGhlIG91dHB1dCBhYm92ZS4iICJFUlJPUiIKICAgICAgICBVcGxvYWQtSW5zdGFsbExvZyAib3NuX2luc3RhbGxfZmFpbGVkIjsgU2hvdy1EaWFnbm9zdGljczsgV2FpdC1Gb3JLZXk7IGV4aXQgMQogICAgfQogICAgV3JpdGUtTG9nICJPY3RhU3BhY2Ugb3NuIGluc3RhbGwgY29tcGxldGUiICJPSyIKICAgIFNldC1TdGVwICJPY3RhU3BhY2Ugb3NuIGluc3RhbGxlZCIgIlBBU1MiCgogICAgIyDilIDilIAgU3RhYmlsaXR5IEZpeCAxOiBjYXAgTlZJRElBIEh1Z2VQYWdlcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAgICMgTlZJRElBJ3MgV1NMMiBkcml2ZXIgbG9ja3MgSHVnZVBhZ2VzIHByb3BvcnRpb25hbCB0byBhdmFpbGFibGUgUkFNIOKAlCB1cCB0byB+OEdCCiAgICAjIG9uIGEgMTBHQiBXU0wgaW5zdGFuY2UuIEVybGFuZydzIG1lbXN1cCBmaXJlcyBhIHN5c3RlbV9tZW1vcnlfaGlnaF93YXRlcm1hcmsgYWxhcm0KICAgICMgd2hlbiA+ODAlIFJBTSBpcyB1c2VkLCBjYXVzaW5nIE9TTiB0byBjYWxsIGluaXQ6c3RvcCgpIH4xNXMgYWZ0ZXIgZXZlcnkgc3RhcnR1cC4KICAgIFdyaXRlLUxvZyAiQ2FwcGluZyBOVklESUEgSHVnZVBhZ2VzIGF0IDI1NiAoNTEyTUIpIHRvIHByZXZlbnQgUkFNIHN0YXJ2YXRpb24uLi4iCiAgICB3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tdXNlciByb290IC0tIGJhc2ggLWMgImVjaG8gdm0ubnJfaHVnZXBhZ2VzPTI1NiA+IC9ldGMvc3lzY3RsLmQvOTAtd3NsLmNvbmYgJiYgc3lzY3RsIC1wIC9ldGMvc3lzY3RsLmQvOTAtd3NsLmNvbmYiIDI+JjEgfCBGb3JFYWNoLU9iamVjdCB7IFdyaXRlLUxvZyAkXyB9CiAgICBXcml0ZS1Mb2cgIkh1Z2VQYWdlcyBjYXBwZWQg4oCUIE5WSURJQSBkcml2ZXIgbGltaXRlZCB0byA1MTJNQiBrZXJuZWwgcGFnZXMiICJPSyIKICAgIFNldC1TdGVwICJIdWdlUGFnZXMgY2FwIChSQU0gZml4KSIgIlBBU1MiCgogICAgIyDilIDilIAgU3RhYmlsaXR5IEZpeCAyOiByYWlzZSBPU04gZGlzayArIG1lbW9yeSBhbGFybSB0aHJlc2hvbGRzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogICAgIyBPY3RhU3BhY2UncyBpbnN0YWxsZXIgY3JlYXRlcyAvZG9ja2VyLWRhdGEuaW1nICh+NzYzR0IgcmVhbCBmaWxlKSBmb3IgRG9ja2VyIHN0b3JhZ2UsCiAgICAjIHB1c2hpbmcgdGhlIHJvb3QgZmlsZXN5c3RlbSB0byB+ODElLiBFcmxhbmcncyBkaXNrc3VwIGZpcmVzIGEgZGlza19hbG1vc3RfZnVsbCBhbGFybQogICAgIyBhdCA4MCUgKHRoZSBkZWZhdWx0KSBhbmQgY2F1c2VzIE9TTiB0byBzZWxmLXRlcm1pbmF0ZS4gUmFpc2luZyB0byA5MCUgY2xlYXJzIGhlYWRyb29tLgogICAgIyBtZW1zdXAncyBzeXN0ZW1fbWVtb3J5X2hpZ2hfd2F0ZXJtYXJrIHVzZXMgInN0cmljdGx5IGZyZWUgLyB0b3RhbCIgd2hpY2ggZmlyZXMgY29uc3RhbnRseQogICAgIyBvbiBMaW51eCBiZWNhdXNlIHRoZSBrZXJuZWwgZmlsbHMgYWxsIHNwYXJlIG1lbW9yeSB3aXRoIGJ1ZmZlciBjYWNoZS4gUmFpc2luZyB0byAwLjk3CiAgICAjIG1lYW5zIHRoZSBhbGFybSBvbmx5IGZpcmVzIHdoZW4gZ2VudWluZWx5IFJBTS1zdGFydmVkOyBicmllZiBzcGlrZXMgY2xlYXIgcXVpY2tseS4KICAgIFdyaXRlLUxvZyAiUGF0Y2hpbmcgT1NOIGFsYXJtIHRocmVzaG9sZHMgKGRpc2sgOTAlLCBtZW1vcnkgOTclKS4uLiIKICAgICRkaXNrRml4U2NyaXB0ID0gQCcKU1lTX0NGRz0kKGxzIC9ob21lL29jdGEvb3NuL3JlbGVhc2VzLyovc3lzLmNvbmZpZyAyPi9kZXYvbnVsbCB8IGdyZXAgLXYgUkVMRUFTRVMgfCBoZWFkIC0xKQppZiBbIC16ICIkU1lTX0NGRyIgXTsgdGhlbiBlY2hvICJzeXMuY29uZmlnIG5vdCBmb3VuZCI7IGV4aXQgMTsgZmkKZ3JlcCAtcSAiZGlza19hbG1vc3RfZnVsbF90aHJlc2hvbGQiICIkU1lTX0NGRyIgJiYgZ3JlcCAtcSAic3lzdGVtX21lbW9yeV9oaWdoX3dhdGVybWFyayIgIiRTWVNfQ0ZHIiAmJiBlY2hvICJhbHJlYWR5IHBhdGNoZWQiICYmIGV4aXQgMApjYXQgPiAiJFNZU19DRkciIDw8ICdFUkxFT0YnClsKICAgIHtrZXJuZWwsIFsKICAgICAgICB7bG9nZ2VyX2xldmVsLCBkZWJ1Z30sCiAgICAgICAge2xvZ2dlciwgWwogICAgICAgICAgICB7aGFuZGxlciwgZGVmYXVsdCwgbG9nZ2VyX3N0ZF9oLCAjewogICAgICAgICAgICAgICAgbGV2ZWwgPT4gZGVidWcsCiAgICAgICAgICAgICAgICBjb25maWcgPT4gI3sKICAgICAgICAgICAgICAgICAgICBidXJzdF9saW1pdF9lbmFibGUgPT4gZmFsc2UKICAgICAgICAgICAgICAgIH0sCiAgICAgICAgICAgICAgICBmb3JtYXR0ZXIgPT4ge2xvZ2dlcl9mb3JtYXR0ZXIsICN7dGVtcGxhdGUgPT4gW3RpbWUsICIgIiwgbXNnLCAiXG4iXX19CiAgICAgICAgICAgIH19CiAgICAgICAgXX0KICAgIF19LAogICAge29zX21vbiwgWwogICAgICAgIHtkaXNrX2FsbW9zdF9mdWxsX3RocmVzaG9sZCwgMC45MH0sCiAgICAgICAge3N5c3RlbV9tZW1vcnlfaGlnaF93YXRlcm1hcmssIDAuOTd9CiAgICBdfQpdLgpFUkxFT0YKZWNobyAicGF0Y2hlZCIKJ0AKICAgICRkaXNrRml4U2NyaXB0ID0gJGRpc2tGaXhTY3JpcHQgLXJlcGxhY2UgImByYG4iLCAiYG4iICAjIENSTEYgYnJlYWtzIGhlcmVkb2MgZGVsaW1pdGVyIHdoZW4gZGVjb2RlZCBpbiBiYXNoCiAgICAkZGlza0ZpeEI2NCA9IFtDb252ZXJ0XTo6VG9CYXNlNjRTdHJpbmcoW1N5c3RlbS5UZXh0LkVuY29kaW5nXTo6VVRGOC5HZXRCeXRlcygkZGlza0ZpeFNjcmlwdCkpCiAgICAkZGlza1Jlc3VsdCA9IHdzbCAtZCBVYnVudHUtMjIuMDQgLS11c2VyIHJvb3QgLS0gYmFzaCAtYyAiZWNobyAnJGRpc2tGaXhCNjQnIHwgYmFzZTY0IC1kIHwgYmFzaCIgMj4mMQogICAgJGRpc2tPayA9ICgkTEFTVEVYSVRDT0RFIC1lcSAwKSAtYW5kICgkZGlza1Jlc3VsdCAtbm90bWF0Y2ggJ3N5bnRheCBlcnJvcnxub3QgZm91bmR8ZXJyb3InKQogICAgV3JpdGUtTG9nICJPU04gYWxhcm0gdGhyZXNob2xkczogJCgkZGlza1Jlc3VsdCAtam9pbiAnICcpIiAkKGlmICgkZGlza09rKSB7ICJPSyIgfSBlbHNlIHsgIldBUk4iIH0pCiAgICBpZiAoJGRpc2tPaykgewogICAgICAgIFNldC1TdGVwICJPU04gYWxhcm0gdGhyZXNob2xkcyIgIlBBU1MiCiAgICB9IGVsc2UgewogICAgICAgIFNldC1TdGVwICJPU04gYWxhcm0gdGhyZXNob2xkcyIgIldBUk4iICJ0aHJlc2hvbGQgcGF0Y2ggZmFpbGVkIOKAlCBPU04gbWF5IHJlc3RhcnQgaWYgZGlzayA+ODAlIG9yIG1lbW9yeSBjYWNoZSBmaWxscyIKICAgIH0KCiAgICAjIOKUgOKUgCBTdGFiaWxpdHkgRml4IDM6IGRpc2FibGUgV2luZG93cyBVcGRhdGUgYXV0by1yZXN0YXJ0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogICAgIyBXaW5kb3dzIDExIGNhbiBmb3JjZS1yZXN0YXJ0IG1pZC1yZW50YWwgdG8gYXBwbHkgdXBkYXRlcywgdGVybWluYXRpbmcgYW55IHJ1bm5pbmcgam9iCiAgICAjIHdpdGggIm5vZGUgd2VudCBkb3duIG9yIHJlYm9vdGVkIGR1cmluZyBzZXNzaW9uIi4gQmxvY2sgYXV0by1yZXN0YXJ0IHdoZW4gYSB1c2VyIGlzCiAgICAjIGxvZ2dlZCBpbiAodXBkYXRlcyBzdGlsbCBkb3dubG9hZCBhbmQgaW5zdGFsbDsgdGhleSBqdXN0IGRvbid0IHJlc3RhcnQgd2l0aG91dCBjb25zZW50KS4KICAgIFdyaXRlLUxvZyAiQmxvY2tpbmcgV2luZG93cyBVcGRhdGUgYXV0by1yZXN0YXJ0IGR1cmluZyBhY3RpdmUgc2Vzc2lvbnMuLi4iCiAgICB0cnkgewogICAgICAgICR3dVBhdGggPSAiSEtMTTpcU09GVFdBUkVcUG9saWNpZXNcTWljcm9zb2Z0XFdpbmRvd3NcV2luZG93c1VwZGF0ZVxBVSIKICAgICAgICBpZiAoLW5vdCAoVGVzdC1QYXRoICR3dVBhdGgpKSB7IE5ldy1JdGVtIC1QYXRoICR3dVBhdGggLUZvcmNlIHwgT3V0LU51bGwgfQogICAgICAgIFNldC1JdGVtUHJvcGVydHkgLVBhdGggJHd1UGF0aCAtTmFtZSAiTm9BdXRvUmVib290V2l0aExvZ2dlZE9uVXNlcnMiIC1WYWx1ZSAxIC1UeXBlIERXb3JkIC1Gb3JjZQogICAgICAgIFNldC1JdGVtUHJvcGVydHkgLVBhdGggJHd1UGF0aCAtTmFtZSAiQVVPcHRpb25zIiAtVmFsdWUgNCAtVHlwZSBEV29yZCAtRm9yY2UgICMgNCA9IGRvd25sb2FkIGFuZCBzY2hlZHVsZSBpbnN0YWxsIChubyBhdXRvLWluc3RhbGwpCiAgICAgICAgV3JpdGUtTG9nICJXaW5kb3dzIFVwZGF0ZSBhdXRvLXJlc3RhcnQgc3VwcHJlc3NlZCIgIk9LIgogICAgICAgIFNldC1TdGVwICJXaW5kb3dzIFVwZGF0ZSByZXN0YXJ0IGd1YXJkIiAiUEFTUyIKICAgIH0gY2F0Y2ggewogICAgICAgIFdyaXRlLUxvZyAiQ291bGQgbm90IHNldCBXaW5kb3dzIFVwZGF0ZSBwb2xpY3kgKG5vbi1mYXRhbCk6ICRfIiAiV0FSTiIKICAgICAgICBTZXQtU3RlcCAiV2luZG93cyBVcGRhdGUgcmVzdGFydCBndWFyZCIgIldBUk4iICJNYW51YWw6IHNldCBOb0F1dG9SZWJvb3RXaXRoTG9nZ2VkT25Vc2Vycz0xIGluIEdyb3VwIFBvbGljeSIKICAgIH0KCiAgICAjIFN0YXJ0IHRoZSBzZXJ2aWNlIHNvIGl0IGNhbiByZWdpc3RlciBhbmQgZ2VuZXJhdGUgYSBub2RlIHRva2VuCiAgICBXcml0ZS1Mb2cgIlN0YXJ0aW5nIG9zbiBzZXJ2aWNlLi4uIgogICAgd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICJzeXN0ZW1jdGwgZW5hYmxlIG9zbiAyPi9kZXYvbnVsbDsgc3lzdGVtY3RsIHN0YXJ0IG9zbiAyPi9kZXYvbnVsbCIKICAgIFNldC1TdGVwICJvc24gc2VydmljZSBzdGFydGVkIiAiUEFTUyIKCiAgICAjIOKUgOKUgCBFeHRyYWN0IE9jdGFTcGFjZSBub2RlIHRva2VuIGZyb20gaW5zdGFsbGVyIG91dHB1dCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAgICMgVGhlIGluc3RhbGxlciBwcmludHMgYSBib3g6IOKVkSAgTm9kZSBUb2tlbjogWFhYWFhYWFhYWCAg4pWRIHRvIHN0ZG91dCDigJQgYnV0IG9ubHkKICAgICMgdGhlIEZJUlNUIHRpbWUgYSBub2RlIGlzIGNyZWF0ZWQ7IGEgcmUtcnVuIG9mIHRoaXMgd3JhcHBlciBhZ2FpbnN0IGFuIGFscmVhZHktCiAgICAjIHJlZ2lzdGVyZWQgbm9kZSB3b24ndCByZXByaW50IGl0LiBTbyB0aGUgbW9tZW50IHdlIGRvIGNhcHR1cmUgaXQgZnJlc2gsIHBlcnNpc3QKICAgICMgaXQgdG8gYSBwbGFpbi10ZXh0IG1hcmtlciBmaWxlIHdlIGNvbnRyb2wsIGFuZCBjaGVjayB0aGF0IGZpbGUgZmlyc3Qgb24gZXZlcnkKICAgICMgZnV0dXJlIHJ1biBiZWZvcmUgZmFsbGluZyBiYWNrIHRvIGd1ZXNzaW5nLiAoVGhlIG9zbi5pZGVudCBmaWxlIE9jdGFTcGFjZSBpdHNlbGYKICAgICMgd3JpdGVzIGlzIGEgcmF3IEVybGFuZyBleHRlcm5hbC10ZXJtLWZvcm1hdCBibG9iLCBub3QgSlNPTiwgYW5kIGlzbid0IGEgc3RhYmxlCiAgICAjIHRoaW5nIHRvIHNjcmFwZSBmcm9tIGJhc2gg4oCUIGRvbid0IHRyeSB0byBwYXJzZSBpdC4pCiAgICAkdG9rZW5NYXJrZXJDbWQgPSAiY2F0IC9ob21lL29jdGEvLnB1bHNlX25vZGVfdG9rZW4gMj4vZGV2L251bGwiCiAgICAkb2N0YU5vZGVUb2tlbiA9ICIiCiAgICAkdG9rZW5NYXRjaCA9ICRvY3RhT3V0cHV0IHwgU2VsZWN0LVN0cmluZyAtUGF0dGVybiAnTm9kZSBUb2tlbjpccyooXFMrKScKICAgIGlmICgkdG9rZW5NYXRjaCkgewogICAgICAgICRvY3RhTm9kZVRva2VuID0gJHRva2VuTWF0Y2guTWF0Y2hlc1swXS5Hcm91cHNbMV0uVmFsdWUuVHJpbSgpCiAgICAgICAgd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICJlY2hvICckb2N0YU5vZGVUb2tlbicgPiAvaG9tZS9vY3RhLy5wdWxzZV9ub2RlX3Rva2VuIiAyPiYxIHwgT3V0LU51bGwKICAgICAgICBXcml0ZS1Mb2cgIk9jdGFTcGFjZSBub2RlIHRva2VuOiAkb2N0YU5vZGVUb2tlbiIgIk9LIgogICAgICAgIFNldC1TdGVwICJPY3RhU3BhY2Ugbm9kZSB0b2tlbiIgIlBBU1MiICJUb2tlbjogJG9jdGFOb2RlVG9rZW4iCiAgICB9IGVsc2UgewogICAgICAgICMgRmFsbGJhY2sgMTogb3VyIG93biBtYXJrZXIgZmlsZSwgd3JpdHRlbiBvbiBhIHByaW9yIHN1Y2Nlc3NmdWwgcnVuIG9mIHRoaXMgc2NyaXB0CiAgICAgICAgV3JpdGUtTG9nICJUb2tlbiBub3QgZm91bmQgaW4gaW5zdGFsbGVyIG91dHB1dCDigJQgY2hlY2tpbmcgZm9yIGEgcHJldmlvdXNseSBzYXZlZCB0b2tlbi4uLiIKICAgICAgICAkbWFya2VyID0gKHdzbCAtZCBVYnVudHUtMjIuMDQgLS11c2VyIHJvb3QgLS0gYmFzaCAtYyAkdG9rZW5NYXJrZXJDbWQgMj4mMSkgLWpvaW4gJycKICAgICAgICAkbWFya2VyID0gJG1hcmtlci5UcmltKCkKICAgICAgICBpZiAoJG1hcmtlciAtbWF0Y2ggJ15cU3s2LH0kJykgewogICAgICAgICAgICAkb2N0YU5vZGVUb2tlbiA9ICRtYXJrZXIKICAgICAgICAgICAgV3JpdGUtTG9nICJPY3RhU3BhY2Ugbm9kZSB0b2tlbiAoZnJvbSBzYXZlZCBtYXJrZXIpOiAkb2N0YU5vZGVUb2tlbiIgIk9LIgogICAgICAgICAgICBTZXQtU3RlcCAiT2N0YVNwYWNlIG5vZGUgdG9rZW4iICJQQVNTIiAiVG9rZW46ICRvY3RhTm9kZVRva2VuIgogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICAgICMgRmFsbGJhY2sgMjogbGVnYWN5IGd1ZXNzZWQgY29uZmlnIHBhdGhzIChrZXB0IGluIGNhc2Ugb3NuJ3MgbGF5b3V0IGNoYW5nZXMpCiAgICAgICAgICAgIFdyaXRlLUxvZyAiTm8gc2F2ZWQgdG9rZW4gbWFya2VyIOKAlCBjaGVja2luZyBvc24gY29uZmlnIGZpbGVzLi4uIgogICAgICAgICAgICBTdGFydC1TbGVlcCAxNQogICAgICAgICAgICAkcmF3ID0gd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jIEAnCmZvciBmIGluIC9ob21lL29jdGEvb3NuL2V0Yy9zeXMuY29uZmlnIC9ldGMvb3NuL25vZGUuanNvbiAvdmFyL2xpYi9vc24vbm9kZS5qc29uOyBkbwogICAgWyAtZiAiJGYiIF0gfHwgY29udGludWUKICAgIHRvaz0kKGdyZXAgLW9QICcibm9kZV90b2tlbiJccyo6XHMqIlxLW14iXSsnICIkZiIgMj4vZGV2L251bGwgfHwgZ3JlcCAtb1AgJyJ0b2tlbiJccyo6XHMqIlxLW14iXSsnICIkZiIgMj4vZGV2L251bGwpCiAgICBbIC1uICIkdG9rIiBdICYmIGVjaG8gIiR0b2siICYmIGJyZWFrCmRvbmUKJ0AgMj4mMQogICAgICAgICAgICAkY2FuZGlkYXRlID0gKCRyYXcgfCBXaGVyZS1PYmplY3QgeyAkXyAtbWF0Y2ggJ15ccypcU3s2LH1ccyokJyB9KSB8IFNlbGVjdC1PYmplY3QgLUZpcnN0IDEKICAgICAgICAgICAgaWYgKCRjYW5kaWRhdGUpIHsKICAgICAgICAgICAgICAgICRvY3RhTm9kZVRva2VuID0gJGNhbmRpZGF0ZS5UcmltKCkKICAgICAgICAgICAgICAgIFdyaXRlLUxvZyAiT2N0YVNwYWNlIG5vZGUgdG9rZW4gKGZyb20gY29uZmlnKTogJG9jdGFOb2RlVG9rZW4iICJPSyIKICAgICAgICAgICAgICAgIFNldC1TdGVwICJPY3RhU3BhY2Ugbm9kZSB0b2tlbiIgIlBBU1MiICJUb2tlbjogJG9jdGFOb2RlVG9rZW4iCiAgICAgICAgICAgIH0gZWxzZSB7CiAgICAgICAgICAgICAgICBXcml0ZS1Mb2cgIk5vZGUgdG9rZW4gbm90IGZvdW5kIOKAlCBpdCB3aWxsIGFwcGVhciBhdCBjdWJlLm9jdGEuY29tcHV0ZXIgYWZ0ZXIgdGhlIG5vZGUgY29ubmVjdHMiICJXQVJOIgogICAgICAgICAgICAgICAgU2V0LVN0ZXAgIk9jdGFTcGFjZSBub2RlIHRva2VuIiAiV0FSTiIgIk5vdCB5ZXQgYXNzaWduZWQg4oCUIGNoZWNrIGN1YmUub2N0YS5jb21wdXRlciIKICAgICAgICAgICAgfQogICAgICAgIH0KICAgIH0KCiAgICAjIOKUgOKUgCBOZXR3b3JraW5nOiBXaW5kb3dzIEZpcmV3YWxsICsgVVBuUCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAgIFdyaXRlLUxvZyAiQWRkaW5nIFdpbmRvd3MgRmlyZXdhbGwgaW5ib3VuZCBydWxlcyAoVENQICsgVURQKS4uLiIKICAgICRhbGxQb3J0cyA9ICRPQ1RBX01HTVRfUE9SVFMgKyAoJE9DVEFfQVBQX1BPUlRfU1RBUlQuLiRPQ1RBX0FQUF9QT1JUX0VORCkKICAgIGZvcmVhY2ggKCRwb3J0IGluICRhbGxQb3J0cykgewogICAgICAgIE5ldy1OZXRGaXJld2FsbFJ1bGUgLURpc3BsYXlOYW1lICJQdWxzZS1PY3RhLVRDUC0kcG9ydCIgLURpcmVjdGlvbiBJbmJvdW5kIGAKICAgICAgICAgICAgLVByb3RvY29sIFRDUCAtTG9jYWxQb3J0ICRwb3J0IC1BY3Rpb24gQWxsb3cgLUVycm9yQWN0aW9uIFNpbGVudGx5Q29udGludWUgfCBPdXQtTnVsbAogICAgICAgIE5ldy1OZXRGaXJld2FsbFJ1bGUgLURpc3BsYXlOYW1lICJQdWxzZS1PY3RhLVVEUC0kcG9ydCIgLURpcmVjdGlvbiBJbmJvdW5kIGAKICAgICAgICAgICAgLVByb3RvY29sIFVEUCAtTG9jYWxQb3J0ICRwb3J0IC1BY3Rpb24gQWxsb3cgLUVycm9yQWN0aW9uIFNpbGVudGx5Q29udGludWUgfCBPdXQtTnVsbAogICAgfQogICAgV3JpdGUtTG9nICJGaXJld2FsbCBydWxlcyBhZGRlZCAoVENQK1VEUCkgZm9yIHBvcnRzICQoJE9DVEFfTUdNVF9QT1JUUyAtam9pbiAnLCAnKSArICRPQ1RBX0FQUF9QT1JUX1NUQVJULSRPQ1RBX0FQUF9QT1JUX0VORCIgIk9LIgogICAgU2V0LVN0ZXAgIldpbmRvd3MgRmlyZXdhbGwgcnVsZXMiICJQQVNTIiAiVENQK1VEUCAkKCRPQ1RBX01HTVRfUE9SVFMgLWpvaW4gJywgJyksICRPQ1RBX0FQUF9QT1JUX1NUQVJULSRPQ1RBX0FQUF9QT1JUX0VORCIKCiAgICBXcml0ZS1Mb2cgIkF0dGVtcHRpbmcgVVBuUCBhdXRvbWF0aWMgcG9ydCBmb3J3YXJkaW5nLi4uIgogICAgJGxvY2FsSVAgPSBHZXQtTG9jYWxJUAogICAgJHVwbnBPayAgPSAkZmFsc2UKICAgIHRyeSB7CiAgICAgICAgJHVwbnAgICAgID0gTmV3LU9iamVjdCAtQ29tT2JqZWN0IEhOZXRDZmcuTkFUVVBuUAogICAgICAgICRtYXBwaW5ncyA9ICR1cG5wLlN0YXRpY1BvcnRNYXBwaW5nQ29sbGVjdGlvbgogICAgICAgIGZvcmVhY2ggKCRwb3J0IGluICRhbGxQb3J0cykgewogICAgICAgICAgICAkbWFwcGluZ3MuQWRkKCRwb3J0LCAiVENQIiwgJHBvcnQsICRsb2NhbElQLCAkdHJ1ZSwgIlB1bHNlLU9jdGEtVENQLSRwb3J0IikgfCBPdXQtTnVsbAogICAgICAgICAgICAkbWFwcGluZ3MuQWRkKCRwb3J0LCAiVURQIiwgJHBvcnQsICRsb2NhbElQLCAkdHJ1ZSwgIlB1bHNlLU9jdGEtVURQLSRwb3J0IikgfCBPdXQtTnVsbAogICAgICAgIH0KICAgICAgICBXcml0ZS1Mb2cgIlVQblAgc3VjY2VlZGVkIOKAlCBwb3J0cyAkKCRPQ1RBX01HTVRfUE9SVFMgLWpvaW4gJywgJyksICRPQ1RBX0FQUF9QT1JUX1NUQVJULSRPQ1RBX0FQUF9QT1JUX0VORCBmb3J3YXJkZWQgKFRDUCtVRFApIHRvICRsb2NhbElQIiAiT0siCiAgICAgICAgU2V0LVN0ZXAgIlVQblAgcG9ydCBmb3J3YXJkaW5nIiAiUEFTUyIgIkF1dG8tZm9yd2FyZGVkIChUQ1ArVURQKSDihpIgJGxvY2FsSVAiCiAgICAgICAgJHVwbnBPayA9ICR0cnVlCiAgICB9IGNhdGNoIHsKICAgICAgICBXcml0ZS1Mb2cgIlVQblAgdW5hdmFpbGFibGUgb24gdGhpcyByb3V0ZXIiICJXQVJOIgogICAgICAgIFNldC1TdGVwICJVUG5QIHBvcnQgZm9yd2FyZGluZyIgIldBUk4iICJVUG5QIHVuYXZhaWxhYmxlIOKAlCBtYW51YWwgcm91dGVyIHNldHVwIHJlcXVpcmVkIChUQ1ArVURQLCBzZWUgYWJvdmUpIgogICAgfQoKICAgIGlmICgtbm90ICR1cG5wT2spIHsKICAgICAgICBXcml0ZS1Ib3N0ICIiCiAgICAgICAgV3JpdGUtSG9zdCAiICDilIzilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilJAiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgIFJPVVRFUiBTRVRVUCBSRVFVSVJFRCAob25lLXRpbWUsIH4yIG1pbnV0ZXMpICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICBZb3VyIHJvdXRlciBkb2Vzbid0IHN1cHBvcnQgYXV0by1mb3J3YXJkaW5nIChVUG5QIG9mZikuICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgT2N0YVNwYWNlIG5lZWRzIEJPVEggVENQIGFuZCBVRFAgZm9yd2FyZGVkLiAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgMS4gT3BlbiB5b3VyIHJvdXRlciBhZG1pbiBwYWdlICh1c3VhbGx5IGh0dHA6Ly8xOTIuMTY4LjEuMSnilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgIDIuIEZpbmQgJ1BvcnQgRm9yd2FyZGluZycgb3IgJ1ZpcnR1YWwgU2VydmVyJyAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICAzLiBBZGQgVENQK1VEUCBydWxlcyDihpIgJGxvY2FsSVAgOiAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAgIFRDUCtVRFAgMTg4ODgg4oaSICRsb2NhbElQYDoxODg4OCAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAgIFRDUCtVRFAgJE9DVEFfQVBQX1BPUlRfU1RBUlQtJE9DVEFfQVBQX1BPUlRfRU5EIOKGkiAkbG9jYWxJUGA6JE9DVEFfQVBQX1BPUlRfU1RBUlQtJE9DVEFfQVBQX1BPUlRfRU5EIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICBQcmVzcyBFbnRlciBvbmNlIGRvbmUgKHlvdSBjYW4gZmluaXNoIHRoaXMgbGF0ZXIgdmlhIHRoZSAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgUHVsc2UgZGFzaGJvYXJkIOKAlCBidXQgam9icyB3b24ndCBsYW5kIHVudGlsIGl0J3MgZG9uZSkgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUlOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUmCIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgICAgICBSZWFkLUhvc3QgIiAgUHJlc3MgRW50ZXIgdG8gY29udGludWUiCiAgICB9CgogICAgIyDilIDilIAgV1NMMiBQb3J0IFByb3h5IChUQ1Agb25seSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgICBpZiAoLW5vdCAkbWlycm9yZWROZXR3b3JraW5nKSB7CiAgICAgICAgV3JpdGUtTG9nICJDb25maWd1cmluZyBXU0wyIFRDUCBwb3J0IHByb3h5IChXaW5kb3dzIGhvc3Qg4oaSIFdTTDIgYnJpZGdlKS4uLiIKICAgICAgICAkd3NsSVAgPSAod3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICJob3N0bmFtZSAtSSAyPi9kZXYvbnVsbCIpLlRyaW0oKS5TcGxpdCgpWzBdCiAgICAgICAgaWYgKCR3c2xJUCkgewogICAgICAgICAgICBTZXQtV1NMMlBvcnRQcm94eSAtV3NsSVAgJHdzbElQCiAgICAgICAgICAgIFNldC1Db250ZW50IC1QYXRoICIkUFVMU0VfRElSXGxhc3Rfd3NsX2lwIiAtVmFsdWUgJHdzbElQIC1FbmNvZGluZyBVVEY4CiAgICAgICAgICAgIFNldC1TdGVwICJXU0wyIHBvcnQgcHJveHkiICJQQVNTIiAiVENQIOKGkiAkd3NsSVAgKFVEUCByZXF1aXJlcyBtaXJyb3JlZCBuZXR3b3JraW5nKSIKICAgICAgICB9IGVsc2UgewogICAgICAgICAgICBXcml0ZS1Mb2cgIkNvdWxkIG5vdCBkZXRlcm1pbmUgV1NMMiBJUCDigJQgcG9ydHByb3h5IHNraXBwZWQ7IHdpbGwgcmV0cnkgb24gbmV4dCBsb2dpbiIgIldBUk4iCiAgICAgICAgICAgIFNldC1TdGVwICJXU0wyIHBvcnQgcHJveHkiICJXQVJOIiAiV1NMMiBJUCBub3QgZm91bmQg4oCUIHdpbGwgcmV0cnkgb24gbmV4dCBsb2dpbiIKICAgICAgICB9CiAgICB9IGVsc2UgewogICAgICAgIFdyaXRlLUxvZyAiTWlycm9yZWQgbmV0d29ya2luZyBhY3RpdmUg4oCUIHBvcnRwcm94eSBub3QgbmVlZGVkOyBVRFAgdHVubmVscyBmdWxseSBmdW5jdGlvbmFsIiAiT0siCiAgICAgICAgU2V0LVN0ZXAgIldTTDIgcG9ydCBwcm94eSIgIlNLSVAiICJOb3QgbmVlZGVkIOKAlCBtaXJyb3JlZCBuZXR3b3JraW5nIGFjdGl2ZSIKICAgIH0KCiAgICAjIOKUgOKUgCBDdWJlIHJlZ2lzdHJhdGlvbiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAgIFdyaXRlLUhvc3QgIiIKICAgIFdyaXRlLUhvc3QgIiAg4pSM4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSQIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4KICAgIFdyaXRlLUhvc3QgIiAg4pSCICBPQ1RBU1BBQ0UgQ1VCRSBSRUdJU1RSQVRJT04gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4KICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbgogICAgV3JpdGUtSG9zdCAiICDilIIgIFRvIGFwcGVhciBpbiB0aGUgT2N0YVNwYWNlIG1hcmtldHBsYWNlOiAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBDeWFuCiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAxLiBPcGVuOiBodHRwczovL2N1YmUub2N0YS5jb21wdXRlciAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4KICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgIDIuIFNpZ24gaW4gLyBjcmVhdGUgYW4gYWNjb3VudCAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbgogICAgV3JpdGUtSG9zdCAiICDilIIgICAgMy4gQWRkIHlvdXIgbm9kZSDigJQgaXQgc2hvdWxkIGFwcGVhciBhdXRvbWF0aWNhbGx5ICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4KICAgIGlmICgkb2N0YU5vZGVUb2tlbikgewogICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBDeWFuCiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICBZb3VyIG5vZGUgdG9rZW46ICRvY3RhTm9kZVRva2VuIiAtRm9yZWdyb3VuZENvbG9yIFdoaXRlCiAgICB9CiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4KICAgIFdyaXRlLUhvc3QgIiAg4pSCICBUaGlzIHN0ZXAgaXMgZG9uZSBpbiB5b3VyIGJyb3dzZXIsIG5vdCB0aGlzIHdpbmRvdy4gICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbgogICAgV3JpdGUtSG9zdCAiICDilJTilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilJgiIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbgogICAgV3JpdGUtSG9zdCAiIgogICAgUmVhZC1Ib3N0ICIgIFByZXNzIEVudGVyIHRvIGNvbnRpbnVlIG9uY2UgeW91J3ZlIG5vdGVkIHRoZSBhYm92ZSIKCiAgICAjIOKUgOKUgCBSZWdpc3RlciB3aXRoIFB1bHNlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogICAgV3JpdGUtTG9nICJSZWdpc3RlcmluZyBtYWNoaW5lIHdpdGggUHVsc2UuLi4iCgogICAgJGJvZHkgPSBAewogICAgICAgIGdwdV9tb2RlbCAgICAgICAgPSAkZ3B1TmFtZQogICAgICAgIHZyYW1fZ2IgICAgICAgICAgPSAkdnJhbUdiCiAgICAgICAgb2N0YV9ub2RlX3Rva2VuICA9ICRvY3RhTm9kZVRva2VuCiAgICAgICAgcGxhdGZvcm0gICAgICAgICA9ICJPY3RhU3BhY2UiCiAgICB9IHwgQ29udmVydFRvLUpzb24KCiAgICB0cnkgewogICAgICAgICRyZXNwID0gSW52b2tlLVJlc3RNZXRob2QgLVVyaSAiJFBVTFNFX0FQSV9CQVNFL3JlZ2lzdGVyT2N0YXNwYWNlRGFlbW9uIiBgCiAgICAgICAgICAgIC1NZXRob2QgUE9TVCBgCiAgICAgICAgICAgIC1Db250ZW50VHlwZSAiYXBwbGljYXRpb24vanNvbiIgYAogICAgICAgICAgICAtSGVhZGVycyBAeyAiQXV0aG9yaXphdGlvbiIgPSAiQmVhcmVyICRQVUxTRV9VU0VSX1RPS0VOIiB9IGAKICAgICAgICAgICAgLUJvZHkgJGJvZHkKICAgICAgICBXcml0ZS1Mb2cgIlB1bHNlIHJlZ2lzdHJhdGlvbjogJCgkcmVzcC5tZXNzYWdlKSIgIk9LIgogICAgICAgIFNldC1TdGVwICJQdWxzZSByZWdpc3RyYXRpb24iICJQQVNTIgogICAgfSBjYXRjaCB7CiAgICAgICAgV3JpdGUtTG9nICJQdWxzZSByZWdpc3RyYXRpb24gZmFpbGVkICh3aWxsIHJldHJ5IG9uIG5leHQgc3RhcnQpOiAkXyIgIldBUk4iCiAgICAgICAgU2V0LVN0ZXAgIlB1bHNlIHJlZ2lzdHJhdGlvbiIgIldBUk4iICJXaWxsIHJldHJ5IGF1dG9tYXRpY2FsbHkgb24gbmV4dCBsb2dpbiIKICAgIH0KCiAgICAjIOKUgOKUgCBDYXB0dXJlIE9jdGFTcGFjZSBub2RlIG5hbWUgZm9yIGNvb3JkaW5hdG9yIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogICAgV3JpdGUtTG9nICJMb29raW5nIHVwIE9jdGFTcGFjZSBub2RlIG5hbWUgZm9yIGNvb3JkaW5hdG9yLi4uIgogICAgJGdwdVRhZyA9IGlmICgkZ3B1TmFtZSAtbWF0Y2ggIlJUWFxzKihcZCtccypUaT8pIikgeyAoJE1hdGNoZXNbMF0gLXJlcGxhY2UgJ1xzJywnJykgfSBgCiAgICAgICAgICAgICAgZWxzZWlmICgkZ3B1TmFtZSAtbWF0Y2ggIkdUWFxzKihcZCtccypUaT8pIikgeyAoJE1hdGNoZXNbMF0gLXJlcGxhY2UgJ1xzJywnJykgfSBgCiAgICAgICAgICAgICAgZWxzZWlmICgkZ3B1TmFtZSAtbWF0Y2ggIlJYXHMqKFxkK1xzKlhUPykiKSB7ICgkTWF0Y2hlc1swXSAtcmVwbGFjZSAnXHMnLCcnKSB9IGAKICAgICAgICAgICAgICBlbHNlIHsgKCRncHVOYW1lIC1zcGxpdCAnICcgfCBTZWxlY3QtT2JqZWN0IC1MYXN0IDEpIH0KICAgICRvY3RhTm9kZU5hbWVGb3JDb29yZCA9ICIiCiAgICBmb3IgKCRpID0gMTsgJGkgLWxlIDY7ICRpKyspIHsKICAgICAgICB0cnkgewogICAgICAgICAgICAkbmkgPSBJbnZva2UtUmVzdE1ldGhvZCAtVXJpICIkUFVMU0VfQVBJX0JBU0UvZ2V0T2N0YU5vZGVJbmZvIiBgCiAgICAgICAgICAgICAgICAtSGVhZGVycyBAeyAiQXV0aG9yaXphdGlvbiIgPSAiQmVhcmVyICRQVUxTRV9VU0VSX1RPS0VOIiB9IC1NZXRob2QgR0VUIC1UaW1lb3V0U2VjIDIwIC1FcnJvckFjdGlvbiBTdG9wCiAgICAgICAgICAgICRtYXRjaGVkTm9kZSA9ICRuaS5ub2RlcyB8IFdoZXJlLU9iamVjdCB7ICRfLm5hbWUgLW1hdGNoIFtyZWdleF06OkVzY2FwZSgkZ3B1VGFnKSB9IHwgU2VsZWN0LU9iamVjdCAtRmlyc3QgMQogICAgICAgICAgICBpZiAoJG1hdGNoZWROb2RlKSB7CiAgICAgICAgICAgICAgICAkb2N0YU5vZGVOYW1lRm9yQ29vcmQgPSAkbWF0Y2hlZE5vZGUubmFtZQogICAgICAgICAgICAgICAgU2V0LUNvbnRlbnQgLVBhdGggIiRQVUxTRV9ESVJcb2N0YV9ub2RlX25hbWUudHh0IiAtVmFsdWUgJG9jdGFOb2RlTmFtZUZvckNvb3JkIC1FbmNvZGluZyBVVEY4CiAgICAgICAgICAgICAgICBXcml0ZS1Mb2cgIk5vZGUgbmFtZSBzYXZlZDogJG9jdGFOb2RlTmFtZUZvckNvb3JkIiAiT0siCiAgICAgICAgICAgICAgICBicmVhawogICAgICAgICAgICB9CiAgICAgICAgfSBjYXRjaCB7IH0KICAgICAgICBpZiAoJGkgLWx0IDYpIHsgV3JpdGUtTG9nICIgIFdhaXRpbmcgZm9yIG5vZGUgdG8gYXBwZWFyLi4uICgkKCRpICogMzApcykiOyBTdGFydC1TbGVlcCAzMCB9CiAgICB9CiAgICBpZiAoLW5vdCAkb2N0YU5vZGVOYW1lRm9yQ29vcmQpIHsKICAgICAgICBXcml0ZS1Mb2cgIk5vZGUgbmFtZSBub3QgeWV0IHZpc2libGUg4oCUIGNvb3JkaW5hdG9yIHdpbGwgc2tpcCBPY3RhU3BhY2UgYXZhaWxhYmlsaXR5IGNoZWNrIiAiV0FSTiIKICAgIH0KCiAgICAjIOKUgOKUgCBQbGF0Zm9ybSBDb29yZGluYXRvcjogV1NMIGtlZXBhbGl2ZSArIG11bHRpLXBsYXRmb3JtIGNvb3JkaW5hdGlvbiDilIDilIDilIDilIDilIAKICAgIFdyaXRlLUxvZyAiSW5zdGFsbGluZyBwbGF0Zm9ybSBjb29yZGluYXRvci4uLiIKICAgICRjb29yZFRlbXBsYXRlID0gQCcKJGNvb3JkTG9nID0gIiRlbnY6TE9DQUxBUFBEQVRBXFB1bHNlXGNvb3JkaW5hdG9yLmxvZyIKJFBVTFNFX0FQSV9CQVNFID0gIiMjQVBJX0JBU0UjIyIKJFBVTFNFX1VTRVJfVE9LRU4gPSAiIyNVU0VSX1RPS0VOIyMiCiRrZWVwYWxpdmVQaWQgPSAkbnVsbAoKZnVuY3Rpb24gRW5zdXJlLVdTTEFsaXZlIHsKICAgIGlmICgkbnVsbCAtZXEgJGtlZXBhbGl2ZVBpZCAtb3IgLW5vdCAoR2V0LVByb2Nlc3MgLUlkICRrZWVwYWxpdmVQaWQgLUVycm9yQWN0aW9uIFNpbGVudGx5Q29udGludWUpKSB7CiAgICAgICAgJHAgPSBTdGFydC1Qcm9jZXNzICJ3c2wuZXhlIiAtQXJndW1lbnRMaXN0ICItZCBVYnVudHUtMjIuMDQgLS11c2VyIHJvb3QgLS0gYmFzaCAtYyAnd2hpbGUgdHJ1ZTsgZG8gc2xlZXAgMzYwMDsgZG9uZSciIC1QYXNzVGhydSAtV2luZG93U3R5bGUgSGlkZGVuIC1FcnJvckFjdGlvbiBTaWxlbnRseUNvbnRpbnVlCiAgICAgICAgaWYgKCRwKSB7ICRzY3JpcHQ6a2VlcGFsaXZlUGlkID0gJHAuSWQ7IEFkZC1Db250ZW50ICRjb29yZExvZyAiJChHZXQtRGF0ZSAtZiAneXl5eS1NTS1kZCBISDptbScpIFdTTCBrZWVwYWxpdmUgKFBJRCAkKCRwLklkKSkiIH0KICAgIH0KfQpmdW5jdGlvbiB3c2wtc3ZjKFtzdHJpbmddJGNtZCkgeyAod3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICRjbWQgMj4mMSB8IE91dC1TdHJpbmcpLlRyaW0oKSB9CgpFbnN1cmUtV1NMQWxpdmUKQWRkLUNvbnRlbnQgJGNvb3JkTG9nICIkKEdldC1EYXRlIC1mICd5eXl5LU1NLWRkIEhIOm1tJykgQ29vcmRpbmF0b3Igc3RhcnRlZCIKCndoaWxlICgkdHJ1ZSkgewogICAgdHJ5IHsKICAgICAgICBFbnN1cmUtV1NMQWxpdmUKICAgICAgICAkb2N0YUV4aXN0cyAgPSBbaW50XSh3c2wtc3ZjICJzeXN0ZW1jdGwgbGlzdC11bml0LWZpbGVzIG9zbi5zZXJ2aWNlIDI+L2Rldi9udWxsIHwgZ3JlcCAtYyBvc24iKSAtZ3QgMAogICAgICAgICRjbG9yZUV4aXN0cyA9IFtpbnRdKHdzbC1zdmMgInN5c3RlbWN0bCBsaXN0LXVuaXQtZmlsZXMgY2xvcmUtaG9zdGluZy5zZXJ2aWNlIDI+L2Rldi9udWxsIHwgZ3JlcCAtYyBjbG9yZS1ob3N0aW5nIikgLWd0IDAKICAgICAgICBpZiAoJG9jdGFFeGlzdHMgLWFuZCAkY2xvcmVFeGlzdHMpIHsKICAgICAgICAgICAgJGNsb3JlUmVudGVkID0gW2ludF0od3NsLXN2YyAiZG9ja2VyIHBzIC1xIDI+L2Rldi9udWxsIHwgd2MgLWwiKSAtZ3QgMAogICAgICAgICAgICAkb2N0YVJlbnRlZCAgPSAkZmFsc2UKICAgICAgICAgICAgJG5vZGVGaWxlID0gIiRlbnY6TE9DQUxBUFBEQVRBXFB1bHNlXG9jdGFfbm9kZV9uYW1lLnR4dCIKICAgICAgICAgICAgaWYgKFRlc3QtUGF0aCAkbm9kZUZpbGUpIHsKICAgICAgICAgICAgICAgICRub2RlTmFtZSA9IChHZXQtQ29udGVudCAkbm9kZUZpbGUgLVJhdykuVHJpbSgpCiAgICAgICAgICAgICAgICB0cnkgewogICAgICAgICAgICAgICAgICAgICRyID0gSW52b2tlLVJlc3RNZXRob2QgIiRQVUxTRV9BUElfQkFTRS9nZXRPY3RhTm9kZUluZm8iIC1IZWFkZXJzIEB7QXV0aG9yaXphdGlvbj0iQmVhcmVyICRQVUxTRV9VU0VSX1RPS0VOIn0gLVRpbWVvdXRTZWMgMTUgLUVycm9yQWN0aW9uIFN0b3AKICAgICAgICAgICAgICAgICAgICAkbiA9ICRyLm5vZGVzIHwgV2hlcmUtT2JqZWN0IHsgJF8ubmFtZSAtZXEgJG5vZGVOYW1lIH0gfCBTZWxlY3QtT2JqZWN0IC1GaXJzdCAxCiAgICAgICAgICAgICAgICAgICAgJG9jdGFSZW50ZWQgPSAkbiAtYW5kICRuLmF2YWlsYWJpbGl0eSAtZXEgImJ1c3kiCiAgICAgICAgICAgICAgICB9IGNhdGNoIHsgfQogICAgICAgICAgICB9CiAgICAgICAgICAgIGlmICgkY2xvcmVSZW50ZWQgLWFuZCAtbm90ICRvY3RhUmVudGVkKSB7CiAgICAgICAgICAgICAgICBpZiAoKHdzbC1zdmMgInN5c3RlbWN0bCBpcy1hY3RpdmUgb3NuIDI+L2Rldi9udWxsIikgLWVxICJhY3RpdmUiKSB7CiAgICAgICAgICAgICAgICAgICAgd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICJzeXN0ZW1jdGwgc3RvcCBvc24gMj4vZGV2L251bGwiIHwgT3V0LU51bGwKICAgICAgICAgICAgICAgICAgICBBZGQtQ29udGVudCAkY29vcmRMb2cgIiQoR2V0LURhdGUgLWYgJ3l5eXktTU0tZGQgSEg6bW0nKSBDbG9yZSByZW50YWwgLS0gcGF1c2VkIG9zbiIKICAgICAgICAgICAgICAgIH0KICAgICAgICAgICAgfSBlbHNlaWYgKCRvY3RhUmVudGVkIC1hbmQgLW5vdCAkY2xvcmVSZW50ZWQpIHsKICAgICAgICAgICAgICAgIGlmICgod3NsLXN2YyAic3lzdGVtY3RsIGlzLWFjdGl2ZSBjbG9yZS1ob3N0aW5nIDI+L2Rldi9udWxsIikgLWVxICJhY3RpdmUiKSB7CiAgICAgICAgICAgICAgICAgICAgd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICJzeXN0ZW1jdGwgc3RvcCBjbG9yZS1ob3N0aW5nIDI+L2Rldi9udWxsIiB8IE91dC1OdWxsCiAgICAgICAgICAgICAgICAgICAgQWRkLUNvbnRlbnQgJGNvb3JkTG9nICIkKEdldC1EYXRlIC1mICd5eXl5LU1NLWRkIEhIOm1tJykgT2N0YVNwYWNlIHJlbnRhbCAtLSBwYXVzZWQgY2xvcmUtaG9zdGluZyIKICAgICAgICAgICAgICAgIH0KICAgICAgICAgICAgfSBlbHNlIHsKICAgICAgICAgICAgICAgIGlmICgod3NsLXN2YyAic3lzdGVtY3RsIGlzLWFjdGl2ZSBvc24gMj4vZGV2L251bGwiKSAtbmUgImFjdGl2ZSIpIHsKICAgICAgICAgICAgICAgICAgICB3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tdXNlciByb290IC0tIGJhc2ggLWMgInN5c3RlbWN0bCBzdGFydCBvc24gMj4vZGV2L251bGwiIHwgT3V0LU51bGwKICAgICAgICAgICAgICAgICAgICBBZGQtQ29udGVudCAkY29vcmRMb2cgIiQoR2V0LURhdGUgLWYgJ3l5eXktTU0tZGQgSEg6bW0nKSBTdGFydGVkIG9zbiIKICAgICAgICAgICAgICAgIH0KICAgICAgICAgICAgICAgIGlmICgod3NsLXN2YyAic3lzdGVtY3RsIGlzLWFjdGl2ZSBjbG9yZS1ob3N0aW5nIDI+L2Rldi9udWxsIikgLW5lICJhY3RpdmUiKSB7CiAgICAgICAgICAgICAgICAgICAgd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICJzeXN0ZW1jdGwgc3RhcnQgY2xvcmUtaG9zdGluZyAyPi9kZXYvbnVsbCIgfCBPdXQtTnVsbAogICAgICAgICAgICAgICAgICAgIEFkZC1Db250ZW50ICRjb29yZExvZyAiJChHZXQtRGF0ZSAtZiAneXl5eS1NTS1kZCBISDptbScpIFN0YXJ0ZWQgY2xvcmUtaG9zdGluZyIKICAgICAgICAgICAgICAgIH0KICAgICAgICAgICAgfQogICAgICAgIH0gZWxzZWlmICgkb2N0YUV4aXN0cykgewogICAgICAgICAgICBpZiAoKHdzbC1zdmMgInN5c3RlbWN0bCBpcy1hY3RpdmUgb3NuIDI+L2Rldi9udWxsIikgLW5lICJhY3RpdmUiKSB7CiAgICAgICAgICAgICAgICB3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tdXNlciByb290IC0tIGJhc2ggLWMgInN5c3RlbWN0bCBzdGFydCBvc24gMj4vZGV2L251bGwiIHwgT3V0LU51bGwKICAgICAgICAgICAgICAgIEFkZC1Db250ZW50ICRjb29yZExvZyAiJChHZXQtRGF0ZSAtZiAneXl5eS1NTS1kZCBISDptbScpIFJlc3RhcnRlZCBvc24iCiAgICAgICAgICAgIH0KICAgICAgICB9IGVsc2VpZiAoJGNsb3JlRXhpc3RzKSB7CiAgICAgICAgICAgIGlmICgod3NsLXN2YyAic3lzdGVtY3RsIGlzLWFjdGl2ZSBjbG9yZS1ob3N0aW5nIDI+L2Rldi9udWxsIikgLW5lICJhY3RpdmUiKSB7CiAgICAgICAgICAgICAgICB3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tdXNlciByb290IC0tIGJhc2ggLWMgInN5c3RlbWN0bCBzdGFydCBjbG9yZS1ob3N0aW5nIDI+L2Rldi9udWxsIiB8IE91dC1OdWxsCiAgICAgICAgICAgICAgICBBZGQtQ29udGVudCAkY29vcmRMb2cgIiQoR2V0LURhdGUgLWYgJ3l5eXktTU0tZGQgSEg6bW0nKSBSZXN0YXJ0ZWQgY2xvcmUtaG9zdGluZyIKICAgICAgICAgICAgfQogICAgICAgIH0KICAgIH0gY2F0Y2ggeyB9CiAgICBTdGFydC1TbGVlcCAzMDAKfQonQAogICAgJGNvb3JkaW5hdG9yID0gJGNvb3JkVGVtcGxhdGUuUmVwbGFjZSgiIyNBUElfQkFTRSMjIiwgJFBVTFNFX0FQSV9CQVNFKS5SZXBsYWNlKCIjI1VTRVJfVE9LRU4jIyIsICRQVUxTRV9VU0VSX1RPS0VOKQogICAgJGNvb3JkUGF0aCA9ICIkUFVMU0VfRElSXGNvb3JkaW5hdG9yLnBzMSIKICAgIFNldC1Db250ZW50IC1QYXRoICRjb29yZFBhdGggLVZhbHVlICRjb29yZGluYXRvciAtRW5jb2RpbmcgVVRGOAoKICAgICRjQSA9IE5ldy1TY2hlZHVsZWRUYXNrQWN0aW9uIC1FeGVjdXRlICJwb3dlcnNoZWxsLmV4ZSIgYAogICAgICAgIC1Bcmd1bWVudCAiLU5vUHJvZmlsZSAtRXhlY3V0aW9uUG9saWN5IEJ5cGFzcyAtV2luZG93U3R5bGUgSGlkZGVuIC1GaWxlIGAiJGNvb3JkUGF0aGAiIgogICAgJGNUID0gTmV3LVNjaGVkdWxlZFRhc2tUcmlnZ2VyIC1BdExvZ09uCiAgICAkY1MgPSBOZXctU2NoZWR1bGVkVGFza1NldHRpbmdzU2V0IC1BbGxvd1N0YXJ0SWZPbkJhdHRlcmllcyAtRXhlY3V0aW9uVGltZUxpbWl0IDAKICAgICRjUCA9IE5ldy1TY2hlZHVsZWRUYXNrUHJpbmNpcGFsIC1Vc2VySWQgJGVudjpVU0VSTkFNRSAtUnVuTGV2ZWwgSGlnaGVzdAogICAgUmVnaXN0ZXItU2NoZWR1bGVkVGFzayAtVGFza05hbWUgJENPT1JESU5BVE9SX1RBU0sgLUFjdGlvbiAkY0EgLVRyaWdnZXIgJGNUIGAKICAgICAgICAtU2V0dGluZ3MgJGNTIC1QcmluY2lwYWwgJGNQIC1Gb3JjZSB8IE91dC1OdWxsCiAgICBXcml0ZS1Mb2cgIlBsYXRmb3JtIGNvb3JkaW5hdG9yIGluc3RhbGxlZCIgIk9LIgogICAgU2V0LVN0ZXAgIkdQVSB3YXRjaGRvZyB0YXNrIiAiUEFTUyIKCiAgICAjIOKUgOKUgCBBdXRvLXN0YXJ0OiBvc24gb24gZXZlcnkgbG9naW4g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgICBXcml0ZS1Mb2cgIkluc3RhbGxpbmcgYXV0by1zdGFydCB0YXNrLi4uIgogICAgJGF1dG9zdGFydCA9IGlmICgkbWlycm9yZWROZXR3b3JraW5nKSB7CiAgICAgICAgQCcKU3RhcnQtU2xlZXAgMTUKd3NsIC1kIFVidW50dS0yMi4wNCAtLSBiYXNoIC1jICdzdWRvIHN5c3RlbWN0bCBzdGFydCBvc24gMj4vZGV2L251bGwnIDI+JjEgfAogICAgQWRkLUNvbnRlbnQgIiRlbnY6TE9DQUxBUFBEQVRBXFB1bHNlXG9jdGFfYXV0b3N0YXJ0LmxvZyIKJ0AKICAgIH0gZWxzZSB7CiAgICAgICAgQCIKU3RhcnQtU2xlZXAgMTUKYCR3c2xJUCA9ICh3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tdXNlciByb290IC0tIGJhc2ggLWMgJ2hvc3RuYW1lIC1JIDI+L2Rldi9udWxsJykuVHJpbSgpLlNwbGl0KClbMF0KYCRsYXN0SVBGaWxlID0gImAkZW52OkxPQ0FMQVBQREFUQVxQdWxzZVxsYXN0X3dzbF9pcCIKYCRsYXN0SVAgPSBpZiAoVGVzdC1QYXRoIGAkbGFzdElQRmlsZSkgeyAoR2V0LUNvbnRlbnQgYCRsYXN0SVBGaWxlKS5UcmltKCkgfSBlbHNlIHsgJycgfQppZiAoYCR3c2xJUCAtYW5kIGAkd3NsSVAgLW5lIGAkbGFzdElQKSB7CiAgICAoQCgxODg4OCkgKyAoNTE4MDAuLjUxODE2KSkgfCBGb3JFYWNoLU9iamVjdCB7CiAgICAgICAgbmV0c2ggaW50ZXJmYWNlIHBvcnRwcm94eSBkZWxldGUgdjR0b3Y0IGxpc3RlbnBvcnQ9YCRfIGxpc3RlbmFkZHJlc3M9MC4wLjAuMCB8IE91dC1OdWxsCiAgICAgICAgbmV0c2ggaW50ZXJmYWNlIHBvcnRwcm94eSBhZGQgdjR0b3Y0IGxpc3RlbnBvcnQ9YCRfIGxpc3RlbmFkZHJlc3M9MC4wLjAuMCBjb25uZWN0cG9ydD1gJF8gY29ubmVjdGFkZHJlc3M9YCR3c2xJUCB8IE91dC1OdWxsCiAgICB9CiAgICBTZXQtQ29udGVudCAtUGF0aCBgJGxhc3RJUEZpbGUgLVZhbHVlIGAkd3NsSVAKfQp3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tIGJhc2ggLWMgJ3N1ZG8gc3lzdGVtY3RsIHN0YXJ0IG9zbiAyPi9kZXYvbnVsbCcgMj4mMSB8CiAgICBBZGQtQ29udGVudCAiYCRlbnY6TE9DQUxBUFBEQVRBXFB1bHNlXG9jdGFfYXV0b3N0YXJ0LmxvZyIKIkAKICAgIH0KICAgICRzdGFydFBhdGggPSAiJFBVTFNFX0RJUlxvY3RhX2F1dG9zdGFydC5wczEiCiAgICBTZXQtQ29udGVudCAtUGF0aCAkc3RhcnRQYXRoIC1WYWx1ZSAkYXV0b3N0YXJ0IC1FbmNvZGluZyBVVEY4CgogICAgJHNBID0gTmV3LVNjaGVkdWxlZFRhc2tBY3Rpb24gLUV4ZWN1dGUgInBvd2Vyc2hlbGwuZXhlIiBgCiAgICAgICAgLUFyZ3VtZW50ICItTm9Qcm9maWxlIC1FeGVjdXRpb25Qb2xpY3kgQnlwYXNzIC1XaW5kb3dTdHlsZSBIaWRkZW4gLUZpbGUgYCIkc3RhcnRQYXRoYCIiCiAgICAkc1QgPSBOZXctU2NoZWR1bGVkVGFza1RyaWdnZXIgLUF0TG9nT24KICAgICRzUyA9IE5ldy1TY2hlZHVsZWRUYXNrU2V0dGluZ3NTZXQgLUFsbG93U3RhcnRJZk9uQmF0dGVyaWVzIC1FeGVjdXRpb25UaW1lTGltaXQgMAogICAgJHNQID0gTmV3LVNjaGVkdWxlZFRhc2tQcmluY2lwYWwgLVVzZXJJZCAkZW52OlVTRVJOQU1FIC1SdW5MZXZlbCBIaWdoZXN0CiAgICBSZWdpc3Rlci1TY2hlZHVsZWRUYXNrIC1UYXNrTmFtZSAkQVVUT1NUQVJUX1RBU0sgLUFjdGlvbiAkc0EgLVRyaWdnZXIgJHNUIGAKICAgICAgICAtU2V0dGluZ3MgJHNTIC1QcmluY2lwYWwgJHNQIC1Gb3JjZSB8IE91dC1OdWxsCiAgICBXcml0ZS1Mb2cgIkF1dG8tc3RhcnQgaW5zdGFsbGVkIiAiT0siCiAgICBTZXQtU3RlcCAiQXV0by1zdGFydCB0YXNrIiAiUEFTUyIKCiAgICAjIOKUgOKUgCBBdXRvLWxvZ2luOiBzdXJ2aXZlIHVuYXR0ZW5kZWQgcmVib290cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAgIFdyaXRlLUhvc3QgIiIKICAgIFdyaXRlLUhvc3QgIiAg4pSM4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSQIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgV3JpdGUtSG9zdCAiICDilIIgIEFVVE8tTE9HSU4gKHJlY29tbWVuZGVkIGZvciBkZWRpY2F0ZWQgR1BVIHNlcnZlcnMpICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgV2l0aG91dCB0aGlzLCBPY3RhU3BhY2UgZ29lcyBPRkZMSU5FIGFmdGVyIGFueSB1bmF0dGVuZGVkICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgcmVib290IChwb3dlciBjdXQsIFdpbmRvd3MgVXBkYXRlKSB1bnRpbCBzb21lb25lIGxvZ3MgaW4uICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgV3JpdGUtSG9zdCAiICDilIIgIFRyYWRlLW9mZjogc3RvcmVzIHlvdXIgV2luZG93cyBwYXNzd29yZCBpbiB0aGUgcmVnaXN0cnkuICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgV3JpdGUtSG9zdCAiICDilIIgIE9ubHkgZW5hYmxlIGlmIHRoaXMgbWFjaGluZSBpcyBpbiBhIHBoeXNpY2FsbHkgc2VjdXJlIHNwb3Qu4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgV3JpdGUtSG9zdCAiICDilIIgIFRvIHVuZG8gbGF0ZXI6IHJ1biBuZXRwbHdpeiBhbmQgcmUtZW5hYmxlIHBhc3N3b3JkIHByb21wdC4g4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgV3JpdGUtSG9zdCAiICDilJTilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilJgiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICBXcml0ZS1Ib3N0ICIiCiAgICAkZG9BdXRvTG9naW4gPSBSZWFkLUhvc3QgIiAgRW5hYmxlIGF1dG8tbG9naW4/ICh5L04pIgogICAgaWYgKCRkb0F1dG9Mb2dpbiAtbWF0Y2ggJ15bWXldJykgewogICAgICAgICRzZWN1cmVQYXNzID0gUmVhZC1Ib3N0ICIgIEVudGVyIHlvdXIgV2luZG93cyBsb2dpbiBwYXNzd29yZCIgLUFzU2VjdXJlU3RyaW5nCiAgICAgICAgJGJzdHIgICAgICA9IFtSdW50aW1lLkludGVyb3BTZXJ2aWNlcy5NYXJzaGFsXTo6U2VjdXJlU3RyaW5nVG9CU1RSKCRzZWN1cmVQYXNzKQogICAgICAgICRwbGFpblBhc3MgPSBbUnVudGltZS5JbnRlcm9wU2VydmljZXMuTWFyc2hhbF06OlB0clRvU3RyaW5nQXV0bygkYnN0cikKICAgICAgICBbUnVudGltZS5JbnRlcm9wU2VydmljZXMuTWFyc2hhbF06Olplcm9GcmVlQlNUUigkYnN0cikKCiAgICAgICAgJHJlZ1BhdGggPSAiSEtMTTpcU09GVFdBUkVcTWljcm9zb2Z0XFdpbmRvd3MgTlRcQ3VycmVudFZlcnNpb25cV2lubG9nb24iCiAgICAgICAgU2V0LUl0ZW1Qcm9wZXJ0eSAtUGF0aCAkcmVnUGF0aCAtTmFtZSAiQXV0b0FkbWluTG9nb24iICAgLVZhbHVlICIxIiAgICAgICAgICAgICAtVHlwZSBTdHJpbmcKICAgICAgICBTZXQtSXRlbVByb3BlcnR5IC1QYXRoICRyZWdQYXRoIC1OYW1lICJEZWZhdWx0VXNlcm5hbWUiICAgLVZhbHVlICRlbnY6VVNFUk5BTUUgICAtVHlwZSBTdHJpbmcKICAgICAgICBTZXQtSXRlbVByb3BlcnR5IC1QYXRoICRyZWdQYXRoIC1OYW1lICJEZWZhdWx0RG9tYWluTmFtZSIgLVZhbHVlICRlbnY6VVNFUkRPTUFJTiAtVHlwZSBTdHJpbmcKICAgICAgICBTZXQtSXRlbVByb3BlcnR5IC1QYXRoICRyZWdQYXRoIC1OYW1lICJEZWZhdWx0UGFzc3dvcmQiICAgLVZhbHVlICRwbGFpblBhc3MgICAgICAtVHlwZSBTdHJpbmcKICAgICAgICAkcGxhaW5QYXNzID0gJG51bGw7IFtTeXN0ZW0uR0NdOjpDb2xsZWN0KCkKCiAgICAgICAgV3JpdGUtTG9nICJBdXRvLWxvZ2luIGVuYWJsZWQgZm9yICRlbnY6VVNFUk5BTUUg4oCUIE9jdGFTcGFjZSByZXN1bWVzIGF1dG9tYXRpY2FsbHkgYWZ0ZXIgYW55IHJlYm9vdCIgIk9LIgogICAgICAgIFdyaXRlLUxvZyAiVG8gZGlzYWJsZTogcnVuIG5ldHBsd2l6IGFuZCByZS1jaGVjayAnVXNlcnMgbXVzdCBlbnRlciBhIHVzZXJuYW1lIGFuZCBwYXNzd29yZCciICJJTkZPIgogICAgICAgIFNldC1TdGVwICJBdXRvLWxvZ2luIiAiUEFTUyIgIkVuYWJsZWQgZm9yICRlbnY6VVNFUk5BTUUiCiAgICB9IGVsc2UgewogICAgICAgIFdyaXRlLUxvZyAiQXV0by1sb2dpbiBza2lwcGVkIOKAlCBtYWNoaW5lIHdpbGwgbmVlZCBhIG1hbnVhbCBsb2dpbiBhZnRlciByZWJvb3QgdG8gcmVzdW1lIE9jdGFTcGFjZSIgIldBUk4iCiAgICAgICAgU2V0LVN0ZXAgIkF1dG8tbG9naW4iICJTS0lQIiAiU2tpcHBlZCDigJQgR1BVIGdvZXMgb2ZmbGluZSBhZnRlciB1bmF0dGVuZGVkIHJlYm9vdHMiCiAgICB9CgogICAgIyDilIDilIAgQ2xlYW51cCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAgIHNjaHRhc2tzIC9kZWxldGUgL3RuICRUQVNLX05BTUUgL2YgMj4kbnVsbCB8IE91dC1OdWxsCiAgICBSZW1vdmUtSXRlbSAkUEhBU0VfRklMRSAtRXJyb3JBY3Rpb24gU2lsZW50bHlDb250aW51ZQoKICAgICMg4pSA4pSAIFN1bW1hcnkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgICAjIFdyaXRlIGZpbmFsIGRpYWdub3N0aWNzIHNuYXBzaG90IHRvIGxvZyAoc2NyZWVuIG91dHB1dCBpcyB0aGUgY2xlYW4gc3VtbWFyeSBiZWxvdykKICAgIFNob3ctRGlhZ25vc3RpY3MgLUxvZ09ubHkKCiAgICBTaG93LUJhbm5lciAiU2V0dXAgQ29tcGxldGUiCiAgICBXcml0ZS1Ib3N0ICIgIFlvdXIgR1BVIGlzIG5vdyBlYXJuaW5nIHZpYSBQdWxzZSArIE9jdGFTcGFjZS4iIC1Gb3JlZ3JvdW5kQ29sb3IgR3JlZW4KICAgIFdyaXRlLUhvc3QgIiIKICAgIEAoCiAgICAgICAgQHsgTCA9ICJHUFUiOyAgICAgICAgICBWID0gJGdwdU5hbWUgfSwKICAgICAgICBAeyBMID0gIlZSQU0iOyAgICAgICAgIFYgPSAiJHt2cmFtR2J9IEdCIiB9LAogICAgICAgIEB7IEwgPSAiUGxhdGZvcm0iOyAgICAgViA9ICJPY3RhU3BhY2UgKHZpYSBQdWxzZSkiIH0sCiAgICAgICAgQHsgTCA9ICJOb2RlIHRva2VuIjsgICBWID0gaWYgKCRvY3RhTm9kZVRva2VuKSB7ICRvY3RhTm9kZVRva2VuIH0gZWxzZSB7ICJQZW5kaW5nIOKAlCBjaGVjayBjdWJlLm9jdGEuY29tcHV0ZXIiIH0gfSwKICAgICAgICBAeyBMID0gIldTTCBrZWVwYWxpdmUiOyBWID0gIkFjdGl2ZSAod2F0Y2hkb2cgcnVubmluZykiIH0sCiAgICAgICAgQHsgTCA9ICJBdXRvLXN0YXJ0IjsgICBWID0gIk9uIGV2ZXJ5IFdpbmRvd3MgbG9naW4iIH0sCiAgICAgICAgQHsgTCA9ICJMb2dzIjsgICAgICAgICBWID0gJExPR19GSUxFIH0KICAgICkgfCBGb3JFYWNoLU9iamVjdCB7IFdyaXRlLUhvc3QgKCIgIHswLC0xNn0gezF9IiAtZiAkXy5MLCAkXy5WKSAtRm9yZWdyb3VuZENvbG9yIFdoaXRlIH0KICAgIFdyaXRlLUhvc3QgIiIKICAgIFdyaXRlLUhvc3QgIiAgRGFzaGJvYXJkOiAgaHR0cHM6Ly9iZW5lZmljaWFsLWRlZXAtd29yay1mbG93LmJhc2U0NC5hcHAiIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbgogICAgV3JpdGUtSG9zdCAiICBDdWJlOiAgICAgICBodHRwczovL2N1YmUub2N0YS5jb21wdXRlciIgLUZvcmVncm91bmRDb2xvciBDeWFuCiAgICBXcml0ZS1Ib3N0ICIiCiAgICBXcml0ZS1Ib3N0ICIgIOKUjOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUkCIgLUZvcmVncm91bmRDb2xvciBEYXJrR3JheQogICAgV3JpdGUtSG9zdCAiICDilIIgIElOU1RBTEwgTE9HICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBEYXJrR3JheQogICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBEYXJrR3JheQogICAgV3JpdGUtSG9zdCAiICDilIIgIEEgZnVsbCBsb2cgb2YgZXZlcnkgaW5zdGFsbCBzdGVwIHdhcyBzYXZlZCB0bzogICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBEYXJrR3JheQogICAgV3JpdGUtSG9zdCAoIiAg4pSCICAgIHswLC02MH3ilIIiIC1mICRMT0dfRklMRSkgLUZvcmVncm91bmRDb2xvciBXaGl0ZQogICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBEYXJrR3JheQogICAgV3JpdGUtSG9zdCAiICDilIIgIFRvIG9wZW4gaXQ6ICAgbm90ZXBhZCBgIiRMT0dfRklMRWAiIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5CiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgVG8gYnJvd3NlOiAgICBSdW4g4oaSICVMT0NBTEFQUERBVEElXFB1bHNlICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkKICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkKICAgIFdyaXRlLUhvc3QgIiAg4pSCICBTaGFyZSBpdCB3aXRoIFB1bHNlIHN1cHBvcnQgaWYgYW55dGhpbmcgbG9va3Mgd3JvbmcuICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkKICAgIFdyaXRlLUhvc3QgIiAg4pSU4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSYIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5CiAgICBXcml0ZS1Ib3N0ICIiCiAgICBXYWl0LUZvcktleQp9CgojIOKUgOKUgCBFbnRyeSBQb2ludCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCnRyYXAgewogICAgV3JpdGUtSG9zdCAiIgogICAgV3JpdGUtSG9zdCAiICBbRVJST1JdIEFuIHVuZXhwZWN0ZWQgZXJyb3Igc3RvcHBlZCB0aGUgaW5zdGFsbGVyOiIgLUZvcmVncm91bmRDb2xvciBSZWQKICAgIFdyaXRlLUhvc3QgIiAgJF8iIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkCiAgICBVcGxvYWQtSW5zdGFsbExvZyAidW5leHBlY3RlZF9lcnJvciIKICAgIFNob3ctRGlhZ25vc3RpY3MKICAgIFJlYWQtSG9zdCAiICBQcmVzcyBFbnRlciB0byBjbG9zZSB0aGlzIHdpbmRvdyIKICAgIGV4aXQgMQp9CgpBc3NlcnQtQWRtaW4KTmV3LUl0ZW0gLUl0ZW1UeXBlIERpcmVjdG9yeSAtRm9yY2UgLVBhdGggJFBVTFNFX0RJUiB8IE91dC1OdWxsCgokcGhhc2UgPSBpZiAoVGVzdC1QYXRoICRQSEFTRV9GSUxFKSB7IEdldC1Db250ZW50ICRQSEFTRV9GSUxFIH0gZWxzZSB7ICIxIiB9CnN3aXRjaCAoJHBoYXNlKSB7CiAgICAiMSIgICAgIHsgSW52b2tlLVBoYXNlMSB9CiAgICAiMiIgICAgIHsgSW52b2tlLVBoYXNlMiB9CiAgICBkZWZhdWx0IHsgV3JpdGUtSG9zdCAiVW5rbm93biBwaGFzZTogJHBoYXNlIiAtRm9yZWdyb3VuZENvbG9yIFJlZDsgV2FpdC1Gb3JLZXk7IGV4aXQgMSB9Cn0K';
const OCTA_PS1 = b64ToStr(OCTA_PS1_B64);

// ── BAT launcher wrapper ──────────────────────────────────────────────────────
function makeSelfExtractingBat(ps1Filename: string, ps1Content: string): string {
  const marker = '__PULSE_PS1__';
  return `@echo off
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
echo     Step 1 ^| If you see "Windows protected your PC"
echo              click "More info" then "Run anyway"
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
set "PS1_PATH=%PULSE_DIR%\\${ps1Filename}"

if not exist "%PULSE_DIR%" mkdir "%PULSE_DIR%"

echo   Extracting setup script...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=[IO.File]::ReadAllText('%~f0',[Text.Encoding]::UTF8); $m='${marker}'; $i=$c.LastIndexOf($m); if($i-lt 0){exit 1}; [IO.File]::WriteAllText('%PS1_PATH%',$c.Substring($i+$m.Length).TrimStart(),[Text.Encoding]::UTF8)"

if not exist "%PS1_PATH%" (
    echo.
    echo   ERROR: Could not extract setup script. Re-download from the Pulse dashboard.
    echo.
    pause
    exit /b 1
)

echo   Launching installer...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -NoExit -File "%PS1_PATH%"
goto :eof

${marker}
${ps1Content}`;
}

// ── Inject placeholders ───────────────────────────────────────────────────────
function inject(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, v);
  }
  return out;
}

// ── Handler ───────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  let body: Record<string, string> = {};
  try { body = await req.json(); } catch { /* no body */ }

  const platform = (body.platform ?? 'clore').toLowerCase();
  const format   = (body.format   ?? 'bat').toLowerCase();  // 'ps1' | 'bat'
  const userToken = body.user_token ?? '';
  const appId     = Deno.env.get('BASE44_APP_ID') ?? '';

  const vars: Record<string, string> = {
    PULSE_USER_TOKEN:    userToken,
    PULSE_APP_ID:        appId,
    CLOREAI_FLEET_TOKEN: CLOREAI_FLEET_TOKEN,
    OCTASPACE_API_KEY:   OCTASPACE_API_KEY,
  };

  let ps1Source: string;
  let ps1Filename: string;
  let batFilename: string;

  if (platform === 'octaspace') {
    ps1Source   = inject(OCTA_PS1, vars);
    ps1Filename = 'pulse-octa-setup.ps1';
    batFilename = 'pulse-octa-setup.bat';
  } else {
    ps1Source   = inject(CLORE_PS1, vars);
    ps1Filename = 'pulse-clore-setup.ps1';
    batFilename = 'pulse-clore-setup.bat';
  }

  if (format === 'ps1') {
    return new Response(ps1Source, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${ps1Filename}"`,
      },
    });
  }

  // Default: return self-extracting .bat with PS1 embedded after __PULSE_PS1__ marker
  const batContent = makeSelfExtractingBat(ps1Filename, ps1Source);
  return new Response(batContent, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${batFilename}"`,
    },
  });
});
