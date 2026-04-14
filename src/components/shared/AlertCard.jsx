import { Trash2, Bell, BellOff, TrendingDown, TrendingUp } from "lucide-react";
import { base44 } from "@/api/base44Client";
import StatusTag from "./StatusTag";

export default function AlertCard({ alert, onRefresh }) {
  const toggleStatus = async () => {
    const next = alert.status === "active" ? "paused" : "active";
    await base44.entities.PriceAlert.update(alert.id, { status: next });
    onRefresh();
  };

  const deleteAlert = async () => {
    await base44.entities.PriceAlert.delete(alert.id);
    onRefresh();
  };

  const platformColors = {
    "Vast.ai": "text-cyan border-cyan/30 bg-cyan/10",
    "Clore.ai": "text-neon-green border-neon-green/30 bg-neon-green/10",
    "RunPod": "text-amber border-amber/30 bg-amber/10",
    "OctaSpace": "text-purple border-purple/30 bg-purple/10",
    "Any": "text-muted-foreground border-border bg-muted/30",
  };

  return (
    <div className="bg-card border border-border rounded-md p-4 relative card-gradient-top">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[11px] font-mono text-foreground font-medium">{alert.label}</span>
            <StatusTag status={alert.status} />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-[9px] tracking-[1px] uppercase px-2 py-0.5 rounded border font-mono ${platformColors[alert.platform] || platformColors.Any}`}>
              {alert.platform}
            </span>
            <span className="text-[10px] text-muted-foreground">{alert.gpu_model}</span>
            <span className="flex items-center gap-1 text-[10px] text-foreground">
              {alert.alert_type === "below" ? (
                <TrendingDown className="w-3 h-3 text-neon-green" />
              ) : (
                <TrendingUp className="w-3 h-3 text-pulse-red" />
              )}
              {alert.alert_type} <span className="text-cyan font-mono">${alert.threshold?.toFixed(3)}/hr</span>
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={toggleStatus} className="text-muted-foreground hover:text-cyan transition-colors">
            {alert.status === "active" ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />}
          </button>
          <button onClick={deleteAlert} className="text-muted-foreground hover:text-pulse-red transition-colors">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}