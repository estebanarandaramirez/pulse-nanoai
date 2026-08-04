import { useState, useEffect } from "react";
import { useAuth } from "@/lib/AuthContext";
import { base44 } from "@/api/base44Client";
import { ShieldAlert, RefreshCw, DollarSign, Coins, Droplets, TrendingUp, Wallet, Zap, Activity } from "lucide-react";
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
  const [claims, setClaims] = useState([]);
  const [loadingBal, setLoadingBal] = useState(true);
  const [loadingClaims, setLoadingClaims] = useState(true);

  const fetchBalances = async () => {
    setLoadingBal(true);
    try {
      const r = await base44.functions.invoke("getTreasuryBalances", {});
      setBalances(r.data);
    } catch {}
    setLoadingBal(false);
  };

  const fetchClaims = async () => {
    setLoadingClaims(true);
    const c = await base44.entities.ClaimEvent.list("-created_date", 20).catch(() => []);
    setClaims(c || []);
    setLoadingClaims(false);
  };

  useEffect(() => {
    fetchBalances();
    fetchClaims();
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

  const fmt = (n, decimals = 4) =>
    n == null ? null : Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: decimals });

  const totalPLSClaimed = claims.filter(c => c.status === "confirmed").reduce((s, c) => s + (c.amount_pls || 0), 0);

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
          onClick={() => { fetchBalances(); fetchClaims(); }}
          className="text-muted-foreground hover:text-cyan transition-colors"
          title="Refresh"
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
          <div className="bg-card border border-amber/30 text-amber rounded-md p-4 relative card-gradient-top">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[9px] tracking-[2px] uppercase font-mono text-muted-foreground">OctaSpace (OCTA)</span>
              <TrendingUp className="w-3.5 h-3.5 text-amber" />
            </div>
            <div className="text-xl font-display font-bold tracking-tight text-amber">
              {loadingBal ? "..." : octa?.balance_octa != null
                ? `${fmt(octa.balance_octa, 4)} OCTA`
                : (octa?.note ? "Not configured" : "Error")}
            </div>
            <div className="mt-1 text-[9px] font-mono text-muted-foreground truncate">
              {octa?.balance_octa != null ? `≈ $${fmt(octa.balance_usd, 2)} USD @ $${octa?.octa_price_usd}/OCTA` : octa?.note ?? ""}
            </div>
            {/* Debug: show scraper log when balance is 0 */}
            {!loadingBal && octa?._debug && (octa.balance_octa === 0 || octa.balance_octa == null) && (
              <details className="mt-2">
                <summary className="text-[9px] font-mono text-amber/60 cursor-pointer hover:text-amber">debug log</summary>
                <div className="mt-1 space-y-0.5 max-h-48 overflow-y-auto">
                  {(octa._debug.log ?? []).map((s, i) => (
                    <p key={i} className="text-[8px] font-mono text-muted-foreground/70 break-all">{s}</p>
                  ))}
                </div>
              </details>
            )}
          </div>
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

      {/* Payout stats */}
      <div className="grid grid-cols-2 gap-3">
        <BalanceCard
          label="PULSE Claimed (Confirmed)"
          value={loadingClaims ? "..." : `${(totalPLSClaimed / 1000).toFixed(1)}k PULSE`}
          sub={`${claims.filter(c => c.status === "confirmed").length} confirmed transactions`}
          color="cyan"
          icon={Coins}
        />
        <BalanceCard
          label="Total Claim Events"
          value={loadingClaims ? "..." : claims.length.toString()}
          sub="All-time across all users"
          color="purple"
          icon={Activity}
        />
      </div>

      {/* Recent Claim Events */}
      <div className="bg-card border border-border rounded-md overflow-hidden relative card-gradient-top">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <span className="font-display font-bold text-sm tracking-[2px] uppercase text-foreground">Recent Claim Events</span>
          <button onClick={fetchClaims} className="text-muted-foreground hover:text-cyan transition-colors">
            <RefreshCw className={`w-3.5 h-3.5 ${loadingClaims ? "animate-spin" : ""}`} />
          </button>
        </div>
        {loadingClaims ? (
          <div className="p-6 text-center text-[10px] text-muted-foreground font-mono">Loading...</div>
        ) : claims.length === 0 ? (
          <div className="p-6 text-center text-[10px] text-muted-foreground font-mono">No claim events yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  {["User", "Amount PLS", "TX Hash", "Status", "Date"].map(h => (
                    <th key={h} className="px-4 py-2 text-[9px] tracking-[1.5px] uppercase text-muted-foreground text-left font-normal">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {claims.map(c => (
                  <tr key={c.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">{c.user_email || "—"}</td>
                    <td className="px-4 py-2.5 text-[11px] font-mono text-cyan">{c.amount_pls?.toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground max-w-xs truncate">{c.tx_hash || "—"}</td>
                    <td className="px-4 py-2.5"><StatusTag status={c.status} /></td>
                    <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">
                      {c.created_date ? format(new Date(c.created_date), "MMM d, HH:mm") : "—"}
                    </td>
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
