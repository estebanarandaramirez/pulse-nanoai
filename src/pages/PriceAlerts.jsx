import { useState, useEffect } from "react";
import { Plus } from "lucide-react";
import { base44 } from "@/api/base44Client";
import AlertCard from "../components/shared/AlertCard";
import CreateAlertModal from "../components/shared/CreateAlertModal";
import SectionTitle from "../components/shared/SectionTitle";

const MOCK_ALERTS = [
  { id: "1", label: "RTX 4090 Cheap", platform: "Vast.ai", gpu_model: "RTX 4090", alert_type: "below", threshold: 0.800, status: "active" },
  { id: "2", label: "H100 Price Spike", platform: "RunPod", gpu_model: "H100", alert_type: "above", threshold: 3.500, status: "triggered" },
  { id: "3", label: "Any 3090 Alert", platform: "Any", gpu_model: "RTX 3090", alert_type: "below", threshold: 0.280, status: "paused" },
];

export default function PriceAlerts() {
  const [alerts, setAlerts] = useState(MOCK_ALERTS);
  const [showCreate, setShowCreate] = useState(false);

  const load = async () => {
    const data = await base44.entities.PriceAlert.list("-created_date");
    if (data?.length) setAlerts(data);
  };

  useEffect(() => { load(); }, []);

  const active = alerts.filter(a => a.status === "active").length;
  const triggered = alerts.filter(a => a.status === "triggered").length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-neon-green animate-pulse-glow" />
          <h1 className="font-display font-bold text-xl tracking-[3px] uppercase text-foreground">Price Alerts</h1>
        </div>
        <button onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 bg-cyan text-background text-[10px] tracking-[1px] uppercase font-mono rounded-md hover:opacity-80 transition-opacity">
          <Plus className="w-3.5 h-3.5" /> New Alert
        </button>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Total Alerts", value: alerts.length, color: "text-foreground" },
          { label: "Active", value: active, color: "text-neon-green" },
          { label: "Triggered", value: triggered, color: "text-amber" },
        ].map(s => (
          <div key={s.label} className="bg-card border border-border rounded-md p-3 text-center">
            <div className={`text-2xl font-display font-bold ${s.color}`}>{s.value}</div>
            <div className="text-[9px] tracking-[2px] uppercase text-muted-foreground mt-1">{s.label}</div>
          </div>
        ))}
      </div>

      <div>
        <SectionTitle>Your Alerts</SectionTitle>
        <div className="mt-3 space-y-2">
          {alerts.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-[10px] font-mono border border-dashed border-border rounded-md">
              No alerts yet. Create your first price alert.
            </div>
          ) : (
            alerts.map(a => <AlertCard key={a.id} alert={a} onRefresh={load} />)
          )}
        </div>
      </div>

      {showCreate && <CreateAlertModal onClose={() => setShowCreate(false)} onCreated={load} />}
    </div>
  );
}