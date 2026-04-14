/**
 * processPlatformRevenue
 *
 * Revenue Distribution Logic:
 *   TOTAL platform revenue (USD) from PayoutSchedule.pool_amount
 *   ├── 40% → Treasury (retained as PULSE tokens already held)
 *   └── 60% → Distribute PULSE tokens proportionally to each user's
 *              Phantom wallet based on their active GPU uptime contribution
 *
 * Pass { dry_run: true } to simulate without on-chain transactions.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
} from 'npm:@solana/web3.js@1.98.0';
import {
  createTransferInstruction,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
  getAccount,
} from 'npm:@solana/spl-token@0.4.9';
import bs58 from 'npm:bs58@6.0.0';

const SOLANA_NETWORK = Deno.env.get('SOLANA_NETWORK') || 'mainnet';
const RPC_URL = SOLANA_NETWORK === 'testnet'
  ? 'https://api.testnet.solana.com'
  : 'https://api.mainnet-beta.solana.com';
const PULSE_MINT = new PublicKey(
  SOLANA_NETWORK === 'testnet'
    ? 'TokenkegQfeZyiNwAJsyFbPVwwQnmZmwMw8d9VLLngc'
    : '2ZkHDUequTHPWQtmJj2AjBAuE1TjuZoWKewnn2Hb6H9p'
);
const PULSE_DECIMALS = 6;
const PULSE_PRICE_USD = 0.01; // 1 PULSE = $0.01

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  const treasuryKey = Deno.env.get('TREASURY_PRIVATE_KEY');
  if (!treasuryKey) return Response.json({ error: 'TREASURY_PRIVATE_KEY not set' }, { status: 500 });

  let dry_run = false;
  try {
    const body = await req.clone().json();
    dry_run = !!body.dry_run;
  } catch {}

  try {
    const user = await base44.auth.me();
    if (user && user.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin only' }, { status: 403 });
    }
  } catch { /* automation call — allow */ }

  // ── 1. Fetch active PayoutSchedule ───────────────────────────────────────
  const configs = await base44.asServiceRole.entities.PayoutSchedule.filter({ is_active: true });
  if (!configs || configs.length === 0) {
    return Response.json({ message: 'No active payout schedule. Skipping.' });
  }
  const config = configs[0];
  const totalRevenueUSD = Number(config.pool_amount) || 0;
  if (totalRevenueUSD <= 0) {
    return Response.json({ message: 'pool_amount is 0. Nothing to process.' });
  }

  // ── 2. Revenue split ─────────────────────────────────────────────────────
  const treasuryShareUSD = totalRevenueUSD * 0.40;
  const userShareUSD = totalRevenueUSD * 0.60;

  // Convert USD → PULSE (at fixed price)
  const totalPulseToDistribute = userShareUSD / PULSE_PRICE_USD;
  const totalPulseLamports = BigInt(Math.floor(totalPulseToDistribute * 10 ** PULSE_DECIMALS));

  // Parse key
  const trimmed = treasuryKey.trim();
  const secretBytes = trimmed.startsWith('[')
    ? Uint8Array.from(JSON.parse(trimmed))
    : bs58.decode(trimmed);
  const treasuryKeypair = Keypair.fromSecretKey(secretBytes);
  const connection = new Connection(RPC_URL, 'confirmed');

  // ── 3. Check treasury PULSE balance ──────────────────────────────────────
  let treasuryPulseBalance = 0n;
  try {
    const ata = await getAssociatedTokenAddress(PULSE_MINT, treasuryKeypair.publicKey);
    const acc = await getAccount(connection, ata);
    treasuryPulseBalance = acc.amount;
  } catch {
    return Response.json({ error: 'Treasury has no PULSE token account. Fund the treasury first.' }, { status: 400 });
  }

  if (!dry_run && treasuryPulseBalance < totalPulseLamports) {
    return Response.json({
      error: `Insufficient PULSE: treasury has ${Number(treasuryPulseBalance) / 10 ** PULSE_DECIMALS}, needs ${totalPulseToDistribute}`,
    }, { status: 400 });
  }

  // ── 4. Fetch users and GPU uptime ─────────────────────────────────────────
  const gpus = await base44.asServiceRole.entities.GPU.filter({ status: 'active' });
  const users = await base44.asServiceRole.entities.User.list();

  const walletMap = {};
  for (const u of users) {
    if (u.email && u.solana_wallet) walletMap[u.email] = u.solana_wallet;
  }

  const userUptime = {};
  for (const gpu of gpus || []) {
    if (!gpu.user_email) continue;
    userUptime[gpu.user_email] = (userUptime[gpu.user_email] || 0) + (gpu.uptime_percent || 0);
  }
  const totalUptime = Object.values(userUptime).reduce((s, v) => s + v, 0);

  const results = {
    dry_run,
    total_revenue_usd: totalRevenueUSD,
    treasury_reserved_usd: treasuryShareUSD,
    user_share_usd: userShareUSD,
    pulse_price_usd: PULSE_PRICE_USD,
    treasury_pulse_balance: Number(treasuryPulseBalance) / 10 ** PULSE_DECIMALS,
    pulse_to_distribute: totalPulseToDistribute,
    distribution: { success: 0, failed: 0, skipped_no_wallet: 0, skipped_no_uptime: 0 },
    payouts: [],
  };

  if (totalUptime === 0) {
    results.distribution.skipped_no_uptime = Object.keys(userUptime).length;
    return Response.json({ ...results, message: 'No GPU uptime found. Nothing distributed.' });
  }

  // ── 5. Distribute PULSE ───────────────────────────────────────────────────
  const treasuryTokenAcc = await getAssociatedTokenAddress(PULSE_MINT, treasuryKeypair.publicKey);

  for (const [email, uptimeScore] of Object.entries(userUptime)) {
    const walletAddr = walletMap[email];
    if (!walletAddr) {
      results.distribution.skipped_no_wallet++;
      results.payouts.push({ email, status: 'skipped_no_wallet', pulse: 0 });
      continue;
    }

    const share = uptimeScore / totalUptime;
    const payout = BigInt(Math.floor(Number(totalPulseLamports) * share));
    if (payout <= 0n) continue;

    const pulseAmount = Number(payout) / 10 ** PULSE_DECIMALS;

    if (dry_run) {
      results.distribution.success++;
      results.payouts.push({ email, wallet: walletAddr.slice(0, 8) + '...', pulse: pulseAmount, share_pct: (share * 100).toFixed(2) + '%', status: 'dry_run' });
      continue;
    }

    try {
      const recipientPubkey = new PublicKey(walletAddr);
      const recipientTokenAcc = await getOrCreateAssociatedTokenAccount(
        connection, treasuryKeypair, PULSE_MINT, recipientPubkey
      );
      const tx = new Transaction().add(
        createTransferInstruction(
          treasuryTokenAcc,
          recipientTokenAcc.address,
          treasuryKeypair.publicKey,
          payout,
        )
      );
      const txHash = await sendAndConfirmTransaction(connection, tx, [treasuryKeypair]);

      await base44.asServiceRole.entities.ClaimEvent.create({
        amount_pls: pulseAmount,
        tx_hash: txHash,
        status: 'confirmed',
        user_email: email,
      }).catch(() => {});

      results.distribution.success++;
      results.payouts.push({ email, wallet: walletAddr.slice(0, 8) + '...', pulse: pulseAmount, tx_hash: txHash, status: 'confirmed' });
    } catch (e) {
      results.distribution.failed++;
      results.payouts.push({ email, pulse: pulseAmount, status: 'failed', error: e.message });
    }
  }

  // ── 6. Update schedule ────────────────────────────────────────────────────
  if (!dry_run) {
    await base44.asServiceRole.entities.PayoutSchedule.update(config.id, {
      last_run_at: new Date().toISOString(),
      last_run_status: results.distribution.failed === 0 ? 'success' : 'failed',
      last_run_tx_count: results.distribution.success,
    });
  }

  return Response.json({
    ...results,
    network: SOLANA_NETWORK,
    warning: SOLANA_NETWORK === 'testnet' ? '🧪 TESTNET MODE - No real value' : undefined,
  });
});