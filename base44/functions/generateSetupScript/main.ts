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
const OCTA_PS1_B64 = 'I1JlcXVpcmVzIC1WZXJzaW9uIDUuMQo8IwouU1lOT1BTSVMKICAgIFBVTFNFIEdQVSBQcm92aWRlciBTZXR1cCDigJQgT2N0YVNwYWNlIEluc3RhbGxlcgouREVTQ1JJUFRJT04KICAgIFBoYXNlIDE6IEVuYWJsZXMgV1NMMiwgc2NoZWR1bGVzIFBoYXNlIDIgdG8gcnVuIGFmdGVyIHJlYm9vdC4KICAgIFBoYXNlIDI6IEluc3RhbGxzIFVidW50dSwgT2N0YVNwYWNlIG5vZGUgKG9zbiksIHNldHMgdXAgbmV0d29ya2luZwogICAgICAgICAgICAgKFVQblAgKyBwb3J0cHJveHkgZm9yIFRDUCwgbWlycm9yZWQgbmV0d29ya2luZyByZWNvbW1lbmRlZCBmb3IgVURQKSwKICAgICAgICAgICAgIEdQVSBnYW1pbmcgZGV0ZWN0aW9uLCBhbmQgYXV0by1zdGFydC4KCiAgICBFbWJlZGRlZCBhdCBkb3dubG9hZCB0aW1lIGJ5IFB1bHNlJ3MgZ2VuZXJhdGVTZXR1cFNjcmlwdCBmdW5jdGlvbjoKICAgICAgUFVMU0VfVVNFUl9UT0tFTiDigJQgdXNlcidzIHNlc3Npb24gdG9rZW4gZm9yIFB1bHNlIEFQSSBjYWxsYmFjawogICAgICBQVUxTRV9BUFBfSUQgICAgIOKAlCBiYXNlNDQgYXBwIElECiM+CgojIOKUgOKUgCBFbWJlZGRlZCBieSBzZXJ2ZXIgYXQgZG93bmxvYWQgdGltZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKJFBVTFNFX1VTRVJfVE9LRU4gPSAie3tQVUxTRV9VU0VSX1RPS0VOfX0iCiRQVUxTRV9BUFBfSUQgICAgID0gInt7UFVMU0VfQVBQX0lEfX0iCiRQVUxTRV9BUElfQkFTRSAgID0gImh0dHBzOi8vYXBpLmJhc2U0NC5hcHAvYXBpL2FwcHMvJFBVTFNFX0FQUF9JRC9mdW5jdGlvbnMiCiMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgokUFVMU0VfRElSICAgICAgPSAiJGVudjpMT0NBTEFQUERBVEFcUHVsc2UiCiRQSEFTRV9GSUxFICAgICA9ICIkUFVMU0VfRElSXG9jdGFfc2V0dXBfcGhhc2UiCiRMT0dfRklMRSAgICAgICA9ICIkUFVMU0VfRElSXG9jdGFfc2V0dXAubG9nIgokVEFTS19OQU1FICAgICAgPSAiUHVsc2VPY3RhU2V0dXBSZXN1bWUiCiRXQVRDSERPR19UQVNLICA9ICJQdWxzZU9jdGFXYXRjaGRvZyIKJEFVVE9TVEFSVF9UQVNLID0gIlB1bHNlT2N0YUF1dG9TdGFydCIKCiMgT2N0YVNwYWNlIHBvcnRzIOKAlCBtYW5hZ2VtZW50IChBUEkpIGFuZCBlbmNyeXB0ZWQgdHVubmVsIHJhbmdlIChUQ1ArVURQKQokT0NUQV9NR01UX1BPUlRTICAgICA9IEAoMTg4ODgpCiRPQ1RBX0FQUF9QT1JUX1NUQVJUID0gNTE4MDAKJE9DVEFfQVBQX1BPUlRfRU5EICAgPSA1MTgxNgoKIyDilIDilIAgSGVscGVycyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCmZ1bmN0aW9uIFdyaXRlLUxvZyB7CiAgICBwYXJhbShbc3RyaW5nXSRtc2csIFtzdHJpbmddJGxldmVsID0gIklORk8iKQogICAgJHRzID0gR2V0LURhdGUgLUZvcm1hdCAiSEg6bW06c3MiCiAgICBBZGQtQ29udGVudCAtUGF0aCAkTE9HX0ZJTEUgLVZhbHVlICJbJHRzXVskbGV2ZWxdICRtc2ciIC1FbmNvZGluZyBVVEY4CiAgICBzd2l0Y2ggKCRsZXZlbCkgewogICAgICAgICJPSyIgICAgeyBXcml0ZS1Ib3N0ICIgIFtPS10gJG1zZyIgLUZvcmVncm91bmRDb2xvciBHcmVlbiB9CiAgICAgICAgIldBUk4iICB7IFdyaXRlLUhvc3QgIiAgWyEhXSAkbXNnIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdyB9CiAgICAgICAgIkVSUk9SIiB7IFdyaXRlLUhvc3QgIiAgW1hdICAkbXNnIiAtRm9yZWdyb3VuZENvbG9yIFJlZCB9CiAgICAgICAgZGVmYXVsdCB7IFdyaXRlLUhvc3QgIiAgLi4uICRtc2ciIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbiB9CiAgICB9Cn0KCmZ1bmN0aW9uIFNob3ctQmFubmVyIHsKICAgIHBhcmFtKFtzdHJpbmddJHN1YnRpdGxlID0gIiIpCiAgICBDbGVhci1Ib3N0CiAgICBXcml0ZS1Ib3N0ICIiCiAgICBXcml0ZS1Ib3N0ICIgIOKWiOKWiOKWiOKWiOKWiOKWiOKVlyDilojilojilZcgICDilojilojilZfilojilojilZcgICAgIOKWiOKWiOKWiOKWiOKWiOKWiOKWiOKVl+KWiOKWiOKWiOKWiOKWiOKWiOKWiOKVlyIgLUZvcmVncm91bmRDb2xvciBNYWdlbnRhCiAgICBXcml0ZS1Ib3N0ICIgIOKWiOKWiOKVlOKVkOKVkOKWiOKWiOKVl+KWiOKWiOKVkSAgIOKWiOKWiOKVkeKWiOKWiOKVkSAgICAg4paI4paI4pWU4pWQ4pWQ4pWQ4pWQ4pWd4paI4paI4pWU4pWQ4pWQ4pWQ4pWQ4pWdIiAtRm9yZWdyb3VuZENvbG9yIE1hZ2VudGEKICAgIFdyaXRlLUhvc3QgIiAg4paI4paI4paI4paI4paI4paI4pWU4pWd4paI4paI4pWRICAg4paI4paI4pWR4paI4paI4pWRICAgICDilojilojilojilojilojilojilojilZfilojilojilojilojilojilZcgICIgLUZvcmVncm91bmRDb2xvciBNYWdlbnRhCiAgICBXcml0ZS1Ib3N0ICIgIOKWiOKWiOKVlOKVkOKVkOKVkOKVnSDilojilojilZEgICDilojilojilZHilojilojilZEgICAgIOKVmuKVkOKVkOKVkOKVkOKWiOKWiOKVkeKWiOKWiOKVlOKVkOKVkOKVnSAgIiAtRm9yZWdyb3VuZENvbG9yIE1hZ2VudGEKICAgIFdyaXRlLUhvc3QgIiAg4paI4paI4pWRICAgICDilZrilojilojilojilojilojilojilZTilZ3ilojilojilojilojilojilojilojilZfilojilojilojilojilojilojilojilZHilojilojilojilojilojilojilojilZciIC1Gb3JlZ3JvdW5kQ29sb3IgTWFnZW50YQogICAgV3JpdGUtSG9zdCAiICDilZrilZDilZ0gICAgICDilZrilZDilZDilZDilZDilZDilZ0g4pWa4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWd4pWa4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWd4pWa4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWdIiAtRm9yZWdyb3VuZENvbG9yIE1hZ2VudGEKICAgIFdyaXRlLUhvc3QgIiIKICAgIFdyaXRlLUhvc3QgIiAgR1BVIFByb3ZpZGVyIFNldHVwIOKAlCBPY3RhU3BhY2UiIC1Gb3JlZ3JvdW5kQ29sb3IgV2hpdGUKICAgIGlmICgkc3VidGl0bGUpIHsgV3JpdGUtSG9zdCAiICAkc3VidGl0bGUiIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkgfQogICAgV3JpdGUtSG9zdCAiIgp9CgpmdW5jdGlvbiBBc3NlcnQtQWRtaW4gewogICAgaWYgKC1ub3QgKFtTZWN1cml0eS5QcmluY2lwYWwuV2luZG93c1ByaW5jaXBhbF1bU2VjdXJpdHkuUHJpbmNpcGFsLldpbmRvd3NJZGVudGl0eV06OkdldEN1cnJlbnQoKSkuSXNJblJvbGUoCiAgICAgICAgW1NlY3VyaXR5LlByaW5jaXBhbC5XaW5kb3dzQnVpbHRJblJvbGVdOjpBZG1pbmlzdHJhdG9yKSkgewogICAgICAgIFdyaXRlLUhvc3QgIiAgUmVsYXVuY2hpbmcgYXMgQWRtaW5pc3RyYXRvci4uLiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgICAgICBTdGFydC1Qcm9jZXNzIHBvd2Vyc2hlbGwgIi1Ob1Byb2ZpbGUgLUV4ZWN1dGlvblBvbGljeSBCeXBhc3MgLUZpbGUgYCIkUFNDb21tYW5kUGF0aGAiIiAtVmVyYiBSdW5BcwogICAgICAgIGV4aXQKICAgIH0KfQoKZnVuY3Rpb24gV2FpdC1Gb3JLZXkgewogICAgV3JpdGUtSG9zdCAiIgogICAgUmVhZC1Ib3N0ICIgIFByZXNzIEVudGVyIHRvIGNsb3NlIHRoaXMgd2luZG93Igp9CgojIOKUgOKUgCBEaWFnbm9zdGljcyBjaGVja2xpc3Qg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiRzY3JpcHQ6U3RlcHMgPSBbb3JkZXJlZF1Ae30KCmZ1bmN0aW9uIFJlZ2lzdGVyLVN0ZXAgewogICAgcGFyYW0oW3N0cmluZ10kbmFtZSwgW3N0cmluZ10kZml4ID0gIiIpCiAgICAkc2NyaXB0OlN0ZXBzWyRuYW1lXSA9IEB7IFN0YXR1cyA9ICJQRU5ESU5HIjsgRGV0YWlsID0gIiI7IEZpeCA9ICRmaXggfQp9CgpmdW5jdGlvbiBTZXQtU3RlcCB7CiAgICBwYXJhbShbc3RyaW5nXSRuYW1lLCBbc3RyaW5nXSRzdGF0dXMsIFtzdHJpbmddJGRldGFpbCA9ICIiKQogICAgaWYgKCRzY3JpcHQ6U3RlcHMuQ29udGFpbnMoJG5hbWUpKSB7CiAgICAgICAgJHNjcmlwdDpTdGVwc1skbmFtZV0uU3RhdHVzID0gJHN0YXR1cwogICAgICAgIGlmICgkZGV0YWlsKSB7ICRzY3JpcHQ6U3RlcHNbJG5hbWVdLkRldGFpbCA9ICRkZXRhaWwgfQogICAgfQp9CgpmdW5jdGlvbiBTaG93LURpYWdub3N0aWNzIHsKICAgIHBhcmFtKFtzd2l0Y2hdJExvZ09ubHkpCiAgICAkc2VwICAgID0gIiAgIiArICgi4pSAIiAqIDY1KQogICAgJGxvZ1NlcCA9ICLilIAiICogNjcKICAgICR0cyAgICAgPSBHZXQtRGF0ZSAtRm9ybWF0ICJ5eXl5LU1NLWRkIEhIOm1tOnNzIgoKICAgIGlmICgtbm90ICRMb2dPbmx5KSB7CiAgICAgICAgV3JpdGUtSG9zdCAiIgogICAgICAgIFdyaXRlLUhvc3QgJHNlcCAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5CiAgICAgICAgV3JpdGUtSG9zdCAiICBJTlNUQUxMIERJQUdOT1NUSUNTIiAtRm9yZWdyb3VuZENvbG9yIFdoaXRlCiAgICAgICAgV3JpdGUtSG9zdCAkc2VwIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkKICAgIH0KCiAgICBBZGQtQ29udGVudCAtUGF0aCAkTE9HX0ZJTEUgLVZhbHVlICIiIC1FbmNvZGluZyBVVEY4CiAgICBBZGQtQ29udGVudCAtUGF0aCAkTE9HX0ZJTEUgLVZhbHVlICRsb2dTZXAgLUVuY29kaW5nIFVURjgKICAgIEFkZC1Db250ZW50IC1QYXRoICRMT0dfRklMRSAtVmFsdWUgIklOU1RBTEwgRElBR05PU1RJQ1MgICR0cyIgLUVuY29kaW5nIFVURjgKICAgIEFkZC1Db250ZW50IC1QYXRoICRMT0dfRklMRSAtVmFsdWUgJGxvZ1NlcCAtRW5jb2RpbmcgVVRGOAoKICAgIGZvcmVhY2ggKCRuYW1lIGluICRzY3JpcHQ6U3RlcHMuS2V5cykgewogICAgICAgICRzICAgICA9ICRzY3JpcHQ6U3RlcHNbJG5hbWVdCiAgICAgICAgJGljb24gID0gc3dpdGNoICgkcy5TdGF0dXMpIHsgIlBBU1MiIHsiW09LXSJ9ICJGQUlMIiB7IltYXSAifSAiV0FSTiIgeyJbISFdIn0gIlNLSVAiIHsiWy0tXSJ9IGRlZmF1bHQgeyJbICBdIn0gfQogICAgICAgICRjb2xvciA9IHN3aXRjaCAoJHMuU3RhdHVzKSB7ICJQQVNTIiB7IkdyZWVuIn0gIkZBSUwiIHsiUmVkIn0gIldBUk4iIHsiWWVsbG93In0gIlNLSVAiIHsiRGFya0dyYXkifSBkZWZhdWx0IHsiRGFya0dyYXkifSB9CgogICAgICAgIGlmICgkcy5TdGF0dXMgLWVxICJQRU5ESU5HIikgewogICAgICAgICAgICBpZiAoLW5vdCAkTG9nT25seSkgeyBXcml0ZS1Ib3N0ICgiICB7MH0gezEsLTU1fSB7Mn0iIC1mICRpY29uLCAkbmFtZSwgIihub3QgcmVhY2hlZCkiKSAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5IH0KICAgICAgICAgICAgQWRkLUNvbnRlbnQgLVBhdGggJExPR19GSUxFIC1WYWx1ZSAoIiAgJGljb24gJG5hbWUgIChub3QgcmVhY2hlZCkiKSAtRW5jb2RpbmcgVVRGOAogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICAgIGlmICgtbm90ICRMb2dPbmx5KSB7CiAgICAgICAgICAgICAgICBXcml0ZS1Ib3N0ICIgICRpY29uICRuYW1lIiAtRm9yZWdyb3VuZENvbG9yICRjb2xvcgogICAgICAgICAgICAgICAgaWYgKCRzLkRldGFpbCkgeyBXcml0ZS1Ib3N0ICIgICAgICAgJCgkcy5EZXRhaWwpIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5IH0KICAgICAgICAgICAgICAgIGlmICgkcy5TdGF0dXMgLWVxICJGQUlMIiAtYW5kICRzLkZpeCkgeyBXcml0ZS1Ib3N0ICIgICAgICAgRml4OiAkKCRzLkZpeCkiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93IH0KICAgICAgICAgICAgfQogICAgICAgICAgICBBZGQtQ29udGVudCAtUGF0aCAkTE9HX0ZJTEUgLVZhbHVlICIgICRpY29uICRuYW1lIiAtRW5jb2RpbmcgVVRGOAogICAgICAgICAgICBpZiAoJHMuRGV0YWlsKSB7IEFkZC1Db250ZW50IC1QYXRoICRMT0dfRklMRSAtVmFsdWUgIiAgICAgICAkKCRzLkRldGFpbCkiIC1FbmNvZGluZyBVVEY4IH0KICAgICAgICAgICAgaWYgKCRzLlN0YXR1cyAtZXEgIkZBSUwiIC1hbmQgJHMuRml4KSB7IEFkZC1Db250ZW50IC1QYXRoICRMT0dfRklMRSAtVmFsdWUgIiAgICAgICBGaXg6ICQoJHMuRml4KSIgLUVuY29kaW5nIFVURjggfQogICAgICAgIH0KICAgIH0KCiAgICBBZGQtQ29udGVudCAtUGF0aCAkTE9HX0ZJTEUgLVZhbHVlICRsb2dTZXAgLUVuY29kaW5nIFVURjgKCiAgICBpZiAoLW5vdCAkTG9nT25seSkgewogICAgICAgIFdyaXRlLUhvc3QgJHNlcCAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5CiAgICAgICAgV3JpdGUtSG9zdCAiICBGdWxsIGxvZzogJExPR19GSUxFIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5CiAgICAgICAgV3JpdGUtSG9zdCAiICBTaGFyZSB3aXRoIFB1bHNlIHN1cHBvcnQgYXQgcHVsc2VuYW5vYWkuY29tIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5CiAgICAgICAgV3JpdGUtSG9zdCAiIgogICAgfQp9CiMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgpmdW5jdGlvbiBHZXQtTG9jYWxJUCB7CiAgICAoR2V0LU5ldElQQWRkcmVzcyAtQWRkcmVzc0ZhbWlseSBJUHY0IHwKICAgICAgICBXaGVyZS1PYmplY3QgeyAkXy5JbnRlcmZhY2VBbGlhcyAtbm90bWF0Y2ggIkxvb3BiYWNrfFdTTHx2RXRoZXJuZXQiIH0gfAogICAgICAgIFNlbGVjdC1PYmplY3QgLUZpcnN0IDEpLklQQWRkcmVzcwp9CgpmdW5jdGlvbiBTZXQtV1NMMlBvcnRQcm94eSB7CiAgICBwYXJhbShbc3RyaW5nXSRXc2xJUCkKICAgICMgVENQIG9ubHkg4oCUIHBvcnRwcm94eSBkb2VzIG5vdCBzdXBwb3J0IFVEUC4gVURQIHR1bm5lbCBwb3J0cyAoNTE4MDAtNTE4MTYpCiAgICAjIHJlcXVpcmUgbWlycm9yZWQgbmV0d29ya2luZyBvbiBXaW5kb3dzIDExIDIySDIrIHRvIGZ1bmN0aW9uIGNvcnJlY3RseS4KICAgICRhbGxQb3J0cyA9ICRPQ1RBX01HTVRfUE9SVFMgKyAoJE9DVEFfQVBQX1BPUlRfU1RBUlQuLiRPQ1RBX0FQUF9QT1JUX0VORCkKICAgIGZvcmVhY2ggKCRwIGluICRhbGxQb3J0cykgewogICAgICAgIG5ldHNoIGludGVyZmFjZSBwb3J0cHJveHkgZGVsZXRlIHY0dG92NCBsaXN0ZW5wb3J0PSRwIGxpc3RlbmFkZHJlc3M9MC4wLjAuMCB8IE91dC1OdWxsCiAgICAgICAgbmV0c2ggaW50ZXJmYWNlIHBvcnRwcm94eSBhZGQgdjR0b3Y0IGxpc3RlbnBvcnQ9JHAgbGlzdGVuYWRkcmVzcz0wLjAuMC4wIGAKICAgICAgICAgICAgY29ubmVjdHBvcnQ9JHAgY29ubmVjdGFkZHJlc3M9JFdzbElQIHwgT3V0LU51bGwKICAgIH0KICAgIFdyaXRlLUxvZyAiV1NMMiBwb3J0cHJveHkgKFRDUCk6ICQoJE9DVEFfTUdNVF9QT1JUUyAtam9pbiAnLCcpICsgJE9DVEFfQVBQX1BPUlRfU1RBUlQtJE9DVEFfQVBQX1BPUlRfRU5EIOKGkiAkV3NsSVAiICJPSyIKICAgIFdyaXRlLUxvZyAiTk9URTogVURQIHBvcnRzICRPQ1RBX0FQUF9QT1JUX1NUQVJULSRPQ1RBX0FQUF9QT1JUX0VORCBuZWVkIG1pcnJvcmVkIG5ldHdvcmtpbmcgZm9yIGZ1bGwgdHVubmVsIHN1cHBvcnQiICJXQVJOIgp9CgojIOKUgOKUgCBQaGFzZSAxOiBFbmFibGUgV1NMMiArIHNjaGVkdWxlIFBoYXNlIDIgYWZ0ZXIgcmVib290IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKZnVuY3Rpb24gSW52b2tlLVBoYXNlMSB7CiAgICBTaG93LUJhbm5lciAiUGhhc2UgMSBvZiAyIOKAlCBFbmFibGluZyBXU0wyIgoKICAgICRzY3JpcHQ6U3RlcHMgPSBbb3JkZXJlZF1Ae30KICAgIFJlZ2lzdGVyLVN0ZXAgIldpbmRvd3MgY29tcGF0aWJpbGl0eSAoYnVpbGQgMTkwNDErKSIKICAgIFJlZ2lzdGVyLVN0ZXAgIkdQVSBkZXRlY3RlZCIKICAgIFJlZ2lzdGVyLVN0ZXAgIlZpcnR1YWxpemF0aW9uIGVuYWJsZWQgaW4gQklPUyIKICAgIFJlZ2lzdGVyLVN0ZXAgIldTTDIgZmVhdHVyZXMgZW5hYmxlZCIKICAgIFJlZ2lzdGVyLVN0ZXAgIldTTDIga2VybmVsIHVwZGF0ZSIKICAgIFJlZ2lzdGVyLVN0ZXAgIlBoYXNlIDIgcmVzdW1lIHRhc2siCgogICAgJGJ1aWxkID0gW1N5c3RlbS5FbnZpcm9ubWVudF06Ok9TVmVyc2lvbi5WZXJzaW9uLkJ1aWxkCiAgICBpZiAoJGJ1aWxkIC1sdCAxOTA0MSkgewogICAgICAgIFNldC1TdGVwICJXaW5kb3dzIGNvbXBhdGliaWxpdHkgKGJ1aWxkIDE5MDQxKykiICJGQUlMIiAiQnVpbGQgJGJ1aWxkIOKAlCByZXF1aXJlcyAxOTA0MSAoV2luZG93cyAxMCAyMDA0KykiCiAgICAgICAgV3JpdGUtTG9nICJXaW5kb3dzIGJ1aWxkICRidWlsZCBpcyB0b28gb2xkLiBXU0wyIHJlcXVpcmVzIGJ1aWxkIDE5MDQxKyAoV2luZG93cyAxMCAyMDA0KykuIiAiRVJST1IiCiAgICAgICAgU2hvdy1EaWFnbm9zdGljczsgV2FpdC1Gb3JLZXk7IGV4aXQgMQogICAgfQogICAgV3JpdGUtTG9nICJXaW5kb3dzIGJ1aWxkICRidWlsZCDigJQgT0siICJPSyIKICAgIFNldC1TdGVwICJXaW5kb3dzIGNvbXBhdGliaWxpdHkgKGJ1aWxkIDE5MDQxKykiICJQQVNTIiAiQnVpbGQgJGJ1aWxkIgoKICAgICRncHUgPSAoR2V0LVdtaU9iamVjdCBXaW4zMl9WaWRlb0NvbnRyb2xsZXIgfAogICAgICAgIFdoZXJlLU9iamVjdCB7ICRfLk5hbWUgLW1hdGNoICJOVklESUF8R2VGb3JjZXxSVFh8R1RYfEFNRHxSYWRlb24iIH0gfAogICAgICAgIFNlbGVjdC1PYmplY3QgLUZpcnN0IDEpLk5hbWUKICAgIGlmICgtbm90ICRncHUpIHsKICAgICAgICBTZXQtU3RlcCAiR1BVIGRldGVjdGVkIiAiRkFJTCIgIk5vIE5WSURJQS9BTUQgR1BVIGZvdW5kIgogICAgICAgIFdyaXRlLUxvZyAiTm8gc3VwcG9ydGVkIEdQVSBkZXRlY3RlZC4gUHVsc2UgcmVxdWlyZXMgYW4gTlZJRElBIG9yIEFNRCBHUFUuIiAiRVJST1IiCiAgICAgICAgU2hvdy1EaWFnbm9zdGljczsgV2FpdC1Gb3JLZXk7IGV4aXQgMQogICAgfQogICAgV3JpdGUtTG9nICJHUFU6ICRncHUiICJPSyIKICAgIFNldC1TdGVwICJHUFUgZGV0ZWN0ZWQiICJQQVNTIiAkZ3B1CgogICAgTmV3LUl0ZW0gLUl0ZW1UeXBlIERpcmVjdG9yeSAtRm9yY2UgLVBhdGggJFBVTFNFX0RJUiB8IE91dC1OdWxsCgogICAgJHZpcnRFbmFibGVkID0gKEdldC1Db21wdXRlckluZm8pLkh5cGVyVlJlcXVpcmVtZW50VmlydHVhbGl6YXRpb25GaXJtd2FyZUVuYWJsZWQKICAgIGlmICgkdmlydEVuYWJsZWQgLWVxICRmYWxzZSkgewogICAgICAgIFNldC1TdGVwICJWaXJ0dWFsaXphdGlvbiBlbmFibGVkIGluIEJJT1MiICJGQUlMIiAiRGlzYWJsZWQg4oCUIHNlZSBCSU9TIGluc3RydWN0aW9ucyBiZWxvdyIKICAgICAgICBXcml0ZS1Mb2cgIkhhcmR3YXJlIHZpcnR1YWxpemF0aW9uIGlzIGRpc2FibGVkIGluIHlvdXIgQklPUy9VRUZJLiIgIkVSUk9SIgogICAgICAgIFdyaXRlLUhvc3QgIiIKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUjOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUkCIgLUZvcmVncm91bmRDb2xvciBSZWQKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgQUNUSU9OIFJFUVVJUkVEOiBFbmFibGUgdmlydHVhbGl6YXRpb24gaW4geW91ciBCSU9TL1VFRkkgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFJlZAogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkCiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgIDEuIFJlc3RhcnQgeW91ciBQQyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBSZWQKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgMi4gUHJlc3MgRGVsZXRlIG9yIEYyIGR1cmluZyBib290IHRvIG9wZW4gQklPUyAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkCiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgIDMuIEZpbmQ6IEFkdmFuY2VkID4gQ1BVIENvbmZpZ3VyYXRpb24gPiBTVk0gTW9kZSAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFJlZAogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAoSW50ZWwgYm9hcmRzOiBsb29rIGZvciAnSW50ZWwgVmlydHVhbGl6YXRpb24nIG9yIFZULXgpIOKUgiIgLUZvcmVncm91bmRDb2xvciBSZWQKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgNC4gU2V0IGl0IHRvIEVuYWJsZWQgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFJlZAogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICA1LiBQcmVzcyBGMTAgdG8gc2F2ZSBhbmQgZXhpdCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBSZWQKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFJlZAogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICBUaGVuIHJlLXJ1biB0aGlzIGluc3RhbGxlci4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkCiAgICAgICAgV3JpdGUtSG9zdCAiICDilJTilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilJgiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkCiAgICAgICAgV3JpdGUtSG9zdCAiIgogICAgICAgIFNob3ctRGlhZ25vc3RpY3M7IFdhaXQtRm9yS2V5OyBleGl0IDEKICAgIH0KICAgIFdyaXRlLUxvZyAiSGFyZHdhcmUgdmlydHVhbGl6YXRpb24gZW5hYmxlZCBpbiBCSU9TIOKAlCBPSyIgIk9LIgogICAgU2V0LVN0ZXAgIlZpcnR1YWxpemF0aW9uIGVuYWJsZWQgaW4gQklPUyIgIlBBU1MiCgogICAgV3JpdGUtTG9nICJFbmFibGluZyBXU0wyIFdpbmRvd3MgZmVhdHVyZXMuLi4iCiAgICBkaXNtLmV4ZSAvb25saW5lIC9lbmFibGUtZmVhdHVyZSAvZmVhdHVyZW5hbWU6TWljcm9zb2Z0LVdpbmRvd3MtU3Vic3lzdGVtLUxpbnV4IC9hbGwgL25vcmVzdGFydCB8IE91dC1OdWxsCiAgICBkaXNtLmV4ZSAvb25saW5lIC9lbmFibGUtZmVhdHVyZSAvZmVhdHVyZW5hbWU6VmlydHVhbE1hY2hpbmVQbGF0Zm9ybSAvYWxsIC9ub3Jlc3RhcnQgfCBPdXQtTnVsbAogICAgV3JpdGUtTG9nICJXU0wyIGZlYXR1cmVzIGVuYWJsZWQiICJPSyIKICAgIFNldC1TdGVwICJXU0wyIGZlYXR1cmVzIGVuYWJsZWQiICJQQVNTIgoKICAgIFdyaXRlLUxvZyAiSW5zdGFsbGluZyBXU0wyIGtlcm5lbCB1cGRhdGUuLi4iCiAgICAkbXNpID0gIiRlbnY6VEVNUFx3c2xfdXBkYXRlLm1zaSIKICAgIHRyeSB7CiAgICAgICAgSW52b2tlLVdlYlJlcXVlc3QgImh0dHBzOi8vd3Nsc3RvcmVzdG9yYWdlLmJsb2IuY29yZS53aW5kb3dzLm5ldC93c2xibG9iL3dzbF91cGRhdGVfeDY0Lm1zaSIgYAogICAgICAgICAgICAtT3V0RmlsZSAkbXNpIC1Vc2VCYXNpY1BhcnNpbmcKICAgICAgICBTdGFydC1Qcm9jZXNzIG1zaWV4ZWMuZXhlIC1Bcmd1bWVudExpc3QgIi9pIGAiJG1zaWAiIC9xdWlldCAvbm9yZXN0YXJ0IiAtV2FpdAogICAgICAgIFdyaXRlLUxvZyAiV1NMMiBrZXJuZWwgdXBkYXRlZCIgIk9LIgogICAgfSBjYXRjaCB7CiAgICAgICAgV3JpdGUtTG9nICJXU0wyIGtlcm5lbCBhbHJlYWR5IHVwIHRvIGRhdGUiICJPSyIKICAgIH0KICAgIFNldC1TdGVwICJXU0wyIGtlcm5lbCB1cGRhdGUiICJQQVNTIgoKICAgIHdzbCAtLXNldC1kZWZhdWx0LXZlcnNpb24gMiAyPiYxIHwgT3V0LU51bGwKCiAgICBTZXQtQ29udGVudCAtUGF0aCAkUEhBU0VfRklMRSAtVmFsdWUgIjIiIC1FbmNvZGluZyBVVEY4CgogICAgJHN0YWJsZVBhdGggPSAiJFBVTFNFX0RJUlxwdWxzZS1vY3RhLXNldHVwLnBzMSIKICAgIGlmICgkUFNDb21tYW5kUGF0aCAtbmUgJHN0YWJsZVBhdGgpIHsKICAgICAgICBDb3B5LUl0ZW0gLVBhdGggJFBTQ29tbWFuZFBhdGggLURlc3RpbmF0aW9uICRzdGFibGVQYXRoIC1Gb3JjZQogICAgfQoKICAgICRhY3Rpb24gICAgPSBOZXctU2NoZWR1bGVkVGFza0FjdGlvbiAtRXhlY3V0ZSAicG93ZXJzaGVsbC5leGUiIGAKICAgICAgICAtQXJndW1lbnQgIi1Ob1Byb2ZpbGUgLUV4ZWN1dGlvblBvbGljeSBCeXBhc3MgLVdpbmRvd1N0eWxlIE5vcm1hbCAtRmlsZSBgIiRzdGFibGVQYXRoYCIiCiAgICAkdHJpZ2dlciAgID0gTmV3LVNjaGVkdWxlZFRhc2tUcmlnZ2VyIC1BdExvZ09uCiAgICAkc2V0dGluZ3MgID0gTmV3LVNjaGVkdWxlZFRhc2tTZXR0aW5nc1NldCAtQWxsb3dTdGFydElmT25CYXR0ZXJpZXMgLURvbnRTdG9wSWZHb2luZ09uQmF0dGVyaWVzCiAgICAkcHJpbmNpcGFsID0gTmV3LVNjaGVkdWxlZFRhc2tQcmluY2lwYWwgLVVzZXJJZCAkZW52OlVTRVJOQU1FIC1SdW5MZXZlbCBIaWdoZXN0CiAgICBSZWdpc3Rlci1TY2hlZHVsZWRUYXNrIC1UYXNrTmFtZSAkVEFTS19OQU1FIC1BY3Rpb24gJGFjdGlvbiAtVHJpZ2dlciAkdHJpZ2dlciBgCiAgICAgICAgLVNldHRpbmdzICRzZXR0aW5ncyAtUHJpbmNpcGFsICRwcmluY2lwYWwgLUZvcmNlIHwgT3V0LU51bGwKICAgIFdyaXRlLUxvZyAiUGhhc2UgMiByZXN1bWUgdGFzayByZWdpc3RlcmVkIiAiT0siCiAgICBTZXQtU3RlcCAiUGhhc2UgMiByZXN1bWUgdGFzayIgIlBBU1MiCgogICAgV3JpdGUtSG9zdCAiIgogICAgV3JpdGUtSG9zdCAiICDilIzilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilJAiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgT25lIHJlYm9vdCByZXF1aXJlZCB0byBjb250aW51ZSBzZXR1cCAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgV3JpdGUtSG9zdCAiICDilIIgIFNldHVwIHdpbGwgcmVzdW1lIGF1dG9tYXRpY2FsbHkuICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgIFdyaXRlLUhvc3QgIiAg4pSU4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSYIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgV3JpdGUtSG9zdCAiIgogICAgJGFuc3dlciA9IFJlYWQtSG9zdCAiICBSZWJvb3Qgbm93PyAoWS9uKSIKICAgIGlmICgkYW5zd2VyIC1uZSAibiIpIHsgUmVzdGFydC1Db21wdXRlciAtRm9yY2UgfQogICAgZWxzZSB7IFdyaXRlLUhvc3QgIiAgUmVib290IHdoZW4gcmVhZHkuIFNldHVwIHJlc3VtZXMgb24gbmV4dCBsb2dpbi4iIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkgfQp9CgojIOKUgOKUgCBQaGFzZSAyOiBVYnVudHUgKyBPY3RhU3BhY2UgKG9zbikgKyBOZXR3b3JraW5nICsgQXV0by1zdGFydCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCmZ1bmN0aW9uIEludm9rZS1QaGFzZTIgewogICAgU2hvdy1CYW5uZXIgIlBoYXNlIDIgb2YgMiDigJQgSW5zdGFsbGluZyBPY3RhU3BhY2UgUHJvdmlkZXIgU3RhY2siCgogICAgJHNjcmlwdDpTdGVwcyA9IFtvcmRlcmVkXUB7fQogICAgUmVnaXN0ZXItU3RlcCAiVWJ1bnR1IG9uIFdTTDIiCiAgICBSZWdpc3Rlci1TdGVwICJzeXN0ZW1kIGluIFdTTDIiCiAgICBSZWdpc3Rlci1TdGVwICJXU0wyIG5ldHdvcmtpbmciCiAgICBSZWdpc3Rlci1TdGVwICJHUFUgY29tcHV0ZSBpbiBXU0wyIiAiVXBkYXRlIFdpbmRvd3MgTlZJRElBIGRyaXZlciBhdCBudmlkaWEuY29tL2RyaXZlcnMiCiAgICBSZWdpc3Rlci1TdGVwICJCdWlsZCB0b29scyAoY3VybCwgYmFzaCkiICJ3c2wgLWQgVWJ1bnR1IC0tIGJhc2ggLWMgJ2FwdC1nZXQgdXBkYXRlICYmIGFwdC1nZXQgaW5zdGFsbCAteSBjdXJsIGJhc2gnIgogICAgUmVnaXN0ZXItU3RlcCAiT2N0YVNwYWNlIG9zbiBpbnN0YWxsZWQiICJDaGVjayBpbnN0YWxsLm9jdGEuc3BhY2Ugb3IgT2N0YVNwYWNlIGRvY3MiCiAgICBSZWdpc3Rlci1TdGVwICJvc24gc2VydmljZSBzdGFydGVkIgogICAgUmVnaXN0ZXItU3RlcCAiT2N0YVNwYWNlIG5vZGUgdG9rZW4iCiAgICBSZWdpc3Rlci1TdGVwICJXaW5kb3dzIEZpcmV3YWxsIHJ1bGVzIgogICAgUmVnaXN0ZXItU3RlcCAiVVBuUCBwb3J0IGZvcndhcmRpbmciCiAgICBSZWdpc3Rlci1TdGVwICJXU0wyIHBvcnQgcHJveHkiCiAgICBSZWdpc3Rlci1TdGVwICJQdWxzZSByZWdpc3RyYXRpb24iCiAgICBSZWdpc3Rlci1TdGVwICJHUFUgd2F0Y2hkb2cgdGFzayIKICAgIFJlZ2lzdGVyLVN0ZXAgIkF1dG8tc3RhcnQgdGFzayIKICAgIFJlZ2lzdGVyLVN0ZXAgIkF1dG8tbG9naW4iCgogICAgV3JpdGUtTG9nICJTZXR0aW5nIHVwIFVidW50dSBvbiBXU0wyLi4uIgogICAgJGRpc3Ryb3MgPSB3c2wgLS1saXN0IC0tcXVpZXQgMj4mMQogICAgaWYgKCRkaXN0cm9zIC1ub3RtYXRjaCAiVWJ1bnR1IikgewogICAgICAgIFdyaXRlLUxvZyAiRG93bmxvYWRpbmcgVWJ1bnR1Li4uIgogICAgICAgIHdzbCAtLWluc3RhbGwgLWQgVWJ1bnR1IC0tbm8tbGF1bmNoIDI+JjEgfCBPdXQtTnVsbAoKICAgICAgICBXcml0ZS1Mb2cgIkluaXRpYWxpemluZyBVYnVudHUgKGZpcnN0IGJvb3QpLi4uIgogICAgICAgIHdzbCAtZCBVYnVudHUgLS11c2VyIHJvb3QgLS0gYmFzaCAtYyAiZWNobyBpbml0aWFsaXplZCIgMj4mMSB8IE91dC1OdWxsCgogICAgICAgICRjaGVjayA9IHdzbCAtZCBVYnVudHUgLS0gZWNobyAib2siIDI+JjEKICAgICAgICBpZiAoJGNoZWNrIC1ub3RtYXRjaCAib2siKSB7CiAgICAgICAgICAgIFdyaXRlLUxvZyAiSGVhZGxlc3MgaW5pdCBmYWlsZWQg4oCUIGxhdW5jaGluZyBVYnVudHUgZm9yIGZpcnN0LXRpbWUgc2V0dXAuLi4iICJXQVJOIgogICAgICAgICAgICBXcml0ZS1Ib3N0ICIiCiAgICAgICAgICAgIFdyaXRlLUhvc3QgIiAgVWJ1bnR1IG5lZWRzIGEgb25lLXRpbWUgc2V0dXAuIEEgbmV3IHdpbmRvdyB3aWxsIG9wZW4uIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgICAgICAgICBXcml0ZS1Ib3N0ICIgIENyZWF0ZSBhIExpbnV4IHVzZXJuYW1lICsgcGFzc3dvcmQsIHRoZW4gY2xvc2UgdGhhdCB3aW5kb3cuIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgICAgICAgICBXcml0ZS1Ib3N0ICIgIFRoaXMgaW5zdGFsbGVyIHdpbGwgY29udGludWUgYXV0b21hdGljYWxseS4iIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICAgICAgICAgIFdyaXRlLUhvc3QgIiIKICAgICAgICAgICAgU3RhcnQtUHJvY2VzcyB3c2wuZXhlIC1Bcmd1bWVudExpc3QgIi1kIFVidW50dSIgLVdhaXQKICAgICAgICB9CgogICAgICAgIFdyaXRlLUxvZyAiVWJ1bnR1IGluc3RhbGxlZCBhbmQgaW5pdGlhbGl6ZWQiICJPSyIKICAgIH0gZWxzZSB7CiAgICAgICAgV3JpdGUtTG9nICJVYnVudHUgYWxyZWFkeSBwcmVzZW50IiAiT0siCiAgICB9CiAgICBTZXQtU3RlcCAiVWJ1bnR1IG9uIFdTTDIiICJQQVNTIgoKICAgICMgRW5hYmxlIHN5c3RlbWQg4oCUIG9zbiBpcyBhIHN5c3RlbWQgc2VydmljZQogICAgV3JpdGUtTG9nICJFbmFibGluZyBzeXN0ZW1kIGluIFdTTDIgKHJlcXVpcmVkIGZvciBvc24gc2VydmljZSkuLi4iCiAgICB3c2wgLWQgVWJ1bnR1IC0tdXNlciByb290IC0tIGJhc2ggLWMgImdyZXAgLXEgJ3N5c3RlbWQ9dHJ1ZScgL2V0Yy93c2wuY29uZiAyPi9kZXYvbnVsbCB8fCBwcmludGYgJ1tib290XVxuc3lzdGVtZD10cnVlXG4nID4gL2V0Yy93c2wuY29uZiIKCiAgICAjIFdTTDIgbWlycm9yZWQgbmV0d29ya2luZyDigJQgZXNwZWNpYWxseSBpbXBvcnRhbnQgZm9yIE9jdGFTcGFjZSBiZWNhdXNlIHRoZQogICAgIyB0dW5uZWwgcG9ydHMgNTE4MDAtNTE4MTYgdXNlIFVEUCwgYW5kIHBvcnRwcm94eSBpcyBUQ1Atb25seS4KICAgICRvc0J1aWxkID0gW1N5c3RlbS5FbnZpcm9ubWVudF06Ok9TVmVyc2lvbi5WZXJzaW9uLkJ1aWxkCiAgICAkbWlycm9yZWROZXR3b3JraW5nID0gJGZhbHNlCiAgICAkd3NsQ29uZmlnUGF0aCA9ICIkZW52OlVTRVJQUk9GSUxFXC53c2xjb25maWciCiAgICBpZiAoJG9zQnVpbGQgLWdlIDIyNjIxKSB7CiAgICAgICAgV3JpdGUtTG9nICJXaW5kb3dzIDExIDIySDIrIGRldGVjdGVkIOKAlCBlbmFibGluZyBXU0wyIG1pcnJvcmVkIG5ldHdvcmtpbmcuLi4iCiAgICAgICAgJHdzbENvbmZpZ0NvbnRlbnQgPSBpZiAoVGVzdC1QYXRoICR3c2xDb25maWdQYXRoKSB7IEdldC1Db250ZW50ICR3c2xDb25maWdQYXRoIC1SYXcgfSBlbHNlIHsgIiIgfQogICAgICAgIGlmICgkd3NsQ29uZmlnQ29udGVudCAtbm90bWF0Y2ggJ25ldHdvcmtpbmdNb2RlJykgewogICAgICAgICAgICBpZiAoJHdzbENvbmZpZ0NvbnRlbnQgLW1hdGNoICdcW3dzbDJcXScpIHsKICAgICAgICAgICAgICAgICR3c2xDb25maWdDb250ZW50ID0gJHdzbENvbmZpZ0NvbnRlbnQgLXJlcGxhY2UgJyhcW3dzbDJcXSknLCAiYCQxYG5uZXR3b3JraW5nTW9kZT1taXJyb3JlZCIKICAgICAgICAgICAgfSBlbHNlIHsKICAgICAgICAgICAgICAgICR3c2xDb25maWdDb250ZW50ICs9ICJgblt3c2wyXWBubmV0d29ya2luZ01vZGU9bWlycm9yZWRgbiIKICAgICAgICAgICAgfQogICAgICAgICAgICBTZXQtQ29udGVudCAtUGF0aCAkd3NsQ29uZmlnUGF0aCAtVmFsdWUgJHdzbENvbmZpZ0NvbnRlbnQgLUVuY29kaW5nIFVURjgKICAgICAgICB9CiAgICAgICAgJG1pcnJvcmVkTmV0d29ya2luZyA9ICR0cnVlCiAgICAgICAgV3JpdGUtTG9nICJXU0wyIG1pcnJvcmVkIG5ldHdvcmtpbmcgY29uZmlndXJlZCDigJQgVURQIHR1bm5lbHMgd2lsbCB3b3JrIGNvcnJlY3RseSIgIk9LIgogICAgICAgIFNldC1TdGVwICJXU0wyIG5ldHdvcmtpbmciICJQQVNTIiAiTWlycm9yZWQgKFdpbmRvd3MgMTEgMjJIMispIOKAlCBVRFAgdHVubmVscyBmdWxseSBmdW5jdGlvbmFsIgogICAgfSBlbHNlIHsKICAgICAgICBXcml0ZS1Mb2cgIldpbmRvd3MgYnVpbGQgJHtvc0J1aWxkfTogbWlycm9yZWQgbmV0d29ya2luZyBuZWVkcyAyMkgyICgyMjYyMSspIOKAlCBwb3J0cHJveHkgb25seSBjb3ZlcnMgVENQOyBVRFAgdHVubmVscyB3aWxsIGJlIGxpbWl0ZWQiICJXQVJOIgogICAgICAgIFNldC1TdGVwICJXU0wyIG5ldHdvcmtpbmciICJXQVJOIiAiUG9ydHByb3h5IG9ubHkgKGJ1aWxkICRvc0J1aWxkKSDigJQgVURQIHR1bm5lbCBwb3J0cyBsaW1pdGVkOyB1cGdyYWRlIHRvIFdpbiAxMSAyMkgyKyByZWNvbW1lbmRlZCIKICAgIH0KCiAgICB3c2wgLS1zaHV0ZG93bgogICAgU3RhcnQtU2xlZXAgMjAKICAgICRzZENoZWNrID0gd3NsIC1kIFVidW50dSAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICJbIC1kIC9ydW4vc3lzdGVtZC9zeXN0ZW0gXSAmJiBlY2hvIHllcyB8fCBlY2hvIG5vIiAyPiYxCiAgICBpZiAoJHNkQ2hlY2sgLW1hdGNoICJ5ZXMiKSB7CiAgICAgICAgV3JpdGUtTG9nICJzeXN0ZW1kIHJ1bm5pbmcgaW4gV1NMMiIgIk9LIgogICAgICAgIFNldC1TdGVwICJzeXN0ZW1kIGluIFdTTDIiICJQQVNTIgogICAgfSBlbHNlIHsKICAgICAgICBXcml0ZS1Mb2cgInN5c3RlbWQgbWF5IG5vdCBiZSBhY3RpdmUg4oCUIG9zbiBtYXkgbm90IGF1dG8tc3RhcnQgb24gcmVib290IiAiV0FSTiIKICAgICAgICBTZXQtU3RlcCAic3lzdGVtZCBpbiBXU0wyIiAiV0FSTiIgInN5c3RlbWQgbm90IGRldGVjdGVkIOKAlCBvc24gc2VydmljZSBtYXkgbm90IHBlcnNpc3QgYWNyb3NzIHJlYm9vdHMiCiAgICB9CgogICAgIyDilIDilIAgRGV0ZWN0IEdQVSB2ZW5kb3Ig4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgICAkZ3B1T2JqICAgID0gR2V0LVdtaU9iamVjdCBXaW4zMl9WaWRlb0NvbnRyb2xsZXIgfCBXaGVyZS1PYmplY3QgeyAkXy5OYW1lIC1tYXRjaCAiTlZJRElBfEdlRm9yY2V8UlRYfEdUWHxBTUR8UmFkZW9uIiB9IHwgU2VsZWN0LU9iamVjdCAtRmlyc3QgMQogICAgJGdwdU5hbWUgICA9ICRncHVPYmouTmFtZQogICAgJHZyYW1NYiAgICA9ICRncHVPYmouQWRhcHRlclJBTQogICAgJHZyYW1HYiAgICA9IGlmICgkdnJhbU1iIC1hbmQgJHZyYW1NYiAtZ3QgMCkgeyBbbWF0aF06OlJvdW5kKCR2cmFtTWIgLyAxR0IpIH0gZWxzZSB7IDggfQogICAgJGdwdVZlbmRvciA9IGlmICgkZ3B1TmFtZSAtbWF0Y2ggIk5WSURJQXxHZUZvcmNlfFJUWHxHVFgiKSB7ICJOVklESUEiIH0gZWxzZSB7ICJBTUQiIH0KCiAgICAjIOKUgOKUgCBQcmUtaW5zdGFsbCBHUFUgY29tcHV0ZSBkcml2ZXJzIGluc2lkZSBXU0wyIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogICAgV3JpdGUtTG9nICJDaGVja2luZyBHUFUgY29tcHV0ZSBlbnZpcm9ubWVudCBpbiBXU0wyICgkZ3B1VmVuZG9yKS4uLiIKICAgIGlmICgkZ3B1VmVuZG9yIC1lcSAiTlZJRElBIikgewogICAgICAgICRudkNoZWNrID0gd3NsIC1kIFVidW50dSAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICJudmlkaWEtc21pIC1MIDI+L2Rldi9udWxsIHwgaGVhZCAtMSIgMj4mMQogICAgICAgIGlmICgkbnZDaGVjayAtbWF0Y2ggIkdQVSAwIikgewogICAgICAgICAgICBXcml0ZS1Mb2cgIk5WSURJQSBHUFUgdmlzaWJsZSBpbiBXU0wyIiAiT0siCiAgICAgICAgICAgIFNldC1TdGVwICJHUFUgY29tcHV0ZSBpbiBXU0wyIiAiUEFTUyIgIm52aWRpYS1zbWkgT0sg4oCUICRncHVOYW1lIgogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICAgIFdyaXRlLUxvZyAiTlZJRElBIEdQVSBub3QgeWV0IHZpc2libGUgaW4gV1NMMiDigJQgZW5zdXJlIFdpbmRvd3MgTlZJRElBIGRyaXZlciBpcyB1cCB0byBkYXRlIiAiV0FSTiIKICAgICAgICAgICAgU2V0LVN0ZXAgIkdQVSBjb21wdXRlIGluIFdTTDIiICJXQVJOIiAibnZpZGlhLXNtaSByZXR1cm5lZCBubyBvdXRwdXQg4oCUIG9zbiBtYXkgZmFpbCB3aXRob3V0IEdQVSBhY2Nlc3MiCiAgICAgICAgfQogICAgfSBlbHNlIHsKICAgICAgICBXcml0ZS1Mb2cgIkluc3RhbGxpbmcgUk9DbSBmb3IgQU1EIEdQVSBpbiBXU0wyICh0aGlzIHRha2VzIGEgZmV3IG1pbnV0ZXMpLi4uIgogICAgICAgICR1YnVudHVWZXIgPSB3c2wgLWQgVWJ1bnR1IC0tdXNlciByb290IC0tIGJhc2ggLWMgImxzYl9yZWxlYXNlIC1jcyAyPi9kZXYvbnVsbCIgMj4mMQogICAgICAgICR1YnVudHVWZXIgPSAkdWJ1bnR1VmVyLlRyaW0oKQogICAgICAgIGlmICgkdWJ1bnR1VmVyIC1ub3RpbiBAKCJqYW1teSIsImZvY2FsIiwibm9ibGUiKSkgeyAkdWJ1bnR1VmVyID0gImphbW15IiB9CiAgICAgICAgJHJvY21TY3JpcHQgPSBAIgpzZXQgLWUKYXB0LWdldCB1cGRhdGUgLXFxIDI+JjEgfCB0YWlsIC0yCmFwdC1nZXQgaW5zdGFsbCAteSAtcXEgd2dldCBnbnVwZyBjYS1jZXJ0aWZpY2F0ZXMgMj4mMSB8IHRhaWwgLTIKbWtkaXIgLXAgL2V0Yy9hcHQva2V5cmluZ3MKd2dldCAtcU8gLSBodHRwczovL3JlcG8ucmFkZW9uLmNvbS9yb2NtL3JvY20uZ3BnLmtleSB8IGdwZyAtLWRlYXJtb3IgLW8gL2V0Yy9hcHQva2V5cmluZ3Mvcm9jbS5ncGcKZWNobyAnZGViIFthcmNoPWFtZDY0IHNpZ25lZC1ieT0vZXRjL2FwdC9rZXlyaW5ncy9yb2NtLmdwZ10gaHR0cHM6Ly9yZXBvLnJhZGVvbi5jb20vcm9jbS9hcHQvNi4yICR1YnVudHVWZXIgbWFpbicgPiAvZXRjL2FwdC9zb3VyY2VzLmxpc3QuZC9yb2NtLmxpc3QKYXB0LWdldCB1cGRhdGUgLXFxIDI+JjEgfCB0YWlsIC0yCmFwdC1nZXQgaW5zdGFsbCAteSAtcXEgcm9jbS1vcGVuY2wtcnVudGltZSAyPiYxIHwgdGFpbCAtNQoiQAogICAgICAgIHdzbCAtZCBVYnVudHUgLS11c2VyIHJvb3QgLS0gYmFzaCAtYyAkcm9jbVNjcmlwdCAyPiYxIHwgRm9yRWFjaC1PYmplY3QgeyBXcml0ZS1Mb2cgJF8gfQogICAgICAgIGlmICgkTEFTVEVYSVRDT0RFIC1lcSAwKSB7CiAgICAgICAgICAgIFdyaXRlLUxvZyAiUk9DbSBpbnN0YWxsZWQiICJPSyIKICAgICAgICAgICAgU2V0LVN0ZXAgIkdQVSBjb21wdXRlIGluIFdTTDIiICJQQVNTIiAiUk9DbSBvcGVuY2wtcnVudGltZSBpbnN0YWxsZWQg4oCUICRncHVOYW1lIgogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICAgIFdyaXRlLUxvZyAiUk9DbSBpbnN0YWxsIGVuY291bnRlcmVkIGVycm9ycyDigJQgT2N0YVNwYWNlIG1heSBoYXZlIGxpbWl0ZWQgQU1EIHN1cHBvcnQiICJXQVJOIgogICAgICAgICAgICBTZXQtU3RlcCAiR1BVIGNvbXB1dGUgaW4gV1NMMiIgIldBUk4iICJST0NtIGluc3RhbGwgaGFkIGVycm9ycyDigJQgQU1EIHN1cHBvcnQgbWF5IGJlIGxpbWl0ZWQiCiAgICAgICAgfQogICAgfQoKICAgICMg4pSA4pSAIEluc3RhbGwgT2N0YVNwYWNlIG5vZGUgKG9zbikgaW5zaWRlIFdTTDIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgICBXcml0ZS1Mb2cgIkluc3RhbGxpbmcgYnVpbGQgdG9vbHMgcmVxdWlyZWQgYnkgb3NuIGluc3RhbGxlciAoY3VybCwgYmFzaCkuLi4iCiAgICB3c2wgLWQgVWJ1bnR1IC0tdXNlciByb290IC0tIGJhc2ggLWMgImV4cG9ydCBERUJJQU5fRlJPTlRFTkQ9bm9uaW50ZXJhY3RpdmU7IGFwdC1nZXQgdXBkYXRlIC1xcSAyPiYxIHwgdGFpbCAtMiAmJiBhcHQtZ2V0IGluc3RhbGwgLXkgLXFxIGN1cmwgYmFzaCAyPiYxIHwgdGFpbCAtMyIgMj4mMSB8IEZvckVhY2gtT2JqZWN0IHsgV3JpdGUtTG9nICRfIH0KICAgIGlmICgkTEFTVEVYSVRDT0RFIC1lcSAwKSB7CiAgICAgICAgU2V0LVN0ZXAgIkJ1aWxkIHRvb2xzIChjdXJsLCBiYXNoKSIgIlBBU1MiCiAgICB9IGVsc2UgewogICAgICAgIFNldC1TdGVwICJCdWlsZCB0b29scyAoY3VybCwgYmFzaCkiICJXQVJOIiAiYXB0LWdldCBleGl0ICRMQVNURVhJVENPREUg4oCUIG9zbiBpbnN0YWxsZXIgd2lsbCBhdHRlbXB0IHRvIGNvbnRpbnVlIGFueXdheSIKICAgIH0KCiAgICBXcml0ZS1Mb2cgIkluc3RhbGxpbmcgT2N0YVNwYWNlIG5vZGUgKG9zbikgaW5zaWRlIFdTTDIuLi4iCiAgICAkb2N0YU91dHB1dCA9IHdzbCAtZCBVYnVudHUgLS11c2VyIHJvb3QgLS0gYmFzaCAtYyAiY3VybCAtZnNTTCBodHRwczovL2luc3RhbGwub2N0YS5zcGFjZSB8IGJhc2giIDI+JjEKICAgICRvY3RhRXhpdCA9ICRMQVNURVhJVENPREUKICAgICRvY3RhT3V0cHV0IHwgRm9yRWFjaC1PYmplY3QgeyBXcml0ZS1Mb2cgJF8gfQogICAgaWYgKCRvY3RhRXhpdCAtbmUgMCkgewogICAgICAgIFNldC1TdGVwICJPY3RhU3BhY2Ugb3NuIGluc3RhbGxlZCIgIkZBSUwiICJpbnN0YWxsLm9jdGEuc3BhY2Ugc2NyaXB0IGV4aXRlZCAkb2N0YUV4aXQg4oCUIHNlZSBsb2cgZm9yIGRldGFpbHMiCiAgICAgICAgV3JpdGUtTG9nICJPY3RhU3BhY2UgaW5zdGFsbGF0aW9uIGZhaWxlZCAoZXhpdCAkb2N0YUV4aXQpLiBDaGVjayB0aGUgb3V0cHV0IGFib3ZlLiIgIkVSUk9SIgogICAgICAgIFNob3ctRGlhZ25vc3RpY3M7IFdhaXQtRm9yS2V5OyBleGl0IDEKICAgIH0KICAgIFdyaXRlLUxvZyAiT2N0YVNwYWNlIG9zbiBpbnN0YWxsIGNvbXBsZXRlIiAiT0siCiAgICBTZXQtU3RlcCAiT2N0YVNwYWNlIG9zbiBpbnN0YWxsZWQiICJQQVNTIgoKICAgICMgU3RhcnQgdGhlIHNlcnZpY2Ugc28gaXQgY2FuIHJlZ2lzdGVyIGFuZCBnZW5lcmF0ZSBhIG5vZGUgdG9rZW4KICAgIFdyaXRlLUxvZyAiU3RhcnRpbmcgb3NuIHNlcnZpY2UuLi4iCiAgICB3c2wgLWQgVWJ1bnR1IC0tdXNlciByb290IC0tIGJhc2ggLWMgInN5c3RlbWN0bCBlbmFibGUgb3NuIDI+L2Rldi9udWxsOyBzeXN0ZW1jdGwgc3RhcnQgb3NuIDI+L2Rldi9udWxsIgogICAgU2V0LVN0ZXAgIm9zbiBzZXJ2aWNlIHN0YXJ0ZWQiICJQQVNTIgoKICAgICMg4pSA4pSAIEV4dHJhY3QgT2N0YVNwYWNlIG5vZGUgdG9rZW4gZnJvbSBpbnN0YWxsZXIgb3V0cHV0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogICAgIyBUaGUgaW5zdGFsbGVyIHByaW50cyBhIGJveDog4pWRICBOb2RlIFRva2VuOiBYWFhYWFhYWFhYICDilZEgdG8gc3Rkb3V0LgogICAgJG9jdGFOb2RlVG9rZW4gPSAiIgogICAgJHRva2VuTWF0Y2ggPSAkb2N0YU91dHB1dCB8IFNlbGVjdC1TdHJpbmcgLVBhdHRlcm4gJ05vZGUgVG9rZW46XHMqKFxTKyknCiAgICBpZiAoJHRva2VuTWF0Y2gpIHsKICAgICAgICAkb2N0YU5vZGVUb2tlbiA9ICR0b2tlbk1hdGNoLk1hdGNoZXNbMF0uR3JvdXBzWzFdLlZhbHVlLlRyaW0oKQogICAgICAgIFdyaXRlLUxvZyAiT2N0YVNwYWNlIG5vZGUgdG9rZW46ICRvY3RhTm9kZVRva2VuIiAiT0siCiAgICAgICAgU2V0LVN0ZXAgIk9jdGFTcGFjZSBub2RlIHRva2VuIiAiUEFTUyIgIlRva2VuOiAkb2N0YU5vZGVUb2tlbiIKICAgIH0gZWxzZSB7CiAgICAgICAgIyBGYWxsYmFjazogY2hlY2sgY29uZmlnIGZpbGVzIHdyaXR0ZW4gYnkgb3NuIGFmdGVyIGZpcnN0IHN0YXJ0CiAgICAgICAgV3JpdGUtTG9nICJUb2tlbiBub3QgZm91bmQgaW4gaW5zdGFsbGVyIG91dHB1dCDigJQgY2hlY2tpbmcgb3NuIGNvbmZpZyBmaWxlcy4uLiIKICAgICAgICBTdGFydC1TbGVlcCAxNQogICAgICAgICRyYXcgPSB3c2wgLWQgVWJ1bnR1IC0tdXNlciByb290IC0tIGJhc2ggLWMgQCcKZm9yIGYgaW4gL2hvbWUvb2N0YS9vc24vZXRjL3N5cy5jb25maWcgL2V0Yy9vc24vbm9kZS5qc29uIC92YXIvbGliL29zbi9ub2RlLmpzb247IGRvCiAgICBbIC1mICIkZiIgXSB8fCBjb250aW51ZQogICAgdG9rPSQoZ3JlcCAtb1AgJyJub2RlX3Rva2VuIlxzKjpccyoiXEtbXiJdKycgIiRmIiAyPi9kZXYvbnVsbCB8fCBncmVwIC1vUCAnInRva2VuIlxzKjpccyoiXEtbXiJdKycgIiRmIiAyPi9kZXYvbnVsbCkKICAgIFsgLW4gIiR0b2siIF0gJiYgZWNobyAiJHRvayIgJiYgYnJlYWsKZG9uZQonQCAyPiYxCiAgICAgICAgJGNhbmRpZGF0ZSA9ICgkcmF3IHwgV2hlcmUtT2JqZWN0IHsgJF8gLW1hdGNoICdeXHMqXFN7Nix9XHMqJCcgfSkgfCBTZWxlY3QtT2JqZWN0IC1GaXJzdCAxCiAgICAgICAgaWYgKCRjYW5kaWRhdGUpIHsKICAgICAgICAgICAgJG9jdGFOb2RlVG9rZW4gPSAkY2FuZGlkYXRlLlRyaW0oKQogICAgICAgICAgICBXcml0ZS1Mb2cgIk9jdGFTcGFjZSBub2RlIHRva2VuIChmcm9tIGNvbmZpZyk6ICRvY3RhTm9kZVRva2VuIiAiT0siCiAgICAgICAgICAgIFNldC1TdGVwICJPY3RhU3BhY2Ugbm9kZSB0b2tlbiIgIlBBU1MiICJUb2tlbjogJG9jdGFOb2RlVG9rZW4iCiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgICAgV3JpdGUtTG9nICJOb2RlIHRva2VuIG5vdCBmb3VuZCDigJQgaXQgd2lsbCBhcHBlYXIgYXQgY3ViZS5vY3RhLmNvbXB1dGVyIGFmdGVyIHRoZSBub2RlIGNvbm5lY3RzIiAiV0FSTiIKICAgICAgICAgICAgU2V0LVN0ZXAgIk9jdGFTcGFjZSBub2RlIHRva2VuIiAiV0FSTiIgIk5vdCB5ZXQgYXNzaWduZWQg4oCUIGNoZWNrIGN1YmUub2N0YS5jb21wdXRlciIKICAgICAgICB9CiAgICB9CgogICAgIyDilIDilIAgTmV0d29ya2luZzogV2luZG93cyBGaXJld2FsbCArIFVQblAg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgICBXcml0ZS1Mb2cgIkFkZGluZyBXaW5kb3dzIEZpcmV3YWxsIGluYm91bmQgcnVsZXMgKFRDUCArIFVEUCkuLi4iCiAgICAkYWxsUG9ydHMgPSAkT0NUQV9NR01UX1BPUlRTICsgKCRPQ1RBX0FQUF9QT1JUX1NUQVJULi4kT0NUQV9BUFBfUE9SVF9FTkQpCiAgICBmb3JlYWNoICgkcG9ydCBpbiAkYWxsUG9ydHMpIHsKICAgICAgICBOZXctTmV0RmlyZXdhbGxSdWxlIC1EaXNwbGF5TmFtZSAiUHVsc2UtT2N0YS1UQ1AtJHBvcnQiIC1EaXJlY3Rpb24gSW5ib3VuZCBgCiAgICAgICAgICAgIC1Qcm90b2NvbCBUQ1AgLUxvY2FsUG9ydCAkcG9ydCAtQWN0aW9uIEFsbG93IC1FcnJvckFjdGlvbiBTaWxlbnRseUNvbnRpbnVlIHwgT3V0LU51bGwKICAgICAgICBOZXctTmV0RmlyZXdhbGxSdWxlIC1EaXNwbGF5TmFtZSAiUHVsc2UtT2N0YS1VRFAtJHBvcnQiIC1EaXJlY3Rpb24gSW5ib3VuZCBgCiAgICAgICAgICAgIC1Qcm90b2NvbCBVRFAgLUxvY2FsUG9ydCAkcG9ydCAtQWN0aW9uIEFsbG93IC1FcnJvckFjdGlvbiBTaWxlbnRseUNvbnRpbnVlIHwgT3V0LU51bGwKICAgIH0KICAgIFdyaXRlLUxvZyAiRmlyZXdhbGwgcnVsZXMgYWRkZWQgKFRDUCtVRFApIGZvciBwb3J0cyAkKCRPQ1RBX01HTVRfUE9SVFMgLWpvaW4gJywgJykgKyAkT0NUQV9BUFBfUE9SVF9TVEFSVC0kT0NUQV9BUFBfUE9SVF9FTkQiICJPSyIKICAgIFNldC1TdGVwICJXaW5kb3dzIEZpcmV3YWxsIHJ1bGVzIiAiUEFTUyIgIlRDUCtVRFAgJCgkT0NUQV9NR01UX1BPUlRTIC1qb2luICcsICcpLCAkT0NUQV9BUFBfUE9SVF9TVEFSVC0kT0NUQV9BUFBfUE9SVF9FTkQiCgogICAgV3JpdGUtTG9nICJBdHRlbXB0aW5nIFVQblAgYXV0b21hdGljIHBvcnQgZm9yd2FyZGluZy4uLiIKICAgICRsb2NhbElQID0gR2V0LUxvY2FsSVAKICAgICR1cG5wT2sgID0gJGZhbHNlCiAgICB0cnkgewogICAgICAgICR1cG5wICAgICA9IE5ldy1PYmplY3QgLUNvbU9iamVjdCBITmV0Q2ZnLk5BVFVQblAKICAgICAgICAkbWFwcGluZ3MgPSAkdXBucC5TdGF0aWNQb3J0TWFwcGluZ0NvbGxlY3Rpb24KICAgICAgICBmb3JlYWNoICgkcG9ydCBpbiAkYWxsUG9ydHMpIHsKICAgICAgICAgICAgJG1hcHBpbmdzLkFkZCgkcG9ydCwgIlRDUCIsICRwb3J0LCAkbG9jYWxJUCwgJHRydWUsICJQdWxzZS1PY3RhLVRDUC0kcG9ydCIpIHwgT3V0LU51bGwKICAgICAgICAgICAgJG1hcHBpbmdzLkFkZCgkcG9ydCwgIlVEUCIsICRwb3J0LCAkbG9jYWxJUCwgJHRydWUsICJQdWxzZS1PY3RhLVVEUC0kcG9ydCIpIHwgT3V0LU51bGwKICAgICAgICB9CiAgICAgICAgV3JpdGUtTG9nICJVUG5QIHN1Y2NlZWRlZCDigJQgcG9ydHMgJCgkT0NUQV9NR01UX1BPUlRTIC1qb2luICcsICcpLCAkT0NUQV9BUFBfUE9SVF9TVEFSVC0kT0NUQV9BUFBfUE9SVF9FTkQgZm9yd2FyZGVkIChUQ1ArVURQKSB0byAkbG9jYWxJUCIgIk9LIgogICAgICAgIFNldC1TdGVwICJVUG5QIHBvcnQgZm9yd2FyZGluZyIgIlBBU1MiICJBdXRvLWZvcndhcmRlZCAoVENQK1VEUCkg4oaSICRsb2NhbElQIgogICAgICAgICR1cG5wT2sgPSAkdHJ1ZQogICAgfSBjYXRjaCB7CiAgICAgICAgV3JpdGUtTG9nICJVUG5QIHVuYXZhaWxhYmxlIG9uIHRoaXMgcm91dGVyIiAiV0FSTiIKICAgICAgICBTZXQtU3RlcCAiVVBuUCBwb3J0IGZvcndhcmRpbmciICJXQVJOIiAiVVBuUCB1bmF2YWlsYWJsZSDigJQgbWFudWFsIHJvdXRlciBzZXR1cCByZXF1aXJlZCAoVENQK1VEUCwgc2VlIGFib3ZlKSIKICAgIH0KCiAgICBpZiAoLW5vdCAkdXBucE9rKSB7CiAgICAgICAgV3JpdGUtSG9zdCAiIgogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSM4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSQIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICBST1VURVIgU0VUVVAgUkVRVUlSRUQgKG9uZS10aW1lLCB+MiBtaW51dGVzKSAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgWW91ciByb3V0ZXIgZG9lc24ndCBzdXBwb3J0IGF1dG8tZm9yd2FyZGluZyAoVVBuUCBvZmYpLiAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgIE9jdGFTcGFjZSBuZWVkcyBCT1RIIFRDUCBhbmQgVURQIGZvcndhcmRlZC4gICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgIDEuIE9wZW4geW91ciByb3V0ZXIgYWRtaW4gcGFnZSAodXN1YWxseSBodHRwOi8vMTkyLjE2OC4xLjEp4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgICAgIFdyaXRlLUhvc3QgIiAg4pSCICAyLiBGaW5kICdQb3J0IEZvcndhcmRpbmcnIG9yICdWaXJ0dWFsIFNlcnZlcicgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgMy4gQWRkIFRDUCtVRFAgcnVsZXMg4oaSICRsb2NhbElQIDogICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgICBUQ1ArVURQIDE4ODg4IOKGkiAkbG9jYWxJUGA6MTg4ODggICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgICBUQ1ArVURQICRPQ1RBX0FQUF9QT1JUX1NUQVJULSRPQ1RBX0FQUF9QT1JUX0VORCDihpIgJGxvY2FsSVBgOiRPQ1RBX0FQUF9QT1JUX1NUQVJULSRPQ1RBX0FQUF9QT1JUX0VORCDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgICAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgUHJlc3MgRW50ZXIgb25jZSBkb25lICh5b3UgY2FuIGZpbmlzaCB0aGlzIGxhdGVyIHZpYSB0aGUgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICAgICAgV3JpdGUtSG9zdCAiICDilIIgIFB1bHNlIGRhc2hib2FyZCDigJQgYnV0IGpvYnMgd29uJ3QgbGFuZCB1bnRpbCBpdCdzIGRvbmUpICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICAgICAgV3JpdGUtSG9zdCAiICDilJTilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilJgiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICAgICAgUmVhZC1Ib3N0ICIgIFByZXNzIEVudGVyIHRvIGNvbnRpbnVlIgogICAgfQoKICAgICMg4pSA4pSAIFdTTDIgUG9ydCBQcm94eSAoVENQIG9ubHkpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogICAgaWYgKC1ub3QgJG1pcnJvcmVkTmV0d29ya2luZykgewogICAgICAgIFdyaXRlLUxvZyAiQ29uZmlndXJpbmcgV1NMMiBUQ1AgcG9ydCBwcm94eSAoV2luZG93cyBob3N0IOKGkiBXU0wyIGJyaWRnZSkuLi4iCiAgICAgICAgJHdzbElQID0gKHdzbCAtZCBVYnVudHUgLS11c2VyIHJvb3QgLS0gYmFzaCAtYyAiaG9zdG5hbWUgLUkgMj4vZGV2L251bGwiKS5UcmltKCkuU3BsaXQoKVswXQogICAgICAgIGlmICgkd3NsSVApIHsKICAgICAgICAgICAgU2V0LVdTTDJQb3J0UHJveHkgLVdzbElQICR3c2xJUAogICAgICAgICAgICBTZXQtQ29udGVudCAtUGF0aCAiJFBVTFNFX0RJUlxsYXN0X3dzbF9pcCIgLVZhbHVlICR3c2xJUCAtRW5jb2RpbmcgVVRGOAogICAgICAgICAgICBTZXQtU3RlcCAiV1NMMiBwb3J0IHByb3h5IiAiUEFTUyIgIlRDUCDihpIgJHdzbElQIChVRFAgcmVxdWlyZXMgbWlycm9yZWQgbmV0d29ya2luZykiCiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgICAgV3JpdGUtTG9nICJDb3VsZCBub3QgZGV0ZXJtaW5lIFdTTDIgSVAg4oCUIHBvcnRwcm94eSBza2lwcGVkOyB3aWxsIHJldHJ5IG9uIG5leHQgbG9naW4iICJXQVJOIgogICAgICAgICAgICBTZXQtU3RlcCAiV1NMMiBwb3J0IHByb3h5IiAiV0FSTiIgIldTTDIgSVAgbm90IGZvdW5kIOKAlCB3aWxsIHJldHJ5IG9uIG5leHQgbG9naW4iCiAgICAgICAgfQogICAgfSBlbHNlIHsKICAgICAgICBXcml0ZS1Mb2cgIk1pcnJvcmVkIG5ldHdvcmtpbmcgYWN0aXZlIOKAlCBwb3J0cHJveHkgbm90IG5lZWRlZDsgVURQIHR1bm5lbHMgZnVsbHkgZnVuY3Rpb25hbCIgIk9LIgogICAgICAgIFNldC1TdGVwICJXU0wyIHBvcnQgcHJveHkiICJTS0lQIiAiTm90IG5lZWRlZCDigJQgbWlycm9yZWQgbmV0d29ya2luZyBhY3RpdmUiCiAgICB9CgogICAgIyDilIDilIAgQ3ViZSByZWdpc3RyYXRpb24g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgICBXcml0ZS1Ib3N0ICIiCiAgICBXcml0ZS1Ib3N0ICIgIOKUjOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUkCIgLUZvcmVncm91bmRDb2xvciBDeWFuCiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgT0NUQVNQQUNFIENVQkUgUkVHSVNUUkFUSU9OICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBDeWFuCiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4KICAgIFdyaXRlLUhvc3QgIiAg4pSCICBUbyBhcHBlYXIgaW4gdGhlIE9jdGFTcGFjZSBtYXJrZXRwbGFjZTogICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbgogICAgV3JpdGUtSG9zdCAiICDilIIgICAgMS4gT3BlbjogaHR0cHM6Ly9jdWJlLm9jdGEuY29tcHV0ZXIgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBDeWFuCiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAyLiBTaWduIGluIC8gY3JlYXRlIGFuIGFjY291bnQgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4KICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgIDMuIEFkZCB5b3VyIG5vZGUg4oCUIGl0IHNob3VsZCBhcHBlYXIgYXV0b21hdGljYWxseSAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBDeWFuCiAgICBpZiAoJG9jdGFOb2RlVG9rZW4pIHsKICAgIFdyaXRlLUhvc3QgIiAg4pSCICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbgogICAgV3JpdGUtSG9zdCAiICDilIIgICAgWW91ciBub2RlIHRva2VuOiAkb2N0YU5vZGVUb2tlbiIgLUZvcmVncm91bmRDb2xvciBXaGl0ZQogICAgfQogICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBDeWFuCiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgVGhpcyBzdGVwIGlzIGRvbmUgaW4geW91ciBicm93c2VyLCBub3QgdGhpcyB3aW5kb3cuICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4KICAgIFdyaXRlLUhvc3QgIiAg4pSU4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSYIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4KICAgIFdyaXRlLUhvc3QgIiIKICAgIFJlYWQtSG9zdCAiICBQcmVzcyBFbnRlciB0byBjb250aW51ZSBvbmNlIHlvdSd2ZSBub3RlZCB0aGUgYWJvdmUiCgogICAgIyDilIDilIAgUmVnaXN0ZXIgd2l0aCBQdWxzZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAgIFdyaXRlLUxvZyAiUmVnaXN0ZXJpbmcgbWFjaGluZSB3aXRoIFB1bHNlLi4uIgoKICAgICRib2R5ID0gQHsKICAgICAgICBncHVfbW9kZWwgICAgICAgID0gJGdwdU5hbWUKICAgICAgICB2cmFtX2diICAgICAgICAgID0gJHZyYW1HYgogICAgICAgIG9jdGFfbm9kZV90b2tlbiAgPSAkb2N0YU5vZGVUb2tlbgogICAgICAgIHBsYXRmb3JtICAgICAgICAgPSAiT2N0YVNwYWNlIgogICAgfSB8IENvbnZlcnRUby1Kc29uCgogICAgdHJ5IHsKICAgICAgICAkcmVzcCA9IEludm9rZS1SZXN0TWV0aG9kIC1VcmkgIiRQVUxTRV9BUElfQkFTRS9yZWdpc3Rlck9jdGFzcGFjZURhZW1vbiIgYAogICAgICAgICAgICAtTWV0aG9kIFBPU1QgYAogICAgICAgICAgICAtQ29udGVudFR5cGUgImFwcGxpY2F0aW9uL2pzb24iIGAKICAgICAgICAgICAgLUhlYWRlcnMgQHsgIkF1dGhvcml6YXRpb24iID0gIkJlYXJlciAkUFVMU0VfVVNFUl9UT0tFTiIgfSBgCiAgICAgICAgICAgIC1Cb2R5ICRib2R5CiAgICAgICAgV3JpdGUtTG9nICJQdWxzZSByZWdpc3RyYXRpb246ICQoJHJlc3AubWVzc2FnZSkiICJPSyIKICAgICAgICBTZXQtU3RlcCAiUHVsc2UgcmVnaXN0cmF0aW9uIiAiUEFTUyIKICAgIH0gY2F0Y2ggewogICAgICAgIFdyaXRlLUxvZyAiUHVsc2UgcmVnaXN0cmF0aW9uIGZhaWxlZCAod2lsbCByZXRyeSBvbiBuZXh0IHN0YXJ0KTogJF8iICJXQVJOIgogICAgICAgIFNldC1TdGVwICJQdWxzZSByZWdpc3RyYXRpb24iICJXQVJOIiAiV2lsbCByZXRyeSBhdXRvbWF0aWNhbGx5IG9uIG5leHQgbG9naW4iCiAgICB9CgogICAgIyDilIDilIAgR1BVIFdhdGNoZG9nOiBwYXVzZSBvc24gZHVyaW5nIGdhbWluZyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAgIFdyaXRlLUxvZyAiSW5zdGFsbGluZyBHUFUgZ2FtaW5nIHdhdGNoZG9nLi4uIgogICAgJHdhdGNoZG9nID0gQCcKJGhpID0gNzU7ICRsbyA9IDIwOyAkcGF1c2VkID0gJGZhbHNlCiR2ZW5kb3IgPSBpZiAoR2V0LVdtaU9iamVjdCBXaW4zMl9WaWRlb0NvbnRyb2xsZXIgfCBXaGVyZS1PYmplY3QgeyAkXy5OYW1lIC1tYXRjaCAnTlZJRElBfEdlRm9yY2V8UlRYfEdUWCcgfSB8IFNlbGVjdC1PYmplY3QgLUZpcnN0IDEpIHsgJ05WSURJQScgfSBlbHNlIHsgJ0FNRCcgfQp3aGlsZSAoJHRydWUpIHsKICAgIHRyeSB7CiAgICAgICAgJHV0aWwgPSBpZiAoJHZlbmRvciAtZXEgJ05WSURJQScpIHsKICAgICAgICAgICAgW2ludF0oJiBudmlkaWEtc21pIC0tcXVlcnktZ3B1PXV0aWxpemF0aW9uLmdwdSAtLWZvcm1hdD1jc3Ysbm9oZWFkZXIsbm91bml0cyAyPiRudWxsKS5UcmltKCkKICAgICAgICB9IGVsc2UgewogICAgICAgICAgICAkcyA9IEdldC1Db3VudGVyICdcR1BVIEVuZ2luZSgqZW5ndHlwZV8zRClcVXRpbGl6YXRpb24gUGVyY2VudGFnZScgLUVycm9yQWN0aW9uIFNpbGVudGx5Q29udGludWUKICAgICAgICAgICAgaWYgKCRzKSB7IFtpbnRdKCRzLkNvdW50ZXJTYW1wbGVzIHwgTWVhc3VyZS1PYmplY3QgLVByb3BlcnR5IENvb2tlZFZhbHVlIC1NYXhpbXVtKS5NYXhpbXVtIH0gZWxzZSB7IDAgfQogICAgICAgIH0KICAgICAgICBpZiAoJHV0aWwgLWd0ICRoaSAtYW5kIC1ub3QgJHBhdXNlZCkgewogICAgICAgICAgICB3c2wgLWQgVWJ1bnR1IC0tIGJhc2ggLWMgInN1ZG8gc3lzdGVtY3RsIHN0b3Agb3NuIDI+L2Rldi9udWxsIgogICAgICAgICAgICAkcGF1c2VkID0gJHRydWUKICAgICAgICAgICAgQWRkLUNvbnRlbnQgIiRlbnY6TE9DQUxBUFBEQVRBXFB1bHNlXG9jdGFfd2F0Y2hkb2cubG9nIiAiJChHZXQtRGF0ZSAtZiAnSEg6bW0nKSBQQVVTRUQgKEdQVSAkdXRpbCUpIgogICAgICAgIH0gZWxzZWlmICgkdXRpbCAtbHQgJGxvIC1hbmQgJHBhdXNlZCkgewogICAgICAgICAgICB3c2wgLWQgVWJ1bnR1IC0tIGJhc2ggLWMgInN1ZG8gc3lzdGVtY3RsIHN0YXJ0IG9zbiAyPi9kZXYvbnVsbCIKICAgICAgICAgICAgJHBhdXNlZCA9ICRmYWxzZQogICAgICAgICAgICBBZGQtQ29udGVudCAiJGVudjpMT0NBTEFQUERBVEFcUHVsc2Vcb2N0YV93YXRjaGRvZy5sb2ciICIkKEdldC1EYXRlIC1mICdISDptbScpIFJFU1VNRUQgKEdQVSAkdXRpbCUpIgogICAgICAgIH0KICAgIH0gY2F0Y2gge30KICAgIFN0YXJ0LVNsZWVwIDMwCn0KJ0AKICAgICR3YXRjaGRvZ1BhdGggPSAiJFBVTFNFX0RJUlxvY3RhX3dhdGNoZG9nLnBzMSIKICAgIFNldC1Db250ZW50IC1QYXRoICR3YXRjaGRvZ1BhdGggLVZhbHVlICR3YXRjaGRvZyAtRW5jb2RpbmcgVVRGOAoKICAgICR3QSA9IE5ldy1TY2hlZHVsZWRUYXNrQWN0aW9uIC1FeGVjdXRlICJwb3dlcnNoZWxsLmV4ZSIgYAogICAgICAgIC1Bcmd1bWVudCAiLU5vUHJvZmlsZSAtRXhlY3V0aW9uUG9saWN5IEJ5cGFzcyAtV2luZG93U3R5bGUgSGlkZGVuIC1GaWxlIGAiJHdhdGNoZG9nUGF0aGAiIgogICAgJHdUID0gTmV3LVNjaGVkdWxlZFRhc2tUcmlnZ2VyIC1BdExvZ09uCiAgICAkd1MgPSBOZXctU2NoZWR1bGVkVGFza1NldHRpbmdzU2V0IC1BbGxvd1N0YXJ0SWZPbkJhdHRlcmllcyAtRXhlY3V0aW9uVGltZUxpbWl0IDAKICAgICR3UCA9IE5ldy1TY2hlZHVsZWRUYXNrUHJpbmNpcGFsIC1Vc2VySWQgJGVudjpVU0VSTkFNRSAtUnVuTGV2ZWwgSGlnaGVzdAogICAgUmVnaXN0ZXItU2NoZWR1bGVkVGFzayAtVGFza05hbWUgJFdBVENIRE9HX1RBU0sgLUFjdGlvbiAkd0EgLVRyaWdnZXIgJHdUIGAKICAgICAgICAtU2V0dGluZ3MgJHdTIC1QcmluY2lwYWwgJHdQIC1Gb3JjZSB8IE91dC1OdWxsCiAgICBXcml0ZS1Mb2cgIkdQVSB3YXRjaGRvZyBpbnN0YWxsZWQgKHBhdXNlcyBkdXJpbmcgZ2FtaW5nLCByZXN1bWVzIHdoZW4gaWRsZSkiICJPSyIKICAgIFNldC1TdGVwICJHUFUgd2F0Y2hkb2cgdGFzayIgIlBBU1MiCgogICAgIyDilIDilIAgQXV0by1zdGFydDogb3NuIG9uIGV2ZXJ5IGxvZ2luIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogICAgV3JpdGUtTG9nICJJbnN0YWxsaW5nIGF1dG8tc3RhcnQgdGFzay4uLiIKICAgICRhdXRvc3RhcnQgPSBpZiAoJG1pcnJvcmVkTmV0d29ya2luZykgewogICAgICAgIEAnClN0YXJ0LVNsZWVwIDE1CndzbCAtZCBVYnVudHUgLS0gYmFzaCAtYyAnc3VkbyBzeXN0ZW1jdGwgc3RhcnQgb3NuIDI+L2Rldi9udWxsJyAyPiYxIHwKICAgIEFkZC1Db250ZW50ICIkZW52OkxPQ0FMQVBQREFUQVxQdWxzZVxvY3RhX2F1dG9zdGFydC5sb2ciCidACiAgICB9IGVsc2UgewogICAgICAgIEAiClN0YXJ0LVNsZWVwIDE1CmAkd3NsSVAgPSAod3NsIC1kIFVidW50dSAtLXVzZXIgcm9vdCAtLSBiYXNoIC1jICdob3N0bmFtZSAtSSAyPi9kZXYvbnVsbCcpLlRyaW0oKS5TcGxpdCgpWzBdCmAkbGFzdElQRmlsZSA9ICJgJGVudjpMT0NBTEFQUERBVEFcUHVsc2VcbGFzdF93c2xfaXAiCmAkbGFzdElQID0gaWYgKFRlc3QtUGF0aCBgJGxhc3RJUEZpbGUpIHsgKEdldC1Db250ZW50IGAkbGFzdElQRmlsZSkuVHJpbSgpIH0gZWxzZSB7ICcnIH0KaWYgKGAkd3NsSVAgLWFuZCBgJHdzbElQIC1uZSBgJGxhc3RJUCkgewogICAgKEAoMTg4ODgpICsgKDUxODAwLi41MTgxNikpIHwgRm9yRWFjaC1PYmplY3QgewogICAgICAgIG5ldHNoIGludGVyZmFjZSBwb3J0cHJveHkgZGVsZXRlIHY0dG92NCBsaXN0ZW5wb3J0PWAkXyBsaXN0ZW5hZGRyZXNzPTAuMC4wLjAgfCBPdXQtTnVsbAogICAgICAgIG5ldHNoIGludGVyZmFjZSBwb3J0cHJveHkgYWRkIHY0dG92NCBsaXN0ZW5wb3J0PWAkXyBsaXN0ZW5hZGRyZXNzPTAuMC4wLjAgY29ubmVjdHBvcnQ9YCRfIGNvbm5lY3RhZGRyZXNzPWAkd3NsSVAgfCBPdXQtTnVsbAogICAgfQogICAgU2V0LUNvbnRlbnQgLVBhdGggYCRsYXN0SVBGaWxlIC1WYWx1ZSBgJHdzbElQCn0Kd3NsIC1kIFVidW50dSAtLSBiYXNoIC1jICdzdWRvIHN5c3RlbWN0bCBzdGFydCBvc24gMj4vZGV2L251bGwnIDI+JjEgfAogICAgQWRkLUNvbnRlbnQgImAkZW52OkxPQ0FMQVBQREFUQVxQdWxzZVxvY3RhX2F1dG9zdGFydC5sb2ciCiJACiAgICB9CiAgICAkc3RhcnRQYXRoID0gIiRQVUxTRV9ESVJcb2N0YV9hdXRvc3RhcnQucHMxIgogICAgU2V0LUNvbnRlbnQgLVBhdGggJHN0YXJ0UGF0aCAtVmFsdWUgJGF1dG9zdGFydCAtRW5jb2RpbmcgVVRGOAoKICAgICRzQSA9IE5ldy1TY2hlZHVsZWRUYXNrQWN0aW9uIC1FeGVjdXRlICJwb3dlcnNoZWxsLmV4ZSIgYAogICAgICAgIC1Bcmd1bWVudCAiLU5vUHJvZmlsZSAtRXhlY3V0aW9uUG9saWN5IEJ5cGFzcyAtV2luZG93U3R5bGUgSGlkZGVuIC1GaWxlIGAiJHN0YXJ0UGF0aGAiIgogICAgJHNUID0gTmV3LVNjaGVkdWxlZFRhc2tUcmlnZ2VyIC1BdExvZ09uCiAgICAkc1MgPSBOZXctU2NoZWR1bGVkVGFza1NldHRpbmdzU2V0IC1BbGxvd1N0YXJ0SWZPbkJhdHRlcmllcyAtRXhlY3V0aW9uVGltZUxpbWl0IDAKICAgICRzUCA9IE5ldy1TY2hlZHVsZWRUYXNrUHJpbmNpcGFsIC1Vc2VySWQgJGVudjpVU0VSTkFNRSAtUnVuTGV2ZWwgSGlnaGVzdAogICAgUmVnaXN0ZXItU2NoZWR1bGVkVGFzayAtVGFza05hbWUgJEFVVE9TVEFSVF9UQVNLIC1BY3Rpb24gJHNBIC1UcmlnZ2VyICRzVCBgCiAgICAgICAgLVNldHRpbmdzICRzUyAtUHJpbmNpcGFsICRzUCAtRm9yY2UgfCBPdXQtTnVsbAogICAgV3JpdGUtTG9nICJBdXRvLXN0YXJ0IGluc3RhbGxlZCIgIk9LIgogICAgU2V0LVN0ZXAgIkF1dG8tc3RhcnQgdGFzayIgIlBBU1MiCgogICAgIyDilIDilIAgQXV0by1sb2dpbjogc3Vydml2ZSB1bmF0dGVuZGVkIHJlYm9vdHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgICBXcml0ZS1Ib3N0ICIiCiAgICBXcml0ZS1Ib3N0ICIgIOKUjOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUkCIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgIFdyaXRlLUhvc3QgIiAg4pSCICBBVVRPLUxPR0lOIChyZWNvbW1lbmRlZCBmb3IgZGVkaWNhdGVkIEdQVSBzZXJ2ZXJzKSAgICAgICAgICDilIIiIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgV3JpdGUtSG9zdCAiICDilIIgIFdpdGhvdXQgdGhpcywgT2N0YVNwYWNlIGdvZXMgT0ZGTElORSBhZnRlciBhbnkgdW5hdHRlbmRlZCAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgV3JpdGUtSG9zdCAiICDilIIgIHJlYm9vdCAocG93ZXIgY3V0LCBXaW5kb3dzIFVwZGF0ZSkgdW50aWwgc29tZW9uZSBsb2dzIGluLiAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgIFdyaXRlLUhvc3QgIiAg4pSCICBUcmFkZS1vZmY6IHN0b3JlcyB5b3VyIFdpbmRvd3MgcGFzc3dvcmQgaW4gdGhlIHJlZ2lzdHJ5LiAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgIFdyaXRlLUhvc3QgIiAg4pSCICBPbmx5IGVuYWJsZSBpZiB0aGlzIG1hY2hpbmUgaXMgaW4gYSBwaHlzaWNhbGx5IHNlY3VyZSBzcG90LuKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgIFdyaXRlLUhvc3QgIiAg4pSCICBUbyB1bmRvIGxhdGVyOiBydW4gbmV0cGx3aXogYW5kIHJlLWVuYWJsZSBwYXNzd29yZCBwcm9tcHQuIOKUgiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgIFdyaXRlLUhvc3QgIiAg4pSU4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSYIiAtRm9yZWdyb3VuZENvbG9yIFllbGxvdwogICAgV3JpdGUtSG9zdCAiIgogICAgJGRvQXV0b0xvZ2luID0gUmVhZC1Ib3N0ICIgIEVuYWJsZSBhdXRvLWxvZ2luPyAoeS9OKSIKICAgIGlmICgkZG9BdXRvTG9naW4gLW1hdGNoICdeW1l5XScpIHsKICAgICAgICAkc2VjdXJlUGFzcyA9IFJlYWQtSG9zdCAiICBFbnRlciB5b3VyIFdpbmRvd3MgbG9naW4gcGFzc3dvcmQiIC1Bc1NlY3VyZVN0cmluZwogICAgICAgICRic3RyICAgICAgPSBbUnVudGltZS5JbnRlcm9wU2VydmljZXMuTWFyc2hhbF06OlNlY3VyZVN0cmluZ1RvQlNUUigkc2VjdXJlUGFzcykKICAgICAgICAkcGxhaW5QYXNzID0gW1J1bnRpbWUuSW50ZXJvcFNlcnZpY2VzLk1hcnNoYWxdOjpQdHJUb1N0cmluZ0F1dG8oJGJzdHIpCiAgICAgICAgW1J1bnRpbWUuSW50ZXJvcFNlcnZpY2VzLk1hcnNoYWxdOjpaZXJvRnJlZUJTVFIoJGJzdHIpCgogICAgICAgICRyZWdQYXRoID0gIkhLTE06XFNPRlRXQVJFXE1pY3Jvc29mdFxXaW5kb3dzIE5UXEN1cnJlbnRWZXJzaW9uXFdpbmxvZ29uIgogICAgICAgIFNldC1JdGVtUHJvcGVydHkgLVBhdGggJHJlZ1BhdGggLU5hbWUgIkF1dG9BZG1pbkxvZ29uIiAgIC1WYWx1ZSAiMSIgICAgICAgICAgICAgLVR5cGUgU3RyaW5nCiAgICAgICAgU2V0LUl0ZW1Qcm9wZXJ0eSAtUGF0aCAkcmVnUGF0aCAtTmFtZSAiRGVmYXVsdFVzZXJuYW1lIiAgIC1WYWx1ZSAkZW52OlVTRVJOQU1FICAgLVR5cGUgU3RyaW5nCiAgICAgICAgU2V0LUl0ZW1Qcm9wZXJ0eSAtUGF0aCAkcmVnUGF0aCAtTmFtZSAiRGVmYXVsdERvbWFpbk5hbWUiIC1WYWx1ZSAkZW52OlVTRVJET01BSU4gLVR5cGUgU3RyaW5nCiAgICAgICAgU2V0LUl0ZW1Qcm9wZXJ0eSAtUGF0aCAkcmVnUGF0aCAtTmFtZSAiRGVmYXVsdFBhc3N3b3JkIiAgIC1WYWx1ZSAkcGxhaW5QYXNzICAgICAgLVR5cGUgU3RyaW5nCiAgICAgICAgJHBsYWluUGFzcyA9ICRudWxsOyBbU3lzdGVtLkdDXTo6Q29sbGVjdCgpCgogICAgICAgIFdyaXRlLUxvZyAiQXV0by1sb2dpbiBlbmFibGVkIGZvciAkZW52OlVTRVJOQU1FIOKAlCBPY3RhU3BhY2UgcmVzdW1lcyBhdXRvbWF0aWNhbGx5IGFmdGVyIGFueSByZWJvb3QiICJPSyIKICAgICAgICBXcml0ZS1Mb2cgIlRvIGRpc2FibGU6IHJ1biBuZXRwbHdpeiBhbmQgcmUtY2hlY2sgJ1VzZXJzIG11c3QgZW50ZXIgYSB1c2VybmFtZSBhbmQgcGFzc3dvcmQnIiAiSU5GTyIKICAgICAgICBTZXQtU3RlcCAiQXV0by1sb2dpbiIgIlBBU1MiICJFbmFibGVkIGZvciAkZW52OlVTRVJOQU1FIgogICAgfSBlbHNlIHsKICAgICAgICBXcml0ZS1Mb2cgIkF1dG8tbG9naW4gc2tpcHBlZCDigJQgbWFjaGluZSB3aWxsIG5lZWQgYSBtYW51YWwgbG9naW4gYWZ0ZXIgcmVib290IHRvIHJlc3VtZSBPY3RhU3BhY2UiICJXQVJOIgogICAgICAgIFNldC1TdGVwICJBdXRvLWxvZ2luIiAiU0tJUCIgIlNraXBwZWQg4oCUIEdQVSBnb2VzIG9mZmxpbmUgYWZ0ZXIgdW5hdHRlbmRlZCByZWJvb3RzIgogICAgfQoKICAgICMg4pSA4pSAIENsZWFudXAg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgICBzY2h0YXNrcyAvZGVsZXRlIC90biAkVEFTS19OQU1FIC9mIDI+JG51bGwgfCBPdXQtTnVsbAogICAgUmVtb3ZlLUl0ZW0gJFBIQVNFX0ZJTEUgLUVycm9yQWN0aW9uIFNpbGVudGx5Q29udGludWUKCiAgICAjIOKUgOKUgCBTdW1tYXJ5IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogICAgIyBXcml0ZSBmaW5hbCBkaWFnbm9zdGljcyBzbmFwc2hvdCB0byBsb2cgKHNjcmVlbiBvdXRwdXQgaXMgdGhlIGNsZWFuIHN1bW1hcnkgYmVsb3cpCiAgICBTaG93LURpYWdub3N0aWNzIC1Mb2dPbmx5CgogICAgU2hvdy1CYW5uZXIgIlNldHVwIENvbXBsZXRlIgogICAgV3JpdGUtSG9zdCAiICBZb3VyIEdQVSBpcyBub3cgZWFybmluZyB2aWEgUHVsc2UgKyBPY3RhU3BhY2UuIiAtRm9yZWdyb3VuZENvbG9yIEdyZWVuCiAgICBXcml0ZS1Ib3N0ICIiCiAgICBAKAogICAgICAgIEB7IEwgPSAiR1BVIjsgICAgICAgICAgViA9ICRncHVOYW1lIH0sCiAgICAgICAgQHsgTCA9ICJWUkFNIjsgICAgICAgICBWID0gIiR7dnJhbUdifSBHQiIgfSwKICAgICAgICBAeyBMID0gIlBsYXRmb3JtIjsgICAgIFYgPSAiT2N0YVNwYWNlICh2aWEgUHVsc2UpIiB9LAogICAgICAgIEB7IEwgPSAiTm9kZSB0b2tlbiI7ICAgViA9IGlmICgkb2N0YU5vZGVUb2tlbikgeyAkb2N0YU5vZGVUb2tlbiB9IGVsc2UgeyAiUGVuZGluZyDigJQgY2hlY2sgY3ViZS5vY3RhLmNvbXB1dGVyIiB9IH0sCiAgICAgICAgQHsgTCA9ICJHYW1pbmcgcGF1c2UiOyBWID0gIkF1dG8gKEdQVSA+IDc1JSB1dGlsKSIgfSwKICAgICAgICBAeyBMID0gIkF1dG8tc3RhcnQiOyAgIFYgPSAiT24gZXZlcnkgV2luZG93cyBsb2dpbiIgfSwKICAgICAgICBAeyBMID0gIkxvZ3MiOyAgICAgICAgIFYgPSAkTE9HX0ZJTEUgfQogICAgKSB8IEZvckVhY2gtT2JqZWN0IHsgV3JpdGUtSG9zdCAoIiAgezAsLTE2fSB7MX0iIC1mICRfLkwsICRfLlYpIC1Gb3JlZ3JvdW5kQ29sb3IgV2hpdGUgfQogICAgV3JpdGUtSG9zdCAiIgogICAgV3JpdGUtSG9zdCAiICBEYXNoYm9hcmQ6ICBodHRwczovL2JlbmVmaWNpYWwtZGVlcC13b3JrLWZsb3cuYmFzZTQ0LmFwcCIgLUZvcmVncm91bmRDb2xvciBDeWFuCiAgICBXcml0ZS1Ib3N0ICIgIEN1YmU6ICAgICAgIGh0dHBzOi8vY3ViZS5vY3RhLmNvbXB1dGVyIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4KICAgIFdyaXRlLUhvc3QgIiIKICAgIFdyaXRlLUhvc3QgIiAg4pSM4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSQIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5CiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgSU5TVEFMTCBMT0cgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5CiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5CiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgQSBmdWxsIGxvZyBvZiBldmVyeSBpbnN0YWxsIHN0ZXAgd2FzIHNhdmVkIHRvOiAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5CiAgICBXcml0ZS1Ib3N0ICgiICDilIIgICAgezAsLTYwfeKUgiIgLWYgJExPR19GSUxFKSAtRm9yZWdyb3VuZENvbG9yIFdoaXRlCiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg4pSCIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5CiAgICBXcml0ZS1Ib3N0ICIgIOKUgiAgVG8gb3BlbiBpdDogICBub3RlcGFkIGAiJExPR19GSUxFYCIiIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkKICAgIFdyaXRlLUhvc3QgIiAg4pSCICBUbyBicm93c2U6ICAgIFJ1biDihpIgJUxPQ0FMQVBQREFUQSVcUHVsc2UgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBEYXJrR3JheQogICAgV3JpdGUtSG9zdCAiICDilIIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBEYXJrR3JheQogICAgV3JpdGUtSG9zdCAiICDilIIgIFNoYXJlIGl0IHdpdGggUHVsc2Ugc3VwcG9ydCBpZiBhbnl0aGluZyBsb29rcyB3cm9uZy4gICAgICAgIOKUgiIgLUZvcmVncm91bmRDb2xvciBEYXJrR3JheQogICAgV3JpdGUtSG9zdCAiICDilJTilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilJgiIC1Gb3JlZ3JvdW5kQ29sb3IgRGFya0dyYXkKICAgIFdyaXRlLUhvc3QgIiIKICAgIFdhaXQtRm9yS2V5Cn0KCiMg4pSA4pSAIEVudHJ5IFBvaW50IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKdHJhcCB7CiAgICBXcml0ZS1Ib3N0ICIiCiAgICBXcml0ZS1Ib3N0ICIgIFtFUlJPUl0gQW4gdW5leHBlY3RlZCBlcnJvciBzdG9wcGVkIHRoZSBpbnN0YWxsZXI6IiAtRm9yZWdyb3VuZENvbG9yIFJlZAogICAgV3JpdGUtSG9zdCAiICAkXyIgLUZvcmVncm91bmRDb2xvciBSZWQKICAgIFNob3ctRGlhZ25vc3RpY3MKICAgIFJlYWQtSG9zdCAiICBQcmVzcyBFbnRlciB0byBjbG9zZSB0aGlzIHdpbmRvdyIKICAgIGV4aXQgMQp9CgpBc3NlcnQtQWRtaW4KTmV3LUl0ZW0gLUl0ZW1UeXBlIERpcmVjdG9yeSAtRm9yY2UgLVBhdGggJFBVTFNFX0RJUiB8IE91dC1OdWxsCgokcGhhc2UgPSBpZiAoVGVzdC1QYXRoICRQSEFTRV9GSUxFKSB7IEdldC1Db250ZW50ICRQSEFTRV9GSUxFIH0gZWxzZSB7ICIxIiB9CnN3aXRjaCAoJHBoYXNlKSB7CiAgICAiMSIgICAgIHsgSW52b2tlLVBoYXNlMSB9CiAgICAiMiIgICAgIHsgSW52b2tlLVBoYXNlMiB9CiAgICBkZWZhdWx0IHsgV3JpdGUtSG9zdCAiVW5rbm93biBwaGFzZTogJHBoYXNlIiAtRm9yZWdyb3VuZENvbG9yIFJlZDsgV2FpdC1Gb3JLZXk7IGV4aXQgMSB9Cn0K';
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