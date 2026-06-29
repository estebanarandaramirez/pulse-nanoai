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

async function timedFetch(url: string, options: RequestInit = {}, ms = 10000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const apiKey = Deno.env.get('CLOREAI_API_KEY');
  if (!apiKey) return Response.json({
    platform: 'Clore.ai',
    total_earnings_usd: 0,
    total_servers: 0,
    rented_servers: 0,
    server_list: [],
    market_rates: [],
    last_fetched: new Date().toISOString(),
    note: 'CLOREAI_API_KEY not configured',
  });

  const headers = { 'auth': apiKey };

  try {
    // Fetch all servers registered under Pulse's Clore.ai account (10s timeout)
    const serversRes = await timedFetch(`${CLORE_BASE}/my_servers`, { headers });
    if (!serversRes.ok) {
      const err = await serversRes.text();
      return Response.json({ error: `Clore.ai servers fetch failed: ${serversRes.status}`, details: err }, { status: 500 });
    }
    const serversData = await serversRes.json();
    const servers: any[] = serversData.servers ?? [];

    // Fetch account balance (contains total earnings)
    const balanceRes = await timedFetch(`${CLORE_BASE}/balance`, { headers });
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
      gpu_model: s.gpu_array?.[0] ?? (typeof s.specs?.gpu === 'string' ? s.specs.gpu : 'Unknown'),
      gpu_count: s.gpu_array?.length ?? s.specs?.gpus_count ?? 1,
      status: s.status ?? 'unknown',
      rented: s.rented ?? false,
      // on_demand_usd is in milli-USD (×1000), USD/day for the whole server
      price_per_hour: (() => {
        const gpuCount = s.gpu_array?.length ?? s.specs?.gpus_count ?? 1;
        const dailyMilliUsd = parseFloat(s.price?.usd?.on_demand_usd ?? 0);
        return dailyMilliUsd > 0 ? parseFloat((dailyMilliUsd / 1000 / gpuCount / 24).toFixed(4)) : 0;
      })(),
      reliability: s.reliability ?? null,
    }));

    const rentedServers = serverList.filter(s => s.rented);

    // Fetch public marketplace to get real market rates
    let marketRates: { name: string; price_per_hour: number }[] = [];
    try {
      const mktRes = await timedFetch(`${CLORE_BASE}/marketplace`, {
        headers: { 'auth': apiKey },
      }, 8000);
      let mktData: any = {};
      try { mktData = await mktRes.json(); } catch { /* leave mktData empty */ }

      {
        // Response: { servers: [...], my_servers: [...], code: 0 }
        const listings: any[] = mktData.servers ?? [];

        // on_demand_usd = USD/day for the whole server → convert to per-GPU per-hour
        // then average across listings of the same GPU model
        const rateMap: Record<string, { sum: number; count: number }> = {};
        for (const item of listings) {
          // on_demand_usd is in milli-USD (×1000), USD/day for the whole server
          const totalDailyMilliUsd = parseFloat(item.price?.usd?.on_demand_usd ?? 0);
          if (!totalDailyMilliUsd) continue;
          const gpuCount = (item.gpu_array?.length) || 1;
          const pricePerGpuHour = totalDailyMilliUsd / 1000 / gpuCount / 24;
          const models: string[] = [...new Set<string>(item.gpu_array ?? [])];
          for (const model of models) {
            if (!model) continue;
            if (!rateMap[model]) rateMap[model] = { sum: 0, count: 0 };
            rateMap[model].sum += pricePerGpuHour;
            rateMap[model].count += 1;
          }
        }
        marketRates = Object.entries(rateMap)
          .map(([name, { sum, count }]) => ({
            name,
            price_per_hour: parseFloat((sum / count).toFixed(4)),
            listing_count: count,
          }))
          .sort((a, b) => b.price_per_hour - a.price_per_hour);
      }
    } catch { /* market rates remain empty, frontend uses fallback */ }

    return Response.json({
      platform: 'Clore.ai',
      total_earnings_usd: totalEarningsUsd,
      total_servers: servers.length,
      rented_servers: rentedServers.length,
      server_list: serverList,
      market_rates: marketRates,
      last_fetched: new Date().toISOString(),
      user_email: user.email,
    });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
