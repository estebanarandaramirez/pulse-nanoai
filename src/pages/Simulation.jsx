import { useState, useEffect } from "react";
import { Play, Save, Trash2, Calculator } from "lucide-react";
import { base44 } from "@/api/base44Client";
import StatCard from "../components/shared/StatCard";
import SectionTitle from "../components/shared/SectionTitle";

const GPU_MODELS = ["RTX 4090", "RTX 4080", "RTX 3090", "RTX 3080", "A100", "H100", "RTX 3070", "RTX 3060"];
const PLATFORMS = ["Vast.ai", "RunPod", "Clore.ai", "OctaSpace"];

const DEFAULT_RATES = {
  "RTX 4090": { "Vast.ai": 0.847, "RunPod": 0.890, "Clore.ai": 0.802, "OctaSpace": 0.780 },
  "RTX 3090": { "Vast.ai": 0.298, "RunPod": 0.310, "Clore.ai": 0.285, "OctaSpace": 0.270 },
  "A100": { "Vast.ai": 1.890, "RunPod": 1.950, "Clore.ai": 1.800, "OctaSpace": 1.750 },
  "H100": { "Vast.ai": 2.800, "RunPod": 2.890, "Clore.ai": 2.750, "OctaSpace": 2.700 },
};

export default function Simulation() {
  const [form, setForm] = useState({
    label: "My Simulation", gpu_model: "RTX 4090", platform: "Vast.ai",
    training_hours: 720, power_cost_per_hr: 0.12, token_rewards_per_hr: 10, token_price_usd: 0.01,
  });
  const [result, setResult] = useState(null);
  const [saved, setSaved] = useState([]);

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  useEffect(() => { loadSaved(); }, []);

  const loadSaved = async () => {
    const data = await base44.entities.RentalSimulation.list("-created_date", 20);
    setSaved(data || []);
  };

  const run = () => {
    const rate = DEFAULT_RATES[form.gpu_model]?.[form.platform] || 0.5;
    const price_per_hr = rate;
    const gross = price_per_hr * form.training_hours;
    const revenue = gross * 0.6;
    const power_cost = form.power_cost_per_hr * form.training_hours;
    const token_val = form.token_rewards_per_hr * form.training_hours * form.token_price_usd;
    const total_revenue = revenue + token_val;
    const net_profit = total_revenue - power_cost;
    const roi_percent = power_cost > 0 ? (net_profit / power_cost) * 100 : 0;
    const break_even_hours = power_cost > 0 ? power_cost / (total_revenue / form.training_hours) : 0;
    setResult({ price_per_hr, gross, revenue, power_cost, token_val, total_revenue, net_profit, roi_percent, break_even_hours });
  };

  const save = async () => {
    if (!result) return;
    const rate = DEFAULT_RATES[form.gpu_model]?.[form.platform] || 0.5;
    await base44.entities.RentalSimulation.create({
      ...form, price_per_hr: rate, expected_revenue_usd: result.revenue,
      total_cost: result.power_cost, total_revenue: result.total_revenue,
      net_profit: result.net_profit, roi_percent: result.roi_percent, break_even_hours: result.break_even_hours,
    });
    loadSaved();
  };

  const del = async (id) => {
    await base44.entities.RentalSimulation.delete(id);
    loadSaved();
  };

  const FIELDS = [
    { label: "Label", key: "label", type: "text" },
    { label: "Training Hours", key: "training_hours", type: "number" },
    { label: "Power Cost $/hr", key: "power_cost_per_hr", type: "number" },
    { label: "Token Rewards / hr", key: "token_rewards_per_hr", type: "number" },
    { label: "Token Price (USD)", key: "token_price_usd", type: "number" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <span className="w-2 h-2 rounded-full bg-neon-green animate-pulse-glow" />
        <h1 className="font-display font-bold text-xl tracking-[3px] uppercase text-foreground">Simulation</h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Input */}
        <div className="bg-card border border-border rounded-md p-5 relative card-gradient-top space-y-4">
          <SectionTitle>Parameters</SectionTitle>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[9px] tracking-[2px] uppercase text-muted-foreground block mb-1">GPU Model</label>
              <select value={form.gpu_model} onChange={e => set("gpu_model", e.target.value)}
                className="w-full bg-input border border-border rounded-md px-3 py-2 text-[11px] font-mono focus:border-primary/50 outline-none">
                {GPU_MODELS.map(g => <option key={g}>{g}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[9px] tracking-[2px] uppercase text-muted-foreground block mb-1">Platform</label>
              <select value={form.platform} onChange={e => set("platform", e.target.value)}
                className="w-full bg-input border border-border rounded-md px-3 py-2 text-[11px] font-mono focus:border-primary/50 outline-none">
                {PLATFORMS.map(p => <option key={p}>{p}</option>)}
              </select>
            </div>
          </div>
          {FIELDS.map(f => (
            <div key={f.key}>
              <label className="text-[9px] tracking-[2px] uppercase text-muted-foreground block mb-1">{f.label}</label>
              <input type={f.type} value={form[f.key]} onChange={e => set(f.key, f.type === "number" ? parseFloat(e.target.value) : e.target.value)}
                className="w-full bg-input border border-border rounded-md px-3 py-2 text-[11px] font-mono focus:border-primary/50 outline-none" />
            </div>
          ))}
          <button onClick={run}
            className="flex items-center gap-2 w-full justify-center py-2.5 bg-cyan text-background text-[10px] tracking-[2px] uppercase font-mono rounded-md hover:opacity-80 transition-opacity">
            <Play className="w-3.5 h-3.5" /> Run Simulation
          </button>
        </div>

        {/* Results */}
        <div className="space-y-4">
          {result ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <StatCard label="Total Revenue" value={`$${result.total_revenue.toFixed(2)}`} color="accent" icon={Calculator} />
                <StatCard label="Net Profit" value={`$${result.net_profit.toFixed(2)}`} color={result.net_profit >= 0 ? "accent" : "amber"} icon={Calculator} />
                <StatCard label="ROI" value={`${result.roi_percent.toFixed(1)}%`} color="primary" icon={Calculator} />
                <StatCard label="Break-even" value={`${result.break_even_hours.toFixed(1)}h`} color="amber" icon={Calculator} />
              </div>
              <div className="bg-card border border-border rounded-md p-4 relative card-gradient-top space-y-2">
                <SectionTitle>Breakdown</SectionTitle>
                {[
                  { label: "Platform Rate", val: `$${result.price_per_hr.toFixed(3)}/hr`, color: "text-foreground" },
                  { label: "Gross Revenue (60%)", val: `$${result.revenue.toFixed(2)}`, color: "text-neon-green" },
                  { label: "Token Rewards", val: `$${result.token_val.toFixed(2)}`, color: "text-purple" },
                  { label: "Power Cost", val: `-$${result.power_cost.toFixed(2)}`, color: "text-pulse-red" },
                ].map(r => (
                  <div key={r.label} className="flex justify-between text-[10px] font-mono py-1 border-b border-border/50">
                    <span className="text-muted-foreground">{r.label}</span>
                    <span className={r.color}>{r.val}</span>
                  </div>
                ))}
              </div>
              <button onClick={save}
                className="flex items-center gap-2 w-full justify-center py-2.5 border border-cyan/40 text-cyan text-[10px] tracking-[2px] uppercase font-mono rounded-md hover:border-cyan transition-colors">
                <Save className="w-3.5 h-3.5" /> Save Simulation
              </button>
            </>
          ) : (
            <div className="h-full flex items-center justify-center text-muted-foreground text-[10px] font-mono border border-dashed border-border rounded-md p-10 text-center">
              Configure parameters and run the simulation to see results
            </div>
          )}
        </div>
      </div>

      {saved.length > 0 && (
        <div>
          <SectionTitle>Saved Simulations</SectionTitle>
          <div className="mt-3 space-y-2">
            {saved.map(s => (
              <div key={s.id} className="bg-card border border-border rounded-md p-3 flex items-center justify-between gap-3">
                <div>
                  <span className="text-[11px] font-mono text-foreground">{s.label}</span>
                  <span className="ml-3 text-[10px] font-mono text-muted-foreground">{s.gpu_model} · {s.platform}</span>
                </div>
                <div className="flex items-center gap-4 text-[10px] font-mono">
                  <span className="text-neon-green">+${s.net_profit?.toFixed(2)}</span>
                  <span className="text-cyan">{s.roi_percent?.toFixed(1)}% ROI</span>
                  <button onClick={() => del(s.id)} className="text-muted-foreground hover:text-pulse-red transition-colors">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}