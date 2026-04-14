/**
 * fetchSaladEarnings
 * Fetches GPU class pricing and active workload earnings from Salad Cloud API.
 *
 * Required env vars:
 *   SALAD_API_KEY      - Your Salad Cloud API key
 *   SALAD_ORG_NAME     - Your organization name (slug)
 *   SALAD_PROJECT_NAME - (Optional) Project name to fetch container earnings
 *
 * Returns:
 *   gpu_classes        - All available GPU classes with current market prices
 *   total_earnings_usd - Estimated earnings from running container workloads
 *   active_containers  - Count of running container instances
 *   container_list     - Details per container group
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const SALAD_BASE = 'https://api.salad.com/api/public';

// Salad uses priority tiers for pricing. We default to "medium" for market rate display.
const DISPLAY_PRIORITY = 'medium';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const apiKey = Deno.env.get('SALAD_API_KEY');
  const orgName = Deno.env.get('SALAD_ORG_NAME');
  const projectName = Deno.env.get('SALAD_PROJECT_NAME');

  if (!apiKey) return Response.json({ error: 'SALAD_API_KEY not configured' }, { status: 500 });
  if (!orgName) return Response.json({ error: 'SALAD_ORG_NAME not configured' }, { status: 500 });

  const headers = { 'Salad-Api-Key': apiKey };

  try {
    // --- Step 1: Fetch available GPU classes with pricing ---
    const gpuClassesRes = await fetch(
      `${SALAD_BASE}/organizations/${orgName}/gpu-classes`,
      { headers }
    );

    if (!gpuClassesRes.ok) {
      const errText = await gpuClassesRes.text();
      return Response.json(
        { error: `Salad GPU classes fetch failed: ${gpuClassesRes.status}`, details: errText },
        { status: 500 }
      );
    }

    const gpuClassesData = await gpuClassesRes.json();
    const rawClasses = gpuClassesData.items || [];

    // Build a lookup map: gpu_class_id -> { name, price_per_hour }
    const gpuClassMap: Record<string, { name: string; price_per_hour: number }> = {};
    const gpuClassList = rawClasses.map((cls: any) => {
      // Prices array contains entries per priority level.
      // Price unit from Salad API is USD per hour as a float.
      const displayPrice = cls.prices?.find((p: any) => p.priority === DISPLAY_PRIORITY);
      const fallbackPrice = cls.prices?.[0];
      const priceUsd = parseFloat(
        ((displayPrice || fallbackPrice)?.price ?? 0).toFixed(4)
      );

      gpuClassMap[cls.id] = { name: cls.name, price_per_hour: priceUsd };

      return {
        id: cls.id,
        name: cls.name,
        price_per_hour: priceUsd,
        // Also expose all priority tiers for the UI
        prices: (cls.prices || []).map((p: any) => ({
          priority: p.priority,
          price_per_hour: parseFloat((p.price ?? 0).toFixed(4)),
        })),
      };
    });

    // --- Step 2: Fetch container group earnings (if project is configured) ---
    let totalEarningsUsd = 0;
    const activeContainers: any[] = [];

    if (projectName) {
      const containersRes = await fetch(
        `${SALAD_BASE}/organizations/${orgName}/projects/${projectName}/containers`,
        { headers }
      );

      if (containersRes.ok) {
        const containersData = await containersRes.json();
        const containerGroups = containersData.items || [];

        for (const cg of containerGroups) {
          if (cg.current_state?.status !== 'running') continue;

          // Fetch live instances for this container group
          const instancesRes = await fetch(
            `${SALAD_BASE}/organizations/${orgName}/projects/${projectName}/containers/${cg.name}/instances`,
            { headers }
          );

          let runningCount = 0;
          if (instancesRes.ok) {
            const instancesData = await instancesRes.json();
            runningCount = (instancesData.instances || []).filter(
              (i: any) => i.state === 'running'
            ).length;
          }

          if (runningCount === 0) continue;

          // Resolve GPU class and price from the container's resource spec
          const gpuClassId = cg.container?.resources?.gpu_classes?.[0] ?? '';
          const gpuClass = gpuClassMap[gpuClassId] ?? { name: 'Unknown GPU', price_per_hour: 0 };

          const createdAt = cg.create_time ? new Date(cg.create_time).getTime() : Date.now();
          const hoursRunning = Math.max(0, (Date.now() - createdAt) / 3_600_000);
          const groupEarnings = gpuClass.price_per_hour * runningCount * hoursRunning;

          totalEarningsUsd += groupEarnings;
          activeContainers.push({
            name: cg.name,
            display_name: cg.display_name ?? cg.name,
            gpu_class: gpuClass.name,
            instance_count: runningCount,
            price_per_hour: gpuClass.price_per_hour,
            hours_running: parseFloat(hoursRunning.toFixed(1)),
            earnings_usd: parseFloat(groupEarnings.toFixed(2)),
          });
        }
      }
    }

    return Response.json({
      platform: 'Salad',
      total_earnings_usd: parseFloat(totalEarningsUsd.toFixed(2)),
      active_containers: activeContainers.length,
      container_list: activeContainers,
      gpu_classes: gpuClassList,
      last_fetched: new Date().toISOString(),
      user_email: user.email,
    });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
