import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from 'npm:@solana/web3.js@1.98.0';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  try {
    const user = await base44.auth.me();
    if (user?.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
  } catch {}

  return Response.json({ error: 'Airdrops are not available on mainnet.' }, { status: 400 });

  try {
    const pubkey = new PublicKey(treasuryAddress);

    // Request 2 SOL airdrop (devnet max per request is 2 SOL)
    const sig = await connection.requestAirdrop(pubkey, 2 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, 'confirmed');

    const balance = await connection.getBalance(pubkey);

    return Response.json({
      success: true,
      tx_signature: sig,
      new_balance_sol: balance / LAMPORTS_PER_SOL,
      message: 'Airdrop of 2 SOL confirmed on devnet',
    });
  } catch (error) {
    // Even if confirm times out, check balance
    try {
      const pubkey = new PublicKey(treasuryAddress);
      const balance = await connection.getBalance(pubkey);
      return Response.json({
        success: false,
        error: error.message,
        current_balance_sol: balance / LAMPORTS_PER_SOL,
      });
    } catch {
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }
});