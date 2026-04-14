import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { wallet_address, amount_pls } = await req.json();

  if (!wallet_address) return Response.json({ error: "No wallet address provided" }, { status: 400 });
  if (!amount_pls || amount_pls <= 0) return Response.json({ error: "Invalid amount" }, { status: 400 });

  // Simulate on-chain transfer (devnet)
  const tx_hash = Array.from({ length: 44 }, () =>
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"[Math.floor(Math.random() * 58)]
  ).join("");

  await base44.entities.ClaimEvent.create({
    amount_pls,
    tx_hash,
    status: "confirmed",
    user_email: user.email,
  });

  return Response.json({
    success: true,
    tx_hash,
    amount_pls,
    wallet_address,
    explorer_url: `https://explorer.solana.com/tx/${tx_hash}`,
  });
});