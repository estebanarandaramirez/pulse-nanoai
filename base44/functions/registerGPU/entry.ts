/**
 * registerGPU
 * UI-facing registration (ConnectGPU page). Fetches live Clore.ai market
 * pricing for the detected GPU, then creates the GPU record.
 *
 * Input: { gpu_name, vram_gb, region, clore_server_id? }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const CLORE_BASE = 'https://api.clore.ai/v1';

const FALLBACK_RATES: Record<string, number> = {
  "RTX 4090": 0.72,
  "RTX 4080": 0.45,
  "RTX 4080 Super": 0.48,
  "RTX 3090": 0.25,
  "RTX 3080": 0.15,
  "A100": 1.60,
  "H100": 2.40,
};

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { gpu_name, vram_gb, region, clore_server_id } = await req.json();

  const apiKey = Deno.env.get('CLOREAI_API_KEY');
  let grossRateHr = FALLBACK_RATES[gpu_name] ?? 0.20;

  // Try to get live market rate from Clore.ai marketplace listings
  if (apiKey) {
    try {
      const marketRes = await fetch(`${CLORE_BASE}/marketplace`, {
        headers: { 'auth': apiKey },
      });
      if (marketRes.ok) {
        const marketData = await marketRes.json();
        const listings: any[] = marketData.offers ?? [];
        const matching = listings
          .filter((o: any) => o.specs?.gpu?.some((g: string) => g.toLowerCase().includes(gpu_name.toLowerCase().replace('nvidia ', ''))))
          .map((o: any) => parseFloat(o.price?.on_demand ?? 0))
          .filter(Boolean)
          .sort((a: number, b: number) => a - b);

        if (matching.length > 0) {
          // Use median market price
          grossRateHr = parseFloat(matching[Math.floor(matching.length / 2)].toFixed(4));
        }
      }
    } catch { /* use fallback */ }
  }

  const userRateHr = parseFloat((grossRateHr * 0.6).toFixed(4));
  const serverId = clore_server_id ? parseInt(clore_server_id, 10) : null;
  const gpu_id = `CLORE-${gpu_name.replace(/\s+/g, '')}-${(serverId ?? Math.random().toString(36).slice(2, 6)).toString().toUpperCase()}`;

  try {
    const selectorRes = await base44.asServiceRole.functions.invoke('platformSelector', {
      gpu_model: gpu_name,
      rates: { 'Clore.ai': grossRateHr },
      user_region: region || 'US',
      user_uptime_requirement: 80,
    });
    const ranked = selectorRes.data.ranked_platforms || [];

    await base44.entities.GPU.create({
      gpu_id,
      model: gpu_name,
      vram_gb: vram_gb || 8,
      status: 'active',
      rate_per_hour: userRateHr,
      uptime_percent: 0,
      total_earned_usd: 0,
      pls_minted: 0,
      user_email: user.email,
      last_heartbeat: new Date().toISOString(),
      clore_server_id: serverId,
      active_platform: 'Clore.ai',
    });

    return Response.json({
      gpu_id,
      gpu_name,
      vram_gb,
      clore_server_id: serverId,
      active_platform: 'Clore.ai',
      gross_rate_hr: grossRateHr,
      user_rate_hr: userRateHr,
      pulse_share_pct: 40,
      daily_usd: parseFloat((userRateHr * 24 * 0.9).toFixed(2)),
      monthly_usd: parseFloat((userRateHr * 24 * 0.9 * 30).toFixed(2)),
      ranked: ranked.map((r: any) => ({
        platform: r.platform,
        net_rate: r.net_rate,
        uptime_reliability: r.uptime_reliability,
        regional_match: r.regional_match,
      })),
    });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
