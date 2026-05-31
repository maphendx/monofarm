"use client";

/**
 * WarehouseLabelModal — full-screen label editor + printer.
 *
 * Opens as a full-screen overlay (like ScannerModal) so you get the
 * full editor experience right from the "🏷 Мітки" button.
 *
 * Modes:
 *   preview  — canvas with real item data, template selector, print buttons
 *   edit     — drag+resize canvas elements, element list, properties panel
 */

import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { API_URL, api, getToken } from "@/lib/api";
import { generateCode128Url } from "@/components/warehouse/labelUtils";
import {
  LabelCanvas,
  substituteVars,
  type LabelDataVars,
  type LabelElement,
  type LabelTemplate,
} from "@/components/warehouse/LabelCanvas";

// ─── Public types ─────────────────────────────────────────────────────────────

export type WarehouseLabelItem =
  | { type: "cell";    id: number; code: string; zone_name: string; notes?: string | null }
  | { type: "product"; id: number; name: string; sku: string; barcode?: string | null; image_url?: string | null; categories?: string[] }
  | { type: "action";  id: number; code: string; label: string };

// ─── Constants ────────────────────────────────────────────────────────────────

const PX_PER_MM = 96 / 25.4;
const CANVAS_W  = 520;         // canvas preview width in px
const GRID_MM   = 0.5;

const EL_ICONS: Record<string, string> = { text: "T", qr: "▦", barcode: "▐▌", image: "🖼", rect: "□", line: "─" };
const EL_LABELS: Record<string, string> = { text: "Текст", qr: "QR", barcode: "Штрих-код", image: "Фото", rect: "Рамка", line: "Лінія" };

// ─── ZPL generation from template elements ────────────────────────────────────

const ZPL_DPI = 203;
const d = (mm: number) => Math.round(mm * ZPL_DPI / 25.4);

function safeZpl(s: string): string {
  return s.replace(/[\\^~]/g, "").slice(0, 40);
}

function elementToZpl(el: LabelElement, vars: LabelDataVars): string {
  const x = d(el.x), y = d(el.y), w = d(el.w), h = d(el.h);

  switch (el.type) {
    case "text": {
      const text = safeZpl(substituteVars(el.text ?? "", vars));
      if (!text) return "";
      const fh = Math.max(8, d(el.fontSize ?? 4));
      const bold = el.fontWeight === "bold" ? "^FB" : "";
      return `^FO${x},${y}${bold}^A0N,${fh},${fh}^FD${text}^FS`;
    }
    case "qr": {
      const val = safeZpl(substituteVars(el.value ?? "", vars));
      if (!val) return "";
      const mag = Math.min(10, Math.max(1, Math.floor(h / 21)));
      const ecc = el.level ?? "M";
      return `^FO${x},${y}^BQN,2,${mag}^FD${ecc}A,${val}^FS`;
    }
    case "barcode": {
      const val = safeZpl(substituteVars(el.value ?? "", vars));
      if (!val) return "";
      const narrow = Math.max(1, Math.min(3, Math.round(w / 60)));
      const showTxt = el.showText !== false ? "Y" : "N";
      // Code128: ^BY<narrow>,<ratio>,<height> then ^BCN (normal orient, height, print below, no checksum, no start/stop)
      return `^FO${x},${y}^BY${narrow},3,${Math.round(h * 0.7)}^BCN,${Math.round(h * 0.7)},${showTxt},N,N^FD${val}^FS`;
    }
    case "rect": {
      const border = Math.max(1, d(el.borderWidth ?? 0.3));
      return `^FO${x},${y}^GB${w},${h},${border}^FS`;
    }
    case "line": {
      const sw = Math.max(1, d(el.strokeWidth ?? 0.5));
      return el.orientation === "vertical"
        ? `^FO${x},${y}^GB${sw},${h},${sw}^FS`
        : `^FO${x},${y}^GB${w},${sw},${sw}^FS`;
    }
    default: return ""; // image: ZPL doesn't support raster images from web
  }
}

function buildZplFromTemplate(
  tpl: LabelTemplate,
  items: WarehouseLabelItem[],
  varsList: LabelDataVars[],
): string {
  const W = d(tpl.width_mm), H = d(tpl.height_mm);
  return items.map((_, i) => {
    const vars = varsList[i];
    const elLines = tpl.elements
      .map(el => elementToZpl(el, vars))
      .filter(Boolean);
    return ["^XA", "^CI28", `^PW${W}`, `^LL${H}`, "^LH0,0", ...elLines, "^XZ"].join("\n");
  }).join("\n");
}

// Fallback ZPL when no template is selected
function buildZplFallback(items: WarehouseLabelItem[], qrVals: string[], wMm: number, hMm: number): string {
  const W = d(wMm), H = d(hMm), pad = d(2);
  const mag = Math.min(10, Math.max(2, Math.floor((H - pad * 2) / 21)));
  const qrD = mag * 21, qrY = Math.floor((H - qrD) / 2);
  const txX = pad + qrD + pad;
  const fsP = Math.min(60, Math.floor(H * 0.30));
  const fsS = Math.min(36, Math.floor(H * 0.18));

  return items.map((item, i) => {
    const qrVal = safeZpl(qrVals[i] ?? defaultQr(item));
    const p1 = item.type === "cell" ? item.code : item.type === "action" ? safeZpl(item.label) : safeZpl(item.name);
    const p2 = item.type === "cell" ? item.zone_name : item.type === "action" ? item.code : item.sku;
    return [
      "^XA", "^CI28", `^PW${W}`, `^LL${H}`, "^LH0,0",
      `^FO${pad},${qrY}^BQN,2,${mag}^FDMA,${qrVal}^FS`,
      `^FO${txX},${Math.floor(H * 0.32)}^A0N,${fsP},${fsP}^FD${safeZpl(p1)}^FS`,
      p2 ? `^FO${txX},${Math.floor(H * 0.60)}^A0N,${fsS},${fsS}^FD${safeZpl(p2)}^FS` : "",
      "^XZ",
    ].filter(Boolean).join("\n");
  }).join("\n");
}

