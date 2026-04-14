import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { Connection, PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from 'npm:@solana/web3.js@1.98.0';
import { getAccount, createTransferInstruction, getAssociatedTokenAddress, getMint, TOKEN_PROGRAM_ID } from 'npm:@solana/spl-token@0.4.9';
import bs58 from 'npm:bs58@6.0.0';

const TOKEN_MINT = new PublicKey('2ZkHDUequTHPWQtmJj2AjBAuE1TjuZoWKewnn2Hb6H9p');
const RPC_URL = 'https://api.mainnet-beta.solana.com';
const MIN_BALANCE_FOR_PAYOUT = 1000; // minimum token balance to qualify

/**
 * Fetch all token holders and their balances for the PULSE mint.
 */
async function getTokenHolders(connection) {
  const accounts = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
    filters: [
      { dataSize: 165 },
      { memcmp: { offset: 0, bytes: TOKEN_MINT.toBase58() } },
    ],
  });

  const holders = [];
  for (const { pubkey, account } of accounts) {
    const tokenAccount = await getAccount(connection, pubkey).catch(() => null);
    if (!tokenAccount) continue;
    const balance = Number(tokenAccount.amount);
    if (balance >= MIN_BALANCE_FOR_PAYOUT) {
      holders.push({
        tokenAccountPubkey: pubkey.toBase58(),
        ownerPubkey: tokenAccount.owner.toBase58(),
        balance,
      });
    }
  }

  return holders;
}

/**
 * Calculate payout amounts proportionally based on holder share of total supply.
 * payoutPool: total lamports (SOL) or token units to distribute.
 */
function calculatePayouts(holders, payoutPool) {
  const totalBalance = holders.reduce((sum, h) => sum + h.balance, 0);
  if (totalBalance === 0) return [];

  return holders.map(h => ({
    ...h,
    share: h.balance / totalBalance,
    payoutAmount: Math.floor((h.balance / totalBalance) * payoutPool),
  })).filter(h => h.payoutAmount > 0);
}

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  // Allow scheduled/service calls or admin users
  const user = await base44.auth.me().catch(() => null);
  if (user && user.role !== 'admin') {
    return Response.json({ error: 'Forbidden: Admin only' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const {
    payout_type = 'sol',           // 'sol' or 'token'
    payout_pool_lamports = 0,      // SOL pool in lamports
    payout_pool_tokens = 0,        // token units pool
    dry_run = true,                // set false to actually send transactions
  } = body;

  const treasuryKey = Deno.env.get('TREASURY_PRIVATE_KEY');
  if (!treasuryKey) {
    return Response.json({ error: 'TREASURY_PRIVATE_KEY not configured' }, { status: 500 });
  }

  const treasuryKeypair = Keypair.fromSecretKey(bs58.decode(treasuryKey));
  const connection = new Connection(RPC_URL, 'confirmed');

  // --- 1. Fetch holders ---
  const holders = await getTokenHolders(connection);
  if (holders.length === 0) {
    return Response.json({ message: 'No eligible holders found', holders: 0 });
  }

  // --- 2. Calculate payouts ---
  const payoutPool = payout_type === 'sol' ? payout_pool_lamports : payout_pool_tokens;
  const payouts = calculatePayouts(holders, payoutPool);

  const results = [];

  if (!dry_run) {
    // --- 3. Send transactions ---
    for (const payout of payouts) {
      let tx_hash = null;
      let status = 'pending';

      try {
        const tx = new Transaction();

        if (payout_type === 'sol') {
          // SOL transfer
          tx.add(SystemProgram.transfer({
            fromPubkey: treasuryKeypair.publicKey,
            toPubkey: new PublicKey(payout.ownerPubkey),
            lamports: payout.payoutAmount,
          }));
        } else {
          // SPL token transfer: treasury → holder's associated token account
          const treasuryTokenAccount = await getAssociatedTokenAddress(TOKEN_MINT, treasuryKeypair.publicKey);
          const recipientTokenAccount = new PublicKey(payout.tokenAccountPubkey);

          tx.add(createTransferInstruction(
            treasuryTokenAccount,
            recipientTokenAccount,
            treasuryKeypair.publicKey,
            BigInt(payout.payoutAmount),
          ));
        }

        tx_hash = await sendAndConfirmTransaction(connection, tx, [treasuryKeypair]);
        status = 'confirmed';
      } catch (err) {
        status = 'failed';
        tx_hash = `error: ${err.message}`;
      }

      // Record claim event in DB
      await base44.asServiceRole.entities.ClaimEvent.create({
        amount_pls: payout_type === 'token' ? payout.payoutAmount : 0,
        tx_hash: tx_hash || '',
        status,
        user_email: payout.ownerPubkey,
      }).catch(() => {});

      results.push({
        owner: payout.ownerPubkey,
        balance: payout.balance,
        share: (payout.share * 100).toFixed(4) + '%',
        payout_amount: payout.payoutAmount,
        payout_type,
        tx_hash,
        status,
      });
    }
  }

  return Response.json({
    dry_run,
    payout_type,
    payout_pool: payoutPool,
    total_holders: holders.length,
    eligible_payouts: payouts.length,
    treasury: treasuryKeypair.publicKey.toBase58(),
    results: dry_run
      ? payouts.map(p => ({
          owner: p.ownerPubkey,
          balance: p.balance,
          share: (p.share * 100).toFixed(4) + '%',
          payout_amount: p.payoutAmount,
          payout_type,
          status: 'dry_run',
        }))
      : results,
  });
});