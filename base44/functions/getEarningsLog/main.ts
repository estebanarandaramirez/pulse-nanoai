/**
 * getEarningsLog
 * Returns the last N days of earnings from Supabase `earnings_log` table.
 * Requires the caller to be authenticated (reads only the current user's rows).
 *
 * Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Optional body: { days } — defaults to 14
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !supabaseKey) return Response.json({ logs: [] });

  const body = await req.json().catch(() => ({}));
  const days = (body.days as number) ?? 14;
  const since = new Date();
  since.setDate(since.getDate() - days + 1);
  const sinceStr = since.toISOString().slice(0, 10);

  const { createClient } = await import('npm:@supabase/supabase-js@2');
  const sb = createClient(supabaseUrl, supabaseKey);

  const { data, error } = await sb
    .from('earnings_log')
    .select('date, octa_usd, clore_usd, total_usd')
    .eq('user_email', user.email)
    .gte('date', sinceStr)
    .order('date', { ascending: true });

  // Table may not exist yet — fall back to base44 entity
  if (error || !data?.length) {
    try {
      const entityLogs = await base44.entities.EarningsLog.filter({ user_email: user.email });
      const sorted = (entityLogs ?? [])
        .filter((l: any) => l.date >= sinceStr)
        .sort((a: any, b: any) => a.date.localeCompare(b.date));
      return Response.json({ logs: sorted, source: 'base44_entity' });
    } catch {
      if (error) return Response.json({ error: error.message }, { status: 500 });
    }
  }

  return Response.json({ logs: data ?? [], source: 'supabase' });
});
