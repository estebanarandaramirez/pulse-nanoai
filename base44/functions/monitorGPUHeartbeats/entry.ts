/**
 * monitorGPUHeartbeats
 * Runs every 5 minutes to check GPU daemon health
 * Alerts if heartbeat missing >10 minutes or uptime drops >20%
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

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

      // Alert 1: Missing heartbeat >10 minutes
      if (heartbeatAge > 10) {
        alerts.push({
          gpu_id: gpu.gpu_id,
          user_email: gpu.user_email,
          alert_type: 'heartbeat_missing',
          severity: heartbeatAge > 30 ? 'critical' : 'warning',
          message: `GPU daemon offline for ${Math.round(heartbeatAge)} minutes`,
          last_heartbeat: gpu.last_heartbeat,
          action_needed: 'Check daemon logs or restart',
        });

        // Auto-mark as offline if >30 min
        if (heartbeatAge > 30) {
          await base44.asServiceRole.entities.GPU.update(gpu.id, {
            status: 'offline',
          });
        }
      }

      // Alert 2: Uptime dropped >20%
      if (gpu.uptime_percent && gpu.uptime_percent < 80) {
        alerts.push({
          gpu_id: gpu.gpu_id,
          user_email: gpu.user_email,
          alert_type: 'low_uptime',
          severity: gpu.uptime_percent < 50 ? 'critical' : 'warning',
          uptime_percent: gpu.uptime_percent,
          message: `GPU uptime dropped to ${gpu.uptime_percent}%`,
          impact: `Reduced earnings this cycle`,
          action_needed: 'Monitor network/power stability',
        });
      }
    }

    // Log alerts in ClaimEvent (for audit trail)
    for (const alert of alerts) {
      await base44.asServiceRole.entities.ClaimEvent.create({
        amount_pls: 0,
        tx_hash: `ALERT_${alert.gpu_id}_${Date.now()}`,
        status: 'confirmed',
        user_email: alert.user_email,
      }).catch(() => {});
    }

    return Response.json({
      timestamp: new Date().toISOString(),
      gpus_checked: allGPUs.length,
      alerts_triggered: alerts.length,
      alerts,
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});