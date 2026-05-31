"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { LabelCanvas, substituteVars, type LabelDataVars, type LabelElement, type LabelTemplate } from "@/components/warehouse/LabelCanvas";
import { generateCode128Url } from "@/components/warehouse/labelUtils";

// ─── Constants ────────────────────────────────────────────────────────────────

const PX_PER_MM = 96 / 25.4;
const CANVAS_W_PX = 560;
const GRID_MM = 0.5;

const ITEM_TYPES = [
  { value: "cell",      label: "Клітинка" },
  { value: "product",   label: "Товар" },
  { value: "action",    label: "Дія сканера" },
  { value: "universal", label: "Універсальний" },
];

const SAMPLE_VARS: Record<string, LabelDataVars> = {
  cell:      { code: "A1", zone_name: "Стелаж 1", notes: "Верхня полиця", CELL_QR: "CELL:42" },
  product:   { name: "Брелок Dragon", sku: "P-0312", barcode: "03026100", categories: "Брелоки · Дракони", PROD_QR: "03026100" },
  action:    { label: "Списання", code: "ACTION:WRITE_OFF", ACTION_QR: "ACTION:WRITE_OFF" },
  universal: { code: "A1", name: "Товар", sku: "SKU-001", CELL_QR: "CELL:1", PROD_QR: "SKU-001", ACTION_QR: "ACTION:RECEIVE" },
};

const ALL_VARS = [
  "{{name}}", "{{sku}}", "{{barcode}}", "{{categories}}", "{{PROD_QR}}",
  "{{code}}", "{{zone_name}}", "{{notes}}", "{{CELL_QR}}",
  "{{label}}", "{{ACTION_QR}}",
];

const EL_ICONS: Record<string, string> = {
  text: "T", qr: "▦", barcode: "▐▌", image: "🖼", rect: "□", line: "─",
};

