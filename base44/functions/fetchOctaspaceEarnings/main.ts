/**
 * fetchOctaspaceEarnings
 * Fetches GPU node info and account balance from OctaSpace.
 *
 * Required env vars:
 *   OCTASPACE_API_KEY — API key from Settings on cube.octa.space
 *
 * OctaSpace API base: https://api.octa.space
 * Auth: Authorization: <api_key> (no Bearer prefix)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const OCTA_API_BASE = 'https://api.octa.space';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const apiKey = Deno.env.get('OCTASPACE_API_KEY');
  if (!apiKey) return Response.json({
    platform: 'OctaSpace',
    total_earnings_usd: 0,
    balance_octa: 0,
    octa_price_usd: 0,
    total_nodes: 0,
    active_nodes: 0,
    nodes: [],
    market_rates: [],
    last_fetched: new Date().toISOString(),
    note: 'OCTASPACE_API_KEY not configured',
  });

  const headers = {
    'Authorization': apiKey,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };

  try {
    // Fetch all nodes under the account
    const nodesRes = await fetch(`${OCTA_API_BASE}/nodes`, { headers });
    if (!nodesRes.ok) {
      const errText = await nodesRes.text().catch(() => '');
      return Response.json(
        { error: `OctaSpace nodes API error ${nodesRes.status}: ${errText}` },
        { status: 502 },
      );
    }
    const nodesData = await nodesRes.json();
    const nodes: any[] = Array.isArray(nodesData) ? nodesData : (nodesData.data ?? nodesData.nodes ?? []);

    // Fetch account balance (in OCTA tokens)
    let balanceOcta = 0;
    try {
      const balRes = await fetch(`${OCTA_API_BASE}/accounts/balance`, { headers });
      if (balRes.ok) {
        const balData = await balRes.json();
        balanceOcta = parseFloat(balData.balance ?? 0);
      }
    } catch { /* balance remains 0 */ }

    // Get OCTA/USD price from CoinGecko
    let octaPriceUsd = 0.09; // fallback
    try {
      const priceRes = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=octaspace&vs_currencies=usd',
        { signal: AbortSignal.timeout(4000) },
      );
      if (priceRes.ok) {
        const priceData = await priceRes.json();
        octaPriceUsd = priceData?.octaspace?.usd ?? octaPriceUsd;
      }
    } catch { /* use fallback price */ }

    const totalEarningsUsd = parseFloat((balanceOcta * octaPriceUsd).toFixed(2));

    const nodeList = nodes.map((n: any) => ({
      node_id: n.id ?? n.node_id,
      gpu_name: n.system?.gpu ?? n.gpu_model ?? n.gpu ?? 'Unknown GPU',
      status: (n.state === 'online' || n.status === 'active') ? 'active' : 'offline',
      rate_per_hour: parseFloat(n.prices?.gpu_hour ?? n.price_per_hour ?? 0),
      location: n.location?.country ?? '?',
    }));

    const activeNodes = nodeList.filter(n => n.status === 'active');

    return Response.json({
      platform: 'OctaSpace',
      total_earnings_usd: totalEarningsUsd,
      balance_octa: balanceOcta,
      octa_price_usd: octaPriceUsd,
      total_nodes: nodeList.length,
      active_nodes: activeNodes.length,
      nodes: nodeList,
      market_rates: [], // no live market endpoint; frontend uses static rates
      last_fetched: new Date().toISOString(),
    });
  } catch (error: any) {
    return Response.json({
      platform: 'OctaSpace',
      total_earnings_usd: 0,
      balance_octa: 0,
      octa_price_usd: 0,
      total_nodes: 0,
      active_nodes: 0,
      nodes: [],
      market_rates: [],
      last_fetched: new Date().toISOString(),
      note: `OctaSpace API unavailable: ${error.message}`,
    });
  }
});
