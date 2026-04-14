/**
 * fetchCloreaiEarnings
 * Fetches GPU rental earnings from Clore.ai
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const apiKey = Deno.env.get('CLOREAI_API_KEY');
  if (!apiKey) return Response.json({ error: 'CLOREAI_API_KEY not set' }, { status: 500 });

  try {
    // Fetch active machines for this user
    const machinesRes = await fetch('https://api.clore.ai/v1/machines', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const machines = await machinesRes.json();

    let totalEarningsUSD = 0;
    const gpuDetails = [];

    for (const machine of machines.data || []) {
      if (machine.status !== 'active' || !machine.rental_active) continue;

      const rentingPricePerMin = machine.renting_price_per_minute || 0;
      const uptimeHours = machine.total_uptime_hours || 0;
      const earningsUSD = (rentingPricePerMin * 60 * uptimeHours);

      totalEarningsUSD += earningsUSD;
      gpuDetails.push({
        machine_id: machine.id,
        gpu_name: machine.gpu_name,
        status: machine.status,
        earnings_usd: earningsUSD,
        uptime_hours: uptimeHours,
        rate_per_min: rentingPricePerMin,
      });
    }

    return Response.json({
      platform: 'Clore.ai',
      total_earnings_usd: parseFloat(totalEarningsUSD.toFixed(2)),
      active_machines: gpuDetails.length,
      machines: gpuDetails,
    });
  } catch (error) {
    return Response.json(
      { error: error.message },
      { status: 500 }
    );
  }
});