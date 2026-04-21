import { useState, useEffect } from "react";
import { Trophy, RefreshCw, Cpu } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";

const MEDAL = { 1: "🥇", 2: "🥈", 3: "🥉" };

function maskEmail(email) {
  if (!email) return "Anonymous";
  const [local, domain] = email.split("@");
  if (!local || !domain) return email;
  return `${local.slice(0, 2)}${"*".repeat(Math.max(2, local.length - 2))}@${domain}`;
}

// Build per-user aggregates from a flat list of GPU records
function buildRankings(gpus) {
  const byUser = {};
  for (const gpu of gpus) {
    const key = gpu.user_email ?? "unknown";
    if (!byUser[key]) {
      byUser[key] = {
        user_email: key,
        total_earned_usd: 0,
        daily_earned_usd: 0,
        gpu_models: [],
        gpu_count: 0,
      };
    }
    byUser[key].total_earned_usd += gpu.total_earned_usd ?? 0;
    byUser[key].daily_earned_usd += gpu.daily_earned_usd ?? 0;
    if (gpu.model && !byUser[key].gpu_models.includes(gpu.model)) {
      byUser[key].gpu_models.push(gpu.model);
    }
    byUser[key].gpu_count += 1;
  }

  return Object.values(byUser)
    .sort((a, b) => b.total_earned_usd - a.total_earned_usd)
    .map((u, i) => ({ ...u, rank: i + 1 }));
}

export default function Leaderboard() {
  const { user } = useAuth();
  const [rankings, setRankings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("total"); // "total" | "daily"

  const load = async () => {
    setLoading(true);
    try {
      // Fetch all GPU records — enough to build cross-user rankings
      const gpus = await base44.entities.GPU.list("-total_earned_usd", 500);
      if (gpus && gpus.length > 0) {
        setRankings(buildRankings(gpus));
      }
    } catch {
      // Stay with whatever we have
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const sorted =
    tab === "daily"
      ? [...rankings].sort((a, b) => b.daily_earned_usd - a.daily_earned_usd).map((r, i) => ({ ...r, rank: i + 1 }))
      : rankings;

  const myEntry = sorted.find(r => r.user_email === user?.email);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Trophy className="w-5 h-5 text-amber" />
          <h1 className="font-display font-bold text-xl tracking-[3px] uppercase text-foreground">
            Leaderboard
          </h1>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="text-muted-foreground hover:text-cyan transition-colors"
          title="Refresh"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-2">
        {[
          { key: "total", label: "Total Earnings" },
          { key: "daily", label: "Daily Earnings" },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-1.5 rounded-md text-[9px] tracking-[1.5px] uppercase font-mono transition-colors
              ${tab === t.key
                ? "bg-cyan/20 text-cyan border border-cyan/40"
                : "bg-card border border-border text-muted-foreground hover:text-foreground"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Your rank callout */}
      {myEntry && (
        <div className="flex items-center gap-4 px-4 py-3 bg-cyan/10 border border-cyan/30 rounded-md glow-cyan">
          <span className="text-2xl font-display font-extrabold text-cyan">#{myEntry.rank}</span>
          <div>
            <div className="text-[10px] font-mono text-cyan font-semibold">Your rank on the network</div>
            <div className="text-[9px] font-mono text-muted-foreground">
              {tab === "daily"
                ? `$${myEntry.daily_earned_usd.toFixed(2)} earned today`
                : `$${myEntry.total_earned_usd.toFixed(2)} total earned`}
              {" · "}
              {myEntry.gpu_count} GPU{myEntry.gpu_count !== 1 ? "s" : ""}
            </div>
          </div>
        </div>
      )}

      {/* Rankings table */}
      <div className="bg-card border border-border rounded-md overflow-hidden relative card-gradient-top">
        <div className="px-4 py-3 border-b border-border">
          <span className="text-[9px] tracking-[2px] uppercase text-muted-foreground font-mono">
            {sorted.length} participants
          </span>
        </div>

        {loading && sorted.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-6 h-6 border-2 border-cyan border-t-transparent rounded-full animate-spin" />
          </div>
        ) : sorted.length === 0 ? (
          <div className="py-16 text-center text-[11px] font-mono text-muted-foreground">
            No earnings recorded yet. Connect a GPU to get on the board.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full table-fixed">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-4 py-2 text-[9px] tracking-[1.5px] uppercase text-muted-foreground text-left font-normal w-16">Rank</th>
                  <th className="px-4 py-2 text-[9px] tracking-[1.5px] uppercase text-muted-foreground text-left font-normal">User</th>
                  <th className="px-4 py-2 text-[9px] tracking-[1.5px] uppercase text-muted-foreground text-left font-normal w-16">GPUs</th>
                  <th className="px-4 py-2 text-[9px] tracking-[1.5px] uppercase text-muted-foreground text-left font-normal w-32">{tab === "daily" ? "Today" : "Total Earned"}</th>
                </tr>
              </thead>
              <tbody>
                {sorted.slice(0, 100).map(entry => {
                  const isMe = entry.user_email === user?.email;
                  const value = tab === "daily" ? entry.daily_earned_usd : entry.total_earned_usd;
                  return (
                    <tr
                      key={entry.user_email}
                      className={`border-b border-border/50 transition-colors
                        ${isMe
                          ? "bg-cyan/5 border-l-2 border-l-cyan"
                          : "hover:bg-muted/20"}`}
                    >
                      {/* Rank */}
                      <td className="px-4 py-3">
                        {MEDAL[entry.rank] ? (
                          <span className="text-base">{MEDAL[entry.rank]}</span>
                        ) : (
                          <span className={`text-[11px] font-mono font-bold ${isMe ? "text-cyan" : "text-muted-foreground"}`}>
                            #{entry.rank}
                          </span>
                        )}
                      </td>

                      {/* User */}
                      <td className="px-4 py-3">
                        <div className={`text-[11px] font-mono ${isMe ? "text-cyan font-semibold" : "text-foreground"}`}>
                          {isMe ? "You" : maskEmail(entry.user_email)}
                        </div>
                        {entry.gpu_models.length > 0 && (
                          <div className="flex items-center gap-1 mt-0.5">
                            <Cpu className="w-2.5 h-2.5 text-muted-foreground" />
                            <span className="text-[9px] font-mono text-muted-foreground">
                              {entry.gpu_models.slice(0, 2).join(", ")}
                              {entry.gpu_models.length > 2 ? ` +${entry.gpu_models.length - 2}` : ""}
                            </span>
                          </div>
                        )}
                      </td>

                      {/* GPU count */}
                      <td className="px-4 py-3 text-[11px] font-mono text-muted-foreground">
                        {entry.gpu_count}
                      </td>

                      {/* Earnings */}
                      <td className="px-4 py-3">
                        <span className={`text-[13px] font-mono font-bold ${isMe ? "text-cyan" : value > 0 ? "text-neon-green" : "text-muted-foreground"}`}>
                          ${value.toFixed(2)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!myEntry && !loading && (
        <div className="text-center py-4">
          <p className="text-[10px] font-mono text-muted-foreground">
            You're not on the board yet.{" "}
            <a href="/connect" className="text-cyan hover:underline">Connect a GPU</a> to start earning.
          </p>
        </div>
      )}
    </div>
  );
}
