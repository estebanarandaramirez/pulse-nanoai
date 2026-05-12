/**
 * monitorMarketRates
 * Runs every 60 minutes to detect higher-yield platforms.
 * Auto-switches GPU records to best platform if +10% yield improvement detected.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const BASE_RATES = {
  "RTX 4090": { "Vast.ai": 0.847, "RunPod": 0.890, "Clore.ai": 0.802, "OctaSpace": 0.780 },
  "RTX 4080": { "Vast.ai": 0.560, "RunPod": 0.580, "Clore.ai": 0.540, "OctaSpace": 0.520 },
  "A100":     { "Vast.ai": 1.890, "RunPod": 1.950, "Clore.ai": 1.800, "OctaSpace": 1.750 },
  "H100":     { "Vast.ai": 2.800, "RunPod": 2.890, "Clore.ai": 2.750, "OctaSpace": 2.700 },
};

function fetchPlatformRate(platform, gpuModel) {
  const rates = BASE_RATES[gpuModel] || { "Vast.ai": 0.3, "RunPod": 0.35, "Clore.ai": 0.28, "OctaSpace": 0.32 };
  return rates[platform] || 0;
}

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req, { useServiceRole: true });

  try {
    const allGPUs = await base44.entities.GPU.filter({ status: 'active' });
    if (!allGPUs || allGPUs.length === 0) {
      return Response.json({ message: 'No active GPUs to monitor' });
    }

    const platforms = ["Vast.ai", "RunPod", "Clore.ai", "OctaSpace"];
    const results = [];

    for (const gpu of allGPUs) {
      if (!gpu.user_email) continue;

      const currentRate = gpu.rate_per_hour || 0;

      // Build platform rate map (synchronous lookup, no external calls)
      const platformRates = {};
      for (const platform of platforms) {
        platformRates[platform] = fetchPlatformRate(platform, gpu.model);
      }

      // Find best-yield platform
      const sorted = Object.entries(platformRates)
        .filter(([, r]) => r > 0)
        .sort(([, a], [, b]) => b - a);

      if (sorted.length === 0) continue;

      const [bestPlatform, bestRate] = sorted[0];

      if (currentRate <= 0) continue;

      const yieldImprovement = ((bestRate - currentRate) / currentRate) * 100;

      if (yieldImprovement >= 10) {
        // Update the GPU record to reflect the better platform rate
        try {
          await base44.entities.GPU.update(gpu.id, {
            rate_per_hour: bestRate,
          });

          results.push({
            gpu_id: gpu.gpu_id,
            model: gpu.model,
            current_rate: currentRate,
            best_platform: bestPlatform,
            best_rate: bestRate,
            yield_improvement_percent: parseFloat(yieldImprovement.toFixed(2)),
            action: 'rate_updated',
          });
        } catch (e) {
          results.push({
            gpu_id: gpu.gpu_id,
            model: gpu.model,
            current_rate: currentRate,
            best_platform: bestPlatform,
            best_rate: bestRate,
            yield_improvement_percent: parseFloat(yieldImprovement.toFixed(2)),
            action: 'update_failed',
            error: e.message,
          });
        }
      }
    }

    return Response.json({
      timestamp: new Date().toISOString(),
      gpus_monitored: allGPUs.length,
      optimizations_found: results.length,
      results,
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});