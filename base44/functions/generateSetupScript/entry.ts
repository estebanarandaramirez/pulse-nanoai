/**
 * generateSetupScript
 * Serves pulse-setup.ps1 with user token and Clore.ai init token injected.
 *
 * Required env vars:
 *   CLOREAI_INIT_TOKEN — Pulse's Clore.ai organization init token
 *   BASE44_APP_ID      — base44 app ID (for the Pulse API callback URL in the script)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const cloreInitToken = Deno.env.get('CLOREAI_INIT_TOKEN') ?? 'CLOREAI_INIT_TOKEN_NOT_SET';

  const appId = Deno.env.get('BASE44_APP_ID') ?? '';

  const body = await req.json().catch(() => ({}));
  const userToken: string = body.user_token ?? '';

  // Read the template from the co-located ps1 file
  let script: string;
  try {
    script = await Deno.readTextFile(new URL('./pulse-setup.ps1', import.meta.url));
  } catch (e: any) {
    return Response.json({ error: `Could not read setup script template: ${e.message}` }, { status: 500 });
  }

  // Inject secrets — replace the three placeholder strings
  script = script
    .replace('"{{PULSE_USER_TOKEN}}"',   `"${userToken}"`)
    .replace('"{{PULSE_APP_ID}}"',       `"${appId}"`)
    .replace('"{{CLOREAI_INIT_TOKEN}}"', `"${cloreInitToken}"`);

  return new Response(script, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="pulse-setup.ps1"',
    },
  });
});
