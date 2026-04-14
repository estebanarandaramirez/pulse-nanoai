/**
 * registerGPUDaemon
 * Called by the local GPU daemon to register/update GPU info
 * Input: { gpu_model, vram_gb, location, platform_preference, daemon_id }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { gpu_model, vram_gb, location, platform_preference, daemon_id, uptime_percent } = body;

  if (!gpu_model || !vram_gb) {
    return Response.json({ error: 'gpu_model and vram_gb required' }, { status: 400 });
  }

  try {
    // Check if GPU already exists for this user
    const existing = await base44.entities.GPU.filter({
      user_email: user.email,
      gpu_id: daemon_id,
    });

    let gpu;
    if (existing && existing.length > 0) {
      // Update existing
      gpu = await base44.entities.GPU.update(existing[0].id, {
        last_heartbeat: new Date().toISOString(),
        uptime_percent: uptime_percent || existing[0].uptime_percent,
        status: 'active',
      });
    } else {
      // Create new GPU record
      gpu = await base44.entities.GPU.create({
        gpu_id: daemon_id,
        model: gpu_model,
        status: 'active',
        rate_per_hour: 0.5,
        uptime_percent: uptime_percent || 100,
        vram_gb: vram_gb,
        location: location || 'Unknown',
        pls_minted: 0,
        last_heartbeat: new Date().toISOString(),
        user_email: user.email,
      });
    }

    // Fetch live Salad rate for this GPU model (Salad is the active platform)
    let saladRateHr = 0.3; // fallback
    try {
      const saladRes = await base44.asServiceRole.functions.invoke('fetchSaladEarnings', {});
      const classes = saladRes.data?.gpu_classes || [];
      // Find closest matching GPU class by name similarity
      const match = classes.find((c: any) =>
        c.name?.toLowerCase().includes(gpu_model.replace('NVIDIA ', '').toLowerCase()) ||
        gpu_model.toLowerCase().includes(c.name?.toLowerCase().replace('nvidia ', ''))
      );
      if (match) saladRateHr = match.price_per_hour;
    } catch {}

    // Platform selector (Salad-only now, but kept for future multi-platform support)
    let recommendedPlatform = platform_preference;
    if (!platform_preference || platform_preference === 'auto') {
      try {
        const selectorRes = await base44.asServiceRole.functions.invoke('platformSelector', {
          gpu_model: gpu_model,
          rates: { "Salad": saladRateHr },
          user_region: location || "US",
          user_uptime_requirement: 80,
        });
        recommendedPlatform = selectorRes.data.recommended_platform;
      } catch {
        recommendedPlatform = 'Salad';
      }
    }

    // Update the stored rate now that we have a live Salad rate
    if (gpu && gpu.id && saladRateHr > 0) {
      await base44.entities.GPU.update(gpu.id, { rate_per_hour: saladRateHr }).catch(() => {});
    }

    // --- Assign GPU to a node pool ---
    let nodeInfo: any = null;
    try {
      const nodeRes = await base44.functions.invoke('assignGPUToNode', { gpu_record_id: gpu.id });
      nodeInfo = nodeRes.data;
    } catch (e: any) {
      console.error('Node assignment failed:', e.message);
    }

    return Response.json({
      success: true,
      gpu_id: gpu.id,
      gpu_model: gpu_model,
      status: 'registered',
      recommended_platform: recommendedPlatform,
      salad_rate_hr: saladRateHr,
      node: nodeInfo,
      message: `GPU registered${nodeInfo ? ` and assigned to ${nodeInfo.node_name}` : ''}. Earning on ${recommendedPlatform} at $${saladRateHr}/hr.`,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});