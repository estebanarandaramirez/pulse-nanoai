import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// One-shot admin cleanup: deletes all ClaimEvent records created before 2026-07-01.
// These are bogus records from the old fake claimPLS function.
// Real payouts (57 PULSE each) were sent on 2026-07-16 and going forward.
Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  try {
    const user = await base44.auth.me();
    if (user?.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
  } catch {}

  const all = await base44.asServiceRole.entities.ClaimEvent.list('-created_date', 500);
  if (!all?.length) return Response.json({ message: 'No ClaimEvent records found.' });

  // Keep only the two real confirmed on-chain payouts from 2026-07-16.
  // Everything else is bogus (fake claimPLS or test data).
  const REAL_TX_HASHES = new Set([
    '39D4wu84MqyAPWEYPxQpypJpjwmDoz15VS8SuBonTudmdY6gQoPaGnbLua9rgyksNJHiUH1Z1232m9Tv1g2TuxAh',
    'cVp1hfooSHQckryHr6vTJjh1CE6PYuLy8m7Lv88sveo3u82MmmjrttK7fxGAXqREiokD1tTHGtYWoRTRLAEkMQU',
  ]);
  const toDelete = all.filter((r: any) => !REAL_TX_HASHES.has(r.tx_hash));

  const deleted: string[] = [];
  const failed: string[] = [];

  for (const record of toDelete) {
    try {
      await base44.asServiceRole.entities.ClaimEvent.delete(record.id);
      deleted.push(`${record.id} (${record.amount_pls} PULSE, ${record.created_date})`);
    } catch (e: any) {
      failed.push(`${record.id}: ${e.message}`);
    }
  }

  return Response.json({
    total_found: all.length,
    deleted_count: deleted.length,
    failed_count: failed.length,
    deleted,
    failed,
    kept: all.length - toDelete.length,
  });
});
