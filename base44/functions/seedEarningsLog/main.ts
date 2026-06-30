/**
 * seedEarningsLog — one-time seed for historical earnings data.
 * Run once from the Dashboard, then delete this function.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const SEED: { date: string; octa_usd: number; clore_usd: number; total_usd: number }[] = [
  { date: '2026-06-25', octa_usd: 0,    clore_usd: 0, total_usd: 0    },
  { date: '2026-06-26', octa_usd: 0.95, clore_usd: 0, total_usd: 0.95 },
  { date: '2026-06-27', octa_usd: 0.95, clore_usd: 0, total_usd: 0.95 },
  { date: '2026-06-28', octa_usd: 0.95, clore_usd: 0, total_usd: 0.95 },
  { date: '2026-06-29', octa_usd: 0.95, clore_usd: 0, total_usd: 0.95 },
  { date: '2026-06-30', octa_usd: 0.95, clore_usd: 0, total_usd: 0.95 },
];

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const results: string[] = [];

  for (const row of SEED) {
    try {
      const existing = await base44.entities.EarningsLog.filter({
        user_email: user.email,
        date: row.date,
      });

      if (existing?.length > 0) {
        await base44.entities.EarningsLog.update(existing[0].id, {
          octa_usd: row.octa_usd,
          clore_usd: row.clore_usd,
          total_usd: row.total_usd,
        });
        results.push(`updated ${row.date}`);
      } else {
        await base44.entities.EarningsLog.create({
          date: row.date,
          user_email: user.email,
          octa_usd: row.octa_usd,
          clore_usd: row.clore_usd,
          total_usd: row.total_usd,
        });
        results.push(`created ${row.date}`);
      }
    } catch (e: any) {
      results.push(`error ${row.date}: ${e.message}`);
    }
  }

  return Response.json({ success: true, results });
});
