/**
 * generateSetupScript
 * Serves pulse-clore-setup.bat or pulse-octa-setup.bat based on the
 * `platform` field in the request body ("clore" | "octaspace").
 *
 * Both installers use the same .bat wrapper that self-elevates via UAC and
 * extracts the embedded PS1 to %LOCALAPPDATA%\Pulse\ before running it,
 * so the Phase 2 scheduled task survives a reboot.
 *
 * Required env vars:
 *   CLOREAI_INIT_TOKEN — Pulse's Clore.ai organisation init token (Clore only)
 *   BASE44_APP_ID      — base44 app ID
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// ── Script templates loaded from sibling .ps1 files ──────────────────────────
// Keeping templates as separate files avoids JS string-escaping issues and
// lets them be edited, linted, and tested independently of this function.

const CLORE_PS1_TEMPLATE = await Deno.readTextFile(new URL('./pulse-setup.ps1', import.meta.url));
const OCTA_PS1_TEMPLATE  = await Deno.readTextFile(new URL('./pulse-octa-setup.ps1', import.meta.url));

// ── Shared .bat wrapper ───────────────────────────────────────────────────────
// Extracts the embedded PS1 to %LOCALAPPDATA%\Pulse\ before elevation so the
// Phase 2 scheduled task can find it after reboot. {{PS1_FILENAME}} is replaced
// at serve time with the platform-specific filename.

const BAT_TEMPLATE = `@echo off
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
echo     Step 1 ^| If you see "Open File - Security Warning", click RUN
echo              If you see "Windows protected your PC", click More info then Run anyway
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
set "PS1_PATH=%PULSE_DIR%\\{{PS1_FILENAME}}"

if not exist "%PULSE_DIR%" mkdir "%PULSE_DIR%"

echo   Step 1: Extracting setup script...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=[IO.File]::ReadAllText('%~f0',[Text.Encoding]::UTF8); $m='__PULSE_PS1__'; $i=$c.LastIndexOf($m); if($i-lt 0){exit 1}; [IO.File]::WriteAllText('%PS1_PATH%',$c.Substring($i+$m.Length).TrimStart(),[Text.Encoding]::UTF8)"

if not exist "%PS1_PATH%" (
    echo.
    echo   ERROR: Could not extract setup script.
    echo   Please re-download from pulsenanoai.com
    echo.
    pause
    exit /b 1
)

echo   Step 2: Launching installer...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -NoExit -File "%PS1_PATH%"
goto :eof

__PULSE_PS1__
`;

// ─────────────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  let user: unknown;
  try {
    user = await base44.auth.me();
  } catch {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const cloreInitToken = Deno.env.get('CLOREAI_INIT_TOKEN') ?? 'CLOREAI_INIT_TOKEN_NOT_SET';
  const appId = Deno.env.get('BASE44_APP_ID') ?? '';

  const body = await req.json().catch(() => ({}));
  const userToken: string = body.user_token ?? '';
  const platform: string = (body.platform ?? 'clore').toLowerCase();

  const isOcta = platform === 'octaspace';
  const ps1Filename = isOcta ? 'pulse-octa-setup.ps1' : 'pulse-clore-setup.ps1';
  const batFilename = isOcta ? 'pulse-octa-setup.bat' : 'pulse-clore-setup.bat';
  const format: string = (body.format ?? 'bat').toLowerCase();

  let ps1 = (isOcta ? OCTA_PS1_TEMPLATE : CLORE_PS1_TEMPLATE)
    .replace('{{PULSE_USER_TOKEN}}', userToken)
    .replace('{{PULSE_APP_ID}}', appId);

  if (!isOcta) {
    ps1 = ps1.replace('{{CLOREAI_INIT_TOKEN}}', cloreInitToken);
  }

  // format=ps1 — return the script directly so callers can save it without a
  // browser-applied Mark-of-the-Web (Zone.Identifier), bypassing Smart App Control.
  if (format === 'ps1') {
    return new Response(ps1, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${ps1Filename}"`,
      },
    });
  }

  const bat = BAT_TEMPLATE.replace('{{PS1_FILENAME}}', ps1Filename) + ps1;

  return new Response(bat, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${batFilename}"`,
    },
  });
});
