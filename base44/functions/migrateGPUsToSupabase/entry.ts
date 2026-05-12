import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !supabaseKey) {
    return Response.json({ error: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required' }, { status: 500 });
  }

  const { createClient } = await import('npm:@supabase/supabase-js@2');
  const sb = createClient(supabaseUrl, supabaseKey);

  try {
    const allGPUs = await base44.asServiceRole.entities.GPU.list();
    if (!allGPUs?.length) {
      return Response.json({ message: 'No GPU entities found in base44' });
    }

    // Deduplicate by gpu_id — keep the one with the most recent heartbeat
    const seen = new Map<string, any>();
    for (const gpu of allGPUs) {
      const id = gpu.gpu_id;
      if (!id) continue;
      const existing = seen.get(id);
      if (!existing) {
        seen.set(id, gpu);
      } else {
        const existingTs = existing.last_heartbeat ? new Date(existing.last_heartbeat).getTime() : 0;
        const newTs = gpu.last_heartbeat ? new Date(gpu.last_heartbeat).getTime() : 0;
        if (newTs > existingTs) seen.set(id, gpu);
      }
    }

    const deduped = [...seen.values()];

    const rows = deduped.map(gpu => ({
      gpu_id:           gpu.gpu_id,
      user_email:       gpu.user_email ?? null,
      model:            gpu.model ?? null,
      vram_gb:          gpu.vram_gb ?? null,
      status:           gpu.status ?? 'offline',
      rate_per_hour:    gpu.rate_per_hour ?? 0,
      user_rate_hr:     gpu.user_rate_hr ?? 0,
      uptime_percent:   gpu.uptime_percent ?? 0,
      total_earned_usd: gpu.total_earned_usd ?? 0,
      daily_earned_usd: gpu.daily_earned_usd ?? 0,
      location:         gpu.location ?? null,
      clore_server_id:  gpu.clore_server_id ?? null,
      active_platform:  gpu.active_platform ?? null,
      last_heartbeat:   gpu.last_heartbeat ?? null,
      node_id:          gpu.node_id ?? null,
      base44_id:        gpu.id ?? null,
    }));

    const { error } = await sb.from('gpus').upsert(rows, { onConflict: 'gpu_id' });
    if (error) throw new Error(error.message);

    return Response.json({
      message: 'Migration complete',
      total_in_base44: allGPUs.length,
      deduplicated_to: deduped.length,
      upserted: rows.length,
    });

  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
});
