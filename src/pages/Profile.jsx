import { useState } from "react";
import { useAuth } from "@/lib/AuthContext";
import { base44 } from "@/api/base44Client";
import PhantomConnect from "../components/shared/PhantomConnect";
import { useToast } from "@/components/ui/use-toast";
import { User, Save } from "lucide-react";

export default function Profile() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [name, setName] = useState(user?.full_name || "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await base44.auth.updateMe({ full_name: name });
      toast({ title: "Profile updated" });
    } catch {
      toast({ title: "Failed to update", variant: "destructive" });
    }
    setSaving(false);
  };

  return (
    <div className="space-y-6 max-w-lg">
      <div className="flex items-center gap-3">
        <span className="w-2 h-2 rounded-full bg-neon-green animate-pulse-glow" />
        <h1 className="font-display font-bold text-xl tracking-[3px] uppercase text-foreground">Profile</h1>
      </div>

      <div className="bg-card border border-border rounded-md p-5 relative card-gradient-top space-y-4">
        <div className="flex items-center gap-4 pb-4 border-b border-border">
          <div className="w-12 h-12 rounded-full bg-cyan/10 border border-cyan/30 flex items-center justify-center">
            <User className="w-6 h-6 text-cyan" />
          </div>
          <div>
            <div className="text-sm font-display font-bold text-foreground">{user?.full_name || "—"}</div>
            <div className="text-[10px] text-muted-foreground font-mono">{user?.email}</div>
          </div>
          <span className={`ml-auto px-2 py-0.5 rounded border text-[9px] tracking-[1.5px] uppercase font-mono
            ${user?.role === "admin" ? "text-amber border-amber/40 bg-amber/10" : "text-cyan border-cyan/40 bg-cyan/10"}`}>
            {user?.role || "user"}
          </span>
        </div>

        <div>
          <label className="text-[9px] tracking-[2px] uppercase text-muted-foreground block mb-1">Email</label>
          <input value={user?.email || ""} disabled
            className="w-full bg-muted/30 border border-border rounded-md px-3 py-2 text-[11px] font-mono text-muted-foreground cursor-not-allowed" />
        </div>

        <div>
          <label className="text-[9px] tracking-[2px] uppercase text-muted-foreground block mb-1">Display Name</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Enter your name..."
            className="w-full bg-input border border-border rounded-md px-3 py-2 text-[11px] font-mono focus:border-primary/50 outline-none"
          />
        </div>

        <button onClick={save} disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-cyan text-background text-[10px] tracking-[1px] uppercase font-mono rounded-md hover:opacity-80 transition-opacity disabled:opacity-50">
          <Save className="w-3.5 h-3.5" />
          {saving ? "Saving..." : "Save Changes"}
        </button>
      </div>

      <div>
        <h2 className="font-display font-bold text-sm tracking-[2px] uppercase text-foreground mb-3">Wallet</h2>
        <PhantomConnect />
      </div>
    </div>
  );
}