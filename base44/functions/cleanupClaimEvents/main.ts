import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// One-shot: zeroes out the 2 bogus ClaimEvent records created Jul 28 2026 20:10
// by the old ClaimEvent seeder that ran before entry.ts was updated to backfill code.
// Wallet.jsx filters(ev => ev.amount_pls > 0), so amount_pls=0 hides them cleanly.

const BOGUS_IDS = ['6a690cb6a504d6f09d09df1a', '6a690cb6af7eb1fb695670b6'];

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  try {
    const user = await base44.auth.me();
    if (user?.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
  } catch {}

  const results: any[] = [];

  for (const id of BOGUS_IDS) {
    try {
      await base44.asServiceRole.entities.ClaimEvent.update(id, { amount_pls: 0 });
      results.push({ id, action: 'zeroed' });
    } catch (e: any) {
      results.push({ id, action: 'error', error: e.message });
    }
  }

  return Response.json({
    message: 'Bogus ClaimEvent cleanup complete',
    results,
  });
});
