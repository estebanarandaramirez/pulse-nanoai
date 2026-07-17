import { useState, useEffect, useMemo } from "react";
import { ExternalLink, Coins, TrendingUp, Zap, Clock } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import StatCard from "../components/shared/StatCard";
import StatusTag from "../components/shared/StatusTag";
import { format, formatDistanceToNow } from "date-fns";

function timeUntilNextPayout() {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(4, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const diffMs = next - now;
  const h = Math.floor(diffMs / 3600000);
  const m = Math.floor((diffMs % 3600000) / 60000);
  return `${h}h ${m}m`;
}

export default function Wallet() {
  const { user } = useAuth();
  const [claims, setClaims] = useState([]);
  const [earningsLogs, setEarningsLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [countdown, setCountdown] = useState(timeUntilNextPayout());

  useEffect(() => {
    const id = setInterval(() => setCountdown(timeUntilNextPayout()), 60000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!user?.email) { setLoading(false); return; }
    Promise.all([
      base44.entities.ClaimEvent
        .filter({ user_email: user.email }, "-created_date", 100)
        .catch(() => []),
      base44.entities.EarningsLog
        .filter({ user_email: user.email }, "-date", 365)
        .catch(() => []),
    ]).then(([c, e]) => {
      setClaims((c || []).filter(ev => ev.amount_pls > 0));
      setEarningsLogs(e || []);
      setLoading(false);
    });
  }, [user?.email]);

  const totalEarned = useMemo(
    () => claims.reduce((s, c) => s + (c.amount_pls || 0), 0),
    [claims]
  );

  const lastClaim = claims[0];

  const pendingUsd = useMemo(() => {
    const since = lastClaim?.created_date ? new Date(lastClaim.created_date) : new Date(0);
    return earningsLogs
      .filter(e => new Date(e.date) > since)
      .reduce((s, e) => s + (parseFloat(e.total_usd) || 0), 0);
  }, [earningsLogs, lastClaim]);

  const estimatedNextPulse = (pendingUsd * 0.60) / 0.01;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <span className="w-2 h-2 rounded-full bg-neon-green animate-pulse-glow" />
        <h1 className="font-display font-bold text-xl tracking-[3px] uppercase text-foreground">Payouts</h1>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Next Payout"
          value={loading ? "..." : countdown}
          sub="Daily · 04:00 UTC"
          color="primary"
          icon={Clock}
        />
        <StatCard
          label="Est. Next Cycle"
          value={loading ? "..." : `${Math.floor(estimatedNextPulse).toLocaleString()} PULSE`}
          sub={`$${(pendingUsd * 0.60).toFixed(2)} pending`}
          color="accent"
          icon={TrendingUp}
        />
        <StatCard
          label="Last Payout"
          value={loading ? "..." : lastClaim ? `${lastClaim.amount_pls.toLocaleString()} PULSE` : "—"}
          sub={lastClaim?.created_date
            ? formatDistanceToNow(new Date(lastClaim.created_date), { addSuffix: true })
            : "No payouts yet"}
          color="amber"
          icon={Zap}
        />
        <StatCard
          label="Total Earned"
          value={loading ? "..." : `${Math.floor(totalEarned).toLocaleString()} PULSE`}
          sub={`$${(totalEarned * 0.01).toFixed(2)} at $0.01`}
          color="purple"
          icon={Coins}
        />
      </div>

      <div className="bg-card border border-border rounded-md overflow-hidden relative card-gradient-top">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="font-display font-bold text-sm tracking-[2px] uppercase text-foreground">Payout History</h2>
        </div>
        {loading ? (
          <div className="p-8 text-center text-[10px] font-mono text-muted-foreground">Loading...</div>
        ) : claims.length === 0 ? (
          <div className="p-8 text-center text-[10px] font-mono text-muted-foreground">
            No payouts yet — PULSE will appear here after the next daily distribution at 04:00 UTC.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  {["Date", "PULSE", "TX Hash", "Status"].map(h => (
                    <th key={h} className="px-4 py-2 text-[9px] tracking-[1.5px] uppercase text-muted-foreground text-left font-normal">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {claims.map(c => (
                  <tr key={c.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">
                      {c.created_date ? format(new Date(c.created_date), "MMM d, yyyy HH:mm") : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-[11px] font-mono text-cyan">
                      {c.amount_pls.toLocaleString()} PULSE
                    </td>
                    <td className="px-4 py-2.5">
                      {c.tx_hash ? (
                        <a
                          href={`https://explorer.solana.com/tx/${c.tx_hash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[10px] font-mono text-muted-foreground hover:text-cyan transition-colors flex items-center gap-1"
                        >
                          {c.tx_hash.slice(0, 12)}... <ExternalLink className="w-3 h-3" />
                        </a>
                      ) : (
                        <span className="text-[10px] font-mono text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusTag status={c.status} />
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
