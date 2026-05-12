import { useState, useEffect } from "react";
import { RefreshCw, Search } from "lucide-react";
import { base44 } from "@/api/base44Client";
import StatCard from "../components/shared/StatCard";
import StatusTag from "../components/shared/StatusTag";
import { Activity, DollarSign, Cpu } from "lucide-react";

const STATUS_FILTER = ["all", "active", "idle", "offline", "maintenance"];

export default function GPUFleet() {
  const [gpus, setGpus] = useState([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await base44.functions.invoke('getGPUFleet', {});
      if (res.data.error) setError(res.data.error);
      else setGpus(res.data.gpus || []);
    } catch (e) {
      setError(`Error: ${e.message}`);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const filtered = gpus.filter(g =>
    (statusFilter === "all" || g.status === statusFilter) &&
    ((g.gpu_id ?? "").toLowerCase().includes(search.toLowerCase()) ||
     (g.model ?? "").toLowerCase().includes(search.toLowerCase()) ||
     (g.user_email ?? "").toLowerCase().includes(search.toLowerCase()))
  );

  const active = gpus.filter(g => g.status === "active").length;
  const totalEarned = gpus.reduce((s, g) => s + (g.total_earned_usd || 0), 0);
  const avgUptime = gpus.length
    ? (gpus.reduce((s, g) => s + (g.uptime_percent || 0), 0) / gpus.length).toFixed(1)
    : 0;

  const heartbeatAge = (ts) => {
    if (!ts) return "never";
    const mins = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
    if (mins < 2) return "just now";
    if (mins < 60) return `${mins}m ago`;
    return `${Math.round(mins / 60)}h ago`;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-neon-green animate-pulse-glow" />
          <h1 className="font-display font-bold text-xl tracking-[3px] uppercase text-foreground">GPU Fleet</h1>

        </div>
        <button onClick={load} disabled={loading}
          className="p-1.5 border border-border rounded-md text-muted-foreground hover:text-cyan hover:border-cyan/50 transition-colors">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {error && (
        <div className="px-4 py-3 bg-pulse-red/10 border border-pulse-red/40 rounded-md text-[10px] font-mono text-pulse-red">{error}</div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StatCard label="Active / Total" value={`${active} / ${gpus.length}`} color="accent" icon={Activity} />
        <StatCard label="Total Earned" value={`$${totalEarned.toFixed(2)}`} color="primary" icon={DollarSign} />
        <StatCard label="Avg Uptime" value={`${avgUptime}%`} color="amber" icon={Cpu} />
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search GPU, model, or email..."
            className="w-full bg-input border border-border rounded-md pl-9 pr-3 py-2 text-[11px] font-mono focus:border-primary/50 outline-none" />
        </div>
        <div className="flex gap-1 flex-wrap">
          {STATUS_FILTER.map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-md text-[9px] tracking-[1px] uppercase font-mono transition-colors
                ${statusFilter === s ? "bg-cyan/20 text-cyan border border-cyan/40" : "bg-card border border-border text-muted-foreground hover:text-foreground"}`}>
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-card border border-border rounded-md overflow-hidden relative card-gradient-top">
        {loading ? (
          <div className="p-8 text-center text-[10px] font-mono text-muted-foreground">Loading fleet...</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-[10px] font-mono text-muted-foreground">
            {gpus.length === 0 ? "No GPUs registered yet. Run the installer on a machine to get started." : "No GPUs match the current filter."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  {["GPU ID", "Model", "Status", "Rate/hr", "Uptime", "Platform", "Heartbeat", "Earned"].map(h => (
                    <th key={h} className="px-4 py-2 text-[9px] tracking-[1.5px] uppercase text-muted-foreground text-left font-normal">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(g => (
                  <tr key={g.gpu_id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">{g.gpu_id}</td>
                    <td className="px-4 py-2.5 text-[11px] font-mono text-foreground">{g.model}</td>
                    <td className="px-4 py-2.5"><StatusTag status={g.status} /></td>
                    <td className="px-4 py-2.5 text-[11px] font-mono text-cyan">${(g.rate_per_hour || 0).toFixed(3)}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="h-1 w-14 bg-muted rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{
                            width: `${g.uptime_percent || 0}%`,
                            background: (g.uptime_percent || 0) > 90 ? "var(--neon-green)" : (g.uptime_percent || 0) > 70 ? "var(--amber)" : "var(--pulse-red)"
                          }} />
                        </div>
                        <span className="text-[10px] font-mono text-muted-foreground">{g.uptime_percent || 0}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">{g.active_platform || "—"}</td>
                    <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">{heartbeatAge(g.last_heartbeat)}</td>
                    <td className="px-4 py-2.5 text-[11px] font-mono text-neon-green">${(g.total_earned_usd || 0).toFixed(2)}</td>
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