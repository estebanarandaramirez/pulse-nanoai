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
$WATCHDOG_TASK   = "PulseGPUWatchdog"
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
        Wait-ForKey; exit 1
    }
    Write-Log "Windows build $build — OK" "OK"

    $gpu = (Get-WmiObject Win32_VideoController |
        Where-Object { $_.Name -match "NVIDIA|GeForce|RTX|GTX|AMD|Radeon" } |
        Select-Object -First 1).Name
    if (-not $gpu) {
        Write-Log "No supported GPU detected. Pulse requires an NVIDIA or AMD GPU." "ERROR"
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

    $watchdog = @'
$wdLog = "$env:LOCALAPPDATA\Pulse\watchdog.log"
$keepalivePid = $null

function Ensure-WSLAlive {
    if ($null -eq $keepalivePid -or -not (Get-Process -Id $keepalivePid -ErrorAction SilentlyContinue)) {
        $p = Start-Process "wsl.exe" -ArgumentList "-d Ubuntu-22.04 --user root -- bash -c 'while true; do sleep 3600; done'" -PassThru -WindowStyle Hidden -ErrorAction SilentlyContinue
        if ($p) {
            $script:keepalivePid = $p.Id
            Add-Content $wdLog "$(Get-Date -f 'yyyy-MM-dd HH:mm') WSL keepalive started (PID $($p.Id))"
        }
    }
}

Ensure-WSLAlive
Add-Content $wdLog "$(Get-Date -f 'yyyy-MM-dd HH:mm') Watchdog started"

while ($true) {
    try { Ensure-WSLAlive } catch {}
    Start-Sleep 30
}
'@
    $watchdogPath = "$PULSE_DIR\\watchdog.ps1"
    Set-Content -Path $watchdogPath -Value $watchdog -Encoding UTF8
    $wA = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \`"$watchdogPath\`""
    $wT = New-ScheduledTaskTrigger -AtLogOn
    $wS = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -ExecutionTimeLimit 0
    $wP = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Highest
    Register-ScheduledTask -TaskName $WATCHDOG_TASK -Action $wA -Trigger $wT -Settings $wS -Principal $wP -Force | Out-Null
    Write-Log "WSL keepalive watchdog installed" "OK"

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
const OCTA_PS1_B64 = 'I1JlcXVpcmVzIC1WZXJzaW9uIDUuMQo8IwouU1lOT1BTSVMKICAgIFBVTFNFIEdQVSBQcm92aWRlciBTZXR1cCDigJQgT2N0YVNwYWNlIEluc3RhbGxlcgouREVTQ1JJUFRJT04KICAgIFBoYXNlIDE6IEVuYWJsZXMgV1NMMiwgc2NoZWR1bGVzIFBoYXNlIDIgdG8gcnVuIGFmdGVyIHJlYm9vdC4KICAgIFBoYXNlIDI6IEluc3RhbGxzIFVidW50dSwgT2N0YVNwYWNlIG5vZGUgKG9zbiksIHNldHMgdXAgbmV0d29ya2luZwogICAgICAgICAgICAgKFVQblAgKyBwb3J0cHJveHkgZm9yIFRDUCwgbWlycm9yZWQgbmV0d29ya2luZyByZWNvbW1lbmRlZCBmb3IgVURQKSwKICAgICAgICAgICAgIEdQVSBnYW1pbmcgZGV0ZWN0aW9uLCBhbmQgYXV0by1zdGFydC4KCiAgICBFbWJlZGRlZCBhdCBkb3dubG9hZCB0aW1lIGJ5IFB1bHNlJ3MgZ2VuZXJhdGVTZXR1cFNjcmlwdCBmdW5jdGlvbjoKICAgICAgUFVMU0VfVVNFUl9UT0tFTiDigJQgdXNlcidzIHNlc3Npb24gdG9rZW4gZm9yIFB1bHNlIEFQSSBjYWxsYmFjawogICAgICBQVUxTRV9BUFBfSUQgICAgIOKAlCBiYXNlNDQgYXBwIElECiM+CgojIOKUgOKUgCBFbWJlZGRlZCBieSBzZXJ2ZXIgYXQgZG93bmxvYWQgdGltZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKJFBVTFNFX1VTRVJfVE9LRU4gPSAie3tQVUxTRV9VU0VSX1RPS0VOfX0iCiRQVUxTRV9BUFBfSUQgICAgID0gInt7UFVMU0VfQVBQX0lEfX0iCiRQVUxTRV9BUElfQkFTRSAgID0gImh0dHBzOi8vYXBpLmJhc2U0NC5hcHAvYXBpL2FwcHMvJFBVTFNFX0FQUF9JRC9mdW5jdGlvbnMiCiMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgokUFVMU0VfRElSICAgICAgPSAiJGVudjpMT0NBTEFQUERBVEFcUHVsc2UiCiRQSEFTRV9GSUxFICAgICA9ICIkUFVMU0VfRElSXG9jdGFfc2V0dXBfcGhhc2UiCiRMT0dfRklMRSAgICAgICA9ICIkUFVMU0VfRElSXG9jdGFfc2V0dXAubG9nIgokVEFTS19OQU1FICAgICAgPSAiUHVsc2VPY3RhU2V0dXBSZXN1bWUiCiRXQVRDSERPR19UQVNLICA9ICJQdWxzZU9jdGFXYXRjaGRvZyIKJEFVVE9TVEFSVF9UQVNLID0gIlB1bHNlT2N0YUF1dG9TdGFydCIKCiMgT2N0YVNwYWNlIHBvcnRzIOKAlCBtYW5hZ2VtZW50IChBUEkpIGFuZCBlbmNyeXB0ZWQgdHVubmVsIHJhbmdlIChUQ1ArVURQKQokT0NUQV9NR01UX1BPUlRTICAgICA9IEAoMTg4ODgpCiRPQ1RBX0FQUF9QT1JUX1NUQVJUID0gNTE4MDAKJE9DVEFfQVBQX1BPUlRfRU5EICAgPSA1MTgxNgoKIyDilIDilIAgSGVscGVycyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCmZ1bmN0aW9uIFdyaXRlLUxvZyB7CiAgICBwYXJhbShbc3RyaW5nXSRtc2csIFtzdHJpbmddJGxldmVsID0gIklORk8iKQogICAgJHRzID0gR2V0LURhdGUgLUZvcm1hdCAiSEg6bW06c3MiCiAgICBBZGQtQ29udGVudCAtUGF0aCAkTE9HX0ZJTEUgLVZhbHVlICJbJHRzXVskbGV2ZWxdICRtc2ciIC1FbmNvZGluZyBVVEY4CiAgICBzd2l0Y2ggKCRsZXZlbCkgewogICAgICAgICJPSyIgICAgeyBXcml0ZS1Ib3N0ICIgIFtPS10gJG1zZyIgLUZvcmVncm91bmRDb2xvciBHcmVlbiB9CiAgICAgICAgIldBUk4iICB7IFdyaXRlLUhvc3QgIiAgWyEhXSAkbXNnIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdyB9CiAgICAgICAgIkVSUk9SIiB7IFdyaXRlLUhvc3QgIiAgW1hdICAkbXNnIiAtRm9yZWdyb3VuZENvbG9yIFJlZCB9CiAgICAgICAgZGVmYXVsdCB7IFdyaXRlLUhvc3QgIiAgLi4uICRtc2ciIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbiB9CiAgICB9Cn0KCmZ1bmN0aW9uIFNob3ctQmFubmVyIHsKICAgIHBhcmFtKFtzdHJpbmddJHN1YnRpdGxlID0gIiIpCiAgICBDbGVhci1Ib3N0CiAgICBXcml0ZS1Ib3N0ICIiCiAgICBXcml0ZS1Ib3N0ICIgIOKWiOKWiOKWiOKWiOKWiOKWiOKVlyDilojilojilZcgICDilojilojilZfilojilojilZcgICAgIOKWiOKWiOKWiOKWiOKWiOKWiOKWiOKVl+KWiOKWiOKWiOKWiOKWiOKWiOKWiOKVlyIgLUZvcmVncm91bmRDb2xvciBNYWdlbnRhCiAgICBXcml0ZS1Ib3N0ICIgIOKWiOKWiOKVlOKVkOKVkOKWiOKWiOKVl+KWiOKWiOKVkSAgIOKWiOKWiOKVkeKWiOKWiOKVkSAgICAg4paI4paI4pWU4pWQ4pWQ4pWQ4pWQ4pWd4paI4paI4pWU4pWQ4pWQ4pWQ4pWQ4pWdIiAtRm9yZWdyb3VuZENvbG9yIE1hZ2VudGEKICAgIFdyaXRlLUhvc3QgIiAg4paI4paI4paI4paI4paI4paI4pWU4pWd4paI4paI4pWRICAg4paI4paI4pWR4paI4paI4pWRICAgICDilojilojilojilojilojilojilojilZfilojilojilojilojilojilZcgICIgLUZvcmVncm91bmRDb2xvciBNYWdlbnRhCiAgICBXcml0ZS1Ib3N0ICIgIOKWiOKWiOKVlOKVkOKVkOKVkOKVnSDilojilojilZEgICDilojilojilZHilojilojilZEgICAgIOKVmuKVkOKVkOKVkOKVkOKWiOKWiOKVkeKWiOKWiOKVlOKVkOKVkOKVnSAgIiAtRm9yZWdyb3VuZENvbG9yIE1hZ2VudGEKICAgIFdyaXRlLUhvc3QgIiAg4paI4paI4pWRICAgICDilZrilojilojilojilojilojilojilZTilZ3ilojilojilojilojilojilojilojilZfilojilojilojilojilojilojilojilZHilojilojilojilojilojilojilojilZciIC1Gb3JlZ3JvdW5kQ29sb3IgTWFnZW50YQogICAgV3JpdGUtSG9zdCAiICDilZrilZDilZ0gICAgICDilZrilZDilZDilZDilZDilZDilZ0g4pWa4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWd4pWa4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWd4pWa4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWdIiAtRm9yZWdyb3VuZENvbG9yIE1hZ2VudGEKICAgIFdyaXRlLUhvc3QgIiIKICAgIFdyaXRlLUhvc3QgIiAgR1BVIFByb3ZpZGVyIFNldHVwIOKAlCBPY3RhU3BhY2UiIC1Gb3JlZ3JvdW5kQ29sb3IgV2hpdGUKICAgIGlmICgkc3VidGl0bGUpIHsgV3JpdGUtSG9zdCAiICAkc3VidGl0bGUiIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkgfQogICAgV3JpdGUtSG9zdCAiIgp9CgpmdW5jdGlvbiBBc3NlcnQtQWRtaW4gewogICAgaWYgKC1ub3QgKFtTZWN1cml0eS5QcmluY2lwYWwuV2luZG93c1ByaW5jaXBhbF1bU2VjdXJpdHkuUHJpbmNpcGFsLldpbmRvd3NJZGVudGl0eV06OkdldEN1cnJlbnQoKSkuSXNJblJvbGUoCiAgICAgICAgW1NlY3VyaXR5LlByaW5jaXBhbC5XaW5kb3dzQnVpbHRJblJvbGVdOjpBZG1pbmlzdHJhdG9yKSkgewogICAgICAgIFdyaXRlLUhvc3QgIiAgUmVsYXVuY2hpbmcgYXMgQWRtaW5pc3RyYXRvci4uLiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgICAgICBTdGFydC1Qcm9jZXNzIHBvd2Vyc2hlbGwgIi1Ob1Byb2ZpbGUgLUV4ZWN1dGlvblBvbGljeSBCeXBhc3MgLUZpbGUgYCIkUFNDb21tYW5kUGF0aGAiIiAtVmVyYiBSdW5BcwogICAgICAgIGV4aXQKICAgIH0KfQoKZnVuY3Rpb24gV2FpdC1Gb3JLZXkgewogICAgV3JpdGUtSG9zdCAiIgogICAgUmVhZC1Ib3N0ICIgIFByZXNzIEVudGVyIHRvIGNsb3NlIHRoaXMgd2luZG93Igp9CgojIOKUgOKUgCBEaWFnbm9zdGljcyBjaGVja2xpc3Qg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiRzY3JpcHQ6U3RlcHMgPSBbb3JkZXJlZF1Ae30KCmZ1bmN0aW9uIFJlZ2lzdGVyLVN0ZXAgewogICAgcGFyYW0oW3N0cmluZ10kbmFtZSwgW3N0cmluZ10kZml4ID0gIiIpCiAgICAkc2NyaXB0OlN0ZXBzWyRuYW1lXSA9IEB7IFN0YXR1cyA9ICJQRU5ESU5HIjsgRGV0YWlsID0gIiI7IEZpeCA9ICRmaXggfQp9CgpmdW5jdGlvbiBTZXQtU3RlcCB7CiAgICBwYXJhbShbc3RyaW5nXSRuYW1lLCBbc3RyaW5nXSRzdGF0dXMsIFtzdHJpbmddJGRldGFpbCA9ICIiKQogICAgaWYgKCRzY3JpcHQ6U3RlcHMuQ29udGFpbnMoJG5hbWUpKSB7CiAgICAgICAgJHNjcmlwdDpTdGVwc1skbmFtZV0uU3RhdHVzID0gJHN0YXR1cwogICAgICAgIGlmICgkZGV0YWlsKSB7ICRzY3JpcHQ6U3RlcHNbJG5hbWVdLkRldGFpbCA9ICRkZXRhaWwgfQogICAgfQp9CgpmdW5jdGlvbiBTaG93LURpYWdub3N0aWNzIHsKICAgIHBhcmFtKFtzd2l0Y2hdJExvZ09ubHkpCiAgICAkc2VwICAgID0gIiAgIiArICgi4pSAIiAqIDY1KQogICAgJGxvZ1NlcCA9ICLilIAiICogNjcKICAgICR0cyAgICAgPSBHZXQtRGF0ZSAtRm9ybWF0ICJ5eXl5LU1NLWRkIEhIOm1tOnNzIgoKICAgIGlmICgtbm90ICRMb2dPbmx5KSB7CiAgICAgICAgV3JpdGUtSG9zdCAiIgogICAgICAgIFdyaXRlLUhvc3QgJHNlcCAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5CiAgICAgICAgV3JpdGUtSG9zdCAiICBJTlNUQUxMIERJQUdOT1NUSUNTIiAtRm9yZWdyb3VuZENvbG9yIFdoaXRlCiAgICAgICAgV3JpdGUtSG9zdCAkc2VwIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkKICAgIH0KCiAgICBBZGQtQ29udGVudCAtUGF0aCAkTE9HX0ZJTEUgLVZhbHVlICIiIC1FbmNvZGluZyBVVEY4CiAgICBBZGQtQ29udGVudCAtUGF0aCAkTE9HX0ZJTEUgLVZhbHVlICRsb2dTZXAgLUVuY29kaW5nIFVURjgKICAgIEFkZC1Db250ZW50IC1QYXRoICRMT0dfRklMRSAtVmFsdWUgIklOU1RBTEwgRElBR05PU1RJQ1MgICR0cyIgLUVuY29kaW5nIFVURjgKICAgIEFkZC1Db250ZW50IC1QYXRoICRMT0dfRklMRSAtVmFsdWUgJGxvZ1NlcCAtRW5jb2RpbmcgVVRGOAoKICAgIGZvcmVhY2ggKCRuYW1lIGluICRzY3JpcHQ6U3RlcHMuS2V5cykgewogICAgICAgICRzICAgICA9ICRzY3JpcHQ6U3RlcHNbJG5hbWVdCiAgICAgICAgJGljb24gID0gc3dpdGNoICgkcy5TdGF0dXMpIHsgIlBBU1MiIHsiW09LXSJ9ICJGQUlMIiB7IltYXSAifSAiV0FSTiIgeyJbISFdIn0gIlNLSVAiIHsiWy0tXSJ9IGRlZmF1bHQgeyJbICBdIn0gfQogICAgICAgICRjb2xvciA9IHN3aXRjaCAoJHMuU3RhdHVzKSB7ICJQQVNTIiB7IkdyZWVuIn0gIkZBSUwiIHsiUmVkIn0gIldBUk4iIHsiWWVsbG93In0gIlNLSVAiIHsiRGFya0dyYXkifSBkZWZhdWx0IHsiRGFya0dyYXkifSB9CgogICAgICAgIGlmICgkcy5TdGF0dXMgLWVxICJQRU5ESU5HIikgewogICAgICAgICAgICBpZiAoLW5vdCAkTG9nT25seSkgeyBXcml0ZS1Ib3N0ICgiICB7MH0gezEsLTU1fSB7Mn0iIC1mICRpY29uLCAkbmFtZSwgIihub3QgcmVhY2hlZCkiKSAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5IH0KICAgICAgICAgICAgQWRkLUNvbnRlbnQgLVBhdGggJExPR19GSUxFIC1WYWx1ZSAoIiAgJGljb24gJG5hbWUgIChub3QgcmVhY2hlZCkiKSAtRW5jb2RpbmcgVVRGOAogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICAgIGlmICgtbm90ICRMb2dPbmx5KSB7CiAgICAgICAgICAgICAgICBXcml0ZS1Ib3N0ICIgICRpY29uICRuYW1lIiAtRm9yZWdyb3VuZENvbG9yICRjb2xvcgogICAgICAgICAgICAgICAgaWYgKCRzLkRldGFpbCkgeyBXcml0ZS1Ib3N0ICIgICAgICAgJCgkcy5EZXRhaWwpIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5IH0KICAgICAgICAgICAgICAgIGlmICgkcy5TdGF0dXMgLWVxICJGQUlMIiAtYW5kICRzLkZpeCkgeyBXcml0ZS1Ib3N0ICIgICAgICAgRml4OiAkKCRzLkZpeCkiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93IH0KICAgICAgICAgICAgfQogICAgICAgICAgICBBZGQtQ29udGVudCAtUGF0aCAkTE9HX0ZJTEUgLVZhbHVlICIgICRpY29uICRuYW1lIiAtRW5jb2RpbmcgVVRGOAogICAgICAgICAgICBpZiAoJHMuRGV0YWlsKSB7IEFkZC1Db250ZW50IC1QYXRoICRMT0dfRklMRSAtVmFsdWUgIiAgICAgICAkKCRzLkRldGFpbCkiIC1FbmNvZGluZyBVVEY4IH0KICAgICAgICAgICAgaWYgKCRzLlN0YXR1cyAtZXEgIkZBSUwiIC1hbmQgJHMuRml4KSB7IEFkZC1Db250ZW50IC1QYXRoICRMT0dfRklMRSAtVmFsdWUgIiAgICAgICBGaXg6ICQoJHMuRml4KSIgLUVuY29kaW5nIFVURjggfQogICAgICAgIH0KICAgIH0KCiAgICBBZGQtQ29udGVudCAtUGF0aCAkTE9HX0ZJTEUgLVZhbHVlICRsb2dTZXAgLUVuY29kaW5nIFVURjgKCiAgICBpZiAoLW5vdCAkTG9nT25seSkgewogICAgICAgIFdyaXRlLUhvc3QgJHNlcCAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5CiAgICAgICAgV3JpdGUtSG9zdCAiICBGdWxsIGxvZzogJExPR19GSUxFIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5CiAgICAgICAgV3JpdGUtSG9zdCAiICBTaGFyZSB3aXRoIFB1bHNlIHN1cHBvcnQgYXQgcHVsc2VuYW5vYWkuY29tIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5CiAgICAgICAgV3JpdGUtSG9zdCAiIgogICAgfQp9CiMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgpmdW5jdGlvbiBHZXQtTG9jYWxJUCB7CiAgICAoR2V0LU5ldElQQWRkcmVzcyAtQWRkcmVzc0ZhbWlseSBJUHY0IHwKICAgICAgICBXaGVyZS1PYmplY3QgeyAkXy5JbnRlcmZhY2VBbGlhcyAtbm90bWF0Y2ggIkxvb3BiYWNrfFdTTHx2RXRoZXJuZXQiIH0gfAogICAgICAgIFNlbGVjdC1PYmplY3QgLUZpcnN0IDEpLklQQWRkcmVzcwp9CgpmdW5jdGlvbiBTZXQtV1NMMlBvcnRQcm94eSB7CiAgICBwYXJhbShbc3RyaW5nXSRXc2xJUCkKICAgICMgVENQIG9ubHkg4oCUIHBvcnRwcm94eSBkb2VzIG5vdCBzdXBwb3J0IFVEUC4gVURQIHR1bm5lbCBwb3J0cyAoNTE4MDAtNTE4MTYpCiAgICAjIHJlcXVpcmUgbWlycm9yZWQgbmV0d29ya2luZyBvbiBXaW5kb3dzIDExIDIySDIrIHRvIGZ1bmN0aW9uIGNvcnJlY3RseS4KICAgICRhbGxQb3J0cyA9ICRPQ1RBX01HTVRfUE9SVFMgKyAoJE9DVEFfQVBQX1BPUlRfU1RBUlQuLiRPQ1RBX0FQUF9QT1JUX0VORCkKICAgIGZvcmVhY2ggKCRwIGluICRhbGxQb3J0cykgewogICAgICAgIG5ldHNoIGludGVyZmFjZSBwb3J0cHJveHkgZGVsZXRlIHY0dG92NCBsaXN0ZW5wb3J0PSRwIGxpc3RlbmFkZHJlc3M9MC4wLjAuMCB8IE91dC1OdWxsCiAgICAgICAgbmV0c2ggaW50ZXJmYWNlIHBvcnRwcm94eSBhZGQgdjR0b3Y0IGxpc3RlbnBvcnQ9JHAgbGlzdGVuYWRkcmVzcz0wLjAuMC4wIGAKICAgICAgICAgICAgY29ubmVjdHBvcnQ9JHAgY29ubmVjdGFkZHJlc3M9JFdzbElQIHwgT3V0LU51bGwKICAgIH0KICAgIFdyaXRlLUxvZyAiV1NMMiBwb3J0cHJveHkgKFRDUCk6ICQoJE9DVEFfTUdNVF9QT1JUUyAtam9pbiAnLCcpICsgJE9DVEFfQVBQX1BPUlRfU1RBUlQtJE9DVEFfQVBQX1BPUlRfRU5EIOKGkiAkV3NsSVAiICJPSyIKICAgIFdyaXRlLUxvZyAiTk9URTogVURQIHBvcnRzICRPQ1RBX0FQUF9QT1JUX1NUQVJULSRPQ1RBX0FQUF9QT1JUX0VORCBuZWVkIG1pcnJvcmVkIG5ldHdvcmtpbmcgZm9yIGZ1bGwgdHVubmVsIHN1cHBvcnQiICJXQVJOIgp9CgojIOKUgOKUgCBQaGFzZSAxOiBFbmFibGUgV1NMMiArIHNjaGVkdWxlIFBoYXNlIDIgYWZ0ZXIgcmVib290IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKZnVuY3Rpb24gSW52b2tlLVBoYXNlMSB7CiAgICBTaG93LUJhbm5lciAiUGhhc2UgMSBvZiAyIOKAlCBFbmFibGluZyBXU0wyIgoKICAgICRzY3JpcHQ6U3RlcHMgPSBbb3JkZXJlZF1Ae30KICAgIFJlZ2lzdGVyLVN0ZXAgIldpbmRvd3MgY29tcGF0aWJpbGl0eSAoYnVpbGQgMTkwNDErKSIKICAgIFJlZ2lzdGVyLVN0ZXAgIkdQVSBkZXRlY3RlZCIKICAgIFJlZ2lzdGVyLVN0ZXAgIlZpcnR1YWxpemF0aW9uIGVuYWJsZWQgaW4gQklPUyIKICAgIFJlZ2lzdGVyLVN0ZXAgIldTTDIgZmVhdHVyZXMgZW5hYmxlZCIKICAgIFJlZ2lzdGVyLVN0ZXAgIldTTDIga2VybmVsIHVwZGF0ZSIKICAgIFJlZ2lzdGVyLVN0ZXAgIlBoYXNlIDIgcmVzdW1lIHRhc2siCgogICAgJGJ1aWxkID0gW1N5c3RlbS5FbnZpcm9ubWVudF06Ok9TVmVyc2lvbi5WZXJzaW9uLkJ1aWxkCiAgICBpZiAoJGJ1aWxkIC1sdCAxOTA0MSkgewogICAgICAgIFNldC1TdGVwICJXaW5kb3dzIGNvbXBhdGliaWxpdHkgKGJ1aWxkIDE5MDQxKykiICJGQUlMIiAiQnVpbGQgJGJ1aWxkIOKAlCByZXF1aXJlcyAxOTA0MSAoV2luZG93cyAxMCAyMDA0KykiCiAgICAgICAgV3JpdGUtTG9nICJXaW5kb3dzIGJ1aWxkICRidWlsZCBpcyB0b28gb2xkLiBXU0wyIHJlcXVpcmVzIGJ1aWxkIDE5MDQxKyAoV2luZG93cyAxMCAyMDA0KykuIiAiRVJST1IiCiAgICAgICAgU2hvdy1EaWFnbm9zdGljczsgV2FpdC1Gb3JLZXk7IGV4aXQgMQogICAgfQogICAgV3JpdGUtTG9nICJXaW5kb3dzIGJ1aWxkICRidWlsZCDigJQgT0siICJPSyIKICAgIFNldC1TdGVwICJXaW5kb3dzIGNvbXBhdGliaWxpdHkgKGJ1aWxkIDE5MDQxKykiICJQQVNTIiAiQnVpbGQgJGJ1aWxkIgoKICAgICRncHUgPSAoR2V0LVdtaU9iamVjdCBXaW4zMl9WaWRlb0NvbnRyb2xsZXIgfAogICAgICAgIFdoZXJlLU9iamVjdCB7ICRfLk5hbWUgLW1hdGNoICJOVklESUF8R2VGb3JjZXxSVFh8R1RYfEFNRHxSYWRlb24iIH0gfAogICAgICAgIFNlbGVjdC1PYmplY3QgLUZpcnN0IDEpLk5hbWUKICAgIGlmICgtbm90ICRncHUpIHsKICAgICAgICBTZXQtU3RlcCAiR1BVIGRldGVjdGVkIiAiRkFJTCIgIk5vIE5WSURJQS9BTUQgR1BVIGZvdW5kIgogICAgICAgIFdyaXRlLUxvZyAiTm8gc3VwcG9ydGVkIEdQVSBkZXRlY3RlZC4gUHVsc2UgcmVxdWlyZXMgYW4gTlZJRElBIG9yIEFNRCBHUFUuIiAiRVJST1IiCiAgICAgICAgU2hvdy1EaWFnbm9zdGljczsgV2FpdC1Gb3JLZXk7IGV4aXQgMQogICAgfQogICAgV3JpdGUtTG9nICJHUFU6ICRncHUiICJPSyIKICAgIFNldC1TdGVwICJHUFUgZGV0ZWN0ZWQiICJQQVNTIiAkZ3B1CgogICAgTmV3LUl0ZW0gLUl0ZW1UeXBlIERpcmVjdG9yeSAtRm9yY2UgLVBhdGggJFBVTFNFX0RJUiB8IE91dC1OdWxsCgogICAgJHZpcnRFbmFibGVkID0gKEdldC1Db21wdXRlckluZm8pLkh5cGVyVlJlcXVpcmVtZW50VmlydHVhbGl6YXRpb25GaXJtd2FyZUVuYWJsZWQKICAgIGlmICgkdmlydEVuYWJsZWQgLWVxICRmYWxzZSkgewogICAgICAgIFNldC1TdGVwICJWaXJ0dWFsaXphdGlvbiBlbmFibGVkIGluIEJJT1MiICJGQUlMIiAiRGlzYWJsZWQg4oCUIHNlZSBCSU9TIGluc3RydWN0aW9ucyBiZWxvdyIKICAgICAgICBXcml0ZS1Mb2cgIkhhcmR3YXJlIHZpcnR1YWxpemF0aW9uIGlzIGRpc2FibGVkIGluIHlvdXIgQklPUy9VRUZJLiIgIkVSUk9SIgogICAgICAgIFdyaXRlLUhvc3QgIiIKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUjOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUkCIgLUZvcmVncm91bmRDb2xvciBSZWQKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgQUNUSU9OIFJFUVVJUkVEOiBFbmFibGUgdmlydHVhbGl6YXRpb24gaW4geW91ciBCSU9TL1VFRkkgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFJlZAogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkCiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgIDEuIFJlc3RhcnQgeW91ciBQQyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBSZWQKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgMi4gUHJlc3MgRGVsZXRlIG9yIEYyIGR1cmluZyBib290IHRvIG9wZW4gQklPUyAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkCiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgIDMuIEZpbmQ6IEFkdmFuY2VkID4gQ1BVIENvbmZpZ3VyYXRpb24gPiBTVk0gTW9kZSAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFJlZAogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAoSW50ZWwgYm9hcmRzOiBsb29rIGZvciAnSW50ZWwgVmlydHVhbGl6YXRpb24nIG9yIFZULXgpIOKUgiIgLUZvcmVncm91bmRDb2xvciBSZWQKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgNC4gU2V0IGl0IHRvIEVuYWJsZWQgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFJlZAogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICA1LiBQcmVzcyBGMTAgdG8gc2F2ZSBhbmQgZXhpdCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBSZWQKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFJlZAogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICBUaGVuIHJlLXJ1biB0aGlzIGluc3RhbGxlci4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkCiAgICAgICAgV3JpdGUtSG9zdCAiICDilJTilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilJgiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkCiAgICAgICAgV3JpdGUtSG9zdCAiIgogICAgICAgIFNob3ctRGlhZ25vc3RpY3M7IFdhaXQtRm9yS2V5OyBleGl0IDEKICAgIH0KICAgIFdyaXRlLUxvZyAiSGFyZHdhcmUgdmlydHVhbGl6YXRpb24gZW5hYmxlZCBpbiBCSU9TIOKAlCBPSyIgIk9LIgogICAgU2V0LVN0ZXAgIlZpcnR1YWxpemF0aW9uIGVuYWJsZWQgaW4gQklPUyIgIlBBU1MiCgogICAgV3JpdGUtTG9nICJFbmFibGluZyBXU0wyIFdpbmRvd3MgZmVhdHVyZXMuLi4iCiAgICBkaXNtLmV4ZSAvb25saW5lIC9lbmFibGUtZmVhdHVyZSAvZmVhdHVyZW5hbWU6TWljcm9zb2Z0LVdpbmRvd3MtU3Vic3lzdGVtLUxpbnV4IC9hbGwgL25vcmVzdGFydCB8IE91dC1OdWxsCiAgICBkaXNtLmV4ZSAvb25saW5lIC9lbmFibGUtZmVhdHVyZSAvZmVhdHVyZW5hbWU6VmlydHVhbE1hY2hpbmVQbGF0Zm9ybSAvYWxsIC9ub3Jlc3RhcnQgfCBPdXQtTnVsbAogICAgV3JpdGUtTG9nICJXU0wyIGZlYXR1cmVzIGVuYWJsZWQiICJPSyIKICAgIFNldC1TdGVwICJXU0wyIGZlYXR1cmVzIGVuYWJsZWQiICJQQVNTIgoKICAgIFdyaXRlLUxvZyAiSW5zdGFsbGluZyBXU0wyIGtlcm5lbCB1cGRhdGUuLi4iCiAgICAkbXNpID0gIiRlbnY6VEVNUFx3c2xfdXBkYXRlLm1zaSIKICAgIHRyeSB7CiAgICAgICAgSW52b2tlLVdlYlJlcXVlc3QgImh0dHBzOi8vd3Nsc3RvcmVzdG9yYWdlLmJsb2IuY29yZS53aW5kb3dzLm5ldC93c2xibG9iL3dzbF91cGRhdGVfeDY0Lm1zaSIgYAogICAgICAgICAgICAtT3V0RmlsZSAkbXNpIC1Vc2VCYXNpY1BhcnNpbmcKICAgICAgICBTdGFydC1Qcm9jZXNzIG1zaWV4ZWMuZXhlIC1Bcmd1bWVudExpc3QgIi9pIGAiJG1zaWAiIC9xdWlldCAvbm9yZXN0YXJ0IiAtV2FpdAogICAgICAgIFdyaXRlLUxvZyAiV1NMMiBrZXJuZWwgdXBkYXRlZCIgIk9LIgogICAgfSBjYXRjaCB7CiAgICAgICAgV3JpdGUtTG9nICJXU0wyIGtlcm5lbCBhbHJlYWR5IHVwIHRvIGRhdGUiICJPSyIKICAgIH0KICAgIFNldC1TdGVwICJXU0wyIGtlcm5lbCB1cGRhdGUiICJQQVNTIgoKICAgIHdzbCAtLXNldC1kZWZhdWx0LXZlcnNpb24gMiAyPiYxIHwgT3V0LU51bGwKCiAgICBTZXQtQ29udGVudCAtUGF0aCAkUEhBU0VfRklMRSAtVmFsdWUgIjIiIC1FbmNvZGluZyBVVEY4CgogICAgJHN0YWJsZVBhdGggPSAiJFBVTFNFX0RJUlxwdWxzZS1vY3RhLXNldHVwLnBzMSIKICAgIGlmICgkUFNDb21tYW5kUGF0aCAtbmUgJHN0YWJsZVBhdGgpIHsKICAgICAgICBDb3B5LUl0ZW0gLVBhdGggJFBTQ29tbWFuZFBhdGggLURlc3RpbmF0aW9uICRzdGFibGVQYXRoIC1Gb3JjZQogICAgfQoKICAgICRhY3Rpb24gICAgPSBOZXctU2NoZWR1bGVkVGFza0FjdGlvbiAtRXhlY3V0ZSAicG93ZXJzaGVsbC5leGUiIGAKICAgICAgICAtQXJndW1lbnQgIi1Ob1Byb2ZpbGUgLUV4ZWN1dGlvblBvbGljeSBCeXBhc3MgLVdpbmRvd1N0eWxlIE5vcm1hbCAtRmlsZSBgIiRzdGFibGVQYXRoYCIiCiAgICAkdHJpZ2dlciAgID0gTmV3LVNjaGVkdWxlZFRhc2tUcmlnZ2VyIC1BdExvZ09uCiAgICAkc2V0dGluZ3MgID0gTmV3LVNjaGVkdWxlZFRhc2tTZXR0aW5nc1NldCAtQWxsb3dTdGFydElmT25CYXR0ZXJpZXMgLURvbnRTdG9wSWZHb2luZ09uQmF0dGVyaWVzCiAgICAkcHJpbmNpcGFsID0gTmV3LVNjaGVkdWxlZFRhc2tQcmluY2lwYWwgLVVzZXJJZCAkZW52OlVTRVJOQU1FIC1SdW5MZXZlbCBIaWdoZXN0CiAgICBSZWdpc3Rlci1TY2hlZHVsZWRUYXNrIC1UYXNrTmFtZSAkVEFTS19OQU1FIC1BY3Rpb24gJGFjdGlvbiAtVHJpZ2dlciAkdHJpZ2dlciBgCiAgICAgICAgLVNldHRpbmdzICRzZXR0aW5ncyAtUHJpbmNpcGFsICRwcmluY2lwYWwgLUZvcmNlIHwgT3V0LU51bGwKICAgIFdyaXRlLUxvZyAiUGhhc2UgMiByZXN1bWUgdGFzayByZWdpc3RlcmVkIiAiT0siCiAgICBTZXQtU3RlcCAiUGhhc2UgMiByZXN1bWUgdGFzayIgIlBBU1MiCgogICAgV3JpdGUtSG9zdCAiIgogICAgV3JpdGUtSG9zdCAiICDilIzilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilJAiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgT25lIHJlYm9vdCByZXF1aXJlZCB0byBjb250aW51ZSBzZXR1cCAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgV3JpdGUtSG9zdCAiICDilIIgIFNldHVwIHdpbGwgcmVzdW1lIGF1dG9tYXRpY2FsbHkuICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgIFdyaXRlLUhvc3QgIiAg4pSU4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSYIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgV3JpdGUtSG9zdCAiIgogICAgJGFuc3dlciA9IFJlYWQtSG9zdCAiICBSZWJvb3Qgbm93PyAoWS9uKSIKICAgIGlmICgkYW5zd2VyIC1uZSAibiIpIHsgUmVzdGFydC1Db21wdXRlciAtRm9yY2UgfQogICAgZWxzZSB7IFdyaXRlLUhvc3QgIiAgUmVib290IHdoZW4gcmVhZHkuIFNldHVwIHJlc3VtZXMgb24gbmV4dCBsb2dpbi4iIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkgfQp9CgojIOKUgOKUgCBQaGFzZSAyOiBVYnVudHUgKyBPY3RhU3BhY2UgKG9zbikgKyBOZXR3b3JraW5nICsgQXV0by1zdGFydCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCmZ1bmN0aW9uIEludm9rZS1QaGFzZTIgewogICAgU2hvdy1CYW5uZXIgIlBoYXNlIDIgb2YgMiDigJQgSW5zdGFsbGluZyBPY3RhU3BhY2UgUHJvdmlkZXIgU3RhY2siCgogICAgJHNjcmlwdDpTdGVwcyA9IFtvcmRlcmVkXUB7fQogICAgUmVnaXN0ZXItU3RlcCAiVWJ1bnR1IG9uIFdTTDIiCiAgICBSZWdpc3Rlci1TdGVwICJzeXN0ZW1kIGluIFdTTDIiCiAgICBSZWdpc3Rlci1TdGVwICJXU0wyIG5ldHdvcmtpbmciCiAgICBSZWdpc3Rlci1TdGVwICJHUFUgY29tcHV0ZSBpbiBXU0wyIiAiVXBkYXRlIFdpbmRvd3MgTlZJRElBIGRyaXZlciBhdCBudmlkaWEuY29tL2RyaXZlcnMiCiAgICBSZWdpc3Rlci1TdGVwICJCdWlsZCB0b29scyAoY3VybCwgYmFzaCkiICJ3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tIGJhc2ggLWMgJ2FwdC1nZXQgdXBkYXRlICYmIGFwdC1nZXQgaW5zdGFsbCAteSBjdXJsIGJhc2gnIgogICAgUmVnaXN0ZXItU3RlcCAiT2N0YVNwYWNlIG9zbiBpbnN0YWxsZWQiICJDaGVjayBpbnN0YWxsLm9jdGEuc3BhY2Ugb3IgT2N0YVNwYWNlIGRvY3MiCiAgICBSZWdpc3Rlci1TdGVwICJIdWdlUGFnZXMgY2FwIChSQU0gZml4KSIKICAgIFJlZ2lzdGVyLVN0ZXAgIk9TTiBhbGFybSB0aHJlc2hvbGRzIgogICAgUmVnaXN0ZXItU3RlcCAib3NuIHNlcnZpY2Ugc3RhcnRlZCIKICAgIFJlZ2lzdGVyLVN0ZXAgIk9jdGFTcGFjZSBub2RlIHRva2VuIgogICAgUmVnaXN0ZXItU3RlcCAiV2luZG93cyBGaXJld2FsbCBydWxlcyIKICAgIFJlZ2lzdGVyLVN0ZXAgIlVQblAgcG9ydCBmb3J3YXJkaW5nIgogICAgUmVnaXN0ZXItU3RlcCAiV1NMMiBwb3J0IHByb3h5IgogICAgUmVnaXN0ZXItU3RlcCAiUHVsc2UgcmVnaXN0cmF0aW9uIgogICAgUmVnaXN0ZXItU3RlcCAiR1BVIHdhdGNoZG9nIHRhc2siCiAgICBSZWdpc3Rlci1TdGVwICJBdXRvLXN0YXJ0IHRhc2siCiAgICBSZWdpc3Rlci1TdGVwICJBdXRvLWxvZ2luIgoKICAgIFdyaXRlLUxvZyAiU2V0dGluZyB1cCBVYnVudHUtMjIuMDQgb24gV1NMMi4uLiIKICAgICMgVGVzdCB0aGUgZGlzdHJvIGRpcmVjdGx5IOKAlCB3c2wgLS1saXN0IC0tcXVpZXQgb3V0cHV0cyBVVEYtMTYgd2hpY2ggY2FuIGNvcnJ1cHQgc3RyaW5nIG1hdGNoaW5nCiAgICAkZGlzdHJvT2sgPSAod3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICJlY2hvIG9rIiAyPiYxKSAtbWF0Y2ggIm9rIgogICAgaWYgKC1ub3QgJGRpc3Ryb09rKSB7CiAgICAgICAgd3NsIC0tdW5yZWdpc3RlciBVYnVudHUtMjIuMDQgMj4mMSB8IE91dC1OdWxsCiAgICAgICAgV3JpdGUtTG9nICJEb3dubG9hZGluZyBVYnVudHUtMjIuMDQuLi4iCiAgICAgICAgd3NsIC0taW5zdGFsbCAtZCBVYnVudHUtMjIuMDQgLS1uby1sYXVuY2ggMj4mMSB8IE91dC1OdWxsCgogICAgICAgIFdyaXRlLUxvZyAiSW5pdGlhbGl6aW5nIFVidW50dS0yMi4wNCBoZWFkbGVzc2x5IChubyBHVUkgcmVxdWlyZWQpLi4uIgogICAgICAgICR1YnVudHVFeGUgPSBHZXQtQ2hpbGRJdGVtICIkZW52OkxPQ0FMQVBQREFUQVxNaWNyb3NvZnRcV2luZG93c0FwcHMiIC1GaWx0ZXIgInVidW50dTIyMDQqLmV4ZSIgLUVycm9yQWN0aW9uIFNpbGVudGx5Q29udGludWUgfCBTZWxlY3QtT2JqZWN0IC1GaXJzdCAxCiAgICAgICAgaWYgKC1ub3QgJHVidW50dUV4ZSkgewogICAgICAgICAgICAkdWJ1bnR1RXhlID0gR2V0LUNoaWxkSXRlbSAiJGVudjpMT0NBTEFQUERBVEFcTWljcm9zb2Z0XFdpbmRvd3NBcHBzIiAtRmlsdGVyICJ1YnVudHUqLmV4ZSIgLUVycm9yQWN0aW9uIFNpbGVudGx5Q29udGludWUgfCBTZWxlY3QtT2JqZWN0IC1GaXJzdCAxCiAgICAgICAgfQogICAgICAgIGlmICgkdWJ1bnR1RXhlKSB7CiAgICAgICAgICAgICYgJHVidW50dUV4ZS5GdWxsTmFtZSBpbnN0YWxsIC0tcm9vdCAyPiYxIHwgT3V0LU51bGwKICAgICAgICB9CiAgICAgICAgU3RhcnQtU2xlZXAgNQoKICAgICAgICAkY2hlY2sgPSB3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tdXNlciByb290IC0tIGJhc2ggLWMgImVjaG8gb2siIDI+JjEKICAgICAgICBpZiAoJGNoZWNrIC1ub3RtYXRjaCAib2siKSB7CiAgICAgICAgICAgIFdyaXRlLUxvZyAiVWJ1bnR1LTIyLjA0IHJvb3QgYWNjZXNzIGZhaWxlZCDigJQgcmUtcnVuIGluc3RhbGxlci4iICJFUlJPUiIKICAgICAgICAgICAgU2hvdy1EaWFnbm9zdGljczsgV2FpdC1Gb3JLZXk7IGV4aXQgMQogICAgICAgIH0KICAgICAgICBXcml0ZS1Mb2cgIlVidW50dS0yMi4wNCBpbnN0YWxsZWQgYW5kIGluaXRpYWxpemVkIiAiT0siCiAgICB9IGVsc2UgewogICAgICAgIFdyaXRlLUxvZyAiVWJ1bnR1LTIyLjA0IGFscmVhZHkgcHJlc2VudCBhbmQgd29ya2luZyIgIk9LIgogICAgfQogICAgU2V0LVN0ZXAgIlVidW50dSBvbiBXU0wyIiAiUEFTUyIKCiAgICAjIEVuYWJsZSBzeXN0ZW1kIOKAlCBvc24gaXMgYSBzeXN0ZW1kIHNlcnZpY2UKICAgIFdyaXRlLUxvZyAiRW5hYmxpbmcgc3lzdGVtZCBpbiBXU0wyIChyZXF1aXJlZCBmb3Igb3NuIHNlcnZpY2UpLi4uIgogICAgd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICJncmVwIC1xICdzeXN0ZW1kPXRydWUnIC9ldGMvd3NsLmNvbmYgMj4vZGV2L251bGwgfHwgcHJpbnRmICdbYm9vdF1cbnN5c3RlbWQ9dHJ1ZVxuJyA+IC9ldGMvd3NsLmNvbmYiCgogICAgIyBXU0wyIG1pcnJvcmVkIG5ldHdvcmtpbmcg4oCUIGVzcGVjaWFsbHkgaW1wb3J0YW50IGZvciBPY3RhU3BhY2UgYmVjYXVzZSB0aGUKICAgICMgdHVubmVsIHBvcnRzIDUxODAwLTUxODE2IHVzZSBVRFAsIGFuZCBwb3J0cHJveHkgaXMgVENQLW9ubHkuCiAgICAkb3NCdWlsZCA9IFtTeXN0ZW0uRW52aXJvbm1lbnRdOjpPU1ZlcnNpb24uVmVyc2lvbi5CdWlsZAogICAgJG1pcnJvcmVkTmV0d29ya2luZyA9ICRmYWxzZQogICAgJHdzbENvbmZpZ1BhdGggPSAiJGVudjpVU0VSUFJPRklMRVwud3NsY29uZmlnIgogICAgIyB2bUlkbGVUaW1lb3V0PS0xIHN0b3BzIFdpbmRvd3MgZnJvbSB0ZWFyaW5nIGRvd24gdGhlIFdTTDIgdXRpbGl0eSBWTSBhZnRlcgogICAgIyBpdCBsb29rcyBpZGxlLiBXaXRob3V0IGl0LCB0aGUgVk0gKGFuZCB0aGUgb3NuIGRhZW1vbiBydW5uaW5nIGluc2lkZSBpdCkgY2FuCiAgICAjIGZyZWV6ZSBzaWxlbnRseSBmb3IgaG91cnMgd2l0aCB6ZXJvIGxvZyBvdXRwdXQg4oCUIG5vIGhlYXJ0YmVhdCB0aW1lb3V0LCBubwogICAgIyBlcnJvciwganVzdCBhIGdhcCDigJQgdW50aWwgc29tZXRoaW5nIHRvdWNoZXMgV1NMIGFnYWluIGFuZCBpdCByZWNvbm5lY3RzLgogICAgIyBUaGlzIGlzIHRoZSBzYW1lIGZpeCBhbHJlYWR5IGFwcGxpZWQgdG8gdGhlIENsb3JlIGluc3RhbGxlciAoQ0xPUkVfUFMxKS4KICAgIGlmICgkb3NCdWlsZCAtZ2UgMjI2MjEpIHsKICAgICAgICBXcml0ZS1Mb2cgIldpbmRvd3MgMTEgMjJIMisgZGV0ZWN0ZWQg4oCUIGVuYWJsaW5nIFdTTDIgbWlycm9yZWQgbmV0d29ya2luZy4uLiIKICAgICAgICAkd3NsQ29uZmlnQ29udGVudCA9IGlmIChUZXN0LVBhdGggJHdzbENvbmZpZ1BhdGgpIHsgR2V0LUNvbnRlbnQgJHdzbENvbmZpZ1BhdGggLVJhdyB9IGVsc2UgeyAiIiB9CiAgICAgICAgJGNoYW5nZWQgPSAkZmFsc2UKICAgICAgICBpZiAoJHdzbENvbmZpZ0NvbnRlbnQgLW5vdG1hdGNoICduZXR3b3JraW5nTW9kZScpIHsKICAgICAgICAgICAgaWYgKCR3c2xDb25maWdDb250ZW50IC1tYXRjaCAnXFt3c2wyXF0nKSB7CiAgICAgICAgICAgICAgICAkd3NsQ29uZmlnQ29udGVudCA9ICR3c2xDb25maWdDb250ZW50IC1yZXBsYWNlICcoXFt3c2wyXF0pJywgImAkMWBubmV0d29ya2luZ01vZGU9bWlycm9yZWQiCiAgICAgICAgICAgIH0gZWxzZSB7CiAgICAgICAgICAgICAgICAkd3NsQ29uZmlnQ29udGVudCArPSAiYG5bd3NsMl1gbm5ldHdvcmtpbmdNb2RlPW1pcnJvcmVkYG4iCiAgICAgICAgICAgIH0KICAgICAgICAgICAgJGNoYW5nZWQgPSAkdHJ1ZQogICAgICAgIH0KICAgICAgICBpZiAoJHdzbENvbmZpZ0NvbnRlbnQgLW5vdG1hdGNoICd2bUlkbGVUaW1lb3V0JykgewogICAgICAgICAgICBpZiAoJHdzbENvbmZpZ0NvbnRlbnQgLW1hdGNoICdcW3dzbDJcXScpIHsKICAgICAgICAgICAgICAgICR3c2xDb25maWdDb250ZW50ID0gJHdzbENvbmZpZ0NvbnRlbnQgLXJlcGxhY2UgJyhcW3dzbDJcXSknLCAiYCQxYG52bUlkbGVUaW1lb3V0PS0xIgogICAgICAgICAgICB9IGVsc2UgewogICAgICAgICAgICAgICAgJHdzbENvbmZpZ0NvbnRlbnQgKz0gImBuW3dzbDJdYG52bUlkbGVUaW1lb3V0PS0xYG4iCiAgICAgICAgICAgIH0KICAgICAgICAgICAgJGNoYW5nZWQgPSAkdHJ1ZQogICAgICAgIH0KICAgICAgICBpZiAoJGNoYW5nZWQpIHsgU2V0LUNvbnRlbnQgLVBhdGggJHdzbENvbmZpZ1BhdGggLVZhbHVlICR3c2xDb25maWdDb250ZW50IC1FbmNvZGluZyBVVEY4IH0KICAgICAgICAkbWlycm9yZWROZXR3b3JraW5nID0gJHRydWUKICAgICAgICBXcml0ZS1Mb2cgIldTTDIgbmV0d29ya2luZyBjb25maWd1cmVkIChtaXJyb3JlZCwgdm1JZGxlVGltZW91dD0tMSkg4oCUIFVEUCB0dW5uZWxzIHdpbGwgd29yayBjb3JyZWN0bHkiICJPSyIKICAgICAgICBTZXQtU3RlcCAiV1NMMiBuZXR3b3JraW5nIiAiUEFTUyIgIk1pcnJvcmVkIChXaW5kb3dzIDExIDIySDIrKSwgdm1JZGxlVGltZW91dD0tMSDigJQgVURQIHR1bm5lbHMgZnVsbHkgZnVuY3Rpb25hbCIKICAgIH0gZWxzZSB7CiAgICAgICAgV3JpdGUtTG9nICJXaW5kb3dzIGJ1aWxkICR7b3NCdWlsZH06IG1pcnJvcmVkIG5ldHdvcmtpbmcgbmVlZHMgMjJIMiAoMjI2MjErKSDigJQgcG9ydHByb3h5IG9ubHkgY292ZXJzIFRDUDsgVURQIHR1bm5lbHMgd2lsbCBiZSBsaW1pdGVkIiAiV0FSTiIKICAgICAgICAkd3NsQ29uZmlnQ29udGVudCA9IGlmIChUZXN0LVBhdGggJHdzbENvbmZpZ1BhdGgpIHsgR2V0LUNvbnRlbnQgJHdzbENvbmZpZ1BhdGggLVJhdyB9IGVsc2UgeyAiIiB9CiAgICAgICAgaWYgKCR3c2xDb25maWdDb250ZW50IC1ub3RtYXRjaCAndm1JZGxlVGltZW91dCcpIHsKICAgICAgICAgICAgaWYgKCR3c2xDb25maWdDb250ZW50IC1tYXRjaCAnXFt3c2wyXF0nKSB7CiAgICAgICAgICAgICAgICAkd3NsQ29uZmlnQ29udGVudCA9ICR3c2xDb25maWdDb250ZW50IC1yZXBsYWNlICcoXFt3c2wyXF0pJywgImAkMWBudm1JZGxlVGltZW91dD0tMSIKICAgICAgICAgICAgfSBlbHNlIHsKICAgICAgICAgICAgICAgICR3c2xDb25maWdDb250ZW50ICs9ICJgblt3c2wyXWBudm1JZGxlVGltZW91dD0tMWBuIgogICAgICAgICAgICB9CiAgICAgICAgICAgIFNldC1Db250ZW50IC1QYXRoICR3c2xDb25maWdQYXRoIC1WYWx1ZSAkd3NsQ29uZmlnQ29udGVudCAtRW5jb2RpbmcgVVRGOAogICAgICAgIH0KICAgICAgICBXcml0ZS1Mb2cgInZtSWRsZVRpbWVvdXQ9LTEgc2V0IChwcmV2ZW50cyBzaWxlbnQgV1NMMiBWTSBpZGxlLWZyZWV6ZSkiICJPSyIKICAgICAgICBTZXQtU3RlcCAiV1NMMiBuZXR3b3JraW5nIiAiV0FSTiIgIlBvcnRwcm94eSBvbmx5IChidWlsZCAkb3NCdWlsZCksIHZtSWRsZVRpbWVvdXQ9LTEg4oCUIFVEUCB0dW5uZWwgcG9ydHMgbGltaXRlZDsgdXBncmFkZSB0byBXaW4gMTEgMjJIMisgcmVjb21tZW5kZWQiCiAgICB9CgogICAgd3NsIC0tc2h1dGRvd24KICAgIFN0YXJ0LVNsZWVwIDIwCiAgICAkc2RDaGVjayA9IHdzbCAtZCBVYnVudHUtMjIuMDQgLS11c2VyIHJvb3QgLS0gYmFzaCAtYyAiWyAtZCAvcnVuL3N5c3RlbWQvc3lzdGVtIF0gJiYgZWNobyB5ZXMgfHwgZWNobyBubyIgMj4mMQogICAgaWYgKCRzZENoZWNrIC1tYXRjaCAieWVzIikgewogICAgICAgIFdyaXRlLUxvZyAic3lzdGVtZCBydW5uaW5nIGluIFdTTDIiICJPSyIKICAgICAgICBTZXQtU3RlcCAic3lzdGVtZCBpbiBXU0wyIiAiUEFTUyIKICAgIH0gZWxzZSB7CiAgICAgICAgV3JpdGUtTG9nICJzeXN0ZW1kIG1heSBub3QgYmUgYWN0aXZlIOKAlCBvc24gbWF5IG5vdCBhdXRvLXN0YXJ0IG9uIHJlYm9vdCIgIldBUk4iCiAgICAgICAgU2V0LVN0ZXAgInN5c3RlbWQgaW4gV1NMMiIgIldBUk4iICJzeXN0ZW1kIG5vdCBkZXRlY3RlZCDigJQgb3NuIHNlcnZpY2UgbWF5IG5vdCBwZXJzaXN0IGFjcm9zcyByZWJvb3RzIgogICAgfQoKICAgICMg4pSA4pSAIERldGVjdCBHUFUgdmVuZG9yIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogICAgJGdwdU9iaiAgICA9IEdldC1XbWlPYmplY3QgV2luMzJfVmlkZW9Db250cm9sbGVyIHwgV2hlcmUtT2JqZWN0IHsgJF8uTmFtZSAtbWF0Y2ggIk5WSURJQXxHZUZvcmNlfFJUWHxHVFh8QU1EfFJhZGVvbiIgfSB8IFNlbGVjdC1PYmplY3QgLUZpcnN0IDEKICAgICRncHVOYW1lICAgPSAkZ3B1T2JqLk5hbWUKICAgICR2cmFtTWIgICAgPSAkZ3B1T2JqLkFkYXB0ZXJSQU0KICAgICR2cmFtR2IgICAgPSBpZiAoJHZyYW1NYiAtYW5kICR2cmFtTWIgLWd0IDApIHsgW21hdGhdOjpSb3VuZCgkdnJhbU1iIC8gMUdCKSB9IGVsc2UgeyA4IH0KICAgICRncHVWZW5kb3IgPSBpZiAoJGdwdU5hbWUgLW1hdGNoICJOVklESUF8R2VGb3JjZXxSVFh8R1RYIikgeyAiTlZJRElBIiB9IGVsc2UgeyAiQU1EIiB9CgogICAgIyDilIDilIAgUHJlLWluc3RhbGwgR1BVIGNvbXB1dGUgZHJpdmVycyBpbnNpZGUgV1NMMiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAgIFdyaXRlLUxvZyAiQ2hlY2tpbmcgR1BVIGNvbXB1dGUgZW52aXJvbm1lbnQgaW4gV1NMMiAoJGdwdVZlbmRvcikuLi4iCiAgICBpZiAoJGdwdVZlbmRvciAtZXEgIk5WSURJQSIpIHsKICAgICAgICAkbnZDaGVjayA9IHdzbCAtZCBVYnVudHUtMjIuMDQgLS11c2VyIHJvb3QgLS0gYmFzaCAtYyAibnZpZGlhLXNtaSAtTCAyPi9kZXYvbnVsbCB8IGhlYWQgLTEiIDI+JjEKICAgICAgICBpZiAoJG52Q2hlY2sgLW1hdGNoICJHUFUgMCIpIHsKICAgICAgICAgICAgV3JpdGUtTG9nICJOVklESUEgR1BVIHZpc2libGUgaW4gV1NMMiIgIk9LIgogICAgICAgICAgICBTZXQtU3RlcCAiR1BVIGNvbXB1dGUgaW4gV1NMMiIgIlBBU1MiICJudmlkaWEtc21pIE9LIOKAlCAkZ3B1TmFtZSIKICAgICAgICB9IGVsc2UgewogICAgICAgICAgICBXcml0ZS1Mb2cgIk5WSURJQSBHUFUgbm90IHlldCB2aXNpYmxlIGluIFdTTDIg4oCUIGVuc3VyZSBXaW5kb3dzIE5WSURJQSBkcml2ZXIgaXMgdXAgdG8gZGF0ZSIgIldBUk4iCiAgICAgICAgICAgIFNldC1TdGVwICJHUFUgY29tcHV0ZSBpbiBXU0wyIiAiV0FSTiIgIm52aWRpYS1zbWkgcmV0dXJuZWQgbm8gb3V0cHV0IOKAlCBvc24gbWF5IGZhaWwgd2l0aG91dCBHUFUgYWNjZXNzIgogICAgICAgIH0KICAgIH0gZWxzZSB7CiAgICAgICAgV3JpdGUtTG9nICJJbnN0YWxsaW5nIFJPQ20gZm9yIEFNRCBHUFUgaW4gV1NMMiAodGhpcyB0YWtlcyBhIGZldyBtaW51dGVzKS4uLiIKICAgICAgICAkdWJ1bnR1VmVyID0gd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICJsc2JfcmVsZWFzZSAtY3MgMj4vZGV2L251bGwiIDI+JjEKICAgICAgICAkdWJ1bnR1VmVyID0gJHVidW50dVZlci5UcmltKCkKICAgICAgICBpZiAoJHVidW50dVZlciAtbm90aW4gQCgiamFtbXkiLCJmb2NhbCIsIm5vYmxlIikpIHsgJHVidW50dVZlciA9ICJqYW1teSIgfQogICAgICAgICRyb2NtU2NyaXB0ID0gInNldCAtZWBuZXhwb3J0IERFQklBTl9GUk9OVEVORD1ub25pbnRlcmFjdGl2ZWBuYXB0LWdldCB1cGRhdGUgLXFxYG5hcHQtZ2V0IGluc3RhbGwgLXkgLXFxIHdnZXQgZ251cGcgY2EtY2VydGlmaWNhdGVzYG5ta2RpciAtcCAvZXRjL2FwdC9rZXlyaW5nc2Bucm0gLWYgL2V0Yy9hcHQva2V5cmluZ3Mvcm9jbS5ncGdgbndnZXQgLXFPIC0gaHR0cHM6Ly9yZXBvLnJhZGVvbi5jb20vcm9jbS9yb2NtLmdwZy5rZXkgfCBncGcgLS1kZWFybW9yIC1vIC9ldGMvYXB0L2tleXJpbmdzL3JvY20uZ3BnYG5lY2hvICdkZWIgW2FyY2g9YW1kNjQgc2lnbmVkLWJ5PS9ldGMvYXB0L2tleXJpbmdzL3JvY20uZ3BnXSBodHRwczovL3JlcG8ucmFkZW9uLmNvbS9yb2NtL2FwdC82LjIgJHVidW50dVZlciBtYWluJyA+IC9ldGMvYXB0L3NvdXJjZXMubGlzdC5kL3JvY20ubGlzdGBuYXB0LWdldCB1cGRhdGUgLXFxYG5hcHQtZ2V0IGluc3RhbGwgLXkgLXFxIHJvY20tb3BlbmNsLXJ1bnRpbWUiCiAgICAgICAgIyBQaXBlIHZpYSBzdGRpbiB0byBhdm9pZCBDUkxGIGlzc3VlcyB3aXRoIGJhc2ggLWMgb24gV2luZG93cwogICAgICAgICRyb2NtU2NyaXB0IHwgd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIDI+JjEgfCBGb3JFYWNoLU9iamVjdCB7IFdyaXRlLUxvZyAkXyB9CiAgICAgICAgaWYgKCRMQVNURVhJVENPREUgLWVxIDApIHsKICAgICAgICAgICAgV3JpdGUtTG9nICJST0NtIGluc3RhbGxlZCIgIk9LIgogICAgICAgICAgICBTZXQtU3RlcCAiR1BVIGNvbXB1dGUgaW4gV1NMMiIgIlBBU1MiICJST0NtIG9wZW5jbC1ydW50aW1lIGluc3RhbGxlZCDigJQgJGdwdU5hbWUiCiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgICAgV3JpdGUtTG9nICJST0NtIGluc3RhbGwgZW5jb3VudGVyZWQgZXJyb3JzIOKAlCBPY3RhU3BhY2UgbWF5IGhhdmUgbGltaXRlZCBBTUQgc3VwcG9ydCIgIldBUk4iCiAgICAgICAgICAgIFNldC1TdGVwICJHUFUgY29tcHV0ZSBpbiBXU0wyIiAiV0FSTiIgIlJPQ20gaW5zdGFsbCBoYWQgZXJyb3JzIOKAlCBBTUQgc3VwcG9ydCBtYXkgYmUgbGltaXRlZCIKICAgICAgICB9CiAgICB9CgogICAgIyDilIDilIAgSW5zdGFsbCBPY3RhU3BhY2Ugbm9kZSAob3NuKSBpbnNpZGUgV1NMMiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAgIFdyaXRlLUxvZyAiSW5zdGFsbGluZyBvc24gcHJlcmVxdWlzaXRlcyAoY3VybCwgYmFzaCwgZ3VtKS4uLiIKICAgIHdzbCAtZCBVYnVudHUtMjIuMDQgLS11c2VyIHJvb3QgLS0gYmFzaCAtYyAiZXhwb3J0IERFQklBTl9GUk9OVEVORD1ub25pbnRlcmFjdGl2ZTsgYXB0LWdldCB1cGRhdGUgLXFxICYmIGFwdC1nZXQgaW5zdGFsbCAteSAtcXEgY3VybCBiYXNoIiAyPiYxIHwgRm9yRWFjaC1PYmplY3QgeyBXcml0ZS1Mb2cgJF8gfQogICAgaWYgKCRMQVNURVhJVENPREUgLWVxIDApIHsKICAgICAgICBTZXQtU3RlcCAiQnVpbGQgdG9vbHMgKGN1cmwsIGJhc2gpIiAiUEFTUyIKICAgIH0gZWxzZSB7CiAgICAgICAgU2V0LVN0ZXAgIkJ1aWxkIHRvb2xzIChjdXJsLCBiYXNoKSIgIldBUk4iICJhcHQtZ2V0IGV4aXQgJExBU1RFWElUQ09ERSDigJQgb3NuIGluc3RhbGxlciB3aWxsIGF0dGVtcHQgdG8gY29udGludWUgYW55d2F5IgogICAgfQoKICAgIFdyaXRlLUxvZyAiSW5zdGFsbGluZyBndW0gKHJlcXVpcmVkIGJ5IE9jdGFTcGFjZSBpbnN0YWxsZXIpLi4uIgogICAgIyBybSAtZiBiZWZvcmUgZGVhcm1vcjogZ3BnIHByb21wdHMgIm92ZXJ3cml0ZT8iIGlmIHRoZSBrZXlyaW5nIGFscmVhZHkgZXhpc3RzIChlLmcuIGEKICAgICMgcHJpb3IgaW50ZXJydXB0ZWQgcnVuKSwgYW5kIHRoYXQgcHJvbXB0IGhhbmdzIGZvcmV2ZXIgd2l0aCBubyBpbnRlcmFjdGl2ZSBzdGRpbiByZWFjaGluZyBpdC4KICAgICRndW1JbnN0YWxsID0gImV4cG9ydCBERUJJQU5fRlJPTlRFTkQ9bm9uaW50ZXJhY3RpdmUgJiYgbWtkaXIgLXAgL2V0Yy9hcHQva2V5cmluZ3MgJiYgcm0gLWYgL2V0Yy9hcHQva2V5cmluZ3MvY2hhcm0uZ3BnICYmIGN1cmwgLWZzU0wgaHR0cHM6Ly9yZXBvLmNoYXJtLnNoL2FwdC9ncGcua2V5IHwgZ3BnIC0tZGVhcm1vciAtbyAvZXRjL2FwdC9rZXlyaW5ncy9jaGFybS5ncGcgJiYgZWNobyAnZGViIFtzaWduZWQtYnk9L2V0Yy9hcHQva2V5cmluZ3MvY2hhcm0uZ3BnXSBodHRwczovL3JlcG8uY2hhcm0uc2gvYXB0LyAqIConIHwgdGVlIC9ldGMvYXB0L3NvdXJjZXMubGlzdC5kL2NoYXJtLmxpc3QgPiAvZGV2L251bGwgJiYgYXB0LWdldCB1cGRhdGUgLXFxICYmIGFwdC1nZXQgaW5zdGFsbCAteSAtcXEgZ3VtIgogICAgd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICRndW1JbnN0YWxsIDI+JjEgfCBGb3JFYWNoLU9iamVjdCB7IFdyaXRlLUxvZyAkXyB9CiAgICBpZiAoJExBU1RFWElUQ09ERSAtbmUgMCkgewogICAgICAgIFdyaXRlLUxvZyAiZ3VtIGluc3RhbGwgZmFpbGVkIOKAlCBPY3RhU3BhY2UgaW5zdGFsbGVyIG1heSBmYWlsIiAiV0FSTiIKICAgIH0gZWxzZSB7CiAgICAgICAgV3JpdGUtTG9nICJndW0gaW5zdGFsbGVkIiAiT0siCiAgICB9CgogICAgV3JpdGUtTG9nICJJbnN0YWxsaW5nIE9jdGFTcGFjZSBub2RlIChvc24pIGluc2lkZSBXU0wyLi4uIgogICAgJG9jdGFPdXRwdXQgPSB3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tdXNlciByb290IC0tIGJhc2ggLWMgImN1cmwgLWZzU0wgaHR0cHM6Ly9pbnN0YWxsLm9jdGEuc3BhY2UgfCBiYXNoIiAyPiYxCiAgICAkb2N0YUV4aXQgPSAkTEFTVEVYSVRDT0RFCiAgICAkb2N0YU91dHB1dCB8IEZvckVhY2gtT2JqZWN0IHsgV3JpdGUtTG9nICRfIH0KICAgIGlmICgkb2N0YUV4aXQgLW5lIDApIHsKICAgICAgICBTZXQtU3RlcCAiT2N0YVNwYWNlIG9zbiBpbnN0YWxsZWQiICJGQUlMIiAiaW5zdGFsbC5vY3RhLnNwYWNlIHNjcmlwdCBleGl0ZWQgJG9jdGFFeGl0IOKAlCBzZWUgbG9nIGZvciBkZXRhaWxzIgogICAgICAgIFdyaXRlLUxvZyAiT2N0YVNwYWNlIGluc3RhbGxhdGlvbiBmYWlsZWQgKGV4aXQgJG9jdGFFeGl0KS4gQ2hlY2sgdGhlIG91dHB1dCBhYm92ZS4iICJFUlJPUiIKICAgICAgICBTaG93LURpYWdub3N0aWNzOyBXYWl0LUZvcktleTsgZXhpdCAxCiAgICB9CiAgICBXcml0ZS1Mb2cgIk9jdGFTcGFjZSBvc24gaW5zdGFsbCBjb21wbGV0ZSIgIk9LIgogICAgU2V0LVN0ZXAgIk9jdGFTcGFjZSBvc24gaW5zdGFsbGVkIiAiUEFTUyIKCiAgICAjIOKUgOKUgCBTdGFiaWxpdHkgRml4IDE6IGNhcCBOVklESUEgSHVnZVBhZ2VzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogICAgIyBOVklESUEncyBXU0wyIGRyaXZlciBsb2NrcyBIdWdlUGFnZXMgcHJvcG9ydGlvbmFsIHRvIGF2YWlsYWJsZSBSQU0g4oCUIHVwIHRvIH44R0IKICAgICMgb24gYSAxMEdCIFdTTCBpbnN0YW5jZS4gRXJsYW5nJ3MgbWVtc3VwIGZpcmVzIGEgc3lzdGVtX21lbW9yeV9oaWdoX3dhdGVybWFyayBhbGFybQogICAgIyB3aGVuID44MCUgUkFNIGlzIHVzZWQsIGNhdXNpbmcgT1NOIHRvIGNhbGwgaW5pdDpzdG9wKCkgfjE1cyBhZnRlciBldmVyeSBzdGFydHVwLgogICAgV3JpdGUtTG9nICJDYXBwaW5nIE5WSURJQSBIdWdlUGFnZXMgYXQgMjU2ICg1MTJNQikgdG8gcHJldmVudCBSQU0gc3RhcnZhdGlvbi4uLiIKICAgIHdzbCAtZCBVYnVudHUtMjIuMDQgLS11c2VyIHJvb3QgLS0gYmFzaCAtYyAiZWNobyB2bS5ucl9odWdlcGFnZXM9MjU2ID4gL2V0Yy9zeXNjdGwuZC85MC13c2wuY29uZiAmJiBzeXNjdGwgLXAgL2V0Yy9zeXNjdGwuZC85MC13c2wuY29uZiIgMj4mMSB8IEZvckVhY2gtT2JqZWN0IHsgV3JpdGUtTG9nICRfIH0KICAgIFdyaXRlLUxvZyAiSHVnZVBhZ2VzIGNhcHBlZCDigJQgTlZJRElBIGRyaXZlciBsaW1pdGVkIHRvIDUxMk1CIGtlcm5lbCBwYWdlcyIgIk9LIgogICAgU2V0LVN0ZXAgIkh1Z2VQYWdlcyBjYXAgKFJBTSBmaXgpIiAiUEFTUyIKCiAgICAjIOKUgOKUgCBTdGFiaWxpdHkgRml4IDI6IHJhaXNlIE9TTiBkaXNrICsgbWVtb3J5IGFsYXJtIHRocmVzaG9sZHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgICAjIE9jdGFTcGFjZSdzIGluc3RhbGxlciBjcmVhdGVzIC9kb2NrZXItZGF0YS5pbWcgKH43NjNHQiByZWFsIGZpbGUpIGZvciBEb2NrZXIgc3RvcmFnZSwKICAgICMgcHVzaGluZyB0aGUgcm9vdCBmaWxlc3lzdGVtIHRvIH44MSUuIEVybGFuZydzIGRpc2tzdXAgZmlyZXMgYSBkaXNrX2FsbW9zdF9mdWxsIGFsYXJtCiAgICAjIGF0IDgwJSAodGhlIGRlZmF1bHQpIGFuZCBjYXVzZXMgT1NOIHRvIHNlbGYtdGVybWluYXRlLiBSYWlzaW5nIHRvIDkwJSBjbGVhcnMgaGVhZHJvb20uCiAgICAjIG1lbXN1cCdzIHN5c3RlbV9tZW1vcnlfaGlnaF93YXRlcm1hcmsgdXNlcyAic3RyaWN0bHkgZnJlZSAvIHRvdGFsIiB3aGljaCBmaXJlcyBjb25zdGFudGx5CiAgICAjIG9uIExpbnV4IGJlY2F1c2UgdGhlIGtlcm5lbCBmaWxscyBhbGwgc3BhcmUgbWVtb3J5IHdpdGggYnVmZmVyIGNhY2hlLiBSYWlzaW5nIHRvIDAuOTcKICAgICMgbWVhbnMgdGhlIGFsYXJtIG9ubHkgZmlyZXMgd2hlbiBnZW51aW5lbHkgUkFNLXN0YXJ2ZWQ7IGJyaWVmIHNwaWtlcyBjbGVhciBxdWlja2x5LgogICAgV3JpdGUtTG9nICJQYXRjaGluZyBPU04gYWxhcm0gdGhyZXNob2xkcyAoZGlzayA5MCUsIG1lbW9yeSA5NyUpLi4uIgogICAgJGRpc2tGaXhTY3JpcHQgPSBAJwpTWVNfQ0ZHPSQobHMgL2hvbWUvb2N0YS9vc24vcmVsZWFzZXMvKi9zeXMuY29uZmlnIDI+L2Rldi9udWxsIHwgZ3JlcCAtdiBSRUxFQVNFUyB8IGhlYWQgLTEpCmlmIFsgLXogIiRTWVNfQ0ZHIiBdOyB0aGVuIGVjaG8gInN5cy5jb25maWcgbm90IGZvdW5kIjsgZXhpdCAxOyBmaQpncmVwIC1xICJkaXNrX2FsbW9zdF9mdWxsX3RocmVzaG9sZCIgIiRTWVNfQ0ZHIiAmJiBncmVwIC1xICJzeXN0ZW1fbWVtb3J5X2hpZ2hfd2F0ZXJtYXJrIiAiJFNZU19DRkciICYmIGVjaG8gImFscmVhZHkgcGF0Y2hlZCIgJiYgZXhpdCAwCmNhdCA+ICIkU1lTX0NGRyIgPDwgJ0VSTEVPRicKWwogICAge2tlcm5lbCwgWwogICAgICAgIHtsb2dnZXJfbGV2ZWwsIGRlYnVnfSwKICAgICAgICB7bG9nZ2VyLCBbCiAgICAgICAgICAgIHtoYW5kbGVyLCBkZWZhdWx0LCBsb2dnZXJfc3RkX2gsICN7CiAgICAgICAgICAgICAgICBsZXZlbCA9PiBkZWJ1ZywKICAgICAgICAgICAgICAgIGNvbmZpZyA9PiAjewogICAgICAgICAgICAgICAgICAgIGJ1cnN0X2xpbWl0X2VuYWJsZSA9PiBmYWxzZQogICAgICAgICAgICAgICAgfSwKICAgICAgICAgICAgICAgIGZvcm1hdHRlciA9PiB7bG9nZ2VyX2Zvcm1hdHRlciwgI3t0ZW1wbGF0ZSA9PiBbdGltZSwgIiAiLCBtc2csICJcbiJdfX0KICAgICAgICAgICAgfX0KICAgICAgICBdfQogICAgXX0sCiAgICB7b3NfbW9uLCBbCiAgICAgICAge2Rpc2tfYWxtb3N0X2Z1bGxfdGhyZXNob2xkLCAwLjkwfSwKICAgICAgICB7c3lzdGVtX21lbW9yeV9oaWdoX3dhdGVybWFyaywgMC45N30KICAgIF19Cl0uCkVSTEVPRgplY2hvICJwYXRjaGVkIgonQAogICAgJGRpc2tGaXhTY3JpcHQgPSAkZGlza0ZpeFNjcmlwdCAtcmVwbGFjZSAiYHJgbiIsICJgbiIgICMgQ1JMRiBicmVha3MgaGVyZWRvYyBkZWxpbWl0ZXIgd2hlbiBkZWNvZGVkIGluIGJhc2gKICAgICRkaXNrRml4QjY0ID0gW0NvbnZlcnRdOjpUb0Jhc2U2NFN0cmluZyhbU3lzdGVtLlRleHQuRW5jb2RpbmddOjpVVEY4LkdldEJ5dGVzKCRkaXNrRml4U2NyaXB0KSkKICAgICRkaXNrUmVzdWx0ID0gd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICJlY2hvICckZGlza0ZpeEI2NCcgfCBiYXNlNjQgLWQgfCBiYXNoIiAyPiYxCiAgICAkZGlza09rID0gKCRMQVNURVhJVENPREUgLWVxIDApIC1hbmQgKCRkaXNrUmVzdWx0IC1ub3RtYXRjaCAnc3ludGF4IGVycm9yfG5vdCBmb3VuZHxlcnJvcicpCiAgICBXcml0ZS1Mb2cgIk9TTiBhbGFybSB0aHJlc2hvbGRzOiAkKCRkaXNrUmVzdWx0IC1qb2luICcgJykiICQoaWYgKCRkaXNrT2spIHsgIk9LIiB9IGVsc2UgeyAiV0FSTiIgfSkKICAgIGlmICgkZGlza09rKSB7CiAgICAgICAgU2V0LVN0ZXAgIk9TTiBhbGFybSB0aHJlc2hvbGRzIiAiUEFTUyIKICAgIH0gZWxzZSB7CiAgICAgICAgU2V0LVN0ZXAgIk9TTiBhbGFybSB0aHJlc2hvbGRzIiAiV0FSTiIgInRocmVzaG9sZCBwYXRjaCBmYWlsZWQg4oCUIE9TTiBtYXkgcmVzdGFydCBpZiBkaXNrID44MCUgb3IgbWVtb3J5IGNhY2hlIGZpbGxzIgogICAgfQoKICAgICMg4pSA4pSAIFN0YWJpbGl0eSBGaXggMzogZGlzYWJsZSBXaW5kb3dzIFVwZGF0ZSBhdXRvLXJlc3RhcnQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgICAjIFdpbmRvd3MgMTEgY2FuIGZvcmNlLXJlc3RhcnQgbWlkLXJlbnRhbCB0byBhcHBseSB1cGRhdGVzLCB0ZXJtaW5hdGluZyBhbnkgcnVubmluZyBqb2IKICAgICMgd2l0aCAibm9kZSB3ZW50IGRvd24gb3IgcmVib290ZWQgZHVyaW5nIHNlc3Npb24iLiBCbG9jayBhdXRvLXJlc3RhcnQgd2hlbiBhIHVzZXIgaXMKICAgICMgbG9nZ2VkIGluICh1cGRhdGVzIHN0aWxsIGRvd25sb2FkIGFuZCBpbnN0YWxsOyB0aGV5IGp1c3QgZG9uJ3QgcmVzdGFydCB3aXRob3V0IGNvbnNlbnQpLgogICAgV3JpdGUtTG9nICJCbG9ja2luZyBXaW5kb3dzIFVwZGF0ZSBhdXRvLXJlc3RhcnQgZHVyaW5nIGFjdGl2ZSBzZXNzaW9ucy4uLiIKICAgIHRyeSB7CiAgICAgICAgJHd1UGF0aCA9ICJIS0xNOlxTT0ZUV0FSRVxQb2xpY2llc1xNaWNyb3NvZnRcV2luZG93c1xXaW5kb3dzVXBkYXRlXEFVIgogICAgICAgIGlmICgtbm90IChUZXN0LVBhdGggJHd1UGF0aCkpIHsgTmV3LUl0ZW0gLVBhdGggJHd1UGF0aCAtRm9yY2UgfCBPdXQtTnVsbCB9CiAgICAgICAgU2V0LUl0ZW1Qcm9wZXJ0eSAtUGF0aCAkd3VQYXRoIC1OYW1lICJOb0F1dG9SZWJvb3RXaXRoTG9nZ2VkT25Vc2VycyIgLVZhbHVlIDEgLVR5cGUgRFdvcmQgLUZvcmNlCiAgICAgICAgU2V0LUl0ZW1Qcm9wZXJ0eSAtUGF0aCAkd3VQYXRoIC1OYW1lICJBVU9wdGlvbnMiIC1WYWx1ZSA0IC1UeXBlIERXb3JkIC1Gb3JjZSAgIyA0ID0gZG93bmxvYWQgYW5kIHNjaGVkdWxlIGluc3RhbGwgKG5vIGF1dG8taW5zdGFsbCkKICAgICAgICBXcml0ZS1Mb2cgIldpbmRvd3MgVXBkYXRlIGF1dG8tcmVzdGFydCBzdXBwcmVzc2VkIiAiT0siCiAgICAgICAgU2V0LVN0ZXAgIldpbmRvd3MgVXBkYXRlIHJlc3RhcnQgZ3VhcmQiICJQQVNTIgogICAgfSBjYXRjaCB7CiAgICAgICAgV3JpdGUtTG9nICJDb3VsZCBub3Qgc2V0IFdpbmRvd3MgVXBkYXRlIHBvbGljeSAobm9uLWZhdGFsKTogJF8iICJXQVJOIgogICAgICAgIFNldC1TdGVwICJXaW5kb3dzIFVwZGF0ZSByZXN0YXJ0IGd1YXJkIiAiV0FSTiIgIk1hbnVhbDogc2V0IE5vQXV0b1JlYm9vdFdpdGhMb2dnZWRPblVzZXJzPTEgaW4gR3JvdXAgUG9saWN5IgogICAgfQoKICAgICMgU3RhcnQgdGhlIHNlcnZpY2Ugc28gaXQgY2FuIHJlZ2lzdGVyIGFuZCBnZW5lcmF0ZSBhIG5vZGUgdG9rZW4KICAgIFdyaXRlLUxvZyAiU3RhcnRpbmcgb3NuIHNlcnZpY2UuLi4iCiAgICB3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tdXNlciByb290IC0tIGJhc2ggLWMgInN5c3RlbWN0bCBlbmFibGUgb3NuIDI+L2Rldi9udWxsOyBzeXN0ZW1jdGwgc3RhcnQgb3NuIDI+L2Rldi9udWxsIgogICAgU2V0LVN0ZXAgIm9zbiBzZXJ2aWNlIHN0YXJ0ZWQiICJQQVNTIgoKICAgICMg4pSA4pSAIEV4dHJhY3QgT2N0YVNwYWNlIG5vZGUgdG9rZW4gZnJvbSBpbnN0YWxsZXIgb3V0cHV0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogICAgIyBUaGUgaW5zdGFsbGVyIHByaW50cyBhIGJveDog4pWRICBOb2RlIFRva2VuOiBYWFhYWFhYWFhYICDilZEgdG8gc3Rkb3V0IOKAlCBidXQgb25seQogICAgIyB0aGUgRklSU1QgdGltZSBhIG5vZGUgaXMgY3JlYXRlZDsgYSByZS1ydW4gb2YgdGhpcyB3cmFwcGVyIGFnYWluc3QgYW4gYWxyZWFkeS0KICAgICMgcmVnaXN0ZXJlZCBub2RlIHdvbid0IHJlcHJpbnQgaXQuIFNvIHRoZSBtb21lbnQgd2UgZG8gY2FwdHVyZSBpdCBmcmVzaCwgcGVyc2lzdAogICAgIyBpdCB0byBhIHBsYWluLXRleHQgbWFya2VyIGZpbGUgd2UgY29udHJvbCwgYW5kIGNoZWNrIHRoYXQgZmlsZSBmaXJzdCBvbiBldmVyeQogICAgIyBmdXR1cmUgcnVuIGJlZm9yZSBmYWxsaW5nIGJhY2sgdG8gZ3Vlc3NpbmcuIChUaGUgb3NuLmlkZW50IGZpbGUgT2N0YVNwYWNlIGl0c2VsZgogICAgIyB3cml0ZXMgaXMgYSByYXcgRXJsYW5nIGV4dGVybmFsLXRlcm0tZm9ybWF0IGJsb2IsIG5vdCBKU09OLCBhbmQgaXNuJ3QgYSBzdGFibGUKICAgICMgdGhpbmcgdG8gc2NyYXBlIGZyb20gYmFzaCDigJQgZG9uJ3QgdHJ5IHRvIHBhcnNlIGl0LikKICAgICR0b2tlbk1hcmtlckNtZCA9ICJjYXQgL2hvbWUvb2N0YS8ucHVsc2Vfbm9kZV90b2tlbiAyPi9kZXYvbnVsbCIKICAgICRvY3RhTm9kZVRva2VuID0gIiIKICAgICR0b2tlbk1hdGNoID0gJG9jdGFPdXRwdXQgfCBTZWxlY3QtU3RyaW5nIC1QYXR0ZXJuICdOb2RlIFRva2VuOlxzKihcUyspJwogICAgaWYgKCR0b2tlbk1hdGNoKSB7CiAgICAgICAgJG9jdGFOb2RlVG9rZW4gPSAkdG9rZW5NYXRjaC5NYXRjaGVzWzBdLkdyb3Vwc1sxXS5WYWx1ZS5UcmltKCkKICAgICAgICB3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tdXNlciByb290IC0tIGJhc2ggLWMgImVjaG8gJyRvY3RhTm9kZVRva2VuJyA+IC9ob21lL29jdGEvLnB1bHNlX25vZGVfdG9rZW4iIDI+JjEgfCBPdXQtTnVsbAogICAgICAgIFdyaXRlLUxvZyAiT2N0YVNwYWNlIG5vZGUgdG9rZW46ICRvY3RhTm9kZVRva2VuIiAiT0siCiAgICAgICAgU2V0LVN0ZXAgIk9jdGFTcGFjZSBub2RlIHRva2VuIiAiUEFTUyIgIlRva2VuOiAkb2N0YU5vZGVUb2tlbiIKICAgIH0gZWxzZSB7CiAgICAgICAgIyBGYWxsYmFjayAxOiBvdXIgb3duIG1hcmtlciBmaWxlLCB3cml0dGVuIG9uIGEgcHJpb3Igc3VjY2Vzc2Z1bCBydW4gb2YgdGhpcyBzY3JpcHQKICAgICAgICBXcml0ZS1Mb2cgIlRva2VuIG5vdCBmb3VuZCBpbiBpbnN0YWxsZXIgb3V0cHV0IOKAlCBjaGVja2luZyBmb3IgYSBwcmV2aW91c2x5IHNhdmVkIHRva2VuLi4uIgogICAgICAgICRtYXJrZXIgPSAod3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICR0b2tlbk1hcmtlckNtZCAyPiYxKSAtam9pbiAnJwogICAgICAgICRtYXJrZXIgPSAkbWFya2VyLlRyaW0oKQogICAgICAgIGlmICgkbWFya2VyIC1tYXRjaCAnXlxTezYsfSQnKSB7CiAgICAgICAgICAgICRvY3RhTm9kZVRva2VuID0gJG1hcmtlcgogICAgICAgICAgICBXcml0ZS1Mb2cgIk9jdGFTcGFjZSBub2RlIHRva2VuIChmcm9tIHNhdmVkIG1hcmtlcik6ICRvY3RhTm9kZVRva2VuIiAiT0siCiAgICAgICAgICAgIFNldC1TdGVwICJPY3RhU3BhY2Ugbm9kZSB0b2tlbiIgIlBBU1MiICJUb2tlbjogJG9jdGFOb2RlVG9rZW4iCiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgICAgIyBGYWxsYmFjayAyOiBsZWdhY3kgZ3Vlc3NlZCBjb25maWcgcGF0aHMgKGtlcHQgaW4gY2FzZSBvc24ncyBsYXlvdXQgY2hhbmdlcykKICAgICAgICAgICAgV3JpdGUtTG9nICJObyBzYXZlZCB0b2tlbiBtYXJrZXIg4oCUIGNoZWNraW5nIG9zbiBjb25maWcgZmlsZXMuLi4iCiAgICAgICAgICAgIFN0YXJ0LVNsZWVwIDE1CiAgICAgICAgICAgICRyYXcgPSB3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tdXNlciByb290IC0tIGJhc2ggLWMgQCcKZm9yIGYgaW4gL2hvbWUvb2N0YS9vc24vZXRjL3N5cy5jb25maWcgL2V0Yy9vc24vbm9kZS5qc29uIC92YXIvbGliL29zbi9ub2RlLmpzb247IGRvCiAgICBbIC1mICIkZiIgXSB8fCBjb250aW51ZQogICAgdG9rPSQoZ3JlcCAtb1AgJyJub2RlX3Rva2VuIlxzKjpccyoiXEtbXiJdKycgIiRmIiAyPi9kZXYvbnVsbCB8fCBncmVwIC1vUCAnInRva2VuIlxzKjpccyoiXEtbXiJdKycgIiRmIiAyPi9kZXYvbnVsbCkKICAgIFsgLW4gIiR0b2siIF0gJiYgZWNobyAiJHRvayIgJiYgYnJlYWsKZG9uZQonQCAyPiYxCiAgICAgICAgICAgICRjYW5kaWRhdGUgPSAoJHJhdyB8IFdoZXJlLU9iamVjdCB7ICRfIC1tYXRjaCAnXlxzKlxTezYsfVxzKiQnIH0pIHwgU2VsZWN0LU9iamVjdCAtRmlyc3QgMQogICAgICAgICAgICBpZiAoJGNhbmRpZGF0ZSkgewogICAgICAgICAgICAgICAgJG9jdGFOb2RlVG9rZW4gPSAkY2FuZGlkYXRlLlRyaW0oKQogICAgICAgICAgICAgICAgV3JpdGUtTG9nICJPY3RhU3BhY2Ugbm9kZSB0b2tlbiAoZnJvbSBjb25maWcpOiAkb2N0YU5vZGVUb2tlbiIgIk9LIgogICAgICAgICAgICAgICAgU2V0LVN0ZXAgIk9jdGFTcGFjZSBub2RlIHRva2VuIiAiUEFTUyIgIlRva2VuOiAkb2N0YU5vZGVUb2tlbiIKICAgICAgICAgICAgfSBlbHNlIHsKICAgICAgICAgICAgICAgIFdyaXRlLUxvZyAiTm9kZSB0b2tlbiBub3QgZm91bmQg4oCUIGl0IHdpbGwgYXBwZWFyIGF0IGN1YmUub2N0YS5jb21wdXRlciBhZnRlciB0aGUgbm9kZSBjb25uZWN0cyIgIldBUk4iCiAgICAgICAgICAgICAgICBTZXQtU3RlcCAiT2N0YVNwYWNlIG5vZGUgdG9rZW4iICJXQVJOIiAiTm90IHlldCBhc3NpZ25lZCDigJQgY2hlY2sgY3ViZS5vY3RhLmNvbXB1dGVyIgogICAgICAgICAgICB9CiAgICAgICAgfQogICAgfQoKICAgICMg4pSA4pSAIE5ldHdvcmtpbmc6IFdpbmRvd3MgRmlyZXdhbGwgKyBVUG5QIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogICAgV3JpdGUtTG9nICJBZGRpbmcgV2luZG93cyBGaXJld2FsbCBpbmJvdW5kIHJ1bGVzIChUQ1AgKyBVRFApLi4uIgogICAgJGFsbFBvcnRzID0gJE9DVEFfTUdNVF9QT1JUUyArICgkT0NUQV9BUFBfUE9SVF9TVEFSVC4uJE9DVEFfQVBQX1BPUlRfRU5EKQogICAgZm9yZWFjaCAoJHBvcnQgaW4gJGFsbFBvcnRzKSB7CiAgICAgICAgTmV3LU5ldEZpcmV3YWxsUnVsZSAtRGlzcGxheU5hbWUgIlB1bHNlLU9jdGEtVENQLSRwb3J0IiAtRGlyZWN0aW9uIEluYm91bmQgYAogICAgICAgICAgICAtUHJvdG9jb2wgVENQIC1Mb2NhbFBvcnQgJHBvcnQgLUFjdGlvbiBBbGxvdyAtRXJyb3JBY3Rpb24gU2lsZW50bHlDb250aW51ZSB8IE91dC1OdWxsCiAgICAgICAgTmV3LU5ldEZpcmV3YWxsUnVsZSAtRGlzcGxheU5hbWUgIlB1bHNlLU9jdGEtVURQLSRwb3J0IiAtRGlyZWN0aW9uIEluYm91bmQgYAogICAgICAgICAgICAtUHJvdG9jb2wgVURQIC1Mb2NhbFBvcnQgJHBvcnQgLUFjdGlvbiBBbGxvdyAtRXJyb3JBY3Rpb24gU2lsZW50bHlDb250aW51ZSB8IE91dC1OdWxsCiAgICB9CiAgICBXcml0ZS1Mb2cgIkZpcmV3YWxsIHJ1bGVzIGFkZGVkIChUQ1ArVURQKSBmb3IgcG9ydHMgJCgkT0NUQV9NR01UX1BPUlRTIC1qb2luICcsICcpICsgJE9DVEFfQVBQX1BPUlRfU1RBUlQtJE9DVEFfQVBQX1BPUlRfRU5EIiAiT0siCiAgICBTZXQtU3RlcCAiV2luZG93cyBGaXJld2FsbCBydWxlcyIgIlBBU1MiICJUQ1ArVURQICQoJE9DVEFfTUdNVF9QT1JUUyAtam9pbiAnLCAnKSwgJE9DVEFfQVBQX1BPUlRfU1RBUlQtJE9DVEFfQVBQX1BPUlRfRU5EIgoKICAgIFdyaXRlLUxvZyAiQXR0ZW1wdGluZyBVUG5QIGF1dG9tYXRpYyBwb3J0IGZvcndhcmRpbmcuLi4iCiAgICAkbG9jYWxJUCA9IEdldC1Mb2NhbElQCiAgICAkdXBucE9rICA9ICRmYWxzZQogICAgdHJ5IHsKICAgICAgICAkdXBucCAgICAgPSBOZXctT2JqZWN0IC1Db21PYmplY3QgSE5ldENmZy5OQVRVUG5QCiAgICAgICAgJG1hcHBpbmdzID0gJHVwbnAuU3RhdGljUG9ydE1hcHBpbmdDb2xsZWN0aW9uCiAgICAgICAgZm9yZWFjaCAoJHBvcnQgaW4gJGFsbFBvcnRzKSB7CiAgICAgICAgICAgICRtYXBwaW5ncy5BZGQoJHBvcnQsICJUQ1AiLCAkcG9ydCwgJGxvY2FsSVAsICR0cnVlLCAiUHVsc2UtT2N0YS1UQ1AtJHBvcnQiKSB8IE91dC1OdWxsCiAgICAgICAgICAgICRtYXBwaW5ncy5BZGQoJHBvcnQsICJVRFAiLCAkcG9ydCwgJGxvY2FsSVAsICR0cnVlLCAiUHVsc2UtT2N0YS1VRFAtJHBvcnQiKSB8IE91dC1OdWxsCiAgICAgICAgfQogICAgICAgIFdyaXRlLUxvZyAiVVBuUCBzdWNjZWVkZWQg4oCUIHBvcnRzICQoJE9DVEFfTUdNVF9QT1JUUyAtam9pbiAnLCAnKSwgJE9DVEFfQVBQX1BPUlRfU1RBUlQtJE9DVEFfQVBQX1BPUlRfRU5EIGZvcndhcmRlZCAoVENQK1VEUCkgdG8gJGxvY2FsSVAiICJPSyIKICAgICAgICBTZXQtU3RlcCAiVVBuUCBwb3J0IGZvcndhcmRpbmciICJQQVNTIiAiQXV0by1mb3J3YXJkZWQgKFRDUCtVRFApIOKGkiAkbG9jYWxJUCIKICAgICAgICAkdXBucE9rID0gJHRydWUKICAgIH0gY2F0Y2ggewogICAgICAgIFdyaXRlLUxvZyAiVVBuUCB1bmF2YWlsYWJsZSBvbiB0aGlzIHJvdXRlciIgIldBUk4iCiAgICAgICAgU2V0LVN0ZXAgIlVQblAgcG9ydCBmb3J3YXJkaW5nIiAiV0FSTiIgIlVQblAgdW5hdmFpbGFibGUg4oCUIG1hbnVhbCByb3V0ZXIgc2V0dXAgcmVxdWlyZWQgKFRDUCtVRFAsIHNlZSBhYm92ZSkiCiAgICB9CgogICAgaWYgKC1ub3QgJHVwbnBPaykgewogICAgICAgIFdyaXRlLUhvc3QgIiIKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUjOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUkCIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgUk9VVEVSIFNFVFVQIFJFUVVJUkVEIChvbmUtdGltZSwgfjIgbWludXRlcykgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgIFlvdXIgcm91dGVyIGRvZXNuJ3Qgc3VwcG9ydCBhdXRvLWZvcndhcmRpbmcgKFVQblAgb2ZmKS4gICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICBPY3RhU3BhY2UgbmVlZHMgQk9USCBUQ1AgYW5kIFVEUCBmb3J3YXJkZWQuICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICAxLiBPcGVuIHlvdXIgcm91dGVyIGFkbWluIHBhZ2UgKHVzdWFsbHkgaHR0cDovLzE5Mi4xNjguMS4xKeKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgMi4gRmluZCAnUG9ydCBGb3J3YXJkaW5nJyBvciAnVmlydHVhbCBTZXJ2ZXInICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgIDMuIEFkZCBUQ1ArVURQIHJ1bGVzIOKGkiAkbG9jYWxJUCA6ICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgVENQK1VEUCAxODg4OCDihpIgJGxvY2FsSVBgOjE4ODg4ICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgVENQK1VEUCAkT0NUQV9BUFBfUE9SVF9TVEFSVC0kT0NUQV9BUFBfUE9SVF9FTkQg4oaSICRsb2NhbElQYDokT0NUQV9BUFBfUE9SVF9TVEFSVC0kT0NUQV9BUFBfUE9SVF9FTkQg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgIFByZXNzIEVudGVyIG9uY2UgZG9uZSAoeW91IGNhbiBmaW5pc2ggdGhpcyBsYXRlciB2aWEgdGhlICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICBQdWxzZSBkYXNoYm9hcmQg4oCUIGJ1dCBqb2JzIHdvbid0IGxhbmQgdW50aWwgaXQncyBkb25lKSAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSU4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSYIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgICAgIFJlYWQtSG9zdCAiICBQcmVzcyBFbnRlciB0byBjb250aW51ZSIKICAgIH0KCiAgICAjIOKUgOKUgCBXU0wyIFBvcnQgUHJveHkgKFRDUCBvbmx5KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAgIGlmICgtbm90ICRtaXJyb3JlZE5ldHdvcmtpbmcpIHsKICAgICAgICBXcml0ZS1Mb2cgIkNvbmZpZ3VyaW5nIFdTTDIgVENQIHBvcnQgcHJveHkgKFdpbmRvd3MgaG9zdCDihpIgV1NMMiBicmlkZ2UpLi4uIgogICAgICAgICR3c2xJUCA9ICh3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tdXNlciByb290IC0tIGJhc2ggLWMgImhvc3RuYW1lIC1JIDI+L2Rldi9udWxsIikuVHJpbSgpLlNwbGl0KClbMF0KICAgICAgICBpZiAoJHdzbElQKSB7CiAgICAgICAgICAgIFNldC1XU0wyUG9ydFByb3h5IC1Xc2xJUCAkd3NsSVAKICAgICAgICAgICAgU2V0LUNvbnRlbnQgLVBhdGggIiRQVUxTRV9ESVJcbGFzdF93c2xfaXAiIC1WYWx1ZSAkd3NsSVAgLUVuY29kaW5nIFVURjgKICAgICAgICAgICAgU2V0LVN0ZXAgIldTTDIgcG9ydCBwcm94eSIgIlBBU1MiICJUQ1Ag4oaSICR3c2xJUCAoVURQIHJlcXVpcmVzIG1pcnJvcmVkIG5ldHdvcmtpbmcpIgogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICAgIFdyaXRlLUxvZyAiQ291bGQgbm90IGRldGVybWluZSBXU0wyIElQIOKAlCBwb3J0cHJveHkgc2tpcHBlZDsgd2lsbCByZXRyeSBvbiBuZXh0IGxvZ2luIiAiV0FSTiIKICAgICAgICAgICAgU2V0LVN0ZXAgIldTTDIgcG9ydCBwcm94eSIgIldBUk4iICJXU0wyIElQIG5vdCBmb3VuZCDigJQgd2lsbCByZXRyeSBvbiBuZXh0IGxvZ2luIgogICAgICAgIH0KICAgIH0gZWxzZSB7CiAgICAgICAgV3JpdGUtTG9nICJNaXJyb3JlZCBuZXR3b3JraW5nIGFjdGl2ZSDigJQgcG9ydHByb3h5IG5vdCBuZWVkZWQ7IFVEUCB0dW5uZWxzIGZ1bGx5IGZ1bmN0aW9uYWwiICJPSyIKICAgICAgICBTZXQtU3RlcCAiV1NMMiBwb3J0IHByb3h5IiAiU0tJUCIgIk5vdCBuZWVkZWQg4oCUIG1pcnJvcmVkIG5ldHdvcmtpbmcgYWN0aXZlIgogICAgfQoKICAgICMg4pSA4pSAIEN1YmUgcmVnaXN0cmF0aW9uIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogICAgV3JpdGUtSG9zdCAiIgogICAgV3JpdGUtSG9zdCAiICDilIzilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilJAiIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbgogICAgV3JpdGUtSG9zdCAiICDilIIgIE9DVEFTUEFDRSBDVUJFIFJFR0lTVFJBVElPTiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbgogICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBDeWFuCiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgVG8gYXBwZWFyIGluIHRoZSBPY3RhU3BhY2UgbWFya2V0cGxhY2U6ICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4KICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgIDEuIE9wZW46IGh0dHBzOi8vY3ViZS5vY3RhLmNvbXB1dGVyICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbgogICAgV3JpdGUtSG9zdCAiICDilIIgICAgMi4gU2lnbiBpbiAvIGNyZWF0ZSBhbiBhY2NvdW50ICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBDeWFuCiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAzLiBBZGQgeW91ciBub2RlIOKAlCBpdCBzaG91bGQgYXBwZWFyIGF1dG9tYXRpY2FsbHkgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbgogICAgaWYgKCRvY3RhTm9kZVRva2VuKSB7CiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4KICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgIFlvdXIgbm9kZSB0b2tlbjogJG9jdGFOb2RlVG9rZW4iIC1Gb3JlZ3JvdW5kQ29sb3IgV2hpdGUKICAgIH0KICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbgogICAgV3JpdGUtSG9zdCAiICDilIIgIFRoaXMgc3RlcCBpcyBkb25lIGluIHlvdXIgYnJvd3Nlciwgbm90IHRoaXMgd2luZG93LiAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBDeWFuCiAgICBXcml0ZS1Ib3N0ICIgIOKUlOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUmCIgLUZvcmVncm91bmRDb2xvciBDeWFuCiAgICBXcml0ZS1Ib3N0ICIiCiAgICBSZWFkLUhvc3QgIiAgUHJlc3MgRW50ZXIgdG8gY29udGludWUgb25jZSB5b3UndmUgbm90ZWQgdGhlIGFib3ZlIgoKICAgICMg4pSA4pSAIFJlZ2lzdGVyIHdpdGggUHVsc2Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgICBXcml0ZS1Mb2cgIlJlZ2lzdGVyaW5nIG1hY2hpbmUgd2l0aCBQdWxzZS4uLiIKCiAgICAkYm9keSA9IEB7CiAgICAgICAgZ3B1X21vZGVsICAgICAgICA9ICRncHVOYW1lCiAgICAgICAgdnJhbV9nYiAgICAgICAgICA9ICR2cmFtR2IKICAgICAgICBvY3RhX25vZGVfdG9rZW4gID0gJG9jdGFOb2RlVG9rZW4KICAgICAgICBwbGF0Zm9ybSAgICAgICAgID0gIk9jdGFTcGFjZSIKICAgIH0gfCBDb252ZXJ0VG8tSnNvbgoKICAgIHRyeSB7CiAgICAgICAgJHJlc3AgPSBJbnZva2UtUmVzdE1ldGhvZCAtVXJpICIkUFVMU0VfQVBJX0JBU0UvcmVnaXN0ZXJPY3Rhc3BhY2VEYWVtb24iIGAKICAgICAgICAgICAgLU1ldGhvZCBQT1NUIGAKICAgICAgICAgICAgLUNvbnRlbnRUeXBlICJhcHBsaWNhdGlvbi9qc29uIiBgCiAgICAgICAgICAgIC1IZWFkZXJzIEB7ICJBdXRob3JpemF0aW9uIiA9ICJCZWFyZXIgJFBVTFNFX1VTRVJfVE9LRU4iIH0gYAogICAgICAgICAgICAtQm9keSAkYm9keQogICAgICAgIFdyaXRlLUxvZyAiUHVsc2UgcmVnaXN0cmF0aW9uOiAkKCRyZXNwLm1lc3NhZ2UpIiAiT0siCiAgICAgICAgU2V0LVN0ZXAgIlB1bHNlIHJlZ2lzdHJhdGlvbiIgIlBBU1MiCiAgICB9IGNhdGNoIHsKICAgICAgICBXcml0ZS1Mb2cgIlB1bHNlIHJlZ2lzdHJhdGlvbiBmYWlsZWQgKHdpbGwgcmV0cnkgb24gbmV4dCBzdGFydCk6ICRfIiAiV0FSTiIKICAgICAgICBTZXQtU3RlcCAiUHVsc2UgcmVnaXN0cmF0aW9uIiAiV0FSTiIgIldpbGwgcmV0cnkgYXV0b21hdGljYWxseSBvbiBuZXh0IGxvZ2luIgogICAgfQoKICAgICMg4pSA4pSAIFdTTCBLZWVwYWxpdmUgV2F0Y2hkb2cg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgICBXcml0ZS1Mb2cgIkluc3RhbGxpbmcgV1NMIGtlZXBhbGl2ZSB3YXRjaGRvZy4uLiIKICAgICR3YXRjaGRvZyA9IEAnCiR3ZExvZyA9ICIkZW52OkxPQ0FMQVBQREFUQVxQdWxzZVxvY3RhX3dhdGNoZG9nLmxvZyIKJGtlZXBhbGl2ZVBpZCA9ICRudWxsCgpmdW5jdGlvbiBFbnN1cmUtV1NMQWxpdmUgewogICAgaWYgKCRudWxsIC1lcSAka2VlcGFsaXZlUGlkIC1vciAtbm90IChHZXQtUHJvY2VzcyAtSWQgJGtlZXBhbGl2ZVBpZCAtRXJyb3JBY3Rpb24gU2lsZW50bHlDb250aW51ZSkpIHsKICAgICAgICAkcCA9IFN0YXJ0LVByb2Nlc3MgIndzbC5leGUiIC1Bcmd1bWVudExpc3QgIi1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICd3aGlsZSB0cnVlOyBkbyBzbGVlcCAzNjAwOyBkb25lJyIgLVBhc3NUaHJ1IC1XaW5kb3dTdHlsZSBIaWRkZW4gLUVycm9yQWN0aW9uIFNpbGVudGx5Q29udGludWUKICAgICAgICBpZiAoJHApIHsKICAgICAgICAgICAgJHNjcmlwdDprZWVwYWxpdmVQaWQgPSAkcC5JZAogICAgICAgICAgICBBZGQtQ29udGVudCAkd2RMb2cgIiQoR2V0LURhdGUgLWYgJ3l5eXktTU0tZGQgSEg6bW0nKSBXU0wga2VlcGFsaXZlIHN0YXJ0ZWQgKFBJRCAkKCRwLklkKSkiCiAgICAgICAgfQogICAgfQp9CgpFbnN1cmUtV1NMQWxpdmUKQWRkLUNvbnRlbnQgJHdkTG9nICIkKEdldC1EYXRlIC1mICd5eXl5LU1NLWRkIEhIOm1tJykgV2F0Y2hkb2cgc3RhcnRlZCIKCndoaWxlICgkdHJ1ZSkgewogICAgdHJ5IHsgRW5zdXJlLVdTTEFsaXZlIH0gY2F0Y2gge30KICAgIFN0YXJ0LVNsZWVwIDMwCn0KJ0AKICAgICR3YXRjaGRvZ1BhdGggPSAiJFBVTFNFX0RJUlxvY3RhX3dhdGNoZG9nLnBzMSIKICAgIFNldC1Db250ZW50IC1QYXRoICR3YXRjaGRvZ1BhdGggLVZhbHVlICR3YXRjaGRvZyAtRW5jb2RpbmcgVVRGOAoKICAgICR3QSA9IE5ldy1TY2hlZHVsZWRUYXNrQWN0aW9uIC1FeGVjdXRlICJwb3dlcnNoZWxsLmV4ZSIgYAogICAgICAgIC1Bcmd1bWVudCAiLU5vUHJvZmlsZSAtRXhlY3V0aW9uUG9saWN5IEJ5cGFzcyAtV2luZG93U3R5bGUgSGlkZGVuIC1GaWxlIGAiJHdhdGNoZG9nUGF0aGAiIgogICAgJHdUID0gTmV3LVNjaGVkdWxlZFRhc2tUcmlnZ2VyIC1BdExvZ09uCiAgICAkd1MgPSBOZXctU2NoZWR1bGVkVGFza1NldHRpbmdzU2V0IC1BbGxvd1N0YXJ0SWZPbkJhdHRlcmllcyAtRXhlY3V0aW9uVGltZUxpbWl0IDAKICAgICR3UCA9IE5ldy1TY2hlZHVsZWRUYXNrUHJpbmNpcGFsIC1Vc2VySWQgJGVudjpVU0VSTkFNRSAtUnVuTGV2ZWwgSGlnaGVzdAogICAgUmVnaXN0ZXItU2NoZWR1bGVkVGFzayAtVGFza05hbWUgJFdBVENIRE9HX1RBU0sgLUFjdGlvbiAkd0EgLVRyaWdnZXIgJHdUIGAKICAgICAgICAtU2V0dGluZ3MgJHdTIC1QcmluY2lwYWwgJHdQIC1Gb3JjZSB8IE91dC1OdWxsCiAgICBXcml0ZS1Mb2cgIkdQVSB3YXRjaGRvZyBpbnN0YWxsZWQgKHBhdXNlcyBkdXJpbmcgZ2FtaW5nLCByZXN1bWVzIHdoZW4gaWRsZSkiICJPSyIKICAgIFNldC1TdGVwICJHUFUgd2F0Y2hkb2cgdGFzayIgIlBBU1MiCgogICAgIyDilIDilIAgQXV0by1zdGFydDogb3NuIG9uIGV2ZXJ5IGxvZ2luIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogICAgV3JpdGUtTG9nICJJbnN0YWxsaW5nIGF1dG8tc3RhcnQgdGFzay4uLiIKICAgICRhdXRvc3RhcnQgPSBpZiAoJG1pcnJvcmVkTmV0d29ya2luZykgewogICAgICAgIEAnClN0YXJ0LVNsZWVwIDE1CndzbCAtZCBVYnVudHUtMjIuMDQgLS0gYmFzaCAtYyAnc3VkbyBzeXN0ZW1jdGwgc3RhcnQgb3NuIDI+L2Rldi9udWxsJyAyPiYxIHwKICAgIEFkZC1Db250ZW50ICIkZW52OkxPQ0FMQVBQREFUQVxQdWxzZVxvY3RhX2F1dG9zdGFydC5sb2ciCidACiAgICB9IGVsc2UgewogICAgICAgIEAiClN0YXJ0LVNsZWVwIDE1CmAkd3NsSVAgPSAod3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICdob3N0bmFtZSAtSSAyPi9kZXYvbnVsbCcpLlRyaW0oKS5TcGxpdCgpWzBdCmAkbGFzdElQRmlsZSA9ICJgJGVudjpMT0NBTEFQUERBVEFcUHVsc2VcbGFzdF93c2xfaXAiCmAkbGFzdElQID0gaWYgKFRlc3QtUGF0aCBgJGxhc3RJUEZpbGUpIHsgKEdldC1Db250ZW50IGAkbGFzdElQRmlsZSkuVHJpbSgpIH0gZWxzZSB7ICcnIH0KaWYgKGAkd3NsSVAgLWFuZCBgJHdzbElQIC1uZSBgJGxhc3RJUCkgewogICAgKEAoMTg4ODgpICsgKDUxODAwLi41MTgxNikpIHwgRm9yRWFjaC1PYmplY3QgewogICAgICAgIG5ldHNoIGludGVyZmFjZSBwb3J0cHJveHkgZGVsZXRlIHY0dG92NCBsaXN0ZW5wb3J0PWAkXyBsaXN0ZW5hZGRyZXNzPTAuMC4wLjAgfCBPdXQtTnVsbAogICAgICAgIG5ldHNoIGludGVyZmFjZSBwb3J0cHJveHkgYWRkIHY0dG92NCBsaXN0ZW5wb3J0PWAkXyBsaXN0ZW5hZGRyZXNzPTAuMC4wLjAgY29ubmVjdHBvcnQ9YCRfIGNvbm5lY3RhZGRyZXNzPWAkd3NsSVAgfCBPdXQtTnVsbAogICAgfQogICAgU2V0LUNvbnRlbnQgLVBhdGggYCRsYXN0SVBGaWxlIC1WYWx1ZSBgJHdzbElQCn0Kd3NsIC1kIFVidW50dS0yMi4wNCAtLSBiYXNoIC1jICdzdWRvIHN5c3RlbWN0bCBzdGFydCBvc24gMj4vZGV2L251bGwnIDI+JjEgfAogICAgQWRkLUNvbnRlbnQgImAkZW52OkxPQ0FMQVBQREFUQVxQdWxzZVxvY3RhX2F1dG9zdGFydC5sb2ciCiJACiAgICB9CiAgICAkc3RhcnRQYXRoID0gIiRQVUxTRV9ESVJcb2N0YV9hdXRvc3RhcnQucHMxIgogICAgU2V0LUNvbnRlbnQgLVBhdGggJHN0YXJ0UGF0aCAtVmFsdWUgJGF1dG9zdGFydCAtRW5jb2RpbmcgVVRGOAoKICAgICRzQSA9IE5ldy1TY2hlZHVsZWRUYXNrQWN0aW9uIC1FeGVjdXRlICJwb3dlcnNoZWxsLmV4ZSIgYAogICAgICAgIC1Bcmd1bWVudCAiLU5vUHJvZmlsZSAtRXhlY3V0aW9uUG9saWN5IEJ5cGFzcyAtV2luZG93U3R5bGUgSGlkZGVuIC1GaWxlIGAiJHN0YXJ0UGF0aGAiIgogICAgJHNUID0gTmV3LVNjaGVkdWxlZFRhc2tUcmlnZ2VyIC1BdExvZ09uCiAgICAkc1MgPSBOZXctU2NoZWR1bGVkVGFza1NldHRpbmdzU2V0IC1BbGxvd1N0YXJ0SWZPbkJhdHRlcmllcyAtRXhlY3V0aW9uVGltZUxpbWl0IDAKICAgICRzUCA9IE5ldy1TY2hlZHVsZWRUYXNrUHJpbmNpcGFsIC1Vc2VySWQgJGVudjpVU0VSTkFNRSAtUnVuTGV2ZWwgSGlnaGVzdAogICAgUmVnaXN0ZXItU2NoZWR1bGVkVGFzayAtVGFza05hbWUgJEFVVE9TVEFSVF9UQVNLIC1BY3Rpb24gJHNBIC1UcmlnZ2VyICRzVCBgCiAgICAgICAgLVNldHRpbmdzICRzUyAtUHJpbmNpcGFsICRzUCAtRm9yY2UgfCBPdXQtTnVsbAogICAgV3JpdGUtTG9nICJBdXRvLXN0YXJ0IGluc3RhbGxlZCIgIk9LIgogICAgU2V0LVN0ZXAgIkF1dG8tc3RhcnQgdGFzayIgIlBBU1MiCgogICAgIyDilIDilIAgQXV0by1sb2dpbjogc3Vydml2ZSB1bmF0dGVuZGVkIHJlYm9vdHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgICBXcml0ZS1Ib3N0ICIiCiAgICBXcml0ZS1Ib3N0ICIgIOKUjOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUkCIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgIFdyaXRlLUhvc3QgIiAg4pSCICBBVVRPLUxPR0lOIChyZWNvbW1lbmRlZCBmb3IgZGVkaWNhdGVkIEdQVSBzZXJ2ZXJzKSAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgV3JpdGUtSG9zdCAiICDilIIgIFdpdGhvdXQgdGhpcywgT2N0YVNwYWNlIGdvZXMgT0ZGTElORSBhZnRlciBhbnkgdW5hdHRlbmRlZCAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgV3JpdGUtSG9zdCAiICDilIIgIHJlYm9vdCAocG93ZXIgY3V0LCBXaW5kb3dzIFVwZGF0ZSkgdW50aWwgc29tZW9uZSBsb2dzIGluLiAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgIFdyaXRlLUhvc3QgIiAg4pSCICBUcmFkZS1vZmY6IHN0b3JlcyB5b3VyIFdpbmRvd3MgcGFzc3dvcmQgaW4gdGhlIHJlZ2lzdHJ5LiAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgIFdyaXRlLUhvc3QgIiAg4pSCICBPbmx5IGVuYWJsZSBpZiB0aGlzIG1hY2hpbmUgaXMgaW4gYSBwaHlzaWNhbGx5IHNlY3VyZSBzcG90LuKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgIFdyaXRlLUhvc3QgIiAg4pSCICBUbyB1bmRvIGxhdGVyOiBydW4gbmV0cGx3aXogYW5kIHJlLWVuYWJsZSBwYXNzd29yZCBwcm9tcHQuIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgIFdyaXRlLUhvc3QgIiAg4pSU4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSYIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgV3JpdGUtSG9zdCAiIgogICAgJGRvQXV0b0xvZ2luID0gUmVhZC1Ib3N0ICIgIEVuYWJsZSBhdXRvLWxvZ2luPyAoeS9OKSIKICAgIGlmICgkZG9BdXRvTG9naW4gLW1hdGNoICdeW1l5XScpIHsKICAgICAgICAkc2VjdXJlUGFzcyA9IFJlYWQtSG9zdCAiICBFbnRlciB5b3VyIFdpbmRvd3MgbG9naW4gcGFzc3dvcmQiIC1Bc1NlY3VyZVN0cmluZwogICAgICAgICRic3RyICAgICAgPSBbUnVudGltZS5JbnRlcm9wU2VydmljZXMuTWFyc2hhbF06OlNlY3VyZVN0cmluZ1RvQlNUUigkc2VjdXJlUGFzcykKICAgICAgICAkcGxhaW5QYXNzID0gW1J1bnRpbWUuSW50ZXJvcFNlcnZpY2VzLk1hcnNoYWxdOjpQdHJUb1N0cmluZ0F1dG8oJGJzdHIpCiAgICAgICAgW1J1bnRpbWUuSW50ZXJvcFNlcnZpY2VzLk1hcnNoYWxdOjpaZXJvRnJlZUJTVFIoJGJzdHIpCgogICAgICAgICRyZWdQYXRoID0gIkhLTE06XFNPRlRXQVJFXE1pY3Jvc29mdFxXaW5kb3dzIE5UXEN1cnJlbnRWZXJzaW9uXFdpbmxvZ29uIgogICAgICAgIFNldC1JdGVtUHJvcGVydHkgLVBhdGggJHJlZ1BhdGggLU5hbWUgIkF1dG9BZG1pbkxvZ29uIiAgIC1WYWx1ZSAiMSIgICAgICAgICAgICAgLVR5cGUgU3RyaW5nCiAgICAgICAgU2V0LUl0ZW1Qcm9wZXJ0eSAtUGF0aCAkcmVnUGF0aCAtTmFtZSAiRGVmYXVsdFVzZXJuYW1lIiAgIC1WYWx1ZSAkZW52OlVTRVJOQU1FICAgLVR5cGUgU3RyaW5nCiAgICAgICAgU2V0LUl0ZW1Qcm9wZXJ0eSAtUGF0aCAkcmVnUGF0aCAtTmFtZSAiRGVmYXVsdERvbWFpbk5hbWUiIC1WYWx1ZSAkZW52OlVTRVJET01BSU4gLVR5cGUgU3RyaW5nCiAgICAgICAgU2V0LUl0ZW1Qcm9wZXJ0eSAtUGF0aCAkcmVnUGF0aCAtTmFtZSAiRGVmYXVsdFBhc3N3b3JkIiAgIC1WYWx1ZSAkcGxhaW5QYXNzICAgICAgLVR5cGUgU3RyaW5nCiAgICAgICAgJHBsYWluUGFzcyA9ICRudWxsOyBbU3lzdGVtLkdDXTo6Q29sbGVjdCgpCgogICAgICAgIFdyaXRlLUxvZyAiQXV0by1sb2dpbiBlbmFibGVkIGZvciAkZW52OlVTRVJOQU1FIOKAlCBPY3RhU3BhY2UgcmVzdW1lcyBhdXRvbWF0aWNhbGx5IGFmdGVyIGFueSByZWJvb3QiICJPSyIKICAgICAgICBXcml0ZS1Mb2cgIlRvIGRpc2FibGU6IHJ1biBuZXRwbHdpeiBhbmQgcmUtY2hlY2sgJ1VzZXJzIG11c3QgZW50ZXIgYSB1c2VybmFtZSBhbmQgcGFzc3dvcmQnIiAiSU5GTyIKICAgICAgICBTZXQtU3RlcCAiQXV0by1sb2dpbiIgIlBBU1MiICJFbmFibGVkIGZvciAkZW52OlVTRVJOQU1FIgogICAgfSBlbHNlIHsKICAgICAgICBXcml0ZS1Mb2cgIkF1dG8tbG9naW4gc2tpcHBlZCDigJQgbWFjaGluZSB3aWxsIG5lZWQgYSBtYW51YWwgbG9naW4gYWZ0ZXIgcmVib290IHRvIHJlc3VtZSBPY3RhU3BhY2UiICJXQVJOIgogICAgICAgIFNldC1TdGVwICJBdXRvLWxvZ2luIiAiU0tJUCIgIlNraXBwZWQg4oCUIEdQVSBnb2VzIG9mZmxpbmUgYWZ0ZXIgdW5hdHRlbmRlZCByZWJvb3RzIgogICAgfQoKICAgICMg4pSA4pSAIENsZWFudXAg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgICBzY2h0YXNrcyAvZGVsZXRlIC90biAkVEFTS19OQU1FIC9mIDI+JG51bGwgfCBPdXQtTnVsbAogICAgUmVtb3ZlLUl0ZW0gJFBIQVNFX0ZJTEUgLUVycm9yQWN0aW9uIFNpbGVudGx5Q29udGludWUKCiAgICAjIOKUgOKUgCBTdW1tYXJ5IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogICAgIyBXcml0ZSBmaW5hbCBkaWFnbm9zdGljcyBzbmFwc2hvdCB0byBsb2cgKHNjcmVlbiBvdXRwdXQgaXMgdGhlIGNsZWFuIHN1bW1hcnkgYmVsb3cpCiAgICBTaG93LURpYWdub3N0aWNzIC1Mb2dPbmx5CgogICAgU2hvdy1CYW5uZXIgIlNldHVwIENvbXBsZXRlIgogICAgV3JpdGUtSG9zdCAiICBZb3VyIEdQVSBpcyBub3cgZWFybmluZyB2aWEgUHVsc2UgKyBPY3RhU3BhY2UuIiAtRm9yZWdyb3VuZENvbG9yIEdyZWVuCiAgICBXcml0ZS1Ib3N0ICIiCiAgICBAKAogICAgICAgIEB7IEwgPSAiR1BVIjsgICAgICAgICAgViA9ICRncHVOYW1lIH0sCiAgICAgICAgQHsgTCA9ICJWUkFNIjsgICAgICAgICBWID0gIiR7dnJhbUdifSBHQiIgfSwKICAgICAgICBAeyBMID0gIlBsYXRmb3JtIjsgICAgIFYgPSAiT2N0YVNwYWNlICh2aWEgUHVsc2UpIiB9LAogICAgICAgIEB7IEwgPSAiTm9kZSB0b2tlbiI7ICAgViA9IGlmICgkb2N0YU5vZGVUb2tlbikgeyAkb2N0YU5vZGVUb2tlbiB9IGVsc2UgeyAiUGVuZGluZyDigJQgY2hlY2sgY3ViZS5vY3RhLmNvbXB1dGVyIiB9IH0sCiAgICAgICAgQHsgTCA9ICJXU0wga2VlcGFsaXZlIjsgViA9ICJBY3RpdmUgKHdhdGNoZG9nIHJ1bm5pbmcpIiB9LAogICAgICAgIEB7IEwgPSAiQXV0by1zdGFydCI7ICAgViA9ICJPbiBldmVyeSBXaW5kb3dzIGxvZ2luIiB9LAogICAgICAgIEB7IEwgPSAiTG9ncyI7ICAgICAgICAgViA9ICRMT0dfRklMRSB9CiAgICApIHwgRm9yRWFjaC1PYmplY3QgeyBXcml0ZS1Ib3N0ICgiICB7MCwtMTZ9IHsxfSIgLWYgJF8uTCwgJF8uVikgLUZvcmVncm91bmRDb2xvciBXaGl0ZSB9CiAgICBXcml0ZS1Ib3N0ICIiCiAgICBXcml0ZS1Ib3N0ICIgIERhc2hib2FyZDogIGh0dHBzOi8vYmVuZWZpY2lhbC1kZWVwLXdvcmstZmxvdy5iYXNlNDQuYXBwIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4KICAgIFdyaXRlLUhvc3QgIiAgQ3ViZTogICAgICAgaHR0cHM6Ly9jdWJlLm9jdGEuY29tcHV0ZXIiIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbgogICAgV3JpdGUtSG9zdCAiIgogICAgV3JpdGUtSG9zdCAiICDilIzilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilJAiIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkKICAgIFdyaXRlLUhvc3QgIiAg4pSCICBJTlNUQUxMIExPRyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkKICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkKICAgIFdyaXRlLUhvc3QgIiAg4pSCICBBIGZ1bGwgbG9nIG9mIGV2ZXJ5IGluc3RhbGwgc3RlcCB3YXMgc2F2ZWQgdG86ICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkKICAgIFdyaXRlLUhvc3QgKCIgIOKUgiAgICB7MCwtNjB94pSCIiAtZiAkTE9HX0ZJTEUpIC1Gb3JlZ3JvdW5kQ29sb3IgV2hpdGUKICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkKICAgIFdyaXRlLUhvc3QgIiAg4pSCICBUbyBvcGVuIGl0OiAgIG5vdGVwYWQgYCIkTE9HX0ZJTEVgIiIgLUZvcmVncm91bmRDb2xvciBEYXJrR3JheQogICAgV3JpdGUtSG9zdCAiICDilIIgIFRvIGJyb3dzZTogICAgUnVuIOKGkiAlTE9DQUxBUFBEQVRBJVxQdWxzZSAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5CiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5CiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgU2hhcmUgaXQgd2l0aCBQdWxzZSBzdXBwb3J0IGlmIGFueXRoaW5nIGxvb2tzIHdyb25nLiAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5CiAgICBXcml0ZS1Ib3N0ICIgIOKUlOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUmCIgLUZvcmVncm91bmRDb2xvciBEYXJrR3JheQogICAgV3JpdGUtSG9zdCAiIgogICAgV2FpdC1Gb3JLZXkKfQoKIyDilIDilIAgRW50cnkgUG9pbnQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgp0cmFwIHsKICAgIFdyaXRlLUhvc3QgIiIKICAgIFdyaXRlLUhvc3QgIiAgW0VSUk9SXSBBbiB1bmV4cGVjdGVkIGVycm9yIHN0b3BwZWQgdGhlIGluc3RhbGxlcjoiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkCiAgICBXcml0ZS1Ib3N0ICIgICRfIiAtRm9yZWdyb3VuZENvbG9yIFJlZAogICAgU2hvdy1EaWFnbm9zdGljcwogICAgUmVhZC1Ib3N0ICIgIFByZXNzIEVudGVyIHRvIGNsb3NlIHRoaXMgd2luZG93IgogICAgZXhpdCAxCn0KCkFzc2VydC1BZG1pbgpOZXctSXRlbSAtSXRlbVR5cGUgRGlyZWN0b3J5IC1Gb3JjZSAtUGF0aCAkUFVMU0VfRElSIHwgT3V0LU51bGwKCiRwaGFzZSA9IGlmIChUZXN0LVBhdGggJFBIQVNFX0ZJTEUpIHsgR2V0LUNvbnRlbnQgJFBIQVNFX0ZJTEUgfSBlbHNlIHsgIjEiIH0Kc3dpdGNoICgkcGhhc2UpIHsKICAgICIxIiAgICAgeyBJbnZva2UtUGhhc2UxIH0KICAgICIyIiAgICAgeyBJbnZva2UtUGhhc2UyIH0KICAgIGRlZmF1bHQgeyBXcml0ZS1Ib3N0ICJVbmtub3duIHBoYXNlOiAkcGhhc2UiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkOyBXYWl0LUZvcktleTsgZXhpdCAxIH0KfQo=';
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
