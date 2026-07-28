import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// One-shot: backfills EarningsLog for Jul 23-27 from actual OctaSpace session data.
// Cross-day sessions split proportionally by seconds.
// OCTA price: $0.077220825494324379 (from OctaSpace tooltip, Jul 25 2026)
// User: esteban.arandaramirez@gmail.com (owner of node 11615)

const OCTA_PRICE = 0.077220825494324379;
const USER_EMAIL = 'esteban.arandaramirez@gmail.com';

// Daily OCTA totals derived from sessions visible in OctaSpace dashboard:
//   0c8ad96f (0.08446883) + f7e504c4 (2.42201043) + da16cac5 (0.02119127) → Jul 23
//   d046be5e (1.07728960) + 3e9ec618 Jul24 portion (33540s/49569s * 20.75878789) → Jul 24
//   3e9ec618 Jul25 portion (16029s/49569s) + f7f80d8e Jul25 portion (25140s/26430s) → Jul 25
//   f7f80d8e Jul26 portion (1290s/26430s) + a5d97b43 Jul26 portion (668min/1598min) → Jul 26
//   a5d97b43 Jul27 portion (930min/1598min * 36.77668941) → Jul 27
const DAILY: { date: string; octa: number }[] = [
  { date: '2026-07-23', octa: 2.52767053  },  // 0.08447 + 2.42201 + 0.02119
  { date: '2026-07-24', octa: 15.12659    },  // 1.07729 + 14.04930
  { date: '2026-07-25', octa: 16.37010    },  // 6.70948 + 9.66062
  { date: '2026-07-26', octa: 15.86938    },  // 0.49599 + 15.37339
  { date: '2026-07-27', octa: 21.40330    },  // 36.77669 * 930/1598
];

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  try {
    const user = await base44.auth.me();
    if (user?.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
  } catch {}

  const results: any[] = [];

  for (const { date, octa } of DAILY) {
    const octa_usd  = parseFloat((octa * OCTA_PRICE).toFixed(6));
    const total_usd = octa_usd;

    try {
      const existing = await base44.asServiceRole.entities.EarningsLog.filter({
        date,
        user_email: USER_EMAIL,
      });

      if (existing?.length > 0) {
        await base44.asServiceRole.entities.EarningsLog.update(existing[0].id, {
          octa_usd,
          clore_usd: 0,
          total_usd,
        });
        results.push({ date, action: 'updated', octa, octa_usd });
      } else {
        await base44.asServiceRole.entities.EarningsLog.create({
          date,
          user_email: USER_EMAIL,
          octa_usd,
          clore_usd: 0,
          total_usd,
        });
        results.push({ date, action: 'created', octa, octa_usd });
      }
    } catch (e: any) {
      results.push({ date, action: 'error', error: e.message });
    }
  }

  const totalOcta = DAILY.reduce((s, d) => s + d.octa, 0);
  const totalUsd  = parseFloat((totalOcta * OCTA_PRICE).toFixed(4));
  const pulseEst  = parseFloat(((totalUsd * 0.60) / 0.01).toFixed(2));

  return Response.json({
    message: 'EarningsLog backfill complete',
    records: results,
    total_octa: parseFloat(totalOcta.toFixed(5)),
    total_usd: totalUsd,
    pulse_payout_estimate: pulseEst,
  });
});
