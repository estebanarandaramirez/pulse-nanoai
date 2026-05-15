/**
 * fetchOctaspaceEarnings
 * Fetches GPU node info and account balance from OctaSpace.
 *
 * Required env vars:
 *   OCTASPACE_API_KEY — API key from Settings on cube.octa.space
 *
 * OctaSpace API base: https://api.octa.space
 * Auth: Authorization: <api_key>  (no Bearer prefix — per python-sdk source)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const OCTA_API_BASE = 'https://api.octa.space';

const EMPTY = {
  platform: 'OctaSpace',
  total_earnings_usd: 0,
  balance_octa: 0,
  octa_price_usd: 0,
  total_nodes: 0,
  active_nodes: 0,
  nodes: [],
  market_rates: [],
  last_fetched: new Date().toISOString(),
};

/** Fetch a URL and return { status, contentType, text }. Never throws. */
async function safeFetch(url: string, headers: Record<string, string>) {
  try {
    const res = await fetch(url, { headers });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      text,
    };
  } catch (e: any) {
    return { ok: false, status: 0, contentType: '', text: '', fetchError: e.message };
  }
}

/** Parse JSON from text. Returns null on failure. */
function tryParse(text: string) {
  try { return JSON.parse(text); } catch { return null; }
}

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const apiKey = Deno.env.get('OCTASPACE_API_KEY');
  if (!apiKey) return Response.json({ ...EMPTY, note: 'OCTASPACE_API_KEY not configured' });

  const headers = {
    'Authorization': apiKey,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };

  // ── Nodes ────────────────────────────────────────────────────────────────────
  const nodesRaw = await safeFetch(`${OCTA_API_BASE}/nodes`, headers);

  if (nodesRaw.fetchError) {
    return Response.json({
      ...EMPTY,
      error: `Network error fetching nodes: ${nodesRaw.fetchError}`,
    });
  }

  if (!nodesRaw.ok || !nodesRaw.contentType.includes('application/json')) {
    return Response.json({
      ...EMPTY,
      error: `nodes endpoint returned HTTP ${nodesRaw.status} (${nodesRaw.contentType || 'no content-type'}). Body: ${nodesRaw.text.slice(0, 500)}`,
    });
  }

  const nodesData = tryParse(nodesRaw.text);
  if (!nodesData) {
    return Response.json({
      ...EMPTY,
      error: `nodes endpoint returned invalid JSON. Raw: ${nodesRaw.text.slice(0, 500)}`,
    });
  }

  const nodes: any[] = Array.isArray(nodesData)
    ? nodesData
    : (nodesData.data ?? nodesData.nodes ?? []);

  // ── Balance ──────────────────────────────────────────────────────────────────
  let balanceOcta = 0;
  const balRaw = await safeFetch(`${OCTA_API_BASE}/accounts/balance`, headers);
  if (balRaw.ok && balRaw.contentType.includes('application/json')) {
    const balData = tryParse(balRaw.text);
    balanceOcta = parseFloat(balData?.balance ?? 0);
  }

  // ── OCTA/USD price ───────────────────────────────────────────────────────────
  let octaPriceUsd = 0.09;
  const priceRaw = await safeFetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=octaspace&vs_currencies=usd',
    { 'Accept': 'application/json' },
  );
  if (priceRaw.ok) {
    const priceData = tryParse(priceRaw.text);
    octaPriceUsd = priceData?.octaspace?.usd ?? octaPriceUsd;
  }

  // ── Build response ───────────────────────────────────────────────────────────
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
    total_earnings_usd: parseFloat((balanceOcta * octaPriceUsd).toFixed(2)),
    balance_octa: balanceOcta,
    octa_price_usd: octaPriceUsd,
    total_nodes: nodeList.length,
    active_nodes: activeNodes.length,
    nodes: nodeList,
    market_rates: [],
    last_fetched: new Date().toISOString(),
  });
});
