import { useState, useEffect } from "react";
import { Plus } from "lucide-react";
import { base44 } from "@/api/base44Client";
import AutoRentConfigCard from "../components/shared/AutoRentConfigCard";
import CreateAutoRentModal from "../components/shared/CreateAutoRentModal";
import SectionTitle from "../components/shared/SectionTitle";

const MOCK_CONFIGS = [
  { id: "1", label: "Cheap 4090 Watcher", platform: "Vast.ai", gpu_model: "RTX 4090", max_price_hr: 0.800, duration_hours: 12, status: "active" },
  { id: "2", label: "H100 Research Run", platform: "RunPod", gpu_model: "H100", max_price_hr: 3.000, duration_hours: 6, status: "rented", last_rented_at: new Date(Date.now() - 7200000).toISOString() },
  { id: "3", label: "Any 3090 Anytime", platform: "Any", gpu_model: "RTX 3090", max_price_hr: 0.300, duration_hours: 24, status: "paused" },
];

export default function AutoRent() {
  const [configs, setConfigs] = useState(MOCK_CONFIGS);
  const [showCreate, setShowCreate] = useState(false);

  const load = async () => {
    const data = await base44.entities.AutoRentConfig.list("-created_date");
    if (data?.length) setConfigs(data);
  };

  useEffect(() => { load(); }, []);

  const active = configs.filter(c => c.status === "active").length;
  const rented = configs.filter(c => c.status === "rented").length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-neon-green animate-pulse-glow" />
          <h1 className="font-display font-bold text-xl tracking-[3px] uppercase text-foreground">Auto-Rent</h1>
        </div>
        <button onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 bg-cyan text-background text-[10px] tracking-[1px] uppercase font-mono rounded-md hover:opacity-80 transition-opacity">
          <Plus className="w-3.5 h-3.5" /> New Config
        </button>
      </div>

      <div className="px-4 py-3 bg-cyan/5 border border-cyan/20 rounded-md text-[10px] font-mono text-muted-foreground">
        Auto-Rent watches the markets and automatically rents compute when prices drop below your set threshold.
        <span className="text-cyan"> Each rental credits your PLS vest.</span>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Watching", value: active, color: "text-neon-green" },
          { label: "Currently Rented", value: rented, color: "text-cyan" },
          { label: "Total Configs", value: configs.length, color: "text-foreground" },
        ].map(s => (
          <div key={s.label} className="bg-card border border-border rounded-md p-3 text-center">
            <div className={`text-2xl font-display font-bold ${s.color}`}>{s.value}</div>
            <div className="text-[9px] tracking-[2px] uppercase text-muted-foreground mt-1">{s.label}</div>
          </div>
        ))}
      </div>

      <div>
        <SectionTitle>Configurations</SectionTitle>
        <div className="mt-3 space-y-2">
          {configs.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-[10px] font-mono border border-dashed border-border rounded-md">
              No auto-rent configs yet.
            </div>
          ) : (
            configs.map(c => <AutoRentConfigCard key={c.id} config={c} onRefresh={load} />)
          )}
        </div>
      </div>

      {showCreate && <CreateAutoRentModal onClose={() => setShowCreate(false)} onCreated={load} />}
    </div>
  );
}