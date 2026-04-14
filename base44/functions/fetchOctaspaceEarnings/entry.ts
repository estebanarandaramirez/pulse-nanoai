/**
 * fetchOctaspaceEarnings
 * Fetches GPU rental earnings from OctaSpace
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const apiKey = Deno.env.get('OCTASPACE_API_KEY');
  if (!apiKey) return Response.json({ error: 'OCTASPACE_API_KEY not set' }, { status: 500 });

  try {
    // Fetch rental instances
    const instancesRes = await fetch('https://api.octaspace.com/v1/instances', {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
    const instances = await instancesRes.json();

    let totalEarningsUSD = 0;
    const gpuDetails = [];

    for (const instance of instances.data || []) {
      if (instance.state !== 'ACTIVE' || !instance.is_rented) continue;

      const pricePerHour = instance.rental_price_per_hour || 0;
      const runningHours = instance.total_running_hours || 0;
      const earningsUSD = pricePerHour * runningHours;

      totalEarningsUSD += earningsUSD;
      gpuDetails.push({
        instance_id: instance.id,
        gpu_name: instance.gpu_model,
        state: instance.state,
        earnings_usd: earningsUSD,
        running_hours: runningHours,
        rate_per_hour: pricePerHour,
      });
    }

    return Response.json({
      platform: 'OctaSpace',
      total_earnings_usd: parseFloat(totalEarningsUSD.toFixed(2)),
      active_instances: gpuDetails.length,
      instances: gpuDetails,
    });
  } catch (error) {
    return Response.json(
      { error: error.message },
      { status: 500 }
    );
  }
});