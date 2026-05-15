/**
 * fetchOctaspaceEarnings
 * Fetches GPU rental earnings from OctaSpace for nodes registered under
 * the Pulse master account.
 *
 * Required env vars:
 *   OCTASPACE_API_KEY — Pulse's OctaSpace API key (from cube.octa.computer)
 *
 * OctaSpace API base: https://api.cube.octa.computer/v1
 * Auth: Bearer token
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const OCTA_API_BASE = 'https://cube.octa.space/api/v1';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const apiKey = Deno.env.get('OCTASPACE_API_KEY');
  if (!apiKey) return Response.json({
    platform: 'OctaSpace',
    total_earnings_usd: 0,
    active_nodes: 0,
    nodes: [],
    note: 'OCTASPACE_API_KEY not configured — add it in Base44 env vars once you have an OctaSpace master account.',
  });

  try {
    // Fetch all nodes registered under the Pulse master account
    const nodesRes = await fetch(`${OCTA_API_BASE}/hosting/nodes`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!nodesRes.ok) {
      const errText = await nodesRes.text().catch(() => '');
      return Response.json(
        { error: `OctaSpace API error ${nodesRes.status}: ${errText}` },
        { status: 502 },
      );
    }

    const nodesData = await nodesRes.json();
    const nodes = nodesData.nodes ?? nodesData.data ?? nodesData ?? [];

    let totalEarningsUSD = 0;
    const gpuDetails = [];

    for (const node of nodes) {
      const isActive = node.status === 'active' || node.state === 'ACTIVE' || node.online === true;
      if (!isActive) continue;

      const pricePerHour = parseFloat(node.price_per_hour ?? node.rental_price_per_hour ?? 0);
      const runningHours = parseFloat(node.total_running_hours ?? node.running_hours ?? 0);
      const earningsUSD = pricePerHour * runningHours;

      totalEarningsUSD += earningsUSD;
      gpuDetails.push({
        node_id: node.id ?? node.node_id,
        node_token: node.token ?? node.node_token ?? '',
        gpu_name: node.gpu_model ?? node.gpu ?? 'Unknown GPU',
        status: node.status ?? node.state,
        earnings_usd: parseFloat(earningsUSD.toFixed(4)),
        running_hours: runningHours,
        rate_per_hour: pricePerHour,
      });
    }

    return Response.json({
      platform: 'OctaSpace',
      total_earnings_usd: parseFloat(totalEarningsUSD.toFixed(2)),
      active_nodes: gpuDetails.length,
      nodes: gpuDetails,
    });
  } catch (error: any) {
    return Response.json({
      platform: 'OctaSpace',
      total_earnings_usd: 0,
      active_nodes: 0,
      nodes: [],
      note: `OctaSpace API unavailable: ${error.message}`,
    });
  }
});
