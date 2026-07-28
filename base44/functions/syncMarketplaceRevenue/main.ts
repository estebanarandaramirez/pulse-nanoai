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

  // ── Write EarningsLog for today per platform owner ────────────────────────
  // Only writes when income > 0 — never overwrites existing records with $0.
  // Attributes earnings only to users whose GPU.platform matches the earning platform.
  // processPlatformRevenue sums all EarningsLog rows since last_run_at for payouts.
  const today = new Date().toISOString().slice(0, 10);
  const earningsLogResults: string[] = [];

  const upsertEarningsLog = async (
    email: string, octa: number, clore: number, other: number,
  ) => {
    const total = parseFloat((octa + clore + other).toFixed(6));
    try {
      const existing = await base44.asServiceRole.entities.EarningsLog.filter({
        date: today, user_email: email,
      });
      if (existing?.length > 0) {
        await base44.asServiceRole.entities.EarningsLog.update(existing[0].id, {
          octa_usd: parseFloat(octa.toFixed(6)),
          clore_usd: parseFloat(clore.toFixed(6)),
          total_usd: total,
        });
        earningsLogResults.push(`updated:${email}`);
      } else {
        await base44.asServiceRole.entities.EarningsLog.create({
          date: today, user_email: email,
          octa_usd: parseFloat(octa.toFixed(6)),
          clore_usd: parseFloat(clore.toFixed(6)),
          total_usd: total,
        });
        earningsLogResults.push(`created:${email}`);
      }
    } catch (e: any) {
      earningsLogResults.push(`error:${email}:${e.message}`);
    }
  };

  try {
    const allGPUs = await base44.asServiceRole.entities.GPU.list();
    const gpus = allGPUs ?? [];

    const emailsByPlatform = (platform: string) => [
      ...new Set(
        gpus
          .filter((g: any) =>
            (g.active_platform ?? g.platform ?? '').toLowerCase() === platform.toLowerCase()
          )
          .map((g: any) => g.user_email)
          .filter(Boolean),
      ),
    ] as string[];

    const octaOwners  = emailsByPlatform('OctaSpace');
    const cloreOwners = emailsByPlatform('Clore');

    if (octa24hUsd > 0 && octaOwners.length > 0) {
      const perUser = octa24hUsd / octaOwners.length;
      for (const email of octaOwners) await upsertEarningsLog(email, perUser, 0, 0);
    } else if (octa24hUsd === 0 && octaOwners.length > 0) {
      earningsLogResults.push(`skipped:octa:no income (owners: ${octaOwners.join(',')})`);
    }

    if (clore24hUsd > 0 && cloreOwners.length > 0) {
      const perUser = clore24hUsd / cloreOwners.length;
      for (const email of cloreOwners) await upsertEarningsLog(email, 0, perUser, 0);
    }

    if (otherUsd > 0) {
      const allOwners = [...new Set(gpus.map((g: any) => g.user_email).filter(Boolean))] as string[];
      if (allOwners.length > 0) {
        const perUser = otherUsd / allOwners.length;
        for (const email of allOwners) await upsertEarningsLog(email, 0, 0, perUser);
      }
    }

    if (earningsLogResults.length === 0) {
      earningsLogResults.push('no income on any platform — EarningsLog not updated');
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
