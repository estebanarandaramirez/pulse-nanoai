import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// One-shot admin cleanup:
// 1. Zero the 2 bogus ClaimEvent records (Jul 28 duplicates of Jul 17 payouts).
// 2. List ALL EarningsLog records for esteban and zero any outside Jul 23-27
//    (the only verified backfill range — any other dates are stale sync artifacts).

const BOGUS_CLAIM_IDS = ['6a690cb6a504d6f09d09df1a', '6a690cb6af7eb1fb695670b6'];
const USER_EMAIL = 'esteban.arandaramirez@gmail.com';
const VALID_DATES = ['2026-07-23', '2026-07-24', '2026-07-25', '2026-07-26', '2026-07-27'];

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  try {
    const user = await base44.auth.me();
    if (user?.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
  } catch {}

  const results: any[] = [];

  // 1. Zero bogus ClaimEvents (idempotent)
  for (const id of BOGUS_CLAIM_IDS) {
    try {
      await base44.asServiceRole.entities.ClaimEvent.update(id, { amount_pls: 0 });
      results.push({ type: 'ClaimEvent', id, action: 'zeroed' });
    } catch (e: any) {
      results.push({ type: 'ClaimEvent', id, action: 'error', error: e.message });
    }
  }

  // 2. Fetch ALL EarningsLog records for esteban, zero anything outside Jul 23-27
  try {
    const all = await base44.asServiceRole.entities.EarningsLog.filter({
      user_email: USER_EMAIL,
    });

    for (const rec of all ?? []) {
      const isValid = VALID_DATES.includes(rec.date ?? '');
      results.push({
        type: 'EarningsLog',
        date: rec.date,
        id: rec.id,
        total_usd: rec.total_usd,
        action: isValid ? 'kept' : 'zeroing',
      });

      if (!isValid) {
        try {
          await base44.asServiceRole.entities.EarningsLog.update(rec.id, {
            octa_usd: 0, clore_usd: 0, total_usd: 0,
          });
        } catch (e: any) {
          results[results.length - 1].error = e.message;
          results[results.length - 1].action = 'error';
        }
      }
    }

    if (!all?.length) results.push({ type: 'EarningsLog', action: 'no_records_found' });
  } catch (e: any) {
    results.push({ type: 'EarningsLog', action: 'error', error: e.message });
  }

  return Response.json({ message: 'Cleanup complete', results });
});
