import { useState, useEffect } from "react";
import { Thermometer, Zap, Activity, AlertTriangle, RefreshCw } from "lucide-react";
import StatusTag from "../components/shared/StatusTag";
import StatCard from "../components/shared/StatCard";

const MOCK_HEALTH = [
  { gpu_id: "GPU-4090-001", model: "RTX 4090", temp_c: 72, power_w: 380, mem_used_pct: 88, status: "active", alert: null },
  { gpu_id: "GPU-3090-002", model: "RTX 3090", temp_c: 85, power_w: 340, mem_used_pct: 94, status: "active", alert: "High temperature" },
  { gpu_id: "GPU-3080-003", model: "RTX 3080", temp_c: 45, power_w: 0, mem_used_pct: 0, status: "idle", alert: null },
  { gpu_id: "GPU-3070-004", model: "RTX 3070", temp_c: 68, power_w: 210, mem_used_pct: 76, status: "active", alert: null },
  { gpu_id: "GPU-3060-005", model: "RTX 3060", temp_c: 30, power_w: 0, mem_used_pct: 0, status: "maintenance", alert: "Fan failure" },
  { gpu_id: "GPU-4090-006", model: "RTX 4090", temp_c: 78, power_w: 390, mem_used_pct: 92, status: "active", alert: null },
  { gpu_id: "GPU-3090-007", model: "RTX 3090", temp_c: 0, power_w: 0, mem_used_pct: 0, status: "offline", alert: "No heartbeat" },
];

function TempBar({ val }) {
  const pct = Math.min(100, (val / 100) * 100);
  const color = val > 85 ? "var(--pulse-red)" : val > 70 ? "var(--amber)" : "var(--neon-green)";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 bg-muted rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="text-[10px] font-mono" style={{ color }}>{val}°C</span>
    </div>
  );
}

function MemBar({ val }) {
  const color = val > 90 ? "var(--pulse-red)" : val > 75 ? "var(--amber)" : "var(--cyan)";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 bg-muted rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${val}%`, background: color }} />
      </div>
      <span className="text-[10px] font-mono" style={{ color }}>{val}%</span>
    </div>
  );
}

export default function GPUHealth() {
  const [health, setHealth] = useState(MOCK_HEALTH);
  const [loading, setLoading] = useState(false);

  const refresh = () => {
    setLoading(true);
    setTimeout(() => {
      setHealth(MOCK_HEALTH.map(g => ({
        ...g,
        temp_c: g.status === "active" ? Math.max(50, g.temp_c + Math.round((Math.random() - 0.5) * 4)) : g.temp_c,
        power_w: g.status === "active" ? Math.max(100, g.power_w + Math.round((Math.random() - 0.5) * 20)) : g.power_w,
      })));
      setLoading(false);
    }, 800);
  };

  const alerts = health.filter(g => g.alert);
  const avgTemp = (health.filter(g => g.temp_c > 0).reduce((s, g) => s + g.temp_c, 0) / health.filter(g => g.temp_c > 0).length || 0).toFixed(0);
  const totalPower = health.reduce((s, g) => s + (g.power_w || 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-neon-green animate-pulse-glow" />
          <h1 className="font-display font-bold text-xl tracking-[3px] uppercase text-foreground">GPU Health</h1>
        </div>
        <button onClick={refresh} disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 border border-cyan/40 text-cyan text-[9px] tracking-[1.5px] uppercase font-mono rounded-md hover:border-cyan transition-colors">
          <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StatCard label="Avg Temp" value={`${avgTemp}°C`} color={parseInt(avgTemp) > 80 ? "amber" : "accent"} icon={Thermometer} />
        <StatCard label="Total Power Draw" value={`${totalPower}W`} color="primary" icon={Zap} />
        <StatCard label="Active Alerts" value={alerts.length.toString()} color={alerts.length > 0 ? "amber" : "accent"} icon={AlertTriangle} />
      </div>

      {alerts.length > 0 && (
        <div className="space-y-2">
          {alerts.map(g => (
            <div key={g.gpu_id} className="flex items-center gap-3 px-4 py-3 bg-amber/10 border border-amber/30 rounded-md">
              <AlertTriangle className="w-4 h-4 text-amber flex-shrink-0" />
              <div className="text-[10px] font-mono text-amber">
                <span className="font-medium">{g.model}</span> ({g.gpu_id}) — {g.alert}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="bg-card border border-border rounded-md overflow-hidden relative card-gradient-top">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                {["GPU ID", "Model", "Status", "Temperature", "Power", "Memory Usage", "Alert"].map(h => (
                  <th key={h} className="px-4 py-2 text-[9px] tracking-[1.5px] uppercase text-muted-foreground text-left font-normal">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {health.map(g => (
                <tr key={g.gpu_id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">{g.gpu_id}</td>
                  <td className="px-4 py-2.5 text-[11px] font-mono text-foreground">{g.model}</td>
                  <td className="px-4 py-2.5"><StatusTag status={g.status} /></td>
                  <td className="px-4 py-2.5"><TempBar val={g.temp_c} /></td>
                  <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">{g.power_w}W</td>
                  <td className="px-4 py-2.5"><MemBar val={g.mem_used_pct} /></td>
                  <td className="px-4 py-2.5">
                    {g.alert
                      ? <span className="text-[9px] font-mono text-amber">{g.alert}</span>
                      : <span className="text-[9px] font-mono text-muted-foreground">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}