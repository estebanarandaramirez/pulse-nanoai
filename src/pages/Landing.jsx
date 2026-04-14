import { Link } from "react-router-dom";
import { Zap, MonitorPlay, Coins, Trophy, Shield, ArrowRight, Cpu } from "lucide-react";
import { base44 } from "@/api/base44Client";

const STEPS = [
  {
    number: "01",
    title: "Create your profile",
    desc: "Sign up in under a minute. No credit card needed.",
    color: "text-cyan",
    borderColor: "border-cyan/30",
  },
  {
    number: "02",
    title: "Connect your GPU",
    desc: "Pulse detects your GPU automatically and places it in a compute node.",
    color: "text-neon-green",
    borderColor: "border-neon-green/30",
  },
  {
    number: "03",
    title: "Earn while you game",
    desc: "When you're not gaming, your GPU mines AI compute jobs. You get paid.",
    color: "text-amber",
    borderColor: "border-amber/30",
  },
];

const FEATURES = [
  {
    icon: MonitorPlay,
    title: "Zero impact on gameplay",
    desc: "Pulse only runs when your GPU is idle. The moment you launch a game, it steps aside.",
    color: "text-cyan",
  },
  {
    icon: Coins,
    title: "60% goes to you",
    desc: "Earn PULSE tokens on every compute job your GPU completes. Paid out continuously.",
    color: "text-neon-green",
  },
  {
    icon: Trophy,
    title: "Compete on the leaderboard",
    desc: "See how your rig ranks against every GPU on the network. Top earners get featured.",
    color: "text-amber",
  },
  {
    icon: Cpu,
    title: "Pooled into nodes",
    desc: "Your GPU joins a compute node with up to 1,000 others — giving buyers the scale they need.",
    color: "text-purple",
  },
  {
    icon: Shield,
    title: "On-chain payouts",
    desc: "Every payment is recorded on Solana. Fully transparent, no hidden fees.",
    color: "text-cyan",
  },
  {
    icon: Zap,
    title: "5-minute setup",
    desc: "Create a profile, connect your GPU, and you're live. That's it.",
    color: "text-neon-green",
  },
];

const STATS = [
  { label: "Active GPUs", value: "500+" },
  { label: "Paid out today", value: "$932" },
  { label: "Avg GPU uptime", value: "94%" },
  { label: "Network nodes", value: "12" },
];

