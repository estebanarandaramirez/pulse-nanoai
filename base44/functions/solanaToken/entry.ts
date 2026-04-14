import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  // Fetch PLS token data from Solana devnet (simulated)
  const supply_ui = 18400000 + Math.round(Math.random() * 10000);
  const price_usd = parseFloat((0.01 + Math.random() * 0.002).toFixed(4));
  const market_cap = parseFloat((supply_ui * price_usd).toFixed(2));
  const volume_24h = parseFloat((market_cap * 0.05 * (0.8 + Math.random() * 0.4)).toFixed(2));

  return Response.json({
    supply: { uiAmount: supply_ui, decimals: 9 },
    price_usd,
    market_cap,
    volume_24h,
    holders: 1240 + Math.round(Math.random() * 50),
    lp_depth: 142580 + Math.round(Math.random() * 5000),
  });
});