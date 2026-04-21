/**
 * fetchVastaiEarnings
 * Fetches host-side machine earnings from Vast.ai using Pulse's master host account.
 * Each user's machine is registered under Pulse's Vast.ai account via setup script.
 *
 * Required env vars:
 *   VASTAI_API_KEY - Pulse's master Vast.ai host API key
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const VAST_BASE = 'https://console.vast.ai/api/v0';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const apiKey = Deno.env.get('VASTAI_API_KEY');
  if (!apiKey) return Response.json({ error: 'VASTAI_API_KEY not configured' }, { status: 500 });

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Accept': 'application/json',
  };

  try {
    // Fetch all machines registered under Pulse's host account
    const machinesRes = await fetch(`${VAST_BASE}/machines/`, { headers });
    if (!machinesRes.ok) {
      const err = await machinesRes.text();
      return Response.json({ error: `Failed to fetch machines: ${machinesRes.status}`, details: err }, { status: 500 });
    }
    const machinesData = await machinesRes.json();
    const machines: any[] = machinesData.machines || [];

    // Fetch earnings for the host account
    const earningsRes = await fetch(`${VAST_BASE}/users/me/machine_earnings/`, { headers });
    if (!earningsRes.ok) {
      const err = await earningsRes.text();
      return Response.json({ error: `Failed to fetch earnings: ${earningsRes.status}`, details: err }, { status: 500 });
    }
    const earningsData = await earningsRes.json();

    // Per-machine earnings summary
    const machineEarnings: any[] = earningsData.summaries || [];
    const earningsMap: Record<number, number> = {};
    let totalEarningsUsd = 0;

    for (const entry of machineEarnings) {
      const earned = parseFloat(entry.credit || 0);
      earningsMap[entry.machine_id] = earned;
      totalEarningsUsd += earned;
    }

    const activeMachines = machines
      .filter(m => m.listed)
      .map(m => ({
        machine_id: m.id,
        gpu_model: m.gpu_name || 'Unknown',
        gpu_count: m.num_gpus || 1,
        listed: m.listed,
        rented: m.rented,
        earnings_usd: parseFloat((earningsMap[m.id] || 0).toFixed(2)),
        reliability: m.reliability2 ?? null,
        inet_up_bw: m.inet_up_bw ?? null,
        inet_down_bw: m.inet_down_bw ?? null,
      }));

    return Response.json({
      platform: 'Vast.ai',
      total_earnings_usd: parseFloat(totalEarningsUsd.toFixed(2)),
      total_machines: machines.length,
      active_machines: activeMachines.filter(m => m.rented).length,
      machine_list: activeMachines,
      last_fetched: new Date().toISOString(),
      user_email: user.email,
    });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
