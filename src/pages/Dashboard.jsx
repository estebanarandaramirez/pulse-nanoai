import { useState, useEffect, useCallback } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import {
  Cpu, Coins, Activity, Server, TrendingUp, RefreshCw, Trash2, ChevronDown
} from "lucide-react";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import StatCard from "../components/shared/StatCard";
import SectionTitle from "../components/shared/SectionTitle";
import StatusTag from "../components/shared/StatusTag";

// ─── Cache helpers (localStorage, 5-min TTL) ────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000;

function readCache(key) {
  try {
    const raw = localStorage.getItem(`dash:${key}`);
    if (!raw) return { data: null, stale: true };
    const { data, ts } = JSON.parse(raw);
    return { data, stale: Date.now() - ts > CACHE_TTL_MS, ts };
  } catch { return { data: null, stale: true }; }
}

function writeCache(key, data) {
  try { localStorage.setItem(`dash:${key}`, JSON.stringify({ data, ts: Date.now() })); } catch {}
}

// ─── Static OctaSpace market rates (no live endpoint available) ─────────────
const OCTA_MARKET_RATES = [
  { name: "NVIDIA H100 80GB",  price_per_hour: 1.50 },
  { name: "NVIDIA A100 80GB",  price_per_hour: 1.20 },
  { name: "NVIDIA RTX 4090",   price_per_hour: 0.45 },
  { name: "NVIDIA RTX 3090",   price_per_hour: 0.30 },
  { name: "NVIDIA RTX 4080",   price_per_hour: 0.28 },
  { name: "NVIDIA RTX 3080",   price_per_hour: 0.18 },
  { name: "NVIDIA RTX 3070",   price_per_hour: 0.12 },
];

// ─── Chart tooltip ───────────────────────────────────────────────────────────
const CTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-md px-3 py-2 text-[10px] font-mono">
      <div className="text-muted-foreground mb-1">{label}</div>
      {payload.map(p => (
        <div key={p.name} style={{ color: p.color }}>
          {p.name}: ${typeof p.value === "number" ? p.value.toFixed(2) : p.value}
        </div>
      ))}
    </div>
  );
};

// ─── Platform config ─────────────────────────────────────────────────────────
const PLATFORMS = [
  { id: "clore",     label: "Clore.ai",   color: "text-cyan",   activeColor: "text-cyan",   activeBg: "bg-cyan/10",   activeBorder: "border-cyan",   dot: "bg-cyan"   },
  { id: "octaspace", label: "OctaSpace",  color: "text-purple", activeColor: "text-purple", activeBg: "bg-purple/10", activeBorder: "border-purple", dot: "bg-purple" },
];

