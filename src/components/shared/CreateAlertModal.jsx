import { useState } from "react";
import { X } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";

export default function CreateAlertModal({ onClose, onCreated }) {
  const { user } = useAuth();
  const [form, setForm] = useState({
    label: "", platform: "Any", gpu_model: "", alert_type: "below", threshold: "", status: "active"
  });
  const [saving, setSaving] = useState(false);

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const save = async () => {
    if (!form.label || !form.gpu_model || !form.threshold) return;
    setSaving(true);
    await base44.entities.PriceAlert.create({ ...form, threshold: parseFloat(form.threshold), user_email: user?.email });
    setSaving(false);
    onCreated?.();
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-md w-full max-w-md relative card-gradient-top">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="font-display font-bold text-sm tracking-[2px] uppercase text-cyan">New Price Alert</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-3">
          {[
            { label: "Label", key: "label", type: "text", placeholder: "My RTX 4090 Alert" },
            { label: "GPU Model", key: "gpu_model", type: "text", placeholder: "RTX 4090" },
            { label: "Threshold $/hr", key: "threshold", type: "number", placeholder: "0.850" },
          ].map(f => (
            <div key={f.key}>
              <label className="text-[9px] tracking-[2px] uppercase text-muted-foreground block mb-1">{f.label}</label>
              <input
                type={f.type}
                placeholder={f.placeholder}
                value={form[f.key]}
                onChange={e => set(f.key, e.target.value)}
                className="w-full bg-input border border-border rounded-md px-3 py-2 text-[11px] font-mono focus:border-primary/50 outline-none"
              />
            </div>
          ))}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[9px] tracking-[2px] uppercase text-muted-foreground block mb-1">Platform</label>
              <select value={form.platform} onChange={e => set("platform", e.target.value)}
                className="w-full bg-input border border-border rounded-md px-3 py-2 text-[11px] font-mono focus:border-primary/50 outline-none">
                {["Any", "Vast.ai", "RunPod", "Clore.ai", "OctaSpace"].map(p => <option key={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[9px] tracking-[2px] uppercase text-muted-foreground block mb-1">Alert Type</label>
              <select value={form.alert_type} onChange={e => set("alert_type", e.target.value)}
                className="w-full bg-input border border-border rounded-md px-3 py-2 text-[11px] font-mono focus:border-primary/50 outline-none">
                <option value="below">Below threshold</option>
                <option value="above">Above threshold</option>
              </select>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
          <button onClick={onClose} className="px-4 py-2 text-[10px] tracking-[1px] uppercase font-mono text-muted-foreground hover:text-foreground transition-colors">Cancel</button>
          <button onClick={save} disabled={saving}
            className="px-4 py-2 text-[10px] tracking-[1px] uppercase font-mono bg-cyan text-background rounded-md hover:opacity-80 transition-opacity disabled:opacity-50">
            {saving ? "Saving..." : "Create Alert"}
          </button>
        </div>
      </div>
    </div>
  );
}