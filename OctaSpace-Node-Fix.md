# OctaSpace AutoNode — Stability Fix Guide

## The Setup

- Windows machine with NVIDIA GPU (GTX 1080 Ti tested)
- Ubuntu 22.04 running inside WSL2 with systemd enabled
- OctaSpace's `osn` daemon (Erlang/OTP, version 0.0.75) running as a systemd service
- Node registered and verified on [cube.octa.computer](https://cube.octa.computer)

After installation and verification, the node repeatedly goes online then offline every 28–90 seconds. Three separate problems cause this.

---

## Problem 1 — NVIDIA Driver Locks All RAM (HugePages)

### What happens

The NVIDIA WSL2 driver reserves a large pool of "HugePages" (2MB kernel pages) proportional to how much RAM WSL2 has available. On a machine with 10GB WSL memory, NVIDIA takes ~8GB as HugePages for GPU VRAM mapping.

This leaves only ~50MB–2GB of usable RAM for the OSN process. Erlang's built-in memory monitor (`os_mon/memsup`) fires a `system_memory_high_watermark` alarm when more than 80% of RAM is in use. When that alarm fires, OSN calls `init:stop()` and shuts down cleanly — no crash, no error in the logs, just a clean exit 15–20 seconds after startup.

### How to diagnose

```bash
# In WSL as root:
free -m
# If "available" is under ~2000MB, HugePages are the problem

cat /proc/meminfo | grep HugePages
# HugePages_Total will be in the thousands (e.g. 4096 = 8GB locked)
```

### Fix — cap HugePages at 256 (512MB)

```bash
# In WSL as root:
echo "vm.nr_hugepages=256" > /etc/sysctl.d/90-wsl.conf
sysctl -p /etc/sysctl.d/90-wsl.conf
```

This file persists across WSL restarts via `systemd-sysctl.service`. After applying, `free -m` should show 8GB+ available.

---

## Problem 2 — Root Filesystem at 81% Triggers Disk Alarm

### What happens

OctaSpace's installer creates a large real file (`/docker-data.img`, typically 763GB) at the root of the WSL filesystem to back Docker's storage. This immediately puts the root filesystem at ~81% usage.

Erlang's disk monitor (`os_mon/disksup`) fires a `disk_almost_full` alarm when any monitored filesystem exceeds 80% usage (the default threshold). This alarm also causes OSN to call `init:stop()` and exit.

### How to diagnose

```bash
# In WSL:
df -h /
# If Use% is 81% or higher on /, this alarm is firing

du -sh /docker-data.img
# Will show ~763G (real file, not sparse)
```

### Fix — raise the disk alarm threshold to 90%

Edit `/home/octa/osn/releases/0.0.75/sys.config` (adjust version number if different):

```erlang
[
    {kernel, [
        {logger_level, debug},
        {logger, [
            {handler, default, logger_std_h, #{
                level => debug,
                config => #{
                    burst_limit_enable => false
                },
                formatter => {logger_formatter, #{template => [time, " ", msg, "\n"]}}
            }}
        ]}
    ]},
    {os_mon, [
        {disk_almost_full_threshold, 0.90}
    ]}
].
```

The key addition is the `{os_mon, [{disk_almost_full_threshold, 0.90}]}` section. This raises the alarm threshold from 80% to 90%, which clears headroom for the 81% disk usage.

After saving, restart OSN:

```bash
systemctl restart osn
```

---

## Problem 3 — No Services Enabled in Node Settings

### What happens

After both system fixes, OSN authenticates successfully with OctaSpace's control server every time. However, the node still cycles every 28–90 seconds. The node shows as **"Busy"** on cube.octa.computer despite never actually running a job.

The cause: OctaSpace assigns a rental task to newly verified nodes automatically. But if the node has no services enabled in its settings, the platform cannot provision the task — so it keeps retrying, causing OSN to restart on each attempt.

### How to diagnose

- Node shows **Verified** + **Busy** on cube.octa.computer but uptime stays at 0%
- OSN log at `/home/octa/osn/log/osn.log.1` shows `authentication successful` followed by silence, then a new startup cycle — no error messages

### Fix — enable Rental and service ports in node settings

1. Go to [cube.octa.computer](https://cube.octa.computer)
2. Click the node → **Settings**
3. Under **Services**, check **Rental** (required for GPU compute jobs)
4. Check **Enable service ports** (required for customer container access, ports 51800–51816)
5. Click **Save settings**

The node will stabilize within 1–2 minutes after saving.

---

## Complete Fix Sequence (SSH Commands)

Run these after SSHing into the Windows host and assuming Ubuntu-22.04 is the WSL distro:

```powershell
# Step 1 — cap HugePages
wsl -d Ubuntu-22.04 -u root -- bash -c "echo vm.nr_hugepages=256 > /etc/sysctl.d/90-wsl.conf && sysctl -p /etc/sysctl.d/90-wsl.conf"

# Step 2 — check OSN version (adjust path below if different)
wsl -d Ubuntu-22.04 -u root -- ls /home/octa/osn/releases/

# Step 3 — write updated sys.config (replace 0.0.75 with actual version if needed)
wsl -d Ubuntu-22.04 -u root -- tee /home/octa/osn/releases/0.0.75/sys.config << 'EOF'
[
    {kernel, [
        {logger_level, debug},
        {logger, [
            {handler, default, logger_std_h, #{
                level => debug,
                config => #{
                    burst_limit_enable => false
                },
                formatter => {logger_formatter, #{template => [time, " ", msg, "\n"]}}
            }}
        ]}
    ]},
    {os_mon, [
        {disk_almost_full_threshold, 0.90}
    ]}
].
EOF

# Step 4 — restart OSN
wsl -d Ubuntu-22.04 -u root -- systemctl restart osn

# Step 5 — verify OSN is running and stays up
wsl -d Ubuntu-22.04 -u root -- systemctl status osn --no-pager
```

Then in cube.octa.computer: enable **Rental** + **Enable service ports** → Save.

---

## Verification

After applying all fixes, check:

```bash
# Memory — should show 8GB+ available
wsl -d Ubuntu-22.04 -u root -- free -m

# OSN — should show active (running) with time increasing
wsl -d Ubuntu-22.04 -u root -- systemctl status osn --no-pager

# OSN log — should show "authentication successful" without further restarts
wsl -d Ubuntu-22.04 -u root -- cat /home/octa/osn/log/osn.log.1
```

On cube.octa.computer the node should show **Online** with uptime ticking up and no further offline flapping.

---

## Why These Fixes Are Persistent

| Fix | Persistence mechanism |
|---|---|
| HugePages cap | `/etc/sysctl.d/90-wsl.conf` loaded by `systemd-sysctl.service` on every WSL boot |
| Disk alarm threshold | Written into OSN's `sys.config` — loaded by OSN on every start |
| Rental service enabled | Saved in OctaSpace's cloud — persists across node restarts |
