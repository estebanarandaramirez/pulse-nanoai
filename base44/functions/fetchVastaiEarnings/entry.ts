/**
 * fetchVastaiEarnings
 * Polls Vast.ai API to fetch user's GPU rental earnings
 * Returns: { total_earnings_usd, gpu_count, active_rentals }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const apiKey = Deno.env.get('VASTAI_API_KEY');
  if (!apiKey) return Response.json({ error: 'VASTAI_API_KEY not configured' }, { status: 500 });

  try {
    // Vast.ai API: fetch user machines
    const machinesRes = await fetch('https://api.vast.ai/api/v0/machines/', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const machinesData = await machinesRes.json();

    if (!machinesData.machines) {
      return Response.json({ error: 'Failed to fetch machines', details: machinesData });
    }

    // Fetch active rentals
    const rentalsRes = await fetch('https://api.vast.ai/api/v0/rentals/active', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const rentalsData = await rentalsRes.json();

    let totalEarningsUsd = 0;
    const activeRentals = rentalsData.rentals || [];

    for (const rental of activeRentals) {
      if (rental.status === 'running') {
        // Accumulate earnings per minute of rental
        const durationMinutes = Math.round((Date.now() - new Date(rental.start_date)) / 60000);
        const earningsThisRental = (rental.price_per_minute || 0) * durationMinutes;
        totalEarningsUsd += earningsThisRental;
      }
    }

    const activeGpuList = activeRentals
      .filter(r => r.status === 'running')
      .map(r => ({
        machine_id: r.machine_id,
        gpu_model: r.gpu_name || 'Unknown',
        price_per_minute: r.price_per_minute,
        duration_minutes: Math.round((Date.now() - new Date(r.start_date)) / 60000),
      }));

    return Response.json({
      platform: 'Vast.ai',
      total_earnings_usd: parseFloat(totalEarningsUsd.toFixed(2)),
      active_rentals: activeRentals.length,
      gpu_list: activeGpuList,
      last_fetched: new Date().toISOString(),
      user_email: user.email,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});