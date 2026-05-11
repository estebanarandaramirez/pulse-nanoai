/**
 * registerGPUDaemon
 * Called by pulse-setup.ps1 after Clore.ai host installation.
 * Creates or updates the GPU record in base44 entities AND Supabase,
 * then links it to the Clore.ai server ID so earnings can be attributed.
 *
 * Input: { gpu_model, vram_gb, clore_server_id?, platform, location }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const CLORE_BASE = 'https://api.clore.ai/v1';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { gpu_model, vram_gb, clore_server_id, platform = 'Clore.ai', location } = body;

  if (!gpu_model || !vram_gb) {
    return Response.json({ error: 'gpu_model and vram_gb are required' }, { status: 400 });
  }

  const apiKey = Deno.env.get('CLOREAI_API_KEY');
  let serverId = clore_server_id ? parseInt(clore_server_id, 10) : null;
  const gpuModelNum = gpu_model.match(/\d{4}/)?.[0] ?? '';

  // Step 1: Fetch my_servers to resolve server ID and get live rate
  let ratePerHour = 0.3;
  if (apiKey) {
    try {
      const res = await fetch(`${CLORE_BASE}/my_servers`, { headers: { auth: apiKey } });
      if (res.ok) {
        const data = await res.json();
        const servers: any[] = data.servers ?? [];

        if (!serverId && gpuModelNum) {
          const matched = servers.find((s: any) =>
            (s.gpu_array ?? []).some((m: string) => m.includes(gpuModelNum))
          );
          if (matched) serverId = matched.id;
        }

        if (serverId) {
          const server = servers.find((s: any) => s.id === serverId);
          if (server?.price?.on_demand) {
            ratePerHour = parseFloat(parseFloat(server.price.on_demand).toFixed(4));
          }
        }
      }
    } catch { /* use fallback rate */ }
  }

  const userRateHr = parseFloat((ratePerHour * 0.6).toFixed(4));
  const gpu_id = `CLORE-${gpu_model.replace(/\s+/g, '')}-${(serverId ?? Math.random().toString(36).slice(2, 6)).toString().toUpperCase()}`;

  const now = new Date().toISOString();

  try {
    // Step 2: Create or update GPU record in base44
    const existing = serverId
      ? await base44.entities.GPU.filter({ user_email: user.email, clore_server_id: serverId })
      : await base44.entities.GPU.filter({ user_email: user.email, model: gpu_model });

    let gpu;
    if (existing && existing.length > 0) {
      gpu = await base44.entities.GPU.update(existing[0].id, {
        last_heartbeat: now,
        status: 'active',
        rate_per_hour: userRateHr,
        active_platform: platform,
        ...(serverId ? { clore_server_id: serverId } : {}),
      });
    } else {
      gpu = await base44.entities.GPU.create({
        gpu_id,
        model: gpu_model,
        vram_gb: parseInt(vram_gb, 10),
        status: 'active',
        rate_per_hour: userRateHr,
        uptime_percent: 100,
        total_earned_usd: 0,
        pls_minted: 0,
        location: location || 'Unknown',
        last_heartbeat: now,
        user_email: user.email,
        clore_server_id: serverId,
        active_platform: platform,
      });
    }

    // Step 3: Write to Supabase (source of truth for GPU registry)
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (supabaseUrl && supabaseKey) {
      try {
        const { createClient } = await import('npm:@supabase/supabase-js@2');
        const sb = createClient(supabaseUrl, supabaseKey);
        await sb.from('gpus').upsert({
          gpu_id: gpu.gpu_id,
          user_email: user.email,
          model: gpu_model,
          vram_gb: parseInt(vram_gb, 10),
          status: 'active',
          rate_per_hour: ratePerHour,
          user_rate_hr: userRateHr,
          uptime_percent: 100,
          total_earned_usd: existing?.[0]?.total_earned_usd ?? 0,
          location: location || 'Unknown',
          clore_server_id: serverId,
          active_platform: platform,
          last_heartbeat: now,
          base44_id: gpu.id,
        }, { onConflict: 'gpu_id' });
      } catch (e: any) {
        console.error('Supabase write failed (non-fatal):', e.message);
      }
    }

    // Step 4: Assign GPU to node
    let nodeInfo: any = null;
    try {
      const nodeRes = await base44.functions.invoke('assignGPUToNode', { gpu_record_id: gpu.id });
      nodeInfo = nodeRes.data;
    } catch (e: any) {
      console.error('Node assignment failed:', e.message);
    }

    // Step 5: Auto-pricing — set competitive market price on Clore.ai
    let autoPricingApplied = false;
    let autoPricingPrice: number | null = null;
    if (apiKey && serverId) {
      try {
        const mktRes = await fetch(`${CLORE_BASE}/marketplace`, { headers: { auth: apiKey } });
        if (mktRes.ok) {
          const mktData = await mktRes.json();
          const listings: any[] = mktData.servers ?? [];

          const matchingPrices = listings
            .filter((item: any) =>
              gpuModelNum &&
              (item.gpu_array ?? []).some((m: string) => m.includes(gpuModelNum))
            )
            .map((item: any) => parseFloat(item.price?.on_demand ?? 0))
            .filter(p => p > 0)
            .sort((a: number, b: number) => a - b);

          if (matchingPrices.length > 0) {
            const median = matchingPrices[Math.floor(matchingPrices.length / 2)];
            const targetPrice = parseFloat((median * 0.9).toFixed(2));

            const setPriceRes = await fetch(`${CLORE_BASE}/set_server_settings`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', auth: apiKey },
              body: JSON.stringify({ id: serverId, settings: { on_demand: { price: targetPrice } } }),
            });
            const setPriceData = await setPriceRes.json().catch(() => ({}));
            autoPricingApplied = setPriceData.code === 0;
            autoPricingPrice = autoPricingApplied ? targetPrice : null;
          }
        }
      } catch { /* pricing remains as-is on Clore dashboard */ }
    }

    return Response.json({
      success: true,
      gpu_id: gpu.gpu_id,
      gpu_model,
      vram_gb,
      clore_server_id: serverId,
      active_platform: platform,
      user_rate_hr: userRateHr,
      gross_rate_hr: ratePerHour,
      pulse_share_pct: 40,
      daily_est_usd: parseFloat((userRateHr * 24 * 0.9).toFixed(2)),
      monthly_est_usd: parseFloat((userRateHr * 24 * 0.9 * 30).toFixed(2)),
      node: nodeInfo,
      auto_pricing: { applied: autoPricingApplied, price_clore_day: autoPricingPrice },
      message: `GPU registered on Clore.ai via Pulse. Earning $${userRateHr}/hr (60% of $${ratePerHour}/hr gross).`,
    });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
