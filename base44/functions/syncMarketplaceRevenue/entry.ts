/**
 * syncMarketplaceRevenue
 * Aggregates earnings from enabled marketplaces and updates PayoutSchedule pool_amount.
 * Run as a scheduled automation every hour.
 *
 * Providers are enabled when their API key env var is present.
 * Override with CLOREAI_ENABLED=false to explicitly disable.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const ENABLED = {
  cloreai:   Deno.env.get('CLOREAI_ENABLED') !== 'false' && !!Deno.env.get('CLOREAI_API_KEY'),
  octaspace: Deno.env.get('OCTASPACE_ENABLED') !== 'false' && !!Deno.env.get('OCTASPACE_API_KEY'),
  runpod:    Deno.env.get('RUNPOD_ENABLED') === 'true',
  vastai:    Deno.env.get('VASTAI_ENABLED') === 'true',
  salad:     Deno.env.get('SALAD_ENABLED') === 'true',
};

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  try {
    const user = await base44.auth.me();
    if (user && user.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin only' }, { status: 403 });
    }
  } catch { /* allow automation/service-role calls */ }

  const breakdown: Record<string, number> = {};
  let totalRevenue = 0;

  if (ENABLED.cloreai) {
    try {
      const res = await base44.asServiceRole.functions.invoke('fetchCloreaiEarnings', {});
      const earned = res.data?.total_earnings_usd ?? 0;
      breakdown.cloreai_usd = earned;
      totalRevenue += earned;
    } catch (e: any) {
      console.error('Clore.ai sync failed:', e.message);
      breakdown.cloreai_usd = 0;
    }
  }

  if (ENABLED.octaspace) {
    try {
      const res = await base44.asServiceRole.functions.invoke('fetchOctaspaceEarnings', {});
      const earned = res.data?.total_earnings_usd ?? 0;
      breakdown.octaspace_usd = earned;
      totalRevenue += earned;
    } catch (e: any) {
      console.error('OctaSpace sync failed:', e.message);
      breakdown.octaspace_usd = 0;
    }
  }

  if (ENABLED.runpod) {
    try {
      const res = await base44.asServiceRole.functions.invoke('fetchRunpodEarnings', {});
      breakdown.runpod_usd = res.data?.total_earnings_usd ?? 0;
      totalRevenue += breakdown.runpod_usd;
    } catch { breakdown.runpod_usd = 0; }
  }

  if (ENABLED.vastai) {
    try {
      const res = await base44.asServiceRole.functions.invoke('fetchVastaiEarnings', {});
      breakdown.vastai_usd = res.data?.total_earnings_usd ?? 0;
      totalRevenue += breakdown.vastai_usd;
    } catch { breakdown.vastai_usd = 0; }
  }

  if (ENABLED.salad) {
    try {
      const res = await base44.asServiceRole.functions.invoke('fetchSaladEarnings', {});
      breakdown.salad_usd = res.data?.total_earnings_usd ?? 0;
      totalRevenue += breakdown.salad_usd;
    } catch { breakdown.salad_usd = 0; }
  }

  try {
    const configs = await base44.asServiceRole.entities.PayoutSchedule.filter({ is_active: true });
    if (!configs || configs.length === 0) {
      return Response.json({
        message: 'No active payout schedule — create one in Admin > Payouts',
        revenue_detected: totalRevenue,
        breakdown,
        enabled_providers: Object.entries(ENABLED).filter(([, v]) => v).map(([k]) => k),
      });
    }

    const config = configs[0];
    await base44.asServiceRole.entities.PayoutSchedule.update(config.id, {
      pool_amount: totalRevenue,
    });

    return Response.json({
      message: 'Revenue sync complete',
      total_revenue_usd: totalRevenue,
      breakdown,
      enabled_providers: Object.entries(ENABLED).filter(([, v]) => v).map(([k]) => k),
      payout_schedule_id: config.id,
      updated_at: new Date().toISOString(),
    });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
