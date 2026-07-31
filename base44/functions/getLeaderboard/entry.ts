/**
 * getLeaderboard
 * Aggregates EarningsLog records by user to produce anonymized leaderboard data.
 * Uses service role to read all users' logs, returns masked emails so any
 * authenticated user can view the board while only seeing their own raw email.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { createClient } from 'npm:@supabase/supabase-js@2';

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return email;
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(2, local.length - 2))}@${domain}`;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const today = new Date().toISOString().slice(0, 10);

    // Aggregate all EarningsLog records via service role (bypasses per-user RLS)
    const allLogs = (await base44.asServiceRole.entities.EarningsLog.list()) ?? [];
    const byUser: Record<string, { total_usd: number; daily_usd: number }> = {};
    for (const log of allLogs) {
      const email = log.user_email as string;
      if (!email) continue;
      if (!byUser[email]) byUser[email] = { total_usd: 0, daily_usd: 0 };
      byUser[email].total_usd += parseFloat(log.total_usd) || 0;
      if (log.date === today) byUser[email].daily_usd += parseFloat(log.total_usd) || 0;
    }

    // GPU info from Supabase for model names and count
    const gpusByUser: Record<string, { models: string[]; count: number }> = {};
    try {
      const sb = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      );
      const { data: gpus } = await sb.from('gpus').select('user_email, model');
      for (const g of gpus ?? []) {
        if (!g.user_email) continue;
        if (!gpusByUser[g.user_email]) gpusByUser[g.user_email] = { models: [], count: 0 };
        gpusByUser[g.user_email].count++;
        if (g.model && !gpusByUser[g.user_email].models.includes(g.model)) {
          gpusByUser[g.user_email].models.push(g.model);
        }
      }
    } catch { /* non-fatal — leaderboard still shows earnings without GPU models */ }

    const isAdmin = user.role === 'admin';
    const rankings = Object.entries(byUser).map(([email, data]) => ({
      is_me: email === user.email,
      user_email: isAdmin ? email : maskEmail(email),
      total_earned_usd: parseFloat(data.total_usd.toFixed(4)),
      daily_earned_usd: parseFloat(data.daily_usd.toFixed(4)),
      gpu_count: gpusByUser[email]?.count ?? 0,
      gpu_models: gpusByUser[email]?.models ?? [],
    }));

    return Response.json({ rankings });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
});