// ─── Main component ───────────────────────────────────────────────────────────
export default function Dashboard() {
  const { user } = useAuth();

  // ── Global state ────────────────────────────────────────────────────────────
  const [platform, setPlatform] = useState("clore");
  const [plsData, setPlsData] = useState({ supply: { uiAmount: 18400000 }, price_usd: 0.01 });
  const [myGPUs, setMyGPUs] = useState([]);
  const [myNode, setMyNode] = useState(null);
  const [gpusLoading, setGpusLoading] = useState(true);
  const [deletingGpu, setDeletingGpu] = useState(null);
  const [gpusOpen, setGpusOpen] = useState(true);

  // ── Platform data ────────────────────────────────────────────────────────────
  const [cloreData, setCloreData]     = useState(null);
  const [cloreLoading, setCloreLoading] = useState(false);
  const [cloreStale, setCloreStale]   = useState(false);
  const [octaData, setOctaData]       = useState(null);
  const [octaLoading, setOctaLoading] = useState(false);
  const [octaStale, setOctaStale]     = useState(false);

  // ── Data loaders (cache-first) ───────────────────────────────────────────────
  const loadClore = useCallback(async (force = false) => {
    if (!force) {
      const cached = readCache('clore');
      if (cached.data) {
        setCloreData(cached.data);
        setCloreStale(cached.stale);
        if (!cached.stale) return; // fresh — no network call
      }
    }
    setCloreLoading(true);
    try {
      const res = await base44.functions.invoke("fetchCloreaiEarnings", {});
      if (res.data) {
        setCloreData(res.data);
        setCloreStale(false);
        writeCache('clore', res.data);
      }
    } catch {}
    setCloreLoading(false);
  }, []);

  const loadOcta = useCallback(async (force = false) => {
    if (!force) {
      const cached = readCache('octa');
      if (cached.data) {
        setOctaData(cached.data);
        setOctaStale(cached.stale);
        if (!cached.stale) return;
      }
    }
    setOctaLoading(true);
    try {
      const res = await base44.functions.invoke("fetchOctaspaceEarnings", {});
      if (res.data) {
        setOctaData(res.data);
        setOctaStale(false);
        writeCache('octa', res.data);
      }
    } catch {}
    setOctaLoading(false);
  }, []);

  useEffect(() => {
    base44.functions.invoke("solanaToken", {}).then(r => { if (r.data) setPlsData(r.data); }).catch(() => {});
    loadClore();
    loadOcta();

    if (user?.email) {
      (async () => {
        try {
          const res = await base44.functions.invoke('getGPUFleet', { user_email: user.email });
          const gpus = res.data?.gpus || [];
          setMyGPUs(gpus);
          const nodeId = gpus[0]?.node_id;
          if (nodeId) {
            const nodes = await base44.entities.Node.filter({ node_id: nodeId }).catch(() => []);
            if (nodes?.length) setMyNode(nodes[0]);
          }
        } catch {}
        setGpusLoading(false);
      })();
    } else {
      setGpusLoading(false);
    }
  }, [user?.email, loadClore, loadOcta]);

  // ── GPU delete ───────────────────────────────────────────────────────────────
  const handleDeleteGpu = async (gpu) => {
    if (!confirm(`Remove ${gpu.model || gpu.gpu_id} from Pulse? This cannot be undone.`)) return;
    setDeletingGpu(gpu.gpu_id);
    try {
      await base44.functions.invoke('deleteGPU', { gpu_id: gpu.gpu_id });
      setMyGPUs(prev => prev.filter(g => g.gpu_id !== gpu.gpu_id));
    } catch (e) {
      alert(`Failed to remove GPU: ${e.message}`);
    }
    setDeletingGpu(null);
  };

  // ── Derived values ───────────────────────────────────────────────────────────
  const plsM = ((plsData?.supply?.uiAmount || 18400000) / 1e6).toFixed(1);
  const totalEarned = (cloreData?.total_earnings_usd ?? 0) + (octaData?.total_earnings_usd ?? 0);
  const activeGPUs = myGPUs.filter(g => g.status === 'active');
  const projectedDaily = activeGPUs.reduce((s, g) => s + ((g.rate_per_hour || 0) * 24 * 0.9), 0);

  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const revenueChart = DAYS.map(day => ({ day, revenue: parseFloat(projectedDaily.toFixed(2)) }));

  // ── Active platform helpers ──────────────────────────────────────────────────
  const isClore = platform === "clore";
  const activePlatform = PLATFORMS.find(p => p.id === platform);
  const platformData    = isClore ? cloreData    : octaData;
  const platformLoading = isClore ? cloreLoading : octaLoading;
  const platformStale   = isClore ? cloreStale   : octaStale;
  const platformRefresh = isClore ? () => loadClore(true) : () => loadOcta(true);

  const platformEarned  = platformData?.total_earnings_usd ?? 0;
  const platformTotal   = isClore ? (cloreData?.total_servers  ?? 0) : (octaData?.total_nodes   ?? 0);
  const platformActive  = isClore ? (cloreData?.rented_servers ?? 0) : (octaData?.active_nodes  ?? 0);
  const platformServers = isClore ? (cloreData?.server_list    ?? []) : (octaData?.nodes         ?? []);
  const marketRates     = isClore
    ? (cloreData?.market_rates?.length ? cloreData.market_rates : [])
    : OCTA_MARKET_RATES;

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">

      {/* ── Header ── */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="w-2 h-2 rounded-full bg-neon-green animate-pulse-glow" />
        <h1 className="font-display font-bold text-xl tracking-[3px] uppercase text-foreground">Dashboard</h1>
        <span className="px-2 py-0.5 bg-cyan/10 border border-cyan/30 rounded text-[9px] tracking-[2px] uppercase font-mono text-cyan">
          live · solana mainnet
        </span>
      </div>

      {/* ── Node banner ── */}
      {myNode && (
        <div className="bg-card border border-cyan/20 rounded-md p-4 relative card-gradient-top">
          <div className="flex items-center gap-3 flex-wrap">
            <Server className="w-4 h-4 text-cyan flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[10px] font-mono text-cyan font-semibold">{myNode.name} · {myNode.platform}</div>
              <div className="text-[9px] font-mono text-muted-foreground mt-0.5">
                {myNode.gpu_count ?? 0} / {myNode.target_gpu_count ?? 1000} GPUs · {myNode.status}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-1.5 w-24 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-cyan rounded-full"
                  style={{ width: `${Math.min(100, ((myNode.gpu_count ?? 0) / (myNode.target_gpu_count ?? 1000)) * 100)}%` }} />
              </div>
              <span className="text-[9px] font-mono text-muted-foreground">
                {Math.round(((myNode.gpu_count ?? 0) / (myNode.target_gpu_count ?? 1000)) * 100)}% full
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ── Global stats row ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Daily Projection"
          value={`$${projectedDaily.toFixed(2)}`}
          sub={activeGPUs.length > 0 ? `${activeGPUs.length} GPU${activeGPUs.length !== 1 ? "s" : ""} active · est.` : "No active GPUs"}
          color="primary" icon={TrendingUp}
        />
        <StatCard
          label="Total Earned · All Platforms"
          value={`$${totalEarned.toFixed(2)}`}
          sub="Clore.ai + OctaSpace"
          color="accent" icon={Coins}
        />
        <StatCard
          label="My GPUs"
          value={myGPUs.length > 0 ? `${activeGPUs.length} / ${myGPUs.length}` : "—"}
          sub={myGPUs.length > 0 ? "active / registered" : "No GPUs registered"}
          color="amber" icon={Cpu}
        />
        <StatCard label="PULSE Supply" value={`${plsM}M`} sub={`$${plsData.price_usd} per PULSE`} color="purple" icon={Activity} />
      </div>

      {/* ── Revenue projection chart ── */}
      {myGPUs.length > 0 && (
        <div className="bg-card border border-border rounded-md p-4 relative card-gradient-top">
          <SectionTitle>
            Daily Revenue Projection
            <span className="ml-2 text-[8px] text-muted-foreground normal-case tracking-normal font-sans font-normal">
              estimated · based on current active GPU rates
            </span>
          </SectionTitle>
          <div className="mt-3 h-40">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={revenueChart}>
                <defs>
                  <linearGradient id="cyanGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#00e5ff" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#00e5ff" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="day" tick={{ fontSize: 9, fill: "hsl(240 15% 55%)" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: "hsl(240 15% 55%)" }} axisLine={false} tickLine={false} width={45} />
                <Tooltip content={<CTooltip />} />
                <Area type="monotone" dataKey="revenue" name="Projected $" stroke="#00e5ff" fill="url(#cyanGrad)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* ── My GPUs — accordion, all platforms ── */}
      <div className="bg-card border border-border rounded-md overflow-hidden relative card-gradient-top">
        <button
          onClick={() => setGpusOpen(o => !o)}
          className="w-full px-4 py-3 flex items-center justify-between hover:bg-muted/20 transition-colors"
        >
          <div className="flex items-center gap-3">
            <SectionTitle>My GPUs</SectionTitle>
            {!gpusLoading && myGPUs.length > 0 && (
              <span className="text-[9px] font-mono text-muted-foreground">
                {activeGPUs.length} active · {myGPUs.length} total
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[9px] font-mono text-muted-foreground">all platforms · pulse registered</span>
            <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform duration-200 ${gpusOpen ? "rotate-180" : ""}`} />
          </div>
        </button>

        {gpusOpen && (
          gpusLoading ? (
            <div className="p-8 text-center text-[10px] font-mono text-muted-foreground border-t border-border">Loading...</div>
          ) : myGPUs.length === 0 ? (
            <div className="p-8 text-center border-t border-border">
              <Cpu className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
              <div className="text-[11px] font-mono text-muted-foreground mb-3">No GPUs registered yet.</div>
              <a href="/connect" className="px-4 py-2 bg-cyan/10 border border-cyan/40 text-cyan text-[10px] font-mono rounded-md hover:border-cyan transition-colors">
                Connect a GPU →
              </a>
            </div>
          ) : (
            <div className="overflow-x-auto border-t border-border">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    {["Model", "Status", "Rate/hr", "Uptime", "Platform", "Earned", ""].map((h, i) => (
                      <th key={i} className="px-4 py-2 text-[9px] tracking-[1.5px] uppercase text-muted-foreground text-left font-normal">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {myGPUs.map(g => (
                    <tr key={g.gpu_id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-2.5 text-[11px] font-mono text-foreground">{g.model}</td>
                      <td className="px-4 py-2.5"><StatusTag status={g.status} /></td>
                      <td className="px-4 py-2.5 text-[11px] font-mono text-cyan">${(g.rate_per_hour || 0).toFixed(3)}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="h-1 w-16 bg-muted rounded-full overflow-hidden">
                            <div className="h-full rounded-full" style={{
                              width: `${g.uptime_percent || 0}%`,
                              background: (g.uptime_percent || 0) > 90
                                ? "var(--neon-green)"
                                : (g.uptime_percent || 0) > 70 ? "var(--amber)" : "var(--pulse-red)"
                            }} />
                          </div>
                          <span className="text-[10px] font-mono text-muted-foreground">{g.uptime_percent || 0}%</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">{g.active_platform || "—"}</td>
                      <td className="px-4 py-2.5 text-[11px] font-mono text-neon-green">${(g.total_earned_usd || 0).toFixed(2)}</td>
                      <td className="px-4 py-2.5">
                        <button
                          onClick={() => handleDeleteGpu(g)}
                          disabled={deletingGpu === g.gpu_id}
                          className="text-muted-foreground hover:text-red-400 transition-colors disabled:opacity-30"
                          title="Remove from Pulse"
                        >
                          {deletingGpu === g.gpu_id
                            ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                            : <Trash2 className="w-3.5 h-3.5" />
                          }
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>

      {/* ── Full-width platform toggle ── */}
      <div className="grid grid-cols-2 bg-card border border-border rounded-md overflow-hidden">
        {PLATFORMS.map(p => (
          <button
            key={p.id}
            onClick={() => setPlatform(p.id)}
            className={`py-3.5 text-[11px] tracking-[2.5px] uppercase font-mono font-semibold transition-all border-b-2 ${
              platform === p.id
                ? `${p.activeColor} ${p.activeBg} ${p.activeBorder}`
                : "text-muted-foreground border-transparent hover:text-foreground hover:bg-muted/20"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* ── Platform section ── */}
      <div className="space-y-4">

        {/* Platform header / stats */}
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="text-[9px] tracking-[2px] uppercase text-muted-foreground">
              {activePlatform.label} · Total Earned
            </div>
            {platformLoading && !platformData ? (
              <div className="flex items-center gap-2 h-8">
                <div className={`w-4 h-4 border-2 border-t-transparent rounded-full animate-spin ${isClore ? "border-cyan" : "border-purple"}`} />
                <span className="text-[10px] font-mono text-muted-foreground">Loading...</span>
              </div>
            ) : (
              <div className={`text-2xl font-display font-bold ${activePlatform.activeColor}`}>
                ${platformEarned.toFixed(2)}
              </div>
            )}
            {platformData && (
              <div className="text-[9px] font-mono text-muted-foreground">
                {platformTotal} {isClore ? "servers" : "nodes"} · {platformActive} {isClore ? "rented" : "active"}
                {octaData?.balance_octa > 0 && !isClore && (
                  <span className="ml-2 text-purple/70">
                    {octaData.balance_octa.toFixed(2)} OCTA @ ${octaData.octa_price_usd?.toFixed(4)}
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 flex-shrink-0 mt-1">
            {platformStale && (
              <span className="text-[8px] font-mono text-amber px-2 py-0.5 bg-amber/10 border border-amber/30 rounded">
                stale
              </span>
            )}
            {platformData?.last_fetched && (
              <span className="text-[9px] font-mono text-muted-foreground">
                {new Date(platformData.last_fetched).toLocaleTimeString()}
              </span>
            )}
            <button
              onClick={platformRefresh}
              disabled={platformLoading}
              className="text-muted-foreground hover:text-foreground transition-colors"
              title="Refresh"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${platformLoading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        {/* Platform servers / nodes table */}
        {platformLoading && !platformServers.length ? (
          <div className="bg-card border border-border rounded-md p-6 flex items-center justify-center gap-3">
            <div className={`w-4 h-4 border-2 border-t-transparent rounded-full animate-spin ${isClore ? "border-cyan" : "border-purple"}`} />
            <span className="text-[10px] font-mono text-muted-foreground">
              Fetching {activePlatform.label} data...
            </span>
          </div>
        ) : platformServers.length > 0 ? (
          <div className="bg-card border border-border rounded-md overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border">
              <span className="text-[9px] tracking-[2px] uppercase text-muted-foreground">
                {isClore ? "Servers" : "Nodes"}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    {(isClore
                      ? ["Name", "GPU", "Status", "Rate/hr", "GPUs"]
                      : ["Node", "GPU", "Status", "Rate/hr", "Location"]
                    ).map(h => (
                      <th key={h} className="px-4 py-2 text-[9px] tracking-[1.5px] uppercase text-muted-foreground text-left font-normal">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {platformServers.map((s, i) => {
                    const isActive = s.rented || s.status === 'active';
                    const rate = s.price_per_hour ?? s.rate_per_hour ?? 0;
                    return (
                      <tr key={s.server_id ?? s.node_id ?? i} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-2.5 text-[10px] font-mono text-foreground">
                          {s.name ?? `Node ${i + 1}`}
                        </td>
                        <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">
                          {s.gpu_model ?? s.gpu_name ?? "—"}
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${
                            isActive
                              ? "text-neon-green border-neon-green/40 bg-neon-green/10"
                              : "text-muted-foreground border-border bg-muted/20"
                          }`}>
                            {s.rented ? "RENTED" : (s.status ?? "—").toUpperCase()}
                          </span>
                        </td>
                        <td className={`px-4 py-2.5 text-[11px] font-mono font-semibold ${activePlatform.activeColor}`}>
                          ${rate.toFixed(3)}
                        </td>
                        <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">
                          {isClore ? (s.gpu_count ?? 1) : (s.location ?? "—")}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : platformData ? (
          <div className="bg-card border border-border rounded-md p-6 text-center text-[10px] font-mono text-muted-foreground">
            No {isClore ? "servers" : "nodes"} found on {activePlatform.label}.
          </div>
        ) : null}

        {/* Market rates */}
        <div className="bg-card border border-border rounded-md overflow-hidden">
          <div className="px-3 py-2.5 border-b border-border flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full animate-pulse-glow ${activePlatform.dot}`} />
            <span className={`text-[9px] tracking-[2px] uppercase font-mono ${activePlatform.activeColor}`}>
              {activePlatform.label} · Market Rates
            </span>
            {!isClore && (
              <span className="text-[8px] font-mono text-muted-foreground ml-1">(estimated)</span>
            )}
            <span className="ml-auto text-[8px] font-mono text-muted-foreground tracking-[1px]">$/hr · on-demand</span>
          </div>
          {platformLoading && !marketRates.length ? (
            <div className="flex items-center justify-center h-24">
              <div className={`w-5 h-5 border-2 border-t-transparent rounded-full animate-spin ${isClore ? "border-cyan" : "border-purple"}`} />
            </div>
          ) : marketRates.length > 0 ? (
            <table className="w-full">
              <thead>
                <tr className="border-b border-border/50">
                  <th className="px-3 py-1.5 text-[8px] tracking-[1.5px] uppercase text-muted-foreground text-left font-normal">GPU</th>
                  <th className="px-3 py-1.5 text-[8px] tracking-[1.5px] uppercase text-muted-foreground text-right font-normal">Rate/hr</th>
                </tr>
              </thead>
              <tbody>
                {marketRates.slice(0, 10).map((r, i) => (
                  <tr key={r.name ?? i} className="hover:bg-muted/20 transition-colors border-b border-border/30">
                    <td className="px-3 py-2 text-[10px] font-mono text-foreground">{r.name}</td>
                    <td className={`px-3 py-2 text-[11px] font-mono text-right font-semibold ${activePlatform.activeColor}`}>
                      ${(r.price_per_hour || 0).toFixed(3)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="p-4 text-center text-[9px] font-mono text-muted-foreground">
              No market rate data available.
            </div>
          )}
        </div>
      </div>


    </div>
  );
}
