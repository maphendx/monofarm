"use client";

// FlowView — live production pipeline
// Data sources:
//   - /api/printers (passed as prop, already polling)
//   - /api/history?limit=20&result=success  (polls every 20s → real packets)
//   - /api/warehouse/analytics              (polls every 60s → real stats)
//   - /api/warehouse/orders?order_status=new (polls every 60s → pending orders)
// Nodes are clickable and navigate to the relevant page.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Printer } from "@/lib/types";
import { api } from "@/lib/api";

// ── types ─────────────────────────────────────────────────────────────────────

interface HistoryItem {
  id: number;
  printer_name: string;
  file_name: string | null;
  finished_at: string | null;
  started_at: string;
  filament_g: number | null;
}

interface FlowGroup {
  key: string;
  label: string;
  items: Printer[];
}

interface FlowEvent {
  time: string;
  name: string;
  printer: string;
  qty: number;
  real: boolean; // came from real history vs simulation
}

interface ProdTemplate {
  name: string;
  qty: number;
  col: string;
  real: boolean;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function buildGroups(printers: Printer[]): FlowGroup[] {
  const map = new Map<string, FlowGroup>();
  for (const p of printers) {
    const key   = p.group_id != null ? `g${p.group_id}` : `k-${p.kind}`;
    const label = p.group_name
      ?? (p.kind === "bambu" ? "Bambu" : p.kind === "snapmaker_u1" ? "Snapmaker U1" : "Принтери");
    if (!map.has(key)) map.set(key, { key, label, items: [] });
    map.get(key)!.items.push(p);
  }
  return [...map.values()].slice(0, 4);
}

function printerColor(name: string): string {
  // deterministic color from printer name
  const colors = ["#f9a8d4", "#fbbf24", "#34d399", "#a78bfa", "#fb923c", "#22d3ee", "#f87171", "#e5e7eb"];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  return colors[h % colors.length];
}

function bezier(ax: number, ay: number, bx: number, by: number): string {
  const dx = Math.max(60, (bx - ax) * 0.5);
  return `M ${ax} ${ay} C ${ax + dx} ${ay}, ${bx - dx} ${by}, ${bx} ${by}`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ── component ─────────────────────────────────────────────────────────────────

interface WhStats {
  unitsProduced: number;
  unitsSold: number;
  pendingOrders: number;
  stockValue: number;
}

interface Props {
  printers: Printer[];
}

export function FlowView({ printers }: Props) {
  const router   = useRouter();
  const wrapRef  = useRef<HTMLDivElement>(null);
  const pauseRef = useRef(false);

  // cross-effect queue: history polling pushes here, animation loop drains it
  const pendingPackets = useRef<ProdTemplate[]>([]);
  const lastHistoryId  = useRef<number>(0);

  const [events,  setEvents]  = useState<FlowEvent[]>([]);
  const [qcStats, setQcStats] = useState({ inflight: 0, ok: 0, throughput: 0 });
  const [whStats, setWhStats] = useState<WhStats>({ unitsProduced: 0, unitsSold: 0, pendingOrders: 0, stockValue: 0 });
  const [paused,  setPaused]  = useState(false);

  // ── fetch warehouse analytics + pending orders ────────────────────────────
  useEffect(() => {
    async function fetch() {
      const [a, o] = await Promise.allSettled([
        api<{ units_produced: number; units_sold: number; stock_value: number }>(
          "/api/warehouse/analytics"
        ),
        api<{ id: number }[]>("/api/warehouse/orders?order_status=new"),
        api<{ id: number }[]>("/api/warehouse/orders?order_status=reserved"),
      ]);
      const analytics = a.status === "fulfilled" ? a.value : null;
      // o is the "new" orders result; index 2 would be "reserved" — but allSettled index 1 and 2
      // We just count non-empty arrays from both
      let pendingOrders = 0;
      if (o.status === "fulfilled") pendingOrders += (o.value as {id:number}[]).length;
      setWhStats({
        unitsProduced: analytics?.units_produced ?? 0,
        unitsSold:     analytics?.units_sold     ?? 0,
        pendingOrders,
        stockValue:    analytics ? Number(analytics.stock_value) : 0,
      });
    }
    fetch();
    const id = setInterval(fetch, 60_000);
    return () => clearInterval(id);
  }, []);

  // ── poll history → real packets + event log ───────────────────────────────
  useEffect(() => {
    async function poll() {
      try {
        const items = await api<HistoryItem[]>("/api/history?limit=20&result=success");
        if (!items.length) return;

        // update event log (real history items)
        setEvents(items.slice(0, 15).map(it => ({
          time:    fmtTime(it.finished_at ?? it.started_at),
          name:    (it.file_name ?? "Виріб").replace(/\.[^.]+$/, "").slice(0, 22),
          printer: it.printer_name,
          qty:     Math.max(1, Math.round((it.filament_g ?? 20) / 20)),
          real:    true,
        })));

        // only spawn packets for items we haven't seen before
        const maxId = Math.max(...items.map(it => it.id));
        const newItems = lastHistoryId.current > 0
          ? items.filter(it => it.id > lastHistoryId.current)
          : [];
        lastHistoryId.current = maxId;

        for (const it of newItems) {
          pendingPackets.current.push({
            name: (it.file_name ?? "Виріб").replace(/\.[^.]+$/, "").slice(0, 16),
            qty:  Math.max(1, Math.round((it.filament_g ?? 20) / 20)),
            col:  printerColor(it.printer_name),
            real: true,
          });
        }
      } catch {}
    }
    poll();
    const id = setInterval(poll, 20_000);
    return () => clearInterval(id);
  }, []);

  function togglePause() {
    pauseRef.current = !pauseRef.current;
    setPaused(pauseRef.current);
  }

  // ── main animation effect ─────────────────────────────────────────────────
  useEffect(() => {
    const wrap: HTMLDivElement = wrapRef.current!;
    if (!wrap || !printers.length) return;

    const groups = buildGroups(printers);
    let running  = true;
    let raf      = 0;
    let bgSpawnT = 3000; // background sim cadence (slower when real data flows)
    let lastTs   = 0;

    let lQcInf = 0, lQcOk = 0, lThru = 0;

    interface Packet {
      el:    HTMLDivElement;
      leg:   0 | 1;
      t:     number;
      p1:    SVGPathElement;
      p2:    SVGPathElement;
      prod:  ProdTemplate;
      speed: number;
    }
    const packets: Packet[] = [];

    // ── DOM setup ─────────────────────────────────────────────────────────────
    wrap.innerHTML = "";

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1;overflow:visible";
    wrap.appendChild(svg);

    const pkLayer = document.createElement("div");
    pkLayer.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:6";
    wrap.appendChild(pkLayer);

    // ── node builder ──────────────────────────────────────────────────────────
    const nodeEls: Record<string, HTMLDivElement> = {};

    function makeNode(
      id: string, xPct: number, yPct: number, html: string,
      href?: string,
    ): HTMLDivElement {
      const d = document.createElement(href ? "button" : "div");
      d.style.cssText = [
        "position:absolute",
        `left:${xPct}%`,
        `top:${yPct}%`,
        "transform:translate(-50%,-50%)",
        "z-index:4",
        "background:var(--bg-elevated)",
        "border:1px solid var(--border-strong)",
        "border-radius:var(--r-xl)",
        "box-shadow:var(--shadow-md)",
        "text-align:left",
        href ? "cursor:pointer;transition:box-shadow .15s,border-color .15s" : "",
      ].join(";");
      if (href) {
        d.addEventListener("mouseenter", () => {
          d.style.boxShadow = "0 0 0 2px var(--accent),var(--shadow-md)";
          d.style.borderColor = "var(--accent)";
        });
        d.addEventListener("mouseleave", () => {
          d.style.boxShadow = "var(--shadow-md)";
          d.style.borderColor = "var(--border-strong)";
        });
        d.addEventListener("click", () => router.push(href));
      }
      d.innerHTML = html;
      wrap.appendChild(d);
      nodeEls[id] = d as HTMLDivElement;
      return d as HTMLDivElement;
    }

    // ── node HTML ─────────────────────────────────────────────────────────────

    function stateColor(state: string | null): string {
      if (state === "printing")  return "var(--state-print)";
      if (state === "error")     return "var(--state-error)";
      if (state === "paused")    return "var(--state-warn)";
      if (state === "offline")   return "var(--state-offline)";
      return "var(--text-faint)";
    }

    function groupHtml(g: FlowGroup): string {
      const printing = g.items.filter(p => p.state === "printing").length;
      const rows = g.items.slice(0, 4).map(p => {
        const col = stateColor(p.state);
        const st  = p.state === "printing" ? (p.progress_pct != null ? `${Math.round(p.progress_pct)}%` : "друк")
                  : p.state === "error"    ? "помилка"
                  : p.state === "paused"   ? "пауза"
                  : p.state === "offline"  ? "офлайн" : "готовий";
        const job = p.job ? `<span style="flex:1;font-size:10px;color:var(--text-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:80px">${p.job}</span>` : "<span style='flex:1'></span>";
        return `<div style="display:flex;align-items:center;gap:5px;padding:2px 0">
          <span style="width:6px;height:6px;border-radius:50%;background:${col};flex-shrink:0"></span>
          <span style="font-size:11px;font-weight:500;font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:64px">${p.name}</span>
          ${job}
          <span style="font-size:10.5px;color:${col};flex-shrink:0">${st}</span>
        </div>`;
      }).join("");
      const more = g.items.length > 4 ? `<div style="font-size:10px;color:var(--text-faint);padding-top:3px">+ ще ${g.items.length - 4}</div>` : "";
      return `<div style="padding:10px 12px;min-width:200px">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/><rect x="6" y="18" width="12" height="4" rx="1"/></svg>
          <span style="font-size:12px;font-weight:600;color:var(--text-hi)">${g.label}</span>
          <span style="font-size:10.5px;color:var(--text-faint);margin-left:auto">${printing}/${g.items.length}</span>
        </div>
        <div>${rows}${more}</div>
      </div>`;
    }

    function qcHtml(): string {
      return `<div style="padding:10px 12px;min-width:180px">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
          <span style="font-size:12px;font-weight:600;color:var(--text-hi)">Контроль · QC</span>
          <span id="fl-qcThr" style="font-size:10.5px;color:var(--text-faint);margin-left:auto">0/год</span>
        </div>
        <div style="display:flex;justify-content:space-between;margin-bottom:6px">
          <span style="font-size:11px;color:var(--text-muted)">В обробці</span>
          <span id="fl-qcInf" style="font-size:13px;font-weight:600;color:var(--text-hi);font-family:var(--font-mono)">0</span>
        </div>
        <div style="height:1px;background:var(--border);margin:6px 0"></div>
        <div style="display:flex;flex-direction:column;gap:4px">
          <div style="display:flex;align-items:center;gap:6px"><span style="width:7px;height:7px;border-radius:50%;background:var(--state-ok);display:inline-block"></span><span style="font-size:11px;color:var(--text-muted)">Прийнято</span><span style="flex:1"></span><span id="fl-qcOk" style="font-size:11.5px;color:var(--state-ok);font-family:var(--font-mono)">0</span></div>
          <div style="display:flex;align-items:center;gap:6px"><span style="width:7px;height:7px;border-radius:50%;background:var(--state-warn);display:inline-block"></span><span style="font-size:11px;color:var(--text-muted)">На переробку</span><span style="flex:1"></span><span style="font-size:11.5px;color:var(--state-warn);font-family:var(--font-mono)">2</span></div>
        </div>
      </div>`;
    }

    function whHtml(): string {
      return `<div style="padding:10px 12px;min-width:210px">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"><path d="M22 8.35V20a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8.35A2 2 0 0 1 3.26 6.5l8-3.2a2 2 0 0 1 1.48 0l8 3.2A2 2 0 0 1 22 8.35Z"/><path d="M6 18h12"/><path d="M12 6v12"/></svg>
          <span style="font-size:12px;font-weight:600;color:var(--text-hi)">Склад</span>
          <span style="font-size:10px;color:var(--accent);margin-left:auto">→ перейти</span>
        </div>
        <div id="fl-wh-body" style="font-size:11px;color:var(--text-faint)">завантаження…</div>
      </div>`;
    }

    function shipHtml(pending: number): string {
      return `<div style="padding:10px 12px;min-width:172px">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"><path d="M5 17H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v5"/><circle cx="17" cy="17" r="3"/><circle cx="8" cy="17" r="3"/></svg>
          <span style="font-size:12px;font-weight:600;color:var(--text-hi)">Відправка</span>
          <span style="font-size:10px;color:var(--accent);margin-left:auto">→ замовлення</span>
        </div>
        <div style="display:flex;justify-content:space-between">
          <span style="font-size:11px;color:var(--text-muted)">Очікують відправки</span>
          <span id="fl-ship-ct" style="font-size:13px;font-weight:600;color:var(--text-hi);font-family:var(--font-mono)">${pending}</span>
        </div>
        <div style="height:1px;background:var(--border);margin:6px 0"></div>
        <div style="font-size:10.5px;color:var(--text-faint)">Нова Пошта · Укрпошта</div>
      </div>`;
    }

    // place nodes
    const groupYs = groups.length <= 1 ? [50]
                  : groups.length === 2 ? [35, 65]
                  : groups.length === 3 ? [24, 50, 76]
                  : [18, 38, 62, 82];
    for (let i = 0; i < groups.length; i++) {
      makeNode(`g${i}`, 15, groupYs[i], groupHtml(groups[i]), "/dashboard");
    }
    makeNode("qc",   50, 42, qcHtml(),           "/history");
    makeNode("wh",   84, 28, whHtml(),            "/warehouse/stock");
    makeNode("ship", 67, 76, shipHtml(whStats.pendingOrders), "/warehouse/orders");

    // ── edges ─────────────────────────────────────────────────────────────────
    interface EdgeRec { base: SVGPathElement }
    const edgeMap: Record<string, EdgeRec> = {};

    function anchor(id: string, side: "l" | "r") {
      const el = nodeEls[id];
      if (!el) return { x: 0, y: 0 };
      const r  = el.getBoundingClientRect();
      const cr = wrap.getBoundingClientRect();
      const y  = r.top - cr.top + r.height / 2;
      return side === "r" ? { x: r.right - cr.left, y } : { x: r.left - cr.left, y };
    }

    function buildEdges() {
      svg.innerHTML = "";
      const defs: [string, string, string][] = [];
      for (let i = 0; i < groups.length; i++) defs.push([`g${i}`, "qc", "#38bdf8"]);
      defs.push(["qc", "wh",   "#22d3ee"]);
      defs.push(["qc", "ship", "#22d3ee"]);

      for (const [s, t, col] of defs) {
        const a = anchor(s, "r");
        const b = anchor(t, "l");
        const d = bezier(a.x, a.y, b.x, b.y);

        const base = document.createElementNS("http://www.w3.org/2000/svg", "path");
        base.setAttribute("d", d); base.setAttribute("stroke", col);
        base.setAttribute("stroke-width", "1.5"); base.setAttribute("fill", "none");
        base.setAttribute("opacity", "0.2");
        svg.appendChild(base);

        const flow = document.createElementNS("http://www.w3.org/2000/svg", "path");
        flow.setAttribute("d", d); flow.setAttribute("stroke", col);
        flow.setAttribute("stroke-width", "1.5"); flow.setAttribute("fill", "none");
        flow.setAttribute("stroke-dasharray", "3 12");
        flow.setAttribute("stroke-linecap", "round");
        flow.setAttribute("opacity", "0.65");
        flow.style.animation = "flow-dash 1.2s linear infinite";
        svg.appendChild(flow);

        edgeMap[`${s}-${t}`] = { base };
      }
    }

    // ── packet spawn ──────────────────────────────────────────────────────────
    function updateQcDom() {
      const inf = wrap.querySelector<HTMLElement>("#fl-qcInf");
      const ok  = wrap.querySelector<HTMLElement>("#fl-qcOk");
      const thr = wrap.querySelector<HTMLElement>("#fl-qcThr");
      if (inf) inf.textContent = String(lQcInf);
      if (ok)  ok.textContent  = String(lQcOk);
      if (thr) thr.textContent = `${lThru}/год`;
    }

    function arrive(pk: Packet) {
      lQcOk  += pk.prod.qty;
      lThru  += pk.prod.qty;
      lQcInf  = Math.max(0, lQcInf - 1);
      updateQcDom();
      nodeEls["wh"]?.animate([
        { boxShadow: "0 0 0 2px rgba(34,211,238,.5),var(--shadow-md)" },
        { boxShadow: "var(--shadow-md)" },
      ], { duration: 600 });
      // update QC stats in React state (throttled via throughput counter)
      setQcStats({ inflight: lQcInf, ok: lQcOk, throughput: lThru });
    }

    function spawnOne(prod: ProdTemplate, gIdx?: number) {
      const i   = gIdx ?? Math.floor(Math.random() * groups.length);
      const e1  = edgeMap[`g${i}-qc`];
      const e2  = edgeMap["qc-wh"];
      if (!e1 || !e2) return;

      const el = document.createElement("div");
      el.style.cssText = "position:absolute;left:0;top:0;will-change:transform;pointer-events:none";
      el.innerHTML = `<div style="display:flex;align-items:center;gap:5px;padding:3px 8px;background:var(--bg-elevated);border:1px solid ${prod.real ? "var(--accent)" : "var(--border-strong)"};border-radius:var(--r-full);box-shadow:var(--shadow-md);font-size:10.5px;font-weight:600;color:var(--text-hi);white-space:nowrap;max-width:160px;overflow:hidden;text-overflow:ellipsis">
        <span style="width:7px;height:7px;border-radius:50%;background:${prod.col};flex-shrink:0"></span>
        <span style="overflow:hidden;text-overflow:ellipsis">${prod.name}</span>
        <span style="color:var(--text-faint);flex-shrink:0">×${prod.qty}</span></div>`;
      pkLayer.appendChild(el);

      lQcInf++;
      updateQcDom();
      packets.push({ el, leg: 0, t: 0, p1: e1.base, p2: e2.base, prod, speed: 0.38 + Math.random() * 0.24 });
    }

    // ── RAF loop ──────────────────────────────────────────────────────────────
    function frame(ts: number) {
      if (!running) return;
      const dt = Math.min(ts - (lastTs || ts), 50);
      lastTs = ts;

      if (!pauseRef.current) {
        // drain real packets queue first
        while (pendingPackets.current.length > 0) {
          spawnOne(pendingPackets.current.shift()!);
        }

        // background simulation (slower when history is active)
        bgSpawnT -= dt;
        if (bgSpawnT <= 0) {
          bgSpawnT = (lastHistoryId.current > 0 ? 5000 : 2000) + Math.random() * 2000;
          const BG_NAMES = ["Flexi Cheetah", "Брелок TPU", "Запчастина", "Деталь v2", "Корпус"];
          const BG_COLS  = ["#f9a8d4", "#e5e7eb", "#94a3b8", "#fbbf24", "#a78bfa"];
          const ri = Math.floor(Math.random() * BG_NAMES.length);
          spawnOne({ name: BG_NAMES[ri], qty: Math.ceil(Math.random() * 8), col: BG_COLS[ri], real: false });
        }

        for (let i = packets.length - 1; i >= 0; i--) {
          const pk = packets[i];
          const path = pk.leg === 0 ? pk.p1 : pk.p2;
          const len  = path.getTotalLength();
          if (len === 0) continue;
          pk.t += (pk.speed / len) * dt;
          const pt = path.getPointAtLength(Math.min(pk.t, 1) * len);
          pk.el.style.transform = `translate(${pt.x}px,${pt.y}px) translate(-50%,-50%)`;
          if (pk.t >= 1) {
            if (pk.leg === 0) {
              pk.leg = 1; pk.t = 0;
              lQcInf = Math.max(0, lQcInf - 1);
              updateQcDom();
            } else {
              arrive(pk);
              pk.el.remove();
              packets.splice(i, 1);
            }
          }
        }
      }

      raf = requestAnimationFrame(frame);
    }

    const ro = new ResizeObserver(() => requestAnimationFrame(buildEdges));
    ro.observe(wrap);
    requestAnimationFrame(() => {
      buildEdges();
      setTimeout(() => spawnOne({ name: "Завантаження…", qty: 1, col: "#22d3ee", real: false }), 600);
    });
    raf = requestAnimationFrame(frame);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      packets.forEach(pk => pk.el.remove());
      wrap.innerHTML = "";
    };
  }, [printers]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── update warehouse node body when stats arrive ──────────────────────────
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const body = wrap.querySelector<HTMLElement>("#fl-wh-body");
    if (!body) return;
    if (whStats.unitsProduced === 0 && whStats.stockValue === 0) return;
    body.innerHTML = [
      `<div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="color:var(--text-muted)">Виготовлено</span><span style="font-family:var(--font-mono);font-weight:600;color:var(--text-hi)">${whStats.unitsProduced}</span></div>`,
      `<div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="color:var(--text-muted)">Продано</span><span style="font-family:var(--font-mono);font-weight:600;color:var(--text-hi)">${whStats.unitsSold}</span></div>`,
      whStats.stockValue > 0 ? `<div style="display:flex;justify-content:space-between"><span style="color:var(--text-muted)">Вартість</span><span style="font-family:var(--font-mono);font-weight:600;color:var(--accent)">${Math.round(whStats.stockValue).toLocaleString("uk-UA")} ₴</span></div>` : "",
    ].join("");
    const shipCt = wrap.querySelector<HTMLElement>("#fl-ship-ct");
    if (shipCt) shipCt.textContent = String(whStats.pendingOrders);
  }, [whStats]);

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-3 h-full">

