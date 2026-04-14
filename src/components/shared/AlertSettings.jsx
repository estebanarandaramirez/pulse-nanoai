import { useState, useEffect } from "react";
import { X } from "lucide-react";

const DEFAULTS = { tempWarn: 80, tempCrit: 90, loadWarn: 90, loadCrit: 98, fanLowCrit: 15, fanHighWarn: 95, notifyWarning: true, notifyCritical: true, browserNotify: false };

export default function AlertSettings({ onClose }) {
  const [settings, setSettings] = useState(DEFAULTS);

  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem("pulse-alert-settings") || "{}");
      setSettings({ ...DEFAULTS, ...s });
    } catch {}
  }, []);

  const set = (k, v) => setSettings(p => ({ ...p, [k]: v }));

  const save = () => {
    localStorage.setItem("pulse-alert-settings", JSON.stringify(settings));
    onClose();
  };

  const fields = [
    { key: "tempWarn", label: "Temp Warning °C", unit: "°C" },
    { key: "tempCrit", label: "Temp Critical °C", unit: "°C" },
    { key: "loadWarn", label: "Load Warning %", unit: "%" },
    { key: "loadCrit", label: "Load Critical %", unit: "%" },
    { key: "fanLowCrit", label: "Fan Low Critical %", unit: "%" },
    { key: "fanHighWarn", label: "Fan High Warning %", unit: "%" },
  ];

  const toggles = [
    { key: "notifyWarning", label: "Notify on warnings" },
    { key: "notifyCritical", label: "Notify on critical" },
    { key: "browserNotify", label: "Browser notifications" },
  ];

  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-md w-full max-w-md relative card-gradient-top">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="font-display font-bold text-sm tracking-[2px] uppercase text-cyan">Alert Settings</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            {fields.map(f => (
              <div key={f.key}>
                <label className="text-[9px] tracking-[1.5px] uppercase text-muted-foreground block mb-1">{f.label}</label>
                <input type="number" value={settings[f.key]} onChange={e => set(f.key, parseFloat(e.target.value))}
                  className="w-full bg-input border border-border rounded-md px-3 py-2 text-[11px] font-mono focus:border-primary/50 outline-none" />
              </div>
            ))}
          </div>
          <div className="space-y-2 pt-2 border-t border-border">
            {toggles.map(t => (
              <label key={t.key} className="flex items-center justify-between cursor-pointer">
                <span className="text-[10px] font-mono text-muted-foreground">{t.label}</span>
                <button
                  onClick={() => set(t.key, !settings[t.key])}
                  className={`w-9 h-5 rounded-full transition-colors relative ${settings[t.key] ? "bg-cyan" : "bg-muted"}`}
                >
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-background transition-transform ${settings[t.key] ? "translate-x-4" : "translate-x-0.5"}`} />
                </button>
              </label>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2 p-4 border-t border-border">
          <button onClick={onClose} className="px-4 py-2 text-[10px] tracking-[1px] uppercase font-mono text-muted-foreground hover:text-foreground">Cancel</button>
          <button onClick={save} className="px-4 py-2 text-[10px] tracking-[1px] uppercase font-mono bg-cyan text-background rounded-md hover:opacity-80 transition-opacity">Save</button>
        </div>
      </div>
    </div>
  );
}