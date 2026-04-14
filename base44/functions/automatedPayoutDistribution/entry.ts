/**
 * automatedPayoutDistribution
 * 
 * Runs every 24 hours to:
 * 1. Calculate accumulated PULSE earnings from Treasury
 * 2. Reserve 40% for Treasury, distribute 60% to users
 * 3. Proportionally allocate based on GPU uptime
 * 4. Execute Solana SPL token transfers
 * 5. Log all transactions and update schedule
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
} from 'npm:@solana/web3.js@1.98.0';
import {
  createTransferInstruction,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
  getAccount,
} from 'npm:@solana/spl-token@0.4.9';
import bs58 from 'npm:bs58@6.0.0';

const RPC_URL = 'https://api.mainnet-beta.solana.com';
const PULSE_MINT = new PublicKey('2ZkHDUequTHPWQtmJj2AjBAuE1TjuZoWKewnn2Hb6H9p');
const PULSE_DECIMALS = 6;

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  // Allow automation to run without user context
  let user = null;
  try {
    user = await base44.auth.me();
  } catch {
    // Service-level execution allowed
  }

  const treasuryKey = Deno.env.get('TREASURY_PRIVATE_KEY');
  if (!treasuryKey) {
    return Response.json(
      { error: 'TREASURY_PRIVATE_KEY not configured' },
      { status: 500 }
    );
  }

  try {
    // ── Parse treasury key ───────────────────────────────────────────────
    const trimmed = treasuryKey.trim();
    const secretBytes = trimmed.startsWith('[')
      ? Uint8Array.from(JSON.parse(trimmed))
      : bs58.decode(trimmed);
    const treasuryKeypair = Keypair.fromSecretKey(secretBytes);
    const connection = new Connection(RPC_URL, 'confirmed');

    // ── 1. Fetch active payout schedule ──────────────────────────────────
    const schedules = await base44.asServiceRole.entities.PayoutSchedule.filter({
      is_active: true,
    });

    if (!schedules || schedules.length === 0) {
      return Response.json({
        success: true,
        message: 'No active payout schedule. Skipping distribution.',
        timestamp: new Date().toISOString(),
      });
    }

    const schedule = schedules[0];
    const poolAmountUSD = Number(schedule.pool_amount) || 0;

    // Convert USD pool to PULSE tokens (assume $0.01 per PULSE)
    const pulsePerUSD = 1 / 0.01; // 100 PULSE per $1
    const totalPulseLamports = BigInt(
      Math.floor(poolAmountUSD * pulsePerUSD * 10 ** PULSE_DECIMALS)
    );

    if (totalPulseLamports <= 0n) {
      return Response.json({
        success: true,
        message: 'Pool amount is 0. Nothing to distribute.',
        timestamp: new Date().toISOString(),
      });
    }

    // ── 2. Check treasury balance ────────────────────────────────────────
    let treasuryBalance = 0n;
    try {
      const ata = await getAssociatedTokenAddress(
        PULSE_MINT,
        treasuryKeypair.publicKey
      );
      const acc = await getAccount(connection, ata);
      treasuryBalance = acc.amount;
    } catch (e) {
      return Response.json(
        {
          error: 'Treasury has no PULSE token account or connection failed.',
          details: e.message,
        },
        { status: 400 }
      );
    }

    // ── 3. Validate sufficient funds ─────────────────────────────────────
    if (treasuryBalance < totalPulseLamports) {
      return Response.json(
        {
          error: `Insufficient PULSE balance. Have: ${Number(treasuryBalance) / 10 ** PULSE_DECIMALS}, need: ${Number(totalPulseLamports) / 10 ** PULSE_DECIMALS}`,
          balance: Number(treasuryBalance) / 10 ** PULSE_DECIMALS,
          required: Number(totalPulseLamports) / 10 ** PULSE_DECIMALS,
        },
        { status: 400 }
      );
    }

    // ── 4. Calculate distribution shares ─────────────────────────────────
    // 60% to users, 40% stays in treasury
    const userDistributionLamports =
      (totalPulseLamports * BigInt(60)) / BigInt(100);
    const treasuryReserveLamports =
      (totalPulseLamports * BigInt(40)) / BigInt(100);

    // Aggregate GPU uptime by user email
    const gpus = await base44.asServiceRole.entities.GPU.filter({
      status: 'active',
    });
    const userUptime = {};
    for (const gpu of gpus || []) {
      if (!gpu.user_email) continue;
      userUptime[gpu.user_email] =
        (userUptime[gpu.user_email] || 0) + (gpu.uptime_percent || 0);
    }

    const totalUptime = Object.values(userUptime).reduce((s, v) => s + v, 0);

    if (totalUptime === 0) {
      return Response.json({
        success: true,
        message: 'No GPU uptime recorded. Skipping distribution.',
        timestamp: new Date().toISOString(),
      });
    }

    // ── 5. Fetch users and wallets ───────────────────────────────────────
    const users = await base44.asServiceRole.entities.User.list();
    const walletMap = {};
    for (const u of users) {
      if (u.email && u.solana_wallet) {
        walletMap[u.email] = u.solana_wallet;
      }
    }

    // ── 6. Execute Solana transfers ──────────────────────────────────────
    const treasuryTokenAcc = await getAssociatedTokenAddress(
      PULSE_MINT,
      treasuryKeypair.publicKey
    );

    const distribution = {
      success: 0,
      failed: 0,
      skipped_no_wallet: 0,
    };
    const payouts = [];

    for (const [email, uptimeScore] of Object.entries(userUptime)) {
      const walletAddr = walletMap[email];
      if (!walletAddr) {
        distribution.skipped_no_wallet++;
        payouts.push({
          email,
          status: 'skipped_no_wallet',
          amount_pls: 0,
        });
        continue;
      }

      const share = uptimeScore / totalUptime;
      const payout = BigInt(
        Math.floor(Number(userDistributionLamports) * share)
      );

      if (payout <= 0n) continue;

      const pulseAmount = Number(payout) / 10 ** PULSE_DECIMALS;

      try {
        const recipientPubkey = new PublicKey(walletAddr);
        const recipientTokenAcc =
          await getOrCreateAssociatedTokenAccount(
            connection,
            treasuryKeypair,
            PULSE_MINT,
            recipientPubkey
          );

        const tx = new Transaction().add(
          createTransferInstruction(
            treasuryTokenAcc,
            recipientTokenAcc.address,
            treasuryKeypair.publicKey,
            payout
          )
        );

        const { sendAndConfirmTransaction } = await import(
          'npm:@solana/web3.js@1.98.0'
        );
        const txHash = await sendAndConfirmTransaction(connection, tx, [
          treasuryKeypair,
        ]);

        // Log the claim event
        await base44.asServiceRole.entities.ClaimEvent.create({
          amount_pls: pulseAmount,
          tx_hash: txHash,
          status: 'confirmed',
          user_email: email,
        }).catch(() => {});

        distribution.success++;
        payouts.push({
          email,
          wallet: walletAddr.slice(0, 8) + '...',
          amount_pls: pulseAmount,
          tx_hash: txHash,
          status: 'confirmed',
        });
      } catch (e) {
        distribution.failed++;
        payouts.push({
          email,
          amount_pls: pulseAmount,
          status: 'failed',
          error: e.message,
        });
      }
    }

    // ── 7. Update payout schedule ────────────────────────────────────────
    await base44.asServiceRole.entities.PayoutSchedule.update(schedule.id, {
      last_run_at: new Date().toISOString(),
      last_run_status:
        distribution.failed > 0 && distribution.success === 0
          ? 'failed'
          : 'success',
      last_run_tx_count: distribution.success,
      pool_amount: 0, // Reset pool after distribution
    });

    return Response.json({
      success: true,
      timestamp: new Date().toISOString(),
      cycle: {
        total_pool_usd: poolAmountUSD,
        total_pulse_distributed: Number(userDistributionLamports) / 10 ** PULSE_DECIMALS,
        user_share_pct: 60,
        treasury_reserve_pct: 40,
      },
      distribution,
      payouts,
    });
  } catch (error) {
    return Response.json(
      {
        error: 'Distribution failed',
        details: error.message,
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
});