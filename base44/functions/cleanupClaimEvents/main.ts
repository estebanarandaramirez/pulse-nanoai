import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// One-shot admin cleanup:
// 1. Zero the 2 bogus ClaimEvent records (Jul 28 duplicates of Jul 17 payouts).
//    Wallet.jsx filters amount_pls > 0, so zeroing hides them cleanly.
// 2. Zero the stale Jul 28 EarningsLog record whose value double-counts Jul 27
//    session income that was already attributed via the Jul 23-27 backfill.

const BOGUS_CLAIM_IDS = ['6a690cb6a504d6f09d09df1a', '6a690cb6af7eb1fb695670b6'];
const STALE_LOG_DATE  = '2026-07-28';
const STALE_LOG_USER  = 'esteban.arandaramirez@gmail.com';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  try {
    const user = await base44.auth.me();
    if (user?.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
  } catch {}

  const results: any[] = [];

  // 1. Zero bogus ClaimEvents
  for (const id of BOGUS_CLAIM_IDS) {
    try {
      await base44.asServiceRole.entities.ClaimEvent.update(id, { amount_pls: 0 });
      results.push({ type: 'ClaimEvent', id, action: 'zeroed' });
    } catch (e: any) {
      results.push({ type: 'ClaimEvent', id, action: 'error', error: e.message });
    }
  }

  // 2. Zero the stale Jul 28 EarningsLog record
  try {
    const existing = await base44.asServiceRole.entities.EarningsLog.filter({
      date: STALE_LOG_DATE,
      user_email: STALE_LOG_USER,
    });
    for (const rec of existing ?? []) {
      await base44.asServiceRole.entities.EarningsLog.update(rec.id, {
        octa_usd: 0,
        clore_usd: 0,
        total_usd: 0,
      });
      results.push({ type: 'EarningsLog', date: STALE_LOG_DATE, id: rec.id, action: 'zeroed' });
    }
    if (!existing?.length) {
      results.push({ type: 'EarningsLog', date: STALE_LOG_DATE, action: 'not_found' });
    }
  } catch (e: any) {
    results.push({ type: 'EarningsLog', date: STALE_LOG_DATE, action: 'error', error: e.message });
  }

  return Response.json({ message: 'Cleanup complete', results });
});
