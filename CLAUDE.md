# Pulse (beneficial-deep-work-flow)

Base44 app ("Pulse") that lets users rent out idle GPU compute across multiple hosting
platforms (OctaSpace, Clore.ai, RunPod, Vast.ai, Salad) from one dashboard, tracks
earnings/heartbeats, and handles PLS/$PULSE token payouts and treasury operations.

- Frontend: Vite + React, deployed via base44 (`base44-app`, see `package.json`).
- Backend: base44 serverless functions in `base44/functions/*` (Deno-style, one folder
  per function).
- **Deployment**: base44 is connected to GitHub and syncs automatically on every push to
  `main`. `git push origin main` deploys all changed functions. No manual dashboard
  step needed.

## base44 function layout

Each function folder has:
- `function.jsonc` — declares the actual deployed entrypoint via `"entry"` (usually
  `main.ts`).
- `entry.ts` — **the file the base44 dashboard deploys from**. Always update this file
  when changing a function's logic. The dashboard reads `entry.ts` as the source;
  editing only `main.ts` in git does nothing to the live function.
- `main.ts` — a local copy of the deployed artifact; keep it in sync with `entry.ts`
  but it is NOT what the dashboard picks up.

**Always update `entry.ts`** when editing any function — this is what the base44
dashboard deploys. Update `main.ts` too so git stays in sync, but `entry.ts` is the
source of truth for what actually runs.

Watch for stale/orphaned duplicate function folders (e.g.
`generateSetupScript/entry/`) that look similar to an active function but aren't wired
into `function.jsonc` as the real entry — don't assume every folder under
`base44/functions/` is live.

## GPU provider installer scripts (Pulse ⇄ OctaSpace/Clore)

`generateSetupScript` (`base44/functions/generateSetupScript/{entry,main}.ts`) generates
the Windows installer users download from the Pulse dashboard. It embeds full installer
scripts as template strings:
- `CLORE_PS1` — literal PowerShell template string, for Clore.ai.
- `OCTA_PS1_B64` — base64-encoded PowerShell blob for OctaSpace, decoded at runtime via
  a `b64ToStr` helper.

`scripts/pulse-octa-setup.ps1` in this repo is the **local, readable source of truth**
for the OctaSpace installer. It is NOT auto-synced to the deployed base64 blob.

**Whenever `scripts/pulse-octa-setup.ps1` is edited, the deployed blob must be
re-encoded and pasted into `OCTA_PS1_B64` in both `entry.ts` and `main.ts`** of
`generateSetupScript` before the change reaches real installers. The reverse can also
drift: fixes have been made directly to the deployed blob (e.g. via live debugging) that
never made it back into the local `.ps1` file. Before editing either side, diff local vs.
deployed (`base64 -d` the `OCTA_PS1_B64` literal) to catch this drift — do not assume one
is a strict superset of the other, and never blindly overwrite one with the other.

### Known OctaSpace stability fixes (all present in the current installer)

The `osn` daemon (Erlang/OTP) running inside WSL2 Ubuntu-22.04 has historically gone
silently offline for two root causes, both fixed in the installer:

1. **Memory-pressure alarm flapping** — NVIDIA's WSL2 driver reserves HugePages
   proportional to RAM; Erlang's `memsup` fires `system_memory_high_watermark` at >80%
   used and the daemon calls `init:stop()` (clean, silent shutdown — no error logged).
   Fix: cap HugePages at 256 (512MB) via `/etc/sysctl.d/90-wsl.conf`, and raise
   `system_memory_high_watermark` to `0.97` in OSN's `sys.config`.
2. **Disk-almost-full alarm** — OctaSpace's `/docker-data.img` pushes root filesystem
   usage past the default 80% `disksup` threshold. Fix: raise
   `disk_almost_full_threshold` to `0.90` in `sys.config`.
3. **Silent multi-hour blackouts** — WSL2's utility VM can be torn down when it looks
   idle, freezing the daemon inside with zero log output until something touches WSL
   again. Fix: `vmIdleTimeout=-1` in `.wslconfig` (both the Windows 11 22H2+ mirrored-
   networking branch and the legacy portproxy branch), plus an `Ensure-WSLAlive`
   keepalive watchdog that spawns a background `wsl.exe ... sleep 3600` process.
4. Also included: Windows Update auto-restart guard
   (`NoAutoRebootWithLoggedOnUsers=1`) so a forced reboot doesn't kill an active rental
   session.

Reference doc: `OctaSpace-Node-Fix.md` for diagnosis commands, `OctaSpace-Node-Reinstall.md`
for the full clean-reinstall procedure (includes a **manual** step — deleting the node
on cube.octa.computer — that cannot be automated and must not be skipped, or the node
re-registers with a stale token).

## Windows/WSL2 environment gotchas (for future debugging sessions)

- **Non-interactive SSH with password auth**: plain `ssh` needs a TTY for password
  prompts and hangs under non-interactive tool shells. Use Python `paramiko`
  (`SSHClient`, `AutoAddPolicy`, `connect(..., look_for_keys=False, allow_agent=False)`)
  plus `open_sftp()` for file transfer instead.
- **Windows console encoding**: printing decoded UTF-8/UTF-16 SSH/WSL output directly
  via a Bash-tool `print()` can throw `'charmap' codec can't encode` on Windows. Write
  output to a local file (UTF-8) and read it back with a file-reading tool instead of
  printing directly.
- **WSL command output via `wsl.exe`** is UTF-16LE and can come out garbled
  ("D e f a u l t..."); strip null bytes (`s.replace('\x00','')`) after decoding.
- **PowerShell quoting**: `\"` is not a valid escape inside a PowerShell double-quoted
  string — use `` `" `` or doubled `""`. Using `\"` silently breaks nested `bash -c "..."`
  invocations passed through `wsl -- bash -c "..."`.
- **XFS/ext4 space-reclamation lag**: `df -h` can show stale usage right after deleting
  a large file until `sync` runs.
- OpenSSH-for-Windows sessions for a local Administrator typically already carry a full
  admin token (no interactive-desktop UAC split-token filtering), so a `.bat`'s own
  UAC-elevation dance (`net session` check + VBS `ShellExecute runas`) is usually
  unnecessary noise when driving it over SSH — safe to extract and run the embedded
  `.ps1` directly instead.

See `CLAUDE.local.md` (gitignored) for live rig SSH access details — never commit
credentials to this file.
