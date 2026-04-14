import { useState, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/AuthContext";
import { base44 } from "@/api/base44Client";
import PhantomConnect from "./shared/PhantomConnect";
import {
  LayoutDashboard, Wallet, Cpu, User, Database, BarChart3, Activity,
  TrendingUp, Bell, RefreshCw, Clock, Calculator, ShieldAlert, Menu, X,
  ChevronDown, ChevronRight, LogOut, Zap, Coins, DollarSign, Trophy
} from "lucide-react";

const NAV_MAIN = [
  { label: "Dashboard", path: "/dashboard", icon: LayoutDashboard },
  { label: "Leaderboard", path: "/leaderboard", icon: Trophy },
  { label: "Wallet", path: "/wallet", icon: Wallet },
  { label: "Connect GPU", path: "/connect", icon: Cpu },
  { label: "Profile", path: "/profile", icon: User },
];

const NAV_ADMIN_SECTION = [
  { label: "GPU Fleet", path: "/gpu-fleet", icon: Database },
  { label: "Simulation", path: "/simulation", icon: BarChart3 },
  { label: "GPU Health", path: "/gpu-health", icon: Activity },
  { label: "Analytics", path: "/analytics", icon: TrendingUp },
  { label: "Rental Analytics", path: "/rental-analytics", icon: Clock },
  { label: "Price Alerts", path: "/alerts", icon: Bell },
  { label: "Auto-Rent", path: "/auto-rent", icon: RefreshCw },
  { label: "Price History", path: "/price-history", icon: TrendingUp },
  { label: "ROI Calculator", path: "/roi-calculator", icon: Calculator },
];

function NavItem({ item, active, onClick }) {
  const Icon = item.icon;
  return (
    <Link to={item.path} onClick={onClick}
      className={`flex items-center gap-3 px-3 py-2 rounded-md text-[10px] tracking-[1.5px] uppercase font-mono transition-all group
        ${active ? "bg-cyan/10 text-cyan border-l-2 border-cyan" : "text-muted-foreground hover:text-foreground hover:bg-muted/30"}`}>
      <Icon className="w-3.5 h-3.5 flex-shrink-0" />
      {item.label}
    </Link>
  );
}

export default function AppLayout({ children }) {
  const location = useLocation();
  const { user } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(true);

  const logout = () => base44.auth.logout();

  const sidebarContent = (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Logo */}
      <div className="px-4 py-5 border-b border-sidebar-border flex-shrink-0">
        <Link to="/dashboard" className="flex items-center gap-2" onClick={() => setSidebarOpen(false)}>
          <div className="relative">
            <Zap className="w-5 h-5 text-cyan" />
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-neon-green animate-pulse-glow" />
          </div>
          <div>
            <div className="font-display font-bold text-sm tracking-[2px] uppercase text-foreground text-glow-cyan">
              PULSE Nano AI
            </div>
            <div className="text-[8px] tracking-[3px] text-muted-foreground uppercase">GPU Monetization</div>
          </div>
        </Link>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto p-3 space-y-0.5 scrollbar-none">
        {NAV_MAIN.map(item => (
          <NavItem key={item.path} item={item} active={location.pathname === item.path} onClick={() => setSidebarOpen(false)} />
        ))}

        <div className="my-3 border-t border-sidebar-border" />

        <button
          onClick={() => setAdminOpen(p => !p)}
          className="flex items-center justify-between w-full px-3 py-1.5 text-[8px] tracking-[2px] uppercase text-muted-foreground hover:text-foreground transition-colors"
        >
          Administration
          {adminOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </button>

        {adminOpen && NAV_ADMIN_SECTION.map(item => (
          <NavItem key={item.path} item={item} active={location.pathname === item.path} onClick={() => setSidebarOpen(false)} />
        ))}

        {user?.role === "admin" && (
          <>
            <div className="my-3 border-t border-sidebar-border" />
            <NavItem item={{ label: "Admin", path: "/admin", icon: ShieldAlert }} active={location.pathname === "/admin"} onClick={() => setSidebarOpen(false)} />
            <NavItem item={{ label: "Payout Scheduler", path: "/admin/payouts", icon: Coins }} active={location.pathname === "/admin/payouts"} onClick={() => setSidebarOpen(false)} />
            <NavItem item={{ label: "Treasury", path: "/admin/treasury", icon: DollarSign }} active={location.pathname === "/admin/treasury"} onClick={() => setSidebarOpen(false)} />
          </>
        )}
      </nav>

      {/* Footer */}
      <div className="p-3 border-t border-sidebar-border flex-shrink-0 space-y-2">
        <PhantomConnect />
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <div className="text-[9px] text-muted-foreground truncate">{user?.email}</div>
            <div className="text-[8px] tracking-[2px] uppercase text-cyan/60">SOLANA · MAINNET</div>
          </div>
          <button onClick={logout} className="text-muted-foreground hover:text-pulse-red transition-colors ml-2">
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex relative z-10">
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex w-56 flex-shrink-0 bg-sidebar border-r border-sidebar-border flex-col">
        {sidebarContent}
      </aside>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div className="lg:hidden fixed inset-0 z-40">
          <div className="absolute inset-0 bg-background/80 backdrop-blur-sm" onClick={() => setSidebarOpen(false)} />
          <aside className="absolute left-0 top-0 bottom-0 w-56 bg-sidebar border-r border-sidebar-border z-50">
            {sidebarContent}
          </aside>
        </div>
      )}

      {/* Main */}
      <main className="flex-1 overflow-auto min-w-0">
        {/* Mobile header */}
        <div className="lg:hidden flex items-center gap-3 px-4 py-3 border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-30">
          <button onClick={() => setSidebarOpen(true)} className="text-muted-foreground hover:text-foreground">
            <Menu className="w-5 h-5" />
          </button>
          <span className="font-display font-bold text-sm tracking-[2px] uppercase text-cyan text-glow-cyan">PULSE Nano AI</span>
        </div>
        <div className="p-4 md:p-6">{children}</div>
      </main>
    </div>
  );
}