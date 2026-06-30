import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !supabaseKey) return Response.json({ logs: [], all_time_total: 0 });

  const body = await req.json().catch(() => ({}));
  const days = (body.days as number) ?? 14;
  const since = new Date();
  since.setDate(since.getDate() - days + 1);
  const sinceStr = since.toISOString().slice(0, 10);

  const { createClient } = await import('npm:@supabase/supabase-js@2');
  const sb = createClient(supabaseUrl, supabaseKey);

  const [recentRes, totalRes] = await Promise.all([
    sb.from('earnings_log')
      .select('date, octa_usd, clore_usd, total_usd')
      .eq('user_email', user.email)
      .gte('date', sinceStr)
      .order('date', { ascending: true }),
    sb.from('earnings_log')
      .select('total_usd')
      .eq('user_email', user.email),
  ]);

  // Fall back to base44 entity if Supabase has no data
  if (recentRes.error || !recentRes.data?.length) {
    try {
      const entityLogs = await base44.entities.EarningsLog.filter({ user_email: user.email });
      const sorted = (entityLogs ?? [])
        .filter((l: any) => l.date >= sinceStr)
        .sort((a: any, b: any) => a.date.localeCompare(b.date));
      const allTimeTotal = (entityLogs ?? [])
        .reduce((sum: number, l: any) => sum + (parseFloat(l.total_usd) || 0), 0);
      return Response.json({ logs: sorted, all_time_total: parseFloat(allTimeTotal.toFixed(2)), source: 'base44_entity' });
    } catch {
      if (recentRes.error) return Response.json({ error: recentRes.error.message }, { status: 500 });
    }
  }

  const allTimeTotal = (totalRes.data ?? [])
    .reduce((sum: number, r: any) => sum + (parseFloat(r.total_usd) || 0), 0);

  return Response.json({
    logs: recentRes.data ?? [],
    all_time_total: parseFloat(allTimeTotal.toFixed(2)),
    source: 'supabase',
  });
});
