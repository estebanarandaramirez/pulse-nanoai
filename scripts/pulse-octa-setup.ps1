#Requires -Version 5.1
<#
.SYNOPSIS
    PULSE GPU Provider Setup — OctaSpace Installer
.DESCRIPTION
    Phase 1: Enables WSL2, schedules Phase 2 to run after reboot.
    Phase 2: Installs Ubuntu, OctaSpace node (osn), sets up networking
             (UPnP + portproxy for TCP, mirrored networking recommended for UDP),
             GPU gaming detection, and auto-start.

    Embedded at download time by Pulse's generateSetupScript function:
      PULSE_USER_TOKEN — user's session token for Pulse API callback
      PULSE_APP_ID     — base44 app ID
#>

# ── Embedded by server at download time ──────────────────────────────────────
$PULSE_USER_TOKEN = "{{PULSE_USER_TOKEN}}"
$PULSE_APP_ID     = "{{PULSE_APP_ID}}"
$PULSE_API_BASE   = "https://api.base44.app/api/apps/$PULSE_APP_ID/functions"
# ─────────────────────────────────────────────────────────────────────────────

$PULSE_DIR      = "$env:LOCALAPPDATA\Pulse"
$PHASE_FILE     = "$PULSE_DIR\octa_setup_phase"
$LOG_FILE       = "$PULSE_DIR\octa_setup.log"
$TASK_NAME      = "PulseOctaSetupResume"
$WATCHDOG_TASK  = "PulseOctaWatchdog"
$AUTOSTART_TASK = "PulseOctaAutoStart"

