"use client";

// FlowView — animated production pipeline
// Printer groups → QC → Warehouse/Shipping
// Packets animate along bezier SVG paths in a RAF loop (imperative canvas inside useEffect).

import { useEffect, useRef, useState } from "react";
import type { Printer } from "@/lib/types";
import { api } from "@/lib/api";

// ── types ─────────────────────────────────────────────────────────────────────

interface FlowGroup {
  key: string;
  label: string;
  items: Printer[];
}

interface FlowEvent {
  time: string;
  name: string;
  from: string;
  zone: string;
  qty: number;
}

interface ProdTemplate {
  name: string;
  qty: number;
  col: string;
  zone: "B" | "C" | "D";
}

// ── default products pool ─────────────────────────────────────────────────────

const DEFAULT_PRODUCTS: ProdTemplate[] = [
  { name: "Flexi Cheetah",   qty: 16, col: "#f9a8d4", zone: "B" },
  { name: "Брелок BS Pass",  qty: 28, col: "#e5e7eb", zone: "B" },
  { name: "Свинка-копилка",  qty: 1,  col: "#f9a8d4", zone: "B" },
  { name: "Холдер 6s3p",     qty: 1,  col: "#e5e7eb", zone: "B" },
  { name: "RX-холдер TPU",   qty: 4,  col: "#6b7280", zone: "B" },
  { name: "Дрон-деталь",     qty: 6,  col: "#94a3b8", zone: "C" },
];

// ── group printers ────────────────────────────────────────────────────────────

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

// ── SVG bezier ────────────────────────────────────────────────────────────────

function bezier(ax: number, ay: number, bx: number, by: number): string {
  const dx = Math.max(60, (bx - ax) * 0.5);
  return `M ${ax} ${ay} C ${ax + dx} ${ay}, ${bx - dx} ${by}, ${bx} ${by}`;
}

// ── component ─────────────────────────────────────────────────────────────────

interface Props {
  printers: Printer[];
}

