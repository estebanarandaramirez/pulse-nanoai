/**
 * syncMarketplaceRevenue
 * Aggregates earnings from enabled marketplaces and updates the PayoutSchedule pool_amount.
 * Typically run as a scheduled automation every hour.
 *
 * Provider feature flags (set to true to re-enable):
 *   salad:     ENABLED (active)
 *   runpod:    gated — set RUNPOD_ENABLED=true to re-enable
 *   vastai:    gated — set VASTAI_ENABLED=true to re-enable
 *   cloreai:   gated — set CLOREAI_ENABLED=true to re-enable
 *   octaspace: gated — set OCTASPACE_ENABLED=true to re-enable
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// Feature flags — flip these env vars to re-enable providers
const ENABLED = {
  salad:     true,
  runpod:    Deno.env.get('RUNPOD_ENABLED') === 'true',
  vastai:    Deno.env.get('VASTAI_ENABLED') === 'true',
  cloreai:   Deno.env.get('CLOREAI_ENABLED') === 'true',
  octaspace: Deno.env.get('OCTASPACE_ENABLED') === 'true',
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

  // --- Salad (active) ---
  let saladEarnings = 0;
  if (ENABLED.salad) {
    try {
      const res = await base44.asServiceRole.functions.invoke('fetchSaladEarnings', {});
      saladEarnings = res.data?.total_earnings_usd ?? 0;
      breakdown.salad_usd = saladEarnings;
    } catch (e: any) {
      console.error('Salad sync failed:', e.message);
      breakdown.salad_usd = 0;
    }
  }

  // --- RunPod (gated) ---
  let runpodEarnings = 0;
  if (ENABLED.runpod) {
    try {
      const res = await base44.asServiceRole.functions.invoke('fetchRunpodEarnings', {});
      runpodEarnings = res.data?.total_earnings_usd ?? 0;
    } catch {}
    breakdown.runpod_usd = runpodEarnings;
  }

  // --- Vast.ai (gated) ---
  let vastaiEarnings = 0;
  if (ENABLED.vastai) {
    try {
      const res = await base44.asServiceRole.functions.invoke('fetchVastaiEarnings', {});
      vastaiEarnings = res.data?.total_earnings_usd ?? 0;
    } catch {}
    breakdown.vastai_usd = vastaiEarnings;
  }

  // --- Clore.ai (gated) ---
  let cloreaiEarnings = 0;
  if (ENABLED.cloreai) {
    try {
      const res = await base44.asServiceRole.functions.invoke('fetchCloreaiEarnings', {});
      cloreaiEarnings = res.data?.total_earnings_usd ?? 0;
    } catch {}
    breakdown.cloreai_usd = cloreaiEarnings;
  }

  // --- OctaSpace (gated) ---
  let octaspaceEarnings = 0;
  if (ENABLED.octaspace) {
    try {
      const res = await base44.asServiceRole.functions.invoke('fetchOctaspaceEarnings', {});
      octaspaceEarnings = res.data?.total_earnings_usd ?? 0;
    } catch {}
    breakdown.octaspace_usd = octaspaceEarnings;
  }

  const totalRevenue = saladEarnings + runpodEarnings + vastaiEarnings + cloreaiEarnings + octaspaceEarnings;

  // Fetch active payout schedule and update its pool amount
  try {
    const configs = await base44.asServiceRole.entities.PayoutSchedule.filter({ is_active: true });
    if (!configs || configs.length === 0) {
      return Response.json({
        message: 'No active payout schedule',
        revenue_detected: totalRevenue,
        breakdown,
        enabled_providers: Object.entries(ENABLED).filter(([, v]) => v).map(([k]) => k),
      });
    }

    const config = configs[0];
    await base44.asServiceRole.entities.PayoutSchedule.update(config.id, {
      pool_amount: totalRevenue,
    });

    await base44.asServiceRole.entities.ClaimEvent.create({
      amount_pls: 0,
      tx_hash: `REVENUE_SYNC_${Date.now()}`,
      status: 'confirmed',
      user_email: 'system@pulse.ai',
    }).catch(() => {});

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
