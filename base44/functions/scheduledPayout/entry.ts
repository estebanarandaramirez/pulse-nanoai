import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { Connection, PublicKey, Keypair, Transaction } from 'npm:@solana/web3.js@1.98.0';
import {
  createTransferInstruction,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from 'npm:@solana/spl-token@0.4.9';
import bs58 from 'npm:bs58@6.0.0';

const TOKEN_MINT = new PublicKey('2ZkHDUequTHPWQtmJj2AjBAuE1TjuZoWKewnn2Hb6H9p');
const RPC_URL = 'https://api.mainnet-beta.solana.com';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  // Fetch active payout schedule
  const configs = await base44.asServiceRole.entities.PayoutSchedule.filter({ is_active: true });
  if (!configs || configs.length === 0) {
    return Response.json({ message: 'No active payout schedule found. Skipping.' });
  }
  const config = configs[0];
  const pool = Number(config.pool_amount) || 0;
  if (pool <= 0) {
    return Response.json({ message: 'Pool amount is 0. Skipping.' });
  }

  const treasuryKey = Deno.env.get('TREASURY_PRIVATE_KEY');
  if (!treasuryKey) {
    return Response.json({ error: 'TREASURY_PRIVATE_KEY not configured' }, { status: 500 });
  }
  const treasuryKeypair = Keypair.fromSecretKey(bs58.decode(treasuryKey));
  const connection = new Connection(RPC_URL, 'confirmed');

  // Get all GPU records grouped by user_email to calculate contribution shares
  const gpus = await base44.asServiceRole.entities.GPU.filter({ status: 'active' });
  if (!gpus || gpus.length === 0) {
    await base44.asServiceRole.entities.PayoutSchedule.update(config.id, {
      last_run_at: new Date().toISOString(),
      last_run_status: 'success',
      last_run_tx_count: 0,
    });
    return Response.json({ message: 'No active GPUs found.' });
  }

  // Aggregate uptime hours per user
  const userUptime = {};
  for (const gpu of gpus) {
    if (!gpu.user_email) continue;
    userUptime[gpu.user_email] = (userUptime[gpu.user_email] || 0) + (gpu.uptime_percent || 0);
  }
  const totalUptime = Object.values(userUptime).reduce((s, v) => s + v, 0);
  if (totalUptime === 0) {
    return Response.json({ message: 'Total uptime is 0. Skipping.' });
  }

  // Fetch users who have a registered solana_wallet
  const users = await base44.asServiceRole.entities.User.list();
  const walletMap = {};
  for (const u of users) {
    if (u.email && u.solana_wallet) walletMap[u.email] = u.solana_wallet;
  }

  const treasuryTokenAcc = await getAssociatedTokenAddress(TOKEN_MINT, treasuryKeypair.publicKey);

  let successCount = 0;
  let failCount = 0;
  // pool is in raw token units (e.g. lamports of token with 6 decimals)
  // Assume pool_amount is in PULSE tokens with 6 decimals
  const poolLamports = BigInt(Math.floor(pool * 1_000_000));

  for (const [email, uptimeScore] of Object.entries(userUptime)) {
    const walletAddr = walletMap[email];
    if (!walletAddr) continue; // skip users without registered wallet

    const share = uptimeScore / totalUptime;
    const payoutAmount = BigInt(Math.floor(Number(poolLamports) * share));
    if (payoutAmount <= 0n) continue;

    try {
      const recipientPubkey = new PublicKey(walletAddr);
      // Get or create recipient's associated token account
      const recipientTokenAcc = await getOrCreateAssociatedTokenAccount(
        connection,
        treasuryKeypair,
        TOKEN_MINT,
        recipientPubkey,
      );

      const tx = new Transaction().add(
        createTransferInstruction(
          treasuryTokenAcc,
          recipientTokenAcc.address,
          treasuryKeypair.publicKey,
          payoutAmount,
        )
      );

      const { sendAndConfirmTransaction } = await import('npm:@solana/web3.js@1.98.0');
      const txHash = await sendAndConfirmTransaction(connection, tx, [treasuryKeypair]);

      await base44.asServiceRole.entities.ClaimEvent.create({
        amount_pls: Number(payoutAmount) / 1_000_000,
        tx_hash: txHash,
        status: 'confirmed',
        user_email: email,
      }).catch(() => {});

      successCount++;
    } catch {
      failCount++;
    }
  }

  await base44.asServiceRole.entities.PayoutSchedule.update(config.id, {
    last_run_at: new Date().toISOString(),
    last_run_status: failCount > 0 && successCount === 0 ? 'failed' : 'success',
    last_run_tx_count: successCount,
  });

  return Response.json({
    message: 'PULSE token payout run complete',
    pool_pulse: pool,
    success: successCount,
    failed: failCount,
    skipped_no_wallet: Object.keys(userUptime).length - Object.keys(walletMap).length,
  });
});