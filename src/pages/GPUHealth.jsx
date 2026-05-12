import { useState, useEffect } from "react";
import { Activity, AlertTriangle, RefreshCw, Clock } from "lucide-react";
import StatusTag from "../components/shared/StatusTag";
import StatCard from "../components/shared/StatCard";
import { supabase } from "@/api/supabaseClient";

function HeartbeatAge({ ts }) {
  if (!ts) return <span className="text-[10px] font-mono text-pulse-red">Never</span>;
  const mins = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  const label = mins < 2 ? "Just now" : mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
  const color = mins < 5 ? "text-neon-green" : mins < 30 ? "text-amber" : "text-pulse-red";
  return <span className={`text-[10px] font-mono ${color}`}>{label}</span>;
}

function UptimeBar({ val }) {
  const color = (val || 0) > 90 ? "var(--neon-green)" : (val || 0) > 70 ? "var(--amber)" : "var(--pulse-red)";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 bg-muted rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${val || 0}%`, background: color }} />
      </div>
      <span className="text-[10px] font-mono" style={{ color }}>{val || 0}%</span>
    </div>
  );
}

export default function GPUHealth() {
  const [gpus, setGpus] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      if (!supabase) { setError("Supabase client not initialized — check VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY"); setLoading(false); return; }
      const { data, err } = await supabase
        .from('gpus')
        .select('gpu_id, model, status, uptime_percent, last_heartbeat, active_platform, user_email, rate_per_hour')
        .order('last_heartbeat', { ascending: false });
      if (err) setError(`Supabase error: ${err.message}`);
      else setGpus(data || []);
    } catch (e) {
      setError(`Unexpected error: ${e.message}`);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const staleGpus = gpus.filter(g => {
    if (!g.last_heartbeat) return true;
    const mins = (Date.now() - new Date(g.last_heartbeat).getTime()) / 60000;
    return mins > 10;
  });
  const activeGpus = gpus.filter(g => g.status === "active");
  const avgUptime = gpus.length
    ? (gpus.reduce((s, g) => s + (g.uptime_percent || 0), 0) / gpus.length).toFixed(0)
    : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-neon-green animate-pulse-glow" />
          <h1 className="font-display font-bold text-xl tracking-[3px] uppercase text-foreground">GPU Health</h1>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 border border-cyan/40 text-cyan text-[9px] tracking-[1.5px] uppercase font-mono rounded-md hover:border-cyan transition-colors">
          <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {error && (
        <div className="px-4 py-3 bg-pulse-red/10 border border-pulse-red/40 rounded-md text-[10px] font-mono text-pulse-red">{error}</div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StatCard label="Active GPUs" value={`${activeGpus.length} / ${gpus.length}`} color="accent" icon={Activity} />
        <StatCard label="Avg Uptime" value={`${avgUptime}%`} color={parseInt(avgUptime) > 80 ? "accent" : "amber"} icon={Clock} />
        <StatCard label="Stale Heartbeat" value={staleGpus.length.toString()} color={staleGpus.length > 0 ? "amber" : "accent"} icon={AlertTriangle} />
      </div>

      {staleGpus.length > 0 && (
        <div className="space-y-2">
          {staleGpus.map(g => {
            const mins = g.last_heartbeat ? Math.round((Date.now() - new Date(g.last_heartbeat).getTime()) / 60000) : null;
            return (
              <div key={g.gpu_id} className="flex items-center gap-3 px-4 py-3 bg-amber/10 border border-amber/30 rounded-md">
                <AlertTriangle className="w-4 h-4 text-amber flex-shrink-0" />
                <div className="text-[10px] font-mono text-amber">
                  <span className="font-medium">{g.model}</span> ({g.gpu_id}) —{" "}
                  {mins === null ? "No heartbeat recorded" : `Last heartbeat ${mins}m ago`}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="bg-card border border-border rounded-md overflow-hidden relative card-gradient-top">
        {loading ? (
          <div className="p-8 text-center text-[10px] font-mono text-muted-foreground">Loading...</div>
        ) : gpus.length === 0 ? (
          <div className="p-8 text-center text-[10px] font-mono text-muted-foreground">
            No GPUs registered yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  {["GPU ID", "Model", "Status", "Uptime", "Last Heartbeat", "Platform"].map(h => (
                    <th key={h} className="px-4 py-2 text-[9px] tracking-[1.5px] uppercase text-muted-foreground text-left font-normal">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {gpus.map(g => (
                  <tr key={g.gpu_id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">{g.gpu_id}</td>
                    <td className="px-4 py-2.5 text-[11px] font-mono text-foreground">{g.model}</td>
                    <td className="px-4 py-2.5"><StatusTag status={g.status} /></td>
                    <td className="px-4 py-2.5"><UptimeBar val={g.uptime_percent} /></td>
                    <td className="px-4 py-2.5"><HeartbeatAge ts={g.last_heartbeat} /></td>
                    <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">{g.active_platform || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="px-4 py-3 bg-muted/20 border border-border rounded-md text-[9px] font-mono text-muted-foreground">
        Temperature and power draw data requires the GPU daemon to send telemetry — coming in a future update.
        Heartbeat age is the primary health signal: &gt;10 min = warning, &gt;30 min = auto-marked offline.
      </div>
    </div>
  );
}