async function sendToBrowserPrint(zpl: string): Promise<"ok" | "not_available" | "error"> {
  try {
    const dr = await fetch("http://localhost:9090/default", { signal: AbortSignal.timeout(1200) });
    if (!dr.ok) return "not_available";
    const device = await dr.json() as Record<string, unknown>;
    const wr = await fetch("http://localhost:9090/write", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device, data: zpl }), signal: AbortSignal.timeout(3000),
    });
    return wr.ok ? "ok" : "error";
  } catch { return "not_available"; }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function defaultQr(item: WarehouseLabelItem): string {
  if (item.type === "cell")   return `CELL:${item.id}`;
  if (item.type === "action") return item.code;
  return item.barcode || item.sku;
}

async function fetchDataUrl(src: string): Promise<string | null> {
  if (src.startsWith("http")) return src;
  try {
    const r = await fetch(API_URL + src, { headers: { Authorization: `Bearer ${getToken() ?? ""}` } });
    if (!r.ok) return null;
    const blob = await r.blob();
    return await new Promise<string>(res => { const rd = new FileReader(); rd.onload = () => res(rd.result as string); rd.readAsDataURL(blob); });
  } catch { return null; }
}

function itemToVars(item: WarehouseLabelItem, qrVal: string, imgUrl?: string): LabelDataVars {
  if (item.type === "cell")   return { code: item.code, zone_name: item.zone_name, notes: item.notes ?? "", CELL_QR: qrVal };
  if (item.type === "action") return { label: item.label, code: item.code, ACTION_QR: qrVal };
  return { name: item.name, sku: item.sku, barcode: item.barcode ?? "", categories: item.categories?.join(" · ") ?? "", PROD_QR: qrVal, product_image: imgUrl };
}

function uid() { return Math.random().toString(36).slice(2, 8); }
function snap(v: number) { return Math.round(v / GRID_MM) * GRID_MM; }
function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

function defaultEl(type: LabelElement["type"], tpl: LabelTemplate): LabelElement {
  const cx = Math.round(tpl.width_mm / 2 - 15), cy = Math.round(tpl.height_mm / 2 - 5);
  switch (type) {
    case "text":    return { id: uid(), type, x: cx, y: cy, w: 30, h: 7,  text: "{{name}}", fontSize: 4.5, fontWeight: "normal", color: "#111111", align: "left" };
    case "qr":      return { id: uid(), type, x: cx, y: cy, w: 20, h: 20, value: "{{CELL_QR}}", level: "M" };
    case "barcode": return { id: uid(), type, x: cx, y: cy, w: 35, h: 15, value: "{{PROD_QR}}", barcodeFormat: "CODE128", showText: false };
    case "image":   return { id: uid(), type, x: cx, y: cy, w: 20, h: 20, source: "product_image", objectFit: "cover" };
    case "rect":    return { id: uid(), type, x: cx, y: cy, w: 30, h: 10, borderColor: "#cccccc", borderWidth: 0.3, fillColor: "transparent", borderRadius: 0 };
    case "line":    return { id: uid(), type, x: cx, y: cy, w: 40, h: 0.5, strokeColor: "#cccccc", strokeWidth: 0.5, orientation: "horizontal" };
  }
}

type Handle = "nw"|"n"|"ne"|"e"|"se"|"s"|"sw"|"w";
const HANDLES: Handle[] = ["nw","n","ne","e","se","s","sw","w"];
const HANDLE_CURSOR: Record<Handle,string> = { nw:"nw-resize",n:"n-resize",ne:"ne-resize",e:"e-resize",se:"se-resize",s:"s-resize",sw:"sw-resize",w:"w-resize" };
function handlePos(h: Handle, w: number, hh: number) {
  const cx = w/2, cy = hh/2;
  const m: Record<Handle,[number,number]> = { nw:[0,0],n:[cx,0],ne:[w,0],e:[w,cy],se:[w,hh],s:[cx,hh],sw:[0,hh],w:[0,cy] };
  return { left: m[h][0], top: m[h][1] };
}

const ALL_VARS = ["{{name}}","{{sku}}","{{barcode}}","{{categories}}","{{PROD_QR}}","{{code}}","{{zone_name}}","{{notes}}","{{CELL_QR}}","{{label}}","{{ACTION_QR}}"];

// ─── Main component ───────────────────────────────────────────────────────────