export function FlowView({ printers }: Props) {
  const wrapRef  = useRef<HTMLDivElement>(null);
  const pauseRef = useRef(false);
  const prodRef  = useRef<ProdTemplate[]>(DEFAULT_PRODUCTS);

  const [events,  setEvents]  = useState<FlowEvent[]>([]);
  const [stats,   setStats]   = useState({ throughput: 0, qcOk: 0, qcInflight: 0 });
  const [zones,   setZones]   = useState({ B: 283, C: 116, D: 6 });
  const [paused,  setPaused]  = useState(false);

  // Try to load real product names from warehouse
  useEffect(() => {
    api<{ id: number; name: string }[]>("/api/warehouse/products?limit=20")
      .then((ps) => {
        if (!ps.length) return;
        const cols = ["#f9a8d4", "#e5e7eb", "#fbbf24", "#a78bfa", "#6b7280", "#94a3b8", "#34d399", "#fb923c"];
        prodRef.current = ps.slice(0, 8).map((p, i) => ({
          name: p.name,
          qty:  Math.floor(Math.random() * 24) + 1,
          col:  cols[i % cols.length],
          zone: (i % 4 === 3 ? "C" : "B") as "B" | "C",
        }));
      })
      .catch(() => {});
  }, []);

  // Toggle pause via ref so RAF loop sees it without re-render
  function togglePause() {
    pauseRef.current = !pauseRef.current;
    setPaused(pauseRef.current);
  }

  // ── main animation effect ──────────────────────────────────────────────────
  useEffect(() => {
    // Explicit non-null type so closures don't lose narrowing
    const wrap: HTMLDivElement = wrapRef.current!;
    if (!wrap || !printers.length) return;

    const groups = buildGroups(printers);
    let running  = true;
    let raf      = 0;
    let spawnT   = 800;
    let lastTs   = 0;

    // local mutable stats (avoid setState in every frame)
    let lQcInf = 0, lQcOk = 0, lThru = 0;
    const lZones: Record<string, number> = { B: 283, C: 116, D: 6 };

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
    const eventsAcc: FlowEvent[] = [];

    // ── build DOM ─────────────────────────────────────────────────────────────
    wrap.innerHTML = "";
    wrap.style.position = "relative";

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1;overflow:visible";
    wrap.appendChild(svg);

    const pkLayer = document.createElement("div");
    pkLayer.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:6";
    wrap.appendChild(pkLayer);

    // ── node builder ──────────────────────────────────────────────────────────
    const nodeEls: Record<string, HTMLDivElement> = {};

    function makeNode(id: string, xPct: number, yPct: number, html: string): HTMLDivElement {
      const d = document.createElement("div");
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
      ].join(";");
      d.innerHTML = html;
      wrap.appendChild(d);
      nodeEls[id] = d;
      return d;
    }

    // ── node HTML builders ─────────────────────────────────────────────────────

    function printerStateColor(state: string | null): string {
      if (state === "printing")  return "var(--state-print)";
      if (state === "error")     return "var(--state-error)";
      if (state === "paused")    return "var(--state-warn)";
      if (state === "offline")   return "var(--state-offline)";
      return "var(--text-faint)";
    }

    function groupNodeHtml(g: FlowGroup): string {
      const printing = g.items.filter(p => p.state === "printing").length;
      const rows = g.items.slice(0, 4).map(p => {
        const stCol = printerStateColor(p.state);
        const st = p.state === "printing"
          ? (p.progress_pct != null ? `${Math.round(p.progress_pct)}%` : "друк")
          : p.state === "error"    ? "помилка"
          : p.state === "paused"  ? "пауза"
          : p.state === "offline" ? "офлайн"
          : "готовий";
        const jobLabel = p.job ? `<span style="flex:1;font-size:10px;color:var(--text-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:90px">${p.job}</span>` : '<span style="flex:1"></span>';
        return `<div style="display:flex;align-items:center;gap:5px;padding:2px 0">
          <span style="width:6px;height:6px;border-radius:50%;background:${stCol};flex-shrink:0"></span>
          <span style="font-size:11px;font-weight:500;min-width:40px;font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60px">${p.name}</span>
          ${jobLabel}
          <span style="font-size:10.5px;color:${stCol};flex-shrink:0">${st}</span>
        </div>`;
      }).join("");
      const more = g.items.length > 4
        ? `<div style="font-size:10px;color:var(--text-faint);padding-top:3px">+ ще ${g.items.length - 4}</div>` : "";
      return `<div style="padding:10px 12px;min-width:200px">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/><rect x="6" y="18" width="12" height="4" rx="1"/></svg>
          <span style="font-size:12px;font-weight:600;color:var(--text-hi)">${g.label}</span>
          <span style="font-size:10.5px;color:var(--text-faint);margin-left:auto">${printing}/${g.items.length}</span>
        </div>
        <div>${rows}${more}</div>
      </div>`;
    }

    function qcNodeHtml(): string {
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

    function whNodeHtml(): string {
      const zones: ["B"|"C"|"D", string, number, number, string][] = [
        ["B", "B · Готові",    283, 62, "var(--state-ok)"],
        ["C", "C · Деталі",    116, 40, "var(--state-print)"],
        ["D", "D · Відправка",  6,  18, "var(--state-warn)"],
      ];
      const rows = zones.map(([id, label, count, fill, col]) =>
        `<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
          <span style="font-size:10.5px;color:var(--text-muted);width:90px;white-space:nowrap">${label}</span>
          <div style="flex:1;height:5px;background:var(--surface-hi);border-radius:var(--r-full);overflow:hidden">
            <div id="fl-zf-${id}" style="height:100%;width:${fill}%;background:${col};border-radius:var(--r-full);transition:width .5s ease"></div>
          </div>
          <span id="fl-zc-${id}" style="font-size:11px;font-weight:600;color:var(--text-hi);min-width:28px;text-align:right;font-family:var(--font-mono)">${count}</span>
        </div>`
      ).join("");
      return `<div style="padding:10px 12px;min-width:220px">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"><path d="M22 8.35V20a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8.35A2 2 0 0 1 3.26 6.5l8-3.2a2 2 0 0 1 1.48 0l8 3.2A2 2 0 0 1 22 8.35Z"/><path d="M6 18h12"/><path d="M12 6v12"/></svg>
          <span style="font-size:12px;font-weight:600;color:var(--text-hi)">Склад</span>
        </div>
        ${rows}
      </div>`;
    }

    function shipNodeHtml(): string {
      return `<div style="padding:10px 12px;min-width:172px">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"><path d="M5 17H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v5"/><circle cx="17" cy="17" r="3"/><circle cx="8" cy="17" r="3"/></svg>
          <span style="font-size:12px;font-weight:600;color:var(--text-hi)">Відправка</span>
        </div>
        <div style="display:flex;justify-content:space-between;margin-bottom:6px">
          <span style="font-size:11px;color:var(--text-muted)">Замовлень</span>
          <span style="font-size:13px;font-weight:600;color:var(--text-hi);font-family:var(--font-mono)">4</span>
        </div>
        <div style="height:1px;background:var(--border);margin:6px 0"></div>
        <div style="font-size:10.5px;color:var(--text-faint)">Нова Пошта · Укрпошта</div>
      </div>`;
    }

    // ── place nodes ────────────────────────────────────────────────────────────
    const groupYs = groups.length <= 1 ? [50]
                  : groups.length === 2 ? [35, 65]
                  : groups.length === 3 ? [24, 50, 76]
                  : [18, 38, 62, 82];

    for (let i = 0; i < groups.length; i++) {
      makeNode(`g${i}`, 15, groupYs[i], groupNodeHtml(groups[i]));
    }
    makeNode("qc",   50, 42, qcNodeHtml());
    makeNode("wh",   84, 28, whNodeHtml());
    makeNode("ship", 67, 76, shipNodeHtml());

    // ── edge building (runs after layout) ────────────────────────────────────

    interface EdgeRec { base: SVGPathElement; flow: SVGPathElement }
    const edgeMap: Record<string, EdgeRec> = {};

    function anchor(id: string, side: "l" | "r"): { x: number; y: number } {
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
        base.setAttribute("d", d);
        base.setAttribute("stroke", col);
        base.setAttribute("stroke-width", "1.5");
        base.setAttribute("fill", "none");
        base.setAttribute("opacity", "0.2");
        svg.appendChild(base);

        const flow = document.createElementNS("http://www.w3.org/2000/svg", "path");
        flow.setAttribute("d", d);
        flow.setAttribute("stroke", col);
        flow.setAttribute("stroke-width", "1.5");
        flow.setAttribute("fill", "none");
        flow.setAttribute("stroke-dasharray", "3 12");
        flow.setAttribute("stroke-linecap", "round");
        flow.setAttribute("opacity", "0.7");
        flow.style.animation = "flow-dash 1.2s linear infinite";
        svg.appendChild(flow);

        edgeMap[`${s}-${t}`] = { base, flow };
      }
    }

    // ── packet animation ──────────────────────────────────────────────────────

    function updateQcDom() {
      const inf = wrap.querySelector<HTMLElement>("#fl-qcInf");
      const ok  = wrap.querySelector<HTMLElement>("#fl-qcOk");
      const thr = wrap.querySelector<HTMLElement>("#fl-qcThr");
      if (inf) inf.textContent = String(lQcInf);
      if (ok)  ok.textContent  = String(lQcOk);
      if (thr) thr.textContent = `${lThru}/год`;
    }

    function arrive(pk: Packet) {
      const z   = pk.prod.zone;
      lZones[z] = (lZones[z] ?? 0) + pk.prod.qty;
      lQcOk    += pk.prod.qty;
      lThru    += pk.prod.qty;
      lQcInf    = Math.max(0, lQcInf - 1);
      updateQcDom();

      const zc = wrap.querySelector<HTMLElement>(`#fl-zc-${z}`);
      const zf = wrap.querySelector<HTMLElement>(`#fl-zf-${z}`);
      if (zc) {
        zc.textContent = String(lZones[z]);
        zc.animate([
          { color: "#22d3ee", transform: "scale(1.3)" },
          { color: "",        transform: "scale(1)" },
        ], { duration: 500, easing: "cubic-bezier(.16,1,.3,1)" });
      }
      if (zf) {
        const w = Math.min(95, parseFloat(zf.style.width) + pk.prod.qty * 0.12);
        zf.style.width = w + "%";
      }
      nodeEls["wh"]?.animate([
        { boxShadow: "0 0 0 2px rgba(34,211,238,.5),var(--shadow-md)" },
        { boxShadow: "var(--shadow-md)" },
      ], { duration: 600 });

      const now = new Date();
      const tm  = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      eventsAcc.unshift({ time: tm, name: pk.prod.name, from: groups[0]?.label ?? "", zone: z, qty: pk.prod.qty });
      if (eventsAcc.length > 20) eventsAcc.pop();
      setEvents([...eventsAcc]);
      setStats({ throughput: lThru, qcOk: lQcOk, qcInflight: lQcInf });
      setZones({ B: lZones.B, C: lZones.C, D: lZones.D });
    }

    function spawnPacket() {
      const pool = prodRef.current;
      if (!pool.length) return;
      const prod = pool[Math.floor(Math.random() * pool.length)];
      const gIdx = Math.floor(Math.random() * groups.length);
      const e1   = edgeMap[`g${gIdx}-qc`];
      const e2   = edgeMap["qc-wh"];
      if (!e1 || !e2) return;

      const el = document.createElement("div");
      el.style.cssText = "position:absolute;left:0;top:0;will-change:transform;pointer-events:none";
      el.innerHTML = `<div style="display:flex;align-items:center;gap:5px;padding:3px 8px;background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--r-full);box-shadow:var(--shadow-md);font-size:10.5px;font-weight:600;color:var(--text-hi);white-space:nowrap">
        <span style="width:7px;height:7px;border-radius:50%;background:${prod.col};flex-shrink:0"></span>+${prod.qty}</div>`;
      pkLayer.appendChild(el);

      lQcInf++;
      updateQcDom();
      packets.push({ el, leg: 0, t: 0, p1: e1.base, p2: e2.base, prod, speed: 0.42 + Math.random() * 0.28 });
    }

    // ── RAF loop ──────────────────────────────────────────────────────────────

    function frame(ts: number) {
      if (!running) return;
      const dt = Math.min(ts - (lastTs || ts), 50);
      lastTs = ts;

      if (!pauseRef.current) {
        spawnT -= dt;
        if (spawnT <= 0) {
          spawnT = 1400 + Math.random() * 1600;
          spawnPacket();
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

    // ── resize observer ───────────────────────────────────────────────────────
    const ro = new ResizeObserver(() => requestAnimationFrame(buildEdges));
    ro.observe(wrap);

    requestAnimationFrame(() => {
      buildEdges();
      setTimeout(() => spawnPacket(), 500);
      setTimeout(() => spawnPacket(), 1200);
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

  // ── render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-3 h-full">

      {/* header row */}
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <p className="text-[11px] text-[var(--text-faint)] mt-0.5 max-w-xs">
            Готові вироби рухаються з принтерів через контроль на склад
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="flex items-center gap-1.5 rounded-full border border-[var(--border)] px-2.5 py-1 text-[11px] text-[var(--text-muted)]">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#38bdf8]" />
            друк → контроль
          </span>
          <span className="flex items-center gap-1.5 rounded-full border border-[var(--border)] px-2.5 py-1 text-[11px] text-[var(--text-muted)]">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#22d3ee]" />
            контроль → склад
          </span>
          <span className="flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[rgba(34,197,94,.06)] px-2.5 py-1 text-[11px] text-[var(--state-ok)]">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--state-ok)]" />
            live
          </span>
          <button
            onClick={togglePause}
            className="rounded-md border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)] transition-colors"
          >
            {paused ? "▶ Старт" : "⏸ Пауза"}
          </button>
        </div>
      </div>

      {/* canvas + sidebar */}
      <div className="flex min-h-0 flex-1 gap-3" style={{ minHeight: 420 }}>

        {/* animated canvas */}
        <div
          ref={wrapRef}
          className="relative flex-1 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg)]"
          style={{
            backgroundImage: "radial-gradient(circle, var(--border) 1px, transparent 1px)",
            backgroundSize: "28px 28px",
          }}
        />

        {/* right sidebar */}
        <div className="flex w-52 shrink-0 flex-col gap-3">

          {/* throughput stats */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-3 space-y-2">
            <p className="text-[11px] font-medium text-[var(--text-faint)]">Сесія</p>
            <div className="flex justify-between text-xs">
              <span className="text-[var(--text-muted)]">Пройшло QC</span>
              <span className="font-mono font-semibold text-[var(--text-hi)]">{stats.qcOk}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-[var(--text-muted)]">В обробці</span>
              <span className="font-mono font-semibold text-[var(--text-hi)]">{stats.qcInflight}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-[var(--text-muted)]">Пропускна здатність</span>
              <span className="font-mono font-semibold text-[var(--accent)]">{stats.throughput}/год</span>
            </div>
          </div>

          {/* warehouse zones */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-3 space-y-2.5">
            <p className="text-[11px] font-medium text-[var(--text-faint)]">Склад</p>
            {([ ["B", "B · Готові", "var(--state-ok)"], ["C", "C · Деталі", "var(--state-print)"], ["D", "D · Відправка", "var(--state-warn)"] ] as [keyof typeof zones, string, string][]).map(([id, label, col]) => (
              <div key={id} className="space-y-1">
                <div className="flex justify-between text-[10.5px]">
                  <span className="text-[var(--text-muted)]">{label}</span>
                  <span className="font-mono font-semibold text-[var(--text-hi)]">{zones[id]}</span>
                </div>
                <div className="h-1 rounded-full bg-[var(--surface-hi)] overflow-hidden">
                  <div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.min(95, (zones[id] / 400) * 100)}%`, background: col }} />
                </div>
              </div>
            ))}
          </div>

          {/* event log */}
          <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]">
            <div className="border-b border-[var(--border)] px-3 py-2 text-[10.5px] font-medium text-[var(--text-faint)]">
              стрічка подій
            </div>
            <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
              {events.length === 0 ? (
                <p className="px-2 py-2 text-[10.5px] text-[var(--text-faint)]">Очікуємо…</p>
              ) : (
                events.slice(0, 15).map((ev, i) => (
                  <div key={i} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[10.5px] hover:bg-[var(--surface-hi)]">
                    <span className="font-mono text-[9.5px] text-[var(--text-faint)] shrink-0">{ev.time}</span>
                    <span className="flex-1 truncate text-[var(--text-muted)]">{ev.name}</span>
                    <span className="font-mono font-semibold text-[var(--state-ok)] shrink-0">+{ev.qty}</span>
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
