import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// One-shot: seeds the two real confirmed on-chain ClaimEvent records from 2026-07-16.
Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  try {
    const user = await base44.auth.me();
    if (user?.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
  } catch {}

  const REAL_PAYOUTS = [
    {
      user_email: 'esteban.arandaramirez@gmail.com',
      amount_pls: 57,
      tx_hash: '39D4wu84MqyAPWEYPxQpypJpjwmDoz15VS8SuBonTudmdY6gQoPaGnbLua9rgyksNJHiUH1Z1232m9Tv1g2TuxAh',
      status: 'confirmed',
    },
    {
      user_email: 'esteban.arandaramirez@gmail.com',
      amount_pls: 57,
      tx_hash: 'cVp1hfooSHQckryHr6vTJjh1CE6PYuLy8m7Lv88sveo3u82MmmjrttK7fxGAXqREiokD1tTHGtYWoRTRLAEkMQU',
      status: 'confirmed',
    },
  ];

  const created: any[] = [];
  const failed: string[] = [];

  for (const payload of REAL_PAYOUTS) {
    try {
      const record = await base44.asServiceRole.entities.ClaimEvent.create(payload);
      created.push(record);
    } catch (e: any) {
      failed.push(`${payload.tx_hash.slice(0, 12)}...: ${e.message}`);
    }
  }

  return Response.json({ created_count: created.length, failed_count: failed.length, created, failed });
});
