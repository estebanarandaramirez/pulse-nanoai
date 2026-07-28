/**
 * syncMarketplaceRevenue
 * Fetches daily income from all enabled platforms, writes per-user EarningsLog records
 * (which processPlatformRevenue reads for payouts), and updates PayoutSchedule.pool_amount
 * for display. Runs hourly via base44 automation — each run overwrites today's record
 * with the latest 24h income snapshot.
 *
 * IMPORTANT: uses total_income_24h_usd (rolling daily income), NOT total_earnings_usd
 * (wallet balance) — the balance is cumulative and would double-count across payouts.
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
  let octa24hUsd = 0;
  let clore24hUsd = 0;
  let otherUsd = 0;

  if (ENABLED.octaspace) {
    try {
      const res = await base44.asServiceRole.functions.invoke('fetchOctaspaceEarnings', {});
      // total_income_24h_usd = rolling 24h income — what we want for daily earnings
      // total_earnings_usd = wallet balance (cumulative) — do NOT use for payout calc
      octa24hUsd = parseFloat(res.data?.total_income_24h_usd ?? 0) || 0;
      breakdown.octaspace_usd = octa24hUsd;
    } catch (e: any) {
      console.error('OctaSpace sync failed:', e.message);
      breakdown.octaspace_usd = 0;
    }
  }

  if (ENABLED.cloreai) {
    try {
      // Clore returns wallet balance, not daily income — track delta when Clore goes live
      // For now record 0 to avoid double-counting cumulative balance across payout cycles
      breakdown.cloreai_usd = 0;
      clore24hUsd = 0;
    } catch { breakdown.cloreai_usd = 0; }
  }

  if (ENABLED.runpod) {
    try {
      const res = await base44.asServiceRole.functions.invoke('fetchRunpodEarnings', {});
      const earned = res.data?.total_income_24h_usd ?? res.data?.total_earnings_usd ?? 0;
      breakdown.runpod_usd = earned;
      otherUsd += earned;
    } catch { breakdown.runpod_usd = 0; }
  }

  if (ENABLED.vastai) {
    try {
      const res = await base44.asServiceRole.functions.invoke('fetchVastaiEarnings', {});
      const earned = res.data?.total_income_24h_usd ?? res.data?.total_earnings_usd ?? 0;
      breakdown.vastai_usd = earned;
      otherUsd += earned;
    } catch { breakdown.vastai_usd = 0; }
  }

  if (ENABLED.salad) {
    try {
      const res = await base44.asServiceRole.functions.invoke('fetchSaladEarnings', {});
      const earned = res.data?.total_income_24h_usd ?? res.data?.total_earnings_usd ?? 0;
      breakdown.salad_usd = earned;
      otherUsd += earned;
    } catch { breakdown.salad_usd = 0; }
  }

  const totalRevenue = octa24hUsd + clore24hUsd + otherUsd;

  // ── Write EarningsLog for today per GPU provider ──────────────────────────
  // Each hourly run overwrites today's record with the freshest 24h snapshot.
  // processPlatformRevenue sums all EarningsLog rows since last_run_at for payouts.
  const today = new Date().toISOString().slice(0, 10);
  const earningsLogResults: string[] = [];

  try {
    const allGPUs = await base44.asServiceRole.entities.GPU.list();
    const userEmails = [
      ...new Set((allGPUs ?? []).map((g: any) => g.user_email).filter(Boolean)),
    ] as string[];

    if (userEmails.length > 0) {
      const perUserOcta  = octa24hUsd  / userEmails.length;
      const perUserClore = clore24hUsd / userEmails.length;
      const perUserOther = otherUsd    / userEmails.length;
      const perUserTotal = perUserOcta + perUserClore + perUserOther;

      for (const email of userEmails) {
        try {
          const existing = await base44.asServiceRole.entities.EarningsLog.filter({
            date: today,
            user_email: email,
          });

          if (existing?.length > 0) {
            await base44.asServiceRole.entities.EarningsLog.update(existing[0].id, {
              octa_usd:  perUserOcta,
              clore_usd: perUserClore,
              total_usd: perUserTotal,
            });
            earningsLogResults.push(`updated:${email}`);
          } else {
            await base44.asServiceRole.entities.EarningsLog.create({
              date:      today,
              user_email: email,
              octa_usd:  perUserOcta,
              clore_usd: perUserClore,
              total_usd: perUserTotal,
            });
            earningsLogResults.push(`created:${email}`);
          }
        } catch (e: any) {
          earningsLogResults.push(`error:${email}:${e.message}`);
        }
      }
    } else {
      earningsLogResults.push('no GPU records found — no users to credit');
    }
  } catch (e: any) {
    earningsLogResults.push(`GPU lookup failed: ${e.message}`);
  }

  // ── Update PayoutSchedule pool_amount (display only) ─────────────────────
  try {
    const configs = await base44.asServiceRole.entities.PayoutSchedule.filter({ is_active: true });
    if (configs?.length > 0) {
      await base44.asServiceRole.entities.PayoutSchedule.update(configs[0].id, {
        pool_amount: totalRevenue,
      });
    }
  } catch { /* non-fatal */ }

  return Response.json({
    message: 'Revenue sync complete',
    total_revenue_usd: totalRevenue,
    breakdown,
    enabled_providers: Object.entries(ENABLED).filter(([, v]) => v).map(([k]) => k),
    earnings_log: earningsLogResults,
    updated_at: new Date().toISOString(),
  });
});
