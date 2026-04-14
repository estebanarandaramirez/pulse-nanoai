import { Trash2, Play, Pause, Clock } from "lucide-react";
import { base44 } from "@/api/base44Client";
import StatusTag from "./StatusTag";
import { format } from "date-fns";

export default function AutoRentConfigCard({ config, onRefresh }) {
  const toggle = async () => {
    const next = config.status === "active" ? "paused" : "active";
    await base44.entities.AutoRentConfig.update(config.id, { status: next });
    onRefresh();
  };

  const del = async () => {
    await base44.entities.AutoRentConfig.delete(config.id);
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
            <span className="text-[11px] font-mono text-foreground font-medium">{config.label}</span>
            <StatusTag status={config.status} />
          </div>
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className={`text-[9px] tracking-[1px] uppercase px-2 py-0.5 rounded border font-mono ${platformColors[config.platform] || platformColors.Any}`}>
              {config.platform}
            </span>
            <span className="text-[10px] text-muted-foreground">{config.gpu_model}</span>
          </div>
          <div className="flex gap-4 text-[9px] text-muted-foreground">
            <span>Max: <span className="text-cyan">${config.max_price_hr?.toFixed(3)}/hr</span></span>
            <span>Duration: <span className="text-foreground">{config.duration_hours}h</span></span>
          </div>
          {config.last_rented_at && (
            <div className="flex items-center gap-1 text-[9px] text-muted-foreground mt-1">
              <Clock className="w-3 h-3" />
              Last rented: {format(new Date(config.last_rented_at), "MMM d, HH:mm")}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={toggle} className="text-muted-foreground hover:text-cyan transition-colors">
            {config.status === "active" ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          </button>
          <button onClick={del} className="text-muted-foreground hover:text-pulse-red transition-colors">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}