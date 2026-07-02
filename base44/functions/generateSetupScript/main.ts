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

    # Verify root access works (first launch may need OOBE on some machines)
    $rootOk = (wsl -d Ubuntu-22.04 --user root -- bash -c "echo ok" 2>&1 | Out-String) -match "ok"
    if (-not $rootOk) {
        Write-Host "  Ubuntu needs first-time user setup. Create a username/password, then close the window." -ForegroundColor Yellow
        Start-Process wsl.exe -ArgumentList "-d Ubuntu-22.04" -Wait
        Start-Sleep 5
        $rootOk = (wsl -d Ubuntu-22.04 --user root -- bash -c "echo ok" 2>&1 | Out-String) -match "ok"
        if (-not $rootOk) {
            Write-Log "Cannot access Ubuntu 22.04 as root after setup — re-run installer." "ERROR"
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
const OCTA_PS1_B64 = 'I1JlcXVpcmVzIC1WZXJzaW9uIDUuMQ0KPCMNCi5TWU5PUFNJUw0KICAgIFBVTFNFIEdQVSBQcm92aWRlciBTZXR1cCDigJQgT2N0YVNwYWNlIEluc3RhbGxlcg0KLkRFU0NSSVBUSU9ODQogICAgUGhhc2UgMTogRW5hYmxlcyBXU0wyLCBzY2hlZHVsZXMgUGhhc2UgMiB0byBydW4gYWZ0ZXIgcmVib290Lg0KICAgIFBoYXNlIDI6IEluc3RhbGxzIFVidW50dSwgT2N0YVNwYWNlIG5vZGUgKG9zbiksIHNldHMgdXAgbmV0d29ya2luZw0KICAgICAgICAgICAgIChVUG5QICsgcG9ydHByb3h5IGZvciBUQ1AsIG1pcnJvcmVkIG5ldHdvcmtpbmcgcmVjb21tZW5kZWQgZm9yIFVEUCksDQogICAgICAgICAgICAgR1BVIGdhbWluZyBkZXRlY3Rpb24sIGFuZCBhdXRvLXN0YXJ0Lg0KDQogICAgRW1iZWRkZWQgYXQgZG93bmxvYWQgdGltZSBieSBQdWxzZSdzIGdlbmVyYXRlU2V0dXBTY3JpcHQgZnVuY3Rpb246DQogICAgICBQVUxTRV9VU0VSX1RPS0VOIOKAlCB1c2VyJ3Mgc2Vzc2lvbiB0b2tlbiBmb3IgUHVsc2UgQVBJIGNhbGxiYWNrDQogICAgICBQVUxTRV9BUFBfSUQgICAgIOKAlCBiYXNlNDQgYXBwIElEDQojPg0KDQojIOKUgOKUgCBFbWJlZGRlZCBieSBzZXJ2ZXIgYXQgZG93bmxvYWQgdGltZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANCiRQVUxTRV9VU0VSX1RPS0VOID0gInt7UFVMU0VfVVNFUl9UT0tFTn19Ig0KJFBVTFNFX0FQUF9JRCAgICAgPSAie3tQVUxTRV9BUFBfSUR9fSINCiRQVUxTRV9BUElfQkFTRSAgID0gImh0dHBzOi8vYXBpLmJhc2U0NC5hcHAvYXBpL2FwcHMvJFBVTFNFX0FQUF9JRC9mdW5jdGlvbnMiDQojIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KDQokUFVMU0VfRElSICAgICAgPSAiJGVudjpMT0NBTEFQUERBVEFcUHVsc2UiDQokUEhBU0VfRklMRSAgICAgPSAiJFBVTFNFX0RJUlxvY3RhX3NldHVwX3BoYXNlIg0KJExPR19GSUxFICAgICAgID0gIiRQVUxTRV9ESVJcb2N0YV9zZXR1cC5sb2ciDQokVEFTS19OQU1FICAgICAgPSAiUHVsc2VPY3RhU2V0dXBSZXN1bWUiDQokV0FUQ0hET0dfVEFTSyAgPSAiUHVsc2VPY3RhV2F0Y2hkb2ciDQokQVVUT1NUQVJUX1RBU0sgPSAiUHVsc2VPY3RhQXV0b1N0YXJ0Ig0KDQojIE9jdGFTcGFjZSBwb3J0cyDigJQgbWFuYWdlbWVudCAoQVBJKSBhbmQgZW5jcnlwdGVkIHR1bm5lbCByYW5nZSAoVENQK1VEUCkNCiRPQ1RBX01HTVRfUE9SVFMgICAgID0gQCgxODg4OCkNCiRPQ1RBX0FQUF9QT1JUX1NUQVJUID0gNTE4MDANCiRPQ1RBX0FQUF9QT1JUX0VORCAgID0gNTE4MTYNCg0KIyDilIDilIAgSGVscGVycyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANCg0KZnVuY3Rpb24gV3JpdGUtTG9nIHsNCiAgICBwYXJhbShbc3RyaW5nXSRtc2csIFtzdHJpbmddJGxldmVsID0gIklORk8iKQ0KICAgICR0cyA9IEdldC1EYXRlIC1Gb3JtYXQgIkhIOm1tOnNzIg0KICAgIEFkZC1Db250ZW50IC1QYXRoICRMT0dfRklMRSAtVmFsdWUgIlskdHNdWyRsZXZlbF0gJG1zZyIgLUVuY29kaW5nIFVURjgNCiAgICBzd2l0Y2ggKCRsZXZlbCkgew0KICAgICAgICAiT0siICAgIHsgV3JpdGUtSG9zdCAiICBbT0tdICRtc2ciIC1Gb3JlZ3JvdW5kQ29sb3IgR3JlZW4gfQ0KICAgICAgICAiV0FSTiIgIHsgV3JpdGUtSG9zdCAiICBbISFdICRtc2ciIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93IH0NCiAgICAgICAgIkVSUk9SIiB7IFdyaXRlLUhvc3QgIiAgW1hdICAkbXNnIiAtRm9yZWdyb3VuZENvbG9yIFJlZCB9DQogICAgICAgIGRlZmF1bHQgeyBXcml0ZS1Ib3N0ICIgIC4uLiAkbXNnIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4gfQ0KICAgIH0NCn0NCg0KZnVuY3Rpb24gU2hvdy1CYW5uZXIgew0KICAgIHBhcmFtKFtzdHJpbmddJHN1YnRpdGxlID0gIiIpDQogICAgQ2xlYXItSG9zdA0KICAgIFdyaXRlLUhvc3QgIiINCiAgICBXcml0ZS1Ib3N0ICIgIOKWiOKWiOKWiOKWiOKWiOKWiOKVlyDilojilojilZcgICDilojilojilZfilojilojilZcgICAgIOKWiOKWiOKWiOKWiOKWiOKWiOKWiOKVl+KWiOKWiOKWiOKWiOKWiOKWiOKWiOKVlyIgLUZvcmVncm91bmRDb2xvciBNYWdlbnRhDQogICAgV3JpdGUtSG9zdCAiICDilojilojilZTilZDilZDilojilojilZfilojilojilZEgICDilojilojilZHilojilojilZEgICAgIOKWiOKWiOKVlOKVkOKVkOKVkOKVkOKVneKWiOKWiOKVlOKVkOKVkOKVkOKVkOKVnSIgLUZvcmVncm91bmRDb2xvciBNYWdlbnRhDQogICAgV3JpdGUtSG9zdCAiICDilojilojilojilojilojilojilZTilZ3ilojilojilZEgICDilojilojilZHilojilojilZEgICAgIOKWiOKWiOKWiOKWiOKWiOKWiOKWiOKVl+KWiOKWiOKWiOKWiOKWiOKVlyAgIiAtRm9yZWdyb3VuZENvbG9yIE1hZ2VudGENCiAgICBXcml0ZS1Ib3N0ICIgIOKWiOKWiOKVlOKVkOKVkOKVkOKVnSDilojilojilZEgICDilojilojilZHilojilojilZEgICAgIOKVmuKVkOKVkOKVkOKVkOKWiOKWiOKVkeKWiOKWiOKVlOKVkOKVkOKVnSAgIiAtRm9yZWdyb3VuZENvbG9yIE1hZ2VudGENCiAgICBXcml0ZS1Ib3N0ICIgIOKWiOKWiOKVkSAgICAg4pWa4paI4paI4paI4paI4paI4paI4pWU4pWd4paI4paI4paI4paI4paI4paI4paI4pWX4paI4paI4paI4paI4paI4paI4paI4pWR4paI4paI4paI4paI4paI4paI4paI4pWXIiAtRm9yZWdyb3VuZENvbG9yIE1hZ2VudGENCiAgICBXcml0ZS1Ib3N0ICIgIOKVmuKVkOKVnSAgICAgIOKVmuKVkOKVkOKVkOKVkOKVkOKVnSDilZrilZDilZDilZDilZDilZDilZDilZ3ilZrilZDilZDilZDilZDilZDilZDilZ3ilZrilZDilZDilZDilZDilZDilZDilZ0iIC1Gb3JlZ3JvdW5kQ29sb3IgTWFnZW50YQ0KICAgIFdyaXRlLUhvc3QgIiINCiAgICBXcml0ZS1Ib3N0ICIgIEdQVSBQcm92aWRlciBTZXR1cCDigJQgT2N0YVNwYWNlIiAtRm9yZWdyb3VuZENvbG9yIFdoaXRlDQogICAgaWYgKCRzdWJ0aXRsZSkgeyBXcml0ZS1Ib3N0ICIgICRzdWJ0aXRsZSIgLUZvcmVncm91bmRDb2xvciBEYXJrR3JheSB9DQogICAgV3JpdGUtSG9zdCAiIg0KfQ0KDQpmdW5jdGlvbiBBc3NlcnQtQWRtaW4gew0KICAgIGlmICgtbm90IChbU2VjdXJpdHkuUHJpbmNpcGFsLldpbmRvd3NQcmluY2lwYWxdW1NlY3VyaXR5LlByaW5jaXBhbC5XaW5kb3dzSWRlbnRpdHldOjpHZXRDdXJyZW50KCkpLklzSW5Sb2xlKA0KICAgICAgICBbU2VjdXJpdHkuUHJpbmNpcGFsLldpbmRvd3NCdWlsdEluUm9sZV06OkFkbWluaXN0cmF0b3IpKSB7DQogICAgICAgIFdyaXRlLUhvc3QgIiAgUmVsYXVuY2hpbmcgYXMgQWRtaW5pc3RyYXRvci4uLiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cNCiAgICAgICAgU3RhcnQtUHJvY2VzcyBwb3dlcnNoZWxsICItTm9Qcm9maWxlIC1FeGVjdXRpb25Qb2xpY3kgQnlwYXNzIC1GaWxlIGAiJFBTQ29tbWFuZFBhdGhgIiIgLVZlcmIgUnVuQXMNCiAgICAgICAgZXhpdA0KICAgIH0NCn0NCg0KZnVuY3Rpb24gV2FpdC1Gb3JLZXkgew0KICAgIFdyaXRlLUhvc3QgIiINCiAgICBSZWFkLUhvc3QgIiAgUHJlc3MgRW50ZXIgdG8gY2xvc2UgdGhpcyB3aW5kb3ciDQp9DQoNCiMg4pSA4pSAIERpYWdub3N0aWNzIGNoZWNrbGlzdCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANCiRzY3JpcHQ6U3RlcHMgPSBbb3JkZXJlZF1Ae30NCg0KZnVuY3Rpb24gUmVnaXN0ZXItU3RlcCB7DQogICAgcGFyYW0oW3N0cmluZ10kbmFtZSwgW3N0cmluZ10kZml4ID0gIiIpDQogICAgJHNjcmlwdDpTdGVwc1skbmFtZV0gPSBAeyBTdGF0dXMgPSAiUEVORElORyI7IERldGFpbCA9ICIiOyBGaXggPSAkZml4IH0NCn0NCg0KZnVuY3Rpb24gU2V0LVN0ZXAgew0KICAgIHBhcmFtKFtzdHJpbmddJG5hbWUsIFtzdHJpbmddJHN0YXR1cywgW3N0cmluZ10kZGV0YWlsID0gIiIpDQogICAgaWYgKCRzY3JpcHQ6U3RlcHMuQ29udGFpbnMoJG5hbWUpKSB7DQogICAgICAgICRzY3JpcHQ6U3RlcHNbJG5hbWVdLlN0YXR1cyA9ICRzdGF0dXMNCiAgICAgICAgaWYgKCRkZXRhaWwpIHsgJHNjcmlwdDpTdGVwc1skbmFtZV0uRGV0YWlsID0gJGRldGFpbCB9DQogICAgfQ0KfQ0KDQpmdW5jdGlvbiBTaG93LURpYWdub3N0aWNzIHsNCiAgICBwYXJhbShbc3dpdGNoXSRMb2dPbmx5KQ0KICAgICRzZXAgICAgPSAiICAiICsgKCLilIAiICogNjUpDQogICAgJGxvZ1NlcCA9ICLilIAiICogNjcNCiAgICAkdHMgICAgID0gR2V0LURhdGUgLUZvcm1hdCAieXl5eS1NTS1kZCBISDptbTpzcyINCg0KICAgIGlmICgtbm90ICRMb2dPbmx5KSB7DQogICAgICAgIFdyaXRlLUhvc3QgIiINCiAgICAgICAgV3JpdGUtSG9zdCAkc2VwIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkNCiAgICAgICAgV3JpdGUtSG9zdCAiICBJTlNUQUxMIERJQUdOT1NUSUNTIiAtRm9yZWdyb3VuZENvbG9yIFdoaXRlDQogICAgICAgIFdyaXRlLUhvc3QgJHNlcCAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5DQogICAgfQ0KDQogICAgQWRkLUNvbnRlbnQgLVBhdGggJExPR19GSUxFIC1WYWx1ZSAiIiAtRW5jb2RpbmcgVVRGOA0KICAgIEFkZC1Db250ZW50IC1QYXRoICRMT0dfRklMRSAtVmFsdWUgJGxvZ1NlcCAtRW5jb2RpbmcgVVRGOA0KICAgIEFkZC1Db250ZW50IC1QYXRoICRMT0dfRklMRSAtVmFsdWUgIklOU1RBTEwgRElBR05PU1RJQ1MgICR0cyIgLUVuY29kaW5nIFVURjgNCiAgICBBZGQtQ29udGVudCAtUGF0aCAkTE9HX0ZJTEUgLVZhbHVlICRsb2dTZXAgLUVuY29kaW5nIFVURjgNCg0KICAgIGZvcmVhY2ggKCRuYW1lIGluICRzY3JpcHQ6U3RlcHMuS2V5cykgew0KICAgICAgICAkcyAgICAgPSAkc2NyaXB0OlN0ZXBzWyRuYW1lXQ0KICAgICAgICAkaWNvbiAgPSBzd2l0Y2ggKCRzLlN0YXR1cykgeyAiUEFTUyIgeyJbT0tdIn0gIkZBSUwiIHsiW1hdICJ9ICJXQVJOIiB7IlshIV0ifSAiU0tJUCIgeyJbLS1dIn0gZGVmYXVsdCB7IlsgIF0ifSB9DQogICAgICAgICRjb2xvciA9IHN3aXRjaCAoJHMuU3RhdHVzKSB7ICJQQVNTIiB7IkdyZWVuIn0gIkZBSUwiIHsiUmVkIn0gIldBUk4iIHsiWWVsbG93In0gIlNLSVAiIHsiRGFya0dyYXkifSBkZWZhdWx0IHsiRGFya0dyYXkifSB9DQoNCiAgICAgICAgaWYgKCRzLlN0YXR1cyAtZXEgIlBFTkRJTkciKSB7DQogICAgICAgICAgICBpZiAoLW5vdCAkTG9nT25seSkgeyBXcml0ZS1Ib3N0ICgiICB7MH0gezEsLTU1fSB7Mn0iIC1mICRpY29uLCAkbmFtZSwgIihub3QgcmVhY2hlZCkiKSAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5IH0NCiAgICAgICAgICAgIEFkZC1Db250ZW50IC1QYXRoICRMT0dfRklMRSAtVmFsdWUgKCIgICRpY29uICRuYW1lICAobm90IHJlYWNoZWQpIikgLUVuY29kaW5nIFVURjgNCiAgICAgICAgfSBlbHNlIHsNCiAgICAgICAgICAgIGlmICgtbm90ICRMb2dPbmx5KSB7DQogICAgICAgICAgICAgICAgV3JpdGUtSG9zdCAiICAkaWNvbiAkbmFtZSIgLUZvcmVncm91bmRDb2xvciAkY29sb3INCiAgICAgICAgICAgICAgICBpZiAoJHMuRGV0YWlsKSB7IFdyaXRlLUhvc3QgIiAgICAgICAkKCRzLkRldGFpbCkiIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkgfQ0KICAgICAgICAgICAgICAgIGlmICgkcy5TdGF0dXMgLWVxICJGQUlMIiAtYW5kICRzLkZpeCkgeyBXcml0ZS1Ib3N0ICIgICAgICAgRml4OiAkKCRzLkZpeCkiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93IH0NCiAgICAgICAgICAgIH0NCiAgICAgICAgICAgIEFkZC1Db250ZW50IC1QYXRoICRMT0dfRklMRSAtVmFsdWUgIiAgJGljb24gJG5hbWUiIC1FbmNvZGluZyBVVEY4DQogICAgICAgICAgICBpZiAoJHMuRGV0YWlsKSB7IEFkZC1Db250ZW50IC1QYXRoICRMT0dfRklMRSAtVmFsdWUgIiAgICAgICAkKCRzLkRldGFpbCkiIC1FbmNvZGluZyBVVEY4IH0NCiAgICAgICAgICAgIGlmICgkcy5TdGF0dXMgLWVxICJGQUlMIiAtYW5kICRzLkZpeCkgeyBBZGQtQ29udGVudCAtUGF0aCAkTE9HX0ZJTEUgLVZhbHVlICIgICAgICAgRml4OiAkKCRzLkZpeCkiIC1FbmNvZGluZyBVVEY4IH0NCiAgICAgICAgfQ0KICAgIH0NCg0KICAgIEFkZC1Db250ZW50IC1QYXRoICRMT0dfRklMRSAtVmFsdWUgJGxvZ1NlcCAtRW5jb2RpbmcgVVRGOA0KDQogICAgaWYgKC1ub3QgJExvZ09ubHkpIHsNCiAgICAgICAgV3JpdGUtSG9zdCAkc2VwIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkNCiAgICAgICAgV3JpdGUtSG9zdCAiICBGdWxsIGxvZzogJExPR19GSUxFIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5DQogICAgICAgIFdyaXRlLUhvc3QgIiAgU2hhcmUgd2l0aCBQdWxzZSBzdXBwb3J0IGF0IHB1bHNlbmFub2FpLmNvbSIgLUZvcmVncm91bmRDb2xvciBEYXJrR3JheQ0KICAgICAgICBXcml0ZS1Ib3N0ICIiDQogICAgfQ0KfQ0KIyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANCg0KZnVuY3Rpb24gR2V0LUxvY2FsSVAgew0KICAgIChHZXQtTmV0SVBBZGRyZXNzIC1BZGRyZXNzRmFtaWx5IElQdjQgfA0KICAgICAgICBXaGVyZS1PYmplY3QgeyAkXy5JbnRlcmZhY2VBbGlhcyAtbm90bWF0Y2ggIkxvb3BiYWNrfFdTTHx2RXRoZXJuZXQiIH0gfA0KICAgICAgICBTZWxlY3QtT2JqZWN0IC1GaXJzdCAxKS5JUEFkZHJlc3MNCn0NCg0KZnVuY3Rpb24gU2V0LVdTTDJQb3J0UHJveHkgew0KICAgIHBhcmFtKFtzdHJpbmddJFdzbElQKQ0KICAgICMgVENQIG9ubHkg4oCUIHBvcnRwcm94eSBkb2VzIG5vdCBzdXBwb3J0IFVEUC4gVURQIHR1bm5lbCBwb3J0cyAoNTE4MDAtNTE4MTYpDQogICAgIyByZXF1aXJlIG1pcnJvcmVkIG5ldHdvcmtpbmcgb24gV2luZG93cyAxMSAyMkgyKyB0byBmdW5jdGlvbiBjb3JyZWN0bHkuDQogICAgJGFsbFBvcnRzID0gJE9DVEFfTUdNVF9QT1JUUyArICgkT0NUQV9BUFBfUE9SVF9TVEFSVC4uJE9DVEFfQVBQX1BPUlRfRU5EKQ0KICAgIGZvcmVhY2ggKCRwIGluICRhbGxQb3J0cykgew0KICAgICAgICBuZXRzaCBpbnRlcmZhY2UgcG9ydHByb3h5IGRlbGV0ZSB2NHRvdjQgbGlzdGVucG9ydD0kcCBsaXN0ZW5hZGRyZXNzPTAuMC4wLjAgfCBPdXQtTnVsbA0KICAgICAgICBuZXRzaCBpbnRlcmZhY2UgcG9ydHByb3h5IGFkZCB2NHRvdjQgbGlzdGVucG9ydD0kcCBsaXN0ZW5hZGRyZXNzPTAuMC4wLjAgYA0KICAgICAgICAgICAgY29ubmVjdHBvcnQ9JHAgY29ubmVjdGFkZHJlc3M9JFdzbElQIHwgT3V0LU51bGwNCiAgICB9DQogICAgV3JpdGUtTG9nICJXU0wyIHBvcnRwcm94eSAoVENQKTogJCgkT0NUQV9NR01UX1BPUlRTIC1qb2luICcsJykgKyAkT0NUQV9BUFBfUE9SVF9TVEFSVC0kT0NUQV9BUFBfUE9SVF9FTkQg4oaSICRXc2xJUCIgIk9LIg0KICAgIFdyaXRlLUxvZyAiTk9URTogVURQIHBvcnRzICRPQ1RBX0FQUF9QT1JUX1NUQVJULSRPQ1RBX0FQUF9QT1JUX0VORCBuZWVkIG1pcnJvcmVkIG5ldHdvcmtpbmcgZm9yIGZ1bGwgdHVubmVsIHN1cHBvcnQiICJXQVJOIg0KfQ0KDQojIOKUgOKUgCBQaGFzZSAxOiBFbmFibGUgV1NMMiArIHNjaGVkdWxlIFBoYXNlIDIgYWZ0ZXIgcmVib290IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KDQpmdW5jdGlvbiBJbnZva2UtUGhhc2UxIHsNCiAgICBTaG93LUJhbm5lciAiUGhhc2UgMSBvZiAyIOKAlCBFbmFibGluZyBXU0wyIg0KDQogICAgJHNjcmlwdDpTdGVwcyA9IFtvcmRlcmVkXUB7fQ0KICAgIFJlZ2lzdGVyLVN0ZXAgIldpbmRvd3MgY29tcGF0aWJpbGl0eSAoYnVpbGQgMTkwNDErKSINCiAgICBSZWdpc3Rlci1TdGVwICJHUFUgZGV0ZWN0ZWQiDQogICAgUmVnaXN0ZXItU3RlcCAiVmlydHVhbGl6YXRpb24gZW5hYmxlZCBpbiBCSU9TIg0KICAgIFJlZ2lzdGVyLVN0ZXAgIldTTDIgZmVhdHVyZXMgZW5hYmxlZCINCiAgICBSZWdpc3Rlci1TdGVwICJXU0wyIGtlcm5lbCB1cGRhdGUiDQogICAgUmVnaXN0ZXItU3RlcCAiUGhhc2UgMiByZXN1bWUgdGFzayINCg0KICAgICRidWlsZCA9IFtTeXN0ZW0uRW52aXJvbm1lbnRdOjpPU1ZlcnNpb24uVmVyc2lvbi5CdWlsZA0KICAgIGlmICgkYnVpbGQgLWx0IDE5MDQxKSB7DQogICAgICAgIFNldC1TdGVwICJXaW5kb3dzIGNvbXBhdGliaWxpdHkgKGJ1aWxkIDE5MDQxKykiICJGQUlMIiAiQnVpbGQgJGJ1aWxkIOKAlCByZXF1aXJlcyAxOTA0MSAoV2luZG93cyAxMCAyMDA0KykiDQogICAgICAgIFdyaXRlLUxvZyAiV2luZG93cyBidWlsZCAkYnVpbGQgaXMgdG9vIG9sZC4gV1NMMiByZXF1aXJlcyBidWlsZCAxOTA0MSsgKFdpbmRvd3MgMTAgMjAwNCspLiIgIkVSUk9SIg0KICAgICAgICBTaG93LURpYWdub3N0aWNzOyBXYWl0LUZvcktleTsgZXhpdCAxDQogICAgfQ0KICAgIFdyaXRlLUxvZyAiV2luZG93cyBidWlsZCAkYnVpbGQg4oCUIE9LIiAiT0siDQogICAgU2V0LVN0ZXAgIldpbmRvd3MgY29tcGF0aWJpbGl0eSAoYnVpbGQgMTkwNDErKSIgIlBBU1MiICJCdWlsZCAkYnVpbGQiDQoNCiAgICAkZ3B1ID0gKEdldC1XbWlPYmplY3QgV2luMzJfVmlkZW9Db250cm9sbGVyIHwNCiAgICAgICAgV2hlcmUtT2JqZWN0IHsgJF8uTmFtZSAtbWF0Y2ggIk5WSURJQXxHZUZvcmNlfFJUWHxHVFh8QU1EfFJhZGVvbiIgfSB8DQogICAgICAgIFNlbGVjdC1PYmplY3QgLUZpcnN0IDEpLk5hbWUNCiAgICBpZiAoLW5vdCAkZ3B1KSB7DQogICAgICAgIFNldC1TdGVwICJHUFUgZGV0ZWN0ZWQiICJGQUlMIiAiTm8gTlZJRElBL0FNRCBHUFUgZm91bmQiDQogICAgICAgIFdyaXRlLUxvZyAiTm8gc3VwcG9ydGVkIEdQVSBkZXRlY3RlZC4gUHVsc2UgcmVxdWlyZXMgYW4gTlZJRElBIG9yIEFNRCBHUFUuIiAiRVJST1IiDQogICAgICAgIFNob3ctRGlhZ25vc3RpY3M7IFdhaXQtRm9yS2V5OyBleGl0IDENCiAgICB9DQogICAgV3JpdGUtTG9nICJHUFU6ICRncHUiICJPSyINCiAgICBTZXQtU3RlcCAiR1BVIGRldGVjdGVkIiAiUEFTUyIgJGdwdQ0KDQogICAgTmV3LUl0ZW0gLUl0ZW1UeXBlIERpcmVjdG9yeSAtRm9yY2UgLVBhdGggJFBVTFNFX0RJUiB8IE91dC1OdWxsDQoNCiAgICAkdmlydEVuYWJsZWQgPSAoR2V0LUNvbXB1dGVySW5mbykuSHlwZXJWUmVxdWlyZW1lbnRWaXJ0dWFsaXphdGlvbkZpcm13YXJlRW5hYmxlZA0KICAgIGlmICgkdmlydEVuYWJsZWQgLWVxICRmYWxzZSkgew0KICAgICAgICBTZXQtU3RlcCAiVmlydHVhbGl6YXRpb24gZW5hYmxlZCBpbiBCSU9TIiAiRkFJTCIgIkRpc2FibGVkIOKAlCBzZWUgQklPUyBpbnN0cnVjdGlvbnMgYmVsb3ciDQogICAgICAgIFdyaXRlLUxvZyAiSGFyZHdhcmUgdmlydHVhbGl6YXRpb24gaXMgZGlzYWJsZWQgaW4geW91ciBCSU9TL1VFRkkuIiAiRVJST1IiDQogICAgICAgIFdyaXRlLUhvc3QgIiINCiAgICAgICAgV3JpdGUtSG9zdCAiICDilIzilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilJAiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkDQogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICBBQ1RJT04gUkVRVUlSRUQ6IEVuYWJsZSB2aXJ0dWFsaXphdGlvbiBpbiB5b3VyIEJJT1MvVUVGSSAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkDQogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkDQogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICAxLiBSZXN0YXJ0IHlvdXIgUEMgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkDQogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICAyLiBQcmVzcyBEZWxldGUgb3IgRjIgZHVyaW5nIGJvb3QgdG8gb3BlbiBCSU9TICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBSZWQNCiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgIDMuIEZpbmQ6IEFkdmFuY2VkID4gQ1BVIENvbmZpZ3VyYXRpb24gPiBTVk0gTW9kZSAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFJlZA0KICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgKEludGVsIGJvYXJkczogbG9vayBmb3IgJ0ludGVsIFZpcnR1YWxpemF0aW9uJyBvciBWVC14KSDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkDQogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICA0LiBTZXQgaXQgdG8gRW5hYmxlZCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkDQogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICA1LiBQcmVzcyBGMTAgdG8gc2F2ZSBhbmQgZXhpdCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBSZWQNCiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBSZWQNCiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgIFRoZW4gcmUtcnVuIHRoaXMgaW5zdGFsbGVyLiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBSZWQNCiAgICAgICAgV3JpdGUtSG9zdCAiICDilJTilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilJgiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkDQogICAgICAgIFdyaXRlLUhvc3QgIiINCiAgICAgICAgU2hvdy1EaWFnbm9zdGljczsgV2FpdC1Gb3JLZXk7IGV4aXQgMQ0KICAgIH0NCiAgICBXcml0ZS1Mb2cgIkhhcmR3YXJlIHZpcnR1YWxpemF0aW9uIGVuYWJsZWQgaW4gQklPUyDigJQgT0siICJPSyINCiAgICBTZXQtU3RlcCAiVmlydHVhbGl6YXRpb24gZW5hYmxlZCBpbiBCSU9TIiAiUEFTUyINCg0KICAgIFdyaXRlLUxvZyAiRW5hYmxpbmcgV1NMMiBXaW5kb3dzIGZlYXR1cmVzLi4uIg0KICAgIGRpc20uZXhlIC9vbmxpbmUgL2VuYWJsZS1mZWF0dXJlIC9mZWF0dXJlbmFtZTpNaWNyb3NvZnQtV2luZG93cy1TdWJzeXN0ZW0tTGludXggL2FsbCAvbm9yZXN0YXJ0IHwgT3V0LU51bGwNCiAgICBkaXNtLmV4ZSAvb25saW5lIC9lbmFibGUtZmVhdHVyZSAvZmVhdHVyZW5hbWU6VmlydHVhbE1hY2hpbmVQbGF0Zm9ybSAvYWxsIC9ub3Jlc3RhcnQgfCBPdXQtTnVsbA0KICAgIFdyaXRlLUxvZyAiV1NMMiBmZWF0dXJlcyBlbmFibGVkIiAiT0siDQogICAgU2V0LVN0ZXAgIldTTDIgZmVhdHVyZXMgZW5hYmxlZCIgIlBBU1MiDQoNCiAgICBXcml0ZS1Mb2cgIkluc3RhbGxpbmcgV1NMMiBrZXJuZWwgdXBkYXRlLi4uIg0KICAgICRtc2kgPSAiJGVudjpURU1QXHdzbF91cGRhdGUubXNpIg0KICAgIHRyeSB7DQogICAgICAgIEludm9rZS1XZWJSZXF1ZXN0ICJodHRwczovL3dzbHN0b3Jlc3RvcmFnZS5ibG9iLmNvcmUud2luZG93cy5uZXQvd3NsYmxvYi93c2xfdXBkYXRlX3g2NC5tc2kiIGANCiAgICAgICAgICAgIC1PdXRGaWxlICRtc2kgLVVzZUJhc2ljUGFyc2luZw0KICAgICAgICBTdGFydC1Qcm9jZXNzIG1zaWV4ZWMuZXhlIC1Bcmd1bWVudExpc3QgIi9pIGAiJG1zaWAiIC9xdWlldCAvbm9yZXN0YXJ0IiAtV2FpdA0KICAgICAgICBXcml0ZS1Mb2cgIldTTDIga2VybmVsIHVwZGF0ZWQiICJPSyINCiAgICB9IGNhdGNoIHsNCiAgICAgICAgV3JpdGUtTG9nICJXU0wyIGtlcm5lbCBhbHJlYWR5IHVwIHRvIGRhdGUiICJPSyINCiAgICB9DQogICAgU2V0LVN0ZXAgIldTTDIga2VybmVsIHVwZGF0ZSIgIlBBU1MiDQoNCiAgICB3c2wgLS1zZXQtZGVmYXVsdC12ZXJzaW9uIDIgMj4mMSB8IE91dC1OdWxsDQoNCiAgICBTZXQtQ29udGVudCAtUGF0aCAkUEhBU0VfRklMRSAtVmFsdWUgIjIiIC1FbmNvZGluZyBVVEY4DQoNCiAgICAkc3RhYmxlUGF0aCA9ICIkUFVMU0VfRElSXHB1bHNlLW9jdGEtc2V0dXAucHMxIg0KICAgIGlmICgkUFNDb21tYW5kUGF0aCAtbmUgJHN0YWJsZVBhdGgpIHsNCiAgICAgICAgQ29weS1JdGVtIC1QYXRoICRQU0NvbW1hbmRQYXRoIC1EZXN0aW5hdGlvbiAkc3RhYmxlUGF0aCAtRm9yY2UNCiAgICB9DQoNCiAgICAkYWN0aW9uICAgID0gTmV3LVNjaGVkdWxlZFRhc2tBY3Rpb24gLUV4ZWN1dGUgInBvd2Vyc2hlbGwuZXhlIiBgDQogICAgICAgIC1Bcmd1bWVudCAiLU5vUHJvZmlsZSAtRXhlY3V0aW9uUG9saWN5IEJ5cGFzcyAtV2luZG93U3R5bGUgTm9ybWFsIC1GaWxlIGAiJHN0YWJsZVBhdGhgIiINCiAgICAkdHJpZ2dlciAgID0gTmV3LVNjaGVkdWxlZFRhc2tUcmlnZ2VyIC1BdExvZ09uDQogICAgJHNldHRpbmdzICA9IE5ldy1TY2hlZHVsZWRUYXNrU2V0dGluZ3NTZXQgLUFsbG93U3RhcnRJZk9uQmF0dGVyaWVzIC1Eb250U3RvcElmR29pbmdPbkJhdHRlcmllcw0KICAgICRwcmluY2lwYWwgPSBOZXctU2NoZWR1bGVkVGFza1ByaW5jaXBhbCAtVXNlcklkICRlbnY6VVNFUk5BTUUgLVJ1bkxldmVsIEhpZ2hlc3QNCiAgICBSZWdpc3Rlci1TY2hlZHVsZWRUYXNrIC1UYXNrTmFtZSAkVEFTS19OQU1FIC1BY3Rpb24gJGFjdGlvbiAtVHJpZ2dlciAkdHJpZ2dlciBgDQogICAgICAgIC1TZXR0aW5ncyAkc2V0dGluZ3MgLVByaW5jaXBhbCAkcHJpbmNpcGFsIC1Gb3JjZSB8IE91dC1OdWxsDQogICAgV3JpdGUtTG9nICJQaGFzZSAyIHJlc3VtZSB0YXNrIHJlZ2lzdGVyZWQiICJPSyINCiAgICBTZXQtU3RlcCAiUGhhc2UgMiByZXN1bWUgdGFzayIgIlBBU1MiDQoNCiAgICBXcml0ZS1Ib3N0ICIiDQogICAgV3JpdGUtSG9zdCAiICDilIzilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilJAiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93DQogICAgV3JpdGUtSG9zdCAiICDilIIgIE9uZSByZWJvb3QgcmVxdWlyZWQgdG8gY29udGludWUgc2V0dXAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cNCiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgU2V0dXAgd2lsbCByZXN1bWUgYXV0b21hdGljYWxseS4gICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdw0KICAgIFdyaXRlLUhvc3QgIiAg4pSU4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSYIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdw0KICAgIFdyaXRlLUhvc3QgIiINCiAgICAkYW5zd2VyID0gUmVhZC1Ib3N0ICIgIFJlYm9vdCBub3c/IChZL24pIg0KICAgIGlmICgkYW5zd2VyIC1uZSAibiIpIHsgUmVzdGFydC1Db21wdXRlciAtRm9yY2UgfQ0KICAgIGVsc2UgeyBXcml0ZS1Ib3N0ICIgIFJlYm9vdCB3aGVuIHJlYWR5LiBTZXR1cCByZXN1bWVzIG9uIG5leHQgbG9naW4uIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5IH0NCn0NCg0KIyDilIDilIAgUGhhc2UgMjogVWJ1bnR1ICsgT2N0YVNwYWNlIChvc24pICsgTmV0d29ya2luZyArIEF1dG8tc3RhcnQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSADQoNCmZ1bmN0aW9uIEludm9rZS1QaGFzZTIgew0KICAgIFNob3ctQmFubmVyICJQaGFzZSAyIG9mIDIg4oCUIEluc3RhbGxpbmcgT2N0YVNwYWNlIFByb3ZpZGVyIFN0YWNrIg0KDQogICAgJHNjcmlwdDpTdGVwcyA9IFtvcmRlcmVkXUB7fQ0KICAgIFJlZ2lzdGVyLVN0ZXAgIlVidW50dSBvbiBXU0wyIg0KICAgIFJlZ2lzdGVyLVN0ZXAgInN5c3RlbWQgaW4gV1NMMiINCiAgICBSZWdpc3Rlci1TdGVwICJXU0wyIG5ldHdvcmtpbmciDQogICAgUmVnaXN0ZXItU3RlcCAiR1BVIGNvbXB1dGUgaW4gV1NMMiIgIlVwZGF0ZSBXaW5kb3dzIE5WSURJQSBkcml2ZXIgYXQgbnZpZGlhLmNvbS9kcml2ZXJzIg0KICAgIFJlZ2lzdGVyLVN0ZXAgIkJ1aWxkIHRvb2xzIChjdXJsLCBiYXNoKSIgIndzbCAtZCBVYnVudHUtMjIuMDQgLS0gYmFzaCAtYyAnYXB0LWdldCB1cGRhdGUgJiYgYXB0LWdldCBpbnN0YWxsIC15IGN1cmwgYmFzaCciDQogICAgUmVnaXN0ZXItU3RlcCAiT2N0YVNwYWNlIG9zbiBpbnN0YWxsZWQiICJDaGVjayBpbnN0YWxsLm9jdGEuc3BhY2Ugb3IgT2N0YVNwYWNlIGRvY3MiDQogICAgUmVnaXN0ZXItU3RlcCAiSHVnZVBhZ2VzIGNhcCAoUkFNIGZpeCkiDQogICAgUmVnaXN0ZXItU3RlcCAiT1NOIGRpc2sgYWxhcm0gdGhyZXNob2xkIg0KICAgIFJlZ2lzdGVyLVN0ZXAgIm9zbiBzZXJ2aWNlIHN0YXJ0ZWQiDQogICAgUmVnaXN0ZXItU3RlcCAiT2N0YVNwYWNlIG5vZGUgdG9rZW4iDQogICAgUmVnaXN0ZXItU3RlcCAiV2luZG93cyBGaXJld2FsbCBydWxlcyINCiAgICBSZWdpc3Rlci1TdGVwICJVUG5QIHBvcnQgZm9yd2FyZGluZyINCiAgICBSZWdpc3Rlci1TdGVwICJXU0wyIHBvcnQgcHJveHkiDQogICAgUmVnaXN0ZXItU3RlcCAiUHVsc2UgcmVnaXN0cmF0aW9uIg0KICAgIFJlZ2lzdGVyLVN0ZXAgIkdQVSB3YXRjaGRvZyB0YXNrIg0KICAgIFJlZ2lzdGVyLVN0ZXAgIkF1dG8tc3RhcnQgdGFzayINCiAgICBSZWdpc3Rlci1TdGVwICJBdXRvLWxvZ2luIg0KDQogICAgV3JpdGUtTG9nICJTZXR0aW5nIHVwIFVidW50dS0yMi4wNCBvbiBXU0wyLi4uIg0KICAgICMgVGVzdCB0aGUgZGlzdHJvIGRpcmVjdGx5IOKAlCB3c2wgLS1saXN0IC0tcXVpZXQgb3V0cHV0cyBVVEYtMTYgd2hpY2ggY2FuIGNvcnJ1cHQgc3RyaW5nIG1hdGNoaW5nDQogICAgJGRpc3Ryb09rID0gKHdzbCAtZCBVYnVudHUtMjIuMDQgLS11c2VyIHJvb3QgLS0gYmFzaCAtYyAiZWNobyBvayIgMj4mMSkgLW1hdGNoICJvayINCiAgICBpZiAoLW5vdCAkZGlzdHJvT2spIHsNCiAgICAgICAgd3NsIC0tdW5yZWdpc3RlciBVYnVudHUtMjIuMDQgMj4mMSB8IE91dC1OdWxsDQogICAgICAgIFdyaXRlLUxvZyAiRG93bmxvYWRpbmcgVWJ1bnR1LTIyLjA0Li4uIg0KICAgICAgICB3c2wgLS1pbnN0YWxsIC1kIFVidW50dS0yMi4wNCAtLW5vLWxhdW5jaCAyPiYxIHwgT3V0LU51bGwNCg0KICAgICAgICBXcml0ZS1Mb2cgIkluaXRpYWxpemluZyBVYnVudHUtMjIuMDQgaGVhZGxlc3NseSAobm8gR1VJIHJlcXVpcmVkKS4uLiINCiAgICAgICAgJHVidW50dUV4ZSA9IEdldC1DaGlsZEl0ZW0gIiRlbnY6TE9DQUxBUFBEQVRBXE1pY3Jvc29mdFxXaW5kb3dzQXBwcyIgLUZpbHRlciAidWJ1bnR1MjIwNCouZXhlIiAtRXJyb3JBY3Rpb24gU2lsZW50bHlDb250aW51ZSB8IFNlbGVjdC1PYmplY3QgLUZpcnN0IDENCiAgICAgICAgaWYgKC1ub3QgJHVidW50dUV4ZSkgew0KICAgICAgICAgICAgJHVidW50dUV4ZSA9IEdldC1DaGlsZEl0ZW0gIiRlbnY6TE9DQUxBUFBEQVRBXE1pY3Jvc29mdFxXaW5kb3dzQXBwcyIgLUZpbHRlciAidWJ1bnR1Ki5leGUiIC1FcnJvckFjdGlvbiBTaWxlbnRseUNvbnRpbnVlIHwgU2VsZWN0LU9iamVjdCAtRmlyc3QgMQ0KICAgICAgICB9DQogICAgICAgIGlmICgkdWJ1bnR1RXhlKSB7DQogICAgICAgICAgICAmICR1YnVudHVFeGUuRnVsbE5hbWUgaW5zdGFsbCAtLXJvb3QgMj4mMSB8IE91dC1OdWxsDQogICAgICAgIH0NCiAgICAgICAgU3RhcnQtU2xlZXAgNQ0KDQogICAgICAgICRjaGVjayA9IHdzbCAtZCBVYnVudHUtMjIuMDQgLS11c2VyIHJvb3QgLS0gYmFzaCAtYyAiZWNobyBvayIgMj4mMQ0KICAgICAgICBpZiAoJGNoZWNrIC1ub3RtYXRjaCAib2siKSB7DQogICAgICAgICAgICBXcml0ZS1Mb2cgIlVidW50dS0yMi4wNCByb290IGFjY2VzcyBmYWlsZWQg4oCUIHJlLXJ1biBpbnN0YWxsZXIuIiAiRVJST1IiDQogICAgICAgICAgICBTaG93LURpYWdub3N0aWNzOyBXYWl0LUZvcktleTsgZXhpdCAxDQogICAgICAgIH0NCiAgICAgICAgV3JpdGUtTG9nICJVYnVudHUtMjIuMDQgaW5zdGFsbGVkIGFuZCBpbml0aWFsaXplZCIgIk9LIg0KICAgIH0gZWxzZSB7DQogICAgICAgIFdyaXRlLUxvZyAiVWJ1bnR1LTIyLjA0IGFscmVhZHkgcHJlc2VudCBhbmQgd29ya2luZyIgIk9LIg0KICAgIH0NCiAgICBTZXQtU3RlcCAiVWJ1bnR1IG9uIFdTTDIiICJQQVNTIg0KDQogICAgIyBFbmFibGUgc3lzdGVtZCDigJQgb3NuIGlzIGEgc3lzdGVtZCBzZXJ2aWNlDQogICAgV3JpdGUtTG9nICJFbmFibGluZyBzeXN0ZW1kIGluIFdTTDIgKHJlcXVpcmVkIGZvciBvc24gc2VydmljZSkuLi4iDQogICAgd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICJncmVwIC1xICdzeXN0ZW1kPXRydWUnIC9ldGMvd3NsLmNvbmYgMj4vZGV2L251bGwgfHwgcHJpbnRmICdbYm9vdF1cbnN5c3RlbWQ9dHJ1ZVxuJyA+IC9ldGMvd3NsLmNvbmYiDQoNCiAgICAjIFdTTDIgbWlycm9yZWQgbmV0d29ya2luZyDigJQgZXNwZWNpYWxseSBpbXBvcnRhbnQgZm9yIE9jdGFTcGFjZSBiZWNhdXNlIHRoZQ0KICAgICMgdHVubmVsIHBvcnRzIDUxODAwLTUxODE2IHVzZSBVRFAsIGFuZCBwb3J0cHJveHkgaXMgVENQLW9ubHkuDQogICAgJG9zQnVpbGQgPSBbU3lzdGVtLkVudmlyb25tZW50XTo6T1NWZXJzaW9uLlZlcnNpb24uQnVpbGQNCiAgICAkbWlycm9yZWROZXR3b3JraW5nID0gJGZhbHNlDQogICAgJHdzbENvbmZpZ1BhdGggPSAiJGVudjpVU0VSUFJPRklMRVwud3NsY29uZmlnIg0KICAgIGlmICgkb3NCdWlsZCAtZ2UgMjI2MjEpIHsNCiAgICAgICAgV3JpdGUtTG9nICJXaW5kb3dzIDExIDIySDIrIGRldGVjdGVkIOKAlCBlbmFibGluZyBXU0wyIG1pcnJvcmVkIG5ldHdvcmtpbmcuLi4iDQogICAgICAgICR3c2xDb25maWdDb250ZW50ID0gaWYgKFRlc3QtUGF0aCAkd3NsQ29uZmlnUGF0aCkgeyBHZXQtQ29udGVudCAkd3NsQ29uZmlnUGF0aCAtUmF3IH0gZWxzZSB7ICIiIH0NCiAgICAgICAgaWYgKCR3c2xDb25maWdDb250ZW50IC1ub3RtYXRjaCAnbmV0d29ya2luZ01vZGUnKSB7DQogICAgICAgICAgICBpZiAoJHdzbENvbmZpZ0NvbnRlbnQgLW1hdGNoICdcW3dzbDJcXScpIHsNCiAgICAgICAgICAgICAgICAkd3NsQ29uZmlnQ29udGVudCA9ICR3c2xDb25maWdDb250ZW50IC1yZXBsYWNlICcoXFt3c2wyXF0pJywgImAkMWBubmV0d29ya2luZ01vZGU9bWlycm9yZWQiDQogICAgICAgICAgICB9IGVsc2Ugew0KICAgICAgICAgICAgICAgICR3c2xDb25maWdDb250ZW50ICs9ICJgblt3c2wyXWBubmV0d29ya2luZ01vZGU9bWlycm9yZWRgbiINCiAgICAgICAgICAgIH0NCiAgICAgICAgICAgIFNldC1Db250ZW50IC1QYXRoICR3c2xDb25maWdQYXRoIC1WYWx1ZSAkd3NsQ29uZmlnQ29udGVudCAtRW5jb2RpbmcgVVRGOA0KICAgICAgICB9DQogICAgICAgICRtaXJyb3JlZE5ldHdvcmtpbmcgPSAkdHJ1ZQ0KICAgICAgICBXcml0ZS1Mb2cgIldTTDIgbWlycm9yZWQgbmV0d29ya2luZyBjb25maWd1cmVkIOKAlCBVRFAgdHVubmVscyB3aWxsIHdvcmsgY29ycmVjdGx5IiAiT0siDQogICAgICAgIFNldC1TdGVwICJXU0wyIG5ldHdvcmtpbmciICJQQVNTIiAiTWlycm9yZWQgKFdpbmRvd3MgMTEgMjJIMispIOKAlCBVRFAgdHVubmVscyBmdWxseSBmdW5jdGlvbmFsIg0KICAgIH0gZWxzZSB7DQogICAgICAgIFdyaXRlLUxvZyAiV2luZG93cyBidWlsZCAke29zQnVpbGR9OiBtaXJyb3JlZCBuZXR3b3JraW5nIG5lZWRzIDIySDIgKDIyNjIxKykg4oCUIHBvcnRwcm94eSBvbmx5IGNvdmVycyBUQ1A7IFVEUCB0dW5uZWxzIHdpbGwgYmUgbGltaXRlZCIgIldBUk4iDQogICAgICAgIFNldC1TdGVwICJXU0wyIG5ldHdvcmtpbmciICJXQVJOIiAiUG9ydHByb3h5IG9ubHkgKGJ1aWxkICRvc0J1aWxkKSDigJQgVURQIHR1bm5lbCBwb3J0cyBsaW1pdGVkOyB1cGdyYWRlIHRvIFdpbiAxMSAyMkgyKyByZWNvbW1lbmRlZCINCiAgICB9DQoNCiAgICB3c2wgLS1zaHV0ZG93bg0KICAgIFN0YXJ0LVNsZWVwIDIwDQogICAgJHNkQ2hlY2sgPSB3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tdXNlciByb290IC0tIGJhc2ggLWMgIlsgLWQgL3J1bi9zeXN0ZW1kL3N5c3RlbSBdICYmIGVjaG8geWVzIHx8IGVjaG8gbm8iIDI+JjENCiAgICBpZiAoJHNkQ2hlY2sgLW1hdGNoICJ5ZXMiKSB7DQogICAgICAgIFdyaXRlLUxvZyAic3lzdGVtZCBydW5uaW5nIGluIFdTTDIiICJPSyINCiAgICAgICAgU2V0LVN0ZXAgInN5c3RlbWQgaW4gV1NMMiIgIlBBU1MiDQogICAgfSBlbHNlIHsNCiAgICAgICAgV3JpdGUtTG9nICJzeXN0ZW1kIG1heSBub3QgYmUgYWN0aXZlIOKAlCBvc24gbWF5IG5vdCBhdXRvLXN0YXJ0IG9uIHJlYm9vdCIgIldBUk4iDQogICAgICAgIFNldC1TdGVwICJzeXN0ZW1kIGluIFdTTDIiICJXQVJOIiAic3lzdGVtZCBub3QgZGV0ZWN0ZWQg4oCUIG9zbiBzZXJ2aWNlIG1heSBub3QgcGVyc2lzdCBhY3Jvc3MgcmVib290cyINCiAgICB9DQoNCiAgICAjIOKUgOKUgCBEZXRlY3QgR1BVIHZlbmRvciDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANCiAgICAkZ3B1T2JqICAgID0gR2V0LVdtaU9iamVjdCBXaW4zMl9WaWRlb0NvbnRyb2xsZXIgfCBXaGVyZS1PYmplY3QgeyAkXy5OYW1lIC1tYXRjaCAiTlZJRElBfEdlRm9yY2V8UlRYfEdUWHxBTUR8UmFkZW9uIiB9IHwgU2VsZWN0LU9iamVjdCAtRmlyc3QgMQ0KICAgICRncHVOYW1lICAgPSAkZ3B1T2JqLk5hbWUNCiAgICAkdnJhbU1iICAgID0gJGdwdU9iai5BZGFwdGVyUkFNDQogICAgJHZyYW1HYiAgICA9IGlmICgkdnJhbU1iIC1hbmQgJHZyYW1NYiAtZ3QgMCkgeyBbbWF0aF06OlJvdW5kKCR2cmFtTWIgLyAxR0IpIH0gZWxzZSB7IDggfQ0KICAgICRncHVWZW5kb3IgPSBpZiAoJGdwdU5hbWUgLW1hdGNoICJOVklESUF8R2VGb3JjZXxSVFh8R1RYIikgeyAiTlZJRElBIiB9IGVsc2UgeyAiQU1EIiB9DQoNCiAgICAjIOKUgOKUgCBQcmUtaW5zdGFsbCBHUFUgY29tcHV0ZSBkcml2ZXJzIGluc2lkZSBXU0wyIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KICAgIFdyaXRlLUxvZyAiQ2hlY2tpbmcgR1BVIGNvbXB1dGUgZW52aXJvbm1lbnQgaW4gV1NMMiAoJGdwdVZlbmRvcikuLi4iDQogICAgaWYgKCRncHVWZW5kb3IgLWVxICJOVklESUEiKSB7DQogICAgICAgICRudkNoZWNrID0gd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICJudmlkaWEtc21pIC1MIDI+L2Rldi9udWxsIHwgaGVhZCAtMSIgMj4mMQ0KICAgICAgICBpZiAoJG52Q2hlY2sgLW1hdGNoICJHUFUgMCIpIHsNCiAgICAgICAgICAgIFdyaXRlLUxvZyAiTlZJRElBIEdQVSB2aXNpYmxlIGluIFdTTDIiICJPSyINCiAgICAgICAgICAgIFNldC1TdGVwICJHUFUgY29tcHV0ZSBpbiBXU0wyIiAiUEFTUyIgIm52aWRpYS1zbWkgT0sg4oCUICRncHVOYW1lIg0KICAgICAgICB9IGVsc2Ugew0KICAgICAgICAgICAgV3JpdGUtTG9nICJOVklESUEgR1BVIG5vdCB5ZXQgdmlzaWJsZSBpbiBXU0wyIOKAlCBlbnN1cmUgV2luZG93cyBOVklESUEgZHJpdmVyIGlzIHVwIHRvIGRhdGUiICJXQVJOIg0KICAgICAgICAgICAgU2V0LVN0ZXAgIkdQVSBjb21wdXRlIGluIFdTTDIiICJXQVJOIiAibnZpZGlhLXNtaSByZXR1cm5lZCBubyBvdXRwdXQg4oCUIG9zbiBtYXkgZmFpbCB3aXRob3V0IEdQVSBhY2Nlc3MiDQogICAgICAgIH0NCiAgICB9IGVsc2Ugew0KICAgICAgICBXcml0ZS1Mb2cgIkluc3RhbGxpbmcgUk9DbSBmb3IgQU1EIEdQVSBpbiBXU0wyICh0aGlzIHRha2VzIGEgZmV3IG1pbnV0ZXMpLi4uIg0KICAgICAgICAkdWJ1bnR1VmVyID0gd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICJsc2JfcmVsZWFzZSAtY3MgMj4vZGV2L251bGwiIDI+JjENCiAgICAgICAgJHVidW50dVZlciA9ICR1YnVudHVWZXIuVHJpbSgpDQogICAgICAgIGlmICgkdWJ1bnR1VmVyIC1ub3RpbiBAKCJqYW1teSIsImZvY2FsIiwibm9ibGUiKSkgeyAkdWJ1bnR1VmVyID0gImphbW15IiB9DQogICAgICAgICRyb2NtU2NyaXB0ID0gInNldCAtZWBuZXhwb3J0IERFQklBTl9GUk9OVEVORD1ub25pbnRlcmFjdGl2ZWBuYXB0LWdldCB1cGRhdGUgLXFxYG5hcHQtZ2V0IGluc3RhbGwgLXkgLXFxIHdnZXQgZ251cGcgY2EtY2VydGlmaWNhdGVzYG5ta2RpciAtcCAvZXRjL2FwdC9rZXlyaW5nc2Bud2dldCAtcU8gLSBodHRwczovL3JlcG8ucmFkZW9uLmNvbS9yb2NtL3JvY20uZ3BnLmtleSB8IGdwZyAtLWRlYXJtb3IgLW8gL2V0Yy9hcHQva2V5cmluZ3Mvcm9jbS5ncGdgbmVjaG8gJ2RlYiBbYXJjaD1hbWQ2NCBzaWduZWQtYnk9L2V0Yy9hcHQva2V5cmluZ3Mvcm9jbS5ncGddIGh0dHBzOi8vcmVwby5yYWRlb24uY29tL3JvY20vYXB0LzYuMiAkdWJ1bnR1VmVyIG1haW4nID4gL2V0Yy9hcHQvc291cmNlcy5saXN0LmQvcm9jbS5saXN0YG5hcHQtZ2V0IHVwZGF0ZSAtcXFgbmFwdC1nZXQgaW5zdGFsbCAteSAtcXEgcm9jbS1vcGVuY2wtcnVudGltZSINCiAgICAgICAgIyBQaXBlIHZpYSBzdGRpbiB0byBhdm9pZCBDUkxGIGlzc3VlcyB3aXRoIGJhc2ggLWMgb24gV2luZG93cw0KICAgICAgICAkcm9jbVNjcmlwdCB8IHdzbCAtZCBVYnVudHUtMjIuMDQgLS11c2VyIHJvb3QgLS0gYmFzaCAyPiYxIHwgRm9yRWFjaC1PYmplY3QgeyBXcml0ZS1Mb2cgJF8gfQ0KICAgICAgICBpZiAoJExBU1RFWElUQ09ERSAtZXEgMCkgew0KICAgICAgICAgICAgV3JpdGUtTG9nICJST0NtIGluc3RhbGxlZCIgIk9LIg0KICAgICAgICAgICAgU2V0LVN0ZXAgIkdQVSBjb21wdXRlIGluIFdTTDIiICJQQVNTIiAiUk9DbSBvcGVuY2wtcnVudGltZSBpbnN0YWxsZWQg4oCUICRncHVOYW1lIg0KICAgICAgICB9IGVsc2Ugew0KICAgICAgICAgICAgV3JpdGUtTG9nICJST0NtIGluc3RhbGwgZW5jb3VudGVyZWQgZXJyb3JzIOKAlCBPY3RhU3BhY2UgbWF5IGhhdmUgbGltaXRlZCBBTUQgc3VwcG9ydCIgIldBUk4iDQogICAgICAgICAgICBTZXQtU3RlcCAiR1BVIGNvbXB1dGUgaW4gV1NMMiIgIldBUk4iICJST0NtIGluc3RhbGwgaGFkIGVycm9ycyDigJQgQU1EIHN1cHBvcnQgbWF5IGJlIGxpbWl0ZWQiDQogICAgICAgIH0NCiAgICB9DQoNCiAgICAjIOKUgOKUgCBJbnN0YWxsIE9jdGFTcGFjZSBub2RlIChvc24pIGluc2lkZSBXU0wyIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KICAgIFdyaXRlLUxvZyAiSW5zdGFsbGluZyBvc24gcHJlcmVxdWlzaXRlcyAoY3VybCwgYmFzaCwgZ3VtKS4uLiINCiAgICB3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tdXNlciByb290IC0tIGJhc2ggLWMgImV4cG9ydCBERUJJQU5fRlJPTlRFTkQ9bm9uaW50ZXJhY3RpdmU7IGFwdC1nZXQgdXBkYXRlIC1xcSAmJiBhcHQtZ2V0IGluc3RhbGwgLXkgLXFxIGN1cmwgYmFzaCIgMj4mMSB8IEZvckVhY2gtT2JqZWN0IHsgV3JpdGUtTG9nICRfIH0NCiAgICBpZiAoJExBU1RFWElUQ09ERSAtZXEgMCkgew0KICAgICAgICBTZXQtU3RlcCAiQnVpbGQgdG9vbHMgKGN1cmwsIGJhc2gpIiAiUEFTUyINCiAgICB9IGVsc2Ugew0KICAgICAgICBTZXQtU3RlcCAiQnVpbGQgdG9vbHMgKGN1cmwsIGJhc2gpIiAiV0FSTiIgImFwdC1nZXQgZXhpdCAkTEFTVEVYSVRDT0RFIOKAlCBvc24gaW5zdGFsbGVyIHdpbGwgYXR0ZW1wdCB0byBjb250aW51ZSBhbnl3YXkiDQogICAgfQ0KDQogICAgV3JpdGUtTG9nICJJbnN0YWxsaW5nIGd1bSAocmVxdWlyZWQgYnkgT2N0YVNwYWNlIGluc3RhbGxlcikuLi4iDQogICAgJGd1bUluc3RhbGwgPSAiZXhwb3J0IERFQklBTl9GUk9OVEVORD1ub25pbnRlcmFjdGl2ZSAmJiBta2RpciAtcCAvZXRjL2FwdC9rZXlyaW5ncyAmJiBjdXJsIC1mc1NMIGh0dHBzOi8vcmVwby5jaGFybS5zaC9hcHQvZ3BnLmtleSB8IGdwZyAtLWRlYXJtb3IgLW8gL2V0Yy9hcHQva2V5cmluZ3MvY2hhcm0uZ3BnICYmIGVjaG8gJ2RlYiBbc2lnbmVkLWJ5PS9ldGMvYXB0L2tleXJpbmdzL2NoYXJtLmdwZ10gaHR0cHM6Ly9yZXBvLmNoYXJtLnNoL2FwdC8gKiAqJyB8IHRlZSAvZXRjL2FwdC9zb3VyY2VzLmxpc3QuZC9jaGFybS5saXN0ID4gL2Rldi9udWxsICYmIGFwdC1nZXQgdXBkYXRlIC1xcSAmJiBhcHQtZ2V0IGluc3RhbGwgLXkgLXFxIGd1bSINCiAgICB3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tdXNlciByb290IC0tIGJhc2ggLWMgJGd1bUluc3RhbGwgMj4mMSB8IEZvckVhY2gtT2JqZWN0IHsgV3JpdGUtTG9nICRfIH0NCiAgICBpZiAoJExBU1RFWElUQ09ERSAtbmUgMCkgew0KICAgICAgICBXcml0ZS1Mb2cgImd1bSBpbnN0YWxsIGZhaWxlZCDigJQgT2N0YVNwYWNlIGluc3RhbGxlciBtYXkgZmFpbCIgIldBUk4iDQogICAgfSBlbHNlIHsNCiAgICAgICAgV3JpdGUtTG9nICJndW0gaW5zdGFsbGVkIiAiT0siDQogICAgfQ0KDQogICAgV3JpdGUtTG9nICJJbnN0YWxsaW5nIE9jdGFTcGFjZSBub2RlIChvc24pIGluc2lkZSBXU0wyLi4uIg0KICAgICRvY3RhT3V0cHV0ID0gd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICJjdXJsIC1mc1NMIGh0dHBzOi8vaW5zdGFsbC5vY3RhLnNwYWNlIHwgYmFzaCIgMj4mMQ0KICAgICRvY3RhRXhpdCA9ICRMQVNURVhJVENPREUNCiAgICAkb2N0YU91dHB1dCB8IEZvckVhY2gtT2JqZWN0IHsgV3JpdGUtTG9nICRfIH0NCiAgICBpZiAoJG9jdGFFeGl0IC1uZSAwKSB7DQogICAgICAgIFNldC1TdGVwICJPY3RhU3BhY2Ugb3NuIGluc3RhbGxlZCIgIkZBSUwiICJpbnN0YWxsLm9jdGEuc3BhY2Ugc2NyaXB0IGV4aXRlZCAkb2N0YUV4aXQg4oCUIHNlZSBsb2cgZm9yIGRldGFpbHMiDQogICAgICAgIFdyaXRlLUxvZyAiT2N0YVNwYWNlIGluc3RhbGxhdGlvbiBmYWlsZWQgKGV4aXQgJG9jdGFFeGl0KS4gQ2hlY2sgdGhlIG91dHB1dCBhYm92ZS4iICJFUlJPUiINCiAgICAgICAgU2hvdy1EaWFnbm9zdGljczsgV2FpdC1Gb3JLZXk7IGV4aXQgMQ0KICAgIH0NCiAgICBXcml0ZS1Mb2cgIk9jdGFTcGFjZSBvc24gaW5zdGFsbCBjb21wbGV0ZSIgIk9LIg0KICAgIFNldC1TdGVwICJPY3RhU3BhY2Ugb3NuIGluc3RhbGxlZCIgIlBBU1MiDQoNCiAgICAjIOKUgOKUgCBTdGFiaWxpdHkgRml4IDE6IGNhcCBOVklESUEgSHVnZVBhZ2VzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KICAgICMgTlZJRElBJ3MgV1NMMiBkcml2ZXIgbG9ja3MgSHVnZVBhZ2VzIHByb3BvcnRpb25hbCB0byBhdmFpbGFibGUgUkFNIOKAlCB1cCB0byB+OEdCDQogICAgIyBvbiBhIDEwR0IgV1NMIGluc3RhbmNlLiBFcmxhbmcncyBtZW1zdXAgZmlyZXMgYSBzeXN0ZW1fbWVtb3J5X2hpZ2hfd2F0ZXJtYXJrIGFsYXJtDQogICAgIyB3aGVuID44MCUgUkFNIGlzIHVzZWQsIGNhdXNpbmcgT1NOIHRvIGNhbGwgaW5pdDpzdG9wKCkgfjE1cyBhZnRlciBldmVyeSBzdGFydHVwLg0KICAgIFdyaXRlLUxvZyAiQ2FwcGluZyBOVklESUEgSHVnZVBhZ2VzIGF0IDI1NiAoNTEyTUIpIHRvIHByZXZlbnQgUkFNIHN0YXJ2YXRpb24uLi4iDQogICAgd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICJlY2hvIHZtLm5yX2h1Z2VwYWdlcz0yNTYgPiAvZXRjL3N5c2N0bC5kLzkwLXdzbC5jb25mICYmIHN5c2N0bCAtcCAvZXRjL3N5c2N0bC5kLzkwLXdzbC5jb25mIiAyPiYxIHwgRm9yRWFjaC1PYmplY3QgeyBXcml0ZS1Mb2cgJF8gfQ0KICAgIFdyaXRlLUxvZyAiSHVnZVBhZ2VzIGNhcHBlZCDigJQgTlZJRElBIGRyaXZlciBsaW1pdGVkIHRvIDUxMk1CIGtlcm5lbCBwYWdlcyIgIk9LIg0KICAgIFNldC1TdGVwICJIdWdlUGFnZXMgY2FwIChSQU0gZml4KSIgIlBBU1MiDQoNCiAgICAjIOKUgOKUgCBTdGFiaWxpdHkgRml4IDI6IHJhaXNlIE9TTiBkaXNrICsgbWVtb3J5IGFsYXJtIHRocmVzaG9sZHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSADQogICAgIyBPY3RhU3BhY2UncyBpbnN0YWxsZXIgY3JlYXRlcyAvZG9ja2VyLWRhdGEuaW1nICh+NzYzR0IgcmVhbCBmaWxlKSBmb3IgRG9ja2VyIHN0b3JhZ2UsDQogICAgIyBwdXNoaW5nIHRoZSByb290IGZpbGVzeXN0ZW0gdG8gfjgxJS4gRXJsYW5nJ3MgZGlza3N1cCBmaXJlcyBhIGRpc2tfYWxtb3N0X2Z1bGwgYWxhcm0NCiAgICAjIGF0IDgwJSAodGhlIGRlZmF1bHQpIGFuZCBjYXVzZXMgT1NOIHRvIHNlbGYtdGVybWluYXRlLiBSYWlzaW5nIHRvIDkwJSBjbGVhcnMgaGVhZHJvb20uDQogICAgIyBtZW1zdXAncyBzeXN0ZW1fbWVtb3J5X2hpZ2hfd2F0ZXJtYXJrIHVzZXMgInN0cmljdGx5IGZyZWUgLyB0b3RhbCIgd2hpY2ggZmlyZXMgY29uc3RhbnRseQ0KICAgICMgb24gTGludXggYmVjYXVzZSB0aGUga2VybmVsIGZpbGxzIGFsbCBzcGFyZSBtZW1vcnkgd2l0aCBidWZmZXIgY2FjaGUuIFJhaXNpbmcgdG8gMC45Nw0KICAgICMgbWVhbnMgdGhlIGFsYXJtIG9ubHkgZmlyZXMgd2hlbiBnZW51aW5lbHkgUkFNLXN0YXJ2ZWQ7IGJyaWVmIHNwaWtlcyBjbGVhciBxdWlja2x5Lg0KICAgIFdyaXRlLUxvZyAiUGF0Y2hpbmcgT1NOIGFsYXJtIHRocmVzaG9sZHMgKGRpc2sgOTAlLCBtZW1vcnkgOTclKS4uLiINCiAgICAkZGlza0ZpeFNjcmlwdCA9IEAnDQpTWVNfQ0ZHPSQobHMgL2hvbWUvb2N0YS9vc24vcmVsZWFzZXMvKi9zeXMuY29uZmlnIDI+L2Rldi9udWxsIHwgZ3JlcCAtdiBSRUxFQVNFUyB8IGhlYWQgLTEpDQppZiBbIC16ICIkU1lTX0NGRyIgXTsgdGhlbiBlY2hvICJzeXMuY29uZmlnIG5vdCBmb3VuZCI7IGV4aXQgMTsgZmkNCmdyZXAgLXEgImRpc2tfYWxtb3N0X2Z1bGxfdGhyZXNob2xkIiAiJFNZU19DRkciICYmIGdyZXAgLXEgInN5c3RlbV9tZW1vcnlfaGlnaF93YXRlcm1hcmsiICIkU1lTX0NGRyIgJiYgZWNobyAiYWxyZWFkeSBwYXRjaGVkIiAmJiBleGl0IDANCmNhdCA+ICIkU1lTX0NGRyIgPDwgJ0VSTEVPRicNClsNCiAgICB7a2VybmVsLCBbDQogICAgICAgIHtsb2dnZXJfbGV2ZWwsIGRlYnVnfSwNCiAgICAgICAge2xvZ2dlciwgWw0KICAgICAgICAgICAge2hhbmRsZXIsIGRlZmF1bHQsIGxvZ2dlcl9zdGRfaCwgI3sNCiAgICAgICAgICAgICAgICBsZXZlbCA9PiBkZWJ1ZywNCiAgICAgICAgICAgICAgICBjb25maWcgPT4gI3sNCiAgICAgICAgICAgICAgICAgICAgYnVyc3RfbGltaXRfZW5hYmxlID0+IGZhbHNlDQogICAgICAgICAgICAgICAgfSwNCiAgICAgICAgICAgICAgICBmb3JtYXR0ZXIgPT4ge2xvZ2dlcl9mb3JtYXR0ZXIsICN7dGVtcGxhdGUgPT4gW3RpbWUsICIgIiwgbXNnLCAiXG4iXX19DQogICAgICAgICAgICB9fQ0KICAgICAgICBdfQ0KICAgIF19LA0KICAgIHtvc19tb24sIFsNCiAgICAgICAge2Rpc2tfYWxtb3N0X2Z1bGxfdGhyZXNob2xkLCAwLjkwfSwNCiAgICAgICAge3N5c3RlbV9tZW1vcnlfaGlnaF93YXRlcm1hcmssIDAuOTd9DQogICAgXX0NCl0uDQpFUkxFT0YNCmVjaG8gInBhdGNoZWQiDQonQA0KICAgICRkaXNrRml4U2NyaXB0ID0gJGRpc2tGaXhTY3JpcHQgLXJlcGxhY2UgImByYG4iLCAiYG4iICAjIENSTEYgYnJlYWtzIGhlcmVkb2MgZGVsaW1pdGVyIHdoZW4gZGVjb2RlZCBpbiBiYXNoDQogICAgJGRpc2tGaXhCNjQgPSBbQ29udmVydF06OlRvQmFzZTY0U3RyaW5nKFtTeXN0ZW0uVGV4dC5FbmNvZGluZ106OlVURjguR2V0Qnl0ZXMoJGRpc2tGaXhTY3JpcHQpKQ0KICAgICRkaXNrUmVzdWx0ID0gd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICJlY2hvICckZGlza0ZpeEI2NCcgfCBiYXNlNjQgLWQgfCBiYXNoIiAyPiYxDQogICAgJGRpc2tPayA9ICgkTEFTVEVYSVRDT0RFIC1lcSAwKSAtYW5kICgkZGlza1Jlc3VsdCAtbm90bWF0Y2ggJ3N5bnRheCBlcnJvcnxub3QgZm91bmR8ZXJyb3InKQ0KICAgIFdyaXRlLUxvZyAiT1NOIGFsYXJtIHRocmVzaG9sZHM6ICQoJGRpc2tSZXN1bHQgLWpvaW4gJyAnKSIgJChpZiAoJGRpc2tPaykgeyAiT0siIH0gZWxzZSB7ICJXQVJOIiB9KQ0KICAgIGlmICgkZGlza09rKSB7DQogICAgICAgIFNldC1TdGVwICJPU04gYWxhcm0gdGhyZXNob2xkcyIgIlBBU1MiDQogICAgfSBlbHNlIHsNCiAgICAgICAgU2V0LVN0ZXAgIk9TTiBhbGFybSB0aHJlc2hvbGRzIiAiV0FSTiIgInRocmVzaG9sZCBwYXRjaCBmYWlsZWQg4oCUIE9TTiBtYXkgcmVzdGFydCBpZiBkaXNrID44MCUgb3IgbWVtb3J5IGNhY2hlIGZpbGxzIg0KICAgIH0NCg0KICAgICMg4pSA4pSAIFN0YWJpbGl0eSBGaXggMzogZGlzYWJsZSBXaW5kb3dzIFVwZGF0ZSBhdXRvLXJlc3RhcnQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSADQogICAgIyBXaW5kb3dzIDExIGNhbiBmb3JjZS1yZXN0YXJ0IG1pZC1yZW50YWwgdG8gYXBwbHkgdXBkYXRlcywgdGVybWluYXRpbmcgYW55IHJ1bm5pbmcgam9iDQogICAgIyB3aXRoICJub2RlIHdlbnQgZG93biBvciByZWJvb3RlZCBkdXJpbmcgc2Vzc2lvbiIuIEJsb2NrIGF1dG8tcmVzdGFydCB3aGVuIGEgdXNlciBpcw0KICAgICMgbG9nZ2VkIGluICh1cGRhdGVzIHN0aWxsIGRvd25sb2FkIGFuZCBpbnN0YWxsOyB0aGV5IGp1c3QgZG9uJ3QgcmVzdGFydCB3aXRob3V0IGNvbnNlbnQpLg0KICAgIFdyaXRlLUxvZyAiQmxvY2tpbmcgV2luZG93cyBVcGRhdGUgYXV0by1yZXN0YXJ0IGR1cmluZyBhY3RpdmUgc2Vzc2lvbnMuLi4iDQogICAgdHJ5IHsNCiAgICAgICAgJHd1UGF0aCA9ICJIS0xNOlxTT0ZUV0FSRVxQb2xpY2llc1xNaWNyb3NvZnRcV2luZG93c1xXaW5kb3dzVXBkYXRlXEFVIg0KICAgICAgICBpZiAoLW5vdCAoVGVzdC1QYXRoICR3dVBhdGgpKSB7IE5ldy1JdGVtIC1QYXRoICR3dVBhdGggLUZvcmNlIHwgT3V0LU51bGwgfQ0KICAgICAgICBTZXQtSXRlbVByb3BlcnR5IC1QYXRoICR3dVBhdGggLU5hbWUgIk5vQXV0b1JlYm9vdFdpdGhMb2dnZWRPblVzZXJzIiAtVmFsdWUgMSAtVHlwZSBEV29yZCAtRm9yY2UNCiAgICAgICAgU2V0LUl0ZW1Qcm9wZXJ0eSAtUGF0aCAkd3VQYXRoIC1OYW1lICJBVU9wdGlvbnMiIC1WYWx1ZSA0IC1UeXBlIERXb3JkIC1Gb3JjZSAgIyA0ID0gZG93bmxvYWQgYW5kIHNjaGVkdWxlIGluc3RhbGwgKG5vIGF1dG8taW5zdGFsbCkNCiAgICAgICAgV3JpdGUtTG9nICJXaW5kb3dzIFVwZGF0ZSBhdXRvLXJlc3RhcnQgc3VwcHJlc3NlZCIgIk9LIg0KICAgICAgICBTZXQtU3RlcCAiV2luZG93cyBVcGRhdGUgcmVzdGFydCBndWFyZCIgIlBBU1MiDQogICAgfSBjYXRjaCB7DQogICAgICAgIFdyaXRlLUxvZyAiQ291bGQgbm90IHNldCBXaW5kb3dzIFVwZGF0ZSBwb2xpY3kgKG5vbi1mYXRhbCk6ICRfIiAiV0FSTiINCiAgICAgICAgU2V0LVN0ZXAgIldpbmRvd3MgVXBkYXRlIHJlc3RhcnQgZ3VhcmQiICJXQVJOIiAiTWFudWFsOiBzZXQgTm9BdXRvUmVib290V2l0aExvZ2dlZE9uVXNlcnM9MSBpbiBHcm91cCBQb2xpY3kiDQogICAgfQ0KDQogICAgIyBTdGFydCB0aGUgc2VydmljZSBzbyBpdCBjYW4gcmVnaXN0ZXIgYW5kIGdlbmVyYXRlIGEgbm9kZSB0b2tlbg0KICAgIFdyaXRlLUxvZyAiU3RhcnRpbmcgb3NuIHNlcnZpY2UuLi4iDQogICAgd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICJzeXN0ZW1jdGwgZW5hYmxlIG9zbiAyPi9kZXYvbnVsbDsgc3lzdGVtY3RsIHN0YXJ0IG9zbiAyPi9kZXYvbnVsbCINCiAgICBTZXQtU3RlcCAib3NuIHNlcnZpY2Ugc3RhcnRlZCIgIlBBU1MiDQoNCiAgICAjIOKUgOKUgCBFeHRyYWN0IE9jdGFTcGFjZSBub2RlIHRva2VuIGZyb20gaW5zdGFsbGVyIG91dHB1dCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANCiAgICAjIFRoZSBpbnN0YWxsZXIgcHJpbnRzIGEgYm94OiDilZEgIE5vZGUgVG9rZW46IFhYWFhYWFhYWFggIOKVkSB0byBzdGRvdXQuDQogICAgJG9jdGFOb2RlVG9rZW4gPSAiIg0KICAgICR0b2tlbk1hdGNoID0gJG9jdGFPdXRwdXQgfCBTZWxlY3QtU3RyaW5nIC1QYXR0ZXJuICdOb2RlIFRva2VuOlxzKihcUyspJw0KICAgIGlmICgkdG9rZW5NYXRjaCkgew0KICAgICAgICAkb2N0YU5vZGVUb2tlbiA9ICR0b2tlbk1hdGNoLk1hdGNoZXNbMF0uR3JvdXBzWzFdLlZhbHVlLlRyaW0oKQ0KICAgICAgICBXcml0ZS1Mb2cgIk9jdGFTcGFjZSBub2RlIHRva2VuOiAkb2N0YU5vZGVUb2tlbiIgIk9LIg0KICAgICAgICBTZXQtU3RlcCAiT2N0YVNwYWNlIG5vZGUgdG9rZW4iICJQQVNTIiAiVG9rZW46ICRvY3RhTm9kZVRva2VuIg0KICAgIH0gZWxzZSB7DQogICAgICAgICMgRmFsbGJhY2s6IGNoZWNrIGNvbmZpZyBmaWxlcyB3cml0dGVuIGJ5IG9zbiBhZnRlciBmaXJzdCBzdGFydA0KICAgICAgICBXcml0ZS1Mb2cgIlRva2VuIG5vdCBmb3VuZCBpbiBpbnN0YWxsZXIgb3V0cHV0IOKAlCBjaGVja2luZyBvc24gY29uZmlnIGZpbGVzLi4uIg0KICAgICAgICBTdGFydC1TbGVlcCAxNQ0KICAgICAgICAkcmF3ID0gd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jIEAnDQpmb3IgZiBpbiAvaG9tZS9vY3RhL29zbi9ldGMvc3lzLmNvbmZpZyAvZXRjL29zbi9ub2RlLmpzb24gL3Zhci9saWIvb3NuL25vZGUuanNvbjsgZG8NCiAgICBbIC1mICIkZiIgXSB8fCBjb250aW51ZQ0KICAgIHRvaz0kKGdyZXAgLW9QICcibm9kZV90b2tlbiJccyo6XHMqIlxLW14iXSsnICIkZiIgMj4vZGV2L251bGwgfHwgZ3JlcCAtb1AgJyJ0b2tlbiJccyo6XHMqIlxLW14iXSsnICIkZiIgMj4vZGV2L251bGwpDQogICAgWyAtbiAiJHRvayIgXSAmJiBlY2hvICIkdG9rIiAmJiBicmVhaw0KZG9uZQ0KJ0AgMj4mMQ0KICAgICAgICAkY2FuZGlkYXRlID0gKCRyYXcgfCBXaGVyZS1PYmplY3QgeyAkXyAtbWF0Y2ggJ15ccypcU3s2LH1ccyokJyB9KSB8IFNlbGVjdC1PYmplY3QgLUZpcnN0IDENCiAgICAgICAgaWYgKCRjYW5kaWRhdGUpIHsNCiAgICAgICAgICAgICRvY3RhTm9kZVRva2VuID0gJGNhbmRpZGF0ZS5UcmltKCkNCiAgICAgICAgICAgIFdyaXRlLUxvZyAiT2N0YVNwYWNlIG5vZGUgdG9rZW4gKGZyb20gY29uZmlnKTogJG9jdGFOb2RlVG9rZW4iICJPSyINCiAgICAgICAgICAgIFNldC1TdGVwICJPY3RhU3BhY2Ugbm9kZSB0b2tlbiIgIlBBU1MiICJUb2tlbjogJG9jdGFOb2RlVG9rZW4iDQogICAgICAgIH0gZWxzZSB7DQogICAgICAgICAgICBXcml0ZS1Mb2cgIk5vZGUgdG9rZW4gbm90IGZvdW5kIOKAlCBpdCB3aWxsIGFwcGVhciBhdCBjdWJlLm9jdGEuY29tcHV0ZXIgYWZ0ZXIgdGhlIG5vZGUgY29ubmVjdHMiICJXQVJOIg0KICAgICAgICAgICAgU2V0LVN0ZXAgIk9jdGFTcGFjZSBub2RlIHRva2VuIiAiV0FSTiIgIk5vdCB5ZXQgYXNzaWduZWQg4oCUIGNoZWNrIGN1YmUub2N0YS5jb21wdXRlciINCiAgICAgICAgfQ0KICAgIH0NCg0KICAgICMg4pSA4pSAIE5ldHdvcmtpbmc6IFdpbmRvd3MgRmlyZXdhbGwgKyBVUG5QIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KICAgIFdyaXRlLUxvZyAiQWRkaW5nIFdpbmRvd3MgRmlyZXdhbGwgaW5ib3VuZCBydWxlcyAoVENQICsgVURQKS4uLiINCiAgICAkYWxsUG9ydHMgPSAkT0NUQV9NR01UX1BPUlRTICsgKCRPQ1RBX0FQUF9QT1JUX1NUQVJULi4kT0NUQV9BUFBfUE9SVF9FTkQpDQogICAgZm9yZWFjaCAoJHBvcnQgaW4gJGFsbFBvcnRzKSB7DQogICAgICAgIE5ldy1OZXRGaXJld2FsbFJ1bGUgLURpc3BsYXlOYW1lICJQdWxzZS1PY3RhLVRDUC0kcG9ydCIgLURpcmVjdGlvbiBJbmJvdW5kIGANCiAgICAgICAgICAgIC1Qcm90b2NvbCBUQ1AgLUxvY2FsUG9ydCAkcG9ydCAtQWN0aW9uIEFsbG93IC1FcnJvckFjdGlvbiBTaWxlbnRseUNvbnRpbnVlIHwgT3V0LU51bGwNCiAgICAgICAgTmV3LU5ldEZpcmV3YWxsUnVsZSAtRGlzcGxheU5hbWUgIlB1bHNlLU9jdGEtVURQLSRwb3J0IiAtRGlyZWN0aW9uIEluYm91bmQgYA0KICAgICAgICAgICAgLVByb3RvY29sIFVEUCAtTG9jYWxQb3J0ICRwb3J0IC1BY3Rpb24gQWxsb3cgLUVycm9yQWN0aW9uIFNpbGVudGx5Q29udGludWUgfCBPdXQtTnVsbA0KICAgIH0NCiAgICBXcml0ZS1Mb2cgIkZpcmV3YWxsIHJ1bGVzIGFkZGVkIChUQ1ArVURQKSBmb3IgcG9ydHMgJCgkT0NUQV9NR01UX1BPUlRTIC1qb2luICcsICcpICsgJE9DVEFfQVBQX1BPUlRfU1RBUlQtJE9DVEFfQVBQX1BPUlRfRU5EIiAiT0siDQogICAgU2V0LVN0ZXAgIldpbmRvd3MgRmlyZXdhbGwgcnVsZXMiICJQQVNTIiAiVENQK1VEUCAkKCRPQ1RBX01HTVRfUE9SVFMgLWpvaW4gJywgJyksICRPQ1RBX0FQUF9QT1JUX1NUQVJULSRPQ1RBX0FQUF9QT1JUX0VORCINCg0KICAgIFdyaXRlLUxvZyAiQXR0ZW1wdGluZyBVUG5QIGF1dG9tYXRpYyBwb3J0IGZvcndhcmRpbmcuLi4iDQogICAgJGxvY2FsSVAgPSBHZXQtTG9jYWxJUA0KICAgICR1cG5wT2sgID0gJGZhbHNlDQogICAgdHJ5IHsNCiAgICAgICAgJHVwbnAgICAgID0gTmV3LU9iamVjdCAtQ29tT2JqZWN0IEhOZXRDZmcuTkFUVVBuUA0KICAgICAgICAkbWFwcGluZ3MgPSAkdXBucC5TdGF0aWNQb3J0TWFwcGluZ0NvbGxlY3Rpb24NCiAgICAgICAgZm9yZWFjaCAoJHBvcnQgaW4gJGFsbFBvcnRzKSB7DQogICAgICAgICAgICAkbWFwcGluZ3MuQWRkKCRwb3J0LCAiVENQIiwgJHBvcnQsICRsb2NhbElQLCAkdHJ1ZSwgIlB1bHNlLU9jdGEtVENQLSRwb3J0IikgfCBPdXQtTnVsbA0KICAgICAgICAgICAgJG1hcHBpbmdzLkFkZCgkcG9ydCwgIlVEUCIsICRwb3J0LCAkbG9jYWxJUCwgJHRydWUsICJQdWxzZS1PY3RhLVVEUC0kcG9ydCIpIHwgT3V0LU51bGwNCiAgICAgICAgfQ0KICAgICAgICBXcml0ZS1Mb2cgIlVQblAgc3VjY2VlZGVkIOKAlCBwb3J0cyAkKCRPQ1RBX01HTVRfUE9SVFMgLWpvaW4gJywgJyksICRPQ1RBX0FQUF9QT1JUX1NUQVJULSRPQ1RBX0FQUF9QT1JUX0VORCBmb3J3YXJkZWQgKFRDUCtVRFApIHRvICRsb2NhbElQIiAiT0siDQogICAgICAgIFNldC1TdGVwICJVUG5QIHBvcnQgZm9yd2FyZGluZyIgIlBBU1MiICJBdXRvLWZvcndhcmRlZCAoVENQK1VEUCkg4oaSICRsb2NhbElQIg0KICAgICAgICAkdXBucE9rID0gJHRydWUNCiAgICB9IGNhdGNoIHsNCiAgICAgICAgV3JpdGUtTG9nICJVUG5QIHVuYXZhaWxhYmxlIG9uIHRoaXMgcm91dGVyIiAiV0FSTiINCiAgICAgICAgU2V0LVN0ZXAgIlVQblAgcG9ydCBmb3J3YXJkaW5nIiAiV0FSTiIgIlVQblAgdW5hdmFpbGFibGUg4oCUIG1hbnVhbCByb3V0ZXIgc2V0dXAgcmVxdWlyZWQgKFRDUCtVRFAsIHNlZSBhYm92ZSkiDQogICAgfQ0KDQogICAgaWYgKC1ub3QgJHVwbnBPaykgew0KICAgICAgICBXcml0ZS1Ib3N0ICIiDQogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSM4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSQIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdw0KICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgUk9VVEVSIFNFVFVQIFJFUVVJUkVEIChvbmUtdGltZSwgfjIgbWludXRlcykgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdw0KICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdw0KICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgWW91ciByb3V0ZXIgZG9lc24ndCBzdXBwb3J0IGF1dG8tZm9yd2FyZGluZyAoVVBuUCBvZmYpLiAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93DQogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICBPY3RhU3BhY2UgbmVlZHMgQk9USCBUQ1AgYW5kIFVEUCBmb3J3YXJkZWQuICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cNCiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cNCiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgIDEuIE9wZW4geW91ciByb3V0ZXIgYWRtaW4gcGFnZSAodXN1YWxseSBodHRwOi8vMTkyLjE2OC4xLjEp4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdw0KICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgMi4gRmluZCAnUG9ydCBGb3J3YXJkaW5nJyBvciAnVmlydHVhbCBTZXJ2ZXInICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93DQogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICAzLiBBZGQgVENQK1VEUCBydWxlcyDihpIgJGxvY2FsSVAgOiAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdw0KICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgICBUQ1ArVURQIDE4ODg4IOKGkiAkbG9jYWxJUGA6MTg4ODggICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cNCiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgVENQK1VEUCAkT0NUQV9BUFBfUE9SVF9TVEFSVC0kT0NUQV9BUFBfUE9SVF9FTkQg4oaSICRsb2NhbElQYDokT0NUQV9BUFBfUE9SVF9TVEFSVC0kT0NUQV9BUFBfUE9SVF9FTkQg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdw0KICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdw0KICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgUHJlc3MgRW50ZXIgb25jZSBkb25lICh5b3UgY2FuIGZpbmlzaCB0aGlzIGxhdGVyIHZpYSB0aGUgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93DQogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICBQdWxzZSBkYXNoYm9hcmQg4oCUIGJ1dCBqb2JzIHdvbid0IGxhbmQgdW50aWwgaXQncyBkb25lKSAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdw0KICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUlOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUmCIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cNCiAgICAgICAgUmVhZC1Ib3N0ICIgIFByZXNzIEVudGVyIHRvIGNvbnRpbnVlIg0KICAgIH0NCg0KICAgICMg4pSA4pSAIFdTTDIgUG9ydCBQcm94eSAoVENQIG9ubHkpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KICAgIGlmICgtbm90ICRtaXJyb3JlZE5ldHdvcmtpbmcpIHsNCiAgICAgICAgV3JpdGUtTG9nICJDb25maWd1cmluZyBXU0wyIFRDUCBwb3J0IHByb3h5IChXaW5kb3dzIGhvc3Qg4oaSIFdTTDIgYnJpZGdlKS4uLiINCiAgICAgICAgJHdzbElQID0gKHdzbCAtZCBVYnVudHUtMjIuMDQgLS11c2VyIHJvb3QgLS0gYmFzaCAtYyAiaG9zdG5hbWUgLUkgMj4vZGV2L251bGwiKS5UcmltKCkuU3BsaXQoKVswXQ0KICAgICAgICBpZiAoJHdzbElQKSB7DQogICAgICAgICAgICBTZXQtV1NMMlBvcnRQcm94eSAtV3NsSVAgJHdzbElQDQogICAgICAgICAgICBTZXQtQ29udGVudCAtUGF0aCAiJFBVTFNFX0RJUlxsYXN0X3dzbF9pcCIgLVZhbHVlICR3c2xJUCAtRW5jb2RpbmcgVVRGOA0KICAgICAgICAgICAgU2V0LVN0ZXAgIldTTDIgcG9ydCBwcm94eSIgIlBBU1MiICJUQ1Ag4oaSICR3c2xJUCAoVURQIHJlcXVpcmVzIG1pcnJvcmVkIG5ldHdvcmtpbmcpIg0KICAgICAgICB9IGVsc2Ugew0KICAgICAgICAgICAgV3JpdGUtTG9nICJDb3VsZCBub3QgZGV0ZXJtaW5lIFdTTDIgSVAg4oCUIHBvcnRwcm94eSBza2lwcGVkOyB3aWxsIHJldHJ5IG9uIG5leHQgbG9naW4iICJXQVJOIg0KICAgICAgICAgICAgU2V0LVN0ZXAgIldTTDIgcG9ydCBwcm94eSIgIldBUk4iICJXU0wyIElQIG5vdCBmb3VuZCDigJQgd2lsbCByZXRyeSBvbiBuZXh0IGxvZ2luIg0KICAgICAgICB9DQogICAgfSBlbHNlIHsNCiAgICAgICAgV3JpdGUtTG9nICJNaXJyb3JlZCBuZXR3b3JraW5nIGFjdGl2ZSDigJQgcG9ydHByb3h5IG5vdCBuZWVkZWQ7IFVEUCB0dW5uZWxzIGZ1bGx5IGZ1bmN0aW9uYWwiICJPSyINCiAgICAgICAgU2V0LVN0ZXAgIldTTDIgcG9ydCBwcm94eSIgIlNLSVAiICJOb3QgbmVlZGVkIOKAlCBtaXJyb3JlZCBuZXR3b3JraW5nIGFjdGl2ZSINCiAgICB9DQoNCiAgICAjIOKUgOKUgCBDdWJlIHJlZ2lzdHJhdGlvbiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANCiAgICBXcml0ZS1Ib3N0ICIiDQogICAgV3JpdGUtSG9zdCAiICDilIzilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilJAiIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbg0KICAgIFdyaXRlLUhvc3QgIiAg4pSCICBPQ1RBU1BBQ0UgQ1VCRSBSRUdJU1RSQVRJT04gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4NCiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4NCiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgVG8gYXBwZWFyIGluIHRoZSBPY3RhU3BhY2UgbWFya2V0cGxhY2U6ICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4NCiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAxLiBPcGVuOiBodHRwczovL2N1YmUub2N0YS5jb21wdXRlciAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4NCiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAyLiBTaWduIGluIC8gY3JlYXRlIGFuIGFjY291bnQgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4NCiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAzLiBBZGQgeW91ciBub2RlIOKAlCBpdCBzaG91bGQgYXBwZWFyIGF1dG9tYXRpY2FsbHkgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbg0KICAgIGlmICgkb2N0YU5vZGVUb2tlbikgew0KICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbg0KICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgIFlvdXIgbm9kZSB0b2tlbjogJG9jdGFOb2RlVG9rZW4iIC1Gb3JlZ3JvdW5kQ29sb3IgV2hpdGUNCiAgICB9DQogICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBDeWFuDQogICAgV3JpdGUtSG9zdCAiICDilIIgIFRoaXMgc3RlcCBpcyBkb25lIGluIHlvdXIgYnJvd3Nlciwgbm90IHRoaXMgd2luZG93LiAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBDeWFuDQogICAgV3JpdGUtSG9zdCAiICDilJTilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilJgiIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbg0KICAgIFdyaXRlLUhvc3QgIiINCiAgICBSZWFkLUhvc3QgIiAgUHJlc3MgRW50ZXIgdG8gY29udGludWUgb25jZSB5b3UndmUgbm90ZWQgdGhlIGFib3ZlIg0KDQogICAgIyDilIDilIAgUmVnaXN0ZXIgd2l0aCBQdWxzZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANCiAgICBXcml0ZS1Mb2cgIlJlZ2lzdGVyaW5nIG1hY2hpbmUgd2l0aCBQdWxzZS4uLiINCg0KICAgICRib2R5ID0gQHsNCiAgICAgICAgZ3B1X21vZGVsICAgICAgICA9ICRncHVOYW1lDQogICAgICAgIHZyYW1fZ2IgICAgICAgICAgPSAkdnJhbUdiDQogICAgICAgIG9jdGFfbm9kZV90b2tlbiAgPSAkb2N0YU5vZGVUb2tlbg0KICAgICAgICBwbGF0Zm9ybSAgICAgICAgID0gIk9jdGFTcGFjZSINCiAgICB9IHwgQ29udmVydFRvLUpzb24NCg0KICAgIHRyeSB7DQogICAgICAgICRyZXNwID0gSW52b2tlLVJlc3RNZXRob2QgLVVyaSAiJFBVTFNFX0FQSV9CQVNFL3JlZ2lzdGVyT2N0YXNwYWNlRGFlbW9uIiBgDQogICAgICAgICAgICAtTWV0aG9kIFBPU1QgYA0KICAgICAgICAgICAgLUNvbnRlbnRUeXBlICJhcHBsaWNhdGlvbi9qc29uIiBgDQogICAgICAgICAgICAtSGVhZGVycyBAeyAiQXV0aG9yaXphdGlvbiIgPSAiQmVhcmVyICRQVUxTRV9VU0VSX1RPS0VOIiB9IGANCiAgICAgICAgICAgIC1Cb2R5ICRib2R5DQogICAgICAgIFdyaXRlLUxvZyAiUHVsc2UgcmVnaXN0cmF0aW9uOiAkKCRyZXNwLm1lc3NhZ2UpIiAiT0siDQogICAgICAgIFNldC1TdGVwICJQdWxzZSByZWdpc3RyYXRpb24iICJQQVNTIg0KICAgIH0gY2F0Y2ggew0KICAgICAgICBXcml0ZS1Mb2cgIlB1bHNlIHJlZ2lzdHJhdGlvbiBmYWlsZWQgKHdpbGwgcmV0cnkgb24gbmV4dCBzdGFydCk6ICRfIiAiV0FSTiINCiAgICAgICAgU2V0LVN0ZXAgIlB1bHNlIHJlZ2lzdHJhdGlvbiIgIldBUk4iICJXaWxsIHJldHJ5IGF1dG9tYXRpY2FsbHkgb24gbmV4dCBsb2dpbiINCiAgICB9DQoNCiAgICAjIOKUgOKUgCBHUFUgV2F0Y2hkb2c6IHBhdXNlIG9zbiBkdXJpbmcgZ2FtaW5nIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KICAgIFdyaXRlLUxvZyAiSW5zdGFsbGluZyBHUFUgZ2FtaW5nIHdhdGNoZG9nLi4uIg0KICAgICR3YXRjaGRvZyA9IEAnDQokaGkgPSA3NTsgJGxvID0gMjA7ICRwYXVzZWQgPSAkZmFsc2UNCiR2ZW5kb3IgPSBpZiAoR2V0LVdtaU9iamVjdCBXaW4zMl9WaWRlb0NvbnRyb2xsZXIgfCBXaGVyZS1PYmplY3QgeyAkXy5OYW1lIC1tYXRjaCAnTlZJRElBfEdlRm9yY2V8UlRYfEdUWCcgfSB8IFNlbGVjdC1PYmplY3QgLUZpcnN0IDEpIHsgJ05WSURJQScgfSBlbHNlIHsgJ0FNRCcgfQ0KJHdkTG9nID0gIiRlbnY6TE9DQUxBUFBEQVRBXFB1bHNlXG9jdGFfd2F0Y2hkb2cubG9nIg0KJGtlZXBhbGl2ZVBpZCA9ICRudWxsDQoNCmZ1bmN0aW9uIEVuc3VyZS1XU0xBbGl2ZSB7DQogICAgaWYgKCRudWxsIC1lcSAka2VlcGFsaXZlUGlkIC1vciAtbm90IChHZXQtUHJvY2VzcyAtSWQgJGtlZXBhbGl2ZVBpZCAtRXJyb3JBY3Rpb24gU2lsZW50bHlDb250aW51ZSkpIHsNCiAgICAgICAgJHAgPSBTdGFydC1Qcm9jZXNzICJ3c2wuZXhlIiAtQXJndW1lbnRMaXN0ICItZCBVYnVudHUtMjIuMDQgLS11c2VyIHJvb3QgLS0gc2xlZXAgMzYwMCIgLVBhc3NUaHJ1IC1XaW5kb3dTdHlsZSBIaWRkZW4gLUVycm9yQWN0aW9uIFNpbGVudGx5Q29udGludWUNCiAgICAgICAgaWYgKCRwKSB7DQogICAgICAgICAgICAkc2NyaXB0OmtlZXBhbGl2ZVBpZCA9ICRwLklkDQogICAgICAgICAgICBBZGQtQ29udGVudCAkd2RMb2cgIiQoR2V0LURhdGUgLWYgJ0hIOm1tJykgV1NMIGtlZXBhbGl2ZSBzdGFydGVkIChQSUQgJCgkcC5JZCkpIg0KICAgICAgICB9DQogICAgfQ0KfQ0KDQpFbnN1cmUtV1NMQWxpdmUNCg0Kd2hpbGUgKCR0cnVlKSB7DQogICAgdHJ5IHsNCiAgICAgICAgRW5zdXJlLVdTTEFsaXZlDQogICAgICAgICR1dGlsID0gaWYgKCR2ZW5kb3IgLWVxICdOVklESUEnKSB7DQogICAgICAgICAgICBbaW50XSgmIG52aWRpYS1zbWkgLS1xdWVyeS1ncHU9dXRpbGl6YXRpb24uZ3B1IC0tZm9ybWF0PWNzdixub2hlYWRlcixub3VuaXRzIDI+JG51bGwpLlRyaW0oKQ0KICAgICAgICB9IGVsc2Ugew0KICAgICAgICAgICAgJHMgPSBHZXQtQ291bnRlciAnXEdQVSBFbmdpbmUoKmVuZ3R5cGVfM0QpXFV0aWxpemF0aW9uIFBlcmNlbnRhZ2UnIC1FcnJvckFjdGlvbiBTaWxlbnRseUNvbnRpbnVlDQogICAgICAgICAgICBpZiAoJHMpIHsgW2ludF0oJHMuQ291bnRlclNhbXBsZXMgfCBNZWFzdXJlLU9iamVjdCAtUHJvcGVydHkgQ29va2VkVmFsdWUgLU1heGltdW0pLk1heGltdW0gfSBlbHNlIHsgMCB9DQogICAgICAgIH0NCiAgICAgICAgaWYgKCR1dGlsIC1ndCAkaGkgLWFuZCAtbm90ICRwYXVzZWQpIHsNCiAgICAgICAgICAgIHdzbCAtZCBVYnVudHUtMjIuMDQgLS0gYmFzaCAtYyAic3VkbyBzeXN0ZW1jdGwgc3RvcCBvc24gMj4vZGV2L251bGwiDQogICAgICAgICAgICAkcGF1c2VkID0gJHRydWUNCiAgICAgICAgICAgIEFkZC1Db250ZW50ICR3ZExvZyAiJChHZXQtRGF0ZSAtZiAnSEg6bW0nKSBQQVVTRUQgKEdQVSAkdXRpbCUpIg0KICAgICAgICB9IGVsc2VpZiAoJHV0aWwgLWx0ICRsbyAtYW5kICRwYXVzZWQpIHsNCiAgICAgICAgICAgIHdzbCAtZCBVYnVudHUtMjIuMDQgLS0gYmFzaCAtYyAic3VkbyBzeXN0ZW1jdGwgc3RhcnQgb3NuIDI+L2Rldi9udWxsIg0KICAgICAgICAgICAgJHBhdXNlZCA9ICRmYWxzZQ0KICAgICAgICAgICAgQWRkLUNvbnRlbnQgJHdkTG9nICIkKEdldC1EYXRlIC1mICdISDptbScpIFJFU1VNRUQgKEdQVSAkdXRpbCUpIg0KICAgICAgICB9DQogICAgfSBjYXRjaCB7fQ0KICAgIFN0YXJ0LVNsZWVwIDMwDQp9DQonQA0KICAgICR3YXRjaGRvZ1BhdGggPSAiJFBVTFNFX0RJUlxvY3RhX3dhdGNoZG9nLnBzMSINCiAgICBTZXQtQ29udGVudCAtUGF0aCAkd2F0Y2hkb2dQYXRoIC1WYWx1ZSAkd2F0Y2hkb2cgLUVuY29kaW5nIFVURjgNCg0KICAgICR3QSA9IE5ldy1TY2hlZHVsZWRUYXNrQWN0aW9uIC1FeGVjdXRlICJwb3dlcnNoZWxsLmV4ZSIgYA0KICAgICAgICAtQXJndW1lbnQgIi1Ob1Byb2ZpbGUgLUV4ZWN1dGlvblBvbGljeSBCeXBhc3MgLVdpbmRvd1N0eWxlIEhpZGRlbiAtRmlsZSBgIiR3YXRjaGRvZ1BhdGhgIiINCiAgICAkd1QgPSBOZXctU2NoZWR1bGVkVGFza1RyaWdnZXIgLUF0TG9nT24NCiAgICAkd1MgPSBOZXctU2NoZWR1bGVkVGFza1NldHRpbmdzU2V0IC1BbGxvd1N0YXJ0SWZPbkJhdHRlcmllcyAtRXhlY3V0aW9uVGltZUxpbWl0IDANCiAgICAkd1AgPSBOZXctU2NoZWR1bGVkVGFza1ByaW5jaXBhbCAtVXNlcklkICRlbnY6VVNFUk5BTUUgLVJ1bkxldmVsIEhpZ2hlc3QNCiAgICBSZWdpc3Rlci1TY2hlZHVsZWRUYXNrIC1UYXNrTmFtZSAkV0FUQ0hET0dfVEFTSyAtQWN0aW9uICR3QSAtVHJpZ2dlciAkd1QgYA0KICAgICAgICAtU2V0dGluZ3MgJHdTIC1QcmluY2lwYWwgJHdQIC1Gb3JjZSB8IE91dC1OdWxsDQogICAgV3JpdGUtTG9nICJHUFUgd2F0Y2hkb2cgaW5zdGFsbGVkIChwYXVzZXMgZHVyaW5nIGdhbWluZywgcmVzdW1lcyB3aGVuIGlkbGUpIiAiT0siDQogICAgU2V0LVN0ZXAgIkdQVSB3YXRjaGRvZyB0YXNrIiAiUEFTUyINCg0KICAgICMg4pSA4pSAIEF1dG8tc3RhcnQ6IG9zbiBvbiBldmVyeSBsb2dpbiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANCiAgICBXcml0ZS1Mb2cgIkluc3RhbGxpbmcgYXV0by1zdGFydCB0YXNrLi4uIg0KICAgICRhdXRvc3RhcnQgPSBpZiAoJG1pcnJvcmVkTmV0d29ya2luZykgew0KICAgICAgICBAJw0KU3RhcnQtU2xlZXAgMTUNCndzbCAtZCBVYnVudHUtMjIuMDQgLS0gYmFzaCAtYyAnc3VkbyBzeXN0ZW1jdGwgc3RhcnQgb3NuIDI+L2Rldi9udWxsJyAyPiYxIHwNCiAgICBBZGQtQ29udGVudCAiJGVudjpMT0NBTEFQUERBVEFcUHVsc2Vcb2N0YV9hdXRvc3RhcnQubG9nIg0KJ0ANCiAgICB9IGVsc2Ugew0KICAgICAgICBAIg0KU3RhcnQtU2xlZXAgMTUNCmAkd3NsSVAgPSAod3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICdob3N0bmFtZSAtSSAyPi9kZXYvbnVsbCcpLlRyaW0oKS5TcGxpdCgpWzBdDQpgJGxhc3RJUEZpbGUgPSAiYCRlbnY6TE9DQUxBUFBEQVRBXFB1bHNlXGxhc3Rfd3NsX2lwIg0KYCRsYXN0SVAgPSBpZiAoVGVzdC1QYXRoIGAkbGFzdElQRmlsZSkgeyAoR2V0LUNvbnRlbnQgYCRsYXN0SVBGaWxlKS5UcmltKCkgfSBlbHNlIHsgJycgfQ0KaWYgKGAkd3NsSVAgLWFuZCBgJHdzbElQIC1uZSBgJGxhc3RJUCkgew0KICAgIChAKDE4ODg4KSArICg1MTgwMC4uNTE4MTYpKSB8IEZvckVhY2gtT2JqZWN0IHsNCiAgICAgICAgbmV0c2ggaW50ZXJmYWNlIHBvcnRwcm94eSBkZWxldGUgdjR0b3Y0IGxpc3RlbnBvcnQ9YCRfIGxpc3RlbmFkZHJlc3M9MC4wLjAuMCB8IE91dC1OdWxsDQogICAgICAgIG5ldHNoIGludGVyZmFjZSBwb3J0cHJveHkgYWRkIHY0dG92NCBsaXN0ZW5wb3J0PWAkXyBsaXN0ZW5hZGRyZXNzPTAuMC4wLjAgY29ubmVjdHBvcnQ9YCRfIGNvbm5lY3RhZGRyZXNzPWAkd3NsSVAgfCBPdXQtTnVsbA0KICAgIH0NCiAgICBTZXQtQ29udGVudCAtUGF0aCBgJGxhc3RJUEZpbGUgLVZhbHVlIGAkd3NsSVANCn0NCndzbCAtZCBVYnVudHUtMjIuMDQgLS0gYmFzaCAtYyAnc3VkbyBzeXN0ZW1jdGwgc3RhcnQgb3NuIDI+L2Rldi9udWxsJyAyPiYxIHwNCiAgICBBZGQtQ29udGVudCAiYCRlbnY6TE9DQUxBUFBEQVRBXFB1bHNlXG9jdGFfYXV0b3N0YXJ0LmxvZyINCiJADQogICAgfQ0KICAgICRzdGFydFBhdGggPSAiJFBVTFNFX0RJUlxvY3RhX2F1dG9zdGFydC5wczEiDQogICAgU2V0LUNvbnRlbnQgLVBhdGggJHN0YXJ0UGF0aCAtVmFsdWUgJGF1dG9zdGFydCAtRW5jb2RpbmcgVVRGOA0KDQogICAgJHNBID0gTmV3LVNjaGVkdWxlZFRhc2tBY3Rpb24gLUV4ZWN1dGUgInBvd2Vyc2hlbGwuZXhlIiBgDQogICAgICAgIC1Bcmd1bWVudCAiLU5vUHJvZmlsZSAtRXhlY3V0aW9uUG9saWN5IEJ5cGFzcyAtV2luZG93U3R5bGUgSGlkZGVuIC1GaWxlIGAiJHN0YXJ0UGF0aGAiIg0KICAgICRzVCA9IE5ldy1TY2hlZHVsZWRUYXNrVHJpZ2dlciAtQXRMb2dPbg0KICAgICRzUyA9IE5ldy1TY2hlZHVsZWRUYXNrU2V0dGluZ3NTZXQgLUFsbG93U3RhcnRJZk9uQmF0dGVyaWVzIC1FeGVjdXRpb25UaW1lTGltaXQgMA0KICAgICRzUCA9IE5ldy1TY2hlZHVsZWRUYXNrUHJpbmNpcGFsIC1Vc2VySWQgJGVudjpVU0VSTkFNRSAtUnVuTGV2ZWwgSGlnaGVzdA0KICAgIFJlZ2lzdGVyLVNjaGVkdWxlZFRhc2sgLVRhc2tOYW1lICRBVVRPU1RBUlRfVEFTSyAtQWN0aW9uICRzQSAtVHJpZ2dlciAkc1QgYA0KICAgICAgICAtU2V0dGluZ3MgJHNTIC1QcmluY2lwYWwgJHNQIC1Gb3JjZSB8IE91dC1OdWxsDQogICAgV3JpdGUtTG9nICJBdXRvLXN0YXJ0IGluc3RhbGxlZCIgIk9LIg0KICAgIFNldC1TdGVwICJBdXRvLXN0YXJ0IHRhc2siICJQQVNTIg0KDQogICAgIyDilIDilIAgQXV0by1sb2dpbjogc3Vydml2ZSB1bmF0dGVuZGVkIHJlYm9vdHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSADQogICAgV3JpdGUtSG9zdCAiIg0KICAgIFdyaXRlLUhvc3QgIiAg4pSM4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSQIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdw0KICAgIFdyaXRlLUhvc3QgIiAg4pSCICBBVVRPLUxPR0lOIChyZWNvbW1lbmRlZCBmb3IgZGVkaWNhdGVkIEdQVSBzZXJ2ZXJzKSAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93DQogICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cNCiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgV2l0aG91dCB0aGlzLCBPY3RhU3BhY2UgZ29lcyBPRkZMSU5FIGFmdGVyIGFueSB1bmF0dGVuZGVkICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93DQogICAgV3JpdGUtSG9zdCAiICDilIIgIHJlYm9vdCAocG93ZXIgY3V0LCBXaW5kb3dzIFVwZGF0ZSkgdW50aWwgc29tZW9uZSBsb2dzIGluLiAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdw0KICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93DQogICAgV3JpdGUtSG9zdCAiICDilIIgIFRyYWRlLW9mZjogc3RvcmVzIHlvdXIgV2luZG93cyBwYXNzd29yZCBpbiB0aGUgcmVnaXN0cnkuICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdw0KICAgIFdyaXRlLUhvc3QgIiAg4pSCICBPbmx5IGVuYWJsZSBpZiB0aGlzIG1hY2hpbmUgaXMgaW4gYSBwaHlzaWNhbGx5IHNlY3VyZSBzcG90LuKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cNCiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgVG8gdW5kbyBsYXRlcjogcnVuIG5ldHBsd2l6IGFuZCByZS1lbmFibGUgcGFzc3dvcmQgcHJvbXB0LiDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93DQogICAgV3JpdGUtSG9zdCAiICDilJTilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilJgiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93DQogICAgV3JpdGUtSG9zdCAiIg0KICAgICRkb0F1dG9Mb2dpbiA9IFJlYWQtSG9zdCAiICBFbmFibGUgYXV0by1sb2dpbj8gKHkvTikiDQogICAgaWYgKCRkb0F1dG9Mb2dpbiAtbWF0Y2ggJ15bWXldJykgew0KICAgICAgICAkc2VjdXJlUGFzcyA9IFJlYWQtSG9zdCAiICBFbnRlciB5b3VyIFdpbmRvd3MgbG9naW4gcGFzc3dvcmQiIC1Bc1NlY3VyZVN0cmluZw0KICAgICAgICAkYnN0ciAgICAgID0gW1J1bnRpbWUuSW50ZXJvcFNlcnZpY2VzLk1hcnNoYWxdOjpTZWN1cmVTdHJpbmdUb0JTVFIoJHNlY3VyZVBhc3MpDQogICAgICAgICRwbGFpblBhc3MgPSBbUnVudGltZS5JbnRlcm9wU2VydmljZXMuTWFyc2hhbF06OlB0clRvU3RyaW5nQXV0bygkYnN0cikNCiAgICAgICAgW1J1bnRpbWUuSW50ZXJvcFNlcnZpY2VzLk1hcnNoYWxdOjpaZXJvRnJlZUJTVFIoJGJzdHIpDQoNCiAgICAgICAgJHJlZ1BhdGggPSAiSEtMTTpcU09GVFdBUkVcTWljcm9zb2Z0XFdpbmRvd3MgTlRcQ3VycmVudFZlcnNpb25cV2lubG9nb24iDQogICAgICAgIFNldC1JdGVtUHJvcGVydHkgLVBhdGggJHJlZ1BhdGggLU5hbWUgIkF1dG9BZG1pbkxvZ29uIiAgIC1WYWx1ZSAiMSIgICAgICAgICAgICAgLVR5cGUgU3RyaW5nDQogICAgICAgIFNldC1JdGVtUHJvcGVydHkgLVBhdGggJHJlZ1BhdGggLU5hbWUgIkRlZmF1bHRVc2VybmFtZSIgICAtVmFsdWUgJGVudjpVU0VSTkFNRSAgIC1UeXBlIFN0cmluZw0KICAgICAgICBTZXQtSXRlbVByb3BlcnR5IC1QYXRoICRyZWdQYXRoIC1OYW1lICJEZWZhdWx0RG9tYWluTmFtZSIgLVZhbHVlICRlbnY6VVNFUkRPTUFJTiAtVHlwZSBTdHJpbmcNCiAgICAgICAgU2V0LUl0ZW1Qcm9wZXJ0eSAtUGF0aCAkcmVnUGF0aCAtTmFtZSAiRGVmYXVsdFBhc3N3b3JkIiAgIC1WYWx1ZSAkcGxhaW5QYXNzICAgICAgLVR5cGUgU3RyaW5nDQogICAgICAgICRwbGFpblBhc3MgPSAkbnVsbDsgW1N5c3RlbS5HQ106OkNvbGxlY3QoKQ0KDQogICAgICAgIFdyaXRlLUxvZyAiQXV0by1sb2dpbiBlbmFibGVkIGZvciAkZW52OlVTRVJOQU1FIOKAlCBPY3RhU3BhY2UgcmVzdW1lcyBhdXRvbWF0aWNhbGx5IGFmdGVyIGFueSByZWJvb3QiICJPSyINCiAgICAgICAgV3JpdGUtTG9nICJUbyBkaXNhYmxlOiBydW4gbmV0cGx3aXogYW5kIHJlLWNoZWNrICdVc2VycyBtdXN0IGVudGVyIGEgdXNlcm5hbWUgYW5kIHBhc3N3b3JkJyIgIklORk8iDQogICAgICAgIFNldC1TdGVwICJBdXRvLWxvZ2luIiAiUEFTUyIgIkVuYWJsZWQgZm9yICRlbnY6VVNFUk5BTUUiDQogICAgfSBlbHNlIHsNCiAgICAgICAgV3JpdGUtTG9nICJBdXRvLWxvZ2luIHNraXBwZWQg4oCUIG1hY2hpbmUgd2lsbCBuZWVkIGEgbWFudWFsIGxvZ2luIGFmdGVyIHJlYm9vdCB0byByZXN1bWUgT2N0YVNwYWNlIiAiV0FSTiINCiAgICAgICAgU2V0LVN0ZXAgIkF1dG8tbG9naW4iICJTS0lQIiAiU2tpcHBlZCDigJQgR1BVIGdvZXMgb2ZmbGluZSBhZnRlciB1bmF0dGVuZGVkIHJlYm9vdHMiDQogICAgfQ0KDQogICAgIyDilIDilIAgQ2xlYW51cCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANCiAgICBzY2h0YXNrcyAvZGVsZXRlIC90biAkVEFTS19OQU1FIC9mIDI+JG51bGwgfCBPdXQtTnVsbA0KICAgIFJlbW92ZS1JdGVtICRQSEFTRV9GSUxFIC1FcnJvckFjdGlvbiBTaWxlbnRseUNvbnRpbnVlDQoNCiAgICAjIOKUgOKUgCBTdW1tYXJ5IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KICAgICMgV3JpdGUgZmluYWwgZGlhZ25vc3RpY3Mgc25hcHNob3QgdG8gbG9nIChzY3JlZW4gb3V0cHV0IGlzIHRoZSBjbGVhbiBzdW1tYXJ5IGJlbG93KQ0KICAgIFNob3ctRGlhZ25vc3RpY3MgLUxvZ09ubHkNCg0KICAgIFNob3ctQmFubmVyICJTZXR1cCBDb21wbGV0ZSINCiAgICBXcml0ZS1Ib3N0ICIgIFlvdXIgR1BVIGlzIG5vdyBlYXJuaW5nIHZpYSBQdWxzZSArIE9jdGFTcGFjZS4iIC1Gb3JlZ3JvdW5kQ29sb3IgR3JlZW4NCiAgICBXcml0ZS1Ib3N0ICIiDQogICAgQCgNCiAgICAgICAgQHsgTCA9ICJHUFUiOyAgICAgICAgICBWID0gJGdwdU5hbWUgfSwNCiAgICAgICAgQHsgTCA9ICJWUkFNIjsgICAgICAgICBWID0gIiR7dnJhbUdifSBHQiIgfSwNCiAgICAgICAgQHsgTCA9ICJQbGF0Zm9ybSI7ICAgICBWID0gIk9jdGFTcGFjZSAodmlhIFB1bHNlKSIgfSwNCiAgICAgICAgQHsgTCA9ICJOb2RlIHRva2VuIjsgICBWID0gaWYgKCRvY3RhTm9kZVRva2VuKSB7ICRvY3RhTm9kZVRva2VuIH0gZWxzZSB7ICJQZW5kaW5nIOKAlCBjaGVjayBjdWJlLm9jdGEuY29tcHV0ZXIiIH0gfSwNCiAgICAgICAgQHsgTCA9ICJHYW1pbmcgcGF1c2UiOyBWID0gIkF1dG8gKEdQVSA+IDc1JSB1dGlsKSIgfSwNCiAgICAgICAgQHsgTCA9ICJBdXRvLXN0YXJ0IjsgICBWID0gIk9uIGV2ZXJ5IFdpbmRvd3MgbG9naW4iIH0sDQogICAgICAgIEB7IEwgPSAiTG9ncyI7ICAgICAgICAgViA9ICRMT0dfRklMRSB9DQogICAgKSB8IEZvckVhY2gtT2JqZWN0IHsgV3JpdGUtSG9zdCAoIiAgezAsLTE2fSB7MX0iIC1mICRfLkwsICRfLlYpIC1Gb3JlZ3JvdW5kQ29sb3IgV2hpdGUgfQ0KICAgIFdyaXRlLUhvc3QgIiINCiAgICBXcml0ZS1Ib3N0ICIgIERhc2hib2FyZDogIGh0dHBzOi8vYmVuZWZpY2lhbC1kZWVwLXdvcmstZmxvdy5iYXNlNDQuYXBwIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4NCiAgICBXcml0ZS1Ib3N0ICIgIEN1YmU6ICAgICAgIGh0dHBzOi8vY3ViZS5vY3RhLmNvbXB1dGVyIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4NCiAgICBXcml0ZS1Ib3N0ICIiDQogICAgV3JpdGUtSG9zdCAiICDilIzilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilJAiIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkNCiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgSU5TVEFMTCBMT0cgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5DQogICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBEYXJrR3JheQ0KICAgIFdyaXRlLUhvc3QgIiAg4pSCICBBIGZ1bGwgbG9nIG9mIGV2ZXJ5IGluc3RhbGwgc3RlcCB3YXMgc2F2ZWQgdG86ICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkNCiAgICBXcml0ZS1Ib3N0ICgiICDilIIgICAgezAsLTYwfeKUgiIgLWYgJExPR19GSUxFKSAtRm9yZWdyb3VuZENvbG9yIFdoaXRlDQogICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBEYXJrR3JheQ0KICAgIFdyaXRlLUhvc3QgIiAg4pSCICBUbyBvcGVuIGl0OiAgIG5vdGVwYWQgYCIkTE9HX0ZJTEVgIiIgLUZvcmVncm91bmRDb2xvciBEYXJrR3JheQ0KICAgIFdyaXRlLUhvc3QgIiAg4pSCICBUbyBicm93c2U6ICAgIFJ1biDihpIgJUxPQ0FMQVBQREFUQSVcUHVsc2UgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBEYXJrR3JheQ0KICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkNCiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgU2hhcmUgaXQgd2l0aCBQdWxzZSBzdXBwb3J0IGlmIGFueXRoaW5nIGxvb2tzIHdyb25nLiAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5DQogICAgV3JpdGUtSG9zdCAiICDilJTilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilJgiIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkNCiAgICBXcml0ZS1Ib3N0ICIiDQogICAgV2FpdC1Gb3JLZXkNCn0NCg0KIyDilIDilIAgRW50cnkgUG9pbnQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSADQoNCnRyYXAgew0KICAgIFdyaXRlLUhvc3QgIiINCiAgICBXcml0ZS1Ib3N0ICIgIFtFUlJPUl0gQW4gdW5leHBlY3RlZCBlcnJvciBzdG9wcGVkIHRoZSBpbnN0YWxsZXI6IiAtRm9yZWdyb3VuZENvbG9yIFJlZA0KICAgIFdyaXRlLUhvc3QgIiAgJF8iIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkDQogICAgU2hvdy1EaWFnbm9zdGljcw0KICAgIFJlYWQtSG9zdCAiICBQcmVzcyBFbnRlciB0byBjbG9zZSB0aGlzIHdpbmRvdyINCiAgICBleGl0IDENCn0NCg0KQXNzZXJ0LUFkbWluDQpOZXctSXRlbSAtSXRlbVR5cGUgRGlyZWN0b3J5IC1Gb3JjZSAtUGF0aCAkUFVMU0VfRElSIHwgT3V0LU51bGwNCg0KJHBoYXNlID0gaWYgKFRlc3QtUGF0aCAkUEhBU0VfRklMRSkgeyBHZXQtQ29udGVudCAkUEhBU0VfRklMRSB9IGVsc2UgeyAiMSIgfQ0Kc3dpdGNoICgkcGhhc2UpIHsNCiAgICAiMSIgICAgIHsgSW52b2tlLVBoYXNlMSB9DQogICAgIjIiICAgICB7IEludm9rZS1QaGFzZTIgfQ0KICAgIGRlZmF1bHQgeyBXcml0ZS1Ib3N0ICJVbmtub3duIHBoYXNlOiAkcGhhc2UiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkOyBXYWl0LUZvcktleTsgZXhpdCAxIH0NCn0NCg==';
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