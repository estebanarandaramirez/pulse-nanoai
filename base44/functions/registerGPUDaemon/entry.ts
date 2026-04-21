/**
 * registerGPUDaemon
 * Called by pulse-setup.ps1 after Clore.ai host installation.
 * Creates or updates the GPU record and links it to the Clore.ai server ID
 * so earnings can be attributed to the correct Pulse user.
 *
 * Input: { gpu_model, vram_gb, clore_server_id, platform, location }
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
  const serverId = clore_server_id ? parseInt(clore_server_id, 10) : null;

  // Fetch live rate for this server from Clore.ai
  let ratePerHour = 0.3;
  if (apiKey && serverId) {
    try {
      const res = await fetch(`${CLORE_BASE}/my_servers`, {
        headers: { 'auth': apiKey },
      });
      if (res.ok) {
        const data = await res.json();
        const server = (data.servers ?? []).find((s: any) => s.id === serverId);
        if (server?.price?.on_demand) {
          ratePerHour = parseFloat(parseFloat(server.price.on_demand).toFixed(4));
        }
      }
    } catch { /* use fallback */ }
  }

  const userRateHr = parseFloat((ratePerHour * 0.6).toFixed(4));
  const gpu_id = `CLORE-${gpu_model.replace(/\s+/g, '')}-${(serverId ?? Math.random().toString(36).slice(2, 6)).toString().toUpperCase()}`;

  try {
    const existing = await base44.entities.GPU.filter({ user_email: user.email, clore_server_id: serverId });

    let gpu;
    if (existing && existing.length > 0) {
      gpu = await base44.entities.GPU.update(existing[0].id, {
        last_heartbeat: new Date().toISOString(),
        status: 'active',
        rate_per_hour: userRateHr,
        active_platform: platform,
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
        last_heartbeat: new Date().toISOString(),
        user_email: user.email,
        clore_server_id: serverId,
        active_platform: platform,
      });
    }

    let nodeInfo: any = null;
    try {
      const nodeRes = await base44.functions.invoke('assignGPUToNode', { gpu_record_id: gpu.id });
      nodeInfo = nodeRes.data;
    } catch (e: any) {
      console.error('Node assignment failed:', e.message);
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
      message: `GPU registered on Clore.ai via Pulse. Earning $${userRateHr}/hr (60% of $${ratePerHour}/hr gross).`,
    });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