const EL_LABELS: Record<string, string> = {
  text: "Текст", qr: "QR", barcode: "Штрих-код", image: "Фото", rect: "Рамка", line: "Лінія",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uid() { return Math.random().toString(36).slice(2, 8); }
function snap(v: number) { return Math.round(v / GRID_MM) * GRID_MM; }
function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

function defaultEl(type: LabelElement["type"], tpl: LabelTemplate): LabelElement {
  const cx = Math.round(tpl.width_mm / 2 - 15);
  const cy = Math.round(tpl.height_mm / 2 - 5);
  switch (type) {
    case "text":    return { id: uid(), type, x: cx, y: cy, w: 30, h: 7,  text: "{{name}}", fontSize: 4.5, fontWeight: "normal", color: "#111111", align: "left" };
    case "qr":      return { id: uid(), type, x: cx, y: cy, w: 20, h: 20, value: "{{CELL_QR}}", level: "M" };
    case "barcode": return { id: uid(), type, x: cx, y: cy, w: 35, h: 15, value: "{{PROD_QR}}", barcodeFormat: "CODE128", showText: true };
    case "image":   return { id: uid(), type, x: cx, y: cy, w: 20, h: 20, source: "product_image", objectFit: "cover" };
    case "rect":    return { id: uid(), type, x: cx, y: cy, w: 30, h: 10, borderColor: "#cccccc", borderWidth: 0.3, fillColor: "transparent", borderRadius: 0 };
    case "line":    return { id: uid(), type, x: cx, y: cy, w: 40, h: 0.5, strokeColor: "#cccccc", strokeWidth: 0.5, orientation: "horizontal" };
  }
}

// ─── Resize handle positions ──────────────────────────────────────────────────

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

const HANDLES: Handle[] = ["nw","n","ne","e","se","s","sw","w"];
const HANDLE_CURSOR: Record<Handle, string> = {
  nw: "nw-resize", n: "n-resize", ne: "ne-resize", e: "e-resize",
  se: "se-resize", s: "s-resize", sw: "sw-resize", w: "w-resize",
};

function handlePos(h: Handle, w: number, hh: number): { left: number; top: number } {
  const cx = w / 2, cy = hh / 2;
  const map: Record<Handle, [number, number]> = {
    nw: [0, 0], n: [cx, 0], ne: [w, 0],
    e: [w, cy], se: [w, hh], s: [cx, hh],
    sw: [0, hh], w: [0, cy],
  };
  return { left: map[h][0], top: map[h][1] };
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function LabelsPage() {
  const [templates, setTemplates] = useState<LabelTemplate[]>([]);
  const [editing,   setEditing]   = useState<LabelTemplate | null>(null);
  const [selId,     setSelId]     = useState<string | null>(null);
  const [saving,    setSaving]    = useState(false);
  const [bcUrls,    setBcUrls]    = useState<Record<string, string>>({});

  const canvasRef  = useRef<HTMLDivElement>(null);
  const dragRef    = useRef<{ id: string; startCX: number; startCY: number; origX: number; origY: number } | null>(null);
  const resizeRef  = useRef<{ id: string; handle: Handle; startCX: number; startCY: number; origEl: LabelElement } | null>(null);
  const inFlight   = useRef(false);

  const load = useCallback(async () => {
    const data = await api<LabelTemplate[]>("/api/warehouse/label-templates");
    setTemplates(data);
  }, []);
  useEffect(() => { load(); }, [load]);

  // Canvas scale and size
  const scale    = editing ? CANVAS_W_PX / (editing.width_mm * PX_PER_MM) : 1;
  const canvasH  = editing ? Math.round(editing.height_mm * PX_PER_MM * scale) : 0;
  const tplNatW  = editing ? editing.width_mm  * PX_PER_MM : 0;
  const tplNatH  = editing ? editing.height_mm * PX_PER_MM : 0;

  // Pre-render barcodes for preview
  useEffect(() => {
    if (!editing) return;
    const vars = SAMPLE_VARS[editing.item_type] ?? SAMPLE_VARS.universal;
    const hPx  = Math.round(editing.height_mm * PX_PER_MM);
    editing.elements.filter(e => e.type === "barcode").forEach(el => {
      const raw = substituteVars(el.value ?? "", vars as Record<string, string>);
      if (!raw || bcUrls[raw]) return;
      generateCode128Url(raw, hPx).then(url => {
        if (url) setBcUrls(p => ({ ...p, [raw]: url }));
      });
    });
  }, [editing?.elements]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mutations ────────────────────────────────────────────────────────────────

  function patchEl(id: string, patch: Partial<LabelElement>) {
    setEditing(prev => prev ? ({
      ...prev,
      elements: prev.elements.map(e => e.id === id ? { ...e, ...patch } : e),
    }) : null);
  }

  function addEl(type: LabelElement["type"]) {
    if (!editing) return;
    const el = defaultEl(type, editing);
    setEditing(p => p ? ({ ...p, elements: [...p.elements, el] }) : null);
    setSelId(el.id);
  }

  function deleteEl(id: string) {
    setEditing(p => p ? ({ ...p, elements: p.elements.filter(e => e.id !== id) }) : null);
    if (selId === id) setSelId(null);
  }

  function moveEl(id: string, dir: -1 | 1) {
    setEditing(prev => {
      if (!prev) return null;
      const arr = [...prev.elements];
      const i = arr.findIndex(e => e.id === id);
      const j = i + dir;
      if (j < 0 || j >= arr.length) return prev;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      return { ...prev, elements: arr };
    });
  }

  // ── Canvas mouse events ───────────────────────────────────────────────────────

  function screenToMm(cx: number, cy: number): { x: number; y: number } {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (cx - rect.left)  / scale / PX_PER_MM,
      y: (cy - rect.top) / scale / PX_PER_MM,
    };
  }

  function onElMouseDown(e: React.MouseEvent, el: LabelElement) {
    e.stopPropagation(); e.preventDefault();
    setSelId(el.id);
    dragRef.current = { id: el.id, startCX: e.clientX, startCY: e.clientY, origX: el.x, origY: el.y };
  }

  function onHandleMouseDown(e: React.MouseEvent, el: LabelElement, handle: Handle) {
    e.stopPropagation(); e.preventDefault();
    resizeRef.current = { id: el.id, handle, startCX: e.clientX, startCY: e.clientY, origEl: { ...el } };
  }

  useEffect(() => {
    function onMove(e: MouseEvent) {
      // drag
      if (dragRef.current && editing) {
        const { id, startCX, startCY, origX, origY } = dragRef.current;
        const dxMm = (e.clientX - startCX) / scale / PX_PER_MM;
        const dyMm = (e.clientY - startCY) / scale / PX_PER_MM;
        const el = editing.elements.find(el => el.id === id);
        if (!el) return;
        patchEl(id, {
          x: snap(clamp(origX + dxMm, 0, editing.width_mm  - el.w)),
          y: snap(clamp(origY + dyMm, 0, editing.height_mm - el.h)),
        });
        return;
      }
      // resize
      if (resizeRef.current && editing) {
        const { id, handle, startCX, startCY, origEl: o } = resizeRef.current;
        const dxMm = (e.clientX - startCX) / scale / PX_PER_MM;
        const dyMm = (e.clientY - startCY) / scale / PX_PER_MM;
        const MIN = 2;
        let { x, y, w, h } = o;
        if (handle.includes("e"))  { w = snap(Math.max(MIN, o.w + dxMm)); }
        if (handle.includes("w"))  { const dw = snap(Math.min(o.w - MIN, dxMm)); x = o.x + dw; w = o.w - dw; }
        if (handle.includes("s"))  { h = snap(Math.max(MIN, o.h + dyMm)); }
        if (handle.includes("n"))  { const dh = snap(Math.min(o.h - MIN, dyMm)); y = o.y + dh; h = o.h - dh; }
        patchEl(id, { x, y, w, h });
      }
    }
    function onUp() { dragRef.current = null; resizeRef.current = null; }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [editing, scale]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!selId || !editing || (e.target as HTMLElement).tagName === "INPUT") return;
      const STEP = e.shiftKey ? 5 : 0.5;
      const el = editing.elements.find(el => el.id === selId);
      if (!el) return;
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteEl(selId); return; }
      if (e.key === "ArrowLeft")  { e.preventDefault(); patchEl(selId, { x: snap(el.x - STEP) }); }
      if (e.key === "ArrowRight") { e.preventDefault(); patchEl(selId, { x: snap(el.x + STEP) }); }
      if (e.key === "ArrowUp")    { e.preventDefault(); patchEl(selId, { y: snap(el.y - STEP) }); }
      if (e.key === "ArrowDown")  { e.preventDefault(); patchEl(selId, { y: snap(el.y + STEP) }); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selId, editing]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Save ─────────────────────────────────────────────────────────────────────

  async function save() {
    if (!editing || inFlight.current) return;
    inFlight.current = true; setSaving(true);
    try {
      const body = { name: editing.name, item_type: editing.item_type, width_mm: editing.width_mm, height_mm: editing.height_mm, elements: editing.elements, is_default: editing.is_default };
      let saved: LabelTemplate;
      if (editing.id === 0) {
        saved = await api<LabelTemplate>("/api/warehouse/label-templates", { method: "POST", body: JSON.stringify(body) });
        setTemplates(p => [...p, saved]);
      } else {
        saved = await api<LabelTemplate>(`/api/warehouse/label-templates/${editing.id}`, { method: "PUT", body: JSON.stringify(body) });
        setTemplates(p => p.map(t => t.id === saved.id ? saved : t));
      }
      setEditing(saved);
    } finally { inFlight.current = false; setSaving(false); }
  }

  async function del(id: number) {
    await api(`/api/warehouse/label-templates/${id}`, { method: "DELETE" });
    setTemplates(p => p.filter(t => t.id !== id));
  }

  // ── Vars for preview ─────────────────────────────────────────────────────────

  const previewVars = editing ? (SAMPLE_VARS[editing.item_type] ?? SAMPLE_VARS.universal) : {};

  // Resolve bc url for preview
  const previewBcUrls: Record<string, string> = {};
  if (editing) {
    editing.elements.filter(e => e.type === "barcode").forEach(el => {
      const raw = substituteVars(el.value ?? "", previewVars as Record<string, string>);
      if (bcUrls[raw]) previewBcUrls[raw] = bcUrls[raw];
    });
  }

  // Selected element
  const selEl = editing?.elements.find(e => e.id === selId) ?? null;

  // ─── Library view ─────────────────────────────────────────────────────────────
  if (!editing) {
    const builtins = templates.filter(t => t.is_builtin);
    const custom   = templates.filter(t => !t.is_builtin);
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">Шаблони міток</h1>
            <p className="text-xs text-[var(--text-faint)]">Натисни «Редагувати» або створи власний шаблон</p>
          </div>
          <button onClick={() => {
            setEditing({ id: 0, name: "Новий шаблон", item_type: "product", width_mm: 100, height_mm: 30, elements: [], is_builtin: false, is_default: false });
            setSelId(null);
          }} className="btn btn-primary">+ Новий шаблон</button>
        </div>

        {builtins.length > 0 && (
          <section>
            <p className="mb-3 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Вбудовані</p>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              {builtins.map(tpl => <TplCard key={tpl.id} tpl={tpl} onEdit={() => { setEditing(JSON.parse(JSON.stringify(tpl))); setSelId(null); }} />)}
            </div>
          </section>
        )}

        {custom.length > 0 && (
          <section>
            <p className="mb-3 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Власні</p>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              {custom.map(tpl => <TplCard key={tpl.id} tpl={tpl}
                onEdit={() => { setEditing(JSON.parse(JSON.stringify(tpl))); setSelId(null); }}
                onDelete={() => del(tpl.id)} />)}
            </div>
          </section>
        )}

        {templates.length === 0 && (
          <div className="rounded-xl border border-dashed border-[var(--border-strong)] py-24 text-center">
            <p className="text-sm text-[var(--text-muted)]">Завантаження…</p>
          </div>
        )}
      </div>
    );
  }

  // ─── Editor view ──────────────────────────────────────────────────────────────
  return (
    <div className="flex h-[calc(100vh-56px)] overflow-hidden bg-[var(--bg)]">

      {/* LEFT PANEL — elements list */}
      <div className="flex w-52 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-elevated)]">
        <div className="border-b border-[var(--border)] px-3 py-2.5">
          <p className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide">Елементи</p>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {editing.elements.length === 0 && (
            <p className="py-6 text-center text-xs text-[var(--text-faint)]">Ще немає елементів</p>
          )}
          {editing.elements.map((el, i) => (
            <div key={el.id}
              className={["flex items-center gap-2 rounded-lg px-2.5 py-2 cursor-pointer text-sm transition select-none",
                selId === el.id
                  ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                  : "hover:bg-[var(--surface-hi)] text-[var(--text)]",
              ].join(" ")}
              onClick={() => setSelId(el.id === selId ? null : el.id)}
            >
              <span className="w-5 shrink-0 text-center font-mono text-base leading-none">{EL_ICONS[el.type]}</span>
              <span className="flex-1 truncate text-xs">
                {el.type === "text" ? el.text : el.type === "image" ? "Фото" : el.value ?? EL_LABELS[el.type]}
              </span>
              <button onClick={e => { e.stopPropagation(); moveEl(el.id, -1); }} disabled={i === 0}
                className="text-[var(--text-faint)] hover:text-[var(--text)] disabled:opacity-20 text-xs leading-none">▲</button>
              <button onClick={e => { e.stopPropagation(); moveEl(el.id, 1); }} disabled={i === editing.elements.length - 1}
                className="text-[var(--text-faint)] hover:text-[var(--text)] disabled:opacity-20 text-xs leading-none">▼</button>
            </div>
          ))}
        </div>

        {/* Add element buttons */}
        <div className="border-t border-[var(--border)] p-2 space-y-1">
          <p className="px-1 text-[10px] text-[var(--text-faint)]">Додати</p>
          <div className="grid grid-cols-3 gap-1">
            {(["text","qr","barcode","image","rect","line"] as LabelElement["type"][]).map(t => (
              <button key={t} type="button" onClick={() => addEl(t)}
                className="flex flex-col items-center gap-0.5 rounded-lg border border-[var(--border)] py-1.5 text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)] hover:bg-[var(--accent)]/5 transition-colors"
                title={EL_LABELS[t]}>
                <span className="text-base leading-none">{EL_ICONS[t]}</span>
                <span className="text-[9px]">{EL_LABELS[t]}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* CENTER — canvas */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-2.5">
          <button onClick={() => setEditing(null)} className="text-sm text-[var(--text-faint)] hover:text-[var(--text)] transition-colors">← Бібліотека</button>
          <div className="h-4 w-px bg-[var(--border)]" />
          <input value={editing.name}
            onChange={e => setEditing(p => p ? { ...p, name: e.target.value } : null)}
            className="flex-1 bg-transparent text-sm font-medium outline-none focus:text-[var(--accent)]" />
          <select value={editing.item_type}
            onChange={e => setEditing(p => p ? { ...p, item_type: e.target.value } : null)}
            className="rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs outline-none focus:border-[var(--accent)]">
            {ITEM_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <div className="flex items-center gap-1.5">
            <input type="number" step="0.5" min="20" max="300" value={editing.width_mm}
              onChange={e => setEditing(p => p ? { ...p, width_mm: parseFloat(e.target.value) || p.width_mm } : null)}
              className="w-16 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-xs text-center font-mono outline-none focus:border-[var(--accent)]" />
            <span className="text-xs text-[var(--text-faint)]">×</span>
            <input type="number" step="0.5" min="10" max="300" value={editing.height_mm}
              onChange={e => setEditing(p => p ? { ...p, height_mm: parseFloat(e.target.value) || p.height_mm } : null)}
              className="w-16 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-xs text-center font-mono outline-none focus:border-[var(--accent)]" />
            <span className="text-[10px] text-[var(--text-faint)]">мм</span>
          </div>
          <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
            <input type="checkbox" checked={editing.is_default ?? false}
              onChange={e => setEditing(p => p ? { ...p, is_default: e.target.checked } : null)}
              className="h-3 w-3" />
            за замовч.
          </label>
          <button onClick={save} disabled={saving || !!editing.is_builtin}
            className="btn btn-primary btn-sm disabled:opacity-50">
            {saving ? "…" : "Зберегти"}
          </button>
        </div>

        {/* Canvas area */}
        <div className="flex flex-1 items-start justify-center overflow-auto bg-[var(--surface-hi)] p-8"
          onClick={() => setSelId(null)}>
          {/* Shadow + border wrapper */}
          <div style={{ position: "relative", width: CANVAS_W_PX, height: canvasH, flexShrink: 0 }}
            className="shadow-xl" onClick={e => e.stopPropagation()}>

            {/* Rendered label (mm-based, scaled) */}
            <div style={{ transform: `scale(${scale})`, transformOrigin: "top left", width: tplNatW, height: tplNatH, position: "absolute" }}>
              <LabelCanvas template={editing} vars={previewVars} barcodeUrls={previewBcUrls} />
            </div>

            {/* Interaction overlays (px-based, in scaled space) */}
            {editing.elements.map(el => {
              const lPx = el.x * PX_PER_MM * scale;
              const tPx = el.y * PX_PER_MM * scale;
              const wPx = el.w * PX_PER_MM * scale;
              const hPx = el.h * PX_PER_MM * scale;
              const isSel = selId === el.id;
              return (
                <div
                  key={el.id}
                  ref={isSel ? canvasRef : undefined}
                  style={{
                    position: "absolute",
                    left: lPx, top: tPx,
                    width: wPx, height: Math.max(hPx, 4),
                    cursor: "move",
                    outline: isSel ? "1.5px solid #06b6d4" : "1px dashed transparent",
                    boxSizing: "border-box",
                    zIndex: isSel ? 10 : 1,
                  }}
                  onMouseDown={e => onElMouseDown(e, el)}
                >
                  {/* Resize handles — only on selected */}
                  {isSel && HANDLES.map(h => {
                    const { left, top } = handlePos(h, wPx, Math.max(hPx, 4));
                    return (
                      <div key={h}
                        style={{
                          position: "absolute",
                          left: left - 4, top: top - 4,
                          width: 8, height: 8,
                          background: "#fff",
                          border: "1.5px solid #06b6d4",
                          borderRadius: 2,
                          cursor: HANDLE_CURSOR[h],
                          zIndex: 20,
                        }}
                        onMouseDown={e => onHandleMouseDown(e, el, h)}
                      />
                    );
                  })}
                </div>
              );
            })}

            {/* Canvas ref target for coordinate math */}
            <div ref={canvasRef} style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />
          </div>
        </div>

        {/* Status bar */}
        {selEl && (
          <div className="flex items-center gap-4 border-t border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-1.5 text-[10px] text-[var(--text-faint)]">
            <span className="font-medium text-[var(--text)]">{EL_LABELS[selEl.type]}</span>
            <span>X: <b>{selEl.x.toFixed(1)}</b> мм</span>
            <span>Y: <b>{selEl.y.toFixed(1)}</b> мм</span>
            <span>Ш: <b>{selEl.w.toFixed(1)}</b> мм</span>
            <span>В: <b>{selEl.h.toFixed(1)}</b> мм</span>
            <span className="ml-auto">Стрілки = 0.5мм · Shift+стрілки = 5мм · Del = видалити</span>
          </div>
        )}
      </div>

      {/* RIGHT PANEL — properties */}
      <div className="flex w-64 shrink-0 flex-col border-l border-[var(--border)] bg-[var(--bg-elevated)]">
        <div className="border-b border-[var(--border)] px-3 py-2.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            {selEl ? `${EL_LABELS[selEl.type]} — властивості` : "Властивості"}
          </p>
        </div>

        {!selEl ? (
          <div className="flex flex-1 items-center justify-center p-4 text-center">
            <p className="text-xs text-[var(--text-faint)]">Клікни або перетягни елемент на полотні</p>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-3 space-y-4">
            {/* Position + size */}
            <fieldset className="space-y-2">
              <legend className="text-[10px] font-medium text-[var(--text-muted)] uppercase tracking-wide">Позиція і розмір (мм)</legend>
              <div className="grid grid-cols-2 gap-2">
                {(["x","y","w","h"] as (keyof LabelElement)[]).map(k => (
                  <label key={k} className="flex items-center gap-1.5">
                    <span className="w-4 text-[10px] text-[var(--text-faint)] font-mono uppercase">{k}</span>
                    <input type="number" step={0.5} value={+(selEl[k] as number).toFixed(2)}
                      onChange={e => patchEl(selEl.id, { [k]: parseFloat(e.target.value) || 0 })}
                      className="flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-xs font-mono outline-none focus:border-[var(--accent)]" />
                  </label>
                ))}
              </div>
            </fieldset>

            {/* Type-specific properties */}
            <ElProps el={selEl} onChange={p => patchEl(selEl.id, p)} />

            <button onClick={() => deleteEl(selEl.id)}
              className="w-full rounded-lg border border-[rgba(239,68,68,.3)] py-1.5 text-xs text-[var(--state-error)] hover:bg-[rgba(239,68,68,.06)] transition-colors">
              Видалити елемент
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Element properties panel ─────────────────────────────────────────────────

function ElProps({ el, onChange }: { el: LabelElement; onChange: (p: Partial<LabelElement>) => void }) {
  const inp = "w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-xs outline-none focus:border-[var(--accent)]";
  const lbl = "text-[10px] text-[var(--text-faint)]";

  switch (el.type) {
    case "text": return (
      <fieldset className="space-y-2.5">
        <legend className="text-[10px] font-medium text-[var(--text-muted)] uppercase tracking-wide">Текст</legend>
        <label className="block">
          <span className={`${lbl} mb-1 block`}>Вміст</span>
          <input value={el.text ?? ""} onChange={e => onChange({ text: e.target.value })} className={inp} />
          <div className="mt-1 flex flex-wrap gap-1">
            {ALL_VARS.map(v => (
              <button key={v} type="button" onClick={() => onChange({ text: (el.text ?? "") + v })}
                className="rounded border border-[var(--border)] px-1 py-0.5 font-mono text-[9px] text-[var(--text-faint)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors">
                {v.replace(/[{}]/g, "")}
              </button>
            ))}
          </div>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className={`${lbl} mb-1 block`}>Розмір (мм)</span>
            <input type="number" step={0.5} min={1} value={el.fontSize ?? 4} onChange={e => onChange({ fontSize: parseFloat(e.target.value) || 4 })} className={inp} />
          </label>
          <label className="block">
            <span className={`${lbl} mb-1 block`}>Жирний</span>
            <button onClick={() => onChange({ fontWeight: el.fontWeight === "bold" ? "normal" : "bold" })}
              className={["w-full rounded border py-1.5 text-xs font-medium transition", el.fontWeight === "bold" ? "border-[var(--border-strong)] bg-[var(--accent)] text-white" : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--surface-hi)]"].join(" ")}>
              {el.fontWeight === "bold" ? "Жирний" : "Звичайний"}
            </button>
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className={`${lbl} mb-1 block`}>Колір</span>
            <div className="flex gap-1.5">
              <input type="color" value={el.color ?? "#111111"} onChange={e => onChange({ color: e.target.value })}
                className="h-8 w-10 cursor-pointer rounded border border-[var(--border)]" />
              <input value={el.color ?? "#111111"} onChange={e => onChange({ color: e.target.value })}
                className={`${inp} flex-1 font-mono uppercase`} maxLength={7} />
            </div>
          </label>
          <label className="block">
            <span className={`${lbl} mb-1 block`}>Вирівнювання</span>
            <div className="flex rounded-lg border border-[var(--border)] overflow-hidden">
              {(["left","center","right"] as const).map(a => (
                <button key={a} onClick={() => onChange({ align: a })}
                  className={["flex-1 py-1.5 text-xs transition", el.align === a ? "bg-[var(--accent)] text-white" : "text-[var(--text-muted)] hover:bg-[var(--surface-hi)]"].join(" ")}>
                  {a === "left" ? "◀" : a === "center" ? "◈" : "▶"}
                </button>
              ))}
            </div>
          </label>
        </div>
      </fieldset>
    );

    case "qr": return (
      <fieldset className="space-y-2.5">
        <legend className="text-[10px] font-medium text-[var(--text-muted)] uppercase tracking-wide">QR-код</legend>
        <label className="block">
          <span className={`${lbl} mb-1 block`}>Вміст</span>
          <input value={el.value ?? ""} onChange={e => onChange({ value: e.target.value })} className={`${inp} font-mono`} />
          <div className="mt-1 flex flex-wrap gap-1">
            {ALL_VARS.map(v => (
              <button key={v} type="button" onClick={() => onChange({ value: v })}
                className="rounded border border-[var(--border)] px-1 py-0.5 font-mono text-[9px] text-[var(--text-faint)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors">
                {v.replace(/[{}]/g, "")}
              </button>
            ))}
          </div>
        </label>
        <label className="block">
          <span className={`${lbl} mb-1 block`}>Рівень корекції</span>
          <div className="flex gap-1.5">
            {(["L","M","Q","H"] as const).map(lvl => (
              <button key={lvl} onClick={() => onChange({ level: lvl })}
                className={["flex-1 rounded border py-1.5 text-xs font-mono font-medium transition", el.level === lvl ? "border-[var(--border-strong)] bg-[var(--accent)] text-white" : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--surface-hi)]"].join(" ")}>
                {lvl}
              </button>
            ))}
          </div>
        </label>
      </fieldset>
    );

    case "barcode": return (
      <fieldset className="space-y-2.5">
        <legend className="text-[10px] font-medium text-[var(--text-muted)] uppercase tracking-wide">Штрих-код</legend>
        <label className="block">
          <span className={`${lbl} mb-1 block`}>Вміст</span>
          <input value={el.value ?? ""} onChange={e => onChange({ value: e.target.value })} className={`${inp} font-mono`} />
          <div className="mt-1 flex flex-wrap gap-1">
            {ALL_VARS.map(v => (
              <button key={v} type="button" onClick={() => onChange({ value: v })}
                className="rounded border border-[var(--border)] px-1 py-0.5 font-mono text-[9px] text-[var(--text-faint)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors">
                {v.replace(/[{}]/g, "")}
              </button>
            ))}
          </div>
        </label>
        <label className="block">
          <span className={`${lbl} mb-1 block`}>Формат</span>
          <div className="flex gap-1.5">
            {(["CODE128","EAN13"] as const).map(f => (
              <button key={f} onClick={() => onChange({ barcodeFormat: f })}
                className={["flex-1 rounded border py-1.5 text-xs font-mono font-medium transition", el.barcodeFormat === f ? "border-[var(--border-strong)] bg-[var(--accent)] text-white" : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--surface-hi)]"].join(" ")}>
                {f}
              </button>
            ))}
          </div>
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input type="checkbox" checked={el.showText ?? true} onChange={e => onChange({ showText: e.target.checked })} className="h-3.5 w-3.5" />
          <span className="text-xs text-[var(--text)]">Показувати текст</span>
        </label>
      </fieldset>
    );

    case "image": return (
      <fieldset className="space-y-2.5">
        <legend className="text-[10px] font-medium text-[var(--text-muted)] uppercase tracking-wide">Фото</legend>
        <p className="text-xs text-[var(--text-faint)]">Джерело: фото товару (image_url)</p>
        <label className="block">
          <span className={`${lbl} mb-1 block`}>Заповнення</span>
          <div className="flex gap-1.5">
            {(["cover","contain"] as const).map(f => (
              <button key={f} onClick={() => onChange({ objectFit: f })}
                className={["flex-1 rounded border py-1.5 text-xs font-medium transition", el.objectFit === f ? "border-[var(--border-strong)] bg-[var(--accent)] text-white" : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--surface-hi)]"].join(" ")}>
                {f === "cover" ? "Обрізати" : "Вмістити"}
              </button>
            ))}
          </div>
        </label>
      </fieldset>
    );

    case "rect": return (
      <fieldset className="space-y-2.5">
        <legend className="text-[10px] font-medium text-[var(--text-muted)] uppercase tracking-wide">Прямокутник</legend>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className={`${lbl} mb-1 block`}>Колір рамки</span>
            <div className="flex gap-1">
              <input type="color" value={el.borderColor ?? "#cccccc"} onChange={e => onChange({ borderColor: e.target.value })} className="h-8 w-9 cursor-pointer rounded border border-[var(--border)]" />
              <input value={el.borderColor ?? "#cccccc"} onChange={e => onChange({ borderColor: e.target.value })} className={`${inp} flex-1 font-mono text-[10px]`} />
            </div>
          </label>
          <label className="block">
            <span className={`${lbl} mb-1 block`}>Товщина (мм)</span>
            <input type="number" step={0.1} min={0} value={el.borderWidth ?? 0.3} onChange={e => onChange({ borderWidth: parseFloat(e.target.value) || 0 })} className={inp} />
          </label>
          <label className="block">
            <span className={`${lbl} mb-1 block`}>Заливка</span>
            <div className="flex gap-1">
              <input type="color" value={el.fillColor && el.fillColor !== "transparent" ? el.fillColor : "#ffffff"} onChange={e => onChange({ fillColor: e.target.value })} className="h-8 w-9 cursor-pointer rounded border border-[var(--border)]" />
              <button onClick={() => onChange({ fillColor: "transparent" })} className="flex-1 rounded border border-[var(--border)] text-[10px] text-[var(--text-faint)] hover:bg-[var(--surface-hi)]">прозора</button>
            </div>
          </label>
          <label className="block">
            <span className={`${lbl} mb-1 block`}>Радіус (мм)</span>
            <input type="number" step={0.5} min={0} value={el.borderRadius ?? 0} onChange={e => onChange({ borderRadius: parseFloat(e.target.value) || 0 })} className={inp} />
          </label>
        </div>
      </fieldset>
    );

    case "line": return (
      <fieldset className="space-y-2.5">
        <legend className="text-[10px] font-medium text-[var(--text-muted)] uppercase tracking-wide">Лінія</legend>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className={`${lbl} mb-1 block`}>Колір</span>
            <div className="flex gap-1">
              <input type="color" value={el.strokeColor ?? "#cccccc"} onChange={e => onChange({ strokeColor: e.target.value })} className="h-8 w-9 cursor-pointer rounded border border-[var(--border)]" />
              <input value={el.strokeColor ?? "#cccccc"} onChange={e => onChange({ strokeColor: e.target.value })} className={`${inp} flex-1 font-mono text-[10px]`} />
            </div>
          </label>
          <label className="block">
            <span className={`${lbl} mb-1 block`}>Товщина (мм)</span>
            <input type="number" step={0.1} min={0.1} value={el.strokeWidth ?? 0.5} onChange={e => onChange({ strokeWidth: parseFloat(e.target.value) || 0.5 })} className={inp} />
          </label>
        </div>
        <label className="block">
          <span className={`${lbl} mb-1 block`}>Орієнтація</span>
          <div className="flex gap-1.5">
            {(["horizontal","vertical"] as const).map(o => (
              <button key={o} onClick={() => onChange({ orientation: o })}
                className={["flex-1 rounded border py-1.5 text-xs font-medium transition", el.orientation === o ? "border-[var(--border-strong)] bg-[var(--accent)] text-white" : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--surface-hi)]"].join(" ")}>
                {o === "horizontal" ? "─ Горизонтальна" : "│ Вертикальна"}
              </button>
            ))}
          </div>
        </label>
      </fieldset>
    );

    default: return null;
  }
}

// ─── Template card ─────────────────────────────────────────────────────────────

const PX = 96 / 25.4;

function TplCard({ tpl, onEdit, onDelete }: { tpl: LabelTemplate; onEdit: () => void; onDelete?: () => void }) {
  const vars = SAMPLE_VARS[tpl.item_type] ?? SAMPLE_VARS.universal;
  const CARD_W = 200;
  const s = Math.min(2, CARD_W / (tpl.width_mm * PX));
  const cH = Math.round(tpl.height_mm * PX * s);

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4 space-y-3 hover:border-[var(--border-strong)] transition-colors">
      <div className="flex items-center justify-center rounded-lg bg-[var(--surface-hi)] p-3">
        <div style={{ width: CARD_W, height: cH, overflow: "hidden" }}>
          <div style={{ transform: `scale(${s})`, transformOrigin: "top left", width: tpl.width_mm * PX, height: tpl.height_mm * PX }}>
            <LabelCanvas template={tpl} vars={vars} />
          </div>
        </div>
      </div>
      <div>
        <p className="font-medium text-sm">{tpl.name}</p>
        <p className="text-xs text-[var(--text-faint)]">
          {ITEM_TYPES.find(t => t.value === tpl.item_type)?.label ?? tpl.item_type}
          {" · "}{tpl.width_mm}×{tpl.height_mm} мм{" · "}{tpl.elements.length} ел.
          {tpl.is_builtin && <span className="ml-1.5 rounded bg-[var(--surface-hi)] px-1 py-0.5 text-[9px]">вбудований</span>}
          {tpl.is_default && <span className="ml-1.5 rounded bg-[var(--accent)]/10 px-1 py-0.5 text-[9px] text-[var(--accent)]">за замовч.</span>}
        </p>
      </div>
      <div className="flex gap-2">
        <button onClick={onEdit} className="flex-1 btn btn-ghost btn-sm">
          {tpl.is_builtin ? "Переглянути" : "Редагувати"}
        </button>
        {!tpl.is_builtin && onDelete && (
          <button onClick={onDelete} className="btn btn-ghost btn-sm text-[var(--state-error)] hover:bg-[rgba(239,68,68,.06)]">×</button>
        )}
      </div>
    </div>
  );
}
