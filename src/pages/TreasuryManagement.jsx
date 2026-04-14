import { useState, useEffect } from "react";
import { useAuth } from "@/lib/AuthContext";
import { base44 } from "@/api/base44Client";
import { ShieldAlert, Play, RefreshCw, DollarSign, Coins, Droplets, TrendingUp } from "lucide-react";
import StatusTag from "../components/shared/StatusTag";
import StatCard from "../components/shared/StatCard";
import { format } from "date-fns";

export default function TreasuryManagement() {
  const { user } = useAuth();
  const [schedule, setSchedule] = useState(null);
  const [lpEvents, setLpEvents] = useState([]);
  const [revenueInput, setRevenueInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    setLoading(true);
    const [configs, events] = await Promise.all([
      base44.entities.PayoutSchedule.filter({ is_active: true }),
      base44.entities.LPEvent.list("-created_date", 10),
    ]);
    if (configs?.length) {
      setSchedule(configs[0]);
      setRevenueInput(String(configs[0].pool_amount || ""));
    }
    setLpEvents(events || []);
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, []);

  if (user?.role !== "admin") {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center space-y-2">
          <ShieldAlert className="w-8 h-8 text-pulse-red mx-auto" />
          <p className="text-sm font-mono text-muted-foreground">Admin access required.</p>
        </div>
      </div>
    );
  }

  const saveRevenue = async () => {
    const amount = parseFloat(revenueInput);
    if (!amount || amount <= 0) return;
    setSaving(true);
    if (schedule) {
      await base44.entities.PayoutSchedule.update(schedule.id, { pool_amount: amount });
    } else {
      await base44.entities.PayoutSchedule.create({
        label: "Platform Revenue Cycle",
        frequency: "daily",
        payout_type: "token",
        pool_amount: amount,
        is_active: true,
      });
    }
    await fetchData();
    setSaving(false);
  };

  const triggerDistribution = async () => {
    setRunning(true);
    setRunResult(null);
    const r = await base44.functions.invoke("processPlatformRevenue", {});
    setRunResult(r.data);
    await fetchData();
    setRunning(false);
  };

  const solPct = 0.60, treasuryPct = 0.40;
  const rev = parseFloat(revenueInput) || 0;
  const treasuryUSD = (rev * treasuryPct).toFixed(2);
  const userShareUSD = (rev * solPct).toFixed(2);
  const pulseEst = (rev * solPct / 0.01).toLocaleString(undefined, { maximumFractionDigits: 0 });
  const solEst = (rev * solPct / 150).toFixed(4);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <span className="w-2 h-2 rounded-full bg-amber animate-pulse-glow" />
        <h1 className="font-display font-bold text-xl tracking-[3px] uppercase text-foreground">Treasury Management</h1>
        <span className="px-2 py-0.5 bg-amber/10 border border-amber/30 rounded text-[9px] tracking-[2px] uppercase font-mono text-amber">Admin Only</span>
      </div>

      {/* Revenue split preview */}
      {rev > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard label="Total Revenue" value={`$${rev.toFixed(2)}`} sub="Current cycle" color="amber" icon={DollarSign} />
          <StatCard label="Treasury (40%)" value={`$${treasuryUSD}`} sub="Stays on-platform" color="purple" icon={ShieldAlert} />
          <StatCard label="LP Injection (60%)" value={`${solEst} SOL`} sub={`~$${userShareUSD}`} color="primary" icon={Droplets} />
          <StatCard label="PULSE to Users (60%)" value={pulseEst} sub="PULSE tokens" color="accent" icon={Coins} />
        </div>
      )}

      {/* Revenue input */}
      <div className="bg-card border border-amber/30 rounded-md p-5 relative card-gradient-top">
        <h2 className="font-display font-bold text-sm tracking-[2px] uppercase text-amber mb-1">Set Platform Revenue</h2>
        <p className="text-[10px] text-muted-foreground font-mono mb-4">
          Enter total USD revenue collected from all GPU rental platforms for the current cycle.
          <br />40% is reserved in treasury · 60% splits between Raydium LP injection and PULSE user distributions.
        </p>
        <div className="flex gap-3">
          <div className="relative flex-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-[11px] font-mono">$</span>
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="e.g. 1554.00"
              value={revenueInput}
              onChange={e => setRevenueInput(e.target.value)}
              className="w-full bg-input border border-border rounded-md pl-6 pr-3 py-2.5 text-[11px] font-mono focus:border-amber/50 outline-none"
            />
          </div>
          <button
            onClick={saveRevenue}
            disabled={saving || !revenueInput}
            className="px-5 py-2.5 bg-amber text-background text-[10px] tracking-[1px] uppercase font-mono rounded-md hover:opacity-80 transition-opacity disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      {/* Manual trigger */}
      <div className="bg-card border border-cyan/30 rounded-md p-5 relative card-gradient-top glow-cyan">
        <h2 className="font-display font-bold text-sm tracking-[2px] uppercase text-cyan mb-1">Manual Distribution Run</h2>
        <p className="text-[10px] text-muted-foreground font-mono mb-4">
          Triggers <span className="text-cyan">processPlatformRevenue</span> immediately. Use to test before the automated midnight run.
          Requires an active PayoutSchedule with a pool amount set above.
        </p>
        <button
          onClick={triggerDistribution}
          disabled={running || !schedule}
          className="flex items-center gap-2 px-6 py-2.5 bg-cyan text-background text-[10px] tracking-[1px] uppercase font-mono rounded-md hover:opacity-80 transition-opacity disabled:opacity-50"
        >
          {running ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          {running ? "Running..." : "Run Distribution Now"}
        </button>
        {!schedule && (
          <p className="mt-2 text-[9px] text-amber font-mono">⚠ No active schedule — save a revenue amount first.</p>
        )}

        {/* Result display */}
        {runResult && (
          <div className="mt-4 bg-muted/30 border border-border rounded-md p-4 text-[10px] font-mono space-y-2">
            {runResult.message ? (
              <p className="text-amber">{runResult.message}</p>
            ) : (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <div className="text-muted-foreground">Total Revenue</div>
                    <div className="text-foreground font-bold">${runResult.total_revenue_usd}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Treasury Reserved</div>
                    <div className="text-purple font-bold">${runResult.treasury_reserved_usd?.toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">LP Injection</div>
                    <div className={runResult.lp_injection?.status === "confirmed" ? "text-neon-green font-bold" : "text-pulse-red font-bold"}>
                      {runResult.lp_injection?.sol?.toFixed(4)} SOL · {runResult.lp_injection?.status}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">PULSE Sent</div>
                    <div className="text-cyan font-bold">
                      {runResult.pulse_distribution?.success} txs · {runResult.pulse_distribution?.skipped_no_wallet} no wallet
                    </div>
                  </div>
                </div>
                {runResult.lp_injection?.tx_hash && (
                  <a
                    href={`https://explorer.solana.com/tx/${runResult.lp_injection.tx_hash}?cluster=devnet`}
                    target="_blank" rel="noreferrer"
                    className="text-cyan hover:underline"
                  >
                    LP TX: {runResult.lp_injection.tx_hash}
                  </a>
                )}
                {runResult.lp_injection?.error && (
                  <p className="text-pulse-red">LP Error: {runResult.lp_injection.error}</p>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Recent LP Events */}
      <div className="bg-card border border-border rounded-md overflow-hidden relative card-gradient-top">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h2 className="font-display font-bold text-sm tracking-[2px] uppercase text-foreground">Recent LP Events</h2>
          <button onClick={fetchData} className="text-muted-foreground hover:text-cyan transition-colors">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
        {loading ? (
          <div className="p-6 text-center text-[10px] text-muted-foreground font-mono">Loading...</div>
        ) : lpEvents.length === 0 ? (
          <div className="p-6 text-center text-[10px] text-muted-foreground font-mono">No LP events yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  {["Date", "Type", "Amount USD", "SOL Depth", "TX Hash", "Status"].map(h => (
                    <th key={h} className="px-4 py-2 text-[9px] tracking-[1.5px] uppercase text-muted-foreground text-left font-normal">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lpEvents.map(e => (
                  <tr key={e.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">
                      {format(new Date(e.created_date), "MMM d, HH:mm")}
                    </td>
                    <td className="px-4 py-2.5 text-[10px] font-mono text-foreground capitalize">{e.type}</td>
                    <td className="px-4 py-2.5 text-[10px] font-mono text-amber">${e.amount_usdc?.toFixed(2)}</td>
                    <td className="px-4 py-2.5 text-[10px] font-mono text-cyan">{e.pool_depth_after?.toFixed(4)} SOL</td>
                    <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">
                      {e.tx_hash ? (
                        <a href={`https://explorer.solana.com/tx/${e.tx_hash}?cluster=devnet`} target="_blank" rel="noreferrer"
                          className="hover:text-cyan transition-colors">
                          {e.tx_hash.slice(0, 8)}...
                        </a>
                      ) : "—"}
                    </td>
                    <td className="px-4 py-2.5"><StatusTag status={e.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}