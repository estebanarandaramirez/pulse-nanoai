# AMD GPU Support — Current Status & Workarounds

## Summary

Neither Clore.ai nor OctaSpace can run on an AMD GPU via the Windows installer (WSL2).
This is a hard operating system limitation, not a software configuration issue.
Both platforms support AMD on **native Linux** only.

---

## Why AMD Doesn't Work on Windows (WSL2)

### The root cause

WSL2 runs a stripped Microsoft-compiled Linux kernel inside a Hyper-V VM.
GPU compute passthrough into that VM requires a cooperation layer between the
Windows GPU driver, the hypervisor, and the Linux kernel.

**NVIDIA built this layer.** The NVIDIA Windows driver (520+) ships a special
`nvidia.ko` module that exposes the GPU inside WSL2 via a paravirtualisation
interface. That's why `nvidia-smi` works inside WSL2.

**AMD has not built an equivalent.** AMD's compute stack (ROCm) requires the
`amdgpu` kernel module, which is a full Linux kernel module that talks directly
to the GPU hardware. WSL2's locked-down Microsoft kernel does not include it,
and there is no AMD WSL2 passthrough driver.

### What this means in practice

| Check | NVIDIA in WSL2 | AMD in WSL2 |
|---|---|---|
| `nvidia-smi` visible | Yes | N/A |
| `/dev/kfd` exists | No (not needed) | **No — never created** |
| `/dev/dri/renderD128` exists | No (not needed) | **No — never created** |
| ROCm can see GPU | N/A | **No** |
| Docker GPU passthrough | Works (nvidia-container-toolkit) | **Fails silently** |

Installing ROCm inside Ubuntu WSL2 succeeds but the GPU is never exposed —
any workload that tries to use it falls back to CPU or crashes.

### Why the platform docs say "AMD supported"

OctaSpace and Clore.ai support AMD on **bare-metal Linux** or a **native Linux
install** (including dual-boot). Their documentation is written for that context.
Our Pulse installer targets Windows users running WSL2, which is a narrower
environment where AMD passthrough simply doesn't exist yet.

---

## Workarounds

### Option A — Native Linux (works today, AMD fully supported)

The user replaces Windows with Ubuntu (or dual-boots) and runs the OctaSpace
node natively. On bare metal, `amdgpu-dkms` loads cleanly and Docker sees the
GPU via `/dev/kfd` + `/dev/dri`.

**What a native Linux installer for Pulse would look like:**

```bash
# 1. Install ROCm kernel driver
wget https://repo.radeon.com/amdgpu-install/7.2.2/ubuntu/jammy/amdgpu-install_7.2.2.70202-1_all.deb
sudo apt install ./amdgpu-install_7.2.2.70202-1_all.deb
sudo apt install amdgpu-dkms rocm
sudo usermod -a -G render,video $USER
# reboot required after this step

# 2. Install Docker with AMD GPU support
# (no extra toolkit needed — Docker uses /dev/kfd directly)
sudo apt install docker.io
sudo usermod -aG docker $USER

# 3. Install OctaSpace node
curl -fsSL https://install.octa.space | bash
# capture token from: systemctl show osn --property=StatusText

# 4. Register at cube.octa.computer → Hosting → Nodes → Add Node
```

This path is buildable as a `pulse-octa-amd-setup.sh` if there is demand.

### Option B — Wait for AMD WSL2 support

Microsoft and AMD have discussed adding ROCm passthrough to WSL2 but there is
no public timeline. When it ships, the existing Windows installer can be updated
to add an AMD branch without changing the platform integration.

Track progress:
- [WSL GitHub issues — AMD GPU](https://github.com/microsoft/WSL/issues)
- [AMD ROCm WSL2 tracking](https://github.com/RadeonOpenCompute/ROCm/issues)

### Option C — Windows native (no WSL2) — not yet viable

OctaSpace and Clore.ai do not have native Windows node clients. Both require a
Linux environment. Until either platform ships a Windows-native provider agent,
WSL2 is the only Windows path — and that path excludes AMD.

---

## For Pulse Developers

- Both `pulse-clore-setup.bat` and `pulse-octa-setup.bat` detect AMD in Phase 1
  and exit with a clear error message directing the user to this document.
- The GPU entity schema has no AMD-specific fields; if a Linux installer is added
  later, the same `octa_node_token` / `clore_server_id` fields apply.
- The `fetchOctaspaceEarnings` and `fetchCloreaiEarnings` backend functions are
  platform-agnostic — they work the same regardless of GPU vendor once a node is
  registered and earning.