      {/* header */}
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[11px] text-[var(--text-faint)]">
          Принтери → QC → Склад · дані оновлюються кожні 20 с
        </p>
        <div className="ml-auto flex items-center gap-2">
          <span className="flex items-center gap-1.5 rounded-full border border-[var(--border)] px-2.5 py-1 text-[11px] text-[var(--text-muted)]">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#38bdf8]" />друк → контроль
          </span>
          <span className="flex items-center gap-1.5 rounded-full border border-[var(--border)] px-2.5 py-1 text-[11px] text-[var(--text-muted)]">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#22d3ee]" />контроль → склад
          </span>
          <span className="flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[rgba(34,197,94,.06)] px-2.5 py-1 text-[11px] text-[var(--state-ok)]">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--state-ok)]" />live
          </span>
          <button onClick={togglePause} className="rounded-md border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)] transition-colors">
            {paused ? "▶ Старт" : "⏸ Пауза"}
          </button>
        </div>
      </div>

      {/* canvas + sidebar */}
      <div className="flex min-h-0 flex-1 gap-3" style={{ minHeight: 420 }}>

        {/* canvas — nodes are clickable (navigate on click) */}
        <div
          ref={wrapRef}
          className="relative flex-1 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg)]"
          style={{
            backgroundImage: "radial-gradient(circle, var(--border) 1px, transparent 1px)",
            backgroundSize: "28px 28px",
          }}
        />

        {/* sidebar */}
        <div className="flex w-52 shrink-0 flex-col gap-3">

          {/* QC stats */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-3 space-y-2">
            <p className="text-[11px] font-medium text-[var(--text-faint)]">Контроль якості</p>
            <div className="flex justify-between text-xs"><span className="text-[var(--text-muted)]">Прийнято (сесія)</span><span className="font-mono font-semibold text-[var(--state-ok)]">{qcStats.ok}</span></div>
            <div className="flex justify-between text-xs"><span className="text-[var(--text-muted)]">В обробці</span><span className="font-mono font-semibold text-[var(--text-hi)]">{qcStats.inflight}</span></div>
            <div className="flex justify-between text-xs"><span className="text-[var(--text-muted)]">Пропускна здатність</span><span className="font-mono font-semibold text-[var(--accent)]">{qcStats.throughput}/год</span></div>
          </div>

          {/* warehouse stats */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-3 space-y-2 cursor-pointer hover:border-[var(--accent)] transition-colors" onClick={() => router.push("/warehouse/analytics")}>
            <p className="text-[11px] font-medium text-[var(--text-faint)]">Склад · цей місяць</p>
            <div className="flex justify-between text-xs"><span className="text-[var(--text-muted)]">Виготовлено</span><span className="font-mono font-semibold text-[var(--text-hi)]">{whStats.unitsProduced}</span></div>
            <div className="flex justify-between text-xs"><span className="text-[var(--text-muted)]">Продано</span><span className="font-mono font-semibold text-[var(--text-hi)]">{whStats.unitsSold}</span></div>
            <div className="flex justify-between text-xs"><span className="text-[var(--text-muted)]">Замовлень</span><span className="font-mono font-semibold text-[var(--state-warn)]">{whStats.pendingOrders}</span></div>
          </div>

          {/* event log — real history */}
          <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]">
            <div className="border-b border-[var(--border)] px-3 py-2 flex items-center justify-between">
              <span className="text-[10.5px] font-medium text-[var(--text-faint)]">Останні завершення</span>
              <button onClick={() => router.push("/history")} className="text-[10px] text-[var(--accent)] hover:underline">всі →</button>
            </div>
            <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
              {events.length === 0 ? (
                <p className="px-2 py-2 text-[10.5px] text-[var(--text-faint)]">Немає завершених робіт…</p>
              ) : (
                events.slice(0, 15).map((ev, i) => (
                  <div key={i} onClick={() => router.push("/history")} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[10.5px] hover:bg-[var(--surface-hi)] cursor-pointer">
                    <span className="font-mono text-[9.5px] text-[var(--text-faint)] shrink-0">{ev.time}</span>
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-[var(--text)]">{ev.name}</div>
                      <div className="truncate text-[9.5px] text-[var(--text-faint)]">{ev.printer}</div>
                    </div>
                    {ev.real && <span className="font-mono font-semibold text-[var(--state-ok)] shrink-0">✓</span>}
                  </div>
                ))
              )}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
