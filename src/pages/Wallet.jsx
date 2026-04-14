import { useState, useEffect } from "react";
import { ExternalLink, Coins, TrendingUp, CheckCircle } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import StatCard from "../components/shared/StatCard";
import VestingBar from "../components/shared/VestingBar";
import StatusTag from "../components/shared/StatusTag";
import PhantomConnect from "../components/shared/PhantomConnect";
import { format } from "date-fns";

const MOCK_STREAMS = [
  { id: "1", source: "gpu_revenue", total_pls: 15000, claimed_pls: 4200, status: "active", end_date: new Date(Date.now() + 86400000 * 20).toISOString() },
  { id: "2", source: "bonus", total_pls: 8500, claimed_pls: 8500, status: "completed", end_date: new Date(Date.now() - 86400000 * 2).toISOString() },
  { id: "3", source: "referral", total_pls: 22000, claimed_pls: 0, status: "active", end_date: new Date(Date.now() + 86400000 * 45).toISOString() },
];

const MOCK_CLAIMS = [
  { id: "1", amount_pls: 2100, tx_hash: "4hNx7...kPq2", status: "confirmed", created_date: new Date(Date.now() - 86400000 * 3).toISOString() },
  { id: "2", amount_pls: 1500, tx_hash: "8mBz3...rWt9", status: "confirmed", created_date: new Date(Date.now() - 86400000 * 7).toISOString() },
  { id: "3", amount_pls: 600, tx_hash: "2kLp9...nQm4", status: "pending", created_date: new Date(Date.now() - 3600000).toISOString() },
];

export default function Wallet() {
  const { user } = useAuth();
  const [wallet, setWallet] = useState(localStorage.getItem("pulse-wallet"));
  const [streams, setStreams] = useState(MOCK_STREAMS);
  const [claims, setClaims] = useState(MOCK_CLAIMS);
  const [amount, setAmount] = useState("");
  const [claiming, setClaiming] = useState(false);
  const [claimResult, setClaimResult] = useState(null);

  const totalPls = streams.reduce((s, x) => s + x.total_pls, 0);
  const claimedPls = streams.reduce((s, x) => s + x.claimed_pls, 0);
  const claimable = totalPls - claimedPls;

  const claim = async () => {
    if (!wallet || !amount || parseFloat(amount) <= 0) return;
    setClaiming(true);
    try {
      const r = await base44.functions.invoke("claimPLS", { wallet_address: wallet, amount_pls: parseFloat(amount) });
      setClaimResult(r.data);
      setAmount("");
    } catch {
      setClaimResult({ error: "Claim failed. Check treasury balance." });
    }
    setClaiming(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <span className="w-2 h-2 rounded-full bg-neon-green animate-pulse-glow" />
        <h1 className="font-display font-bold text-xl tracking-[3px] uppercase text-foreground">Wallet</h1>
      </div>

      <PhantomConnect onWalletChange={setWallet} />

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StatCard label="Total PULSE" value={totalPls.toLocaleString()} color="primary" icon={Coins} />
        <StatCard label="Claimed" value={claimedPls.toLocaleString()} color="accent" icon={CheckCircle} />
        <StatCard label="Claimable" value={claimable.toLocaleString()} color="amber" icon={TrendingUp} />
      </div>

      {/* Claim panel */}
      <div className="bg-card border border-cyan/30 rounded-md p-5 glow-cyan relative card-gradient-top">
        <h2 className="font-display font-bold text-sm tracking-[2px] uppercase text-cyan mb-4">Claim PULSE to Wallet</h2>
        {!wallet && (
          <div className="flex items-center gap-2 mb-4 px-3 py-2 bg-amber/10 border border-amber/30 rounded-md text-[10px] font-mono text-amber">
            ⚠ Connect your Phantom wallet first to claim PULSE tokens.
          </div>
        )}
        <div className="flex gap-3">
          <div className="flex-1 relative">
            <input
              type="number"
              placeholder="Enter PLS amount..."
              value={amount}
              onChange={e => setAmount(e.target.value)}
              disabled={!wallet}
              className="w-full bg-input border border-border rounded-md px-3 py-2.5 text-[11px] font-mono focus:border-cyan/50 outline-none disabled:opacity-50"
            />
          </div>
          <button onClick={() => setAmount(claimable.toString())} disabled={!wallet}
            className="px-3 py-2.5 border border-border rounded-md text-[10px] font-mono text-muted-foreground hover:text-cyan hover:border-cyan/50 transition-colors disabled:opacity-50">
            Max
          </button>
          <button onClick={claim} disabled={!wallet || claiming || !amount}
            className="px-5 py-2.5 bg-cyan text-background text-[10px] tracking-[1px] uppercase font-mono rounded-md hover:opacity-80 transition-opacity disabled:opacity-50">
            {claiming ? "Claiming..." : "Claim"}
          </button>
        </div>
        {claimResult && (
          <div className={`mt-3 px-3 py-2 rounded-md text-[10px] font-mono ${claimResult.error ? "bg-pulse-red/10 border border-pulse-red/30 text-pulse-red" : "bg-neon-green/10 border border-neon-green/30 text-neon-green"}`}>
            {claimResult.error || `✓ PULSE Claimed! TX: ${claimResult.tx_hash}`}
          </div>
        )}
      </div>

      {/* Vesting Streams */}
      <div>
        <h2 className="font-display font-bold text-sm tracking-[2px] uppercase text-foreground mb-3">Vesting Streams</h2>
        <div className="space-y-3">
          {streams.map(s => <VestingBar key={s.id} stream={s} />)}
        </div>
      </div>

      {/* Claim History */}
      <div className="bg-card border border-border rounded-md overflow-hidden relative card-gradient-top">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="font-display font-bold text-sm tracking-[2px] uppercase text-foreground">Claim History</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                {["Date", "Amount PULSE", "TX Hash", "Status"].map(h => (
                  <th key={h} className="px-4 py-2 text-[9px] tracking-[1.5px] uppercase text-muted-foreground text-left font-normal">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {claims.map(c => (
                <tr key={c.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">{format(new Date(c.created_date), "MMM d, yyyy HH:mm")}</td>
                  <td className="px-4 py-2.5 text-[11px] font-mono text-cyan">{c.amount_pls.toLocaleString()} PULSE</td>
                  <td className="px-4 py-2.5">
                    <a href={`https://explorer.solana.com/tx/${c.tx_hash}?cluster=devnet`} target="_blank" rel="noreferrer"
                      className="text-[10px] font-mono text-muted-foreground hover:text-cyan transition-colors flex items-center gap-1">
                      {c.tx_hash} <ExternalLink className="w-3 h-3" />
                    </a>
                  </td>
                  <td className="px-4 py-2.5"><StatusTag status={c.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}