export default function Landing() {
  const goToSignup = () => base44.auth.redirectToLogin("/create-profile");
  const goToLogin = () => base44.auth.redirectToLogin("/dashboard");

  return (
    <div className="min-h-screen relative z-10">
      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative">
              <Zap className="w-5 h-5 text-cyan" />
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-neon-green animate-pulse-glow" />
            </div>
            <span className="font-display font-bold text-sm tracking-[3px] uppercase text-glow-cyan text-cyan">
              PULSE
            </span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={goToLogin}
              className="px-4 py-2 text-[10px] tracking-[1.5px] uppercase font-mono text-muted-foreground hover:text-foreground transition-colors"
            >
              Sign in
            </button>
            <button
              onClick={goToSignup}
              className="flex items-center gap-2 px-4 py-2 bg-cyan text-background text-[10px] tracking-[2px] uppercase font-mono rounded-md hover:opacity-80 transition-opacity"
            >
              Start earning <ArrowRight className="w-3 h-3" />
            </button>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-6 pt-24 pb-20 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-neon-green/10 border border-neon-green/30 rounded-full mb-8">
          <span className="w-1.5 h-1.5 rounded-full bg-neon-green animate-pulse-glow" />
          <span className="text-[9px] tracking-[2px] uppercase font-mono text-neon-green">
            Network live · 500 GPUs earning now
          </span>
        </div>

        <h1 className="font-display font-extrabold text-4xl md:text-6xl lg:text-7xl text-foreground mb-6 leading-tight">
          Your gaming PC<br />
          <span className="text-cyan text-glow-cyan">earns money while<br />you sleep.</span>
        </h1>

        <p className="text-muted-foreground font-mono text-sm md:text-base max-w-2xl mx-auto mb-10 leading-relaxed">
          Connect your GPU to the Pulse network. When you're not gaming,
          it runs AI compute jobs and you earn <span className="text-neon-green font-semibold">PULSE tokens</span> — automatically,
          with zero impact on your games.
        </p>

        <div className="flex items-center justify-center gap-4 flex-wrap">
          <button
            onClick={goToSignup}
            className="px-8 py-3.5 bg-cyan text-background text-[11px] tracking-[2px] uppercase font-mono rounded-md hover:opacity-80 transition-opacity glow-cyan"
          >
            Start Earning Free
          </button>
          <button
            onClick={goToLogin}
            className="px-8 py-3.5 border border-border text-foreground text-[11px] tracking-[2px] uppercase font-mono rounded-md hover:border-cyan/50 hover:text-cyan transition-all"
          >
            Sign In →
          </button>
        </div>

        <p className="mt-4 text-[9px] font-mono text-muted-foreground">
          No upfront cost · No commitment · Works on any gaming PC
        </p>
      </section>

      {/* Stats bar */}
      <section className="border-y border-border bg-card/30">
        <div className="max-w-6xl mx-auto px-6 py-8 grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
          {STATS.map(s => (
            <div key={s.label}>
              <div className="text-3xl font-display font-bold text-cyan text-glow-cyan mb-1">{s.value}</div>
              <div className="text-[9px] tracking-[2px] uppercase text-muted-foreground">{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="max-w-6xl mx-auto px-6 py-20">
        <div className="text-center mb-14">
          <p className="text-[9px] tracking-[3px] uppercase font-mono text-cyan mb-3">How it works</p>
          <h2 className="font-display font-bold text-3xl text-foreground">
            Three steps to passive income
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {STEPS.map((step, i) => (
            <div key={step.number} className={`relative bg-card border ${step.borderColor} rounded-md p-6 card-gradient-top`}>
              <div className={`text-5xl font-display font-extrabold ${step.color} opacity-20 mb-4 leading-none`}>
                {step.number}
              </div>
              <h3 className={`font-display font-bold text-base text-foreground mb-2`}>{step.title}</h3>
              <p className="text-[11px] font-mono text-muted-foreground leading-relaxed">{step.desc}</p>
              {i < STEPS.length - 1 && (
                <ArrowRight className="hidden md:block absolute -right-3 top-1/2 -translate-y-1/2 w-6 h-6 text-border z-10" />
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="max-w-6xl mx-auto px-6 pb-20">
        <div className="text-center mb-14">
          <p className="text-[9px] tracking-[3px] uppercase font-mono text-cyan mb-3">Why Pulse</p>
          <h2 className="font-display font-bold text-3xl text-foreground">
            Built for gamers, not data centers
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {FEATURES.map(f => {
            const Icon = f.icon;
            return (
              <div key={f.title} className="bg-card border border-border rounded-md p-5 relative card-gradient-top hover:border-cyan/30 transition-colors">
                <Icon className={`w-5 h-5 ${f.color} mb-3`} />
                <h3 className="font-display font-bold text-sm text-foreground mb-2">{f.title}</h3>
                <p className="text-[11px] text-muted-foreground font-mono leading-relaxed">{f.desc}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Final CTA */}
      <section className="border-t border-border bg-card/30 py-24 text-center">
        <h2 className="font-display font-extrabold text-4xl md:text-5xl text-foreground mb-4 leading-tight">
          Your GPU is sitting idle<br />
          <span className="text-cyan text-glow-cyan">right now.</span>
        </h2>
        <p className="text-muted-foreground font-mono text-sm mb-10 max-w-xl mx-auto">
          Every hour it's not earning is money left on the table. Join the Pulse network today.
        </p>
        <button
          onClick={goToSignup}
          className="px-12 py-4 bg-cyan text-background text-[12px] tracking-[2px] uppercase font-mono rounded-md hover:opacity-80 transition-opacity glow-cyan"
        >
          Connect My GPU →
        </button>
        <p className="mt-4 text-[9px] font-mono text-muted-foreground">Free to join · Takes 5 minutes</p>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-8 text-center">
        <div className="text-[9px] tracking-[2px] uppercase text-muted-foreground font-mono">
          © 2025 PULSE · Powered by Solana · PULSE token
        </div>
      </footer>
    </div>
  );
}
