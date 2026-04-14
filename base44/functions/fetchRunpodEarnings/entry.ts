/**
 * fetchRunpodEarnings
 * Polls RunPod API to fetch user's GPU rental earnings
 * Returns: { total_earnings_usd, gpu_count, period }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const apiKey = Deno.env.get('RUNPOD_API_KEY');
  if (!apiKey) return Response.json({ error: 'RUNPOD_API_KEY not configured' }, { status: 500 });

  try {
    // Fetch user's pods (GPUs)
    const podsRes = await fetch('https://api.runpod.io/v2/pods', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const podsData = await podsRes.json();
    
    if (!podsData.pods) {
      return Response.json({ error: 'Failed to fetch pods', details: podsData });
    }

    // Calculate earnings from active rental pods
    let totalEarningsUsd = 0;
    const activeGpus = [];

    for (const pod of podsData.pods) {
      if (pod.machine_type === 'GPU' && pod.is_rented && pod.rental_rate) {
        activeGpus.push({
          pod_id: pod.id,
          gpu_model: pod.gpu_count > 0 ? `${pod.gpu_count}x ${pod.gpu_name || 'GPU'}` : 'Unknown',
          hourly_rate: pod.rental_rate,
          uptime_hours: Math.round((Date.now() - new Date(pod.started_at)) / 3600000),
        });
        // Estimate earnings: hourly rate × uptime
        totalEarningsUsd += pod.rental_rate * Math.round((Date.now() - new Date(pod.started_at)) / 3600000);
      }
    }

    return Response.json({
      platform: 'RunPod',
      total_earnings_usd: parseFloat(totalEarningsUsd.toFixed(2)),
      active_gpus: activeGpus.length,
      gpu_list: activeGpus,
      last_fetched: new Date().toISOString(),
      user_email: user.email,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});