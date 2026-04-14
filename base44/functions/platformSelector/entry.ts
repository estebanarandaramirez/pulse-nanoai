/**
 * platformSelector
 * Smart platform selection based on uptime, fees, and earnings optimization.
 *
 * Active platforms: Salad
 * Gated platforms:  Vast.ai, RunPod, Clore.ai, OctaSpace (preserved for re-enablement)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const PLATFORM_PROFILES = {
  "Salad": {
    name: "Salad",
    uptime_reliability: 0.96,
    platform_fee_percent: 1.5,
    regions: ["US", "EU", "APAC", "Global"],
    min_uptime_requirement: 70,
    enabled: true,
  },
  // --- Gated providers (flip enabled: true to re-activate) ---
  "Vast.ai": {
    name: "Vast.ai",
    uptime_reliability: 0.92,
    platform_fee_percent: 2.5,
    regions: ["US", "EU", "APAC"],
    min_uptime_requirement: 85,
    enabled: false,
  },
  "RunPod": {
    name: "RunPod",
    uptime_reliability: 0.94,
    platform_fee_percent: 3.0,
    regions: ["US", "EU"],
    min_uptime_requirement: 80,
    enabled: false,
  },
  "Clore.ai": {
    name: "Clore.ai",
    uptime_reliability: 0.88,
    platform_fee_percent: 2.0,
    regions: ["US", "EU", "APAC"],
    min_uptime_requirement: 75,
    enabled: false,
  },
  "OctaSpace": {
    name: "OctaSpace",
    uptime_reliability: 0.90,
    platform_fee_percent: 1.5,
    regions: ["US", "EU", "APAC"],
    min_uptime_requirement: 80,
    enabled: false,
  },
};

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { gpu_model, rates, user_region, user_uptime_requirement } = await req.json();

  // Only consider enabled platforms
  const eligible = Object.values(PLATFORM_PROFILES).filter(
    p => p.enabled && p.min_uptime_requirement <= (user_uptime_requirement || 75)
  );

  const scored = eligible.map(platform => {
    const basePrice = rates?.[platform.name] ?? 0.3;
    const afterFee = basePrice * (1 - platform.platform_fee_percent / 100);
    const uptimeBonus = afterFee * platform.uptime_reliability;
    const regionMatch = user_region && platform.regions.includes(user_region) ? 1.0 : 0.95;
    const finalScore = uptimeBonus * regionMatch;

    return {
      platform: platform.name,
      base_rate: parseFloat(basePrice.toFixed(3)),
      platform_fee_percent: platform.platform_fee_percent,
      net_rate: parseFloat(afterFee.toFixed(3)),
      uptime_reliability: platform.uptime_reliability,
      regional_match: user_region
        ? (platform.regions.includes(user_region) ? "yes" : "no")
        : "unknown",
      final_score: parseFloat(finalScore.toFixed(4)),
    };
  }).sort((a, b) => b.final_score - a.final_score);

  if (scored.length === 0) {
    return Response.json({
      error: "No eligible platforms for your uptime requirement",
      requirement: user_uptime_requirement,
      message: `Lower your uptime threshold or contact support.`,
    }, { status: 400 });
  }

  return Response.json({
    gpu_model,
    user_region: user_region || "unknown",
    user_uptime_requirement,
    recommended_platform: scored[0].platform,
    ranked_platforms: scored,
    breakdown: {
      selection_criteria: [
        "Base hourly rate per platform",
        "Platform fee deduction",
        "Uptime reliability weighting",
        "Regional proximity bonus",
      ],
    },
  });
});
