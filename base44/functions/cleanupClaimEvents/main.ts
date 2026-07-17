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

  const cutoff = new Date('2026-07-01T00:00:00Z');
  const toDelete = all.filter((r: any) => new Date(r.created_date) < cutoff);

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
