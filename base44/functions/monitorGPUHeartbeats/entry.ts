/**
 * monitorGPUHeartbeats
 * Runs every 5 minutes. Marks GPUs offline if heartbeat missing >30 min.
 * Syncs status changes to Supabase.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  let sb: any = null;
  if (supabaseUrl && supabaseKey) {
    try {
      const { createClient } = await import('npm:@supabase/supabase-js@2');
      sb = createClient(supabaseUrl, supabaseKey);
    } catch { /* Supabase unavailable, continue without it */ }
  }

  try {
    const allGPUs = await base44.asServiceRole.entities.GPU.filter({ status: 'active' });
    if (!allGPUs || allGPUs.length === 0) {
      return Response.json({ message: 'No active GPUs' });
    }

    const alerts = [];
    const now = Date.now();

    for (const gpu of allGPUs) {
      const lastHeartbeat = gpu.last_heartbeat ? new Date(gpu.last_heartbeat).getTime() : 0;
      const heartbeatAge = (now - lastHeartbeat) / 1000 / 60; // minutes

      if (heartbeatAge > 10) {
        const severity = heartbeatAge > 30 ? 'critical' : 'warning';
        alerts.push({
          gpu_id: gpu.gpu_id,
          user_email: gpu.user_email,
          alert_type: 'heartbeat_missing',
          severity,
          message: `GPU daemon offline for ${Math.round(heartbeatAge)} minutes`,
          last_heartbeat: gpu.last_heartbeat,
        });

        if (heartbeatAge > 30) {
          await base44.asServiceRole.entities.GPU.update(gpu.id, { status: 'offline' });
          if (sb) {
            await sb.from('gpus')
              .update({ status: 'offline' })
              .eq('gpu_id', gpu.gpu_id)
              .catch(() => {});
          }
        }
      }

      if (gpu.uptime_percent && gpu.uptime_percent < 80) {
        alerts.push({
          gpu_id: gpu.gpu_id,
          user_email: gpu.user_email,
          alert_type: 'low_uptime',
          severity: gpu.uptime_percent < 50 ? 'critical' : 'warning',
          uptime_percent: gpu.uptime_percent,
          message: `GPU uptime dropped to ${gpu.uptime_percent}%`,
        });
      }
    }

    return Response.json({
      timestamp: new Date().toISOString(),
      gpus_checked: allGPUs.length,
      alerts_triggered: alerts.length,
      alerts,
    });

  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