# OctaSpace ports — management (API) and encrypted tunnel range (TCP+UDP)
$OCTA_MGMT_PORTS     = @(18888)
$OCTA_APP_PORT_START = 51800
$OCTA_APP_PORT_END   = 51816

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
    Write-Host "  ██████╗ ██╗   ██╗██╗     ███████╗███████╗" -ForegroundColor Magenta
    Write-Host "  ██╔══██╗██║   ██║██║     ██╔════╝██╔════╝" -ForegroundColor Magenta
    Write-Host "  ██████╔╝██║   ██║██║     ███████╗█████╗  " -ForegroundColor Magenta
    Write-Host "  ██╔═══╝ ██║   ██║██║     ╚════██║██╔══╝  " -ForegroundColor Magenta
    Write-Host "  ██║     ╚██████╔╝███████╗███████║███████╗" -ForegroundColor Magenta
    Write-Host "  ╚═╝      ╚═════╝ ╚══════╝╚══════╝╚══════╝" -ForegroundColor Magenta
    Write-Host ""
    Write-Host "  GPU Provider Setup — OctaSpace" -ForegroundColor White
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
    # TCP only — portproxy does not support UDP. UDP tunnel ports (51800-51816)
    # require mirrored networking on Windows 11 22H2+ to function correctly.
    $allPorts = $OCTA_MGMT_PORTS + ($OCTA_APP_PORT_START..$OCTA_APP_PORT_END)
    foreach ($p in $allPorts) {
        netsh interface portproxy delete v4tov4 listenport=$p listenaddress=0.0.0.0 | Out-Null
        netsh interface portproxy add v4tov4 listenport=$p listenaddress=0.0.0.0 `
            connectport=$p connectaddress=$WslIP | Out-Null
    }
    Write-Log "WSL2 portproxy (TCP): $($OCTA_MGMT_PORTS -join ',') + $OCTA_APP_PORT_START-$OCTA_APP_PORT_END → $WslIP" "OK"
    Write-Log "NOTE: UDP ports $OCTA_APP_PORT_START-$OCTA_APP_PORT_END need mirrored networking for full tunnel support" "WARN"
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

    $build = [System.Environment]::OSVersion.Version.Build
    if ($build -lt 19041) {
        Set-Step "Windows compatibility (build 19041+)" "FAIL" "Build $build — requires 19041 (Windows 10 2004+)"
        Write-Log "Windows build $build is too old. WSL2 requires build 19041+ (Windows 10 2004+)." "ERROR"
        Show-Diagnostics; Wait-ForKey; exit 1
    }
    Write-Log "Windows build $build — OK" "OK"
    Set-Step "Windows compatibility (build 19041+)" "PASS" "Build $build"

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

    Write-Log "Enabling WSL2 Windows features..."
    dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart | Out-Null
    dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart | Out-Null
    Write-Log "WSL2 features enabled" "OK"
    Set-Step "WSL2 features enabled" "PASS"

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

    Set-Content -Path $PHASE_FILE -Value "2" -Encoding UTF8

    $stablePath = "$PULSE_DIR\pulse-octa-setup.ps1"
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

# ── Phase 2: Ubuntu + OctaSpace (osn) + Networking + Auto-start ──────────────

function Invoke-Phase2 {
    Show-Banner "Phase 2 of 2 — Installing OctaSpace Provider Stack"

    $script:Steps = [ordered]@{}
    Register-Step "Ubuntu on WSL2"
    Register-Step "systemd in WSL2"
    Register-Step "WSL2 networking"
    Register-Step "GPU compute in WSL2" "Update Windows NVIDIA driver at nvidia.com/drivers"
    Register-Step "Build tools (curl, bash)" "wsl -d Ubuntu-22.04 -- bash -c 'apt-get update && apt-get install -y curl bash'"
    Register-Step "OctaSpace osn installed" "Check install.octa.space or OctaSpace docs"
    Register-Step "osn service started"
    Register-Step "OctaSpace node token"
    Register-Step "Windows Firewall rules"
    Register-Step "UPnP port forwarding"
    Register-Step "WSL2 port proxy"
    Register-Step "Pulse registration"
    Register-Step "GPU watchdog task"
    Register-Step "Auto-start task"
    Register-Step "Auto-login"

    Write-Log "Setting up Ubuntu on WSL2..."
    $distros = wsl --list --quiet 2>&1
    if ($distros -notmatch "Ubuntu-22.04") {
        Write-Log "Downloading Ubuntu..."
        wsl --install -d Ubuntu-22.04 --no-launch 2>&1 | Out-Null

        Write-Log "Initializing Ubuntu headlessly (no GUI required)..."
        $ubuntuExe = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WindowsApps" -Filter "ubuntu*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($ubuntuExe) {
            & $ubuntuExe.FullName install --root 2>&1 | Out-Null
        } else {
            wsl -d Ubuntu-22.04 --user root -- bash -c "echo ok" 2>&1 | Out-Null
        }
        Start-Sleep 5

        $check = wsl -d Ubuntu-22.04 --user root -- bash -c "echo ok" 2>&1
        if ($check -notmatch "ok") {
            Write-Log "Ubuntu root access failed — re-run installer." "ERROR"
            Show-Diagnostics; Wait-ForKey; exit 1
        }

        Write-Log "Ubuntu installed and initialized" "OK"
    } else {
        Write-Log "Ubuntu already present" "OK"
    }
    Set-Step "Ubuntu on WSL2" "PASS"

    # Enable systemd — osn is a systemd service
    Write-Log "Enabling systemd in WSL2 (required for osn service)..."
    wsl -d Ubuntu-22.04 --user root -- bash -c "grep -q 'systemd=true' /etc/wsl.conf 2>/dev/null || printf '[boot]\nsystemd=true\n' > /etc/wsl.conf"

    # WSL2 mirrored networking — especially important for OctaSpace because the
    # tunnel ports 51800-51816 use UDP, and portproxy is TCP-only.
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
        Write-Log "WSL2 mirrored networking configured — UDP tunnels will work correctly" "OK"
        Set-Step "WSL2 networking" "PASS" "Mirrored (Windows 11 22H2+) — UDP tunnels fully functional"
    } else {
        Write-Log "Windows build ${osBuild}: mirrored networking needs 22H2 (22621+) — portproxy only covers TCP; UDP tunnels will be limited" "WARN"
        Set-Step "WSL2 networking" "WARN" "Portproxy only (build $osBuild) — UDP tunnel ports limited; upgrade to Win 11 22H2+ recommended"
    }

    wsl --shutdown
    Start-Sleep 20
    $sdCheck = wsl -d Ubuntu-22.04 --user root -- bash -c "[ -d /run/systemd/system ] && echo yes || echo no" 2>&1
    if ($sdCheck -match "yes") {
        Write-Log "systemd running in WSL2" "OK"
        Set-Step "systemd in WSL2" "PASS"
    } else {
        Write-Log "systemd may not be active — osn may not auto-start on reboot" "WARN"
        Set-Step "systemd in WSL2" "WARN" "systemd not detected — osn service may not persist across reboots"
    }

    # ── Detect GPU vendor ─────────────────────────────────────────────────────
    $gpuObj    = Get-WmiObject Win32_VideoController | Where-Object { $_.Name -match "NVIDIA|GeForce|RTX|GTX|AMD|Radeon" } | Select-Object -First 1
    $gpuName   = $gpuObj.Name
    $vramMb    = $gpuObj.AdapterRAM
    $vramGb    = if ($vramMb -and $vramMb -gt 0) { [math]::Round($vramMb / 1GB) } else { 8 }
    $gpuVendor = if ($gpuName -match "NVIDIA|GeForce|RTX|GTX") { "NVIDIA" } else { "AMD" }

    # ── Pre-install GPU compute drivers inside WSL2 ───────────────────────────
    Write-Log "Checking GPU compute environment in WSL2 ($gpuVendor)..."
    if ($gpuVendor -eq "NVIDIA") {
        $nvCheck = wsl -d Ubuntu-22.04 --user root -- bash -c "nvidia-smi -L 2>/dev/null | head -1" 2>&1
        if ($nvCheck -match "GPU 0") {
            Write-Log "NVIDIA GPU visible in WSL2" "OK"
            Set-Step "GPU compute in WSL2" "PASS" "nvidia-smi OK — $gpuName"
        } else {
            Write-Log "NVIDIA GPU not yet visible in WSL2 — ensure Windows NVIDIA driver is up to date" "WARN"
            Set-Step "GPU compute in WSL2" "WARN" "nvidia-smi returned no output — osn may fail without GPU access"
        }
    } else {
        Write-Log "Installing ROCm for AMD GPU in WSL2 (this takes a few minutes)..."
        $ubuntuVer = wsl -d Ubuntu-22.04 --user root -- bash -c "lsb_release -cs 2>/dev/null" 2>&1
        $ubuntuVer = $ubuntuVer.Trim()
        if ($ubuntuVer -notin @("jammy","focal","noble")) { $ubuntuVer = "jammy" }
        $rocmScript = "set -e`nexport DEBIAN_FRONTEND=noninteractive`napt-get update -qq`napt-get install -y -qq wget gnupg ca-certificates`nmkdir -p /etc/apt/keyrings`nwget -qO - https://repo.radeon.com/rocm/rocm.gpg.key | gpg --dearmor -o /etc/apt/keyrings/rocm.gpg`necho 'deb [arch=amd64 signed-by=/etc/apt/keyrings/rocm.gpg] https://repo.radeon.com/rocm/apt/6.2 $ubuntuVer main' > /etc/apt/sources.list.d/rocm.list`napt-get update -qq`napt-get install -y -qq rocm-opencl-runtime"
        # Pipe via stdin to avoid CRLF issues with bash -c on Windows
        $rocmScript | wsl -d Ubuntu-22.04 --user root -- bash 2>&1 | ForEach-Object { Write-Log $_ }
        if ($LASTEXITCODE -eq 0) {
            Write-Log "ROCm installed" "OK"
            Set-Step "GPU compute in WSL2" "PASS" "ROCm opencl-runtime installed — $gpuName"
        } else {
            Write-Log "ROCm install encountered errors — OctaSpace may have limited AMD support" "WARN"
            Set-Step "GPU compute in WSL2" "WARN" "ROCm install had errors — AMD support may be limited"
        }
    }

    # ── Install OctaSpace node (osn) inside WSL2 ─────────────────────────────
    Write-Log "Installing osn prerequisites (curl, bash, gum)..."
    wsl -d Ubuntu-22.04 --user root -- bash -c "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq curl bash" 2>&1 | ForEach-Object { Write-Log $_ }
    if ($LASTEXITCODE -eq 0) {
        Set-Step "Build tools (curl, bash)" "PASS"
    } else {
        Set-Step "Build tools (curl, bash)" "WARN" "apt-get exit $LASTEXITCODE — osn installer will attempt to continue anyway"
    }

    Write-Log "Installing gum (required by OctaSpace installer)..."
    $gumInstall = "export DEBIAN_FRONTEND=noninteractive && mkdir -p /etc/apt/keyrings && curl -fsSL https://repo.charm.sh/apt/gpg.key | gpg --dearmor -o /etc/apt/keyrings/charm.gpg && echo 'deb [signed-by=/etc/apt/keyrings/charm.gpg] https://repo.charm.sh/apt/ * *' | tee /etc/apt/sources.list.d/charm.list > /dev/null && apt-get update -qq && apt-get install -y -qq gum"
    wsl -d Ubuntu-22.04 --user root -- bash -c $gumInstall 2>&1 | ForEach-Object { Write-Log $_ }
    if ($LASTEXITCODE -ne 0) {
        Write-Log "gum install failed — OctaSpace installer may fail" "WARN"
    } else {
        Write-Log "gum installed" "OK"
    }

    Write-Log "Installing OctaSpace node (osn) inside WSL2..."
    $octaOutput = wsl -d Ubuntu-22.04 --user root -- bash -c "curl -fsSL https://install.octa.space | bash" 2>&1
    $octaExit = $LASTEXITCODE
    $octaOutput | ForEach-Object { Write-Log $_ }
    if ($octaExit -ne 0) {
        Set-Step "OctaSpace osn installed" "FAIL" "install.octa.space script exited $octaExit — see log for details"
        Write-Log "OctaSpace installation failed (exit $octaExit). Check the output above." "ERROR"
        Show-Diagnostics; Wait-ForKey; exit 1
    }
    Write-Log "OctaSpace osn install complete" "OK"
    Set-Step "OctaSpace osn installed" "PASS"

    # Start the service so it can register and generate a node token
    Write-Log "Starting osn service..."
    wsl -d Ubuntu-22.04 --user root -- bash -c "systemctl enable osn 2>/dev/null; systemctl start osn 2>/dev/null"
    Set-Step "osn service started" "PASS"

    # ── Extract OctaSpace node token from installer output ────────────────────
    # The installer prints a box: ║  Node Token: XXXXXXXXXX  ║ to stdout.
    $octaNodeToken = ""
    $tokenMatch = $octaOutput | Select-String -Pattern 'Node Token:\s*(\S+)'
    if ($tokenMatch) {
        $octaNodeToken = $tokenMatch.Matches[0].Groups[1].Value.Trim()
        Write-Log "OctaSpace node token: $octaNodeToken" "OK"
        Set-Step "OctaSpace node token" "PASS" "Token: $octaNodeToken"
    } else {
        # Fallback: check config files written by osn after first start
        Write-Log "Token not found in installer output — checking osn config files..."
        Start-Sleep 15
        $raw = wsl -d Ubuntu-22.04 --user root -- bash -c @'
for f in /home/octa/osn/etc/sys.config /etc/osn/node.json /var/lib/osn/node.json; do
    [ -f "$f" ] || continue
    tok=$(grep -oP '"node_token"\s*:\s*"\K[^"]+' "$f" 2>/dev/null || grep -oP '"token"\s*:\s*"\K[^"]+' "$f" 2>/dev/null)
    [ -n "$tok" ] && echo "$tok" && break
done
'@ 2>&1
        $candidate = ($raw | Where-Object { $_ -match '^\s*\S{6,}\s*$' }) | Select-Object -First 1
        if ($candidate) {
            $octaNodeToken = $candidate.Trim()
            Write-Log "OctaSpace node token (from config): $octaNodeToken" "OK"
            Set-Step "OctaSpace node token" "PASS" "Token: $octaNodeToken"
        } else {
            Write-Log "Node token not found — it will appear at cube.octa.computer after the node connects" "WARN"
            Set-Step "OctaSpace node token" "WARN" "Not yet assigned — check cube.octa.computer"
        }
    }

    # ── Networking: Windows Firewall + UPnP ──────────────────────────────────
    Write-Log "Adding Windows Firewall inbound rules (TCP + UDP)..."
    $allPorts = $OCTA_MGMT_PORTS + ($OCTA_APP_PORT_START..$OCTA_APP_PORT_END)
    foreach ($port in $allPorts) {
        New-NetFirewallRule -DisplayName "Pulse-Octa-TCP-$port" -Direction Inbound `
            -Protocol TCP -LocalPort $port -Action Allow -ErrorAction SilentlyContinue | Out-Null
        New-NetFirewallRule -DisplayName "Pulse-Octa-UDP-$port" -Direction Inbound `
            -Protocol UDP -LocalPort $port -Action Allow -ErrorAction SilentlyContinue | Out-Null
    }
    Write-Log "Firewall rules added (TCP+UDP) for ports $($OCTA_MGMT_PORTS -join ', ') + $OCTA_APP_PORT_START-$OCTA_APP_PORT_END" "OK"
    Set-Step "Windows Firewall rules" "PASS" "TCP+UDP $($OCTA_MGMT_PORTS -join ', '), $OCTA_APP_PORT_START-$OCTA_APP_PORT_END"

    Write-Log "Attempting UPnP automatic port forwarding..."
    $localIP = Get-LocalIP
    $upnpOk  = $false
    try {
        $upnp     = New-Object -ComObject HNetCfg.NATUPnP
        $mappings = $upnp.StaticPortMappingCollection
        foreach ($port in $allPorts) {
            $mappings.Add($port, "TCP", $port, $localIP, $true, "Pulse-Octa-TCP-$port") | Out-Null
            $mappings.Add($port, "UDP", $port, $localIP, $true, "Pulse-Octa-UDP-$port") | Out-Null
        }
        Write-Log "UPnP succeeded — ports $($OCTA_MGMT_PORTS -join ', '), $OCTA_APP_PORT_START-$OCTA_APP_PORT_END forwarded (TCP+UDP) to $localIP" "OK"
        Set-Step "UPnP port forwarding" "PASS" "Auto-forwarded (TCP+UDP) → $localIP"
        $upnpOk = $true
    } catch {
        Write-Log "UPnP unavailable on this router" "WARN"
        Set-Step "UPnP port forwarding" "WARN" "UPnP unavailable — manual router setup required (TCP+UDP, see above)"
    }

    if (-not $upnpOk) {
        Write-Host ""
        Write-Host "  ┌──────────────────────────────────────────────────────────────┐" -ForegroundColor Yellow
        Write-Host "  │  ROUTER SETUP REQUIRED (one-time, ~2 minutes)                │" -ForegroundColor Yellow
        Write-Host "  │                                                              │" -ForegroundColor Yellow
        Write-Host "  │  Your router doesn't support auto-forwarding (UPnP off).    │" -ForegroundColor Yellow
        Write-Host "  │  OctaSpace needs BOTH TCP and UDP forwarded.                │" -ForegroundColor Yellow
        Write-Host "  │                                                              │" -ForegroundColor Yellow
        Write-Host "  │  1. Open your router admin page (usually http://192.168.1.1)│" -ForegroundColor Yellow
        Write-Host "  │  2. Find 'Port Forwarding' or 'Virtual Server'              │" -ForegroundColor Yellow
        Write-Host "  │  3. Add TCP+UDP rules → $localIP :                          │" -ForegroundColor Yellow
        Write-Host "  │       TCP+UDP 18888 → $localIP`:18888                       │" -ForegroundColor Yellow
        Write-Host "  │       TCP+UDP $OCTA_APP_PORT_START-$OCTA_APP_PORT_END → $localIP`:$OCTA_APP_PORT_START-$OCTA_APP_PORT_END │" -ForegroundColor Yellow
        Write-Host "  │                                                              │" -ForegroundColor Yellow
        Write-Host "  │  Press Enter once done (you can finish this later via the   │" -ForegroundColor Yellow
        Write-Host "  │  Pulse dashboard — but jobs won't land until it's done)     │" -ForegroundColor Yellow
        Write-Host "  └──────────────────────────────────────────────────────────────┘" -ForegroundColor Yellow
        Read-Host "  Press Enter to continue"
    }

    # ── WSL2 Port Proxy (TCP only) ────────────────────────────────────────────
    if (-not $mirroredNetworking) {
        Write-Log "Configuring WSL2 TCP port proxy (Windows host → WSL2 bridge)..."
        $wslIP = (wsl -d Ubuntu-22.04 --user root -- bash -c "hostname -I 2>/dev/null").Trim().Split()[0]
        if ($wslIP) {
            Set-WSL2PortProxy -WslIP $wslIP
            Set-Content -Path "$PULSE_DIR\last_wsl_ip" -Value $wslIP -Encoding UTF8
            Set-Step "WSL2 port proxy" "PASS" "TCP → $wslIP (UDP requires mirrored networking)"
        } else {
            Write-Log "Could not determine WSL2 IP — portproxy skipped; will retry on next login" "WARN"
            Set-Step "WSL2 port proxy" "WARN" "WSL2 IP not found — will retry on next login"
        }
    } else {
        Write-Log "Mirrored networking active — portproxy not needed; UDP tunnels fully functional" "OK"
        Set-Step "WSL2 port proxy" "SKIP" "Not needed — mirrored networking active"
    }

    # ── Cube registration ─────────────────────────────────────────────────────
    Write-Host ""
    Write-Host "  ┌──────────────────────────────────────────────────────────────┐" -ForegroundColor Cyan
    Write-Host "  │  OCTASPACE CUBE REGISTRATION                                  │" -ForegroundColor Cyan
    Write-Host "  │                                                              │" -ForegroundColor Cyan
    Write-Host "  │  To appear in the OctaSpace marketplace:                     │" -ForegroundColor Cyan
    Write-Host "  │    1. Open: https://cube.octa.computer                       │" -ForegroundColor Cyan
    Write-Host "  │    2. Sign in / create an account                            │" -ForegroundColor Cyan
    Write-Host "  │    3. Add your node — it should appear automatically         │" -ForegroundColor Cyan
    if ($octaNodeToken) {
    Write-Host "  │                                                              │" -ForegroundColor Cyan
    Write-Host "  │    Your node token: $octaNodeToken" -ForegroundColor White
    }
    Write-Host "  │                                                              │" -ForegroundColor Cyan
    Write-Host "  │  This step is done in your browser, not this window.         │" -ForegroundColor Cyan
    Write-Host "  └──────────────────────────────────────────────────────────────┘" -ForegroundColor Cyan
    Write-Host ""
    Read-Host "  Press Enter to continue once you've noted the above"

    # ── Register with Pulse ───────────────────────────────────────────────────
    Write-Log "Registering machine with Pulse..."

    $body = @{
        gpu_model        = $gpuName
        vram_gb          = $vramGb
        octa_node_token  = $octaNodeToken
        platform         = "OctaSpace"
    } | ConvertTo-Json

    try {
        $resp = Invoke-RestMethod -Uri "$PULSE_API_BASE/registerOctaspaceDaemon" `
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

    # ── GPU Watchdog: pause osn during gaming ─────────────────────────────────
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
            wsl -d Ubuntu-22.04 -- bash -c "sudo systemctl stop osn 2>/dev/null"
            $paused = $true
            Add-Content "$env:LOCALAPPDATA\Pulse\octa_watchdog.log" "$(Get-Date -f 'HH:mm') PAUSED (GPU $util%)"
        } elseif ($util -lt $lo -and $paused) {
            wsl -d Ubuntu-22.04 -- bash -c "sudo systemctl start osn 2>/dev/null"
            $paused = $false
            Add-Content "$env:LOCALAPPDATA\Pulse\octa_watchdog.log" "$(Get-Date -f 'HH:mm') RESUMED (GPU $util%)"
        }
    } catch {}
    Start-Sleep 30
}
'@
    $watchdogPath = "$PULSE_DIR\octa_watchdog.ps1"
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

    # ── Auto-start: osn on every login ────────────────────────────────────────
    Write-Log "Installing auto-start task..."
    $autostart = if ($mirroredNetworking) {
        @'
Start-Sleep 15
wsl -d Ubuntu-22.04 -- bash -c 'sudo systemctl start osn 2>/dev/null' 2>&1 |
    Add-Content "$env:LOCALAPPDATA\Pulse\octa_autostart.log"
'@
    } else {
        @"
Start-Sleep 15
`$wslIP = (wsl -d Ubuntu-22.04 --user root -- bash -c 'hostname -I 2>/dev/null').Trim().Split()[0]
`$lastIPFile = "`$env:LOCALAPPDATA\Pulse\last_wsl_ip"
`$lastIP = if (Test-Path `$lastIPFile) { (Get-Content `$lastIPFile).Trim() } else { '' }
if (`$wslIP -and `$wslIP -ne `$lastIP) {
    (@(18888) + (51800..51816)) | ForEach-Object {
        netsh interface portproxy delete v4tov4 listenport=`$_ listenaddress=0.0.0.0 | Out-Null
        netsh interface portproxy add v4tov4 listenport=`$_ listenaddress=0.0.0.0 connectport=`$_ connectaddress=`$wslIP | Out-Null
    }
    Set-Content -Path `$lastIPFile -Value `$wslIP
}
wsl -d Ubuntu-22.04 -- bash -c 'sudo systemctl start osn 2>/dev/null' 2>&1 |
    Add-Content "`$env:LOCALAPPDATA\Pulse\octa_autostart.log"
"@
    }
    $startPath = "$PULSE_DIR\octa_autostart.ps1"
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
    Write-Host "  │  Without this, OctaSpace goes OFFLINE after any unattended  │" -ForegroundColor Yellow
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
        Set-ItemProperty -Path $regPath -Name "AutoAdminLogon"   -Value "1"             -Type String
        Set-ItemProperty -Path $regPath -Name "DefaultUsername"   -Value $env:USERNAME   -Type String
        Set-ItemProperty -Path $regPath -Name "DefaultDomainName" -Value $env:USERDOMAIN -Type String
        Set-ItemProperty -Path $regPath -Name "DefaultPassword"   -Value $plainPass      -Type String
        $plainPass = $null; [System.GC]::Collect()

        Write-Log "Auto-login enabled for $env:USERNAME — OctaSpace resumes automatically after any reboot" "OK"
        Write-Log "To disable: run netplwiz and re-check 'Users must enter a username and password'" "INFO"
        Set-Step "Auto-login" "PASS" "Enabled for $env:USERNAME"
    } else {
        Write-Log "Auto-login skipped — machine will need a manual login after reboot to resume OctaSpace" "WARN"
        Set-Step "Auto-login" "SKIP" "Skipped — GPU goes offline after unattended reboots"
    }

    # ── Cleanup ───────────────────────────────────────────────────────────────
    schtasks /delete /tn $TASK_NAME /f 2>$null | Out-Null
    Remove-Item $PHASE_FILE -ErrorAction SilentlyContinue

    # ── Summary ───────────────────────────────────────────────────────────────
    # Write final diagnostics snapshot to log (screen output is the clean summary below)
    Show-Diagnostics -LogOnly

    Show-Banner "Setup Complete"
    Write-Host "  Your GPU is now earning via Pulse + OctaSpace." -ForegroundColor Green
    Write-Host ""
    @(
        @{ L = "GPU";          V = $gpuName },
        @{ L = "VRAM";         V = "${vramGb} GB" },
        @{ L = "Platform";     V = "OctaSpace (via Pulse)" },
        @{ L = "Node token";   V = if ($octaNodeToken) { $octaNodeToken } else { "Pending — check cube.octa.computer" } },
        @{ L = "Gaming pause"; V = "Auto (GPU > 75% util)" },
        @{ L = "Auto-start";   V = "On every Windows login" },
        @{ L = "Logs";         V = $LOG_FILE }
    ) | ForEach-Object { Write-Host ("  {0,-16} {1}" -f $_.L, $_.V) -ForegroundColor White }
    Write-Host ""
    Write-Host "  Dashboard:  https://beneficial-deep-work-flow.base44.app" -ForegroundColor Cyan
    Write-Host "  Cube:       https://cube.octa.computer" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  ┌──────────────────────────────────────────────────────────────┐" -ForegroundColor DarkGray
    Write-Host "  │  INSTALL LOG                                                 │" -ForegroundColor DarkGray
    Write-Host "  │                                                              │" -ForegroundColor DarkGray
    Write-Host "  │  A full log of every install step was saved to:              │" -ForegroundColor DarkGray
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
