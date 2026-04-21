/**
 * fetchCloreaiEarnings
 * Fetches host-side server list and balance from Clore.ai using Pulse's master account.
 *
 * Required env vars:
 *   CLOREAI_API_KEY — Pulse's Clore.ai account API key
 *
 * Auth: Clore.ai uses `auth: <token>` header (not Authorization: Bearer)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const CLORE_BASE = 'https://api.clore.ai/v1';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const apiKey = Deno.env.get('CLOREAI_API_KEY');
  if (!apiKey) return Response.json({ error: 'CLOREAI_API_KEY not configured' }, { status: 500 });

  const headers = { 'auth': apiKey };

  try {
    // Fetch all servers registered under Pulse's Clore.ai account
    const serversRes = await fetch(`${CLORE_BASE}/my_servers`, { headers });
    if (!serversRes.ok) {
      const err = await serversRes.text();
      return Response.json({ error: `Clore.ai servers fetch failed: ${serversRes.status}`, details: err }, { status: 500 });
    }
    const serversData = await serversRes.json();
    const servers: any[] = serversData.servers ?? [];

    // Fetch account balance (contains total earnings)
    const balanceRes = await fetch(`${CLORE_BASE}/balance`, { headers });
    let totalEarningsUsd = 0;
    if (balanceRes.ok) {
      const balanceData = await balanceRes.json();
      // Clore.ai returns balance in CLORE tokens — convert to USD at market rate
      // The `usd_value` field is provided when available
      totalEarningsUsd = parseFloat((balanceData.usd_value ?? balanceData.balance ?? 0).toFixed(2));
    }

    const serverList = servers.map((s: any) => ({
      server_id: s.id,
      name: s.name ?? `Server #${s.id}`,
      gpu_model: s.specs?.gpu?.join(', ') ?? 'Unknown',
      gpu_count: s.specs?.gpus_count ?? 1,
      status: s.status ?? 'unknown',
      rented: s.rented ?? false,
      price_per_hour: parseFloat((s.price?.on_demand ?? 0).toFixed(4)),
      reliability: s.reliability ?? null,
    }));

    const rentedServers = serverList.filter(s => s.rented);

    // Fetch public marketplace to get real market rates
    let marketRates: { name: string; price_per_hour: number }[] = [];
    let marketDebug: any = null;
    try {
      const mktRes = await fetch(`${CLORE_BASE}/marketplace`, {
        headers: { 'auth': apiKey },
      });
      const mktText = await mktRes.text();
      let mktData: any = {};
      try { mktData = JSON.parse(mktText); } catch { marketDebug = { parse_error: mktText.slice(0, 200) }; }

      if (!marketDebug) {
        // Clore.ai marketplace: try known response shapes
        const listings: any[] = mktData.cards ?? mktData.servers ?? mktData.data ?? mktData.offers ?? [];
        marketDebug = {
          http_status: mktRes.status,
          top_level_keys: Object.keys(mktData),
          listing_count: listings.length,
          sample: listings[0] ?? null,
        };

        const rateMap: Record<string, number> = {};
        for (const item of listings) {
          // Try multiple GPU field shapes
          const gpuModels: string[] =
            item.specs?.gpu ??
            (item.gpu_model ? [item.gpu_model] : []) ??
            [];
          const price =
            parseFloat(item.price?.on_demand ?? item.on_demand_price ?? item.price_per_hour ?? item.price ?? 0);
          if (!price || !gpuModels.length) continue;
          for (const model of gpuModels) {
            if (!model || model.toLowerCase() === 'unknown') continue;
            if (!rateMap[model] || price > rateMap[model]) rateMap[model] = price;
          }
        }
        marketRates = Object.entries(rateMap)
          .map(([name, price_per_hour]) => ({ name, price_per_hour: parseFloat(price_per_hour.toFixed(4)) }))
          .sort((a, b) => b.price_per_hour - a.price_per_hour);
      }
    } catch (e: any) {
      marketDebug = { fetch_error: e.message };
    }

    return Response.json({
      platform: 'Clore.ai',
      total_earnings_usd: totalEarningsUsd,
      total_servers: servers.length,
      rented_servers: rentedServers.length,
      server_list: serverList,
      market_rates: marketRates,
      market_debug: marketDebug,
      last_fetched: new Date().toISOString(),
      user_email: user.email,
    });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
