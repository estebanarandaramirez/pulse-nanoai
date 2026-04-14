import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const BASE_RATES = {
  "RTX 4090": { "Vast.ai": 0.847, "RunPod": 0.890, "Clore.ai": 0.802, "OctaSpace": 0.780 },
  "RTX 4080": { "Vast.ai": 0.560, "RunPod": 0.580, "Clore.ai": 0.540, "OctaSpace": 0.520 },
  "RTX 3090": { "Vast.ai": 0.298, "RunPod": 0.310, "Clore.ai": 0.285, "OctaSpace": 0.270 },
  "RTX 3080": { "Vast.ai": 0.175, "RunPod": 0.185, "Clore.ai": 0.168, "OctaSpace": 0.160 },
  "A100": { "Vast.ai": 1.890, "RunPod": 1.950, "Clore.ai": 1.800, "OctaSpace": 1.750 },
  "H100": { "Vast.ai": 2.800, "RunPod": 2.890, "Clore.ai": 2.750, "OctaSpace": 2.700 },
};

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { gpu_name, vram_gb, region } = await req.json();

  const rates = BASE_RATES[gpu_name] || { "Vast.ai": 0.200, "RunPod": 0.210, "Clore.ai": 0.190, "OctaSpace": 0.180 };

  try {
    // Use platformSelector to get smart ranking
    const selectorRes = await base44.asServiceRole.functions.invoke('platformSelector', {
      gpu_model: gpu_name,
      rates,
      user_region: region || "US",
      user_uptime_requirement: 80,
    });

    const ranked = selectorRes.data.ranked_platforms;
    const best = ranked[0];
    const gpu_id = `GPU-${gpu_name.replace(/\s+/g, "")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    
    // User gets 60% of net rate
    const user_rate_hr = parseFloat((best.net_rate * 0.6).toFixed(3));

    // Save GPU record
    await base44.entities.GPU.create({
      gpu_id,
      model: gpu_name,
      vram_gb: vram_gb || 8,
      status: "active",
      rate_per_hour: user_rate_hr,
      uptime_percent: 0,
      total_earned_usd: 0,
      pls_minted: 0,
      user_email: user.email,
      last_heartbeat: new Date().toISOString(),
    });

    return Response.json({
      gpu_id,
      gpu_name,
      vram_gb,
      best_platform: best.platform,
      best_rate_after_fees: best.net_rate,
      user_rate_hr,
      daily_usd: parseFloat((user_rate_hr * 24 * 0.9).toFixed(2)),
      monthly_usd: parseFloat((user_rate_hr * 24 * 0.9 * 30).toFixed(2)),
      ranked: ranked.map(r => ({
        platform: r.platform,
        net_rate: r.net_rate,
        uptime_reliability: r.uptime_reliability,
        regional_match: r.regional_match,
      })),
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});