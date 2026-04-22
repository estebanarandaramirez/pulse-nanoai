import { useState } from "react";
import { Cpu, Search } from "lucide-react";

const GPU_OPTIONS = [
  { name: "RTX 4090", vram: 24 }, { name: "RTX 4080", vram: 16 }, { name: "RTX 3090", vram: 24 },
  { name: "RTX 3080", vram: 10 }, { name: "RTX 3070", vram: 8 }, { name: "RTX 3060", vram: 12 },
  { name: "A100", vram: 80 }, { name: "H100", vram: 80 },
];

export default function GPUDetector({ onDetected }) {
  const [detected, setDetected] = useState(null);
  const [manual, setManual] = useState(false);
  const [manualName, setManualName] = useState("RTX 4090");
  const [manualVram, setManualVram] = useState(24);
  const [detecting, setDetecting] = useState(false);

  const detect = () => {
    setDetecting(true);
    setTimeout(() => {
      let name = "Unknown GPU";
      let vram = 8;
      try {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
        if (gl) {
          const ext = gl.getExtension("WEBGL_debug_renderer_info");
          if (ext) {
            const renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || "";
            const match = GPU_OPTIONS.find(g => renderer.toLowerCase().includes(g.name.toLowerCase().replace("rtx", "").trim()));
            if (match) { name = match.name; vram = match.vram; }
            else if (renderer) { name = renderer.split("/")[0].trim() || "Unknown GPU"; }
          }
        }
      } catch (e) {}
      if (name === "Unknown GPU") { setManual(true); setDetecting(false); return; }
      const result = { name, vram };
      setDetected(result);
      onDetected?.(result);
      setDetecting(false);
    }, 1200);
  };

  const confirmManual = () => {
    const result = { name: manualName, vram: parseInt(manualVram) };
    setDetected(result);
    setManual(false);
    onDetected?.(result);
  };

  if (manual) {
    return (
      <div className="bg-card border border-border rounded-md p-4 space-y-3">
        <p className="text-[10px] text-muted-foreground">Could not auto-detect. Select your GPU manually:</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[9px] tracking-[2px] uppercase text-muted-foreground block mb-1">GPU Model</label>
            <select value={manualName} onChange={e => {
              const g = GPU_OPTIONS.find(g => g.name === e.target.value);
              setManualName(e.target.value);
              if (g) setManualVram(g.vram);
            }} className="w-full bg-input border border-border rounded-md px-3 py-2 text-[11px] font-mono outline-none">
              {GPU_OPTIONS.map(g => <option key={g.name}>{g.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[9px] tracking-[2px] uppercase text-muted-foreground block mb-1">VRAM (GB)</label>
            <input type="number" value={manualVram} onChange={e => setManualVram(e.target.value)}
              className="w-full bg-input border border-border rounded-md px-3 py-2 text-[11px] font-mono outline-none" />
          </div>
        </div>
        <button onClick={confirmManual}
          className="w-full py-2 bg-cyan text-background text-[10px] tracking-[2px] uppercase font-mono rounded-md hover:opacity-80 transition-opacity">
          Confirm GPU
        </button>
      </div>
    );
  }

  if (detected) {
    return (
      <div className="bg-card border border-neon-green/30 rounded-md p-4 glow-green flex items-center gap-4">
        <Cpu className="w-8 h-8 text-neon-green flex-shrink-0" />
        <div>
          <div className="text-[9px] tracking-[2px] uppercase text-neon-green mb-1">GPU Detected</div>
          <div className="text-lg font-display font-bold text-foreground">{detected.name}</div>
          <div className="text-[10px] text-muted-foreground">{detected.vram}GB VRAM</div>
        </div>
      </div>
    );
  }

  return (
    <button onClick={detect} disabled={detecting}
      className="flex items-center gap-3 w-full bg-card border border-cyan/40 hover:border-cyan hover:glow-cyan rounded-md px-4 py-4 transition-all group">
      {detecting ? (
        <div className="w-5 h-5 border-2 border-cyan border-t-transparent rounded-full animate-spin" />
      ) : (
        <Search className="w-5 h-5 text-cyan" />
      )}
      <div className="text-left">
        <div className="text-[9px] tracking-[2px] uppercase text-muted-foreground">Auto-Detect &amp; Register</div>
        <div className="text-[11px] font-mono text-cyan group-hover:text-glow-cyan">
          {detecting ? "Scanning hardware..." : "Register GPU with Pulse"}
        </div>
      </div>
    </button>
  );
}