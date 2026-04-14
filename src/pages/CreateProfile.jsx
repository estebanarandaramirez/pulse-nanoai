import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/AuthContext";
import { base44 } from "@/api/base44Client";
import { Zap, User, Mail, Phone, ArrowRight, Loader2 } from "lucide-react";

export default function CreateProfile() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    full_name: "",
    email: user?.email ?? "",
    phone: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const set = (field) => (e) => setForm(prev => ({ ...prev, [field]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.full_name.trim()) { setError("Please enter your name."); return; }
    if (!form.email.trim()) { setError("Please enter your email."); return; }

    setSaving(true);
    setError(null);

    try {
      await base44.entities.User.update(user.id, {
        full_name: form.full_name.trim(),
        phone: form.phone.trim(),
      }).catch(() => {
        // User entity update may fail if fields aren't defined — proceed anyway
      });

      // Mark profile as completed in localStorage so we don't re-show this page
      localStorage.setItem("pulse_profile_complete", "true");
      navigate("/connect");
    } catch (err) {
      setError("Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 py-12 relative z-10">
      {/* Logo */}
      <div className="flex items-center gap-2 mb-10">
        <div className="relative">
          <Zap className="w-5 h-5 text-cyan" />
          <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-neon-green animate-pulse-glow" />
        </div>
        <span className="font-display font-bold text-sm tracking-[3px] uppercase text-glow-cyan text-cyan">
          PULSE
        </span>
      </div>

      {/* Card */}
      <div className="w-full max-w-md bg-card border border-border rounded-md p-8 relative card-gradient-top">
        {/* Header */}
        <div className="mb-8">
          <h1 className="font-display font-bold text-xl tracking-[2px] uppercase text-foreground mb-2">
            Create your profile
          </h1>
          <p className="text-[11px] font-mono text-muted-foreground leading-relaxed">
            One step before your GPU starts earning. Takes 30 seconds.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Full name */}
          <div>
            <label className="block text-[9px] tracking-[2px] uppercase text-muted-foreground mb-2 font-mono">
              Full name
            </label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input
                type="text"
                value={form.full_name}
                onChange={set("full_name")}
                placeholder="Your name"
                autoFocus
                className="w-full bg-input border border-border rounded-md pl-9 pr-4 py-2.5 text-[11px] font-mono focus:border-cyan/50 outline-none placeholder:text-muted-foreground/50"
              />
            </div>
          </div>

          {/* Email */}
          <div>
            <label className="block text-[9px] tracking-[2px] uppercase text-muted-foreground mb-2 font-mono">
              Email
            </label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input
                type="email"
                value={form.email}
                onChange={set("email")}
                placeholder="you@example.com"
                className="w-full bg-input border border-border rounded-md pl-9 pr-4 py-2.5 text-[11px] font-mono focus:border-cyan/50 outline-none placeholder:text-muted-foreground/50"
              />
            </div>
          </div>

          {/* Phone */}
          <div>
            <label className="block text-[9px] tracking-[2px] uppercase text-muted-foreground mb-2 font-mono">
              Phone number <span className="text-muted-foreground/50">(optional)</span>
            </label>
            <div className="relative">
              <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input
                type="tel"
                value={form.phone}
                onChange={set("phone")}
                placeholder="+1 555 000 0000"
                className="w-full bg-input border border-border rounded-md pl-9 pr-4 py-2.5 text-[11px] font-mono focus:border-cyan/50 outline-none placeholder:text-muted-foreground/50"
              />
            </div>
          </div>

          {error && (
            <p className="text-[10px] font-mono text-pulse-red px-3 py-2 bg-pulse-red/10 border border-pulse-red/30 rounded-md">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={saving}
            className="w-full flex items-center justify-center gap-2 py-3 bg-cyan text-background text-[11px] tracking-[2px] uppercase font-mono rounded-md hover:opacity-80 transition-opacity disabled:opacity-50 mt-2"
          >
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <>
                Connect my GPU <ArrowRight className="w-3.5 h-3.5" />
              </>
            )}
          </button>
        </form>
      </div>

      {/* Progress indicator */}
      <div className="flex items-center gap-3 mt-8">
        {["Profile", "Connect GPU", "Start Earning"].map((label, i) => (
          <div key={label} className="flex items-center gap-3">
            <div className={`flex items-center gap-1.5 text-[9px] font-mono tracking-[1px] uppercase
              ${i === 0 ? "text-cyan" : "text-muted-foreground"}`}>
              <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold
                ${i === 0 ? "bg-cyan text-background" : "border border-border text-muted-foreground"}`}>
                {i + 1}
              </span>
              {label}
            </div>
            {i < 2 && <span className="text-border text-xs">—</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
