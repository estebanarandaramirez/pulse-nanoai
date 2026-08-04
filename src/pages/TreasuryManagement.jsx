import { useState, useEffect } from "react";
import { useAuth } from "@/lib/AuthContext";
import { base44 } from "@/api/base44Client";
import { ShieldAlert, Play, RefreshCw, DollarSign, Coins, Droplets, TrendingUp, Wallet, Zap } from "lucide-react";
import StatusTag from "../components/shared/StatusTag";
import { format } from "date-fns";

function BalanceCard({ label, value, sub, color = "cyan", icon: Icon }) {
  const colorMap = {
    cyan:   "border-cyan/30 text-cyan",
    amber:  "border-amber/30 text-amber",
    purple: "border-purple/30 text-purple",
    green:  "border-neon-green/30 text-neon-green",
  };
  return (
    <div className={`bg-card border rounded-md p-4 relative card-gradient-top ${colorMap[color]}`}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-[9px] tracking-[2px] uppercase font-mono text-muted-foreground">{label}</span>
        {Icon && <Icon className={`w-3.5 h-3.5 ${colorMap[color].split(" ")[1]}`} />}
      </div>
      <div className={`text-xl font-display font-bold tracking-tight ${colorMap[color].split(" ")[1]}`}>
        {value ?? <span className="text-muted-foreground text-sm">—</span>}
      </div>
      {sub && <div className="mt-1 text-[9px] font-mono text-muted-foreground truncate">{sub}</div>}
    </div>
  );
}

export default function TreasuryManagement() {
  const { user } = useAuth();
  const [balances, setBalances] = useState(null);
  const [lpEvents, setLpEvents] = useState([]);
  const [loadingBal, setLoadingBal] = useState(true);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState(null);

  const fetchBalances = async () => {
    setLoadingBal(true);
    try {
      const r = await base44.functions.invoke("getTreasuryBalances", {});
      setBalances(r.data);
    } catch {}
    setLoadingBal(false);
  };

  const fetchEvents = async () => {
    setLoadingEvents(true);
    const events = await base44.entities.LPEvent.list("-created_date", 10);
    setLpEvents(events || []);
    setLoadingEvents(false);
  };

  useEffect(() => {
    fetchBalances();
    fetchEvents();
  }, []);

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

  const triggerDistribution = async () => {
    setRunning(true);
    setRunResult(null);
    const r = await base44.functions.invoke("processPlatformRevenue", {});
    setRunResult(r.data);
    await Promise.all([fetchBalances(), fetchEvents()]);
    setRunning(false);
  };

  const fmt = (n, decimals = 4) =>
    n == null ? null : Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: decimals });

  const sol   = balances?.sol;
  const pulse = balances?.pulse;
  const octa  = balances?.octa;
  const clore = balances?.clore;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-amber animate-pulse-glow" />
          <h1 className="font-display font-bold text-xl tracking-[3px] uppercase text-foreground">Treasury</h1>
          <span className="px-2 py-0.5 bg-amber/10 border border-amber/30 rounded text-[9px] tracking-[2px] uppercase font-mono text-amber">Admin Only</span>
        </div>
        <button
          onClick={() => { fetchBalances(); fetchEvents(); }}
          className="text-muted-foreground hover:text-cyan transition-colors"
          title="Refresh balances"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loadingBal ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Distribution wallet */}
      <div>
        <div className="mb-2 flex items-center gap-2">
          <Wallet className="w-3.5 h-3.5 text-cyan" />
          <span className="text-[9px] tracking-[2px] uppercase font-mono text-muted-foreground">Distribution Wallet (Solana)</span>
          <span className="text-[9px] font-mono text-muted-foreground/50 truncate">{balances?.distribution_wallet}</span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <BalanceCard
            label="SOL Balance"
            value={loadingBal ? "..." : sol?.balance_sol != null ? `${fmt(sol.balance_sol, 4)} SOL` : "Error"}
            sub="Transaction fees"
            color="cyan"
            icon={Zap}
          />
          <BalanceCard
            label="PULSE Token Balance"
            value={loadingBal ? "..." : pulse?.balance_pulse != null ? `${fmt(pulse.balance_pulse, 0)} PULSE` : "Error"}
            sub="Available to distribute"
            color="purple"
            icon={Coins}
          />
        </div>
      </div>

      {/* Platform treasury wallets */}
      <div>
        <div className="mb-2 flex items-center gap-2">
          <DollarSign className="w-3.5 h-3.5 text-amber" />
          <span className="text-[9px] tracking-[2px] uppercase font-mono text-muted-foreground">Platform Treasury Wallets</span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <BalanceCard
            label="OctaSpace (OCTA)"
            value={loadingBal ? "..." : octa?.balance_octa != null
              ? `${fmt(octa.balance_octa, 4)} OCTA`
              : (octa?.note ? "Not configured" : "Error")}
            sub={octa?.balance_octa != null ? `≈ $${fmt(octa.balance_usd, 2)} USD @ $${octa?.octa_price_usd}/OCTA` : octa?.note ?? ""}
            color="amber"
            icon={TrendingUp}
          />
          <BalanceCard
            label="Clore.ai (CLORE)"
            value={loadingBal ? "..." : clore?.balance_clore != null
              ? `${fmt(clore.balance_clore, 4)} CLORE`
              : (clore?.note ? "Not configured" : "Error")}
            sub={clore?.balance_clore != null ? `≈ $${fmt(clore.balance_usd, 2)} USD` : clore?.note ?? ""}
            color="green"
            icon={Droplets}
          />
        </div>
        {balances?.fetched_at && (
          <p className="mt-2 text-[9px] font-mono text-muted-foreground/50">
            Last fetched: {format(new Date(balances.fetched_at), "MMM d, HH:mm:ss")}
          </p>
        )}
      </div>

      {/* Manual distribution trigger */}
      <div className="bg-card border border-cyan/30 rounded-md p-5 relative card-gradient-top glow-cyan">
        <h2 className="font-display font-bold text-sm tracking-[2px] uppercase text-cyan mb-1">Manual Distribution Run</h2>
        <p className="text-[10px] text-muted-foreground font-mono mb-4">
          Triggers <span className="text-cyan">processPlatformRevenue</span> immediately.
          The automated scheduler runs daily at 04:00 UTC — use this to force an early cycle.
        </p>
        <button
          onClick={triggerDistribution}
          disabled={running}
          className="flex items-center gap-2 px-6 py-2.5 bg-cyan text-background text-[10px] tracking-[1px] uppercase font-mono rounded-md hover:opacity-80 transition-opacity disabled:opacity-50"
        >
          {running ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          {running ? "Running..." : "Run Distribution Now"}
        </button>

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
                  <p className="text-cyan">{runResult.lp_injection.tx_hash}</p>
                )}
                {runResult.lp_injection?.error && (
                  <p className="text-pulse-red">LP Error: {runResult.lp_injection.error}</p>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* LP Events */}
      <div className="bg-card border border-border rounded-md overflow-hidden relative card-gradient-top">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h2 className="font-display font-bold text-sm tracking-[2px] uppercase text-foreground">Recent LP Events</h2>
          <button onClick={fetchEvents} className="text-muted-foreground hover:text-cyan transition-colors">
            <RefreshCw className={`w-3.5 h-3.5 ${loadingEvents ? "animate-spin" : ""}`} />
          </button>
        </div>
        {loadingEvents ? (
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
                      {e.tx_hash ? e.tx_hash.slice(0, 8) + "..." : "—"}
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
