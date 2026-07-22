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
rm -f /usr/local/bin/nvidia-smi; NV=/usr/lib/wsl/lib/nvidia-smi; [ ! -f "$NV" ] && NV=$(find /usr/lib/wsl -name nvidia-smi 2>/dev/null | head -1); [ -f "$NV" ] && ln -sf "$NV" /usr/local/bin/nvidia-smi && echo 'nvidia-smi symlinked OK' || echo 'WARNING: nvidia-smi not found'; pip3 install -q requests 2>&1 | tail -1; mkdir -p /opt/clore-onboarding; curl -fsSL 'https://gitlab.com/api/v4/projects/cloreai-public%2Fonboarding/repository/files/clore_onboarding.py/raw?ref=main' -o /opt/clore-onboarding/clore_onboarding.py || { echo 'ERROR: clore_onboarding.py download failed'; exit 1; }; curl -fsSL 'https://gitlab.com/api/v4/projects/cloreai-public%2Fonboarding/repository/files/specs.py/raw?ref=main' -o /opt/clore-onboarding/specs.py || { echo 'ERROR: specs.py download failed'; exit 1; }; printf '[Unit]\nDescription=Clore Fleet Onboarding Service\n\n[Service]\nType=simple\nWorkingDirectory=/opt/clore-onboarding\nExecStart=/usr/bin/python3 /opt/clore-onboarding/clore_onboarding.py --mode linux\nRestart=always\nRestartSec=10\n\n[Install]\nWantedBy=multi-user.target\n' > /etc/systemd/system/clore-onboarding.service; update-alternatives --set iptables /usr/sbin/iptables-legacy 2>/dev/null || true; update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy 2>/dev/null || true; mkdir -p /etc/docker; echo eyJpcHRhYmxlcyI6ZmFsc2UsImRlZmF1bHQtcnVudGltZSI6Im52aWRpYSIsInJ1bnRpbWVzIjp7Im52aWRpYSI6eyJwYXRoIjoibnZpZGlhLWNvbnRhaW5lci1ydW50aW1lIiwicnVudGltZUFyZ3MiOltdfX19 | base64 -d > /etc/docker/daemon.json; echo br_netfilter > /etc/modules-load.d/clore.conf; modprobe br_netfilter 2>/dev/null || true; systemctl restart docker 2>/dev/null || true; docker network prune -f 2>/dev/null; true; printf '#!/bin/bash\ncd /opt/clore-hosting/hosting\nwhile true; do\n    setsid -w /opt/clore-hosting/.miniconda-env/bin/python3 hosting.py --service\n    echo "hosting.py restarting in 5s..."\n    sleep 5\ndone\n' > /opt/clore-hosting/pulse-hosting-loop.sh; chmod +x /opt/clore-hosting/pulse-hosting-loop.sh; mkdir -p /etc/systemd/system/clore-hosting.service.d; printf '[Unit]\nAfter=docker.service\n\n[Service]\nEnvironment="PYTHONUNBUFFERED=1"\nEnvironment="PATH=/opt/clore-hosting/.miniconda-env/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"\nExecStartPre=/bin/rm -f /opt/clore-hosting/.clore-partner/host_facts/partner_interface.socket\nExecStartPre=/bin/bash -c "iptables -t nat -C POSTROUTING -s 172.16.0.0/12 ! -d 172.16.0.0/12 -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s 172.16.0.0/12 ! -d 172.16.0.0/12 -j MASQUERADE"\nExecStart=\nExecStart=/opt/clore-hosting/pulse-hosting-loop.sh\n' > /etc/systemd/system/clore-hosting.service.d/override.conf; systemctl daemon-reload; systemctl enable clore-hosting; systemctl enable clore-onboarding; echo 'Starting clore-onboarding...'; systemctl start clore-onboarding; echo 'Waiting 75s for onboarding to register...'; sleep 75; echo 'Starting clore-hosting...'; systemctl start clore-hosting || true; echo 'Disabling clore-onboarding - registration complete'; systemctl stop clore-onboarding; systemctl disable clore-onboarding; echo 'clore-onboarding disabled'
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
$hi = 75; $lo = 20; $paused = $false
$vendor = if (Get-WmiObject Win32_VideoController | Where-Object { $_.Name -match 'NVIDIA|GeForce|RTX|GTX' } | Select-Object -First 1) { 'NVIDIA' } else { 'AMD' }
while ($true) {
    try {
        $util = if ($vendor -eq 'NVIDIA') {
            [int](& nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>$null).Trim()
        } else {
            $s = Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage' -ErrorAction SilentlyContinue
            if ($s) { [int]($s.CounterSamples | Measure-Object -Property CookedValue -Maximum).Maximum } else { 0 }
        }
        if ($util -gt $hi -and -not $paused) {
            wsl -d Ubuntu-22.04 --user root -- bash -c "systemctl stop clore-hosting 2>/dev/null"
            $paused = $true
            Add-Content "$env:LOCALAPPDATA\\Pulse\\watchdog.log" "$(Get-Date -f 'HH:mm') PAUSED (GPU $util%)"
        } elseif ($util -lt $lo -and $paused) {
            wsl -d Ubuntu-22.04 --user root -- bash -c "systemctl start clore-hosting 2>/dev/null"
            $paused = $false
            Add-Content "$env:LOCALAPPDATA\\Pulse\\watchdog.log" "$(Get-Date -f 'HH:mm') RESUMED (GPU $util%)"
        }
    } catch {}
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
    Write-Log "GPU watchdog installed" "OK"

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
const OCTA_PS1_B64 = 'I1JlcXVpcmVzIC1WZXJzaW9uIDUuMQo8IwouU1lOT1BTSVMKICAgIFBVTFNFIEdQVSBQcm92aWRlciBTZXR1cCDigJQgT2N0YVNwYWNlIEluc3RhbGxlcgouREVTQ1JJUFRJT04KICAgIFBoYXNlIDE6IEVuYWJsZXMgV1NMMiwgc2NoZWR1bGVzIFBoYXNlIDIgdG8gcnVuIGFmdGVyIHJlYm9vdC4KICAgIFBoYXNlIDI6IEluc3RhbGxzIFVidW50dSwgT2N0YVNwYWNlIG5vZGUgKG9zbiksIHNldHMgdXAgbmV0d29ya2luZwogICAgICAgICAgICAgKFVQblAgKyBwb3J0cHJveHkgZm9yIFRDUCwgbWlycm9yZWQgbmV0d29ya2luZyByZWNvbW1lbmRlZCBmb3IgVURQKSwKICAgICAgICAgICAgIEdQVSBnYW1pbmcgZGV0ZWN0aW9uLCBhbmQgYXV0by1zdGFydC4KCiAgICBFbWJlZGRlZCBhdCBkb3dubG9hZCB0aW1lIGJ5IFB1bHNlJ3MgZ2VuZXJhdGVTZXR1cFNjcmlwdCBmdW5jdGlvbjoKICAgICAgUFVMU0VfVVNFUl9UT0tFTiDigJQgdXNlcidzIHNlc3Npb24gdG9rZW4gZm9yIFB1bHNlIEFQSSBjYWxsYmFjawogICAgICBQVUxTRV9BUFBfSUQgICAgIOKAlCBiYXNlNDQgYXBwIElECiM+CgojIOKUgOKUgCBFbWJlZGRlZCBieSBzZXJ2ZXIgYXQgZG93bmxvYWQgdGltZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKJFBVTFNFX1VTRVJfVE9LRU4gPSAie3tQVUxTRV9VU0VSX1RPS0VOfX0iCiRQVUxTRV9BUFBfSUQgICAgID0gInt7UFVMU0VfQVBQX0lEfX0iCiRQVUxTRV9BUElfQkFTRSAgID0gImh0dHBzOi8vYXBpLmJhc2U0NC5hcHAvYXBpL2FwcHMvJFBVTFNFX0FQUF9JRC9mdW5jdGlvbnMiCiMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgokUFVMU0VfRElSICAgICAgPSAiJGVudjpMT0NBTEFQUERBVEFcUHVsc2UiCiRQSEFTRV9GSUxFICAgICA9ICIkUFVMU0VfRElSXG9jdGFfc2V0dXBfcGhhc2UiCiRMT0dfRklMRSAgICAgICA9ICIkUFVMU0VfRElSXG9jdGFfc2V0dXAubG9nIgokVEFTS19OQU1FICAgICAgPSAiUHVsc2VPY3RhU2V0dXBSZXN1bWUiCiRXQVRDSERPR19UQVNLICA9ICJQdWxzZU9jdGFXYXRjaGRvZyIKJEFVVE9TVEFSVF9UQVNLID0gIlB1bHNlT2N0YUF1dG9TdGFydCIKCiMgT2N0YVNwYWNlIHBvcnRzIOKAlCBtYW5hZ2VtZW50IChBUEkpIGFuZCBlbmNyeXB0ZWQgdHVubmVsIHJhbmdlIChUQ1ArVURQKQokT0NUQV9NR01UX1BPUlRTICAgICA9IEAoMTg4ODgpCiRPQ1RBX0FQUF9QT1JUX1NUQVJUID0gNTE4MDAKJE9DVEFfQVBQX1BPUlRfRU5EICAgPSA1MTgxNgoKIyDilIDilIAgSGVscGVycyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCmZ1bmN0aW9uIFdyaXRlLUxvZyB7CiAgICBwYXJhbShbc3RyaW5nXSRtc2csIFtzdHJpbmddJGxldmVsID0gIklORk8iKQogICAgJHRzID0gR2V0LURhdGUgLUZvcm1hdCAiSEg6bW06c3MiCiAgICBBZGQtQ29udGVudCAtUGF0aCAkTE9HX0ZJTEUgLVZhbHVlICJbJHRzXVskbGV2ZWxdICRtc2ciIC1FbmNvZGluZyBVVEY4CiAgICBzd2l0Y2ggKCRsZXZlbCkgewogICAgICAgICJPSyIgICAgeyBXcml0ZS1Ib3N0ICIgIFtPS10gJG1zZyIgLUZvcmVncm91bmRDb2xvciBHcmVlbiB9CiAgICAgICAgIldBUk4iICB7IFdyaXRlLUhvc3QgIiAgWyEhXSAkbXNnIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdyB9CiAgICAgICAgIkVSUk9SIiB7IFdyaXRlLUhvc3QgIiAgW1hdICAkbXNnIiAtRm9yZWdyb3VuZENvbG9yIFJlZCB9CiAgICAgICAgZGVmYXVsdCB7IFdyaXRlLUhvc3QgIiAgLi4uICRtc2ciIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbiB9CiAgICB9Cn0KCmZ1bmN0aW9uIFNob3ctQmFubmVyIHsKICAgIHBhcmFtKFtzdHJpbmddJHN1YnRpdGxlID0gIiIpCiAgICBDbGVhci1Ib3N0CiAgICBXcml0ZS1Ib3N0ICIiCiAgICBXcml0ZS1Ib3N0ICIgIOKWiOKWiOKWiOKWiOKWiOKWiOKVlyDilojilojilZcgICDilojilojilZfilojilojilZcgICAgIOKWiOKWiOKWiOKWiOKWiOKWiOKWiOKVl+KWiOKWiOKWiOKWiOKWiOKWiOKWiOKVlyIgLUZvcmVncm91bmRDb2xvciBNYWdlbnRhCiAgICBXcml0ZS1Ib3N0ICIgIOKWiOKWiOKVlOKVkOKVkOKWiOKWiOKVl+KWiOKWiOKVkSAgIOKWiOKWiOKVkeKWiOKWiOKVkSAgICAg4paI4paI4pWU4pWQ4pWQ4pWQ4pWQ4pWd4paI4paI4pWU4pWQ4pWQ4pWQ4pWQ4pWdIiAtRm9yZWdyb3VuZENvbG9yIE1hZ2VudGEKICAgIFdyaXRlLUhvc3QgIiAg4paI4paI4paI4paI4paI4paI4pWU4pWd4paI4paI4pWRICAg4paI4paI4pWR4paI4paI4pWRICAgICDilojilojilojilojilojilojilojilZfilojilojilojilojilojilZcgICIgLUZvcmVncm91bmRDb2xvciBNYWdlbnRhCiAgICBXcml0ZS1Ib3N0ICIgIOKWiOKWiOKVlOKVkOKVkOKVkOKVnSDilojilojilZEgICDilojilojilZHilojilojilZEgICAgIOKVmuKVkOKVkOKVkOKVkOKWiOKWiOKVkeKWiOKWiOKVlOKVkOKVkOKVnSAgIiAtRm9yZWdyb3VuZENvbG9yIE1hZ2VudGEKICAgIFdyaXRlLUhvc3QgIiAg4paI4paI4pWRICAgICDilZrilojilojilojilojilojilojilZTilZ3ilojilojilojilojilojilojilojilZfilojilojilojilojilojilojilojilZHilojilojilojilojilojilojilojilZciIC1Gb3JlZ3JvdW5kQ29sb3IgTWFnZW50YQogICAgV3JpdGUtSG9zdCAiICDilZrilZDilZ0gICAgICDilZrilZDilZDilZDilZDilZDilZ0g4pWa4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWd4pWa4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWd4pWa4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWdIiAtRm9yZWdyb3VuZENvbG9yIE1hZ2VudGEKICAgIFdyaXRlLUhvc3QgIiIKICAgIFdyaXRlLUhvc3QgIiAgR1BVIFByb3ZpZGVyIFNldHVwIOKAlCBPY3RhU3BhY2UiIC1Gb3JlZ3JvdW5kQ29sb3IgV2hpdGUKICAgIGlmICgkc3VidGl0bGUpIHsgV3JpdGUtSG9zdCAiICAkc3VidGl0bGUiIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkgfQogICAgV3JpdGUtSG9zdCAiIgp9CgpmdW5jdGlvbiBBc3NlcnQtQWRtaW4gewogICAgaWYgKC1ub3QgKFtTZWN1cml0eS5QcmluY2lwYWwuV2luZG93c1ByaW5jaXBhbF1bU2VjdXJpdHkuUHJpbmNpcGFsLldpbmRvd3NJZGVudGl0eV06OkdldEN1cnJlbnQoKSkuSXNJblJvbGUoCiAgICAgICAgW1NlY3VyaXR5LlByaW5jaXBhbC5XaW5kb3dzQnVpbHRJblJvbGVdOjpBZG1pbmlzdHJhdG9yKSkgewogICAgICAgIFdyaXRlLUhvc3QgIiAgUmVsYXVuY2hpbmcgYXMgQWRtaW5pc3RyYXRvci4uLiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgICAgICBTdGFydC1Qcm9jZXNzIHBvd2Vyc2hlbGwgIi1Ob1Byb2ZpbGUgLUV4ZWN1dGlvblBvbGljeSBCeXBhc3MgLUZpbGUgYCIkUFNDb21tYW5kUGF0aGAiIiAtVmVyYiBSdW5BcwogICAgICAgIGV4aXQKICAgIH0KfQoKZnVuY3Rpb24gV2FpdC1Gb3JLZXkgewogICAgV3JpdGUtSG9zdCAiIgogICAgUmVhZC1Ib3N0ICIgIFByZXNzIEVudGVyIHRvIGNsb3NlIHRoaXMgd2luZG93Igp9CgojIOKUgOKUgCBEaWFnbm9zdGljcyBjaGVja2xpc3Qg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiRzY3JpcHQ6U3RlcHMgPSBbb3JkZXJlZF1Ae30KCmZ1bmN0aW9uIFJlZ2lzdGVyLVN0ZXAgewogICAgcGFyYW0oW3N0cmluZ10kbmFtZSwgW3N0cmluZ10kZml4ID0gIiIpCiAgICAkc2NyaXB0OlN0ZXBzWyRuYW1lXSA9IEB7IFN0YXR1cyA9ICJQRU5ESU5HIjsgRGV0YWlsID0gIiI7IEZpeCA9ICRmaXggfQp9CgpmdW5jdGlvbiBTZXQtU3RlcCB7CiAgICBwYXJhbShbc3RyaW5nXSRuYW1lLCBbc3RyaW5nXSRzdGF0dXMsIFtzdHJpbmddJGRldGFpbCA9ICIiKQogICAgaWYgKCRzY3JpcHQ6U3RlcHMuQ29udGFpbnMoJG5hbWUpKSB7CiAgICAgICAgJHNjcmlwdDpTdGVwc1skbmFtZV0uU3RhdHVzID0gJHN0YXR1cwogICAgICAgIGlmICgkZGV0YWlsKSB7ICRzY3JpcHQ6U3RlcHNbJG5hbWVdLkRldGFpbCA9ICRkZXRhaWwgfQogICAgfQp9CgpmdW5jdGlvbiBTaG93LURpYWdub3N0aWNzIHsKICAgIHBhcmFtKFtzd2l0Y2hdJExvZ09ubHkpCiAgICAkc2VwICAgID0gIiAgIiArICgi4pSAIiAqIDY1KQogICAgJGxvZ1NlcCA9ICLilIAiICogNjcKICAgICR0cyAgICAgPSBHZXQtRGF0ZSAtRm9ybWF0ICJ5eXl5LU1NLWRkIEhIOm1tOnNzIgoKICAgIGlmICgtbm90ICRMb2dPbmx5KSB7CiAgICAgICAgV3JpdGUtSG9zdCAiIgogICAgICAgIFdyaXRlLUhvc3QgJHNlcCAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5CiAgICAgICAgV3JpdGUtSG9zdCAiICBJTlNUQUxMIERJQUdOT1NUSUNTIiAtRm9yZWdyb3VuZENvbG9yIFdoaXRlCiAgICAgICAgV3JpdGUtSG9zdCAkc2VwIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkKICAgIH0KCiAgICBBZGQtQ29udGVudCAtUGF0aCAkTE9HX0ZJTEUgLVZhbHVlICIiIC1FbmNvZGluZyBVVEY4CiAgICBBZGQtQ29udGVudCAtUGF0aCAkTE9HX0ZJTEUgLVZhbHVlICRsb2dTZXAgLUVuY29kaW5nIFVURjgKICAgIEFkZC1Db250ZW50IC1QYXRoICRMT0dfRklMRSAtVmFsdWUgIklOU1RBTEwgRElBR05PU1RJQ1MgICR0cyIgLUVuY29kaW5nIFVURjgKICAgIEFkZC1Db250ZW50IC1QYXRoICRMT0dfRklMRSAtVmFsdWUgJGxvZ1NlcCAtRW5jb2RpbmcgVVRGOAoKICAgIGZvcmVhY2ggKCRuYW1lIGluICRzY3JpcHQ6U3RlcHMuS2V5cykgewogICAgICAgICRzICAgICA9ICRzY3JpcHQ6U3RlcHNbJG5hbWVdCiAgICAgICAgJGljb24gID0gc3dpdGNoICgkcy5TdGF0dXMpIHsgIlBBU1MiIHsiW09LXSJ9ICJGQUlMIiB7IltYXSAifSAiV0FSTiIgeyJbISFdIn0gIlNLSVAiIHsiWy0tXSJ9IGRlZmF1bHQgeyJbICBdIn0gfQogICAgICAgICRjb2xvciA9IHN3aXRjaCAoJHMuU3RhdHVzKSB7ICJQQVNTIiB7IkdyZWVuIn0gIkZBSUwiIHsiUmVkIn0gIldBUk4iIHsiWWVsbG93In0gIlNLSVAiIHsiRGFya0dyYXkifSBkZWZhdWx0IHsiRGFya0dyYXkifSB9CgogICAgICAgIGlmICgkcy5TdGF0dXMgLWVxICJQRU5ESU5HIikgewogICAgICAgICAgICBpZiAoLW5vdCAkTG9nT25seSkgeyBXcml0ZS1Ib3N0ICgiICB7MH0gezEsLTU1fSB7Mn0iIC1mICRpY29uLCAkbmFtZSwgIihub3QgcmVhY2hlZCkiKSAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5IH0KICAgICAgICAgICAgQWRkLUNvbnRlbnQgLVBhdGggJExPR19GSUxFIC1WYWx1ZSAoIiAgJGljb24gJG5hbWUgIChub3QgcmVhY2hlZCkiKSAtRW5jb2RpbmcgVVRGOAogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICAgIGlmICgtbm90ICRMb2dPbmx5KSB7CiAgICAgICAgICAgICAgICBXcml0ZS1Ib3N0ICIgICRpY29uICRuYW1lIiAtRm9yZWdyb3VuZENvbG9yICRjb2xvcgogICAgICAgICAgICAgICAgaWYgKCRzLkRldGFpbCkgeyBXcml0ZS1Ib3N0ICIgICAgICAgJCgkcy5EZXRhaWwpIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5IH0KICAgICAgICAgICAgICAgIGlmICgkcy5TdGF0dXMgLWVxICJGQUlMIiAtYW5kICRzLkZpeCkgeyBXcml0ZS1Ib3N0ICIgICAgICAgRml4OiAkKCRzLkZpeCkiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93IH0KICAgICAgICAgICAgfQogICAgICAgICAgICBBZGQtQ29udGVudCAtUGF0aCAkTE9HX0ZJTEUgLVZhbHVlICIgICRpY29uICRuYW1lIiAtRW5jb2RpbmcgVVRGOAogICAgICAgICAgICBpZiAoJHMuRGV0YWlsKSB7IEFkZC1Db250ZW50IC1QYXRoICRMT0dfRklMRSAtVmFsdWUgIiAgICAgICAkKCRzLkRldGFpbCkiIC1FbmNvZGluZyBVVEY4IH0KICAgICAgICAgICAgaWYgKCRzLlN0YXR1cyAtZXEgIkZBSUwiIC1hbmQgJHMuRml4KSB7IEFkZC1Db250ZW50IC1QYXRoICRMT0dfRklMRSAtVmFsdWUgIiAgICAgICBGaXg6ICQoJHMuRml4KSIgLUVuY29kaW5nIFVURjggfQogICAgICAgIH0KICAgIH0KCiAgICBBZGQtQ29udGVudCAtUGF0aCAkTE9HX0ZJTEUgLVZhbHVlICRsb2dTZXAgLUVuY29kaW5nIFVURjgKCiAgICBpZiAoLW5vdCAkTG9nT25seSkgewogICAgICAgIFdyaXRlLUhvc3QgJHNlcCAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5CiAgICAgICAgV3JpdGUtSG9zdCAiICBGdWxsIGxvZzogJExPR19GSUxFIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5CiAgICAgICAgV3JpdGUtSG9zdCAiICBTaGFyZSB3aXRoIFB1bHNlIHN1cHBvcnQgYXQgcHVsc2VuYW5vYWkuY29tIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5CiAgICAgICAgV3JpdGUtSG9zdCAiIgogICAgfQp9CiMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgpmdW5jdGlvbiBHZXQtTG9jYWxJUCB7CiAgICAoR2V0LU5ldElQQWRkcmVzcyAtQWRkcmVzc0ZhbWlseSBJUHY0IHwKICAgICAgICBXaGVyZS1PYmplY3QgeyAkXy5JbnRlcmZhY2VBbGlhcyAtbm90bWF0Y2ggIkxvb3BiYWNrfFdTTHx2RXRoZXJuZXQiIH0gfAogICAgICAgIFNlbGVjdC1PYmplY3QgLUZpcnN0IDEpLklQQWRkcmVzcwp9CgpmdW5jdGlvbiBTZXQtV1NMMlBvcnRQcm94eSB7CiAgICBwYXJhbShbc3RyaW5nXSRXc2xJUCkKICAgICMgVENQIG9ubHkg4oCUIHBvcnRwcm94eSBkb2VzIG5vdCBzdXBwb3J0IFVEUC4gVURQIHR1bm5lbCBwb3J0cyAoNTE4MDAtNTE4MTYpCiAgICAjIHJlcXVpcmUgbWlycm9yZWQgbmV0d29ya2luZyBvbiBXaW5kb3dzIDExIDIySDIrIHRvIGZ1bmN0aW9uIGNvcnJlY3RseS4KICAgICRhbGxQb3J0cyA9ICRPQ1RBX01HTVRfUE9SVFMgKyAoJE9DVEFfQVBQX1BPUlRfU1RBUlQuLiRPQ1RBX0FQUF9QT1JUX0VORCkKICAgIGZvcmVhY2ggKCRwIGluICRhbGxQb3J0cykgewogICAgICAgIG5ldHNoIGludGVyZmFjZSBwb3J0cHJveHkgZGVsZXRlIHY0dG92NCBsaXN0ZW5wb3J0PSRwIGxpc3RlbmFkZHJlc3M9MC4wLjAuMCB8IE91dC1OdWxsCiAgICAgICAgbmV0c2ggaW50ZXJmYWNlIHBvcnRwcm94eSBhZGQgdjR0b3Y0IGxpc3RlbnBvcnQ9JHAgbGlzdGVuYWRkcmVzcz0wLjAuMC4wIGAKICAgICAgICAgICAgY29ubmVjdHBvcnQ9JHAgY29ubmVjdGFkZHJlc3M9JFdzbElQIHwgT3V0LU51bGwKICAgIH0KICAgIFdyaXRlLUxvZyAiV1NMMiBwb3J0cHJveHkgKFRDUCk6ICQoJE9DVEFfTUdNVF9QT1JUUyAtam9pbiAnLCcpICsgJE9DVEFfQVBQX1BPUlRfU1RBUlQtJE9DVEFfQVBQX1BPUlRfRU5EIOKGkiAkV3NsSVAiICJPSyIKICAgIFdyaXRlLUxvZyAiTk9URTogVURQIHBvcnRzICRPQ1RBX0FQUF9QT1JUX1NUQVJULSRPQ1RBX0FQUF9QT1JUX0VORCBuZWVkIG1pcnJvcmVkIG5ldHdvcmtpbmcgZm9yIGZ1bGwgdHVubmVsIHN1cHBvcnQiICJXQVJOIgp9CgojIOKUgOKUgCBQaGFzZSAxOiBFbmFibGUgV1NMMiArIHNjaGVkdWxlIFBoYXNlIDIgYWZ0ZXIgcmVib290IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKZnVuY3Rpb24gSW52b2tlLVBoYXNlMSB7CiAgICBTaG93LUJhbm5lciAiUGhhc2UgMSBvZiAyIOKAlCBFbmFibGluZyBXU0wyIgoKICAgICRzY3JpcHQ6U3RlcHMgPSBbb3JkZXJlZF1Ae30KICAgIFJlZ2lzdGVyLVN0ZXAgIldpbmRvd3MgY29tcGF0aWJpbGl0eSAoYnVpbGQgMTkwNDErKSIKICAgIFJlZ2lzdGVyLVN0ZXAgIkdQVSBkZXRlY3RlZCIKICAgIFJlZ2lzdGVyLVN0ZXAgIlZpcnR1YWxpemF0aW9uIGVuYWJsZWQgaW4gQklPUyIKICAgIFJlZ2lzdGVyLVN0ZXAgIldTTDIgZmVhdHVyZXMgZW5hYmxlZCIKICAgIFJlZ2lzdGVyLVN0ZXAgIldTTDIga2VybmVsIHVwZGF0ZSIKICAgIFJlZ2lzdGVyLVN0ZXAgIlBoYXNlIDIgcmVzdW1lIHRhc2siCgogICAgJGJ1aWxkID0gW1N5c3RlbS5FbnZpcm9ubWVudF06Ok9TVmVyc2lvbi5WZXJzaW9uLkJ1aWxkCiAgICBpZiAoJGJ1aWxkIC1sdCAxOTA0MSkgewogICAgICAgIFNldC1TdGVwICJXaW5kb3dzIGNvbXBhdGliaWxpdHkgKGJ1aWxkIDE5MDQxKykiICJGQUlMIiAiQnVpbGQgJGJ1aWxkIOKAlCByZXF1aXJlcyAxOTA0MSAoV2luZG93cyAxMCAyMDA0KykiCiAgICAgICAgV3JpdGUtTG9nICJXaW5kb3dzIGJ1aWxkICRidWlsZCBpcyB0b28gb2xkLiBXU0wyIHJlcXVpcmVzIGJ1aWxkIDE5MDQxKyAoV2luZG93cyAxMCAyMDA0KykuIiAiRVJST1IiCiAgICAgICAgU2hvdy1EaWFnbm9zdGljczsgV2FpdC1Gb3JLZXk7IGV4aXQgMQogICAgfQogICAgV3JpdGUtTG9nICJXaW5kb3dzIGJ1aWxkICRidWlsZCDigJQgT0siICJPSyIKICAgIFNldC1TdGVwICJXaW5kb3dzIGNvbXBhdGliaWxpdHkgKGJ1aWxkIDE5MDQxKykiICJQQVNTIiAiQnVpbGQgJGJ1aWxkIgoKICAgICRncHUgPSAoR2V0LVdtaU9iamVjdCBXaW4zMl9WaWRlb0NvbnRyb2xsZXIgfAogICAgICAgIFdoZXJlLU9iamVjdCB7ICRfLk5hbWUgLW1hdGNoICJOVklESUF8R2VGb3JjZXxSVFh8R1RYfEFNRHxSYWRlb24iIH0gfAogICAgICAgIFNlbGVjdC1PYmplY3QgLUZpcnN0IDEpLk5hbWUKICAgIGlmICgtbm90ICRncHUpIHsKICAgICAgICBTZXQtU3RlcCAiR1BVIGRldGVjdGVkIiAiRkFJTCIgIk5vIE5WSURJQS9BTUQgR1BVIGZvdW5kIgogICAgICAgIFdyaXRlLUxvZyAiTm8gc3VwcG9ydGVkIEdQVSBkZXRlY3RlZC4gUHVsc2UgcmVxdWlyZXMgYW4gTlZJRElBIG9yIEFNRCBHUFUuIiAiRVJST1IiCiAgICAgICAgU2hvdy1EaWFnbm9zdGljczsgV2FpdC1Gb3JLZXk7IGV4aXQgMQogICAgfQogICAgV3JpdGUtTG9nICJHUFU6ICRncHUiICJPSyIKICAgIFNldC1TdGVwICJHUFUgZGV0ZWN0ZWQiICJQQVNTIiAkZ3B1CgogICAgTmV3LUl0ZW0gLUl0ZW1UeXBlIERpcmVjdG9yeSAtRm9yY2UgLVBhdGggJFBVTFNFX0RJUiB8IE91dC1OdWxsCgogICAgJHZpcnRFbmFibGVkID0gKEdldC1Db21wdXRlckluZm8pLkh5cGVyVlJlcXVpcmVtZW50VmlydHVhbGl6YXRpb25GaXJtd2FyZUVuYWJsZWQKICAgIGlmICgkdmlydEVuYWJsZWQgLWVxICRmYWxzZSkgewogICAgICAgIFNldC1TdGVwICJWaXJ0dWFsaXphdGlvbiBlbmFibGVkIGluIEJJT1MiICJGQUlMIiAiRGlzYWJsZWQg4oCUIHNlZSBCSU9TIGluc3RydWN0aW9ucyBiZWxvdyIKICAgICAgICBXcml0ZS1Mb2cgIkhhcmR3YXJlIHZpcnR1YWxpemF0aW9uIGlzIGRpc2FibGVkIGluIHlvdXIgQklPUy9VRUZJLiIgIkVSUk9SIgogICAgICAgIFdyaXRlLUhvc3QgIiIKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUjOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUkCIgLUZvcmVncm91bmRDb2xvciBSZWQKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgQUNUSU9OIFJFUVVJUkVEOiBFbmFibGUgdmlydHVhbGl6YXRpb24gaW4geW91ciBCSU9TL1VFRkkgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFJlZAogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkCiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgIDEuIFJlc3RhcnQgeW91ciBQQyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBSZWQKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgMi4gUHJlc3MgRGVsZXRlIG9yIEYyIGR1cmluZyBib290IHRvIG9wZW4gQklPUyAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkCiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgIDMuIEZpbmQ6IEFkdmFuY2VkID4gQ1BVIENvbmZpZ3VyYXRpb24gPiBTVk0gTW9kZSAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFJlZAogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAoSW50ZWwgYm9hcmRzOiBsb29rIGZvciAnSW50ZWwgVmlydHVhbGl6YXRpb24nIG9yIFZULXgpIOKUgiIgLUZvcmVncm91bmRDb2xvciBSZWQKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgNC4gU2V0IGl0IHRvIEVuYWJsZWQgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFJlZAogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICA1LiBQcmVzcyBGMTAgdG8gc2F2ZSBhbmQgZXhpdCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBSZWQKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFJlZAogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICBUaGVuIHJlLXJ1biB0aGlzIGluc3RhbGxlci4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkCiAgICAgICAgV3JpdGUtSG9zdCAiICDilJTilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilJgiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkCiAgICAgICAgV3JpdGUtSG9zdCAiIgogICAgICAgIFNob3ctRGlhZ25vc3RpY3M7IFdhaXQtRm9yS2V5OyBleGl0IDEKICAgIH0KICAgIFdyaXRlLUxvZyAiSGFyZHdhcmUgdmlydHVhbGl6YXRpb24gZW5hYmxlZCBpbiBCSU9TIOKAlCBPSyIgIk9LIgogICAgU2V0LVN0ZXAgIlZpcnR1YWxpemF0aW9uIGVuYWJsZWQgaW4gQklPUyIgIlBBU1MiCgogICAgV3JpdGUtTG9nICJFbmFibGluZyBXU0wyIFdpbmRvd3MgZmVhdHVyZXMuLi4iCiAgICBkaXNtLmV4ZSAvb25saW5lIC9lbmFibGUtZmVhdHVyZSAvZmVhdHVyZW5hbWU6TWljcm9zb2Z0LVdpbmRvd3MtU3Vic3lzdGVtLUxpbnV4IC9hbGwgL25vcmVzdGFydCB8IE91dC1OdWxsCiAgICBkaXNtLmV4ZSAvb25saW5lIC9lbmFibGUtZmVhdHVyZSAvZmVhdHVyZW5hbWU6VmlydHVhbE1hY2hpbmVQbGF0Zm9ybSAvYWxsIC9ub3Jlc3RhcnQgfCBPdXQtTnVsbAogICAgV3JpdGUtTG9nICJXU0wyIGZlYXR1cmVzIGVuYWJsZWQiICJPSyIKICAgIFNldC1TdGVwICJXU0wyIGZlYXR1cmVzIGVuYWJsZWQiICJQQVNTIgoKICAgIFdyaXRlLUxvZyAiSW5zdGFsbGluZyBXU0wyIGtlcm5lbCB1cGRhdGUuLi4iCiAgICAkbXNpID0gIiRlbnY6VEVNUFx3c2xfdXBkYXRlLm1zaSIKICAgIHRyeSB7CiAgICAgICAgSW52b2tlLVdlYlJlcXVlc3QgImh0dHBzOi8vd3Nsc3RvcmVzdG9yYWdlLmJsb2IuY29yZS53aW5kb3dzLm5ldC93c2xibG9iL3dzbF91cGRhdGVfeDY0Lm1zaSIgYAogICAgICAgICAgICAtT3V0RmlsZSAkbXNpIC1Vc2VCYXNpY1BhcnNpbmcKICAgICAgICBTdGFydC1Qcm9jZXNzIG1zaWV4ZWMuZXhlIC1Bcmd1bWVudExpc3QgIi9pIGAiJG1zaWAiIC9xdWlldCAvbm9yZXN0YXJ0IiAtV2FpdAogICAgICAgIFdyaXRlLUxvZyAiV1NMMiBrZXJuZWwgdXBkYXRlZCIgIk9LIgogICAgfSBjYXRjaCB7CiAgICAgICAgV3JpdGUtTG9nICJXU0wyIGtlcm5lbCBhbHJlYWR5IHVwIHRvIGRhdGUiICJPSyIKICAgIH0KICAgIFNldC1TdGVwICJXU0wyIGtlcm5lbCB1cGRhdGUiICJQQVNTIgoKICAgIHdzbCAtLXNldC1kZWZhdWx0LXZlcnNpb24gMiAyPiYxIHwgT3V0LU51bGwKCiAgICBTZXQtQ29udGVudCAtUGF0aCAkUEhBU0VfRklMRSAtVmFsdWUgIjIiIC1FbmNvZGluZyBVVEY4CgogICAgJHN0YWJsZVBhdGggPSAiJFBVTFNFX0RJUlxwdWxzZS1vY3RhLXNldHVwLnBzMSIKICAgIGlmICgkUFNDb21tYW5kUGF0aCAtbmUgJHN0YWJsZVBhdGgpIHsKICAgICAgICBDb3B5LUl0ZW0gLVBhdGggJFBTQ29tbWFuZFBhdGggLURlc3RpbmF0aW9uICRzdGFibGVQYXRoIC1Gb3JjZQogICAgfQoKICAgICRhY3Rpb24gICAgPSBOZXctU2NoZWR1bGVkVGFza0FjdGlvbiAtRXhlY3V0ZSAicG93ZXJzaGVsbC5leGUiIGAKICAgICAgICAtQXJndW1lbnQgIi1Ob1Byb2ZpbGUgLUV4ZWN1dGlvblBvbGljeSBCeXBhc3MgLVdpbmRvd1N0eWxlIE5vcm1hbCAtRmlsZSBgIiRzdGFibGVQYXRoYCIiCiAgICAkdHJpZ2dlciAgID0gTmV3LVNjaGVkdWxlZFRhc2tUcmlnZ2VyIC1BdExvZ09uCiAgICAkc2V0dGluZ3MgID0gTmV3LVNjaGVkdWxlZFRhc2tTZXR0aW5nc1NldCAtQWxsb3dTdGFydElmT25CYXR0ZXJpZXMgLURvbnRTdG9wSWZHb2luZ09uQmF0dGVyaWVzCiAgICAkcHJpbmNpcGFsID0gTmV3LVNjaGVkdWxlZFRhc2tQcmluY2lwYWwgLVVzZXJJZCAkZW52OlVTRVJOQU1FIC1SdW5MZXZlbCBIaWdoZXN0CiAgICBSZWdpc3Rlci1TY2hlZHVsZWRUYXNrIC1UYXNrTmFtZSAkVEFTS19OQU1FIC1BY3Rpb24gJGFjdGlvbiAtVHJpZ2dlciAkdHJpZ2dlciBgCiAgICAgICAgLVNldHRpbmdzICRzZXR0aW5ncyAtUHJpbmNpcGFsICRwcmluY2lwYWwgLUZvcmNlIHwgT3V0LU51bGwKICAgIFdyaXRlLUxvZyAiUGhhc2UgMiByZXN1bWUgdGFzayByZWdpc3RlcmVkIiAiT0siCiAgICBTZXQtU3RlcCAiUGhhc2UgMiByZXN1bWUgdGFzayIgIlBBU1MiCgogICAgV3JpdGUtSG9zdCAiIgogICAgV3JpdGUtSG9zdCAiICDilIzilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilJAiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgT25lIHJlYm9vdCByZXF1aXJlZCB0byBjb250aW51ZSBzZXR1cCAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgV3JpdGUtSG9zdCAiICDilIIgIFNldHVwIHdpbGwgcmVzdW1lIGF1dG9tYXRpY2FsbHkuICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgIFdyaXRlLUhvc3QgIiAg4pSU4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSYIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgV3JpdGUtSG9zdCAiIgogICAgJGFuc3dlciA9IFJlYWQtSG9zdCAiICBSZWJvb3Qgbm93PyAoWS9uKSIKICAgIGlmICgkYW5zd2VyIC1uZSAibiIpIHsgUmVzdGFydC1Db21wdXRlciAtRm9yY2UgfQogICAgZWxzZSB7IFdyaXRlLUhvc3QgIiAgUmVib290IHdoZW4gcmVhZHkuIFNldHVwIHJlc3VtZXMgb24gbmV4dCBsb2dpbi4iIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkgfQp9CgojIOKUgOKUgCBQaGFzZSAyOiBVYnVudHUgKyBPY3RhU3BhY2UgKG9zbikgKyBOZXR3b3JraW5nICsgQXV0by1zdGFydCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCmZ1bmN0aW9uIEludm9rZS1QaGFzZTIgewogICAgU2hvdy1CYW5uZXIgIlBoYXNlIDIgb2YgMiDigJQgSW5zdGFsbGluZyBPY3RhU3BhY2UgUHJvdmlkZXIgU3RhY2siCgogICAgJHNjcmlwdDpTdGVwcyA9IFtvcmRlcmVkXUB7fQogICAgUmVnaXN0ZXItU3RlcCAiVWJ1bnR1IG9uIFdTTDIiCiAgICBSZWdpc3Rlci1TdGVwICJzeXN0ZW1kIGluIFdTTDIiCiAgICBSZWdpc3Rlci1TdGVwICJXU0wyIG5ldHdvcmtpbmciCiAgICBSZWdpc3Rlci1TdGVwICJHUFUgY29tcHV0ZSBpbiBXU0wyIiAiVXBkYXRlIFdpbmRvd3MgTlZJRElBIGRyaXZlciBhdCBudmlkaWEuY29tL2RyaXZlcnMiCiAgICBSZWdpc3Rlci1TdGVwICJCdWlsZCB0b29scyAoY3VybCwgYmFzaCkiICJ3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tIGJhc2ggLWMgJ2FwdC1nZXQgdXBkYXRlICYmIGFwdC1nZXQgaW5zdGFsbCAteSBjdXJsIGJhc2gnIgogICAgUmVnaXN0ZXItU3RlcCAiT2N0YVNwYWNlIG9zbiBpbnN0YWxsZWQiICJDaGVjayBpbnN0YWxsLm9jdGEuc3BhY2Ugb3IgT2N0YVNwYWNlIGRvY3MiCiAgICBSZWdpc3Rlci1TdGVwICJIdWdlUGFnZXMgY2FwIChSQU0gZml4KSIKICAgIFJlZ2lzdGVyLVN0ZXAgIk9TTiBkaXNrIGFsYXJtIHRocmVzaG9sZCIKICAgIFJlZ2lzdGVyLVN0ZXAgIm9zbiBzZXJ2aWNlIHN0YXJ0ZWQiCiAgICBSZWdpc3Rlci1TdGVwICJPY3RhU3BhY2Ugbm9kZSB0b2tlbiIKICAgIFJlZ2lzdGVyLVN0ZXAgIldpbmRvd3MgRmlyZXdhbGwgcnVsZXMiCiAgICBSZWdpc3Rlci1TdGVwICJVUG5QIHBvcnQgZm9yd2FyZGluZyIKICAgIFJlZ2lzdGVyLVN0ZXAgIldTTDIgcG9ydCBwcm94eSIKICAgIFJlZ2lzdGVyLVN0ZXAgIlB1bHNlIHJlZ2lzdHJhdGlvbiIKICAgIFJlZ2lzdGVyLVN0ZXAgIkdQVSB3YXRjaGRvZyB0YXNrIgogICAgUmVnaXN0ZXItU3RlcCAiQXV0by1zdGFydCB0YXNrIgogICAgUmVnaXN0ZXItU3RlcCAiQXV0by1sb2dpbiIKCiAgICBXcml0ZS1Mb2cgIlNldHRpbmcgdXAgVWJ1bnR1LTIyLjA0IG9uIFdTTDIuLi4iCiAgICAjIFRlc3QgdGhlIGRpc3RybyBkaXJlY3RseSDigJQgd3NsIC0tbGlzdCAtLXF1aWV0IG91dHB1dHMgVVRGLTE2IHdoaWNoIGNhbiBjb3JydXB0IHN0cmluZyBtYXRjaGluZwogICAgJGRpc3Ryb09rID0gKHdzbCAtZCBVYnVudHUtMjIuMDQgLS11c2VyIHJvb3QgLS0gYmFzaCAtYyAiZWNobyBvayIgMj4mMSkgLW1hdGNoICJvayIKICAgIGlmICgtbm90ICRkaXN0cm9PaykgewogICAgICAgIHdzbCAtLXVucmVnaXN0ZXIgVWJ1bnR1LTIyLjA0IDI+JjEgfCBPdXQtTnVsbAogICAgICAgIFdyaXRlLUxvZyAiRG93bmxvYWRpbmcgVWJ1bnR1LTIyLjA0Li4uIgogICAgICAgIHdzbCAtLWluc3RhbGwgLWQgVWJ1bnR1LTIyLjA0IC0tbm8tbGF1bmNoIDI+JjEgfCBPdXQtTnVsbAoKICAgICAgICBXcml0ZS1Mb2cgIkluaXRpYWxpemluZyBVYnVudHUtMjIuMDQgaGVhZGxlc3NseSAobm8gR1VJIHJlcXVpcmVkKS4uLiIKICAgICAgICAkdWJ1bnR1RXhlID0gR2V0LUNoaWxkSXRlbSAiJGVudjpMT0NBTEFQUERBVEFcTWljcm9zb2Z0XFdpbmRvd3NBcHBzIiAtRmlsdGVyICJ1YnVudHUyMjA0Ki5leGUiIC1FcnJvckFjdGlvbiBTaWxlbnRseUNvbnRpbnVlIHwgU2VsZWN0LU9iamVjdCAtRmlyc3QgMQogICAgICAgIGlmICgtbm90ICR1YnVudHVFeGUpIHsKICAgICAgICAgICAgJHVidW50dUV4ZSA9IEdldC1DaGlsZEl0ZW0gIiRlbnY6TE9DQUxBUFBEQVRBXE1pY3Jvc29mdFxXaW5kb3dzQXBwcyIgLUZpbHRlciAidWJ1bnR1Ki5leGUiIC1FcnJvckFjdGlvbiBTaWxlbnRseUNvbnRpbnVlIHwgU2VsZWN0LU9iamVjdCAtRmlyc3QgMQogICAgICAgIH0KICAgICAgICBpZiAoJHVidW50dUV4ZSkgewogICAgICAgICAgICAmICR1YnVudHVFeGUuRnVsbE5hbWUgaW5zdGFsbCAtLXJvb3QgMj4mMSB8IE91dC1OdWxsCiAgICAgICAgfQogICAgICAgIFN0YXJ0LVNsZWVwIDUKCiAgICAgICAgJGNoZWNrID0gd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICJlY2hvIG9rIiAyPiYxCiAgICAgICAgaWYgKCRjaGVjayAtbm90bWF0Y2ggIm9rIikgewogICAgICAgICAgICBXcml0ZS1Mb2cgIlVidW50dS0yMi4wNCByb290IGFjY2VzcyBmYWlsZWQg4oCUIHJlLXJ1biBpbnN0YWxsZXIuIiAiRVJST1IiCiAgICAgICAgICAgIFNob3ctRGlhZ25vc3RpY3M7IFdhaXQtRm9yS2V5OyBleGl0IDEKICAgICAgICB9CiAgICAgICAgV3JpdGUtTG9nICJVYnVudHUtMjIuMDQgaW5zdGFsbGVkIGFuZCBpbml0aWFsaXplZCIgIk9LIgogICAgfSBlbHNlIHsKICAgICAgICBXcml0ZS1Mb2cgIlVidW50dS0yMi4wNCBhbHJlYWR5IHByZXNlbnQgYW5kIHdvcmtpbmciICJPSyIKICAgIH0KICAgIFNldC1TdGVwICJVYnVudHUgb24gV1NMMiIgIlBBU1MiCgogICAgIyBFbmFibGUgc3lzdGVtZCDigJQgb3NuIGlzIGEgc3lzdGVtZCBzZXJ2aWNlCiAgICBXcml0ZS1Mb2cgIkVuYWJsaW5nIHN5c3RlbWQgaW4gV1NMMiAocmVxdWlyZWQgZm9yIG9zbiBzZXJ2aWNlKS4uLiIKICAgIHdzbCAtZCBVYnVudHUtMjIuMDQgLS11c2VyIHJvb3QgLS0gYmFzaCAtYyAiZ3JlcCAtcSAnc3lzdGVtZD10cnVlJyAvZXRjL3dzbC5jb25mIDI+L2Rldi9udWxsIHx8IHByaW50ZiAnW2Jvb3RdXG5zeXN0ZW1kPXRydWVcbicgPiAvZXRjL3dzbC5jb25mIgoKICAgICMgV1NMMiBtaXJyb3JlZCBuZXR3b3JraW5nIOKAlCBlc3BlY2lhbGx5IGltcG9ydGFudCBmb3IgT2N0YVNwYWNlIGJlY2F1c2UgdGhlCiAgICAjIHR1bm5lbCBwb3J0cyA1MTgwMC01MTgxNiB1c2UgVURQLCBhbmQgcG9ydHByb3h5IGlzIFRDUC1vbmx5LgogICAgJG9zQnVpbGQgPSBbU3lzdGVtLkVudmlyb25tZW50XTo6T1NWZXJzaW9uLlZlcnNpb24uQnVpbGQKICAgICRtaXJyb3JlZE5ldHdvcmtpbmcgPSAkZmFsc2UKICAgICR3c2xDb25maWdQYXRoID0gIiRlbnY6VVNFUlBST0ZJTEVcLndzbGNvbmZpZyIKICAgICMgdm1JZGxlVGltZW91dD0tMSBzdG9wcyBXaW5kb3dzIGZyb20gdGVhcmluZyBkb3duIHRoZSBXU0wyIHV0aWxpdHkgVk0gYWZ0ZXIKICAgICMgaXQgbG9va3MgaWRsZS4gV2l0aG91dCBpdCwgdGhlIFZNIChhbmQgdGhlIG9zbiBkYWVtb24gcnVubmluZyBpbnNpZGUgaXQpIGNhbgogICAgIyBmcmVlemUgc2lsZW50bHkgZm9yIGhvdXJzIHdpdGggemVybyBsb2cgb3V0cHV0IOKAlCBubyBoZWFydGJlYXQgdGltZW91dCwgbm8KICAgICMgZXJyb3IsIGp1c3QgYSBnYXAg4oCUIHVudGlsIHNvbWV0aGluZyB0b3VjaGVzIFdTTCBhZ2FpbiBhbmQgaXQgcmVjb25uZWN0cy4KICAgICMgVGhpcyBpcyB0aGUgc2FtZSBmaXggYWxyZWFkeSBhcHBsaWVkIHRvIHRoZSBDbG9yZSBpbnN0YWxsZXIgKENMT1JFX1BTMSkuCiAgICBpZiAoJG9zQnVpbGQgLWdlIDIyNjIxKSB7CiAgICAgICAgV3JpdGUtTG9nICJXaW5kb3dzIDExIDIySDIrIGRldGVjdGVkIOKAlCBlbmFibGluZyBXU0wyIG1pcnJvcmVkIG5ldHdvcmtpbmcuLi4iCiAgICAgICAgJHdzbENvbmZpZ0NvbnRlbnQgPSBpZiAoVGVzdC1QYXRoICR3c2xDb25maWdQYXRoKSB7IEdldC1Db250ZW50ICR3c2xDb25maWdQYXRoIC1SYXcgfSBlbHNlIHsgIiIgfQogICAgICAgICRjaGFuZ2VkID0gJGZhbHNlCiAgICAgICAgaWYgKCR3c2xDb25maWdDb250ZW50IC1ub3RtYXRjaCAnbmV0d29ya2luZ01vZGUnKSB7CiAgICAgICAgICAgIGlmICgkd3NsQ29uZmlnQ29udGVudCAtbWF0Y2ggJ1xbd3NsMlxdJykgewogICAgICAgICAgICAgICAgJHdzbENvbmZpZ0NvbnRlbnQgPSAkd3NsQ29uZmlnQ29udGVudCAtcmVwbGFjZSAnKFxbd3NsMlxdKScsICJgJDFgbm5ldHdvcmtpbmdNb2RlPW1pcnJvcmVkIgogICAgICAgICAgICB9IGVsc2UgewogICAgICAgICAgICAgICAgJHdzbENvbmZpZ0NvbnRlbnQgKz0gImBuW3dzbDJdYG5uZXR3b3JraW5nTW9kZT1taXJyb3JlZGBuIgogICAgICAgICAgICB9CiAgICAgICAgICAgICRjaGFuZ2VkID0gJHRydWUKICAgICAgICB9CiAgICAgICAgaWYgKCR3c2xDb25maWdDb250ZW50IC1ub3RtYXRjaCAndm1JZGxlVGltZW91dCcpIHsKICAgICAgICAgICAgaWYgKCR3c2xDb25maWdDb250ZW50IC1tYXRjaCAnXFt3c2wyXF0nKSB7CiAgICAgICAgICAgICAgICAkd3NsQ29uZmlnQ29udGVudCA9ICR3c2xDb25maWdDb250ZW50IC1yZXBsYWNlICcoXFt3c2wyXF0pJywgImAkMWBudm1JZGxlVGltZW91dD0tMSIKICAgICAgICAgICAgfSBlbHNlIHsKICAgICAgICAgICAgICAgICR3c2xDb25maWdDb250ZW50ICs9ICJgblt3c2wyXWBudm1JZGxlVGltZW91dD0tMWBuIgogICAgICAgICAgICB9CiAgICAgICAgICAgICRjaGFuZ2VkID0gJHRydWUKICAgICAgICB9CiAgICAgICAgaWYgKCRjaGFuZ2VkKSB7IFNldC1Db250ZW50IC1QYXRoICR3c2xDb25maWdQYXRoIC1WYWx1ZSAkd3NsQ29uZmlnQ29udGVudCAtRW5jb2RpbmcgVVRGOCB9CiAgICAgICAgJG1pcnJvcmVkTmV0d29ya2luZyA9ICR0cnVlCiAgICAgICAgV3JpdGUtTG9nICJXU0wyIG5ldHdvcmtpbmcgY29uZmlndXJlZCAobWlycm9yZWQsIHZtSWRsZVRpbWVvdXQ9LTEpIOKAlCBVRFAgdHVubmVscyB3aWxsIHdvcmsgY29ycmVjdGx5IiAiT0siCiAgICAgICAgU2V0LVN0ZXAgIldTTDIgbmV0d29ya2luZyIgIlBBU1MiICJNaXJyb3JlZCAoV2luZG93cyAxMSAyMkgyKyksIHZtSWRsZVRpbWVvdXQ9LTEg4oCUIFVEUCB0dW5uZWxzIGZ1bGx5IGZ1bmN0aW9uYWwiCiAgICB9IGVsc2UgewogICAgICAgIFdyaXRlLUxvZyAiV2luZG93cyBidWlsZCAke29zQnVpbGR9OiBtaXJyb3JlZCBuZXR3b3JraW5nIG5lZWRzIDIySDIgKDIyNjIxKykg4oCUIHBvcnRwcm94eSBvbmx5IGNvdmVycyBUQ1A7IFVEUCB0dW5uZWxzIHdpbGwgYmUgbGltaXRlZCIgIldBUk4iCiAgICAgICAgJHdzbENvbmZpZ0NvbnRlbnQgPSBpZiAoVGVzdC1QYXRoICR3c2xDb25maWdQYXRoKSB7IEdldC1Db250ZW50ICR3c2xDb25maWdQYXRoIC1SYXcgfSBlbHNlIHsgIiIgfQogICAgICAgIGlmICgkd3NsQ29uZmlnQ29udGVudCAtbm90bWF0Y2ggJ3ZtSWRsZVRpbWVvdXQnKSB7CiAgICAgICAgICAgIGlmICgkd3NsQ29uZmlnQ29udGVudCAtbWF0Y2ggJ1xbd3NsMlxdJykgewogICAgICAgICAgICAgICAgJHdzbENvbmZpZ0NvbnRlbnQgPSAkd3NsQ29uZmlnQ29udGVudCAtcmVwbGFjZSAnKFxbd3NsMlxdKScsICJgJDFgbnZtSWRsZVRpbWVvdXQ9LTEiCiAgICAgICAgICAgIH0gZWxzZSB7CiAgICAgICAgICAgICAgICAkd3NsQ29uZmlnQ29udGVudCArPSAiYG5bd3NsMl1gbnZtSWRsZVRpbWVvdXQ9LTFgbiIKICAgICAgICAgICAgfQogICAgICAgICAgICBTZXQtQ29udGVudCAtUGF0aCAkd3NsQ29uZmlnUGF0aCAtVmFsdWUgJHdzbENvbmZpZ0NvbnRlbnQgLUVuY29kaW5nIFVURjgKICAgICAgICB9CiAgICAgICAgV3JpdGUtTG9nICJ2bUlkbGVUaW1lb3V0PS0xIHNldCAocHJldmVudHMgc2lsZW50IFdTTDIgVk0gaWRsZS1mcmVlemUpIiAiT0siCiAgICAgICAgU2V0LVN0ZXAgIldTTDIgbmV0d29ya2luZyIgIldBUk4iICJQb3J0cHJveHkgb25seSAoYnVpbGQgJG9zQnVpbGQpLCB2bUlkbGVUaW1lb3V0PS0xIOKAlCBVRFAgdHVubmVsIHBvcnRzIGxpbWl0ZWQ7IHVwZ3JhZGUgdG8gV2luIDExIDIySDIrIHJlY29tbWVuZGVkIgogICAgfQoKICAgIHdzbCAtLXNodXRkb3duCiAgICBTdGFydC1TbGVlcCAyMAogICAgJHNkQ2hlY2sgPSB3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tdXNlciByb290IC0tIGJhc2ggLWMgIlsgLWQgL3J1bi9zeXN0ZW1kL3N5c3RlbSBdICYmIGVjaG8geWVzIHx8IGVjaG8gbm8iIDI+JjEKICAgIGlmICgkc2RDaGVjayAtbWF0Y2ggInllcyIpIHsKICAgICAgICBXcml0ZS1Mb2cgInN5c3RlbWQgcnVubmluZyBpbiBXU0wyIiAiT0siCiAgICAgICAgU2V0LVN0ZXAgInN5c3RlbWQgaW4gV1NMMiIgIlBBU1MiCiAgICB9IGVsc2UgewogICAgICAgIFdyaXRlLUxvZyAic3lzdGVtZCBtYXkgbm90IGJlIGFjdGl2ZSDigJQgb3NuIG1heSBub3QgYXV0by1zdGFydCBvbiByZWJvb3QiICJXQVJOIgogICAgICAgIFNldC1TdGVwICJzeXN0ZW1kIGluIFdTTDIiICJXQVJOIiAic3lzdGVtZCBub3QgZGV0ZWN0ZWQg4oCUIG9zbiBzZXJ2aWNlIG1heSBub3QgcGVyc2lzdCBhY3Jvc3MgcmVib290cyIKICAgIH0KCiAgICAjIOKUgOKUgCBEZXRlY3QgR1BVIHZlbmRvciDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAgICRncHVPYmogICAgPSBHZXQtV21pT2JqZWN0IFdpbjMyX1ZpZGVvQ29udHJvbGxlciB8IFdoZXJlLU9iamVjdCB7ICRfLk5hbWUgLW1hdGNoICJOVklESUF8R2VGb3JjZXxSVFh8R1RYfEFNRHxSYWRlb24iIH0gfCBTZWxlY3QtT2JqZWN0IC1GaXJzdCAxCiAgICAkZ3B1TmFtZSAgID0gJGdwdU9iai5OYW1lCiAgICAkdnJhbU1iICAgID0gJGdwdU9iai5BZGFwdGVyUkFNCiAgICAkdnJhbUdiICAgID0gaWYgKCR2cmFtTWIgLWFuZCAkdnJhbU1iIC1ndCAwKSB7IFttYXRoXTo6Um91bmQoJHZyYW1NYiAvIDFHQikgfSBlbHNlIHsgOCB9CiAgICAkZ3B1VmVuZG9yID0gaWYgKCRncHVOYW1lIC1tYXRjaCAiTlZJRElBfEdlRm9yY2V8UlRYfEdUWCIpIHsgIk5WSURJQSIgfSBlbHNlIHsgIkFNRCIgfQoKICAgICMg4pSA4pSAIFByZS1pbnN0YWxsIEdQVSBjb21wdXRlIGRyaXZlcnMgaW5zaWRlIFdTTDIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgICBXcml0ZS1Mb2cgIkNoZWNraW5nIEdQVSBjb21wdXRlIGVudmlyb25tZW50IGluIFdTTDIgKCRncHVWZW5kb3IpLi4uIgogICAgaWYgKCRncHVWZW5kb3IgLWVxICJOVklESUEiKSB7CiAgICAgICAgJG52Q2hlY2sgPSB3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tdXNlciByb290IC0tIGJhc2ggLWMgIm52aWRpYS1zbWkgLUwgMj4vZGV2L251bGwgfCBoZWFkIC0xIiAyPiYxCiAgICAgICAgaWYgKCRudkNoZWNrIC1tYXRjaCAiR1BVIDAiKSB7CiAgICAgICAgICAgIFdyaXRlLUxvZyAiTlZJRElBIEdQVSB2aXNpYmxlIGluIFdTTDIiICJPSyIKICAgICAgICAgICAgU2V0LVN0ZXAgIkdQVSBjb21wdXRlIGluIFdTTDIiICJQQVNTIiAibnZpZGlhLXNtaSBPSyDigJQgJGdwdU5hbWUiCiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgICAgV3JpdGUtTG9nICJOVklESUEgR1BVIG5vdCB5ZXQgdmlzaWJsZSBpbiBXU0wyIOKAlCBlbnN1cmUgV2luZG93cyBOVklESUEgZHJpdmVyIGlzIHVwIHRvIGRhdGUiICJXQVJOIgogICAgICAgICAgICBTZXQtU3RlcCAiR1BVIGNvbXB1dGUgaW4gV1NMMiIgIldBUk4iICJudmlkaWEtc21pIHJldHVybmVkIG5vIG91dHB1dCDigJQgb3NuIG1heSBmYWlsIHdpdGhvdXQgR1BVIGFjY2VzcyIKICAgICAgICB9CiAgICB9IGVsc2UgewogICAgICAgIFdyaXRlLUxvZyAiSW5zdGFsbGluZyBST0NtIGZvciBBTUQgR1BVIGluIFdTTDIgKHRoaXMgdGFrZXMgYSBmZXcgbWludXRlcykuLi4iCiAgICAgICAgJHVidW50dVZlciA9IHdzbCAtZCBVYnVudHUtMjIuMDQgLS11c2VyIHJvb3QgLS0gYmFzaCAtYyAibHNiX3JlbGVhc2UgLWNzIDI+L2Rldi9udWxsIiAyPiYxCiAgICAgICAgJHVidW50dVZlciA9ICR1YnVudHVWZXIuVHJpbSgpCiAgICAgICAgaWYgKCR1YnVudHVWZXIgLW5vdGluIEAoImphbW15IiwiZm9jYWwiLCJub2JsZSIpKSB7ICR1YnVudHVWZXIgPSAiamFtbXkiIH0KICAgICAgICAkcm9jbVNjcmlwdCA9ICJzZXQgLWVgbmV4cG9ydCBERUJJQU5fRlJPTlRFTkQ9bm9uaW50ZXJhY3RpdmVgbmFwdC1nZXQgdXBkYXRlIC1xcWBuYXB0LWdldCBpbnN0YWxsIC15IC1xcSB3Z2V0IGdudXBnIGNhLWNlcnRpZmljYXRlc2BubWtkaXIgLXAgL2V0Yy9hcHQva2V5cmluZ3NgbndnZXQgLXFPIC0gaHR0cHM6Ly9yZXBvLnJhZGVvbi5jb20vcm9jbS9yb2NtLmdwZy5rZXkgfCBncGcgLS1kZWFybW9yIC1vIC9ldGMvYXB0L2tleXJpbmdzL3JvY20uZ3BnYG5lY2hvICdkZWIgW2FyY2g9YW1kNjQgc2lnbmVkLWJ5PS9ldGMvYXB0L2tleXJpbmdzL3JvY20uZ3BnXSBodHRwczovL3JlcG8ucmFkZW9uLmNvbS9yb2NtL2FwdC82LjIgJHVidW50dVZlciBtYWluJyA+IC9ldGMvYXB0L3NvdXJjZXMubGlzdC5kL3JvY20ubGlzdGBuYXB0LWdldCB1cGRhdGUgLXFxYG5hcHQtZ2V0IGluc3RhbGwgLXkgLXFxIHJvY20tb3BlbmNsLXJ1bnRpbWUiCiAgICAgICAgIyBQaXBlIHZpYSBzdGRpbiB0byBhdm9pZCBDUkxGIGlzc3VlcyB3aXRoIGJhc2ggLWMgb24gV2luZG93cwogICAgICAgICRyb2NtU2NyaXB0IHwgd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIDI+JjEgfCBGb3JFYWNoLU9iamVjdCB7IFdyaXRlLUxvZyAkXyB9CiAgICAgICAgaWYgKCRMQVNURVhJVENPREUgLWVxIDApIHsKICAgICAgICAgICAgV3JpdGUtTG9nICJST0NtIGluc3RhbGxlZCIgIk9LIgogICAgICAgICAgICBTZXQtU3RlcCAiR1BVIGNvbXB1dGUgaW4gV1NMMiIgIlBBU1MiICJST0NtIG9wZW5jbC1ydW50aW1lIGluc3RhbGxlZCDigJQgJGdwdU5hbWUiCiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgICAgV3JpdGUtTG9nICJST0NtIGluc3RhbGwgZW5jb3VudGVyZWQgZXJyb3JzIOKAlCBPY3RhU3BhY2UgbWF5IGhhdmUgbGltaXRlZCBBTUQgc3VwcG9ydCIgIldBUk4iCiAgICAgICAgICAgIFNldC1TdGVwICJHUFUgY29tcHV0ZSBpbiBXU0wyIiAiV0FSTiIgIlJPQ20gaW5zdGFsbCBoYWQgZXJyb3JzIOKAlCBBTUQgc3VwcG9ydCBtYXkgYmUgbGltaXRlZCIKICAgICAgICB9CiAgICB9CgogICAgIyDilIDilIAgSW5zdGFsbCBPY3RhU3BhY2Ugbm9kZSAob3NuKSBpbnNpZGUgV1NMMiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAgIFdyaXRlLUxvZyAiSW5zdGFsbGluZyBvc24gcHJlcmVxdWlzaXRlcyAoY3VybCwgYmFzaCwgZ3VtKS4uLiIKICAgIHdzbCAtZCBVYnVudHUtMjIuMDQgLS11c2VyIHJvb3QgLS0gYmFzaCAtYyAiZXhwb3J0IERFQklBTl9GUk9OVEVORD1ub25pbnRlcmFjdGl2ZTsgYXB0LWdldCB1cGRhdGUgLXFxICYmIGFwdC1nZXQgaW5zdGFsbCAteSAtcXEgY3VybCBiYXNoIiAyPiYxIHwgRm9yRWFjaC1PYmplY3QgeyBXcml0ZS1Mb2cgJF8gfQogICAgaWYgKCRMQVNURVhJVENPREUgLWVxIDApIHsKICAgICAgICBTZXQtU3RlcCAiQnVpbGQgdG9vbHMgKGN1cmwsIGJhc2gpIiAiUEFTUyIKICAgIH0gZWxzZSB7CiAgICAgICAgU2V0LVN0ZXAgIkJ1aWxkIHRvb2xzIChjdXJsLCBiYXNoKSIgIldBUk4iICJhcHQtZ2V0IGV4aXQgJExBU1RFWElUQ09ERSDigJQgb3NuIGluc3RhbGxlciB3aWxsIGF0dGVtcHQgdG8gY29udGludWUgYW55d2F5IgogICAgfQoKICAgIFdyaXRlLUxvZyAiSW5zdGFsbGluZyBndW0gKHJlcXVpcmVkIGJ5IE9jdGFTcGFjZSBpbnN0YWxsZXIpLi4uIgogICAgJGd1bUluc3RhbGwgPSAiZXhwb3J0IERFQklBTl9GUk9OVEVORD1ub25pbnRlcmFjdGl2ZSAmJiBta2RpciAtcCAvZXRjL2FwdC9rZXlyaW5ncyAmJiBjdXJsIC1mc1NMIGh0dHBzOi8vcmVwby5jaGFybS5zaC9hcHQvZ3BnLmtleSB8IGdwZyAtLWRlYXJtb3IgLW8gL2V0Yy9hcHQva2V5cmluZ3MvY2hhcm0uZ3BnICYmIGVjaG8gJ2RlYiBbc2lnbmVkLWJ5PS9ldGMvYXB0L2tleXJpbmdzL2NoYXJtLmdwZ10gaHR0cHM6Ly9yZXBvLmNoYXJtLnNoL2FwdC8gKiAqJyB8IHRlZSAvZXRjL2FwdC9zb3VyY2VzLmxpc3QuZC9jaGFybS5saXN0ID4gL2Rldi9udWxsICYmIGFwdC1nZXQgdXBkYXRlIC1xcSAmJiBhcHQtZ2V0IGluc3RhbGwgLXkgLXFxIGd1bSIKICAgIHdzbCAtZCBVYnVudHUtMjIuMDQgLS11c2VyIHJvb3QgLS0gYmFzaCAtYyAkZ3VtSW5zdGFsbCAyPiYxIHwgRm9yRWFjaC1PYmplY3QgeyBXcml0ZS1Mb2cgJF8gfQogICAgaWYgKCRMQVNURVhJVENPREUgLW5lIDApIHsKICAgICAgICBXcml0ZS1Mb2cgImd1bSBpbnN0YWxsIGZhaWxlZCDigJQgT2N0YVNwYWNlIGluc3RhbGxlciBtYXkgZmFpbCIgIldBUk4iCiAgICB9IGVsc2UgewogICAgICAgIFdyaXRlLUxvZyAiZ3VtIGluc3RhbGxlZCIgIk9LIgogICAgfQoKICAgIFdyaXRlLUxvZyAiSW5zdGFsbGluZyBPY3RhU3BhY2Ugbm9kZSAob3NuKSBpbnNpZGUgV1NMMi4uLiIKICAgICRvY3RhT3V0cHV0ID0gd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICJjdXJsIC1mc1NMIGh0dHBzOi8vaW5zdGFsbC5vY3RhLnNwYWNlIHwgYmFzaCIgMj4mMQogICAgJG9jdGFFeGl0ID0gJExBU1RFWElUQ09ERQogICAgJG9jdGFPdXRwdXQgfCBGb3JFYWNoLU9iamVjdCB7IFdyaXRlLUxvZyAkXyB9CiAgICBpZiAoJG9jdGFFeGl0IC1uZSAwKSB7CiAgICAgICAgU2V0LVN0ZXAgIk9jdGFTcGFjZSBvc24gaW5zdGFsbGVkIiAiRkFJTCIgImluc3RhbGwub2N0YS5zcGFjZSBzY3JpcHQgZXhpdGVkICRvY3RhRXhpdCDigJQgc2VlIGxvZyBmb3IgZGV0YWlscyIKICAgICAgICBXcml0ZS1Mb2cgIk9jdGFTcGFjZSBpbnN0YWxsYXRpb24gZmFpbGVkIChleGl0ICRvY3RhRXhpdCkuIENoZWNrIHRoZSBvdXRwdXQgYWJvdmUuIiAiRVJST1IiCiAgICAgICAgU2hvdy1EaWFnbm9zdGljczsgV2FpdC1Gb3JLZXk7IGV4aXQgMQogICAgfQogICAgV3JpdGUtTG9nICJPY3RhU3BhY2Ugb3NuIGluc3RhbGwgY29tcGxldGUiICJPSyIKICAgIFNldC1TdGVwICJPY3RhU3BhY2Ugb3NuIGluc3RhbGxlZCIgIlBBU1MiCgogICAgIyDilIDilIAgU3RhYmlsaXR5IEZpeCAxOiBjYXAgTlZJRElBIEh1Z2VQYWdlcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAgICMgTlZJRElBJ3MgV1NMMiBkcml2ZXIgbG9ja3MgSHVnZVBhZ2VzIHByb3BvcnRpb25hbCB0byBhdmFpbGFibGUgUkFNIOKAlCB1cCB0byB+OEdCCiAgICAjIG9uIGEgMTBHQiBXU0wgaW5zdGFuY2UuIEVybGFuZydzIG1lbXN1cCBmaXJlcyBhIHN5c3RlbV9tZW1vcnlfaGlnaF93YXRlcm1hcmsgYWxhcm0KICAgICMgd2hlbiA+ODAlIFJBTSBpcyB1c2VkLCBjYXVzaW5nIE9TTiB0byBjYWxsIGluaXQ6c3RvcCgpIH4xNXMgYWZ0ZXIgZXZlcnkgc3RhcnR1cC4KICAgIFdyaXRlLUxvZyAiQ2FwcGluZyBOVklESUEgSHVnZVBhZ2VzIGF0IDI1NiAoNTEyTUIpIHRvIHByZXZlbnQgUkFNIHN0YXJ2YXRpb24uLi4iCiAgICB3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tdXNlciByb290IC0tIGJhc2ggLWMgImVjaG8gdm0ubnJfaHVnZXBhZ2VzPTI1NiA+IC9ldGMvc3lzY3RsLmQvOTAtd3NsLmNvbmYgJiYgc3lzY3RsIC1wIC9ldGMvc3lzY3RsLmQvOTAtd3NsLmNvbmYiIDI+JjEgfCBGb3JFYWNoLU9iamVjdCB7IFdyaXRlLUxvZyAkXyB9CiAgICBXcml0ZS1Mb2cgIkh1Z2VQYWdlcyBjYXBwZWQg4oCUIE5WSURJQSBkcml2ZXIgbGltaXRlZCB0byA1MTJNQiBrZXJuZWwgcGFnZXMiICJPSyIKICAgIFNldC1TdGVwICJIdWdlUGFnZXMgY2FwIChSQU0gZml4KSIgIlBBU1MiCgogICAgIyDilIDilIAgU3RhYmlsaXR5IEZpeCAyOiByYWlzZSBPU04gZGlzayArIG1lbW9yeSBhbGFybSB0aHJlc2hvbGRzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogICAgIyBPY3RhU3BhY2UncyBpbnN0YWxsZXIgY3JlYXRlcyAvZG9ja2VyLWRhdGEuaW1nICh+NzYzR0IgcmVhbCBmaWxlKSBmb3IgRG9ja2VyIHN0b3JhZ2UsCiAgICAjIHB1c2hpbmcgdGhlIHJvb3QgZmlsZXN5c3RlbSB0byB+ODElLiBFcmxhbmcncyBkaXNrc3VwIGZpcmVzIGEgZGlza19hbG1vc3RfZnVsbCBhbGFybQogICAgIyBhdCA4MCUgKHRoZSBkZWZhdWx0KSBhbmQgY2F1c2VzIE9TTiB0byBzZWxmLXRlcm1pbmF0ZS4gUmFpc2luZyB0byA5MCUgY2xlYXJzIGhlYWRyb29tLgogICAgIyBtZW1zdXAncyBzeXN0ZW1fbWVtb3J5X2hpZ2hfd2F0ZXJtYXJrIHVzZXMgInN0cmljdGx5IGZyZWUgLyB0b3RhbCIgd2hpY2ggZmlyZXMgY29uc3RhbnRseQogICAgIyBvbiBMaW51eCBiZWNhdXNlIHRoZSBrZXJuZWwgZmlsbHMgYWxsIHNwYXJlIG1lbW9yeSB3aXRoIGJ1ZmZlciBjYWNoZS4gUmFpc2luZyB0byAwLjk3CiAgICAjIG1lYW5zIHRoZSBhbGFybSBvbmx5IGZpcmVzIHdoZW4gZ2VudWluZWx5IFJBTS1zdGFydmVkOyBicmllZiBzcGlrZXMgY2xlYXIgcXVpY2tseS4KICAgIFdyaXRlLUxvZyAiUGF0Y2hpbmcgT1NOIGFsYXJtIHRocmVzaG9sZHMgKGRpc2sgOTAlLCBtZW1vcnkgOTclKS4uLiIKICAgICRkaXNrRml4U2NyaXB0ID0gQCcKU1lTX0NGRz0kKGxzIC9ob21lL29jdGEvb3NuL3JlbGVhc2VzLyovc3lzLmNvbmZpZyAyPi9kZXYvbnVsbCB8IGdyZXAgLXYgUkVMRUFTRVMgfCBoZWFkIC0xKQppZiBbIC16ICIkU1lTX0NGRyIgXTsgdGhlbiBlY2hvICJzeXMuY29uZmlnIG5vdCBmb3VuZCI7IGV4aXQgMTsgZmkKZ3JlcCAtcSAiZGlza19hbG1vc3RfZnVsbF90aHJlc2hvbGQiICIkU1lTX0NGRyIgJiYgZ3JlcCAtcSAic3lzdGVtX21lbW9yeV9oaWdoX3dhdGVybWFyayIgIiRTWVNfQ0ZHIiAmJiBlY2hvICJhbHJlYWR5IHBhdGNoZWQiICYmIGV4aXQgMApjYXQgPiAiJFNZU19DRkciIDw8ICdFUkxFT0YnClsKICAgIHtrZXJuZWwsIFsKICAgICAgICB7bG9nZ2VyX2xldmVsLCBkZWJ1Z30sCiAgICAgICAge2xvZ2dlciwgWwogICAgICAgICAgICB7aGFuZGxlciwgZGVmYXVsdCwgbG9nZ2VyX3N0ZF9oLCAjewogICAgICAgICAgICAgICAgbGV2ZWwgPT4gZGVidWcsCiAgICAgICAgICAgICAgICBjb25maWcgPT4gI3sKICAgICAgICAgICAgICAgICAgICBidXJzdF9saW1pdF9lbmFibGUgPT4gZmFsc2UKICAgICAgICAgICAgICAgIH0sCiAgICAgICAgICAgICAgICBmb3JtYXR0ZXIgPT4ge2xvZ2dlcl9mb3JtYXR0ZXIsICN7dGVtcGxhdGUgPT4gW3RpbWUsICIgIiwgbXNnLCAiXG4iXX19CiAgICAgICAgICAgIH19CiAgICAgICAgXX0KICAgIF19LAogICAge29zX21vbiwgWwogICAgICAgIHtkaXNrX2FsbW9zdF9mdWxsX3RocmVzaG9sZCwgMC45MH0sCiAgICAgICAge3N5c3RlbV9tZW1vcnlfaGlnaF93YXRlcm1hcmssIDAuOTd9CiAgICBdfQpdLgpFUkxFT0YKZWNobyAicGF0Y2hlZCIKJ0AKICAgICRkaXNrRml4U2NyaXB0ID0gJGRpc2tGaXhTY3JpcHQgLXJlcGxhY2UgImByYG4iLCAiYG4iICAjIENSTEYgYnJlYWtzIGhlcmVkb2MgZGVsaW1pdGVyIHdoZW4gZGVjb2RlZCBpbiBiYXNoCiAgICAkZGlza0ZpeEI2NCA9IFtDb252ZXJ0XTo6VG9CYXNlNjRTdHJpbmcoW1N5c3RlbS5UZXh0LkVuY29kaW5nXTo6VVRGOC5HZXRCeXRlcygkZGlza0ZpeFNjcmlwdCkpCiAgICAkZGlza1Jlc3VsdCA9IHdzbCAtZCBVYnVudHUtMjIuMDQgLS11c2VyIHJvb3QgLS0gYmFzaCAtYyAiZWNobyAnJGRpc2tGaXhCNjQnIHwgYmFzZTY0IC1kIHwgYmFzaCIgMj4mMQogICAgJGRpc2tPayA9ICgkTEFTVEVYSVRDT0RFIC1lcSAwKSAtYW5kICgkZGlza1Jlc3VsdCAtbm90bWF0Y2ggJ3N5bnRheCBlcnJvcnxub3QgZm91bmR8ZXJyb3InKQogICAgV3JpdGUtTG9nICJPU04gYWxhcm0gdGhyZXNob2xkczogJCgkZGlza1Jlc3VsdCAtam9pbiAnICcpIiAkKGlmICgkZGlza09rKSB7ICJPSyIgfSBlbHNlIHsgIldBUk4iIH0pCiAgICBpZiAoJGRpc2tPaykgewogICAgICAgIFNldC1TdGVwICJPU04gYWxhcm0gdGhyZXNob2xkcyIgIlBBU1MiCiAgICB9IGVsc2UgewogICAgICAgIFNldC1TdGVwICJPU04gYWxhcm0gdGhyZXNob2xkcyIgIldBUk4iICJ0aHJlc2hvbGQgcGF0Y2ggZmFpbGVkIOKAlCBPU04gbWF5IHJlc3RhcnQgaWYgZGlzayA+ODAlIG9yIG1lbW9yeSBjYWNoZSBmaWxscyIKICAgIH0KCiAgICAjIOKUgOKUgCBTdGFiaWxpdHkgRml4IDM6IGRpc2FibGUgV2luZG93cyBVcGRhdGUgYXV0by1yZXN0YXJ0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogICAgIyBXaW5kb3dzIDExIGNhbiBmb3JjZS1yZXN0YXJ0IG1pZC1yZW50YWwgdG8gYXBwbHkgdXBkYXRlcywgdGVybWluYXRpbmcgYW55IHJ1bm5pbmcgam9iCiAgICAjIHdpdGggIm5vZGUgd2VudCBkb3duIG9yIHJlYm9vdGVkIGR1cmluZyBzZXNzaW9uIi4gQmxvY2sgYXV0by1yZXN0YXJ0IHdoZW4gYSB1c2VyIGlzCiAgICAjIGxvZ2dlZCBpbiAodXBkYXRlcyBzdGlsbCBkb3dubG9hZCBhbmQgaW5zdGFsbDsgdGhleSBqdXN0IGRvbid0IHJlc3RhcnQgd2l0aG91dCBjb25zZW50KS4KICAgIFdyaXRlLUxvZyAiQmxvY2tpbmcgV2luZG93cyBVcGRhdGUgYXV0by1yZXN0YXJ0IGR1cmluZyBhY3RpdmUgc2Vzc2lvbnMuLi4iCiAgICB0cnkgewogICAgICAgICR3dVBhdGggPSAiSEtMTTpcU09GVFdBUkVcUG9saWNpZXNcTWljcm9zb2Z0XFdpbmRvd3NcV2luZG93c1VwZGF0ZVxBVSIKICAgICAgICBpZiAoLW5vdCAoVGVzdC1QYXRoICR3dVBhdGgpKSB7IE5ldy1JdGVtIC1QYXRoICR3dVBhdGggLUZvcmNlIHwgT3V0LU51bGwgfQogICAgICAgIFNldC1JdGVtUHJvcGVydHkgLVBhdGggJHd1UGF0aCAtTmFtZSAiTm9BdXRvUmVib290V2l0aExvZ2dlZE9uVXNlcnMiIC1WYWx1ZSAxIC1UeXBlIERXb3JkIC1Gb3JjZQogICAgICAgIFNldC1JdGVtUHJvcGVydHkgLVBhdGggJHd1UGF0aCAtTmFtZSAiQVVPcHRpb25zIiAtVmFsdWUgNCAtVHlwZSBEV29yZCAtRm9yY2UgICMgNCA9IGRvd25sb2FkIGFuZCBzY2hlZHVsZSBpbnN0YWxsIChubyBhdXRvLWluc3RhbGwpCiAgICAgICAgV3JpdGUtTG9nICJXaW5kb3dzIFVwZGF0ZSBhdXRvLXJlc3RhcnQgc3VwcHJlc3NlZCIgIk9LIgogICAgICAgIFNldC1TdGVwICJXaW5kb3dzIFVwZGF0ZSByZXN0YXJ0IGd1YXJkIiAiUEFTUyIKICAgIH0gY2F0Y2ggewogICAgICAgIFdyaXRlLUxvZyAiQ291bGQgbm90IHNldCBXaW5kb3dzIFVwZGF0ZSBwb2xpY3kgKG5vbi1mYXRhbCk6ICRfIiAiV0FSTiIKICAgICAgICBTZXQtU3RlcCAiV2luZG93cyBVcGRhdGUgcmVzdGFydCBndWFyZCIgIldBUk4iICJNYW51YWw6IHNldCBOb0F1dG9SZWJvb3RXaXRoTG9nZ2VkT25Vc2Vycz0xIGluIEdyb3VwIFBvbGljeSIKICAgIH0KCiAgICAjIFN0YXJ0IHRoZSBzZXJ2aWNlIHNvIGl0IGNhbiByZWdpc3RlciBhbmQgZ2VuZXJhdGUgYSBub2RlIHRva2VuCiAgICBXcml0ZS1Mb2cgIlN0YXJ0aW5nIG9zbiBzZXJ2aWNlLi4uIgogICAgd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICJzeXN0ZW1jdGwgZW5hYmxlIG9zbiAyPi9kZXYvbnVsbDsgc3lzdGVtY3RsIHN0YXJ0IG9zbiAyPi9kZXYvbnVsbCIKICAgIFNldC1TdGVwICJvc24gc2VydmljZSBzdGFydGVkIiAiUEFTUyIKCiAgICAjIOKUgOKUgCBFeHRyYWN0IE9jdGFTcGFjZSBub2RlIHRva2VuIGZyb20gaW5zdGFsbGVyIG91dHB1dCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAgICMgVGhlIGluc3RhbGxlciBwcmludHMgYSBib3g6IOKVkSAgTm9kZSBUb2tlbjogWFhYWFhYWFhYWCAg4pWRIHRvIHN0ZG91dC4KICAgICRvY3RhTm9kZVRva2VuID0gIiIKICAgICR0b2tlbk1hdGNoID0gJG9jdGFPdXRwdXQgfCBTZWxlY3QtU3RyaW5nIC1QYXR0ZXJuICdOb2RlIFRva2VuOlxzKihcUyspJwogICAgaWYgKCR0b2tlbk1hdGNoKSB7CiAgICAgICAgJG9jdGFOb2RlVG9rZW4gPSAkdG9rZW5NYXRjaC5NYXRjaGVzWzBdLkdyb3Vwc1sxXS5WYWx1ZS5UcmltKCkKICAgICAgICBXcml0ZS1Mb2cgIk9jdGFTcGFjZSBub2RlIHRva2VuOiAkb2N0YU5vZGVUb2tlbiIgIk9LIgogICAgICAgIFNldC1TdGVwICJPY3RhU3BhY2Ugbm9kZSB0b2tlbiIgIlBBU1MiICJUb2tlbjogJG9jdGFOb2RlVG9rZW4iCiAgICB9IGVsc2UgewogICAgICAgICMgRmFsbGJhY2s6IGNoZWNrIGNvbmZpZyBmaWxlcyB3cml0dGVuIGJ5IG9zbiBhZnRlciBmaXJzdCBzdGFydAogICAgICAgIFdyaXRlLUxvZyAiVG9rZW4gbm90IGZvdW5kIGluIGluc3RhbGxlciBvdXRwdXQg4oCUIGNoZWNraW5nIG9zbiBjb25maWcgZmlsZXMuLi4iCiAgICAgICAgU3RhcnQtU2xlZXAgMTUKICAgICAgICAkcmF3ID0gd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jIEAnCmZvciBmIGluIC9ob21lL29jdGEvb3NuL2V0Yy9zeXMuY29uZmlnIC9ldGMvb3NuL25vZGUuanNvbiAvdmFyL2xpYi9vc24vbm9kZS5qc29uOyBkbwogICAgWyAtZiAiJGYiIF0gfHwgY29udGludWUKICAgIHRvaz0kKGdyZXAgLW9QICcibm9kZV90b2tlbiJccyo6XHMqIlxLW14iXSsnICIkZiIgMj4vZGV2L251bGwgfHwgZ3JlcCAtb1AgJyJ0b2tlbiJccyo6XHMqIlxLW14iXSsnICIkZiIgMj4vZGV2L251bGwpCiAgICBbIC1uICIkdG9rIiBdICYmIGVjaG8gIiR0b2siICYmIGJyZWFrCmRvbmUKJ0AgMj4mMQogICAgICAgICRjYW5kaWRhdGUgPSAoJHJhdyB8IFdoZXJlLU9iamVjdCB7ICRfIC1tYXRjaCAnXlxzKlxTezYsfVxzKiQnIH0pIHwgU2VsZWN0LU9iamVjdCAtRmlyc3QgMQogICAgICAgIGlmICgkY2FuZGlkYXRlKSB7CiAgICAgICAgICAgICRvY3RhTm9kZVRva2VuID0gJGNhbmRpZGF0ZS5UcmltKCkKICAgICAgICAgICAgV3JpdGUtTG9nICJPY3RhU3BhY2Ugbm9kZSB0b2tlbiAoZnJvbSBjb25maWcpOiAkb2N0YU5vZGVUb2tlbiIgIk9LIgogICAgICAgICAgICBTZXQtU3RlcCAiT2N0YVNwYWNlIG5vZGUgdG9rZW4iICJQQVNTIiAiVG9rZW46ICRvY3RhTm9kZVRva2VuIgogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICAgIFdyaXRlLUxvZyAiTm9kZSB0b2tlbiBub3QgZm91bmQg4oCUIGl0IHdpbGwgYXBwZWFyIGF0IGN1YmUub2N0YS5jb21wdXRlciBhZnRlciB0aGUgbm9kZSBjb25uZWN0cyIgIldBUk4iCiAgICAgICAgICAgIFNldC1TdGVwICJPY3RhU3BhY2Ugbm9kZSB0b2tlbiIgIldBUk4iICJOb3QgeWV0IGFzc2lnbmVkIOKAlCBjaGVjayBjdWJlLm9jdGEuY29tcHV0ZXIiCiAgICAgICAgfQogICAgfQoKICAgICMg4pSA4pSAIE5ldHdvcmtpbmc6IFdpbmRvd3MgRmlyZXdhbGwgKyBVUG5QIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogICAgV3JpdGUtTG9nICJBZGRpbmcgV2luZG93cyBGaXJld2FsbCBpbmJvdW5kIHJ1bGVzIChUQ1AgKyBVRFApLi4uIgogICAgJGFsbFBvcnRzID0gJE9DVEFfTUdNVF9QT1JUUyArICgkT0NUQV9BUFBfUE9SVF9TVEFSVC4uJE9DVEFfQVBQX1BPUlRfRU5EKQogICAgZm9yZWFjaCAoJHBvcnQgaW4gJGFsbFBvcnRzKSB7CiAgICAgICAgTmV3LU5ldEZpcmV3YWxsUnVsZSAtRGlzcGxheU5hbWUgIlB1bHNlLU9jdGEtVENQLSRwb3J0IiAtRGlyZWN0aW9uIEluYm91bmQgYAogICAgICAgICAgICAtUHJvdG9jb2wgVENQIC1Mb2NhbFBvcnQgJHBvcnQgLUFjdGlvbiBBbGxvdyAtRXJyb3JBY3Rpb24gU2lsZW50bHlDb250aW51ZSB8IE91dC1OdWxsCiAgICAgICAgTmV3LU5ldEZpcmV3YWxsUnVsZSAtRGlzcGxheU5hbWUgIlB1bHNlLU9jdGEtVURQLSRwb3J0IiAtRGlyZWN0aW9uIEluYm91bmQgYAogICAgICAgICAgICAtUHJvdG9jb2wgVURQIC1Mb2NhbFBvcnQgJHBvcnQgLUFjdGlvbiBBbGxvdyAtRXJyb3JBY3Rpb24gU2lsZW50bHlDb250aW51ZSB8IE91dC1OdWxsCiAgICB9CiAgICBXcml0ZS1Mb2cgIkZpcmV3YWxsIHJ1bGVzIGFkZGVkIChUQ1ArVURQKSBmb3IgcG9ydHMgJCgkT0NUQV9NR01UX1BPUlRTIC1qb2luICcsICcpICsgJE9DVEFfQVBQX1BPUlRfU1RBUlQtJE9DVEFfQVBQX1BPUlRfRU5EIiAiT0siCiAgICBTZXQtU3RlcCAiV2luZG93cyBGaXJld2FsbCBydWxlcyIgIlBBU1MiICJUQ1ArVURQICQoJE9DVEFfTUdNVF9QT1JUUyAtam9pbiAnLCAnKSwgJE9DVEFfQVBQX1BPUlRfU1RBUlQtJE9DVEFfQVBQX1BPUlRfRU5EIgoKICAgIFdyaXRlLUxvZyAiQXR0ZW1wdGluZyBVUG5QIGF1dG9tYXRpYyBwb3J0IGZvcndhcmRpbmcuLi4iCiAgICAkbG9jYWxJUCA9IEdldC1Mb2NhbElQCiAgICAkdXBucE9rICA9ICRmYWxzZQogICAgdHJ5IHsKICAgICAgICAkdXBucCAgICAgPSBOZXctT2JqZWN0IC1Db21PYmplY3QgSE5ldENmZy5OQVRVUG5QCiAgICAgICAgJG1hcHBpbmdzID0gJHVwbnAuU3RhdGljUG9ydE1hcHBpbmdDb2xsZWN0aW9uCiAgICAgICAgZm9yZWFjaCAoJHBvcnQgaW4gJGFsbFBvcnRzKSB7CiAgICAgICAgICAgICRtYXBwaW5ncy5BZGQoJHBvcnQsICJUQ1AiLCAkcG9ydCwgJGxvY2FsSVAsICR0cnVlLCAiUHVsc2UtT2N0YS1UQ1AtJHBvcnQiKSB8IE91dC1OdWxsCiAgICAgICAgICAgICRtYXBwaW5ncy5BZGQoJHBvcnQsICJVRFAiLCAkcG9ydCwgJGxvY2FsSVAsICR0cnVlLCAiUHVsc2UtT2N0YS1VRFAtJHBvcnQiKSB8IE91dC1OdWxsCiAgICAgICAgfQogICAgICAgIFdyaXRlLUxvZyAiVVBuUCBzdWNjZWVkZWQg4oCUIHBvcnRzICQoJE9DVEFfTUdNVF9QT1JUUyAtam9pbiAnLCAnKSwgJE9DVEFfQVBQX1BPUlRfU1RBUlQtJE9DVEFfQVBQX1BPUlRfRU5EIGZvcndhcmRlZCAoVENQK1VEUCkgdG8gJGxvY2FsSVAiICJPSyIKICAgICAgICBTZXQtU3RlcCAiVVBuUCBwb3J0IGZvcndhcmRpbmciICJQQVNTIiAiQXV0by1mb3J3YXJkZWQgKFRDUCtVRFApIOKGkiAkbG9jYWxJUCIKICAgICAgICAkdXBucE9rID0gJHRydWUKICAgIH0gY2F0Y2ggewogICAgICAgIFdyaXRlLUxvZyAiVVBuUCB1bmF2YWlsYWJsZSBvbiB0aGlzIHJvdXRlciIgIldBUk4iCiAgICAgICAgU2V0LVN0ZXAgIlVQblAgcG9ydCBmb3J3YXJkaW5nIiAiV0FSTiIgIlVQblAgdW5hdmFpbGFibGUg4oCUIG1hbnVhbCByb3V0ZXIgc2V0dXAgcmVxdWlyZWQgKFRDUCtVRFAsIHNlZSBhYm92ZSkiCiAgICB9CgogICAgaWYgKC1ub3QgJHVwbnBPaykgewogICAgICAgIFdyaXRlLUhvc3QgIiIKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUjOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUkCIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgUk9VVEVSIFNFVFVQIFJFUVVJUkVEIChvbmUtdGltZSwgfjIgbWludXRlcykgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgIFlvdXIgcm91dGVyIGRvZXNuJ3Qgc3VwcG9ydCBhdXRvLWZvcndhcmRpbmcgKFVQblAgb2ZmKS4gICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICBPY3RhU3BhY2UgbmVlZHMgQk9USCBUQ1AgYW5kIFVEUCBmb3J3YXJkZWQuICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICAxLiBPcGVuIHlvdXIgcm91dGVyIGFkbWluIHBhZ2UgKHVzdWFsbHkgaHR0cDovLzE5Mi4xNjguMS4xKeKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgMi4gRmluZCAnUG9ydCBGb3J3YXJkaW5nJyBvciAnVmlydHVhbCBTZXJ2ZXInICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgIDMuIEFkZCBUQ1ArVURQIHJ1bGVzIOKGkiAkbG9jYWxJUCA6ICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgVENQK1VEUCAxODg4OCDihpIgJGxvY2FsSVBgOjE4ODg4ICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgVENQK1VEUCAkT0NUQV9BUFBfUE9SVF9TVEFSVC0kT0NUQV9BUFBfUE9SVF9FTkQg4oaSICRsb2NhbElQYDokT0NUQV9BUFBfUE9SVF9TVEFSVC0kT0NUQV9BUFBfUE9SVF9FTkQg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgIFByZXNzIEVudGVyIG9uY2UgZG9uZSAoeW91IGNhbiBmaW5pc2ggdGhpcyBsYXRlciB2aWEgdGhlICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICBQdWxzZSBkYXNoYm9hcmQg4oCUIGJ1dCBqb2JzIHdvbid0IGxhbmQgdW50aWwgaXQncyBkb25lKSAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSU4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSYIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgICAgIFJlYWQtSG9zdCAiICBQcmVzcyBFbnRlciB0byBjb250aW51ZSIKICAgIH0KCiAgICAjIOKUgOKUgCBXU0wyIFBvcnQgUHJveHkgKFRDUCBvbmx5KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAgIGlmICgtbm90ICRtaXJyb3JlZE5ldHdvcmtpbmcpIHsKICAgICAgICBXcml0ZS1Mb2cgIkNvbmZpZ3VyaW5nIFdTTDIgVENQIHBvcnQgcHJveHkgKFdpbmRvd3MgaG9zdCDihpIgV1NMMiBicmlkZ2UpLi4uIgogICAgICAgICR3c2xJUCA9ICh3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tdXNlciByb290IC0tIGJhc2ggLWMgImhvc3RuYW1lIC1JIDI+L2Rldi9udWxsIikuVHJpbSgpLlNwbGl0KClbMF0KICAgICAgICBpZiAoJHdzbElQKSB7CiAgICAgICAgICAgIFNldC1XU0wyUG9ydFByb3h5IC1Xc2xJUCAkd3NsSVAKICAgICAgICAgICAgU2V0LUNvbnRlbnQgLVBhdGggIiRQVUxTRV9ESVJcbGFzdF93c2xfaXAiIC1WYWx1ZSAkd3NsSVAgLUVuY29kaW5nIFVURjgKICAgICAgICAgICAgU2V0LVN0ZXAgIldTTDIgcG9ydCBwcm94eSIgIlBBU1MiICJUQ1Ag4oaSICR3c2xJUCAoVURQIHJlcXVpcmVzIG1pcnJvcmVkIG5ldHdvcmtpbmcpIgogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICAgIFdyaXRlLUxvZyAiQ291bGQgbm90IGRldGVybWluZSBXU0wyIElQIOKAlCBwb3J0cHJveHkgc2tpcHBlZDsgd2lsbCByZXRyeSBvbiBuZXh0IGxvZ2luIiAiV0FSTiIKICAgICAgICAgICAgU2V0LVN0ZXAgIldTTDIgcG9ydCBwcm94eSIgIldBUk4iICJXU0wyIElQIG5vdCBmb3VuZCDigJQgd2lsbCByZXRyeSBvbiBuZXh0IGxvZ2luIgogICAgICAgIH0KICAgIH0gZWxzZSB7CiAgICAgICAgV3JpdGUtTG9nICJNaXJyb3JlZCBuZXR3b3JraW5nIGFjdGl2ZSDigJQgcG9ydHByb3h5IG5vdCBuZWVkZWQ7IFVEUCB0dW5uZWxzIGZ1bGx5IGZ1bmN0aW9uYWwiICJPSyIKICAgICAgICBTZXQtU3RlcCAiV1NMMiBwb3J0IHByb3h5IiAiU0tJUCIgIk5vdCBuZWVkZWQg4oCUIG1pcnJvcmVkIG5ldHdvcmtpbmcgYWN0aXZlIgogICAgfQoKICAgICMg4pSA4pSAIEN1YmUgcmVnaXN0cmF0aW9uIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogICAgV3JpdGUtSG9zdCAiIgogICAgV3JpdGUtSG9zdCAiICDilIzilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilJAiIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbgogICAgV3JpdGUtSG9zdCAiICDilIIgIE9DVEFTUEFDRSBDVUJFIFJFR0lTVFJBVElPTiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbgogICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBDeWFuCiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgVG8gYXBwZWFyIGluIHRoZSBPY3RhU3BhY2UgbWFya2V0cGxhY2U6ICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4KICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgIDEuIE9wZW46IGh0dHBzOi8vY3ViZS5vY3RhLmNvbXB1dGVyICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbgogICAgV3JpdGUtSG9zdCAiICDilIIgICAgMi4gU2lnbiBpbiAvIGNyZWF0ZSBhbiBhY2NvdW50ICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBDeWFuCiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAzLiBBZGQgeW91ciBub2RlIOKAlCBpdCBzaG91bGQgYXBwZWFyIGF1dG9tYXRpY2FsbHkgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbgogICAgaWYgKCRvY3RhTm9kZVRva2VuKSB7CiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4KICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgIFlvdXIgbm9kZSB0b2tlbjogJG9jdGFOb2RlVG9rZW4iIC1Gb3JlZ3JvdW5kQ29sb3IgV2hpdGUKICAgIH0KICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbgogICAgV3JpdGUtSG9zdCAiICDilIIgIFRoaXMgc3RlcCBpcyBkb25lIGluIHlvdXIgYnJvd3Nlciwgbm90IHRoaXMgd2luZG93LiAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBDeWFuCiAgICBXcml0ZS1Ib3N0ICIgIOKUlOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUmCIgLUZvcmVncm91bmRDb2xvciBDeWFuCiAgICBXcml0ZS1Ib3N0ICIiCiAgICBSZWFkLUhvc3QgIiAgUHJlc3MgRW50ZXIgdG8gY29udGludWUgb25jZSB5b3UndmUgbm90ZWQgdGhlIGFib3ZlIgoKICAgICMg4pSA4pSAIFJlZ2lzdGVyIHdpdGggUHVsc2Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgICBXcml0ZS1Mb2cgIlJlZ2lzdGVyaW5nIG1hY2hpbmUgd2l0aCBQdWxzZS4uLiIKCiAgICAkYm9keSA9IEB7CiAgICAgICAgZ3B1X21vZGVsICAgICAgICA9ICRncHVOYW1lCiAgICAgICAgdnJhbV9nYiAgICAgICAgICA9ICR2cmFtR2IKICAgICAgICBvY3RhX25vZGVfdG9rZW4gID0gJG9jdGFOb2RlVG9rZW4KICAgICAgICBwbGF0Zm9ybSAgICAgICAgID0gIk9jdGFTcGFjZSIKICAgIH0gfCBDb252ZXJ0VG8tSnNvbgoKICAgIHRyeSB7CiAgICAgICAgJHJlc3AgPSBJbnZva2UtUmVzdE1ldGhvZCAtVXJpICIkUFVMU0VfQVBJX0JBU0UvcmVnaXN0ZXJPY3Rhc3BhY2VEYWVtb24iIGAKICAgICAgICAgICAgLU1ldGhvZCBQT1NUIGAKICAgICAgICAgICAgLUNvbnRlbnRUeXBlICJhcHBsaWNhdGlvbi9qc29uIiBgCiAgICAgICAgICAgIC1IZWFkZXJzIEB7ICJBdXRob3JpemF0aW9uIiA9ICJCZWFyZXIgJFBVTFNFX1VTRVJfVE9LRU4iIH0gYAogICAgICAgICAgICAtQm9keSAkYm9keQogICAgICAgIFdyaXRlLUxvZyAiUHVsc2UgcmVnaXN0cmF0aW9uOiAkKCRyZXNwLm1lc3NhZ2UpIiAiT0siCiAgICAgICAgU2V0LVN0ZXAgIlB1bHNlIHJlZ2lzdHJhdGlvbiIgIlBBU1MiCiAgICB9IGNhdGNoIHsKICAgICAgICBXcml0ZS1Mb2cgIlB1bHNlIHJlZ2lzdHJhdGlvbiBmYWlsZWQgKHdpbGwgcmV0cnkgb24gbmV4dCBzdGFydCk6ICRfIiAiV0FSTiIKICAgICAgICBTZXQtU3RlcCAiUHVsc2UgcmVnaXN0cmF0aW9uIiAiV0FSTiIgIldpbGwgcmV0cnkgYXV0b21hdGljYWxseSBvbiBuZXh0IGxvZ2luIgogICAgfQoKICAgICMg4pSA4pSAIEdQVSBXYXRjaGRvZzogcGF1c2Ugb3NuIGR1cmluZyBnYW1pbmcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgICBXcml0ZS1Mb2cgIkluc3RhbGxpbmcgR1BVIGdhbWluZyB3YXRjaGRvZy4uLiIKICAgICR3YXRjaGRvZyA9IEAnCiRoaSA9IDc1OyAkbG8gPSAyMDsgJHBhdXNlZCA9ICRmYWxzZQokdmVuZG9yID0gaWYgKEdldC1XbWlPYmplY3QgV2luMzJfVmlkZW9Db250cm9sbGVyIHwgV2hlcmUtT2JqZWN0IHsgJF8uTmFtZSAtbWF0Y2ggJ05WSURJQXxHZUZvcmNlfFJUWHxHVFgnIH0gfCBTZWxlY3QtT2JqZWN0IC1GaXJzdCAxKSB7ICdOVklESUEnIH0gZWxzZSB7ICdBTUQnIH0KJHdkTG9nID0gIiRlbnY6TE9DQUxBUFBEQVRBXFB1bHNlXG9jdGFfd2F0Y2hkb2cubG9nIgoka2VlcGFsaXZlUGlkID0gJG51bGwKCmZ1bmN0aW9uIEVuc3VyZS1XU0xBbGl2ZSB7CiAgICBpZiAoJG51bGwgLWVxICRrZWVwYWxpdmVQaWQgLW9yIC1ub3QgKEdldC1Qcm9jZXNzIC1JZCAka2VlcGFsaXZlUGlkIC1FcnJvckFjdGlvbiBTaWxlbnRseUNvbnRpbnVlKSkgewogICAgICAgICRwID0gU3RhcnQtUHJvY2VzcyAid3NsLmV4ZSIgLUFyZ3VtZW50TGlzdCAiLWQgVWJ1bnR1LTIyLjA0IC0tdXNlciByb290IC0tIHNsZWVwIDM2MDAiIC1QYXNzVGhydSAtV2luZG93U3R5bGUgSGlkZGVuIC1FcnJvckFjdGlvbiBTaWxlbnRseUNvbnRpbnVlCiAgICAgICAgaWYgKCRwKSB7CiAgICAgICAgICAgICRzY3JpcHQ6a2VlcGFsaXZlUGlkID0gJHAuSWQKICAgICAgICAgICAgQWRkLUNvbnRlbnQgJHdkTG9nICIkKEdldC1EYXRlIC1mICdISDptbScpIFdTTCBrZWVwYWxpdmUgc3RhcnRlZCAoUElEICQoJHAuSWQpKSIKICAgICAgICB9CiAgICB9Cn0KCkVuc3VyZS1XU0xBbGl2ZQoKd2hpbGUgKCR0cnVlKSB7CiAgICB0cnkgewogICAgICAgIEVuc3VyZS1XU0xBbGl2ZQogICAgICAgICR1dGlsID0gaWYgKCR2ZW5kb3IgLWVxICdOVklESUEnKSB7CiAgICAgICAgICAgIFtpbnRdKCYgbnZpZGlhLXNtaSAtLXF1ZXJ5LWdwdT11dGlsaXphdGlvbi5ncHUgLS1mb3JtYXQ9Y3N2LG5vaGVhZGVyLG5vdW5pdHMgMj4kbnVsbCkuVHJpbSgpCiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgICAgJHMgPSBHZXQtQ291bnRlciAnXEdQVSBFbmdpbmUoKmVuZ3R5cGVfM0QpXFV0aWxpemF0aW9uIFBlcmNlbnRhZ2UnIC1FcnJvckFjdGlvbiBTaWxlbnRseUNvbnRpbnVlCiAgICAgICAgICAgIGlmICgkcykgeyBbaW50XSgkcy5Db3VudGVyU2FtcGxlcyB8IE1lYXN1cmUtT2JqZWN0IC1Qcm9wZXJ0eSBDb29rZWRWYWx1ZSAtTWF4aW11bSkuTWF4aW11bSB9IGVsc2UgeyAwIH0KICAgICAgICB9CiAgICAgICAgaWYgKCR1dGlsIC1ndCAkaGkgLWFuZCAtbm90ICRwYXVzZWQpIHsKICAgICAgICAgICAgd3NsIC1kIFVidW50dS0yMi4wNCAtLSBiYXNoIC1jICJzdWRvIHN5c3RlbWN0bCBzdG9wIG9zbiAyPi9kZXYvbnVsbCIKICAgICAgICAgICAgJHBhdXNlZCA9ICR0cnVlCiAgICAgICAgICAgIEFkZC1Db250ZW50ICR3ZExvZyAiJChHZXQtRGF0ZSAtZiAnSEg6bW0nKSBQQVVTRUQgKEdQVSAkdXRpbCUpIgogICAgICAgIH0gZWxzZWlmICgkdXRpbCAtbHQgJGxvIC1hbmQgJHBhdXNlZCkgewogICAgICAgICAgICB3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tIGJhc2ggLWMgInN1ZG8gc3lzdGVtY3RsIHN0YXJ0IG9zbiAyPi9kZXYvbnVsbCIKICAgICAgICAgICAgJHBhdXNlZCA9ICRmYWxzZQogICAgICAgICAgICBBZGQtQ29udGVudCAkd2RMb2cgIiQoR2V0LURhdGUgLWYgJ0hIOm1tJykgUkVTVU1FRCAoR1BVICR1dGlsJSkiCiAgICAgICAgfQogICAgfSBjYXRjaCB7fQogICAgU3RhcnQtU2xlZXAgMzAKfQonQAogICAgJHdhdGNoZG9nUGF0aCA9ICIkUFVMU0VfRElSXG9jdGFfd2F0Y2hkb2cucHMxIgogICAgU2V0LUNvbnRlbnQgLVBhdGggJHdhdGNoZG9nUGF0aCAtVmFsdWUgJHdhdGNoZG9nIC1FbmNvZGluZyBVVEY4CgogICAgJHdBID0gTmV3LVNjaGVkdWxlZFRhc2tBY3Rpb24gLUV4ZWN1dGUgInBvd2Vyc2hlbGwuZXhlIiBgCiAgICAgICAgLUFyZ3VtZW50ICItTm9Qcm9maWxlIC1FeGVjdXRpb25Qb2xpY3kgQnlwYXNzIC1XaW5kb3dTdHlsZSBIaWRkZW4gLUZpbGUgYCIkd2F0Y2hkb2dQYXRoYCIiCiAgICAkd1QgPSBOZXctU2NoZWR1bGVkVGFza1RyaWdnZXIgLUF0TG9nT24KICAgICR3UyA9IE5ldy1TY2hlZHVsZWRUYXNrU2V0dGluZ3NTZXQgLUFsbG93U3RhcnRJZk9uQmF0dGVyaWVzIC1FeGVjdXRpb25UaW1lTGltaXQgMAogICAgJHdQID0gTmV3LVNjaGVkdWxlZFRhc2tQcmluY2lwYWwgLVVzZXJJZCAkZW52OlVTRVJOQU1FIC1SdW5MZXZlbCBIaWdoZXN0CiAgICBSZWdpc3Rlci1TY2hlZHVsZWRUYXNrIC1UYXNrTmFtZSAkV0FUQ0hET0dfVEFTSyAtQWN0aW9uICR3QSAtVHJpZ2dlciAkd1QgYAogICAgICAgIC1TZXR0aW5ncyAkd1MgLVByaW5jaXBhbCAkd1AgLUZvcmNlIHwgT3V0LU51bGwKICAgIFdyaXRlLUxvZyAiR1BVIHdhdGNoZG9nIGluc3RhbGxlZCAocGF1c2VzIGR1cmluZyBnYW1pbmcsIHJlc3VtZXMgd2hlbiBpZGxlKSIgIk9LIgogICAgU2V0LVN0ZXAgIkdQVSB3YXRjaGRvZyB0YXNrIiAiUEFTUyIKCiAgICAjIOKUgOKUgCBBdXRvLXN0YXJ0OiBvc24gb24gZXZlcnkgbG9naW4g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgICBXcml0ZS1Mb2cgIkluc3RhbGxpbmcgYXV0by1zdGFydCB0YXNrLi4uIgogICAgJGF1dG9zdGFydCA9IGlmICgkbWlycm9yZWROZXR3b3JraW5nKSB7CiAgICAgICAgQCcKU3RhcnQtU2xlZXAgMTUKd3NsIC1kIFVidW50dS0yMi4wNCAtLSBiYXNoIC1jICdzdWRvIHN5c3RlbWN0bCBzdGFydCBvc24gMj4vZGV2L251bGwnIDI+JjEgfAogICAgQWRkLUNvbnRlbnQgIiRlbnY6TE9DQUxBUFBEQVRBXFB1bHNlXG9jdGFfYXV0b3N0YXJ0LmxvZyIKJ0AKICAgIH0gZWxzZSB7CiAgICAgICAgQCIKU3RhcnQtU2xlZXAgMTUKYCR3c2xJUCA9ICh3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tdXNlciByb290IC0tIGJhc2ggLWMgJ2hvc3RuYW1lIC1JIDI+L2Rldi9udWxsJykuVHJpbSgpLlNwbGl0KClbMF0KYCRsYXN0SVBGaWxlID0gImAkZW52OkxPQ0FMQVBQREFUQVxQdWxzZVxsYXN0X3dzbF9pcCIKYCRsYXN0SVAgPSBpZiAoVGVzdC1QYXRoIGAkbGFzdElQRmlsZSkgeyAoR2V0LUNvbnRlbnQgYCRsYXN0SVBGaWxlKS5UcmltKCkgfSBlbHNlIHsgJycgfQppZiAoYCR3c2xJUCAtYW5kIGAkd3NsSVAgLW5lIGAkbGFzdElQKSB7CiAgICAoQCgxODg4OCkgKyAoNTE4MDAuLjUxODE2KSkgfCBGb3JFYWNoLU9iamVjdCB7CiAgICAgICAgbmV0c2ggaW50ZXJmYWNlIHBvcnRwcm94eSBkZWxldGUgdjR0b3Y0IGxpc3RlbnBvcnQ9YCRfIGxpc3RlbmFkZHJlc3M9MC4wLjAuMCB8IE91dC1OdWxsCiAgICAgICAgbmV0c2ggaW50ZXJmYWNlIHBvcnRwcm94eSBhZGQgdjR0b3Y0IGxpc3RlbnBvcnQ9YCRfIGxpc3RlbmFkZHJlc3M9MC4wLjAuMCBjb25uZWN0cG9ydD1gJF8gY29ubmVjdGFkZHJlc3M9YCR3c2xJUCB8IE91dC1OdWxsCiAgICB9CiAgICBTZXQtQ29udGVudCAtUGF0aCBgJGxhc3RJUEZpbGUgLVZhbHVlIGAkd3NsSVAKfQp3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tIGJhc2ggLWMgJ3N1ZG8gc3lzdGVtY3RsIHN0YXJ0IG9zbiAyPi9kZXYvbnVsbCcgMj4mMSB8CiAgICBBZGQtQ29udGVudCAiYCRlbnY6TE9DQUxBUFBEQVRBXFB1bHNlXG9jdGFfYXV0b3N0YXJ0LmxvZyIKIkAKICAgIH0KICAgICRzdGFydFBhdGggPSAiJFBVTFNFX0RJUlxvY3RhX2F1dG9zdGFydC5wczEiCiAgICBTZXQtQ29udGVudCAtUGF0aCAkc3RhcnRQYXRoIC1WYWx1ZSAkYXV0b3N0YXJ0IC1FbmNvZGluZyBVVEY4CgogICAgJHNBID0gTmV3LVNjaGVkdWxlZFRhc2tBY3Rpb24gLUV4ZWN1dGUgInBvd2Vyc2hlbGwuZXhlIiBgCiAgICAgICAgLUFyZ3VtZW50ICItTm9Qcm9maWxlIC1FeGVjdXRpb25Qb2xpY3kgQnlwYXNzIC1XaW5kb3dTdHlsZSBIaWRkZW4gLUZpbGUgYCIkc3RhcnRQYXRoYCIiCiAgICAkc1QgPSBOZXctU2NoZWR1bGVkVGFza1RyaWdnZXIgLUF0TG9nT24KICAgICRzUyA9IE5ldy1TY2hlZHVsZWRUYXNrU2V0dGluZ3NTZXQgLUFsbG93U3RhcnRJZk9uQmF0dGVyaWVzIC1FeGVjdXRpb25UaW1lTGltaXQgMAogICAgJHNQID0gTmV3LVNjaGVkdWxlZFRhc2tQcmluY2lwYWwgLVVzZXJJZCAkZW52OlVTRVJOQU1FIC1SdW5MZXZlbCBIaWdoZXN0CiAgICBSZWdpc3Rlci1TY2hlZHVsZWRUYXNrIC1UYXNrTmFtZSAkQVVUT1NUQVJUX1RBU0sgLUFjdGlvbiAkc0EgLVRyaWdnZXIgJHNUIGAKICAgICAgICAtU2V0dGluZ3MgJHNTIC1QcmluY2lwYWwgJHNQIC1Gb3JjZSB8IE91dC1OdWxsCiAgICBXcml0ZS1Mb2cgIkF1dG8tc3RhcnQgaW5zdGFsbGVkIiAiT0siCiAgICBTZXQtU3RlcCAiQXV0by1zdGFydCB0YXNrIiAiUEFTUyIKCiAgICAjIOKUgOKUgCBBdXRvLWxvZ2luOiBzdXJ2aXZlIHVuYXR0ZW5kZWQgcmVib290cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAgIFdyaXRlLUhvc3QgIiIKICAgIFdyaXRlLUhvc3QgIiAg4pSM4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSQIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgV3JpdGUtSG9zdCAiICDilIIgIEFVVE8tTE9HSU4gKHJlY29tbWVuZGVkIGZvciBkZWRpY2F0ZWQgR1BVIHNlcnZlcnMpICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgV2l0aG91dCB0aGlzLCBPY3RhU3BhY2UgZ29lcyBPRkZMSU5FIGFmdGVyIGFueSB1bmF0dGVuZGVkICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgcmVib290IChwb3dlciBjdXQsIFdpbmRvd3MgVXBkYXRlKSB1bnRpbCBzb21lb25lIGxvZ3MgaW4uICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgV3JpdGUtSG9zdCAiICDilIIgIFRyYWRlLW9mZjogc3RvcmVzIHlvdXIgV2luZG93cyBwYXNzd29yZCBpbiB0aGUgcmVnaXN0cnkuICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgV3JpdGUtSG9zdCAiICDilIIgIE9ubHkgZW5hYmxlIGlmIHRoaXMgbWFjaGluZSBpcyBpbiBhIHBoeXNpY2FsbHkgc2VjdXJlIHNwb3Qu4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgV3JpdGUtSG9zdCAiICDilIIgIFRvIHVuZG8gbGF0ZXI6IHJ1biBuZXRwbHdpeiBhbmQgcmUtZW5hYmxlIHBhc3N3b3JkIHByb21wdC4g4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgV3JpdGUtSG9zdCAiICDilJTilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilJgiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICBXcml0ZS1Ib3N0ICIiCiAgICAkZG9BdXRvTG9naW4gPSBSZWFkLUhvc3QgIiAgRW5hYmxlIGF1dG8tbG9naW4/ICh5L04pIgogICAgaWYgKCRkb0F1dG9Mb2dpbiAtbWF0Y2ggJ15bWXldJykgewogICAgICAgICRzZWN1cmVQYXNzID0gUmVhZC1Ib3N0ICIgIEVudGVyIHlvdXIgV2luZG93cyBsb2dpbiBwYXNzd29yZCIgLUFzU2VjdXJlU3RyaW5nCiAgICAgICAgJGJzdHIgICAgICA9IFtSdW50aW1lLkludGVyb3BTZXJ2aWNlcy5NYXJzaGFsXTo6U2VjdXJlU3RyaW5nVG9CU1RSKCRzZWN1cmVQYXNzKQogICAgICAgICRwbGFpblBhc3MgPSBbUnVudGltZS5JbnRlcm9wU2VydmljZXMuTWFyc2hhbF06OlB0clRvU3RyaW5nQXV0bygkYnN0cikKICAgICAgICBbUnVudGltZS5JbnRlcm9wU2VydmljZXMuTWFyc2hhbF06Olplcm9GcmVlQlNUUigkYnN0cikKCiAgICAgICAgJHJlZ1BhdGggPSAiSEtMTTpcU09GVFdBUkVcTWljcm9zb2Z0XFdpbmRvd3MgTlRcQ3VycmVudFZlcnNpb25cV2lubG9nb24iCiAgICAgICAgU2V0LUl0ZW1Qcm9wZXJ0eSAtUGF0aCAkcmVnUGF0aCAtTmFtZSAiQXV0b0FkbWluTG9nb24iICAgLVZhbHVlICIxIiAgICAgICAgICAgICAtVHlwZSBTdHJpbmcKICAgICAgICBTZXQtSXRlbVByb3BlcnR5IC1QYXRoICRyZWdQYXRoIC1OYW1lICJEZWZhdWx0VXNlcm5hbWUiICAgLVZhbHVlICRlbnY6VVNFUk5BTUUgICAtVHlwZSBTdHJpbmcKICAgICAgICBTZXQtSXRlbVByb3BlcnR5IC1QYXRoICRyZWdQYXRoIC1OYW1lICJEZWZhdWx0RG9tYWluTmFtZSIgLVZhbHVlICRlbnY6VVNFUkRPTUFJTiAtVHlwZSBTdHJpbmcKICAgICAgICBTZXQtSXRlbVByb3BlcnR5IC1QYXRoICRyZWdQYXRoIC1OYW1lICJEZWZhdWx0UGFzc3dvcmQiICAgLVZhbHVlICRwbGFpblBhc3MgICAgICAtVHlwZSBTdHJpbmcKICAgICAgICAkcGxhaW5QYXNzID0gJG51bGw7IFtTeXN0ZW0uR0NdOjpDb2xsZWN0KCkKCiAgICAgICAgV3JpdGUtTG9nICJBdXRvLWxvZ2luIGVuYWJsZWQgZm9yICRlbnY6VVNFUk5BTUUg4oCUIE9jdGFTcGFjZSByZXN1bWVzIGF1dG9tYXRpY2FsbHkgYWZ0ZXIgYW55IHJlYm9vdCIgIk9LIgogICAgICAgIFdyaXRlLUxvZyAiVG8gZGlzYWJsZTogcnVuIG5ldHBsd2l6IGFuZCByZS1jaGVjayAnVXNlcnMgbXVzdCBlbnRlciBhIHVzZXJuYW1lIGFuZCBwYXNzd29yZCciICJJTkZPIgogICAgICAgIFNldC1TdGVwICJBdXRvLWxvZ2luIiAiUEFTUyIgIkVuYWJsZWQgZm9yICRlbnY6VVNFUk5BTUUiCiAgICB9IGVsc2UgewogICAgICAgIFdyaXRlLUxvZyAiQXV0by1sb2dpbiBza2lwcGVkIOKAlCBtYWNoaW5lIHdpbGwgbmVlZCBhIG1hbnVhbCBsb2dpbiBhZnRlciByZWJvb3QgdG8gcmVzdW1lIE9jdGFTcGFjZSIgIldBUk4iCiAgICAgICAgU2V0LVN0ZXAgIkF1dG8tbG9naW4iICJTS0lQIiAiU2tpcHBlZCDigJQgR1BVIGdvZXMgb2ZmbGluZSBhZnRlciB1bmF0dGVuZGVkIHJlYm9vdHMiCiAgICB9CgogICAgIyDilIDilIAgQ2xlYW51cCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAgIHNjaHRhc2tzIC9kZWxldGUgL3RuICRUQVNLX05BTUUgL2YgMj4kbnVsbCB8IE91dC1OdWxsCiAgICBSZW1vdmUtSXRlbSAkUEhBU0VfRklMRSAtRXJyb3JBY3Rpb24gU2lsZW50bHlDb250aW51ZQoKICAgICMg4pSA4pSAIFN1bW1hcnkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgICAjIFdyaXRlIGZpbmFsIGRpYWdub3N0aWNzIHNuYXBzaG90IHRvIGxvZyAoc2NyZWVuIG91dHB1dCBpcyB0aGUgY2xlYW4gc3VtbWFyeSBiZWxvdykKICAgIFNob3ctRGlhZ25vc3RpY3MgLUxvZ09ubHkKCiAgICBTaG93LUJhbm5lciAiU2V0dXAgQ29tcGxldGUiCiAgICBXcml0ZS1Ib3N0ICIgIFlvdXIgR1BVIGlzIG5vdyBlYXJuaW5nIHZpYSBQdWxzZSArIE9jdGFTcGFjZS4iIC1Gb3JlZ3JvdW5kQ29sb3IgR3JlZW4KICAgIFdyaXRlLUhvc3QgIiIKICAgIEAoCiAgICAgICAgQHsgTCA9ICJHUFUiOyAgICAgICAgICBWID0gJGdwdU5hbWUgfSwKICAgICAgICBAeyBMID0gIlZSQU0iOyAgICAgICAgIFYgPSAiJHt2cmFtR2J9IEdCIiB9LAogICAgICAgIEB7IEwgPSAiUGxhdGZvcm0iOyAgICAgViA9ICJPY3RhU3BhY2UgKHZpYSBQdWxzZSkiIH0sCiAgICAgICAgQHsgTCA9ICJOb2RlIHRva2VuIjsgICBWID0gaWYgKCRvY3RhTm9kZVRva2VuKSB7ICRvY3RhTm9kZVRva2VuIH0gZWxzZSB7ICJQZW5kaW5nIOKAlCBjaGVjayBjdWJlLm9jdGEuY29tcHV0ZXIiIH0gfSwKICAgICAgICBAeyBMID0gIkdhbWluZyBwYXVzZSI7IFYgPSAiQXV0byAoR1BVID4gNzUlIHV0aWwpIiB9LAogICAgICAgIEB7IEwgPSAiQXV0by1zdGFydCI7ICAgViA9ICJPbiBldmVyeSBXaW5kb3dzIGxvZ2luIiB9LAogICAgICAgIEB7IEwgPSAiTG9ncyI7ICAgICAgICAgViA9ICRMT0dfRklMRSB9CiAgICApIHwgRm9yRWFjaC1PYmplY3QgeyBXcml0ZS1Ib3N0ICgiICB7MCwtMTZ9IHsxfSIgLWYgJF8uTCwgJF8uVikgLUZvcmVncm91bmRDb2xvciBXaGl0ZSB9CiAgICBXcml0ZS1Ib3N0ICIiCiAgICBXcml0ZS1Ib3N0ICIgIERhc2hib2FyZDogIGh0dHBzOi8vYmVuZWZpY2lhbC1kZWVwLXdvcmstZmxvdy5iYXNlNDQuYXBwIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4KICAgIFdyaXRlLUhvc3QgIiAgQ3ViZTogICAgICAgaHR0cHM6Ly9jdWJlLm9jdGEuY29tcHV0ZXIiIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbgogICAgV3JpdGUtSG9zdCAiIgogICAgV3JpdGUtSG9zdCAiICDilIzilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilJAiIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkKICAgIFdyaXRlLUhvc3QgIiAg4pSCICBJTlNUQUxMIExPRyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkKICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkKICAgIFdyaXRlLUhvc3QgIiAg4pSCICBBIGZ1bGwgbG9nIG9mIGV2ZXJ5IGluc3RhbGwgc3RlcCB3YXMgc2F2ZWQgdG86ICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkKICAgIFdyaXRlLUhvc3QgKCIgIOKUgiAgICB7MCwtNjB94pSCIiAtZiAkTE9HX0ZJTEUpIC1Gb3JlZ3JvdW5kQ29sb3IgV2hpdGUKICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkKICAgIFdyaXRlLUhvc3QgIiAg4pSCICBUbyBvcGVuIGl0OiAgIG5vdGVwYWQgYCIkTE9HX0ZJTEVgIiIgLUZvcmVncm91bmRDb2xvciBEYXJrR3JheQogICAgV3JpdGUtSG9zdCAiICDilIIgIFRvIGJyb3dzZTogICAgUnVuIOKGkiAlTE9DQUxBUFBEQVRBJVxQdWxzZSAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5CiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5CiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgU2hhcmUgaXQgd2l0aCBQdWxzZSBzdXBwb3J0IGlmIGFueXRoaW5nIGxvb2tzIHdyb25nLiAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5CiAgICBXcml0ZS1Ib3N0ICIgIOKUlOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUmCIgLUZvcmVncm91bmRDb2xvciBEYXJrR3JheQogICAgV3JpdGUtSG9zdCAiIgogICAgV2FpdC1Gb3JLZXkKfQoKIyDilIDilIAgRW50cnkgUG9pbnQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgp0cmFwIHsKICAgIFdyaXRlLUhvc3QgIiIKICAgIFdyaXRlLUhvc3QgIiAgW0VSUk9SXSBBbiB1bmV4cGVjdGVkIGVycm9yIHN0b3BwZWQgdGhlIGluc3RhbGxlcjoiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkCiAgICBXcml0ZS1Ib3N0ICIgICRfIiAtRm9yZWdyb3VuZENvbG9yIFJlZAogICAgU2hvdy1EaWFnbm9zdGljcwogICAgUmVhZC1Ib3N0ICIgIFByZXNzIEVudGVyIHRvIGNsb3NlIHRoaXMgd2luZG93IgogICAgZXhpdCAxCn0KCkFzc2VydC1BZG1pbgpOZXctSXRlbSAtSXRlbVR5cGUgRGlyZWN0b3J5IC1Gb3JjZSAtUGF0aCAkUFVMU0VfRElSIHwgT3V0LU51bGwKCiRwaGFzZSA9IGlmIChUZXN0LVBhdGggJFBIQVNFX0ZJTEUpIHsgR2V0LUNvbnRlbnQgJFBIQVNFX0ZJTEUgfSBlbHNlIHsgIjEiIH0Kc3dpdGNoICgkcGhhc2UpIHsKICAgICIxIiAgICAgeyBJbnZva2UtUGhhc2UxIH0KICAgICIyIiAgICAgeyBJbnZva2UtUGhhc2UyIH0KICAgIGRlZmF1bHQgeyBXcml0ZS1Ib3N0ICJVbmtub3duIHBoYXNlOiAkcGhhc2UiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkOyBXYWl0LUZvcktleTsgZXhpdCAxIH0KfQo=';
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
