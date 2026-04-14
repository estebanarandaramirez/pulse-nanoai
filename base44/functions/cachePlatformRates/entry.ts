/**
 * cachePlatformRates
 * In-memory cache for platform GPU rates with 5-minute TTL.
 *
 * Active providers:
 *   salad — fetches live GPU class pricing from Salad Cloud API
 *
 * Gated providers (preserved, not called):
 *   Vast.ai, RunPod, Clore.ai, OctaSpace
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const SALAD_BASE = 'https://api.salad.com/api/public';
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry { rate: number; timestamp: number }
const CACHE: Record<string, CacheEntry> = {};

async function getSaladRate(gpuModel: string): Promise<number> {
  const key = `Salad:${gpuModel}`;
  const cached = CACHE[key];
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.rate;

  const apiKey = Deno.env.get('SALAD_API_KEY');
  const orgName = Deno.env.get('SALAD_ORG_NAME');
  if (!apiKey || !orgName) return 0;

  try {
    const res = await fetch(`${SALAD_BASE}/organizations/${orgName}/gpu-classes`, {
      headers: { 'Salad-Api-Key': apiKey },
    });
    if (!res.ok) return 0;

    const data = await res.json();
    const classes = data.items || [];

    // Cache all GPU classes in one shot to avoid repeated calls
    for (const cls of classes) {
      const mediumPrice = cls.prices?.find((p: any) => p.priority === 'medium');
      const rate = parseFloat(((mediumPrice || cls.prices?.[0])?.price ?? 0).toFixed(4));
      CACHE[`Salad:${cls.name}`] = { rate, timestamp: Date.now() };
    }

    return CACHE[key]?.rate ?? 0;
  } catch {
    return 0;
  }
}

// ---- Gated provider fetchers (kept for future re-enablement) ----

// async function getVastaiRate(gpuModel: string): Promise<number> { ... }
// async function getRunpodRate(gpuModel: string): Promise<number> { ... }
// async function getCloreaiRate(gpuModel: string): Promise<number> { ... }
// async function getOctaspaceRate(gpuModel: string): Promise<number> { ... }

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { platform, gpu_model } = await req.json();

  if (platform !== 'Salad') {
    return Response.json({
      platform,
      gpu_model,
      rate_per_hour: 0,
      cached: false,
      note: `${platform} is currently gated. Only Salad is active.`,
    });
  }

  const rate = await getSaladRate(gpu_model);
  return Response.json({ platform, gpu_model, rate_per_hour: rate, cached: true });
});
