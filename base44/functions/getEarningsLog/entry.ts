import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const days = (body.days as number) ?? 14;
  const since = new Date();
  since.setDate(since.getDate() - days + 1);
  const sinceStr = since.toISOString().slice(0, 10);

  // Read from base44 entity (service role to bypass RLS) — this is where
  // backfill and syncMarketplaceRevenue write their data.
  // The Supabase `earnings_log` table is a separate store with stale/incomplete
  // data; reading it via sb.from() returns wrong results.
  try {
    const all = await base44.asServiceRole.entities.EarningsLog.filter({
      user_email: user.email,
    });
    const logs = (all ?? [])
      .filter((l: any) => (l.date ?? '') >= sinceStr)
      .sort((a: any, b: any) => (a.date ?? '').localeCompare(b.date ?? ''));
    const allTimeTotal = (all ?? [])
      .reduce((sum: number, l: any) => sum + (parseFloat(l.total_usd) || 0), 0);
    return Response.json({
      logs,
      all_time_total: parseFloat(allTimeTotal.toFixed(2)),
      source: 'base44_entity',
    });
  } catch (e: any) {
    return Response.json({ error: e.message, logs: [], all_time_total: 0 }, { status: 500 });
  }
});
