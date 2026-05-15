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
        if ($wslConfigContent -notmatch 'networkingMode') {
            if ($wslConfigContent -match '\[wsl2\]') {
                $wslConfigContent = $wslConfigContent -replace '(\[wsl2\])', "\`$1\`nnetworkingMode=mirrored"
            } else {
                $wslConfigContent += "\`n[wsl2]\`nnetworkingMode=mirrored\`n"
            }
            Set-Content -Path $wslConfigPath -Value $wslConfigContent -Encoding UTF8
        }
        $mirroredNetworking = $true
        Write-Log "WSL2 mirrored networking configured" "OK"
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
rm -f /usr/local/bin/nvidia-smi; NV=/usr/lib/wsl/lib/nvidia-smi; [ ! -f "$NV" ] && NV=$(find /usr/lib/wsl -name nvidia-smi 2>/dev/null | head -1); [ -f "$NV" ] && ln -sf "$NV" /usr/local/bin/nvidia-smi && echo 'nvidia-smi symlinked OK' || echo 'WARNING: nvidia-smi not found'; pip3 install -q requests 2>&1 | tail -1; mkdir -p /opt/clore-onboarding; curl -fsSL 'https://gitlab.com/api/v4/projects/cloreai-public%2Fonboarding/repository/files/clore_onboarding.py/raw?ref=main' -o /opt/clore-onboarding/clore_onboarding.py || { echo 'ERROR: clore_onboarding.py download failed'; exit 1; }; curl -fsSL 'https://gitlab.com/api/v4/projects/cloreai-public%2Fonboarding/repository/files/specs.py/raw?ref=main' -o /opt/clore-onboarding/specs.py || { echo 'ERROR: specs.py download failed'; exit 1; }; printf '[Unit]\nDescription=Clore Fleet Onboarding Service\n\n[Service]\nType=simple\nWorkingDirectory=/opt/clore-onboarding\nExecStart=/usr/bin/python3 /opt/clore-onboarding/clore_onboarding.py --mode linux\nRestart=always\nRestartSec=10\n\n[Install]\nWantedBy=multi-user.target\n' > /etc/systemd/system/clore-onboarding.service; update-alternatives --set iptables /usr/sbin/iptables-legacy 2>/dev/null || true; update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy 2>/dev/null || true; mkdir -p /etc/docker; echo eyJpcHRhYmxlcyI6ZmFsc2UsImRlZmF1bHQtcnVudGltZSI6Im52aWRpYSIsInJ1bnRpbWVzIjp7Im52aWRpYSI6eyJwYXRoIjoibnZpZGlhLWNvbnRhaW5lci1ydW50aW1lIiwicnVudGltZUFyZ3MiOltdfX19 | base64 -d > /etc/docker/daemon.json; echo br_netfilter > /etc/modules-load.d/clore.conf; modprobe br_netfilter 2>/dev/null || true; systemctl restart docker 2>/dev/null || true; docker network prune -f 2>/dev/null; true; printf '#!/bin/bash\ncd /opt/clore-hosting/hosting\nwhile true; do\n    setsid -w /opt/clore-hosting/.miniconda-env/bin/python3 hosting.py --service\n    echo "hosting.py restarting in 5s..."\n    sleep 5\ndone\n' > /opt/clore-hosting/pulse-hosting-loop.sh; chmod +x /opt/clore-hosting/pulse-hosting-loop.sh; mkdir -p /etc/systemd/system/clore-hosting.service.d; printf '[Unit]\nAfter=docker.service\n\n[Service]\nEnvironment="PYTHONUNBUFFERED=1"\nEnvironment="PATH=/opt/clore-hosting/.miniconda-env/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"\nExecStartPre=/usr/bin/docker container prune -f\nExecStartPre=/usr/bin/docker network prune -f\nExecStartPre=/bin/bash -c "for br in $(ip -br link show type bridge 2>/dev/null | grep -oE ^br-[^ ]+); do ip link set dev $br down 2>/dev/null; ip link delete $br 2>/dev/null; done; true"\nExecStartPre=/bin/rm -f /opt/clore-hosting/.clore-partner/host_facts/partner_interface.socket\nExecStart=\nExecStart=/opt/clore-hosting/pulse-hosting-loop.sh\n' > /etc/systemd/system/clore-hosting.service.d/override.conf; systemctl daemon-reload; systemctl enable clore-hosting; systemctl enable clore-onboarding; echo 'Starting clore-onboarding...'; systemctl start clore-onboarding; echo 'Waiting 75s for onboarding to register...'; sleep 75; echo 'Starting clore-hosting...'; systemctl start clore-hosting || true; echo 'Disabling clore-onboarding - registration complete'; systemctl stop clore-onboarding; systemctl disable clore-onboarding; echo 'clore-onboarding disabled'
'@
    $setupB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($setupOnboarding))
    wsl -d Ubuntu-22.04 --user root -- bash -c "echo '$setupB64' | base64 -d | bash"
    Write-Log "Clore fleet onboarding service started" "OK"

    Write-Log "Waiting for Clore.ai services to start (up to 3 min)..."
    for ($i = 1; $i -le 18; $i++) {
        $svcOk = (wsl -d Ubuntu-22.04 --user root -- bash -c "systemctl is-active clore-hosting 2>/dev/null && systemctl is-active clore-onboarding 2>/dev/null && echo both_ok" 2>&1 | Out-String) -match "both_ok"
        if ($svcOk) { Write-Log "Clore.ai services running" "OK"; break }
        if ($i % 3 -eq 0) {
            $stat = wsl -d Ubuntu-22.04 --user root -- bash -c "systemctl is-active clore-hosting 2>&1; systemctl is-active clore-onboarding 2>&1" 2>&1
            Write-Log "  Service status: $($stat -join ' / ')"
        }
        Write-Log "  Waiting for services... ($($i * 10)s)"
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
const OCTA_PS1_B64 = 'I1JlcXVpcmVzIC1WZXJzaW9uIDUuMQ0KPCMNCi5TWU5PUFNJUw0KICAgIFBVTFNFIEdQVSBQcm92aWRlciBTZXR1cCDigJQgT2N0YVNwYWNlIEluc3RhbGxlcg0KLkRFU0NSSVBUSU9ODQogICAgUGhhc2UgMTogRW5hYmxlcyBXU0wyLCBzY2hlZHVsZXMgUGhhc2UgMiB0byBydW4gYWZ0ZXIgcmVib290Lg0KICAgIFBoYXNlIDI6IEluc3RhbGxzIFVidW50dSwgT2N0YVNwYWNlIG5vZGUgKG9zbiksIHNldHMgdXAgbmV0d29ya2luZw0KICAgICAgICAgICAgIChVUG5QICsgcG9ydHByb3h5IGZvciBUQ1AsIG1pcnJvcmVkIG5ldHdvcmtpbmcgcmVjb21tZW5kZWQgZm9yIFVEUCksDQogICAgICAgICAgICAgR1BVIGdhbWluZyBkZXRlY3Rpb24sIGFuZCBhdXRvLXN0YXJ0Lg0KDQogICAgRW1iZWRkZWQgYXQgZG93bmxvYWQgdGltZSBieSBQdWxzZSdzIGdlbmVyYXRlU2V0dXBTY3JpcHQgZnVuY3Rpb246DQogICAgICBQVUxTRV9VU0VSX1RPS0VOIOKAlCB1c2VyJ3Mgc2Vzc2lvbiB0b2tlbiBmb3IgUHVsc2UgQVBJIGNhbGxiYWNrDQogICAgICBQVUxTRV9BUFBfSUQgICAgIOKAlCBiYXNlNDQgYXBwIElEDQojPg0KDQojIOKUgOKUgCBFbWJlZGRlZCBieSBzZXJ2ZXIgYXQgZG93bmxvYWQgdGltZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANCiRQVUxTRV9VU0VSX1RPS0VOID0gInt7UFVMU0VfVVNFUl9UT0tFTn19Ig0KJFBVTFNFX0FQUF9JRCAgICAgPSAie3tQVUxTRV9BUFBfSUR9fSINCiRQVUxTRV9BUElfQkFTRSAgID0gImh0dHBzOi8vYXBpLmJhc2U0NC5hcHAvYXBpL2FwcHMvJFBVTFNFX0FQUF9JRC9mdW5jdGlvbnMiDQojIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KDQokUFVMU0VfRElSICAgICAgPSAiJGVudjpMT0NBTEFQUERBVEFcUHVsc2UiDQokUEhBU0VfRklMRSAgICAgPSAiJFBVTFNFX0RJUlxvY3RhX3NldHVwX3BoYXNlIg0KJExPR19GSUxFICAgICAgID0gIiRQVUxTRV9ESVJcb2N0YV9zZXR1cC5sb2ciDQokVEFTS19OQU1FICAgICAgPSAiUHVsc2VPY3RhU2V0dXBSZXN1bWUiDQokV0FUQ0hET0dfVEFTSyAgPSAiUHVsc2VPY3RhV2F0Y2hkb2ciDQokQVVUT1NUQVJUX1RBU0sgPSAiUHVsc2VPY3RhQXV0b1N0YXJ0Ig0KDQojIE9jdGFTcGFjZSBwb3J0cyDigJQgbWFuYWdlbWVudCAoQVBJKSBhbmQgZW5jcnlwdGVkIHR1bm5lbCByYW5nZSAoVENQK1VEUCkNCiRPQ1RBX01HTVRfUE9SVFMgICAgID0gQCgxODg4OCkNCiRPQ1RBX0FQUF9QT1JUX1NUQVJUID0gNTE4MDANCiRPQ1RBX0FQUF9QT1JUX0VORCAgID0gNTE4MTYNCg0KIyDilIDilIAgSGVscGVycyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANCg0KZnVuY3Rpb24gV3JpdGUtTG9nIHsNCiAgICBwYXJhbShbc3RyaW5nXSRtc2csIFtzdHJpbmddJGxldmVsID0gIklORk8iKQ0KICAgICR0cyA9IEdldC1EYXRlIC1Gb3JtYXQgIkhIOm1tOnNzIg0KICAgIEFkZC1Db250ZW50IC1QYXRoICRMT0dfRklMRSAtVmFsdWUgIlskdHNdWyRsZXZlbF0gJG1zZyIgLUVuY29kaW5nIFVURjgNCiAgICBzd2l0Y2ggKCRsZXZlbCkgew0KICAgICAgICAiT0siICAgIHsgV3JpdGUtSG9zdCAiICBbT0tdICRtc2ciIC1Gb3JlZ3JvdW5kQ29sb3IgR3JlZW4gfQ0KICAgICAgICAiV0FSTiIgIHsgV3JpdGUtSG9zdCAiICBbISFdICRtc2ciIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93IH0NCiAgICAgICAgIkVSUk9SIiB7IFdyaXRlLUhvc3QgIiAgW1hdICAkbXNnIiAtRm9yZWdyb3VuZENvbG9yIFJlZCB9DQogICAgICAgIGRlZmF1bHQgeyBXcml0ZS1Ib3N0ICIgIC4uLiAkbXNnIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4gfQ0KICAgIH0NCn0NCg0KZnVuY3Rpb24gU2hvdy1CYW5uZXIgew0KICAgIHBhcmFtKFtzdHJpbmddJHN1YnRpdGxlID0gIiIpDQogICAgQ2xlYXItSG9zdA0KICAgIFdyaXRlLUhvc3QgIiINCiAgICBXcml0ZS1Ib3N0ICIgIOKWiOKWiOKWiOKWiOKWiOKWiOKVlyDilojilojilZcgICDilojilojilZfilojilojilZcgICAgIOKWiOKWiOKWiOKWiOKWiOKWiOKWiOKVl+KWiOKWiOKWiOKWiOKWiOKWiOKWiOKVlyIgLUZvcmVncm91bmRDb2xvciBNYWdlbnRhDQogICAgV3JpdGUtSG9zdCAiICDilojilojilZTilZDilZDilojilojilZfilojilojilZEgICDilojilojilZHilojilojilZEgICAgIOKWiOKWiOKVlOKVkOKVkOKVkOKVkOKVneKWiOKWiOKVlOKVkOKVkOKVkOKVkOKVnSIgLUZvcmVncm91bmRDb2xvciBNYWdlbnRhDQogICAgV3JpdGUtSG9zdCAiICDilojilojilojilojilojilojilZTilZ3ilojilojilZEgICDilojilojilZHilojilojilZEgICAgIOKWiOKWiOKWiOKWiOKWiOKWiOKWiOKVl+KWiOKWiOKWiOKWiOKWiOKVlyAgIiAtRm9yZWdyb3VuZENvbG9yIE1hZ2VudGENCiAgICBXcml0ZS1Ib3N0ICIgIOKWiOKWiOKVlOKVkOKVkOKVkOKVnSDilojilojilZEgICDilojilojilZHilojilojilZEgICAgIOKVmuKVkOKVkOKVkOKVkOKWiOKWiOKVkeKWiOKWiOKVlOKVkOKVkOKVnSAgIiAtRm9yZWdyb3VuZENvbG9yIE1hZ2VudGENCiAgICBXcml0ZS1Ib3N0ICIgIOKWiOKWiOKVkSAgICAg4pWa4paI4paI4paI4paI4paI4paI4pWU4pWd4paI4paI4paI4paI4paI4paI4paI4pWX4paI4paI4paI4paI4paI4paI4paI4pWR4paI4paI4paI4paI4paI4paI4paI4pWXIiAtRm9yZWdyb3VuZENvbG9yIE1hZ2VudGENCiAgICBXcml0ZS1Ib3N0ICIgIOKVmuKVkOKVnSAgICAgIOKVmuKVkOKVkOKVkOKVkOKVkOKVnSDilZrilZDilZDilZDilZDilZDilZDilZ3ilZrilZDilZDilZDilZDilZDilZDilZ3ilZrilZDilZDilZDilZDilZDilZDilZ0iIC1Gb3JlZ3JvdW5kQ29sb3IgTWFnZW50YQ0KICAgIFdyaXRlLUhvc3QgIiINCiAgICBXcml0ZS1Ib3N0ICIgIEdQVSBQcm92aWRlciBTZXR1cCDigJQgT2N0YVNwYWNlIiAtRm9yZWdyb3VuZENvbG9yIFdoaXRlDQogICAgaWYgKCRzdWJ0aXRsZSkgeyBXcml0ZS1Ib3N0ICIgICRzdWJ0aXRsZSIgLUZvcmVncm91bmRDb2xvciBEYXJrR3JheSB9DQogICAgV3JpdGUtSG9zdCAiIg0KfQ0KDQpmdW5jdGlvbiBBc3NlcnQtQWRtaW4gew0KICAgIGlmICgtbm90IChbU2VjdXJpdHkuUHJpbmNpcGFsLldpbmRvd3NQcmluY2lwYWxdW1NlY3VyaXR5LlByaW5jaXBhbC5XaW5kb3dzSWRlbnRpdHldOjpHZXRDdXJyZW50KCkpLklzSW5Sb2xlKA0KICAgICAgICBbU2VjdXJpdHkuUHJpbmNpcGFsLldpbmRvd3NCdWlsdEluUm9sZV06OkFkbWluaXN0cmF0b3IpKSB7DQogICAgICAgIFdyaXRlLUhvc3QgIiAgUmVsYXVuY2hpbmcgYXMgQWRtaW5pc3RyYXRvci4uLiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cNCiAgICAgICAgU3RhcnQtUHJvY2VzcyBwb3dlcnNoZWxsICItTm9Qcm9maWxlIC1FeGVjdXRpb25Qb2xpY3kgQnlwYXNzIC1GaWxlIGAiJFBTQ29tbWFuZFBhdGhgIiIgLVZlcmIgUnVuQXMNCiAgICAgICAgZXhpdA0KICAgIH0NCn0NCg0KZnVuY3Rpb24gV2FpdC1Gb3JLZXkgew0KICAgIFdyaXRlLUhvc3QgIiINCiAgICBSZWFkLUhvc3QgIiAgUHJlc3MgRW50ZXIgdG8gY2xvc2UgdGhpcyB3aW5kb3ciDQp9DQoNCiMg4pSA4pSAIERpYWdub3N0aWNzIGNoZWNrbGlzdCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANCiRzY3JpcHQ6U3RlcHMgPSBbb3JkZXJlZF1Ae30NCg0KZnVuY3Rpb24gUmVnaXN0ZXItU3RlcCB7DQogICAgcGFyYW0oW3N0cmluZ10kbmFtZSwgW3N0cmluZ10kZml4ID0gIiIpDQogICAgJHNjcmlwdDpTdGVwc1skbmFtZV0gPSBAeyBTdGF0dXMgPSAiUEVORElORyI7IERldGFpbCA9ICIiOyBGaXggPSAkZml4IH0NCn0NCg0KZnVuY3Rpb24gU2V0LVN0ZXAgew0KICAgIHBhcmFtKFtzdHJpbmddJG5hbWUsIFtzdHJpbmddJHN0YXR1cywgW3N0cmluZ10kZGV0YWlsID0gIiIpDQogICAgaWYgKCRzY3JpcHQ6U3RlcHMuQ29udGFpbnMoJG5hbWUpKSB7DQogICAgICAgICRzY3JpcHQ6U3RlcHNbJG5hbWVdLlN0YXR1cyA9ICRzdGF0dXMNCiAgICAgICAgaWYgKCRkZXRhaWwpIHsgJHNjcmlwdDpTdGVwc1skbmFtZV0uRGV0YWlsID0gJGRldGFpbCB9DQogICAgfQ0KfQ0KDQpmdW5jdGlvbiBTaG93LURpYWdub3N0aWNzIHsNCiAgICBwYXJhbShbc3dpdGNoXSRMb2dPbmx5KQ0KICAgICRzZXAgICAgPSAiICAiICsgKCLilIAiICogNjUpDQogICAgJGxvZ1NlcCA9ICLilIAiICogNjcNCiAgICAkdHMgICAgID0gR2V0LURhdGUgLUZvcm1hdCAieXl5eS1NTS1kZCBISDptbTpzcyINCg0KICAgIGlmICgtbm90ICRMb2dPbmx5KSB7DQogICAgICAgIFdyaXRlLUhvc3QgIiINCiAgICAgICAgV3JpdGUtSG9zdCAkc2VwIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkNCiAgICAgICAgV3JpdGUtSG9zdCAiICBJTlNUQUxMIERJQUdOT1NUSUNTIiAtRm9yZWdyb3VuZENvbG9yIFdoaXRlDQogICAgICAgIFdyaXRlLUhvc3QgJHNlcCAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5DQogICAgfQ0KDQogICAgQWRkLUNvbnRlbnQgLVBhdGggJExPR19GSUxFIC1WYWx1ZSAiIiAtRW5jb2RpbmcgVVRGOA0KICAgIEFkZC1Db250ZW50IC1QYXRoICRMT0dfRklMRSAtVmFsdWUgJGxvZ1NlcCAtRW5jb2RpbmcgVVRGOA0KICAgIEFkZC1Db250ZW50IC1QYXRoICRMT0dfRklMRSAtVmFsdWUgIklOU1RBTEwgRElBR05PU1RJQ1MgICR0cyIgLUVuY29kaW5nIFVURjgNCiAgICBBZGQtQ29udGVudCAtUGF0aCAkTE9HX0ZJTEUgLVZhbHVlICRsb2dTZXAgLUVuY29kaW5nIFVURjgNCg0KICAgIGZvcmVhY2ggKCRuYW1lIGluICRzY3JpcHQ6U3RlcHMuS2V5cykgew0KICAgICAgICAkcyAgICAgPSAkc2NyaXB0OlN0ZXBzWyRuYW1lXQ0KICAgICAgICAkaWNvbiAgPSBzd2l0Y2ggKCRzLlN0YXR1cykgeyAiUEFTUyIgeyJbT0tdIn0gIkZBSUwiIHsiW1hdICJ9ICJXQVJOIiB7IlshIV0ifSAiU0tJUCIgeyJbLS1dIn0gZGVmYXVsdCB7IlsgIF0ifSB9DQogICAgICAgICRjb2xvciA9IHN3aXRjaCAoJHMuU3RhdHVzKSB7ICJQQVNTIiB7IkdyZWVuIn0gIkZBSUwiIHsiUmVkIn0gIldBUk4iIHsiWWVsbG93In0gIlNLSVAiIHsiRGFya0dyYXkifSBkZWZhdWx0IHsiRGFya0dyYXkifSB9DQoNCiAgICAgICAgaWYgKCRzLlN0YXR1cyAtZXEgIlBFTkRJTkciKSB7DQogICAgICAgICAgICBpZiAoLW5vdCAkTG9nT25seSkgeyBXcml0ZS1Ib3N0ICgiICB7MH0gezEsLTU1fSB7Mn0iIC1mICRpY29uLCAkbmFtZSwgIihub3QgcmVhY2hlZCkiKSAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5IH0NCiAgICAgICAgICAgIEFkZC1Db250ZW50IC1QYXRoICRMT0dfRklMRSAtVmFsdWUgKCIgICRpY29uICRuYW1lICAobm90IHJlYWNoZWQpIikgLUVuY29kaW5nIFVURjgNCiAgICAgICAgfSBlbHNlIHsNCiAgICAgICAgICAgIGlmICgtbm90ICRMb2dPbmx5KSB7DQogICAgICAgICAgICAgICAgV3JpdGUtSG9zdCAiICAkaWNvbiAkbmFtZSIgLUZvcmVncm91bmRDb2xvciAkY29sb3INCiAgICAgICAgICAgICAgICBpZiAoJHMuRGV0YWlsKSB7IFdyaXRlLUhvc3QgIiAgICAgICAkKCRzLkRldGFpbCkiIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkgfQ0KICAgICAgICAgICAgICAgIGlmICgkcy5TdGF0dXMgLWVxICJGQUlMIiAtYW5kICRzLkZpeCkgeyBXcml0ZS1Ib3N0ICIgICAgICAgRml4OiAkKCRzLkZpeCkiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93IH0NCiAgICAgICAgICAgIH0NCiAgICAgICAgICAgIEFkZC1Db250ZW50IC1QYXRoICRMT0dfRklMRSAtVmFsdWUgIiAgJGljb24gJG5hbWUiIC1FbmNvZGluZyBVVEY4DQogICAgICAgICAgICBpZiAoJHMuRGV0YWlsKSB7IEFkZC1Db250ZW50IC1QYXRoICRMT0dfRklMRSAtVmFsdWUgIiAgICAgICAkKCRzLkRldGFpbCkiIC1FbmNvZGluZyBVVEY4IH0NCiAgICAgICAgICAgIGlmICgkcy5TdGF0dXMgLWVxICJGQUlMIiAtYW5kICRzLkZpeCkgeyBBZGQtQ29udGVudCAtUGF0aCAkTE9HX0ZJTEUgLVZhbHVlICIgICAgICAgRml4OiAkKCRzLkZpeCkiIC1FbmNvZGluZyBVVEY4IH0NCiAgICAgICAgfQ0KICAgIH0NCg0KICAgIEFkZC1Db250ZW50IC1QYXRoICRMT0dfRklMRSAtVmFsdWUgJGxvZ1NlcCAtRW5jb2RpbmcgVVRGOA0KDQogICAgaWYgKC1ub3QgJExvZ09ubHkpIHsNCiAgICAgICAgV3JpdGUtSG9zdCAkc2VwIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkNCiAgICAgICAgV3JpdGUtSG9zdCAiICBGdWxsIGxvZzogJExPR19GSUxFIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5DQogICAgICAgIFdyaXRlLUhvc3QgIiAgU2hhcmUgd2l0aCBQdWxzZSBzdXBwb3J0IGF0IHB1bHNlbmFub2FpLmNvbSIgLUZvcmVncm91bmRDb2xvciBEYXJrR3JheQ0KICAgICAgICBXcml0ZS1Ib3N0ICIiDQogICAgfQ0KfQ0KIyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANCg0KZnVuY3Rpb24gR2V0LUxvY2FsSVAgew0KICAgIChHZXQtTmV0SVBBZGRyZXNzIC1BZGRyZXNzRmFtaWx5IElQdjQgfA0KICAgICAgICBXaGVyZS1PYmplY3QgeyAkXy5JbnRlcmZhY2VBbGlhcyAtbm90bWF0Y2ggIkxvb3BiYWNrfFdTTHx2RXRoZXJuZXQiIH0gfA0KICAgICAgICBTZWxlY3QtT2JqZWN0IC1GaXJzdCAxKS5JUEFkZHJlc3MNCn0NCg0KZnVuY3Rpb24gU2V0LVdTTDJQb3J0UHJveHkgew0KICAgIHBhcmFtKFtzdHJpbmddJFdzbElQKQ0KICAgICMgVENQIG9ubHkg4oCUIHBvcnRwcm94eSBkb2VzIG5vdCBzdXBwb3J0IFVEUC4gVURQIHR1bm5lbCBwb3J0cyAoNTE4MDAtNTE4MTYpDQogICAgIyByZXF1aXJlIG1pcnJvcmVkIG5ldHdvcmtpbmcgb24gV2luZG93cyAxMSAyMkgyKyB0byBmdW5jdGlvbiBjb3JyZWN0bHkuDQogICAgJGFsbFBvcnRzID0gJE9DVEFfTUdNVF9QT1JUUyArICgkT0NUQV9BUFBfUE9SVF9TVEFSVC4uJE9DVEFfQVBQX1BPUlRfRU5EKQ0KICAgIGZvcmVhY2ggKCRwIGluICRhbGxQb3J0cykgew0KICAgICAgICBuZXRzaCBpbnRlcmZhY2UgcG9ydHByb3h5IGRlbGV0ZSB2NHRvdjQgbGlzdGVucG9ydD0kcCBsaXN0ZW5hZGRyZXNzPTAuMC4wLjAgfCBPdXQtTnVsbA0KICAgICAgICBuZXRzaCBpbnRlcmZhY2UgcG9ydHByb3h5IGFkZCB2NHRvdjQgbGlzdGVucG9ydD0kcCBsaXN0ZW5hZGRyZXNzPTAuMC4wLjAgYA0KICAgICAgICAgICAgY29ubmVjdHBvcnQ9JHAgY29ubmVjdGFkZHJlc3M9JFdzbElQIHwgT3V0LU51bGwNCiAgICB9DQogICAgV3JpdGUtTG9nICJXU0wyIHBvcnRwcm94eSAoVENQKTogJCgkT0NUQV9NR01UX1BPUlRTIC1qb2luICcsJykgKyAkT0NUQV9BUFBfUE9SVF9TVEFSVC0kT0NUQV9BUFBfUE9SVF9FTkQg4oaSICRXc2xJUCIgIk9LIg0KICAgIFdyaXRlLUxvZyAiTk9URTogVURQIHBvcnRzICRPQ1RBX0FQUF9QT1JUX1NUQVJULSRPQ1RBX0FQUF9QT1JUX0VORCBuZWVkIG1pcnJvcmVkIG5ldHdvcmtpbmcgZm9yIGZ1bGwgdHVubmVsIHN1cHBvcnQiICJXQVJOIg0KfQ0KDQojIOKUgOKUgCBQaGFzZSAxOiBFbmFibGUgV1NMMiArIHNjaGVkdWxlIFBoYXNlIDIgYWZ0ZXIgcmVib290IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KDQpmdW5jdGlvbiBJbnZva2UtUGhhc2UxIHsNCiAgICBTaG93LUJhbm5lciAiUGhhc2UgMSBvZiAyIOKAlCBFbmFibGluZyBXU0wyIg0KDQogICAgJHNjcmlwdDpTdGVwcyA9IFtvcmRlcmVkXUB7fQ0KICAgIFJlZ2lzdGVyLVN0ZXAgIldpbmRvd3MgY29tcGF0aWJpbGl0eSAoYnVpbGQgMTkwNDErKSINCiAgICBSZWdpc3Rlci1TdGVwICJHUFUgZGV0ZWN0ZWQiDQogICAgUmVnaXN0ZXItU3RlcCAiVmlydHVhbGl6YXRpb24gZW5hYmxlZCBpbiBCSU9TIg0KICAgIFJlZ2lzdGVyLVN0ZXAgIldTTDIgZmVhdHVyZXMgZW5hYmxlZCINCiAgICBSZWdpc3Rlci1TdGVwICJXU0wyIGtlcm5lbCB1cGRhdGUiDQogICAgUmVnaXN0ZXItU3RlcCAiUGhhc2UgMiByZXN1bWUgdGFzayINCg0KICAgICRidWlsZCA9IFtTeXN0ZW0uRW52aXJvbm1lbnRdOjpPU1ZlcnNpb24uVmVyc2lvbi5CdWlsZA0KICAgIGlmICgkYnVpbGQgLWx0IDE5MDQxKSB7DQogICAgICAgIFNldC1TdGVwICJXaW5kb3dzIGNvbXBhdGliaWxpdHkgKGJ1aWxkIDE5MDQxKykiICJGQUlMIiAiQnVpbGQgJGJ1aWxkIOKAlCByZXF1aXJlcyAxOTA0MSAoV2luZG93cyAxMCAyMDA0KykiDQogICAgICAgIFdyaXRlLUxvZyAiV2luZG93cyBidWlsZCAkYnVpbGQgaXMgdG9vIG9sZC4gV1NMMiByZXF1aXJlcyBidWlsZCAxOTA0MSsgKFdpbmRvd3MgMTAgMjAwNCspLiIgIkVSUk9SIg0KICAgICAgICBTaG93LURpYWdub3N0aWNzOyBXYWl0LUZvcktleTsgZXhpdCAxDQogICAgfQ0KICAgIFdyaXRlLUxvZyAiV2luZG93cyBidWlsZCAkYnVpbGQg4oCUIE9LIiAiT0siDQogICAgU2V0LVN0ZXAgIldpbmRvd3MgY29tcGF0aWJpbGl0eSAoYnVpbGQgMTkwNDErKSIgIlBBU1MiICJCdWlsZCAkYnVpbGQiDQoNCiAgICAkZ3B1ID0gKEdldC1XbWlPYmplY3QgV2luMzJfVmlkZW9Db250cm9sbGVyIHwNCiAgICAgICAgV2hlcmUtT2JqZWN0IHsgJF8uTmFtZSAtbWF0Y2ggIk5WSURJQXxHZUZvcmNlfFJUWHxHVFh8QU1EfFJhZGVvbiIgfSB8DQogICAgICAgIFNlbGVjdC1PYmplY3QgLUZpcnN0IDEpLk5hbWUNCiAgICBpZiAoLW5vdCAkZ3B1KSB7DQogICAgICAgIFNldC1TdGVwICJHUFUgZGV0ZWN0ZWQiICJGQUlMIiAiTm8gTlZJRElBL0FNRCBHUFUgZm91bmQiDQogICAgICAgIFdyaXRlLUxvZyAiTm8gc3VwcG9ydGVkIEdQVSBkZXRlY3RlZC4gUHVsc2UgcmVxdWlyZXMgYW4gTlZJRElBIG9yIEFNRCBHUFUuIiAiRVJST1IiDQogICAgICAgIFNob3ctRGlhZ25vc3RpY3M7IFdhaXQtRm9yS2V5OyBleGl0IDENCiAgICB9DQogICAgV3JpdGUtTG9nICJHUFU6ICRncHUiICJPSyINCiAgICBTZXQtU3RlcCAiR1BVIGRldGVjdGVkIiAiUEFTUyIgJGdwdQ0KDQogICAgTmV3LUl0ZW0gLUl0ZW1UeXBlIERpcmVjdG9yeSAtRm9yY2UgLVBhdGggJFBVTFNFX0RJUiB8IE91dC1OdWxsDQoNCiAgICAkdmlydEVuYWJsZWQgPSAoR2V0LUNvbXB1dGVySW5mbykuSHlwZXJWUmVxdWlyZW1lbnRWaXJ0dWFsaXphdGlvbkZpcm13YXJlRW5hYmxlZA0KICAgIGlmICgkdmlydEVuYWJsZWQgLWVxICRmYWxzZSkgew0KICAgICAgICBTZXQtU3RlcCAiVmlydHVhbGl6YXRpb24gZW5hYmxlZCBpbiBCSU9TIiAiRkFJTCIgIkRpc2FibGVkIOKAlCBzZWUgQklPUyBpbnN0cnVjdGlvbnMgYmVsb3ciDQogICAgICAgIFdyaXRlLUxvZyAiSGFyZHdhcmUgdmlydHVhbGl6YXRpb24gaXMgZGlzYWJsZWQgaW4geW91ciBCSU9TL1VFRkkuIiAiRVJST1IiDQogICAgICAgIFdyaXRlLUhvc3QgIiINCiAgICAgICAgV3JpdGUtSG9zdCAiICDilIzilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilJAiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkDQogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICBBQ1RJT04gUkVRVUlSRUQ6IEVuYWJsZSB2aXJ0dWFsaXphdGlvbiBpbiB5b3VyIEJJT1MvVUVGSSAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkDQogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkDQogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICAxLiBSZXN0YXJ0IHlvdXIgUEMgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkDQogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICAyLiBQcmVzcyBEZWxldGUgb3IgRjIgZHVyaW5nIGJvb3QgdG8gb3BlbiBCSU9TICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBSZWQNCiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgIDMuIEZpbmQ6IEFkdmFuY2VkID4gQ1BVIENvbmZpZ3VyYXRpb24gPiBTVk0gTW9kZSAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFJlZA0KICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgKEludGVsIGJvYXJkczogbG9vayBmb3IgJ0ludGVsIFZpcnR1YWxpemF0aW9uJyBvciBWVC14KSDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkDQogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICA0LiBTZXQgaXQgdG8gRW5hYmxlZCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkDQogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICA1LiBQcmVzcyBGMTAgdG8gc2F2ZSBhbmQgZXhpdCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBSZWQNCiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBSZWQNCiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgIFRoZW4gcmUtcnVuIHRoaXMgaW5zdGFsbGVyLiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBSZWQNCiAgICAgICAgV3JpdGUtSG9zdCAiICDilJTilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilJgiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkDQogICAgICAgIFdyaXRlLUhvc3QgIiINCiAgICAgICAgU2hvdy1EaWFnbm9zdGljczsgV2FpdC1Gb3JLZXk7IGV4aXQgMQ0KICAgIH0NCiAgICBXcml0ZS1Mb2cgIkhhcmR3YXJlIHZpcnR1YWxpemF0aW9uIGVuYWJsZWQgaW4gQklPUyDigJQgT0siICJPSyINCiAgICBTZXQtU3RlcCAiVmlydHVhbGl6YXRpb24gZW5hYmxlZCBpbiBCSU9TIiAiUEFTUyINCg0KICAgIFdyaXRlLUxvZyAiRW5hYmxpbmcgV1NMMiBXaW5kb3dzIGZlYXR1cmVzLi4uIg0KICAgIGRpc20uZXhlIC9vbmxpbmUgL2VuYWJsZS1mZWF0dXJlIC9mZWF0dXJlbmFtZTpNaWNyb3NvZnQtV2luZG93cy1TdWJzeXN0ZW0tTGludXggL2FsbCAvbm9yZXN0YXJ0IHwgT3V0LU51bGwNCiAgICBkaXNtLmV4ZSAvb25saW5lIC9lbmFibGUtZmVhdHVyZSAvZmVhdHVyZW5hbWU6VmlydHVhbE1hY2hpbmVQbGF0Zm9ybSAvYWxsIC9ub3Jlc3RhcnQgfCBPdXQtTnVsbA0KICAgIFdyaXRlLUxvZyAiV1NMMiBmZWF0dXJlcyBlbmFibGVkIiAiT0siDQogICAgU2V0LVN0ZXAgIldTTDIgZmVhdHVyZXMgZW5hYmxlZCIgIlBBU1MiDQoNCiAgICBXcml0ZS1Mb2cgIkluc3RhbGxpbmcgV1NMMiBrZXJuZWwgdXBkYXRlLi4uIg0KICAgICRtc2kgPSAiJGVudjpURU1QXHdzbF91cGRhdGUubXNpIg0KICAgIHRyeSB7DQogICAgICAgIEludm9rZS1XZWJSZXF1ZXN0ICJodHRwczovL3dzbHN0b3Jlc3RvcmFnZS5ibG9iLmNvcmUud2luZG93cy5uZXQvd3NsYmxvYi93c2xfdXBkYXRlX3g2NC5tc2kiIGANCiAgICAgICAgICAgIC1PdXRGaWxlICRtc2kgLVVzZUJhc2ljUGFyc2luZw0KICAgICAgICBTdGFydC1Qcm9jZXNzIG1zaWV4ZWMuZXhlIC1Bcmd1bWVudExpc3QgIi9pIGAiJG1zaWAiIC9xdWlldCAvbm9yZXN0YXJ0IiAtV2FpdA0KICAgICAgICBXcml0ZS1Mb2cgIldTTDIga2VybmVsIHVwZGF0ZWQiICJPSyINCiAgICB9IGNhdGNoIHsNCiAgICAgICAgV3JpdGUtTG9nICJXU0wyIGtlcm5lbCBhbHJlYWR5IHVwIHRvIGRhdGUiICJPSyINCiAgICB9DQogICAgU2V0LVN0ZXAgIldTTDIga2VybmVsIHVwZGF0ZSIgIlBBU1MiDQoNCiAgICB3c2wgLS1zZXQtZGVmYXVsdC12ZXJzaW9uIDIgMj4mMSB8IE91dC1OdWxsDQoNCiAgICBTZXQtQ29udGVudCAtUGF0aCAkUEhBU0VfRklMRSAtVmFsdWUgIjIiIC1FbmNvZGluZyBVVEY4DQoNCiAgICAkc3RhYmxlUGF0aCA9ICIkUFVMU0VfRElSXHB1bHNlLW9jdGEtc2V0dXAucHMxIg0KICAgIGlmICgkUFNDb21tYW5kUGF0aCAtbmUgJHN0YWJsZVBhdGgpIHsNCiAgICAgICAgQ29weS1JdGVtIC1QYXRoICRQU0NvbW1hbmRQYXRoIC1EZXN0aW5hdGlvbiAkc3RhYmxlUGF0aCAtRm9yY2UNCiAgICB9DQoNCiAgICAkYWN0aW9uICAgID0gTmV3LVNjaGVkdWxlZFRhc2tBY3Rpb24gLUV4ZWN1dGUgInBvd2Vyc2hlbGwuZXhlIiBgDQogICAgICAgIC1Bcmd1bWVudCAiLU5vUHJvZmlsZSAtRXhlY3V0aW9uUG9saWN5IEJ5cGFzcyAtV2luZG93U3R5bGUgTm9ybWFsIC1GaWxlIGAiJHN0YWJsZVBhdGhgIiINCiAgICAkdHJpZ2dlciAgID0gTmV3LVNjaGVkdWxlZFRhc2tUcmlnZ2VyIC1BdExvZ09uDQogICAgJHNldHRpbmdzICA9IE5ldy1TY2hlZHVsZWRUYXNrU2V0dGluZ3NTZXQgLUFsbG93U3RhcnRJZk9uQmF0dGVyaWVzIC1Eb250U3RvcElmR29pbmdPbkJhdHRlcmllcw0KICAgICRwcmluY2lwYWwgPSBOZXctU2NoZWR1bGVkVGFza1ByaW5jaXBhbCAtVXNlcklkICRlbnY6VVNFUk5BTUUgLVJ1bkxldmVsIEhpZ2hlc3QNCiAgICBSZWdpc3Rlci1TY2hlZHVsZWRUYXNrIC1UYXNrTmFtZSAkVEFTS19OQU1FIC1BY3Rpb24gJGFjdGlvbiAtVHJpZ2dlciAkdHJpZ2dlciBgDQogICAgICAgIC1TZXR0aW5ncyAkc2V0dGluZ3MgLVByaW5jaXBhbCAkcHJpbmNpcGFsIC1Gb3JjZSB8IE91dC1OdWxsDQogICAgV3JpdGUtTG9nICJQaGFzZSAyIHJlc3VtZSB0YXNrIHJlZ2lzdGVyZWQiICJPSyINCiAgICBTZXQtU3RlcCAiUGhhc2UgMiByZXN1bWUgdGFzayIgIlBBU1MiDQoNCiAgICBXcml0ZS1Ib3N0ICIiDQogICAgV3JpdGUtSG9zdCAiICDilIzilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilJAiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93DQogICAgV3JpdGUtSG9zdCAiICDilIIgIE9uZSByZWJvb3QgcmVxdWlyZWQgdG8gY29udGludWUgc2V0dXAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cNCiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgU2V0dXAgd2lsbCByZXN1bWUgYXV0b21hdGljYWxseS4gICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdw0KICAgIFdyaXRlLUhvc3QgIiAg4pSU4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSYIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdw0KICAgIFdyaXRlLUhvc3QgIiINCiAgICAkYW5zd2VyID0gUmVhZC1Ib3N0ICIgIFJlYm9vdCBub3c/IChZL24pIg0KICAgIGlmICgkYW5zd2VyIC1uZSAibiIpIHsgUmVzdGFydC1Db21wdXRlciAtRm9yY2UgfQ0KICAgIGVsc2UgeyBXcml0ZS1Ib3N0ICIgIFJlYm9vdCB3aGVuIHJlYWR5LiBTZXR1cCByZXN1bWVzIG9uIG5leHQgbG9naW4uIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5IH0NCn0NCg0KIyDilIDilIAgUGhhc2UgMjogVWJ1bnR1ICsgT2N0YVNwYWNlIChvc24pICsgTmV0d29ya2luZyArIEF1dG8tc3RhcnQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSADQoNCmZ1bmN0aW9uIEludm9rZS1QaGFzZTIgew0KICAgIFNob3ctQmFubmVyICJQaGFzZSAyIG9mIDIg4oCUIEluc3RhbGxpbmcgT2N0YVNwYWNlIFByb3ZpZGVyIFN0YWNrIg0KDQogICAgJHNjcmlwdDpTdGVwcyA9IFtvcmRlcmVkXUB7fQ0KICAgIFJlZ2lzdGVyLVN0ZXAgIlVidW50dSBvbiBXU0wyIg0KICAgIFJlZ2lzdGVyLVN0ZXAgInN5c3RlbWQgaW4gV1NMMiINCiAgICBSZWdpc3Rlci1TdGVwICJXU0wyIG5ldHdvcmtpbmciDQogICAgUmVnaXN0ZXItU3RlcCAiR1BVIGNvbXB1dGUgaW4gV1NMMiIgIlVwZGF0ZSBXaW5kb3dzIE5WSURJQSBkcml2ZXIgYXQgbnZpZGlhLmNvbS9kcml2ZXJzIg0KICAgIFJlZ2lzdGVyLVN0ZXAgIkJ1aWxkIHRvb2xzIChjdXJsLCBiYXNoKSIgIndzbCAtZCBVYnVudHUtMjIuMDQgLS0gYmFzaCAtYyAnYXB0LWdldCB1cGRhdGUgJiYgYXB0LWdldCBpbnN0YWxsIC15IGN1cmwgYmFzaCciDQogICAgUmVnaXN0ZXItU3RlcCAiT2N0YVNwYWNlIG9zbiBpbnN0YWxsZWQiICJDaGVjayBpbnN0YWxsLm9jdGEuc3BhY2Ugb3IgT2N0YVNwYWNlIGRvY3MiDQogICAgUmVnaXN0ZXItU3RlcCAib3NuIHNlcnZpY2Ugc3RhcnRlZCINCiAgICBSZWdpc3Rlci1TdGVwICJPY3RhU3BhY2Ugbm9kZSB0b2tlbiINCiAgICBSZWdpc3Rlci1TdGVwICJXaW5kb3dzIEZpcmV3YWxsIHJ1bGVzIg0KICAgIFJlZ2lzdGVyLVN0ZXAgIlVQblAgcG9ydCBmb3J3YXJkaW5nIg0KICAgIFJlZ2lzdGVyLVN0ZXAgIldTTDIgcG9ydCBwcm94eSINCiAgICBSZWdpc3Rlci1TdGVwICJQdWxzZSByZWdpc3RyYXRpb24iDQogICAgUmVnaXN0ZXItU3RlcCAiR1BVIHdhdGNoZG9nIHRhc2siDQogICAgUmVnaXN0ZXItU3RlcCAiQXV0by1zdGFydCB0YXNrIg0KICAgIFJlZ2lzdGVyLVN0ZXAgIkF1dG8tbG9naW4iDQoNCiAgICBXcml0ZS1Mb2cgIlNldHRpbmcgdXAgVWJ1bnR1LTIyLjA0IG9uIFdTTDIuLi4iDQogICAgIyBUZXN0IHRoZSBkaXN0cm8gZGlyZWN0bHkg4oCUIHdzbCAtLWxpc3QgLS1xdWlldCBvdXRwdXRzIFVURi0xNiB3aGljaCBjYW4gY29ycnVwdCBzdHJpbmcgbWF0Y2hpbmcNCiAgICAkZGlzdHJvT2sgPSAod3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICJlY2hvIG9rIiAyPiYxKSAtbWF0Y2ggIm9rIg0KICAgIGlmICgtbm90ICRkaXN0cm9Paykgew0KICAgICAgICB3c2wgLS11bnJlZ2lzdGVyIFVidW50dS0yMi4wNCAyPiYxIHwgT3V0LU51bGwNCiAgICAgICAgV3JpdGUtTG9nICJEb3dubG9hZGluZyBVYnVudHUtMjIuMDQuLi4iDQogICAgICAgIHdzbCAtLWluc3RhbGwgLWQgVWJ1bnR1LTIyLjA0IC0tbm8tbGF1bmNoIDI+JjEgfCBPdXQtTnVsbA0KDQogICAgICAgIFdyaXRlLUxvZyAiSW5pdGlhbGl6aW5nIFVidW50dS0yMi4wNCBoZWFkbGVzc2x5IChubyBHVUkgcmVxdWlyZWQpLi4uIg0KICAgICAgICAkdWJ1bnR1RXhlID0gR2V0LUNoaWxkSXRlbSAiJGVudjpMT0NBTEFQUERBVEFcTWljcm9zb2Z0XFdpbmRvd3NBcHBzIiAtRmlsdGVyICJ1YnVudHUyMjA0Ki5leGUiIC1FcnJvckFjdGlvbiBTaWxlbnRseUNvbnRpbnVlIHwgU2VsZWN0LU9iamVjdCAtRmlyc3QgMQ0KICAgICAgICBpZiAoLW5vdCAkdWJ1bnR1RXhlKSB7DQogICAgICAgICAgICAkdWJ1bnR1RXhlID0gR2V0LUNoaWxkSXRlbSAiJGVudjpMT0NBTEFQUERBVEFcTWljcm9zb2Z0XFdpbmRvd3NBcHBzIiAtRmlsdGVyICJ1YnVudHUqLmV4ZSIgLUVycm9yQWN0aW9uIFNpbGVudGx5Q29udGludWUgfCBTZWxlY3QtT2JqZWN0IC1GaXJzdCAxDQogICAgICAgIH0NCiAgICAgICAgaWYgKCR1YnVudHVFeGUpIHsNCiAgICAgICAgICAgICYgJHVidW50dUV4ZS5GdWxsTmFtZSBpbnN0YWxsIC0tcm9vdCAyPiYxIHwgT3V0LU51bGwNCiAgICAgICAgfQ0KICAgICAgICBTdGFydC1TbGVlcCA1DQoNCiAgICAgICAgJGNoZWNrID0gd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICJlY2hvIG9rIiAyPiYxDQogICAgICAgIGlmICgkY2hlY2sgLW5vdG1hdGNoICJvayIpIHsNCiAgICAgICAgICAgIFdyaXRlLUxvZyAiVWJ1bnR1LTIyLjA0IHJvb3QgYWNjZXNzIGZhaWxlZCDigJQgcmUtcnVuIGluc3RhbGxlci4iICJFUlJPUiINCiAgICAgICAgICAgIFNob3ctRGlhZ25vc3RpY3M7IFdhaXQtRm9yS2V5OyBleGl0IDENCiAgICAgICAgfQ0KICAgICAgICBXcml0ZS1Mb2cgIlVidW50dS0yMi4wNCBpbnN0YWxsZWQgYW5kIGluaXRpYWxpemVkIiAiT0siDQogICAgfSBlbHNlIHsNCiAgICAgICAgV3JpdGUtTG9nICJVYnVudHUtMjIuMDQgYWxyZWFkeSBwcmVzZW50IGFuZCB3b3JraW5nIiAiT0siDQogICAgfQ0KICAgIFNldC1TdGVwICJVYnVudHUgb24gV1NMMiIgIlBBU1MiDQoNCiAgICAjIEVuYWJsZSBzeXN0ZW1kIOKAlCBvc24gaXMgYSBzeXN0ZW1kIHNlcnZpY2UNCiAgICBXcml0ZS1Mb2cgIkVuYWJsaW5nIHN5c3RlbWQgaW4gV1NMMiAocmVxdWlyZWQgZm9yIG9zbiBzZXJ2aWNlKS4uLiINCiAgICB3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tdXNlciByb290IC0tIGJhc2ggLWMgImdyZXAgLXEgJ3N5c3RlbWQ9dHJ1ZScgL2V0Yy93c2wuY29uZiAyPi9kZXYvbnVsbCB8fCBwcmludGYgJ1tib290XVxuc3lzdGVtZD10cnVlXG4nID4gL2V0Yy93c2wuY29uZiINCg0KICAgICMgV1NMMiBtaXJyb3JlZCBuZXR3b3JraW5nIOKAlCBlc3BlY2lhbGx5IGltcG9ydGFudCBmb3IgT2N0YVNwYWNlIGJlY2F1c2UgdGhlDQogICAgIyB0dW5uZWwgcG9ydHMgNTE4MDAtNTE4MTYgdXNlIFVEUCwgYW5kIHBvcnRwcm94eSBpcyBUQ1Atb25seS4NCiAgICAkb3NCdWlsZCA9IFtTeXN0ZW0uRW52aXJvbm1lbnRdOjpPU1ZlcnNpb24uVmVyc2lvbi5CdWlsZA0KICAgICRtaXJyb3JlZE5ldHdvcmtpbmcgPSAkZmFsc2UNCiAgICAkd3NsQ29uZmlnUGF0aCA9ICIkZW52OlVTRVJQUk9GSUxFXC53c2xjb25maWciDQogICAgaWYgKCRvc0J1aWxkIC1nZSAyMjYyMSkgew0KICAgICAgICBXcml0ZS1Mb2cgIldpbmRvd3MgMTEgMjJIMisgZGV0ZWN0ZWQg4oCUIGVuYWJsaW5nIFdTTDIgbWlycm9yZWQgbmV0d29ya2luZy4uLiINCiAgICAgICAgJHdzbENvbmZpZ0NvbnRlbnQgPSBpZiAoVGVzdC1QYXRoICR3c2xDb25maWdQYXRoKSB7IEdldC1Db250ZW50ICR3c2xDb25maWdQYXRoIC1SYXcgfSBlbHNlIHsgIiIgfQ0KICAgICAgICBpZiAoJHdzbENvbmZpZ0NvbnRlbnQgLW5vdG1hdGNoICduZXR3b3JraW5nTW9kZScpIHsNCiAgICAgICAgICAgIGlmICgkd3NsQ29uZmlnQ29udGVudCAtbWF0Y2ggJ1xbd3NsMlxdJykgew0KICAgICAgICAgICAgICAgICR3c2xDb25maWdDb250ZW50ID0gJHdzbENvbmZpZ0NvbnRlbnQgLXJlcGxhY2UgJyhcW3dzbDJcXSknLCAiYCQxYG5uZXR3b3JraW5nTW9kZT1taXJyb3JlZCINCiAgICAgICAgICAgIH0gZWxzZSB7DQogICAgICAgICAgICAgICAgJHdzbENvbmZpZ0NvbnRlbnQgKz0gImBuW3dzbDJdYG5uZXR3b3JraW5nTW9kZT1taXJyb3JlZGBuIg0KICAgICAgICAgICAgfQ0KICAgICAgICAgICAgU2V0LUNvbnRlbnQgLVBhdGggJHdzbENvbmZpZ1BhdGggLVZhbHVlICR3c2xDb25maWdDb250ZW50IC1FbmNvZGluZyBVVEY4DQogICAgICAgIH0NCiAgICAgICAgJG1pcnJvcmVkTmV0d29ya2luZyA9ICR0cnVlDQogICAgICAgIFdyaXRlLUxvZyAiV1NMMiBtaXJyb3JlZCBuZXR3b3JraW5nIGNvbmZpZ3VyZWQg4oCUIFVEUCB0dW5uZWxzIHdpbGwgd29yayBjb3JyZWN0bHkiICJPSyINCiAgICAgICAgU2V0LVN0ZXAgIldTTDIgbmV0d29ya2luZyIgIlBBU1MiICJNaXJyb3JlZCAoV2luZG93cyAxMSAyMkgyKykg4oCUIFVEUCB0dW5uZWxzIGZ1bGx5IGZ1bmN0aW9uYWwiDQogICAgfSBlbHNlIHsNCiAgICAgICAgV3JpdGUtTG9nICJXaW5kb3dzIGJ1aWxkICR7b3NCdWlsZH06IG1pcnJvcmVkIG5ldHdvcmtpbmcgbmVlZHMgMjJIMiAoMjI2MjErKSDigJQgcG9ydHByb3h5IG9ubHkgY292ZXJzIFRDUDsgVURQIHR1bm5lbHMgd2lsbCBiZSBsaW1pdGVkIiAiV0FSTiINCiAgICAgICAgU2V0LVN0ZXAgIldTTDIgbmV0d29ya2luZyIgIldBUk4iICJQb3J0cHJveHkgb25seSAoYnVpbGQgJG9zQnVpbGQpIOKAlCBVRFAgdHVubmVsIHBvcnRzIGxpbWl0ZWQ7IHVwZ3JhZGUgdG8gV2luIDExIDIySDIrIHJlY29tbWVuZGVkIg0KICAgIH0NCg0KICAgIHdzbCAtLXNodXRkb3duDQogICAgU3RhcnQtU2xlZXAgMjANCiAgICAkc2RDaGVjayA9IHdzbCAtZCBVYnVudHUtMjIuMDQgLS11c2VyIHJvb3QgLS0gYmFzaCAtYyAiWyAtZCAvcnVuL3N5c3RlbWQvc3lzdGVtIF0gJiYgZWNobyB5ZXMgfHwgZWNobyBubyIgMj4mMQ0KICAgIGlmICgkc2RDaGVjayAtbWF0Y2ggInllcyIpIHsNCiAgICAgICAgV3JpdGUtTG9nICJzeXN0ZW1kIHJ1bm5pbmcgaW4gV1NMMiIgIk9LIg0KICAgICAgICBTZXQtU3RlcCAic3lzdGVtZCBpbiBXU0wyIiAiUEFTUyINCiAgICB9IGVsc2Ugew0KICAgICAgICBXcml0ZS1Mb2cgInN5c3RlbWQgbWF5IG5vdCBiZSBhY3RpdmUg4oCUIG9zbiBtYXkgbm90IGF1dG8tc3RhcnQgb24gcmVib290IiAiV0FSTiINCiAgICAgICAgU2V0LVN0ZXAgInN5c3RlbWQgaW4gV1NMMiIgIldBUk4iICJzeXN0ZW1kIG5vdCBkZXRlY3RlZCDigJQgb3NuIHNlcnZpY2UgbWF5IG5vdCBwZXJzaXN0IGFjcm9zcyByZWJvb3RzIg0KICAgIH0NCg0KICAgICMg4pSA4pSAIERldGVjdCBHUFUgdmVuZG9yIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KICAgICRncHVPYmogICAgPSBHZXQtV21pT2JqZWN0IFdpbjMyX1ZpZGVvQ29udHJvbGxlciB8IFdoZXJlLU9iamVjdCB7ICRfLk5hbWUgLW1hdGNoICJOVklESUF8R2VGb3JjZXxSVFh8R1RYfEFNRHxSYWRlb24iIH0gfCBTZWxlY3QtT2JqZWN0IC1GaXJzdCAxDQogICAgJGdwdU5hbWUgICA9ICRncHVPYmouTmFtZQ0KICAgICR2cmFtTWIgICAgPSAkZ3B1T2JqLkFkYXB0ZXJSQU0NCiAgICAkdnJhbUdiICAgID0gaWYgKCR2cmFtTWIgLWFuZCAkdnJhbU1iIC1ndCAwKSB7IFttYXRoXTo6Um91bmQoJHZyYW1NYiAvIDFHQikgfSBlbHNlIHsgOCB9DQogICAgJGdwdVZlbmRvciA9IGlmICgkZ3B1TmFtZSAtbWF0Y2ggIk5WSURJQXxHZUZvcmNlfFJUWHxHVFgiKSB7ICJOVklESUEiIH0gZWxzZSB7ICJBTUQiIH0NCg0KICAgICMg4pSA4pSAIFByZS1pbnN0YWxsIEdQVSBjb21wdXRlIGRyaXZlcnMgaW5zaWRlIFdTTDIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSADQogICAgV3JpdGUtTG9nICJDaGVja2luZyBHUFUgY29tcHV0ZSBlbnZpcm9ubWVudCBpbiBXU0wyICgkZ3B1VmVuZG9yKS4uLiINCiAgICBpZiAoJGdwdVZlbmRvciAtZXEgIk5WSURJQSIpIHsNCiAgICAgICAgJG52Q2hlY2sgPSB3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tdXNlciByb290IC0tIGJhc2ggLWMgIm52aWRpYS1zbWkgLUwgMj4vZGV2L251bGwgfCBoZWFkIC0xIiAyPiYxDQogICAgICAgIGlmICgkbnZDaGVjayAtbWF0Y2ggIkdQVSAwIikgew0KICAgICAgICAgICAgV3JpdGUtTG9nICJOVklESUEgR1BVIHZpc2libGUgaW4gV1NMMiIgIk9LIg0KICAgICAgICAgICAgU2V0LVN0ZXAgIkdQVSBjb21wdXRlIGluIFdTTDIiICJQQVNTIiAibnZpZGlhLXNtaSBPSyDigJQgJGdwdU5hbWUiDQogICAgICAgIH0gZWxzZSB7DQogICAgICAgICAgICBXcml0ZS1Mb2cgIk5WSURJQSBHUFUgbm90IHlldCB2aXNpYmxlIGluIFdTTDIg4oCUIGVuc3VyZSBXaW5kb3dzIE5WSURJQSBkcml2ZXIgaXMgdXAgdG8gZGF0ZSIgIldBUk4iDQogICAgICAgICAgICBTZXQtU3RlcCAiR1BVIGNvbXB1dGUgaW4gV1NMMiIgIldBUk4iICJudmlkaWEtc21pIHJldHVybmVkIG5vIG91dHB1dCDigJQgb3NuIG1heSBmYWlsIHdpdGhvdXQgR1BVIGFjY2VzcyINCiAgICAgICAgfQ0KICAgIH0gZWxzZSB7DQogICAgICAgIFdyaXRlLUxvZyAiSW5zdGFsbGluZyBST0NtIGZvciBBTUQgR1BVIGluIFdTTDIgKHRoaXMgdGFrZXMgYSBmZXcgbWludXRlcykuLi4iDQogICAgICAgICR1YnVudHVWZXIgPSB3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tdXNlciByb290IC0tIGJhc2ggLWMgImxzYl9yZWxlYXNlIC1jcyAyPi9kZXYvbnVsbCIgMj4mMQ0KICAgICAgICAkdWJ1bnR1VmVyID0gJHVidW50dVZlci5UcmltKCkNCiAgICAgICAgaWYgKCR1YnVudHVWZXIgLW5vdGluIEAoImphbW15IiwiZm9jYWwiLCJub2JsZSIpKSB7ICR1YnVudHVWZXIgPSAiamFtbXkiIH0NCiAgICAgICAgJHJvY21TY3JpcHQgPSAic2V0IC1lYG5leHBvcnQgREVCSUFOX0ZST05URU5EPW5vbmludGVyYWN0aXZlYG5hcHQtZ2V0IHVwZGF0ZSAtcXFgbmFwdC1nZXQgaW5zdGFsbCAteSAtcXEgd2dldCBnbnVwZyBjYS1jZXJ0aWZpY2F0ZXNgbm1rZGlyIC1wIC9ldGMvYXB0L2tleXJpbmdzYG53Z2V0IC1xTyAtIGh0dHBzOi8vcmVwby5yYWRlb24uY29tL3JvY20vcm9jbS5ncGcua2V5IHwgZ3BnIC0tZGVhcm1vciAtbyAvZXRjL2FwdC9rZXlyaW5ncy9yb2NtLmdwZ2BuZWNobyAnZGViIFthcmNoPWFtZDY0IHNpZ25lZC1ieT0vZXRjL2FwdC9rZXlyaW5ncy9yb2NtLmdwZ10gaHR0cHM6Ly9yZXBvLnJhZGVvbi5jb20vcm9jbS9hcHQvNi4yICR1YnVudHVWZXIgbWFpbicgPiAvZXRjL2FwdC9zb3VyY2VzLmxpc3QuZC9yb2NtLmxpc3RgbmFwdC1nZXQgdXBkYXRlIC1xcWBuYXB0LWdldCBpbnN0YWxsIC15IC1xcSByb2NtLW9wZW5jbC1ydW50aW1lIg0KICAgICAgICAjIFBpcGUgdmlhIHN0ZGluIHRvIGF2b2lkIENSTEYgaXNzdWVzIHdpdGggYmFzaCAtYyBvbiBXaW5kb3dzDQogICAgICAgICRyb2NtU2NyaXB0IHwgd3NsIC1kIFVidW50dS0yMi4wNCAtLXVzZXIgcm9vdCAtLSBiYXNoIDI+JjEgfCBGb3JFYWNoLU9iamVjdCB7IFdyaXRlLUxvZyAkXyB9DQogICAgICAgIGlmICgkTEFTVEVYSVRDT0RFIC1lcSAwKSB7DQogICAgICAgICAgICBXcml0ZS1Mb2cgIlJPQ20gaW5zdGFsbGVkIiAiT0siDQogICAgICAgICAgICBTZXQtU3RlcCAiR1BVIGNvbXB1dGUgaW4gV1NMMiIgIlBBU1MiICJST0NtIG9wZW5jbC1ydW50aW1lIGluc3RhbGxlZCDigJQgJGdwdU5hbWUiDQogICAgICAgIH0gZWxzZSB7DQogICAgICAgICAgICBXcml0ZS1Mb2cgIlJPQ20gaW5zdGFsbCBlbmNvdW50ZXJlZCBlcnJvcnMg4oCUIE9jdGFTcGFjZSBtYXkgaGF2ZSBsaW1pdGVkIEFNRCBzdXBwb3J0IiAiV0FSTiINCiAgICAgICAgICAgIFNldC1TdGVwICJHUFUgY29tcHV0ZSBpbiBXU0wyIiAiV0FSTiIgIlJPQ20gaW5zdGFsbCBoYWQgZXJyb3JzIOKAlCBBTUQgc3VwcG9ydCBtYXkgYmUgbGltaXRlZCINCiAgICAgICAgfQ0KICAgIH0NCg0KICAgICMg4pSA4pSAIEluc3RhbGwgT2N0YVNwYWNlIG5vZGUgKG9zbikgaW5zaWRlIFdTTDIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSADQogICAgV3JpdGUtTG9nICJJbnN0YWxsaW5nIG9zbiBwcmVyZXF1aXNpdGVzIChjdXJsLCBiYXNoLCBndW0pLi4uIg0KICAgIHdzbCAtZCBVYnVudHUtMjIuMDQgLS11c2VyIHJvb3QgLS0gYmFzaCAtYyAiZXhwb3J0IERFQklBTl9GUk9OVEVORD1ub25pbnRlcmFjdGl2ZTsgYXB0LWdldCB1cGRhdGUgLXFxICYmIGFwdC1nZXQgaW5zdGFsbCAteSAtcXEgY3VybCBiYXNoIiAyPiYxIHwgRm9yRWFjaC1PYmplY3QgeyBXcml0ZS1Mb2cgJF8gfQ0KICAgIGlmICgkTEFTVEVYSVRDT0RFIC1lcSAwKSB7DQogICAgICAgIFNldC1TdGVwICJCdWlsZCB0b29scyAoY3VybCwgYmFzaCkiICJQQVNTIg0KICAgIH0gZWxzZSB7DQogICAgICAgIFNldC1TdGVwICJCdWlsZCB0b29scyAoY3VybCwgYmFzaCkiICJXQVJOIiAiYXB0LWdldCBleGl0ICRMQVNURVhJVENPREUg4oCUIG9zbiBpbnN0YWxsZXIgd2lsbCBhdHRlbXB0IHRvIGNvbnRpbnVlIGFueXdheSINCiAgICB9DQoNCiAgICBXcml0ZS1Mb2cgIkluc3RhbGxpbmcgZ3VtIChyZXF1aXJlZCBieSBPY3RhU3BhY2UgaW5zdGFsbGVyKS4uLiINCiAgICAkZ3VtSW5zdGFsbCA9ICJleHBvcnQgREVCSUFOX0ZST05URU5EPW5vbmludGVyYWN0aXZlICYmIG1rZGlyIC1wIC9ldGMvYXB0L2tleXJpbmdzICYmIGN1cmwgLWZzU0wgaHR0cHM6Ly9yZXBvLmNoYXJtLnNoL2FwdC9ncGcua2V5IHwgZ3BnIC0tZGVhcm1vciAtbyAvZXRjL2FwdC9rZXlyaW5ncy9jaGFybS5ncGcgJiYgZWNobyAnZGViIFtzaWduZWQtYnk9L2V0Yy9hcHQva2V5cmluZ3MvY2hhcm0uZ3BnXSBodHRwczovL3JlcG8uY2hhcm0uc2gvYXB0LyAqIConIHwgdGVlIC9ldGMvYXB0L3NvdXJjZXMubGlzdC5kL2NoYXJtLmxpc3QgPiAvZGV2L251bGwgJiYgYXB0LWdldCB1cGRhdGUgLXFxICYmIGFwdC1nZXQgaW5zdGFsbCAteSAtcXEgZ3VtIg0KICAgIHdzbCAtZCBVYnVudHUtMjIuMDQgLS11c2VyIHJvb3QgLS0gYmFzaCAtYyAkZ3VtSW5zdGFsbCAyPiYxIHwgRm9yRWFjaC1PYmplY3QgeyBXcml0ZS1Mb2cgJF8gfQ0KICAgIGlmICgkTEFTVEVYSVRDT0RFIC1uZSAwKSB7DQogICAgICAgIFdyaXRlLUxvZyAiZ3VtIGluc3RhbGwgZmFpbGVkIOKAlCBPY3RhU3BhY2UgaW5zdGFsbGVyIG1heSBmYWlsIiAiV0FSTiINCiAgICB9IGVsc2Ugew0KICAgICAgICBXcml0ZS1Mb2cgImd1bSBpbnN0YWxsZWQiICJPSyINCiAgICB9DQoNCiAgICBXcml0ZS1Mb2cgIkluc3RhbGxpbmcgT2N0YVNwYWNlIG5vZGUgKG9zbikgaW5zaWRlIFdTTDIuLi4iDQogICAgJG9jdGFPdXRwdXQgPSB3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tdXNlciByb290IC0tIGJhc2ggLWMgImN1cmwgLWZzU0wgaHR0cHM6Ly9pbnN0YWxsLm9jdGEuc3BhY2UgfCBiYXNoIiAyPiYxDQogICAgJG9jdGFFeGl0ID0gJExBU1RFWElUQ09ERQ0KICAgICRvY3RhT3V0cHV0IHwgRm9yRWFjaC1PYmplY3QgeyBXcml0ZS1Mb2cgJF8gfQ0KICAgIGlmICgkb2N0YUV4aXQgLW5lIDApIHsNCiAgICAgICAgU2V0LVN0ZXAgIk9jdGFTcGFjZSBvc24gaW5zdGFsbGVkIiAiRkFJTCIgImluc3RhbGwub2N0YS5zcGFjZSBzY3JpcHQgZXhpdGVkICRvY3RhRXhpdCDigJQgc2VlIGxvZyBmb3IgZGV0YWlscyINCiAgICAgICAgV3JpdGUtTG9nICJPY3RhU3BhY2UgaW5zdGFsbGF0aW9uIGZhaWxlZCAoZXhpdCAkb2N0YUV4aXQpLiBDaGVjayB0aGUgb3V0cHV0IGFib3ZlLiIgIkVSUk9SIg0KICAgICAgICBTaG93LURpYWdub3N0aWNzOyBXYWl0LUZvcktleTsgZXhpdCAxDQogICAgfQ0KICAgIFdyaXRlLUxvZyAiT2N0YVNwYWNlIG9zbiBpbnN0YWxsIGNvbXBsZXRlIiAiT0siDQogICAgU2V0LVN0ZXAgIk9jdGFTcGFjZSBvc24gaW5zdGFsbGVkIiAiUEFTUyINCg0KICAgICMgU3RhcnQgdGhlIHNlcnZpY2Ugc28gaXQgY2FuIHJlZ2lzdGVyIGFuZCBnZW5lcmF0ZSBhIG5vZGUgdG9rZW4NCiAgICBXcml0ZS1Mb2cgIlN0YXJ0aW5nIG9zbiBzZXJ2aWNlLi4uIg0KICAgIHdzbCAtZCBVYnVudHUtMjIuMDQgLS11c2VyIHJvb3QgLS0gYmFzaCAtYyAic3lzdGVtY3RsIGVuYWJsZSBvc24gMj4vZGV2L251bGw7IHN5c3RlbWN0bCBzdGFydCBvc24gMj4vZGV2L251bGwiDQogICAgU2V0LVN0ZXAgIm9zbiBzZXJ2aWNlIHN0YXJ0ZWQiICJQQVNTIg0KDQogICAgIyDilIDilIAgRXh0cmFjdCBPY3RhU3BhY2Ugbm9kZSB0b2tlbiBmcm9tIGluc3RhbGxlciBvdXRwdXQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSADQogICAgIyBUaGUgaW5zdGFsbGVyIHByaW50cyBhIGJveDog4pWRICBOb2RlIFRva2VuOiBYWFhYWFhYWFhYICDilZEgdG8gc3Rkb3V0Lg0KICAgICRvY3RhTm9kZVRva2VuID0gIiINCiAgICAkdG9rZW5NYXRjaCA9ICRvY3RhT3V0cHV0IHwgU2VsZWN0LVN0cmluZyAtUGF0dGVybiAnTm9kZSBUb2tlbjpccyooXFMrKScNCiAgICBpZiAoJHRva2VuTWF0Y2gpIHsNCiAgICAgICAgJG9jdGFOb2RlVG9rZW4gPSAkdG9rZW5NYXRjaC5NYXRjaGVzWzBdLkdyb3Vwc1sxXS5WYWx1ZS5UcmltKCkNCiAgICAgICAgV3JpdGUtTG9nICJPY3RhU3BhY2Ugbm9kZSB0b2tlbjogJG9jdGFOb2RlVG9rZW4iICJPSyINCiAgICAgICAgU2V0LVN0ZXAgIk9jdGFTcGFjZSBub2RlIHRva2VuIiAiUEFTUyIgIlRva2VuOiAkb2N0YU5vZGVUb2tlbiINCiAgICB9IGVsc2Ugew0KICAgICAgICAjIEZhbGxiYWNrOiBjaGVjayBjb25maWcgZmlsZXMgd3JpdHRlbiBieSBvc24gYWZ0ZXIgZmlyc3Qgc3RhcnQNCiAgICAgICAgV3JpdGUtTG9nICJUb2tlbiBub3QgZm91bmQgaW4gaW5zdGFsbGVyIG91dHB1dCDigJQgY2hlY2tpbmcgb3NuIGNvbmZpZyBmaWxlcy4uLiINCiAgICAgICAgU3RhcnQtU2xlZXAgMTUNCiAgICAgICAgJHJhdyA9IHdzbCAtZCBVYnVudHUtMjIuMDQgLS11c2VyIHJvb3QgLS0gYmFzaCAtYyBAJw0KZm9yIGYgaW4gL2hvbWUvb2N0YS9vc24vZXRjL3N5cy5jb25maWcgL2V0Yy9vc24vbm9kZS5qc29uIC92YXIvbGliL29zbi9ub2RlLmpzb247IGRvDQogICAgWyAtZiAiJGYiIF0gfHwgY29udGludWUNCiAgICB0b2s9JChncmVwIC1vUCAnIm5vZGVfdG9rZW4iXHMqOlxzKiJcS1teIl0rJyAiJGYiIDI+L2Rldi9udWxsIHx8IGdyZXAgLW9QICcidG9rZW4iXHMqOlxzKiJcS1teIl0rJyAiJGYiIDI+L2Rldi9udWxsKQ0KICAgIFsgLW4gIiR0b2siIF0gJiYgZWNobyAiJHRvayIgJiYgYnJlYWsNCmRvbmUNCidAIDI+JjENCiAgICAgICAgJGNhbmRpZGF0ZSA9ICgkcmF3IHwgV2hlcmUtT2JqZWN0IHsgJF8gLW1hdGNoICdeXHMqXFN7Nix9XHMqJCcgfSkgfCBTZWxlY3QtT2JqZWN0IC1GaXJzdCAxDQogICAgICAgIGlmICgkY2FuZGlkYXRlKSB7DQogICAgICAgICAgICAkb2N0YU5vZGVUb2tlbiA9ICRjYW5kaWRhdGUuVHJpbSgpDQogICAgICAgICAgICBXcml0ZS1Mb2cgIk9jdGFTcGFjZSBub2RlIHRva2VuIChmcm9tIGNvbmZpZyk6ICRvY3RhTm9kZVRva2VuIiAiT0siDQogICAgICAgICAgICBTZXQtU3RlcCAiT2N0YVNwYWNlIG5vZGUgdG9rZW4iICJQQVNTIiAiVG9rZW46ICRvY3RhTm9kZVRva2VuIg0KICAgICAgICB9IGVsc2Ugew0KICAgICAgICAgICAgV3JpdGUtTG9nICJOb2RlIHRva2VuIG5vdCBmb3VuZCDigJQgaXQgd2lsbCBhcHBlYXIgYXQgY3ViZS5vY3RhLmNvbXB1dGVyIGFmdGVyIHRoZSBub2RlIGNvbm5lY3RzIiAiV0FSTiINCiAgICAgICAgICAgIFNldC1TdGVwICJPY3RhU3BhY2Ugbm9kZSB0b2tlbiIgIldBUk4iICJOb3QgeWV0IGFzc2lnbmVkIOKAlCBjaGVjayBjdWJlLm9jdGEuY29tcHV0ZXIiDQogICAgICAgIH0NCiAgICB9DQoNCiAgICAjIOKUgOKUgCBOZXR3b3JraW5nOiBXaW5kb3dzIEZpcmV3YWxsICsgVVBuUCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANCiAgICBXcml0ZS1Mb2cgIkFkZGluZyBXaW5kb3dzIEZpcmV3YWxsIGluYm91bmQgcnVsZXMgKFRDUCArIFVEUCkuLi4iDQogICAgJGFsbFBvcnRzID0gJE9DVEFfTUdNVF9QT1JUUyArICgkT0NUQV9BUFBfUE9SVF9TVEFSVC4uJE9DVEFfQVBQX1BPUlRfRU5EKQ0KICAgIGZvcmVhY2ggKCRwb3J0IGluICRhbGxQb3J0cykgew0KICAgICAgICBOZXctTmV0RmlyZXdhbGxSdWxlIC1EaXNwbGF5TmFtZSAiUHVsc2UtT2N0YS1UQ1AtJHBvcnQiIC1EaXJlY3Rpb24gSW5ib3VuZCBgDQogICAgICAgICAgICAtUHJvdG9jb2wgVENQIC1Mb2NhbFBvcnQgJHBvcnQgLUFjdGlvbiBBbGxvdyAtRXJyb3JBY3Rpb24gU2lsZW50bHlDb250aW51ZSB8IE91dC1OdWxsDQogICAgICAgIE5ldy1OZXRGaXJld2FsbFJ1bGUgLURpc3BsYXlOYW1lICJQdWxzZS1PY3RhLVVEUC0kcG9ydCIgLURpcmVjdGlvbiBJbmJvdW5kIGANCiAgICAgICAgICAgIC1Qcm90b2NvbCBVRFAgLUxvY2FsUG9ydCAkcG9ydCAtQWN0aW9uIEFsbG93IC1FcnJvckFjdGlvbiBTaWxlbnRseUNvbnRpbnVlIHwgT3V0LU51bGwNCiAgICB9DQogICAgV3JpdGUtTG9nICJGaXJld2FsbCBydWxlcyBhZGRlZCAoVENQK1VEUCkgZm9yIHBvcnRzICQoJE9DVEFfTUdNVF9QT1JUUyAtam9pbiAnLCAnKSArICRPQ1RBX0FQUF9QT1JUX1NUQVJULSRPQ1RBX0FQUF9QT1JUX0VORCIgIk9LIg0KICAgIFNldC1TdGVwICJXaW5kb3dzIEZpcmV3YWxsIHJ1bGVzIiAiUEFTUyIgIlRDUCtVRFAgJCgkT0NUQV9NR01UX1BPUlRTIC1qb2luICcsICcpLCAkT0NUQV9BUFBfUE9SVF9TVEFSVC0kT0NUQV9BUFBfUE9SVF9FTkQiDQoNCiAgICBXcml0ZS1Mb2cgIkF0dGVtcHRpbmcgVVBuUCBhdXRvbWF0aWMgcG9ydCBmb3J3YXJkaW5nLi4uIg0KICAgICRsb2NhbElQID0gR2V0LUxvY2FsSVANCiAgICAkdXBucE9rICA9ICRmYWxzZQ0KICAgIHRyeSB7DQogICAgICAgICR1cG5wICAgICA9IE5ldy1PYmplY3QgLUNvbU9iamVjdCBITmV0Q2ZnLk5BVFVQblANCiAgICAgICAgJG1hcHBpbmdzID0gJHVwbnAuU3RhdGljUG9ydE1hcHBpbmdDb2xsZWN0aW9uDQogICAgICAgIGZvcmVhY2ggKCRwb3J0IGluICRhbGxQb3J0cykgew0KICAgICAgICAgICAgJG1hcHBpbmdzLkFkZCgkcG9ydCwgIlRDUCIsICRwb3J0LCAkbG9jYWxJUCwgJHRydWUsICJQdWxzZS1PY3RhLVRDUC0kcG9ydCIpIHwgT3V0LU51bGwNCiAgICAgICAgICAgICRtYXBwaW5ncy5BZGQoJHBvcnQsICJVRFAiLCAkcG9ydCwgJGxvY2FsSVAsICR0cnVlLCAiUHVsc2UtT2N0YS1VRFAtJHBvcnQiKSB8IE91dC1OdWxsDQogICAgICAgIH0NCiAgICAgICAgV3JpdGUtTG9nICJVUG5QIHN1Y2NlZWRlZCDigJQgcG9ydHMgJCgkT0NUQV9NR01UX1BPUlRTIC1qb2luICcsICcpLCAkT0NUQV9BUFBfUE9SVF9TVEFSVC0kT0NUQV9BUFBfUE9SVF9FTkQgZm9yd2FyZGVkIChUQ1ArVURQKSB0byAkbG9jYWxJUCIgIk9LIg0KICAgICAgICBTZXQtU3RlcCAiVVBuUCBwb3J0IGZvcndhcmRpbmciICJQQVNTIiAiQXV0by1mb3J3YXJkZWQgKFRDUCtVRFApIOKGkiAkbG9jYWxJUCINCiAgICAgICAgJHVwbnBPayA9ICR0cnVlDQogICAgfSBjYXRjaCB7DQogICAgICAgIFdyaXRlLUxvZyAiVVBuUCB1bmF2YWlsYWJsZSBvbiB0aGlzIHJvdXRlciIgIldBUk4iDQogICAgICAgIFNldC1TdGVwICJVUG5QIHBvcnQgZm9yd2FyZGluZyIgIldBUk4iICJVUG5QIHVuYXZhaWxhYmxlIOKAlCBtYW51YWwgcm91dGVyIHNldHVwIHJlcXVpcmVkIChUQ1ArVURQLCBzZWUgYWJvdmUpIg0KICAgIH0NCg0KICAgIGlmICgtbm90ICR1cG5wT2spIHsNCiAgICAgICAgV3JpdGUtSG9zdCAiIg0KICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUjOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUkCIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cNCiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgIFJPVVRFUiBTRVRVUCBSRVFVSVJFRCAob25lLXRpbWUsIH4yIG1pbnV0ZXMpICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cNCiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cNCiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgIFlvdXIgcm91dGVyIGRvZXNuJ3Qgc3VwcG9ydCBhdXRvLWZvcndhcmRpbmcgKFVQblAgb2ZmKS4gICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdw0KICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgT2N0YVNwYWNlIG5lZWRzIEJPVEggVENQIGFuZCBVRFAgZm9yd2FyZGVkLiAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93DQogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93DQogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICAxLiBPcGVuIHlvdXIgcm91dGVyIGFkbWluIHBhZ2UgKHVzdWFsbHkgaHR0cDovLzE5Mi4xNjguMS4xKeKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cNCiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgIDIuIEZpbmQgJ1BvcnQgRm9yd2FyZGluZycgb3IgJ1ZpcnR1YWwgU2VydmVyJyAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdw0KICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgMy4gQWRkIFRDUCtVRFAgcnVsZXMg4oaSICRsb2NhbElQIDogICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cNCiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgVENQK1VEUCAxODg4OCDihpIgJGxvY2FsSVBgOjE4ODg4ICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93DQogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAgIFRDUCtVRFAgJE9DVEFfQVBQX1BPUlRfU1RBUlQtJE9DVEFfQVBQX1BPUlRfRU5EIOKGkiAkbG9jYWxJUGA6JE9DVEFfQVBQX1BPUlRfU1RBUlQtJE9DVEFfQVBQX1BPUlRfRU5EIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cNCiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cNCiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgIFByZXNzIEVudGVyIG9uY2UgZG9uZSAoeW91IGNhbiBmaW5pc2ggdGhpcyBsYXRlciB2aWEgdGhlICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdw0KICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgUHVsc2UgZGFzaGJvYXJkIOKAlCBidXQgam9icyB3b24ndCBsYW5kIHVudGlsIGl0J3MgZG9uZSkgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cNCiAgICAgICAgV3JpdGUtSG9zdCAiICDilJTilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilJgiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93DQogICAgICAgIFJlYWQtSG9zdCAiICBQcmVzcyBFbnRlciB0byBjb250aW51ZSINCiAgICB9DQoNCiAgICAjIOKUgOKUgCBXU0wyIFBvcnQgUHJveHkgKFRDUCBvbmx5KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANCiAgICBpZiAoLW5vdCAkbWlycm9yZWROZXR3b3JraW5nKSB7DQogICAgICAgIFdyaXRlLUxvZyAiQ29uZmlndXJpbmcgV1NMMiBUQ1AgcG9ydCBwcm94eSAoV2luZG93cyBob3N0IOKGkiBXU0wyIGJyaWRnZSkuLi4iDQogICAgICAgICR3c2xJUCA9ICh3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tdXNlciByb290IC0tIGJhc2ggLWMgImhvc3RuYW1lIC1JIDI+L2Rldi9udWxsIikuVHJpbSgpLlNwbGl0KClbMF0NCiAgICAgICAgaWYgKCR3c2xJUCkgew0KICAgICAgICAgICAgU2V0LVdTTDJQb3J0UHJveHkgLVdzbElQICR3c2xJUA0KICAgICAgICAgICAgU2V0LUNvbnRlbnQgLVBhdGggIiRQVUxTRV9ESVJcbGFzdF93c2xfaXAiIC1WYWx1ZSAkd3NsSVAgLUVuY29kaW5nIFVURjgNCiAgICAgICAgICAgIFNldC1TdGVwICJXU0wyIHBvcnQgcHJveHkiICJQQVNTIiAiVENQIOKGkiAkd3NsSVAgKFVEUCByZXF1aXJlcyBtaXJyb3JlZCBuZXR3b3JraW5nKSINCiAgICAgICAgfSBlbHNlIHsNCiAgICAgICAgICAgIFdyaXRlLUxvZyAiQ291bGQgbm90IGRldGVybWluZSBXU0wyIElQIOKAlCBwb3J0cHJveHkgc2tpcHBlZDsgd2lsbCByZXRyeSBvbiBuZXh0IGxvZ2luIiAiV0FSTiINCiAgICAgICAgICAgIFNldC1TdGVwICJXU0wyIHBvcnQgcHJveHkiICJXQVJOIiAiV1NMMiBJUCBub3QgZm91bmQg4oCUIHdpbGwgcmV0cnkgb24gbmV4dCBsb2dpbiINCiAgICAgICAgfQ0KICAgIH0gZWxzZSB7DQogICAgICAgIFdyaXRlLUxvZyAiTWlycm9yZWQgbmV0d29ya2luZyBhY3RpdmUg4oCUIHBvcnRwcm94eSBub3QgbmVlZGVkOyBVRFAgdHVubmVscyBmdWxseSBmdW5jdGlvbmFsIiAiT0siDQogICAgICAgIFNldC1TdGVwICJXU0wyIHBvcnQgcHJveHkiICJTS0lQIiAiTm90IG5lZWRlZCDigJQgbWlycm9yZWQgbmV0d29ya2luZyBhY3RpdmUiDQogICAgfQ0KDQogICAgIyDilIDilIAgQ3ViZSByZWdpc3RyYXRpb24g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSADQogICAgV3JpdGUtSG9zdCAiIg0KICAgIFdyaXRlLUhvc3QgIiAg4pSM4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSQIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4NCiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgT0NUQVNQQUNFIENVQkUgUkVHSVNUUkFUSU9OICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBDeWFuDQogICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBDeWFuDQogICAgV3JpdGUtSG9zdCAiICDilIIgIFRvIGFwcGVhciBpbiB0aGUgT2N0YVNwYWNlIG1hcmtldHBsYWNlOiAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBDeWFuDQogICAgV3JpdGUtSG9zdCAiICDilIIgICAgMS4gT3BlbjogaHR0cHM6Ly9jdWJlLm9jdGEuY29tcHV0ZXIgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBDeWFuDQogICAgV3JpdGUtSG9zdCAiICDilIIgICAgMi4gU2lnbiBpbiAvIGNyZWF0ZSBhbiBhY2NvdW50ICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBDeWFuDQogICAgV3JpdGUtSG9zdCAiICDilIIgICAgMy4gQWRkIHlvdXIgbm9kZSDigJQgaXQgc2hvdWxkIGFwcGVhciBhdXRvbWF0aWNhbGx5ICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4NCiAgICBpZiAoJG9jdGFOb2RlVG9rZW4pIHsNCiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4NCiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICBZb3VyIG5vZGUgdG9rZW46ICRvY3RhTm9kZVRva2VuIiAtRm9yZWdyb3VuZENvbG9yIFdoaXRlDQogICAgfQ0KICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbg0KICAgIFdyaXRlLUhvc3QgIiAg4pSCICBUaGlzIHN0ZXAgaXMgZG9uZSBpbiB5b3VyIGJyb3dzZXIsIG5vdCB0aGlzIHdpbmRvdy4gICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbg0KICAgIFdyaXRlLUhvc3QgIiAg4pSU4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSYIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4NCiAgICBXcml0ZS1Ib3N0ICIiDQogICAgUmVhZC1Ib3N0ICIgIFByZXNzIEVudGVyIHRvIGNvbnRpbnVlIG9uY2UgeW91J3ZlIG5vdGVkIHRoZSBhYm92ZSINCg0KICAgICMg4pSA4pSAIFJlZ2lzdGVyIHdpdGggUHVsc2Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSADQogICAgV3JpdGUtTG9nICJSZWdpc3RlcmluZyBtYWNoaW5lIHdpdGggUHVsc2UuLi4iDQoNCiAgICAkYm9keSA9IEB7DQogICAgICAgIGdwdV9tb2RlbCAgICAgICAgPSAkZ3B1TmFtZQ0KICAgICAgICB2cmFtX2diICAgICAgICAgID0gJHZyYW1HYg0KICAgICAgICBvY3RhX25vZGVfdG9rZW4gID0gJG9jdGFOb2RlVG9rZW4NCiAgICAgICAgcGxhdGZvcm0gICAgICAgICA9ICJPY3RhU3BhY2UiDQogICAgfSB8IENvbnZlcnRUby1Kc29uDQoNCiAgICB0cnkgew0KICAgICAgICAkcmVzcCA9IEludm9rZS1SZXN0TWV0aG9kIC1VcmkgIiRQVUxTRV9BUElfQkFTRS9yZWdpc3Rlck9jdGFzcGFjZURhZW1vbiIgYA0KICAgICAgICAgICAgLU1ldGhvZCBQT1NUIGANCiAgICAgICAgICAgIC1Db250ZW50VHlwZSAiYXBwbGljYXRpb24vanNvbiIgYA0KICAgICAgICAgICAgLUhlYWRlcnMgQHsgIkF1dGhvcml6YXRpb24iID0gIkJlYXJlciAkUFVMU0VfVVNFUl9UT0tFTiIgfSBgDQogICAgICAgICAgICAtQm9keSAkYm9keQ0KICAgICAgICBXcml0ZS1Mb2cgIlB1bHNlIHJlZ2lzdHJhdGlvbjogJCgkcmVzcC5tZXNzYWdlKSIgIk9LIg0KICAgICAgICBTZXQtU3RlcCAiUHVsc2UgcmVnaXN0cmF0aW9uIiAiUEFTUyINCiAgICB9IGNhdGNoIHsNCiAgICAgICAgV3JpdGUtTG9nICJQdWxzZSByZWdpc3RyYXRpb24gZmFpbGVkICh3aWxsIHJldHJ5IG9uIG5leHQgc3RhcnQpOiAkXyIgIldBUk4iDQogICAgICAgIFNldC1TdGVwICJQdWxzZSByZWdpc3RyYXRpb24iICJXQVJOIiAiV2lsbCByZXRyeSBhdXRvbWF0aWNhbGx5IG9uIG5leHQgbG9naW4iDQogICAgfQ0KDQogICAgIyDilIDilIAgR1BVIFdhdGNoZG9nOiBwYXVzZSBvc24gZHVyaW5nIGdhbWluZyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANCiAgICBXcml0ZS1Mb2cgIkluc3RhbGxpbmcgR1BVIGdhbWluZyB3YXRjaGRvZy4uLiINCiAgICAkd2F0Y2hkb2cgPSBAJw0KJGhpID0gNzU7ICRsbyA9IDIwOyAkcGF1c2VkID0gJGZhbHNlDQokdmVuZG9yID0gaWYgKEdldC1XbWlPYmplY3QgV2luMzJfVmlkZW9Db250cm9sbGVyIHwgV2hlcmUtT2JqZWN0IHsgJF8uTmFtZSAtbWF0Y2ggJ05WSURJQXxHZUZvcmNlfFJUWHxHVFgnIH0gfCBTZWxlY3QtT2JqZWN0IC1GaXJzdCAxKSB7ICdOVklESUEnIH0gZWxzZSB7ICdBTUQnIH0NCndoaWxlICgkdHJ1ZSkgew0KICAgIHRyeSB7DQogICAgICAgICR1dGlsID0gaWYgKCR2ZW5kb3IgLWVxICdOVklESUEnKSB7DQogICAgICAgICAgICBbaW50XSgmIG52aWRpYS1zbWkgLS1xdWVyeS1ncHU9dXRpbGl6YXRpb24uZ3B1IC0tZm9ybWF0PWNzdixub2hlYWRlcixub3VuaXRzIDI+JG51bGwpLlRyaW0oKQ0KICAgICAgICB9IGVsc2Ugew0KICAgICAgICAgICAgJHMgPSBHZXQtQ291bnRlciAnXEdQVSBFbmdpbmUoKmVuZ3R5cGVfM0QpXFV0aWxpemF0aW9uIFBlcmNlbnRhZ2UnIC1FcnJvckFjdGlvbiBTaWxlbnRseUNvbnRpbnVlDQogICAgICAgICAgICBpZiAoJHMpIHsgW2ludF0oJHMuQ291bnRlclNhbXBsZXMgfCBNZWFzdXJlLU9iamVjdCAtUHJvcGVydHkgQ29va2VkVmFsdWUgLU1heGltdW0pLk1heGltdW0gfSBlbHNlIHsgMCB9DQogICAgICAgIH0NCiAgICAgICAgaWYgKCR1dGlsIC1ndCAkaGkgLWFuZCAtbm90ICRwYXVzZWQpIHsNCiAgICAgICAgICAgIHdzbCAtZCBVYnVudHUtMjIuMDQgLS0gYmFzaCAtYyAic3VkbyBzeXN0ZW1jdGwgc3RvcCBvc24gMj4vZGV2L251bGwiDQogICAgICAgICAgICAkcGF1c2VkID0gJHRydWUNCiAgICAgICAgICAgIEFkZC1Db250ZW50ICIkZW52OkxPQ0FMQVBQREFUQVxQdWxzZVxvY3RhX3dhdGNoZG9nLmxvZyIgIiQoR2V0LURhdGUgLWYgJ0hIOm1tJykgUEFVU0VEIChHUFUgJHV0aWwlKSINCiAgICAgICAgfSBlbHNlaWYgKCR1dGlsIC1sdCAkbG8gLWFuZCAkcGF1c2VkKSB7DQogICAgICAgICAgICB3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tIGJhc2ggLWMgInN1ZG8gc3lzdGVtY3RsIHN0YXJ0IG9zbiAyPi9kZXYvbnVsbCINCiAgICAgICAgICAgICRwYXVzZWQgPSAkZmFsc2UNCiAgICAgICAgICAgIEFkZC1Db250ZW50ICIkZW52OkxPQ0FMQVBQREFUQVxQdWxzZVxvY3RhX3dhdGNoZG9nLmxvZyIgIiQoR2V0LURhdGUgLWYgJ0hIOm1tJykgUkVTVU1FRCAoR1BVICR1dGlsJSkiDQogICAgICAgIH0NCiAgICB9IGNhdGNoIHt9DQogICAgU3RhcnQtU2xlZXAgMzANCn0NCidADQogICAgJHdhdGNoZG9nUGF0aCA9ICIkUFVMU0VfRElSXG9jdGFfd2F0Y2hkb2cucHMxIg0KICAgIFNldC1Db250ZW50IC1QYXRoICR3YXRjaGRvZ1BhdGggLVZhbHVlICR3YXRjaGRvZyAtRW5jb2RpbmcgVVRGOA0KDQogICAgJHdBID0gTmV3LVNjaGVkdWxlZFRhc2tBY3Rpb24gLUV4ZWN1dGUgInBvd2Vyc2hlbGwuZXhlIiBgDQogICAgICAgIC1Bcmd1bWVudCAiLU5vUHJvZmlsZSAtRXhlY3V0aW9uUG9saWN5IEJ5cGFzcyAtV2luZG93U3R5bGUgSGlkZGVuIC1GaWxlIGAiJHdhdGNoZG9nUGF0aGAiIg0KICAgICR3VCA9IE5ldy1TY2hlZHVsZWRUYXNrVHJpZ2dlciAtQXRMb2dPbg0KICAgICR3UyA9IE5ldy1TY2hlZHVsZWRUYXNrU2V0dGluZ3NTZXQgLUFsbG93U3RhcnRJZk9uQmF0dGVyaWVzIC1FeGVjdXRpb25UaW1lTGltaXQgMA0KICAgICR3UCA9IE5ldy1TY2hlZHVsZWRUYXNrUHJpbmNpcGFsIC1Vc2VySWQgJGVudjpVU0VSTkFNRSAtUnVuTGV2ZWwgSGlnaGVzdA0KICAgIFJlZ2lzdGVyLVNjaGVkdWxlZFRhc2sgLVRhc2tOYW1lICRXQVRDSERPR19UQVNLIC1BY3Rpb24gJHdBIC1UcmlnZ2VyICR3VCBgDQogICAgICAgIC1TZXR0aW5ncyAkd1MgLVByaW5jaXBhbCAkd1AgLUZvcmNlIHwgT3V0LU51bGwNCiAgICBXcml0ZS1Mb2cgIkdQVSB3YXRjaGRvZyBpbnN0YWxsZWQgKHBhdXNlcyBkdXJpbmcgZ2FtaW5nLCByZXN1bWVzIHdoZW4gaWRsZSkiICJPSyINCiAgICBTZXQtU3RlcCAiR1BVIHdhdGNoZG9nIHRhc2siICJQQVNTIg0KDQogICAgIyDilIDilIAgQXV0by1zdGFydDogb3NuIG9uIGV2ZXJ5IGxvZ2luIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KICAgIFdyaXRlLUxvZyAiSW5zdGFsbGluZyBhdXRvLXN0YXJ0IHRhc2suLi4iDQogICAgJGF1dG9zdGFydCA9IGlmICgkbWlycm9yZWROZXR3b3JraW5nKSB7DQogICAgICAgIEAnDQpTdGFydC1TbGVlcCAxNQ0Kd3NsIC1kIFVidW50dS0yMi4wNCAtLSBiYXNoIC1jICdzdWRvIHN5c3RlbWN0bCBzdGFydCBvc24gMj4vZGV2L251bGwnIDI+JjEgfA0KICAgIEFkZC1Db250ZW50ICIkZW52OkxPQ0FMQVBQREFUQVxQdWxzZVxvY3RhX2F1dG9zdGFydC5sb2ciDQonQA0KICAgIH0gZWxzZSB7DQogICAgICAgIEAiDQpTdGFydC1TbGVlcCAxNQ0KYCR3c2xJUCA9ICh3c2wgLWQgVWJ1bnR1LTIyLjA0IC0tdXNlciByb290IC0tIGJhc2ggLWMgJ2hvc3RuYW1lIC1JIDI+L2Rldi9udWxsJykuVHJpbSgpLlNwbGl0KClbMF0NCmAkbGFzdElQRmlsZSA9ICJgJGVudjpMT0NBTEFQUERBVEFcUHVsc2VcbGFzdF93c2xfaXAiDQpgJGxhc3RJUCA9IGlmIChUZXN0LVBhdGggYCRsYXN0SVBGaWxlKSB7IChHZXQtQ29udGVudCBgJGxhc3RJUEZpbGUpLlRyaW0oKSB9IGVsc2UgeyAnJyB9DQppZiAoYCR3c2xJUCAtYW5kIGAkd3NsSVAgLW5lIGAkbGFzdElQKSB7DQogICAgKEAoMTg4ODgpICsgKDUxODAwLi41MTgxNikpIHwgRm9yRWFjaC1PYmplY3Qgew0KICAgICAgICBuZXRzaCBpbnRlcmZhY2UgcG9ydHByb3h5IGRlbGV0ZSB2NHRvdjQgbGlzdGVucG9ydD1gJF8gbGlzdGVuYWRkcmVzcz0wLjAuMC4wIHwgT3V0LU51bGwNCiAgICAgICAgbmV0c2ggaW50ZXJmYWNlIHBvcnRwcm94eSBhZGQgdjR0b3Y0IGxpc3RlbnBvcnQ9YCRfIGxpc3RlbmFkZHJlc3M9MC4wLjAuMCBjb25uZWN0cG9ydD1gJF8gY29ubmVjdGFkZHJlc3M9YCR3c2xJUCB8IE91dC1OdWxsDQogICAgfQ0KICAgIFNldC1Db250ZW50IC1QYXRoIGAkbGFzdElQRmlsZSAtVmFsdWUgYCR3c2xJUA0KfQ0Kd3NsIC1kIFVidW50dS0yMi4wNCAtLSBiYXNoIC1jICdzdWRvIHN5c3RlbWN0bCBzdGFydCBvc24gMj4vZGV2L251bGwnIDI+JjEgfA0KICAgIEFkZC1Db250ZW50ICJgJGVudjpMT0NBTEFQUERBVEFcUHVsc2Vcb2N0YV9hdXRvc3RhcnQubG9nIg0KIkANCiAgICB9DQogICAgJHN0YXJ0UGF0aCA9ICIkUFVMU0VfRElSXG9jdGFfYXV0b3N0YXJ0LnBzMSINCiAgICBTZXQtQ29udGVudCAtUGF0aCAkc3RhcnRQYXRoIC1WYWx1ZSAkYXV0b3N0YXJ0IC1FbmNvZGluZyBVVEY4DQoNCiAgICAkc0EgPSBOZXctU2NoZWR1bGVkVGFza0FjdGlvbiAtRXhlY3V0ZSAicG93ZXJzaGVsbC5leGUiIGANCiAgICAgICAgLUFyZ3VtZW50ICItTm9Qcm9maWxlIC1FeGVjdXRpb25Qb2xpY3kgQnlwYXNzIC1XaW5kb3dTdHlsZSBIaWRkZW4gLUZpbGUgYCIkc3RhcnRQYXRoYCIiDQogICAgJHNUID0gTmV3LVNjaGVkdWxlZFRhc2tUcmlnZ2VyIC1BdExvZ09uDQogICAgJHNTID0gTmV3LVNjaGVkdWxlZFRhc2tTZXR0aW5nc1NldCAtQWxsb3dTdGFydElmT25CYXR0ZXJpZXMgLUV4ZWN1dGlvblRpbWVMaW1pdCAwDQogICAgJHNQID0gTmV3LVNjaGVkdWxlZFRhc2tQcmluY2lwYWwgLVVzZXJJZCAkZW52OlVTRVJOQU1FIC1SdW5MZXZlbCBIaWdoZXN0DQogICAgUmVnaXN0ZXItU2NoZWR1bGVkVGFzayAtVGFza05hbWUgJEFVVE9TVEFSVF9UQVNLIC1BY3Rpb24gJHNBIC1UcmlnZ2VyICRzVCBgDQogICAgICAgIC1TZXR0aW5ncyAkc1MgLVByaW5jaXBhbCAkc1AgLUZvcmNlIHwgT3V0LU51bGwNCiAgICBXcml0ZS1Mb2cgIkF1dG8tc3RhcnQgaW5zdGFsbGVkIiAiT0siDQogICAgU2V0LVN0ZXAgIkF1dG8tc3RhcnQgdGFzayIgIlBBU1MiDQoNCiAgICAjIOKUgOKUgCBBdXRvLWxvZ2luOiBzdXJ2aXZlIHVuYXR0ZW5kZWQgcmVib290cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANCiAgICBXcml0ZS1Ib3N0ICIiDQogICAgV3JpdGUtSG9zdCAiICDilIzilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilJAiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93DQogICAgV3JpdGUtSG9zdCAiICDilIIgIEFVVE8tTE9HSU4gKHJlY29tbWVuZGVkIGZvciBkZWRpY2F0ZWQgR1BVIHNlcnZlcnMpICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cNCiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdw0KICAgIFdyaXRlLUhvc3QgIiAg4pSCICBXaXRob3V0IHRoaXMsIE9jdGFTcGFjZSBnb2VzIE9GRkxJTkUgYWZ0ZXIgYW55IHVuYXR0ZW5kZWQgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cNCiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgcmVib290IChwb3dlciBjdXQsIFdpbmRvd3MgVXBkYXRlKSB1bnRpbCBzb21lb25lIGxvZ3MgaW4uICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93DQogICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cNCiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgVHJhZGUtb2ZmOiBzdG9yZXMgeW91ciBXaW5kb3dzIHBhc3N3b3JkIGluIHRoZSByZWdpc3RyeS4gICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93DQogICAgV3JpdGUtSG9zdCAiICDilIIgIE9ubHkgZW5hYmxlIGlmIHRoaXMgbWFjaGluZSBpcyBpbiBhIHBoeXNpY2FsbHkgc2VjdXJlIHNwb3Qu4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdw0KICAgIFdyaXRlLUhvc3QgIiAg4pSCICBUbyB1bmRvIGxhdGVyOiBydW4gbmV0cGx3aXogYW5kIHJlLWVuYWJsZSBwYXNzd29yZCBwcm9tcHQuIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cNCiAgICBXcml0ZS1Ib3N0ICIgIOKUlOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUmCIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cNCiAgICBXcml0ZS1Ib3N0ICIiDQogICAgJGRvQXV0b0xvZ2luID0gUmVhZC1Ib3N0ICIgIEVuYWJsZSBhdXRvLWxvZ2luPyAoeS9OKSINCiAgICBpZiAoJGRvQXV0b0xvZ2luIC1tYXRjaCAnXltZeV0nKSB7DQogICAgICAgICRzZWN1cmVQYXNzID0gUmVhZC1Ib3N0ICIgIEVudGVyIHlvdXIgV2luZG93cyBsb2dpbiBwYXNzd29yZCIgLUFzU2VjdXJlU3RyaW5nDQogICAgICAgICRic3RyICAgICAgPSBbUnVudGltZS5JbnRlcm9wU2VydmljZXMuTWFyc2hhbF06OlNlY3VyZVN0cmluZ1RvQlNUUigkc2VjdXJlUGFzcykNCiAgICAgICAgJHBsYWluUGFzcyA9IFtSdW50aW1lLkludGVyb3BTZXJ2aWNlcy5NYXJzaGFsXTo6UHRyVG9TdHJpbmdBdXRvKCRic3RyKQ0KICAgICAgICBbUnVudGltZS5JbnRlcm9wU2VydmljZXMuTWFyc2hhbF06Olplcm9GcmVlQlNUUigkYnN0cikNCg0KICAgICAgICAkcmVnUGF0aCA9ICJIS0xNOlxTT0ZUV0FSRVxNaWNyb3NvZnRcV2luZG93cyBOVFxDdXJyZW50VmVyc2lvblxXaW5sb2dvbiINCiAgICAgICAgU2V0LUl0ZW1Qcm9wZXJ0eSAtUGF0aCAkcmVnUGF0aCAtTmFtZSAiQXV0b0FkbWluTG9nb24iICAgLVZhbHVlICIxIiAgICAgICAgICAgICAtVHlwZSBTdHJpbmcNCiAgICAgICAgU2V0LUl0ZW1Qcm9wZXJ0eSAtUGF0aCAkcmVnUGF0aCAtTmFtZSAiRGVmYXVsdFVzZXJuYW1lIiAgIC1WYWx1ZSAkZW52OlVTRVJOQU1FICAgLVR5cGUgU3RyaW5nDQogICAgICAgIFNldC1JdGVtUHJvcGVydHkgLVBhdGggJHJlZ1BhdGggLU5hbWUgIkRlZmF1bHREb21haW5OYW1lIiAtVmFsdWUgJGVudjpVU0VSRE9NQUlOIC1UeXBlIFN0cmluZw0KICAgICAgICBTZXQtSXRlbVByb3BlcnR5IC1QYXRoICRyZWdQYXRoIC1OYW1lICJEZWZhdWx0UGFzc3dvcmQiICAgLVZhbHVlICRwbGFpblBhc3MgICAgICAtVHlwZSBTdHJpbmcNCiAgICAgICAgJHBsYWluUGFzcyA9ICRudWxsOyBbU3lzdGVtLkdDXTo6Q29sbGVjdCgpDQoNCiAgICAgICAgV3JpdGUtTG9nICJBdXRvLWxvZ2luIGVuYWJsZWQgZm9yICRlbnY6VVNFUk5BTUUg4oCUIE9jdGFTcGFjZSByZXN1bWVzIGF1dG9tYXRpY2FsbHkgYWZ0ZXIgYW55IHJlYm9vdCIgIk9LIg0KICAgICAgICBXcml0ZS1Mb2cgIlRvIGRpc2FibGU6IHJ1biBuZXRwbHdpeiBhbmQgcmUtY2hlY2sgJ1VzZXJzIG11c3QgZW50ZXIgYSB1c2VybmFtZSBhbmQgcGFzc3dvcmQnIiAiSU5GTyINCiAgICAgICAgU2V0LVN0ZXAgIkF1dG8tbG9naW4iICJQQVNTIiAiRW5hYmxlZCBmb3IgJGVudjpVU0VSTkFNRSINCiAgICB9IGVsc2Ugew0KICAgICAgICBXcml0ZS1Mb2cgIkF1dG8tbG9naW4gc2tpcHBlZCDigJQgbWFjaGluZSB3aWxsIG5lZWQgYSBtYW51YWwgbG9naW4gYWZ0ZXIgcmVib290IHRvIHJlc3VtZSBPY3RhU3BhY2UiICJXQVJOIg0KICAgICAgICBTZXQtU3RlcCAiQXV0by1sb2dpbiIgIlNLSVAiICJTa2lwcGVkIOKAlCBHUFUgZ29lcyBvZmZsaW5lIGFmdGVyIHVuYXR0ZW5kZWQgcmVib290cyINCiAgICB9DQoNCiAgICAjIOKUgOKUgCBDbGVhbnVwIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KICAgIHNjaHRhc2tzIC9kZWxldGUgL3RuICRUQVNLX05BTUUgL2YgMj4kbnVsbCB8IE91dC1OdWxsDQogICAgUmVtb3ZlLUl0ZW0gJFBIQVNFX0ZJTEUgLUVycm9yQWN0aW9uIFNpbGVudGx5Q29udGludWUNCg0KICAgICMg4pSA4pSAIFN1bW1hcnkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSADQogICAgIyBXcml0ZSBmaW5hbCBkaWFnbm9zdGljcyBzbmFwc2hvdCB0byBsb2cgKHNjcmVlbiBvdXRwdXQgaXMgdGhlIGNsZWFuIHN1bW1hcnkgYmVsb3cpDQogICAgU2hvdy1EaWFnbm9zdGljcyAtTG9nT25seQ0KDQogICAgU2hvdy1CYW5uZXIgIlNldHVwIENvbXBsZXRlIg0KICAgIFdyaXRlLUhvc3QgIiAgWW91ciBHUFUgaXMgbm93IGVhcm5pbmcgdmlhIFB1bHNlICsgT2N0YVNwYWNlLiIgLUZvcmVncm91bmRDb2xvciBHcmVlbg0KICAgIFdyaXRlLUhvc3QgIiINCiAgICBAKA0KICAgICAgICBAeyBMID0gIkdQVSI7ICAgICAgICAgIFYgPSAkZ3B1TmFtZSB9LA0KICAgICAgICBAeyBMID0gIlZSQU0iOyAgICAgICAgIFYgPSAiJHt2cmFtR2J9IEdCIiB9LA0KICAgICAgICBAeyBMID0gIlBsYXRmb3JtIjsgICAgIFYgPSAiT2N0YVNwYWNlICh2aWEgUHVsc2UpIiB9LA0KICAgICAgICBAeyBMID0gIk5vZGUgdG9rZW4iOyAgIFYgPSBpZiAoJG9jdGFOb2RlVG9rZW4pIHsgJG9jdGFOb2RlVG9rZW4gfSBlbHNlIHsgIlBlbmRpbmcg4oCUIGNoZWNrIGN1YmUub2N0YS5jb21wdXRlciIgfSB9LA0KICAgICAgICBAeyBMID0gIkdhbWluZyBwYXVzZSI7IFYgPSAiQXV0byAoR1BVID4gNzUlIHV0aWwpIiB9LA0KICAgICAgICBAeyBMID0gIkF1dG8tc3RhcnQiOyAgIFYgPSAiT24gZXZlcnkgV2luZG93cyBsb2dpbiIgfSwNCiAgICAgICAgQHsgTCA9ICJMb2dzIjsgICAgICAgICBWID0gJExPR19GSUxFIH0NCiAgICApIHwgRm9yRWFjaC1PYmplY3QgeyBXcml0ZS1Ib3N0ICgiICB7MCwtMTZ9IHsxfSIgLWYgJF8uTCwgJF8uVikgLUZvcmVncm91bmRDb2xvciBXaGl0ZSB9DQogICAgV3JpdGUtSG9zdCAiIg0KICAgIFdyaXRlLUhvc3QgIiAgRGFzaGJvYXJkOiAgaHR0cHM6Ly9iZW5lZmljaWFsLWRlZXAtd29yay1mbG93LmJhc2U0NC5hcHAiIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbg0KICAgIFdyaXRlLUhvc3QgIiAgQ3ViZTogICAgICAgaHR0cHM6Ly9jdWJlLm9jdGEuY29tcHV0ZXIiIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbg0KICAgIFdyaXRlLUhvc3QgIiINCiAgICBXcml0ZS1Ib3N0ICIgIOKUjOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUkCIgLUZvcmVncm91bmRDb2xvciBEYXJrR3JheQ0KICAgIFdyaXRlLUhvc3QgIiAg4pSCICBJTlNUQUxMIExPRyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkNCiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5DQogICAgV3JpdGUtSG9zdCAiICDilIIgIEEgZnVsbCBsb2cgb2YgZXZlcnkgaW5zdGFsbCBzdGVwIHdhcyBzYXZlZCB0bzogICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBEYXJrR3JheQ0KICAgIFdyaXRlLUhvc3QgKCIgIOKUgiAgICB7MCwtNjB94pSCIiAtZiAkTE9HX0ZJTEUpIC1Gb3JlZ3JvdW5kQ29sb3IgV2hpdGUNCiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5DQogICAgV3JpdGUtSG9zdCAiICDilIIgIFRvIG9wZW4gaXQ6ICAgbm90ZXBhZCBgIiRMT0dfRklMRWAiIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5DQogICAgV3JpdGUtSG9zdCAiICDilIIgIFRvIGJyb3dzZTogICAgUnVuIOKGkiAlTE9DQUxBUFBEQVRBJVxQdWxzZSAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5DQogICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBEYXJrR3JheQ0KICAgIFdyaXRlLUhvc3QgIiAg4pSCICBTaGFyZSBpdCB3aXRoIFB1bHNlIHN1cHBvcnQgaWYgYW55dGhpbmcgbG9va3Mgd3JvbmcuICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkNCiAgICBXcml0ZS1Ib3N0ICIgIOKUlOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUmCIgLUZvcmVncm91bmRDb2xvciBEYXJrR3JheQ0KICAgIFdyaXRlLUhvc3QgIiINCiAgICBXYWl0LUZvcktleQ0KfQ0KDQojIOKUgOKUgCBFbnRyeSBQb2ludCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANCg0KdHJhcCB7DQogICAgV3JpdGUtSG9zdCAiIg0KICAgIFdyaXRlLUhvc3QgIiAgW0VSUk9SXSBBbiB1bmV4cGVjdGVkIGVycm9yIHN0b3BwZWQgdGhlIGluc3RhbGxlcjoiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkDQogICAgV3JpdGUtSG9zdCAiICAkXyIgLUZvcmVncm91bmRDb2xvciBSZWQNCiAgICBTaG93LURpYWdub3N0aWNzDQogICAgUmVhZC1Ib3N0ICIgIFByZXNzIEVudGVyIHRvIGNsb3NlIHRoaXMgd2luZG93Ig0KICAgIGV4aXQgMQ0KfQ0KDQpBc3NlcnQtQWRtaW4NCk5ldy1JdGVtIC1JdGVtVHlwZSBEaXJlY3RvcnkgLUZvcmNlIC1QYXRoICRQVUxTRV9ESVIgfCBPdXQtTnVsbA0KDQokcGhhc2UgPSBpZiAoVGVzdC1QYXRoICRQSEFTRV9GSUxFKSB7IEdldC1Db250ZW50ICRQSEFTRV9GSUxFIH0gZWxzZSB7ICIxIiB9DQpzd2l0Y2ggKCRwaGFzZSkgew0KICAgICIxIiAgICAgeyBJbnZva2UtUGhhc2UxIH0NCiAgICAiMiIgICAgIHsgSW52b2tlLVBoYXNlMiB9DQogICAgZGVmYXVsdCB7IFdyaXRlLUhvc3QgIlVua25vd24gcGhhc2U6ICRwaGFzZSIgLUZvcmVncm91bmRDb2xvciBSZWQ7IFdhaXQtRm9yS2V5OyBleGl0IDEgfQ0KfQ0K';
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