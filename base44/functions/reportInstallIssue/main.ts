/**
 * reportInstallIssue
 * Called by the PowerShell installer on failure to upload the log file.
 * No auth required — installer may run before the user has a session token,
 * but we attempt to resolve email from the token if provided.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  let userEmail = 'unknown';
  try {
    const user = await base44.auth.me();
    if (user?.email) userEmail = user.email;
  } catch { /* anonymous upload is fine */ }

  const body = await req.json().catch(() => ({}));
  const { platform, error_step, log_content, installer_version } = body;

  if (!platform || !error_step) {
    return Response.json({ error: 'platform and error_step are required' }, { status: 400 });
  }

  // Truncate log to 50k chars to stay within entity size limits
  const logTrunc = typeof log_content === 'string'
    ? log_content.slice(-50_000)
    : '';

  await base44.asServiceRole.entities.InstallReport.create({
    user_email: userEmail,
    platform,
    error_step,
    log_content: logTrunc,
    installer_version: installer_version ?? '',
    status: 'new',
    admin_notes: '',
  });

  return Response.json({ success: true });
});
