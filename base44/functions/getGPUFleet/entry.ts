import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { createClient } from 'npm:@supabase/supabase-js@2';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseKey) {
      return Response.json({ error: 'Supabase not configured' }, { status: 500 });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const userEmail = body.user_email;

    // ── GPU records ───────────────────────────────────────────────────────────
    let query = supabase.from('gpus').select('*').order('last_heartbeat', { ascending: false });
    if (userEmail) query = query.eq('user_email', userEmail);

    const { data, error } = await query;
    if (error) return Response.json({ error: error.message }, { status: 500 });

    // ── EarningsLog totals per user (service role bypasses per-user RLS) ──────
    const allLogs = await base44.asServiceRole.entities.EarningsLog.list();
    const earnByUser: Record<string, number> = {};
    for (const log of allLogs ?? []) {
      const email = (log as any).user_email;
      if (!email) continue;
      earnByUser[email] = (earnByUser[email] ?? 0) + (parseFloat((log as any).total_usd) || 0);
    }

    const gpus = (data ?? []).map((g: any) => ({
      gpu_id:          g.gpu_id,
      model:           g.model,
      user_email:      g.user_email,
      status:          g.status,
      active_platform: g.active_platform,
      last_heartbeat:  g.last_heartbeat,
      rate_per_hour:   g.rate_per_hour,
      // earnings_usd = sum of all EarningsLog rows for this GPU's owner
      earnings_usd: parseFloat((earnByUser[g.user_email] ?? 0).toFixed(2)),
    }));

    return Response.json({ gpus });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
});