export function WarehouseLabelModal({ items, onClose }: { items: WarehouseLabelItem[]; onClose: () => void }) {
  const itemType = items[0]?.type ?? "product";

  // ── State ─────────────────────────────────────────────────────────────────
  const [templates,   setTemplates]   = useState<LabelTemplate[]>([]);
  const [tplId,       setTplId]       = useState<number | null>(null);
  const [editMode,    setEditMode]    = useState(false);
  const [localTpl,    setLocalTpl]    = useState<LabelTemplate | null>(null); // mutable copy during edit
  const [selId,       setSelId]       = useState<string | null>(null);
  const [previewIdx,  setPreviewIdx]  = useState(0);
  const [customQr,    setCustomQr]    = useState<string>("");
  const [imgUrls,     setImgUrls]     = useState<Record<number,string>>({});
  const [bcUrls,      setBcUrls]      = useState<Record<string,string>>({});
  const [printBcUrls, setPrintBcUrls] = useState<Record<string,string>>({});
  const [status,      setStatus]      = useState<string | null>(null);
  const [busy,        setBusy]        = useState(false);
  const [saving,      setSaving]      = useState(false);
  const [printing,    setPrinting]    = useState(false);

  const canvasBoxRef = useRef<HTMLDivElement>(null);
  const dragRef      = useRef<{id:string;startCX:number;startCY:number;origX:number;origY:number}|null>(null);
  const resizeRef    = useRef<{id:string;handle:Handle;startCX:number;startCY:number;origEl:LabelElement}|null>(null);
  const inFlight     = useRef(false);

  const activeTpl  = localTpl ?? templates.find(t => t.id === tplId) ?? null;
  const isSingle   = items.length === 1;
  const previewItem = items[Math.min(previewIdx, items.length - 1)];
  const qrVal      = customQr || defaultQr(previewItem);
  const previewVars = itemToVars(previewItem, qrVal, previewItem.type === "product" ? imgUrls[previewItem.id] : undefined);

  // canvas scale
  const scale   = activeTpl ? CANVAS_W / (activeTpl.width_mm * PX_PER_MM) : 1;
  const canvasH = activeTpl ? Math.round(activeTpl.height_mm * PX_PER_MM * scale) : 0;

  // ── Load templates on mount ────────────────────────────────────────────────
  useEffect(() => {
    api<LabelTemplate[]>(`/api/warehouse/label-templates?item_type=${itemType}`)
      .then(data => {
        setTemplates(data);
        const def = data.find(t => t.is_default) ?? data[0];
        if (def) { setTplId(def.id); }
      }).catch(() => {});

    if (itemType === "product") {
      items.forEach(item => {
        if (item.type !== "product" || !item.image_url) return;
        fetchDataUrl(item.image_url).then(url => { if (url) setImgUrls(p => ({ ...p, [item.id]: url })); });
      });
    }
    setCustomQr(defaultQr(items[0]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Pre-render barcodes when template changes ──────────────────────────────
  useEffect(() => {
    if (!activeTpl) return;
    // SVG barcodes — no hPx needed, infinitely scalable
    activeTpl.elements.filter(e => e.type === "barcode").forEach(el => {
      const showText = el.showText ?? false;
      items.slice(0, 20).forEach(item => {
        const vars     = itemToVars(item, defaultQr(item), item.type === "product" ? imgUrls[item.id] : undefined);
        const raw      = substituteVars(el.value ?? "", vars as Record<string,string>);
        const cacheKey = `${raw}__${showText ? "1" : "0"}`;
        if (!raw || bcUrls[cacheKey]) return;
        generateCode128Url(raw, 0, showText).then(url => {
          if (url) setBcUrls(p => ({ ...p, [cacheKey]: url, [raw]: url }));
        });
      });
    });
  }, [activeTpl?.id, activeTpl?.elements]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Enter edit mode ────────────────────────────────────────────────────────
  function enterEdit() {
    if (!activeTpl) return;
    if (!localTpl) setLocalTpl(JSON.parse(JSON.stringify(activeTpl)));
    setEditMode(true);
    setSelId(null);
  }

  function exitEdit() {
    setEditMode(false);
    setLocalTpl(null);
    setSelId(null);
  }

  // ── Element mutations (edit mode) ─────────────────────────────────────────
  function patchEl(id: string, patch: Partial<LabelElement>) {
    setLocalTpl(p => p ? ({ ...p, elements: p.elements.map(e => e.id === id ? { ...e, ...patch } : e) }) : null);
  }
  function addEl(type: LabelElement["type"]) {
    if (!localTpl) return;
    const el = defaultEl(type, localTpl);
    setLocalTpl(p => p ? ({ ...p, elements: [...p.elements, el] }) : null);
    setSelId(el.id);
  }
  function deleteEl(id: string) {
    setLocalTpl(p => p ? ({ ...p, elements: p.elements.filter(e => e.id !== id) }) : null);
    if (selId === id) setSelId(null);
  }
  function moveEl(id: string, dir: -1|1) {
    setLocalTpl(prev => {
      if (!prev) return null;
      const arr = [...prev.elements];
      const i = arr.findIndex(e => e.id === id), j = i + dir;
      if (j < 0 || j >= arr.length) return prev;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      return { ...prev, elements: arr };
    });
  }

  // ── Canvas drag + resize (edit mode) ─────────────────────────────────────
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
    if (!editMode) return;
    function onMove(e: MouseEvent) {
      if (dragRef.current && localTpl) {
        const { id, startCX, startCY, origX, origY } = dragRef.current;
        const el = localTpl.elements.find(e => e.id === id); if (!el) return;
        patchEl(id, {
          x: snap(clamp(origX + (e.clientX - startCX) / scale / PX_PER_MM, 0, localTpl.width_mm  - el.w)),
          y: snap(clamp(origY + (e.clientY - startCY) / scale / PX_PER_MM, 0, localTpl.height_mm - el.h)),
        });
      }
      if (resizeRef.current && localTpl) {
        const { id, handle, startCX, startCY, origEl: o } = resizeRef.current;
        const dxMm = (e.clientX - startCX) / scale / PX_PER_MM;
        const dyMm = (e.clientY - startCY) / scale / PX_PER_MM;
        const MIN = 2; let { x, y, w, h } = o;
        if (handle.includes("e"))  w = snap(Math.max(MIN, o.w + dxMm));
        if (handle.includes("w"))  { const d = snap(Math.min(o.w - MIN, dxMm)); x = o.x + d; w = o.w - d; }
        if (handle.includes("s"))  h = snap(Math.max(MIN, o.h + dyMm));
        if (handle.includes("n"))  { const d = snap(Math.min(o.h - MIN, dyMm)); y = o.y + d; h = o.h - d; }
        patchEl(id, { x, y, w, h });
      }
    }
    function onUp() { dragRef.current = null; resizeRef.current = null; }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [editMode, localTpl, scale]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard shortcuts (edit mode)
  useEffect(() => {
    if (!editMode) return;
    function onKey(e: KeyboardEvent) {
      if (!selId || !localTpl || (e.target as HTMLElement).tagName === "INPUT") return;
      const el = localTpl.elements.find(e => e.id === selId); if (!el) return;
      const s = e.shiftKey ? 5 : 0.5;
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteEl(selId); }
      else if (e.key === "ArrowLeft")  { e.preventDefault(); patchEl(selId, { x: snap(el.x - s) }); }
      else if (e.key === "ArrowRight") { e.preventDefault(); patchEl(selId, { x: snap(el.x + s) }); }
      else if (e.key === "ArrowUp")    { e.preventDefault(); patchEl(selId, { y: snap(el.y - s) }); }
      else if (e.key === "ArrowDown")  { e.preventDefault(); patchEl(selId, { y: snap(el.y + s) }); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editMode, selId, localTpl]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Save template ──────────────────────────────────────────────────────────
  async function saveTemplate() {
    if (!localTpl || inFlight.current) return;
    inFlight.current = true; setSaving(true);
    try {
      const body = { name: localTpl.name, item_type: localTpl.item_type, width_mm: localTpl.width_mm, height_mm: localTpl.height_mm, elements: localTpl.elements, is_default: localTpl.is_default };
      let saved: LabelTemplate;
      if (localTpl.id <= 0) {
        saved = await api<LabelTemplate>("/api/warehouse/label-templates", { method: "POST", body: JSON.stringify({ ...body, name: localTpl.name + " (копія)" }) });
      } else if (localTpl.is_builtin) {
        saved = await api<LabelTemplate>("/api/warehouse/label-templates", { method: "POST", body: JSON.stringify({ ...body, name: localTpl.name + " (копія)" }) });
      } else {
        saved = await api<LabelTemplate>(`/api/warehouse/label-templates/${localTpl.id}`, { method: "PUT", body: JSON.stringify(body) });
      }
      setTemplates(p => {
        const exists = p.find(t => t.id === saved.id);
        return exists ? p.map(t => t.id === saved.id ? saved : t) : [...p, saved];
      });
      setTplId(saved.id);
      setLocalTpl(null);
      setEditMode(false);
      setSelId(null);
    } finally { inFlight.current = false; setSaving(false); }
  }

  // ── A4 print — renders React labels into DOM, uses window.print() ──────────
  async function printA4() {
    if (!activeTpl || printing) return;

    // 1. Generate ALL barcode SVGs before rendering (SVG — no hPx needed)
    const allBc: Record<string, string> = { ...bcUrls };
    await Promise.all(
      activeTpl.elements
        .filter(e => e.type === "barcode")
        .flatMap(el => {
          const showText = el.showText ?? false;
          return items.map(async item => {
            const vars     = itemToVars(item, defaultQr(item), item.type === "product" ? imgUrls[item.id] : undefined);
            const raw      = substituteVars(el.value ?? "", vars as Record<string, string>);
            const cacheKey = `${raw}__${showText ? "1" : "0"}`;
            if (!raw || allBc[cacheKey]) return;
            const url = await generateCode128Url(raw, 0, showText);
            if (url) { allBc[cacheKey] = url; allBc[raw] = url; }
          });
        }),
    );
    setPrintBcUrls(allBc);

    // 2. Render print portal + trigger print
    setPrinting(true);
    await new Promise(r => setTimeout(r, 300));
    const cleanup = () => { setPrinting(false); window.removeEventListener("afterprint", cleanup); };
    window.addEventListener("afterprint", cleanup);
    window.print();
    setTimeout(cleanup, 30_000);
  }

  // ── Zebra ZPL — uses template elements for universal output ──────────────
  async function printZebra() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setStatus(null);

    let zpl: string;
    if (activeTpl) {
      // Template-based: each element type → correct ZPL command
      const varsList = items.map((item, i) =>
        itemToVars(item, i === 0 && isSingle ? qrVal : defaultQr(item), item.type === "product" ? imgUrls[item.id] : undefined),
      );
      zpl = buildZplFromTemplate(activeTpl, items, varsList);
    } else {
      // Fallback: simple QR + text
      const qrVals = items.map((item, i) => i === 0 && isSingle ? qrVal : defaultQr(item));
      zpl = buildZplFallback(items, qrVals, 57, 32);
    }

    const result = await sendToBrowserPrint(zpl);
    setStatus(
      result === "ok"            ? "✓ Відправлено на Zebra"             :
      result === "not_available" ? "✗ Zebra Browser Print не знайдено" :
                                   "✗ Помилка відправки",
    );
    inFlight.current = false; setBusy(false);
  }

  // ── Barcode url map for current preview ───────────────────────────────────
  const previewBcUrls: Record<string,string> = {};
  if (activeTpl) {
    activeTpl.elements.filter(e => e.type === "barcode").forEach(el => {
      const raw = substituteVars(el.value ?? "", previewVars as Record<string,string>);
      if (bcUrls[raw]) previewBcUrls[raw] = bcUrls[raw];
    });
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const selEl = editMode ? (localTpl?.elements.find(e => e.id === selId) ?? null) : null;
  const displayTpl = editMode ? localTpl : activeTpl;

  const inputCls = "rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-xs outline-none focus:border-[var(--accent)]";

  return (
    <>
    {/* Large modal overlay */}
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
    <div className="relative flex w-full max-w-[1280px] h-[92vh] flex-col rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-2xl overflow-hidden">

      {/* ── Top bar ───────────────────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-3">
        <button onClick={onClose} className="flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)]">✕</button>
        <div className="h-4 w-px bg-[var(--border)]" />
        <span className="font-medium text-sm">
          {items.length > 1 ? `Мітки — ${items.length} ${itemType === "product" ? "позицій" : itemType === "action" ? "дій" : "комірок"}` : `Мітка`}
        </span>

        {/* Template selector */}
        <select value={tplId ?? ""} onChange={e => { setTplId(e.target.value ? Number(e.target.value) : null); setLocalTpl(null); setEditMode(false); }}
          className="ml-2 min-w-[180px] rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]">
          <option value="">— Оберіть шаблон —</option>
          {templates.map(t => <option key={t.id} value={t.id}>{t.is_builtin ? `📌 ${t.name}` : t.name}</option>)}
        </select>

        {/* Delete custom template */}
        {activeTpl && !activeTpl.is_builtin && !editMode && (
          <button
            onClick={async () => {
              if (!confirm(`Видалити шаблон «${activeTpl.name}»?`)) return;
              await api(`/api/warehouse/label-templates/${activeTpl.id}`, { method: "DELETE" });
              setTemplates(p => p.filter(t => t.id !== activeTpl.id));
              setTplId(null);
            }}
            title="Видалити шаблон"
            className="flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[rgba(239,68,68,.08)] hover:text-[var(--state-error)]">
            🗑
          </button>
        )}

        {/* New blank template with custom size */}
        {!editMode && (
          <button
            onClick={() => {
              const w = parseFloat(prompt("Ширина (мм):", "100") ?? "0") || 100;
              const h = parseFloat(prompt("Висота (мм):",  "30") ?? "0") || 30;
              const name = prompt("Назва шаблону:", `${w}×${h}мм`) ?? `${w}×${h}мм`;
              const newTpl: LabelTemplate = { id: 0, name, item_type: itemType, width_mm: w, height_mm: h, elements: [], is_builtin: false, is_default: false };
              setLocalTpl(newTpl);
              setTplId(null);
              setEditMode(true);
              setSelId(null);
            }}
            title="Новий шаблон з довільним розміром"
            className="btn btn-ghost btn-sm text-xs">
            + Свій розмір
          </button>
        )}

        {/* Edit / Save / Cancel */}
        {!editMode ? (
          <button onClick={enterEdit} disabled={!activeTpl}
            className="btn btn-secondary btn-sm disabled:opacity-40">
            Редагувати шаблон
          </button>
        ) : (
          <>
            <button onClick={saveTemplate} disabled={saving} className="btn btn-primary btn-sm disabled:opacity-50">
              {saving ? "…" : localTpl?.is_builtin ? "Зберегти як копію" : "Зберегти"}
            </button>
            <button onClick={exitEdit} className="btn btn-ghost btn-sm">Скасувати</button>
          </>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Status */}
        {status && <span className={`text-xs ${status.startsWith("✓") ? "text-[var(--state-ok)]" : "text-[var(--state-error)]"}`}>{status}</span>}

        {/* QR override (single item, not editing) */}
        {isSingle && !editMode && (
          <input value={customQr} onChange={e => setCustomQr(e.target.value)}
            className={`${inputCls} w-40 font-mono text-xs`}
            placeholder="Вміст QR" />
        )}

        {/* Item navigation (multiple items) */}
        {items.length > 1 && !editMode && (
          <div className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
            <button onClick={() => setPreviewIdx(p => Math.max(0, p - 1))} disabled={previewIdx === 0}
              className="rounded px-1.5 py-0.5 hover:bg-[var(--surface-hi)] disabled:opacity-30">◀</button>
            <span>{previewIdx + 1} / {items.length}</span>
            <button onClick={() => setPreviewIdx(p => Math.min(items.length - 1, p + 1))} disabled={previewIdx === items.length - 1}
              className="rounded px-1.5 py-0.5 hover:bg-[var(--surface-hi)] disabled:opacity-30">▶</button>
          </div>
        )}

        {/* Print buttons */}
        <button onClick={printZebra} disabled={busy || !activeTpl} className="btn btn-secondary btn-sm disabled:opacity-40">
          {busy ? "…" : "Zebra (ZPL)"}
        </button>
        <button onClick={printA4} disabled={!activeTpl} className="btn btn-primary btn-sm disabled:opacity-40">
          🖨 A4
        </button>
      </div>

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* LEFT — element list (edit mode only) */}
        {editMode && (
          <div className="flex w-48 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-elevated)]">
            <div className="border-b border-[var(--border)] px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Елементи</p>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
              {(localTpl?.elements ?? []).map((el, i) => (
                <div key={el.id}
                  className={["flex items-center gap-1.5 rounded-lg px-2.5 py-2 cursor-pointer text-xs transition select-none",
                    selId === el.id ? "bg-[var(--accent)]/10 text-[var(--accent)]" : "hover:bg-[var(--surface-hi)] text-[var(--text)]",
                  ].join(" ")}
                  onClick={() => setSelId(el.id === selId ? null : el.id)}>
                  <span className="text-base leading-none">{EL_ICONS[el.type]}</span>
                  <span className="flex-1 truncate">{el.type === "text" ? el.text : el.type === "image" ? "Фото" : el.value ?? EL_LABELS[el.type]}</span>
                  <button onClick={e => { e.stopPropagation(); moveEl(el.id, -1); }} disabled={i === 0} className="text-[var(--text-faint)] hover:text-[var(--text)] disabled:opacity-20 text-[10px]">▲</button>
                  <button onClick={e => { e.stopPropagation(); moveEl(el.id, 1); }} disabled={i === (localTpl?.elements.length ?? 0) - 1} className="text-[var(--text-faint)] hover:text-[var(--text)] disabled:opacity-20 text-[10px]">▼</button>
                </div>
              ))}
            </div>
            <div className="border-t border-[var(--border)] p-2">
              <p className="mb-1.5 px-1 text-[9px] text-[var(--text-faint)]">Додати</p>
              <div className="grid grid-cols-3 gap-1">
                {(["text","qr","barcode","image","rect","line"] as LabelElement["type"][]).map(t => (
                  <button key={t} onClick={() => addEl(t)} title={EL_LABELS[t]}
                    className="flex flex-col items-center gap-0.5 rounded-lg border border-[var(--border)] py-1.5 text-[10px] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors">
                    <span className="text-base leading-none">{EL_ICONS[t]}</span>
                    <span>{EL_LABELS[t]}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* CENTER — canvas */}
        <div className="flex flex-1 flex-col items-center justify-start overflow-auto bg-[var(--surface-hi)] p-8 gap-4"
          onClick={() => editMode && setSelId(null)}>
          {!displayTpl ? (
            <div className="flex flex-col items-center justify-center gap-3 text-center">
              <p className="text-[var(--text-muted)]">Оберіть шаблон мітки зверху</p>
              {templates.length === 0 && <p className="text-xs text-[var(--text-faint)]">Спочатку запустіть міграцію бази даних</p>}
            </div>
          ) : (
            <>
              {/* Outer container — clips to CANVAS_W×canvasH */}
              <div
                ref={canvasBoxRef}
                style={{ position: "relative", width: CANVAS_W, height: canvasH, flexShrink: 0, overflow: "hidden" }}
                className="shadow-xl"
                onClick={e => { e.stopPropagation(); editMode && setSelId(null); }}
              >
                {/* Single scaled container — both canvas AND overlays live here in mm space */}
                <div style={{
                  transform: `scale(${scale})`,
                  transformOrigin: "top left",
                  width: `${displayTpl.width_mm}mm`,
                  height: `${displayTpl.height_mm}mm`,
                  position: "absolute",
                  top: 0, left: 0,
                }}>
                  {/* Rendered label (pointer events disabled so overlays catch clicks) */}
                  <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
                    <LabelCanvas template={displayTpl} vars={previewVars} barcodeUrls={previewBcUrls} />
                  </div>

                  {/* Overlays in mm — SAME coordinate system, zero drift at any position */}
                  {editMode && (localTpl?.elements ?? []).map(el => {
                    const isSel = selId === el.id;
                    const hMm   = Math.max(el.h, 1);
                    const HSZ   = 2.5; // handle size in mm
                    return (
                      <div key={el.id} style={{
                        position: "absolute",
                        left: `${el.x}mm`, top: `${el.y}mm`,
                        width: `${el.w}mm`, height: `${hMm}mm`,
                        cursor: "move",
                        outline: isSel ? "0.4mm solid #06b6d4" : "0.2mm dashed rgba(120,120,120,0.4)",
                        boxSizing: "border-box",
                        zIndex: isSel ? 200 : 10,
                      }} onMouseDown={e => { e.stopPropagation(); onElMouseDown(e, el); }}>
                        {isSel && HANDLES.map(h => {
                          const hx = h.includes("e") ? el.w : h.includes("w") ? 0 : el.w / 2;
                          const hy = h.includes("s") ? hMm : h.includes("n") ? 0 : hMm / 2;
                          return (
                            <div key={h} style={{
                              position: "absolute",
                              left: `${hx}mm`, top: `${hy}mm`,
                              width: `${HSZ}mm`, height: `${HSZ}mm`,
                              marginLeft: `${-HSZ / 2}mm`, marginTop: `${-HSZ / 2}mm`,
                              background: "#06b6d4",
                              border: "0.3mm solid #fff",
                              borderRadius: "0.4mm",
                              cursor: HANDLE_CURSOR[h],
                              zIndex: 300,
                              boxShadow: "0 0.5mm 1mm rgba(0,0,0,0.25)",
                            }} onMouseDown={e => { e.stopPropagation(); onHandleMouseDown(e, el, h); }} />
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
              {/* Info below canvas */}
              <p className="text-[10px] text-[var(--text-faint)]">
                {displayTpl.width_mm}×{displayTpl.height_mm} мм
                {editMode && " · Перетягуй елементи · Стрілки 0.5мм · Shift+стрілки 5мм · Del видалити"}
              </p>
            </>
          )}
        </div>

        {/* RIGHT — properties (edit) or template info (preview) */}
        <div className="flex w-64 shrink-0 flex-col border-l border-[var(--border)] bg-[var(--bg-elevated)]">
          <div className="border-b border-[var(--border)] px-3 py-2.5">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
              {editMode ? (selEl ? `${EL_LABELS[selEl.type]} — властивості` : "Властивості") : "Налаштування"}
            </p>
          </div>

          {editMode ? (
            // ── Edit mode: element properties ─────────────────────────────
            <div className="flex-1 overflow-y-auto p-3 space-y-4">
              {selEl ? (
                <>
                  {/* Position + size */}
                  <div className="space-y-2">
                    <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Позиція і розмір (мм)</p>
                    <div className="grid grid-cols-2 gap-2">
                      {(["x","y","w","h"] as const).map(k => (
                        <label key={k} className="flex items-center gap-1.5">
                          <span className="w-4 shrink-0 font-mono text-[10px] uppercase text-[var(--text-faint)]">{k}</span>
                          <input type="number" step={0.5} value={+(selEl[k] as number).toFixed(2)}
                            onChange={e => patchEl(selEl.id, { [k]: parseFloat(e.target.value) || 0 })}
                            className="flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-xs font-mono outline-none focus:border-[var(--accent)]" />
                        </label>
                      ))}
                    </div>
                  </div>
                  <ElProps el={selEl} onChange={p => patchEl(selEl.id, p)} />
                  <button onClick={() => deleteEl(selEl.id)} className="w-full rounded-lg border border-[rgba(239,68,68,.3)] py-1.5 text-xs text-[var(--state-error)] hover:bg-[rgba(239,68,68,.06)] transition-colors">
                    Видалити елемент
                  </button>
                </>
              ) : (
                <>
                  {localTpl && (
                    <div className="space-y-2.5">
                      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Шаблон</p>
                      <label className="block">
                        <span className="mb-1 block text-[10px] text-[var(--text-faint)]">Назва</span>
                        <input value={localTpl.name} onChange={e => setLocalTpl(p => p ? { ...p, name: e.target.value } : null)} className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-xs outline-none focus:border-[var(--accent)]" />
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        <label className="block">
                          <span className="mb-1 block text-[10px] text-[var(--text-faint)]">Ш мм</span>
                          <input type="number" step={0.5} value={localTpl.width_mm} onChange={e => setLocalTpl(p => p ? { ...p, width_mm: parseFloat(e.target.value) || p.width_mm } : null)} className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-xs font-mono outline-none focus:border-[var(--accent)]" />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-[10px] text-[var(--text-faint)]">В мм</span>
                          <input type="number" step={0.5} value={localTpl.height_mm} onChange={e => setLocalTpl(p => p ? { ...p, height_mm: parseFloat(e.target.value) || p.height_mm } : null)} className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-xs font-mono outline-none focus:border-[var(--accent)]" />
                        </label>
                      </div>
                    </div>
                  )}
                  <p className="text-xs text-[var(--text-faint)] text-center py-4">Клікни елемент на полотні</p>
                </>
              )}
            </div>
          ) : (
            // ── Preview mode: print settings ─────────────────────────────
            <div className="flex-1 overflow-y-auto p-3 space-y-4">
              {activeTpl && (
                <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3 space-y-1 text-xs">
                  <p className="font-medium">{activeTpl.name}</p>
                  <p className="text-[var(--text-faint)]">{activeTpl.width_mm}×{activeTpl.height_mm} мм · {activeTpl.elements.length} ел.</p>
                  {activeTpl.is_builtin && <span className="inline-block rounded bg-[var(--surface-hi)] px-1.5 py-0.5 text-[10px]">вбудований</span>}
                </div>
              )}

              {/* QR override for single item */}
              {isSingle && activeTpl && (
                <div>
                  <p className="mb-1.5 text-[10px] font-medium text-[var(--text-muted)]">Вміст QR / штрих-коду</p>
                  <input value={customQr} onChange={e => setCustomQr(e.target.value)} className={`${inputCls} w-full font-mono`} />
                  {customQr !== defaultQr(previewItem) && (
                    <button onClick={() => setCustomQr(defaultQr(previewItem))} className="mt-1 text-[10px] text-[var(--text-faint)] hover:text-[var(--text)] underline underline-offset-2">
                      Скинути до {defaultQr(previewItem)}
                    </button>
                  )}
                </div>
              )}

              {items.length > 1 && (
                <p className="text-xs text-[var(--text-faint)]">
                  Всього {items.length} міток. A4 — всі разом, Zebra — по одній.
                </p>
              )}

              {!activeTpl && templates.length > 0 && (
                <p className="text-sm text-[var(--text-muted)] text-center py-6">Оберіть шаблон зверху</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
    </div>  {/* end modal dialog */}

    {/* Print portal — React-rendered labels, @media print shows only these */}
    {printing && activeTpl && createPortal(
      (() => {
        // Auto-calculate minimum margin so labels fit maximum columns
        // A4 = 210mm. Find largest margin where at least 1 label fits.
        // Try 2 columns first; fall back to 1.
        const lw = activeTpl.width_mm;
        const GAP = 2;
        const marginForTwo = Math.max(1, Math.floor((210 - 2 * lw - GAP) / 2));
        const margin = lw * 2 + GAP + marginForTwo * 2 <= 210 ? marginForTwo : Math.max(1, Math.floor((210 - lw) / 2));
        const cols = lw * 2 + GAP + margin * 2 <= 210 ? 2 : 1;

        return (
          <>
            {/* eslint-disable-next-line react/no-danger */}
            <style dangerouslySetInnerHTML={{ __html: `
              @media print {
                body > *:not(#wl-a4-print) { display: none !important; }
                @page { size: A4; margin: ${margin}mm; }
              }
              @media screen { #wl-a4-print { display: none !important; } }
            ` }} />
            <div id="wl-a4-print" style={{
              display: "grid",
              gridTemplateColumns: `repeat(${cols}, ${lw}mm)`,
              gap: `${GAP}mm`,
              alignContent: "flex-start",
              background: "#fff",
              fontFamily: "Arial, Helvetica, sans-serif",
            }}>
              {items.map((item, i) => {
                const vars = itemToVars(
                  item,
                  isSingle && i === 0 ? qrVal : defaultQr(item),
                  item.type === "product" ? imgUrls[item.id] : undefined,
                );
                const bcu: Record<string, string> = {};
                activeTpl.elements.filter(e => e.type === "barcode").forEach(el => {
                  const raw = substituteVars(el.value ?? "", vars as Record<string, string>);
                  if (printBcUrls[raw]) bcu[raw] = printBcUrls[raw];
                });
                return (
                  <div key={i} style={{ breakInside: "avoid", pageBreakInside: "avoid" }}>
                    <LabelCanvas template={activeTpl} vars={vars} barcodeUrls={bcu} />
                  </div>
                );
              })}
            </div>
          </>
        );
      })(),
      document.body,
    )}
    </>
  );
}

// ─── Element properties ───────────────────────────────────────────────────────

function ElProps({ el, onChange }: { el: LabelElement; onChange: (p: Partial<LabelElement>) => void }) {
  const inp = "w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-xs outline-none focus:border-[var(--accent)]";
  const lbl = "mb-1 block text-[10px] text-[var(--text-faint)]";
  const seg = (opts: {v:string;label:string}[], cur:string|undefined, set:(v:string)=>void) => (
    <div className="flex rounded-lg border border-[var(--border)] overflow-hidden">
      {opts.map(o => <button key={o.v} onClick={() => set(o.v)} className={["flex-1 py-1.5 text-xs transition", cur===o.v?"bg-[var(--accent)] text-white":"text-[var(--text-muted)] hover:bg-[var(--surface-hi)]"].join(" ")}>{o.label}</button>)}
    </div>
  );

  switch (el.type) {
    case "text": return (
      <div className="space-y-3">
        <label className="block"><span className={lbl}>Текст</span>
          <input value={el.text??""} onChange={e=>onChange({text:e.target.value})} className={inp}/>
          <div className="mt-1 flex flex-wrap gap-1">
            {ALL_VARS.map(v=><button key={v} type="button" onClick={()=>onChange({text:(el.text??"")+v})}
              className="rounded border border-[var(--border)] px-1 py-0.5 font-mono text-[9px] text-[var(--text-faint)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors">{v.replace(/[{}]/g,"")}</button>)}
          </div>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block"><span className={lbl}>Розмір (мм)</span><input type="number" step={0.5} min={1} value={el.fontSize??4} onChange={e=>onChange({fontSize:parseFloat(e.target.value)||4})} className={inp}/></label>
          <label className="block"><span className={lbl}>Жирний</span>{seg([{v:"bold",label:"Жирний"},{v:"normal",label:"Звичайний"}],el.fontWeight,v=>onChange({fontWeight:v as "bold"|"normal"}))}</label>
        </div>
        <label className="block"><span className={lbl}>Колір</span>
          <div className="flex gap-1.5"><input type="color" value={el.color??"#111111"} onChange={e=>onChange({color:e.target.value})} className="h-8 w-9 cursor-pointer rounded border border-[var(--border)]"/>
          <input value={el.color??"#111111"} onChange={e=>onChange({color:e.target.value})} className={`${inp} flex-1 font-mono`} maxLength={7}/></div>
        </label>
        <label className="block"><span className={lbl}>Вирівнювання</span>{seg([{v:"left",label:"◀ Ліво"},{v:"center",label:"◈ Центр"},{v:"right",label:"Право ▶"}],el.align,v=>onChange({align:v as "left"|"center"|"right"}))}</label>
      </div>
    );
    case "qr": return (
      <div className="space-y-3">
        <label className="block"><span className={lbl}>Вміст</span>
          <input value={el.value??""} onChange={e=>onChange({value:e.target.value})} className={`${inp} font-mono`}/>
          <div className="mt-1 flex flex-wrap gap-1">{ALL_VARS.map(v=><button key={v} type="button" onClick={()=>onChange({value:v})} className="rounded border border-[var(--border)] px-1 py-0.5 font-mono text-[9px] text-[var(--text-faint)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors">{v.replace(/[{}]/g,"")}</button>)}</div>
        </label>
        <label className="block"><span className={lbl}>Рівень корекції</span>{seg([{v:"L",label:"L"},{v:"M",label:"M"},{v:"Q",label:"Q"},{v:"H",label:"H"}],el.level,v=>onChange({level:v as "L"|"M"|"Q"|"H"}))}</label>
      </div>
    );
    case "barcode": return (
      <div className="space-y-3">
        <label className="block"><span className={lbl}>Вміст</span>
          <input value={el.value??""} onChange={e=>onChange({value:e.target.value})} className={`${inp} font-mono`}/>
          <div className="mt-1 flex flex-wrap gap-1">{ALL_VARS.map(v=><button key={v} type="button" onClick={()=>onChange({value:v})} className="rounded border border-[var(--border)] px-1 py-0.5 font-mono text-[9px] text-[var(--text-faint)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors">{v.replace(/[{}]/g,"")}</button>)}</div>
        </label>
        <label className="block"><span className={lbl}>Формат</span>{seg([{v:"CODE128",label:"Code128"},{v:"EAN13",label:"EAN-13"}],el.barcodeFormat,v=>onChange({barcodeFormat:v as "CODE128"|"EAN13"}))}</label>
        <label className="flex cursor-pointer items-center gap-2"><input type="checkbox" checked={el.showText??false} onChange={e=>onChange({showText:e.target.checked})} className="h-3.5 w-3.5"/><span className="text-xs text-[var(--text)]">Показувати текст під баркодом</span></label>
      </div>
    );
    case "image": return (
      <div className="space-y-3">
        <p className="text-xs text-[var(--text-faint)]">Джерело: фото товару</p>
        <label className="block"><span className={lbl}>Заповнення</span>{seg([{v:"cover",label:"Обрізати"},{v:"contain",label:"Вмістити"}],el.objectFit,v=>onChange({objectFit:v as "cover"|"contain"}))}</label>
      </div>
    );
    case "rect": return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <label className="block"><span className={lbl}>Колір рамки</span><div className="flex gap-1"><input type="color" value={el.borderColor??"#cccccc"} onChange={e=>onChange({borderColor:e.target.value})} className="h-8 w-9 cursor-pointer rounded border border-[var(--border)]"/><input value={el.borderColor??"#cccccc"} onChange={e=>onChange({borderColor:e.target.value})} className={`${inp} flex-1 font-mono text-[10px]`}/></div></label>
          <label className="block"><span className={lbl}>Товщина (мм)</span><input type="number" step={0.1} min={0} value={el.borderWidth??0.3} onChange={e=>onChange({borderWidth:parseFloat(e.target.value)||0})} className={inp}/></label>
          <label className="block"><span className={lbl}>Заливка</span><div className="flex gap-1"><input type="color" value={el.fillColor&&el.fillColor!=="transparent"?el.fillColor:"#ffffff"} onChange={e=>onChange({fillColor:e.target.value})} className="h-8 w-9 cursor-pointer rounded border border-[var(--border)]"/><button onClick={()=>onChange({fillColor:"transparent"})} className="flex-1 rounded border border-[var(--border)] text-[10px] text-[var(--text-faint)] hover:bg-[var(--surface-hi)]">прозора</button></div></label>
          <label className="block"><span className={lbl}>Радіус (мм)</span><input type="number" step={0.5} min={0} value={el.borderRadius??0} onChange={e=>onChange({borderRadius:parseFloat(e.target.value)||0})} className={inp}/></label>
        </div>
      </div>
    );
    case "line": return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <label className="block"><span className={lbl}>Колір</span><div className="flex gap-1"><input type="color" value={el.strokeColor??"#cccccc"} onChange={e=>onChange({strokeColor:e.target.value})} className="h-8 w-9 cursor-pointer rounded border border-[var(--border)]"/><input value={el.strokeColor??"#cccccc"} onChange={e=>onChange({strokeColor:e.target.value})} className={`${inp} flex-1 font-mono text-[10px]`}/></div></label>
          <label className="block"><span className={lbl}>Товщина (мм)</span><input type="number" step={0.1} min={0.1} value={el.strokeWidth??0.5} onChange={e=>onChange({strokeWidth:parseFloat(e.target.value)||0.5})} className={inp}/></label>
        </div>
        <label className="block"><span className={lbl}>Орієнтація</span>{seg([{v:"horizontal",label:"─ Горизонт."},{v:"vertical",label:"│ Вертикал."}],el.orientation,v=>onChange({orientation:v as "horizontal"|"vertical"}))}</label>
      </div>
    );
    default: return null;
  }
}
