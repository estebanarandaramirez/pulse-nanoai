import { useState, useEffect, useCallback } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import {
  Cpu, Coins, Activity, Server, TrendingUp, RefreshCw, ChevronDown, X, Pencil, Check, Info, Link2
} from "lucide-react";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import StatCard from "../components/shared/StatCard";
import SectionTitle from "../components/shared/SectionTitle";

// ─── Cache helpers (localStorage, 5-min TTL) ────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_VERSION = 'v4';

function readCache(key) {
  try {
    const raw = localStorage.getItem(`dash:${key}:${CACHE_VERSION}`);
    if (!raw) return { data: null, stale: true };
    const { data, ts } = JSON.parse(raw);
    return { data, stale: Date.now() - ts > CACHE_TTL_MS, ts };
  } catch { return { data: null, stale: true }; }
}

function writeCache(key, data) {
  try { localStorage.setItem(`dash:${key}:${CACHE_VERSION}`, JSON.stringify({ data, ts: Date.now() })); } catch {}
}

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

// ─── Main component ───────────────────────────────────────────────────────────
export default function Dashboard() {
  const { user } = useAuth();

  // ── Global state ────────────────────────────────────────────────────────────
  const [plsData, setPlsData] = useState({ supply: { uiAmount: 18400000 }, price_usd: 0.01 });
  const [myGPUs, setMyGPUs] = useState([]);
  const [myNode, setMyNode] = useState(null);
  const [gpusLoading, setGpusLoading] = useState(true);

  // ── Accordion state ──────────────────────────────────────────────────────────
  const [mainOpen, setMainOpen] = useState(true);
  const [octaOpen, setOctaOpen] = useState(true);
  const [cloreOpen, setCloreOpen] = useState(true);

  // ── Platform data ────────────────────────────────────────────────────────────
  const [cloreData, setCloreData]       = useState(null);
  const [cloreLoading, setCloreLoading] = useState(false);
  const [cloreStale, setCloreStale]     = useState(false);
  const [octaData, setOctaData]         = useState(null);
  const [octaLoading, setOctaLoading]   = useState(false);
  const [octaStale, setOctaStale]       = useState(false);
  const [octaNodes, setOctaNodes]       = useState([]);
  const [octaNodesLoading, setOctaNodesLoading] = useState(false);

  // ── OctaSpace price editing ──────────────────────────────────────────────────
  const [editingNodePrice, setEditingNodePrice] = useState(null); // { node_id, value }
  const [savingNodePrice, setSavingNodePrice]   = useState(null); // node_id string

  // ── OctaSpace node linking ───────────────────────────────────────────────────
  const [linkAssignments, setLinkAssignments] = useState({}); // { [octa_node_id]: gpu_base44_id }
  const [linkingNode, setLinkingNode]         = useState(null);
  const [showProjectionInfo, setShowProjectionInfo] = useState(false);

  const linkOctaNode = async (nodeId, gpuBase44Id) => {
    if (!gpuBase44Id) return;
    setLinkingNode(nodeId);
    try {
      const res = await base44.functions.invoke('assignPlatformNode', {
        gpu_base44_id: gpuBase44Id,
        platform_node_id: String(nodeId),
        platform: 'OctaSpace',
      });
      if (res.data?.success) {
        const fleetRes = await base44.functions.invoke('getGPUFleet', { user_email: user.email });
        setMyGPUs(fleetRes.data?.gpus || []);
        setLinkAssignments(prev => { const n = { ...prev }; delete n[nodeId]; return n; });
      } else {
        alert(`Link failed: ${res.data?.error ?? 'unknown error'}`);
      }
    } catch (e) { alert(`Error: ${e.message}`); }
    setLinkingNode(null);
  };

  const saveNodePrice = async (nodeId, priceStr) => {
    const price = parseFloat(priceStr);
    if (!price || isNaN(price) || price <= 0) return;
    setSavingNodePrice(nodeId);
    try {
      const res = await base44.functions.invoke('updateOctaNodePrice', { node_id: String(nodeId), base_usd: price });
      if (res.data?.success) {
        setOctaNodes(prev => prev.map(n => n.node_id == nodeId ? { ...n, rate_per_hour: price } : n));
        setEditingNodePrice(null);
      } else {
        alert(`Price update failed: ${res.data?.message ?? 'unknown error'}`);
      }
    } catch (e) {
      alert(`Error: ${e.message}`);
    }
    setSavingNodePrice(null);
  };

  // ── Data loaders (cache-first) ───────────────────────────────────────────────
  const isErrorResponse = (data) => !!(data?.error || data?.note);

  const loadClore = useCallback(async (force = false) => {
    if (!force) {
      const cached = readCache('clore');
      if (cached.data && !isErrorResponse(cached.data)) {
        setCloreData(cached.data);
        setCloreStale(cached.stale);
        if (!cached.stale) return;
      }
    }
    setCloreLoading(true);
    // Stop spinner after 25s regardless — server function has its own 10s timeouts per fetch
    const stopSpinner = setTimeout(() => setCloreLoading(false), 25000);
    try {
      const res = await base44.functions.invoke("fetchCloreaiEarnings", {});
      if (res.data) {
        setCloreData(res.data);
        if (!isErrorResponse(res.data)) { setCloreStale(false); writeCache('clore', res.data); }
      }
    } catch {}
    clearTimeout(stopSpinner);
    setCloreLoading(false);
  }, []);

  const loadOcta = useCallback(async (force = false) => {
    if (!force) {
      const cached = readCache('octa');
      if (cached.data && !isErrorResponse(cached.data)) {
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
        if (!isErrorResponse(res.data)) { setOctaStale(false); writeCache('octa', res.data); }
      }
    } catch {}
    setOctaLoading(false);
    setOctaNodesLoading(true);
    try {
      const nr = await base44.functions.invoke("getOctaNodeInfo", {});
      if (nr.data?.nodes) setOctaNodes(nr.data.nodes);
    } catch {}
    setOctaNodesLoading(false);
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

  // ── Derived values ───────────────────────────────────────────────────────────
  const plsM = ((plsData?.supply?.uiAmount || 18400000) / 1e6).toFixed(1);
  const activeGPUs = myGPUs.filter(g => g.status === 'active');
  const cloreServers = cloreData?.server_list ?? [];

  // Filter OctaSpace nodes by platform_node_id or node_id (both columns may hold the OctaSpace node ID)
  const rawOctaNodes = octaNodes.length ? octaNodes : (octaData?.nodes ?? []);
  const isLinked = (n) => myGPUs.some(g => {
    const id = String(n.node_id);
    return (g.platform_node_id && g.platform_node_id === id) || (g.node_id && g.node_id === id);
  });
  const octaNodesDisplay = rawOctaNodes.filter(isLinked);
  const unlinkedOctaNodes = rawOctaNodes.filter(n => !isLinked(n));

  // Earnings: sum actual 24h income from scraped OctaSpace nodes + Clore wallet balance
  const octaIncome24h = octaNodes.reduce((s, n) => s + (n.income_24h_usd ?? 0), 0);
  const total24hIncome = parseFloat(((cloreData?.total_earnings_usd ?? 0) + octaIncome24h).toFixed(2));

  // Projection: 16h/day (8h sleeping + 8h at work — when GPU is idle and rented out)
  const RENT_HOURS = 16;
  const octaProjected = octaNodes
    .filter(n => n.status === 'online')
    .reduce((s, n) => s + (n.rate_per_hour ?? 0) * RENT_HOURS, 0);
  const cloreProjected = cloreServers
    .reduce((s, sv) => s + (sv.price_per_hour ?? 0) * RENT_HOURS, 0);
  const projectedDaily = parseFloat((octaProjected + cloreProjected).toFixed(2));

  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const revenueChart = DAYS.map(day => ({ day, revenue: parseFloat(projectedDaily.toFixed(2)) }));

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
          sub={projectedDaily > 0 ? "OctaSpace online + Clore.ai · est." : "No online nodes"}
          color="primary" icon={TrendingUp}
        />
        <StatCard
          label="Earnings · All Platforms"
          value={`$${total24hIncome.toFixed(2)}`}
          sub="Clore.ai + OctaSpace 24h"
          color="accent" icon={Coins}
        />
        <StatCard
          label="My GPUs"
          value={!gpusLoading && myGPUs.length > 0 ? `${activeGPUs.length} / ${myGPUs.length}` : "—"}
          sub={myGPUs.length > 0 ? "active / registered" : "No GPUs registered"}
          color="amber" icon={Cpu}
        />
        <StatCard label="PULSE Supply" value={`${plsM}M`} sub={`$${plsData.price_usd} per PULSE`} color="purple" icon={Activity} />
      </div>

      {/* ── Revenue projection chart ── */}
      {projectedDaily > 0 && (
        <div className="bg-card border border-border rounded-md p-4 relative card-gradient-top">
          <div className="flex items-center gap-2">
            <SectionTitle>
              Daily Revenue Projection
            </SectionTitle>
            <span className="text-[8px] text-muted-foreground normal-case tracking-normal font-sans font-normal">
              estimated · 16h/day
            </span>
            <div className="relative"
              onMouseEnter={() => setShowProjectionInfo(true)}
              onMouseLeave={() => setShowProjectionInfo(false)}
            >
              <Info className="w-3 h-3 text-muted-foreground hover:text-foreground cursor-help transition-colors" />
              {showProjectionInfo && (
                <div className="absolute left-0 top-5 z-50 w-72 bg-card border border-border rounded-md p-3 text-[9px] font-mono text-muted-foreground shadow-lg">
                  <div className="text-foreground font-semibold mb-1">How we calculate this</div>
                  <div>Rate × 16h/day — assuming your GPU is idle and available to renters for:</div>
                  <div className="mt-1 pl-2 space-y-0.5">
                    <div>· 8h overnight (while you sleep)</div>
                    <div>· 8h during the workday (9-to-5)</div>
                  </div>
                  <div className="mt-1 text-muted-foreground/70">The remaining 8h are reserved for personal use (gaming, etc.)</div>
                </div>
              )}
            </div>
          </div>
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

      {/* ── Nodes & Servers — main accordion with platform sub-accordions ── */}
      <div className="bg-card border border-border rounded-md overflow-hidden relative card-gradient-top">

        {/* Main header */}
        <button
          onClick={() => setMainOpen(o => !o)}
          className="w-full px-4 py-3 flex items-center justify-between hover:bg-muted/20 transition-colors"
        >
          <div className="flex items-center gap-3">
            <SectionTitle>Nodes &amp; Servers</SectionTitle>
            <span className="text-[9px] font-mono text-muted-foreground">all platforms</span>
          </div>
          <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform duration-200 ${mainOpen ? "rotate-180" : ""}`} />
        </button>

        {mainOpen && (
          <div className="border-t border-border divide-y divide-border">

            {/* ── OctaSpace sub-accordion ───────────────────────────────────── */}
            <div>
              <button
                onClick={() => setOctaOpen(o => !o)}
                className="w-full px-4 py-2.5 flex items-center gap-2.5 hover:bg-purple/5 transition-colors text-left"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-purple flex-shrink-0" />
                <span className="text-[10px] font-mono font-semibold text-purple tracking-[2px] uppercase">OctaSpace</span>
                {(octaLoading || octaNodesLoading) ? (
                  <div className="w-3 h-3 border border-purple border-t-transparent rounded-full animate-spin flex-shrink-0" />
                ) : (
                  <span className="text-[9px] font-mono text-muted-foreground">
                    {octaNodesDisplay.filter(n => n.status === 'online').length} online · {octaNodesDisplay.length} nodes
                  </span>
                )}
                {(octaData?.total_income_24h_usd ?? 0) > 0 && (
                  <span className="text-[9px] font-mono text-neon-green">
                    ${octaData.total_income_24h_usd.toFixed(2)} 24h
                  </span>
                )}
                {(octaData?.balance_octa ?? 0) > 0 && (
                  <span className="text-[9px] font-mono text-purple/50">
                    {octaData.balance_octa.toFixed(2)} OCTA
                  </span>
                )}
                <div className="ml-auto flex items-center gap-2">
                  {octaStale && (
                    <span className="text-[8px] font-mono text-amber px-1.5 py-0.5 bg-amber/10 border border-amber/30 rounded">stale</span>
                  )}
                  {octaData?.last_fetched && (
                    <span className="text-[9px] font-mono text-muted-foreground hidden sm:block">
                      {new Date(octaData.last_fetched).toLocaleTimeString()}
                    </span>
                  )}
                  <button
                    onClick={e => { e.stopPropagation(); loadOcta(true); }}
                    disabled={octaLoading || octaNodesLoading}
                    className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                    title="Refresh OctaSpace"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${(octaLoading || octaNodesLoading) ? "animate-spin" : ""}`} />
                  </button>
                  <ChevronDown className={`w-3 h-3 text-muted-foreground transition-transform duration-200 ${octaOpen ? "rotate-180" : ""}`} />
                </div>
              </button>

              {octaOpen && (
                octaNodesDisplay.length > 0 ? (
                  <div className="overflow-x-auto border-t border-border/50">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border bg-muted/5">
                          {["Node", "GPU", "Online", "Rental", "Rate/hr", "Income 24h"].map(h => (
                            <th key={h} className="px-4 py-2 text-[9px] tracking-[1.5px] uppercase text-muted-foreground text-left font-normal">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {octaNodesDisplay.map((s, i) => {
                          const isOnline = s.status === 'online' || s.status === 'active';
                          const isBusy = s.availability === 'busy';
                          const nodeId = s.node_id;
                          const rate = s.rate_per_hour ?? 0;
                          const isEditingThis = editingNodePrice?.node_id == nodeId;
                          const isSavingThis  = savingNodePrice == nodeId;
                          return (
                            <tr key={nodeId ?? i} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                              <td className="px-4 py-2.5 text-[10px] font-mono text-foreground max-w-[180px] truncate" title={s.name}>
                                {s.name ?? `Node ${i + 1}`}
                              </td>
                              <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">
                                {s.gpu_name || '—'}
                              </td>
                              <td className="px-4 py-2.5">
                                <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${
                                  isOnline
                                    ? "text-neon-green border-neon-green/40 bg-neon-green/10"
                                    : "text-muted-foreground border-border bg-muted/20"
                                }`}>
                                  {isOnline ? "ONLINE" : "OFFLINE"}
                                </span>
                              </td>
                              <td className="px-4 py-2.5">
                                {isOnline ? (
                                  <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${
                                    isBusy
                                      ? "text-amber border-amber/40 bg-amber/10"
                                      : "text-muted-foreground border-border bg-muted/20"
                                  }`}>
                                    {isBusy ? "BUSY" : "IDLE"}
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground text-[9px] font-mono">—</span>
                                )}
                              </td>
                              <td className="px-4 py-2.5">
                                {isEditingThis ? (
                                  <div className="flex items-center gap-1">
                                    <span className="text-[10px] font-mono text-muted-foreground">$</span>
                                    <input
                                      type="number" step="0.01" min="0.001"
                                      value={editingNodePrice.value}
                                      onChange={e => setEditingNodePrice(p => ({ ...p, value: e.target.value }))}
                                      className="w-16 bg-muted border border-purple/40 rounded px-1 py-0.5 text-[10px] font-mono text-foreground focus:outline-none focus:border-purple"
                                      onKeyDown={e => {
                                        if (e.key === 'Enter') saveNodePrice(nodeId, editingNodePrice.value);
                                        if (e.key === 'Escape') setEditingNodePrice(null);
                                      }}
                                      autoFocus
                                    />
                                    <button onClick={() => saveNodePrice(nodeId, editingNodePrice.value)} disabled={isSavingThis}
                                      className="text-neon-green hover:text-neon-green/80 disabled:opacity-40">
                                      {isSavingThis ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                                    </button>
                                    <button onClick={() => setEditingNodePrice(null)} className="text-muted-foreground hover:text-foreground">
                                      <X className="w-3 h-3" />
                                    </button>
                                  </div>
                                ) : (
                                  <div className="flex items-center gap-1.5">
                                    <span className="text-[11px] font-mono font-semibold text-purple">${rate.toFixed(3)}</span>
                                    <button
                                      onClick={() => setEditingNodePrice({ node_id: nodeId, value: rate.toFixed(3) })}
                                      className="text-muted-foreground hover:text-purple transition-colors"
                                      title="Edit price"
                                    >
                                      <Pencil className="w-2.5 h-2.5" />
                                    </button>
                                  </div>
                                )}
                              </td>
                              <td className="px-4 py-2.5 text-[10px] font-mono text-neon-green">
                                {(s.income_24h_usd ?? 0) > 0
                                  ? `$${s.income_24h_usd.toFixed(2)}`
                                  : <span className="text-muted-foreground">—</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : !octaLoading && !octaNodesLoading ? (
                  <div className="px-4 py-4 text-center text-[10px] font-mono text-muted-foreground border-t border-border/50">
                    No linked OctaSpace nodes.
                  </div>
                ) : null
              )}

              {/* ── Unlinked OctaSpace nodes ── */}
              {octaOpen && unlinkedOctaNodes.length > 0 && !octaNodesLoading && (
                <div className="border-t border-amber/20 bg-amber/5">
                  <div className="px-4 py-2 flex items-center gap-2">
                    <Link2 className="w-3 h-3 text-amber flex-shrink-0" />
                    <span className="text-[9px] font-mono text-amber">
                      {unlinkedOctaNodes.length} node{unlinkedOctaNodes.length !== 1 ? 's' : ''} not linked to a registered GPU — link to filter in
                    </span>
                  </div>
                  {unlinkedOctaNodes.map(n => {
                    const unlinkableGPUs = myGPUs.filter(g => !g.platform_node_id);
                    return (
                      <div key={n.node_id} className="px-4 py-2 border-t border-amber/10 flex items-center gap-3 flex-wrap">
                        <span className="text-[10px] font-mono text-muted-foreground w-44 truncate" title={n.name}>{n.name}</span>
                        <span className="text-[9px] font-mono text-muted-foreground/60">#{n.node_id}</span>
                        <select
                          value={linkAssignments[n.node_id] || ''}
                          onChange={e => setLinkAssignments(prev => ({ ...prev, [n.node_id]: e.target.value }))}
                          className="flex-1 min-w-[160px] bg-muted border border-border rounded px-2 py-1 text-[10px] font-mono text-foreground focus:outline-none focus:border-amber"
                        >
                          <option value="">— Select registered GPU —</option>
                          {unlinkableGPUs.map(g => (
                            <option key={g.base44_id ?? g.gpu_id} value={g.base44_id ?? g.gpu_id}>
                              {g.model} · {g.gpu_id}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => linkOctaNode(n.node_id, linkAssignments[n.node_id])}
                          disabled={!linkAssignments[n.node_id] || linkingNode === n.node_id}
                          className="flex items-center gap-1.5 px-3 py-1 bg-amber/10 border border-amber/30 rounded text-[9px] font-mono text-amber hover:bg-amber/20 disabled:opacity-40 transition-colors"
                        >
                          {linkingNode === n.node_id
                            ? <RefreshCw className="w-3 h-3 animate-spin" />
                            : <Link2 className="w-3 h-3" />}
                          Link
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* ── Clore.ai sub-accordion ────────────────────────────────────── */}
            <div>
              <button
                onClick={() => setCloreOpen(o => !o)}
                className="w-full px-4 py-2.5 flex items-center gap-2.5 hover:bg-cyan/5 transition-colors text-left"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-cyan flex-shrink-0" />
                <span className="text-[10px] font-mono font-semibold text-cyan tracking-[2px] uppercase">Clore.ai</span>
                {cloreLoading ? (
                  <div className="w-3 h-3 border border-cyan border-t-transparent rounded-full animate-spin flex-shrink-0" />
                ) : (
                  <span className="text-[9px] font-mono text-muted-foreground">
                    {cloreServers.filter(s => s.rented).length} rented · {cloreServers.length} servers
                  </span>
                )}
                {(cloreData?.total_earnings_usd ?? 0) > 0 && (
                  <span className="text-[9px] font-mono text-neon-green">
                    ${cloreData.total_earnings_usd.toFixed(2)} balance
                  </span>
                )}
                <div className="ml-auto flex items-center gap-2">
                  {cloreStale && (
                    <span className="text-[8px] font-mono text-amber px-1.5 py-0.5 bg-amber/10 border border-amber/30 rounded">stale</span>
                  )}
                  {cloreData?.last_fetched && (
                    <span className="text-[9px] font-mono text-muted-foreground hidden sm:block">
                      {new Date(cloreData.last_fetched).toLocaleTimeString()}
                    </span>
                  )}
                  <button
                    onClick={e => { e.stopPropagation(); loadClore(true); }}
                    disabled={cloreLoading}
                    className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                    title="Refresh Clore"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${cloreLoading ? "animate-spin" : ""}`} />
                  </button>
                  <ChevronDown className={`w-3 h-3 text-muted-foreground transition-transform duration-200 ${cloreOpen ? "rotate-180" : ""}`} />
                </div>
              </button>

              {cloreOpen && (
                cloreServers.length > 0 ? (
                  <div className="overflow-x-auto border-t border-border/50">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border bg-muted/5">
                          {["Server", "GPU", "Online", "Rental", "Rate/hr", "GPUs"].map(h => (
                            <th key={h} className="px-4 py-2 text-[9px] tracking-[1.5px] uppercase text-muted-foreground text-left font-normal">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {cloreServers.map((s, i) => {
                          const isRented = s.rented;
                          return (
                            <tr key={s.server_id ?? i} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                              <td className="px-4 py-2.5 text-[10px] font-mono text-foreground max-w-[200px] truncate" title={s.name}>
                                {s.name ?? `Server #${s.server_id}`}
                              </td>
                              <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">
                                {s.gpu_model ?? '—'}
                              </td>
                              <td className="px-4 py-2.5">
                                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border text-neon-green border-neon-green/40 bg-neon-green/10">
                                  ACTIVE
                                </span>
                              </td>
                              <td className="px-4 py-2.5">
                                <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${
                                  isRented
                                    ? "text-amber border-amber/40 bg-amber/10"
                                    : "text-muted-foreground border-border bg-muted/20"
                                }`}>
                                  {isRented ? "RENTED" : "IDLE"}
                                </span>
                              </td>
                              <td className="px-4 py-2.5 text-[11px] font-mono font-semibold text-cyan">
                                ${(s.price_per_hour ?? 0).toFixed(3)}
                              </td>
                              <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">
                                {s.gpu_count ?? 1}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : !cloreLoading ? (
                  <div className="px-4 py-4 text-center text-[10px] font-mono text-muted-foreground border-t border-border/50">
                    No Clore.ai servers found.
                  </div>
                ) : null
              )}
            </div>

          </div>
        )}
      </div>

    </div>
  );
}
