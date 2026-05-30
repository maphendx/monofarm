"use client";

/**
 * ScannerModal — universal barcode/QR scanner overlay.
 *
 * Default mode: scan a cell + a product → assign product to that cell.
 * Action mode: scan a functional ACTION QR first → the chosen operation
 * (write-off / transfer / receive / stocktake) runs after the keeper scans
 * the cell(s) + product and enters a quantity. Action stays active after each
 * confirm so repeated operations need only one ACTION scan.
 *
 * ACTION QR format: "ACTION:WRITE_OFF" | "ACTION:TRANSFER" | "ACTION:RECEIVE"
 * | "ACTION:STOCKTAKE" (print a wall sheet via the footer button).
 *
 * Device: DS6878 handheld (keyboard-wedge — types the code + Enter into the
 * focused field). No camera. iPad-friendly tap targets for future workers.
 */

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

type CellDetail = { cell_id: number; cell_code: string; cell_notes: string | null; zone_name: string; warehouse_name: string };
type Product    = { id: number; name: string; sku: string; barcode: string | null; unit: string };
type ScanResult = { type: "cell" | "product"; cell?: CellDetail; product?: Product };
type ScanAction = "write_off" | "transfer" | "receive" | "stocktake";

const ACTIONS: Record<ScanAction, { label: string; verb: string; idle: string; qtyLabel: string; needsTo: boolean; needsPrice: boolean }> = {
  write_off: { label: "Списання",        verb: "Списати",      idle: "Списання: скануй комірку, потім товар",          qtyLabel: "Кількість",            needsTo: false, needsPrice: false },
  transfer:  { label: "Переміщення",     verb: "Перемістити",  idle: "Переміщення: скануй комірку-джерело",            qtyLabel: "Кількість",            needsTo: true,  needsPrice: false },
  receive:   { label: "Прийом",          verb: "Прийняти",     idle: "Прийом: скануй комірку, потім товар",            qtyLabel: "Кількість",            needsTo: false, needsPrice: true  },
  stocktake: { label: "Інвентаризація",  verb: "Зберегти факт", idle: "Інвентаризація: скануй комірку, потім товар",   qtyLabel: "Фактично в комірці",   needsTo: false, needsPrice: false },
};

// ACTION QR suffix → action.
const ACTION_QR: Record<string, ScanAction> = {
  WRITE_OFF: "write_off", TRANSFER: "transfer", RECEIVE: "receive", STOCKTAKE: "stocktake",
};

// ── Action-QR print sheet (wall poster) ─────────────────────────────────────────

function printActionSheet() {
  const items = [
    { code: "ACTION:WRITE_OFF", label: "Списання" },
    { code: "ACTION:TRANSFER",  label: "Переміщення" },
    { code: "ACTION:RECEIVE",   label: "Прийом" },
    { code: "ACTION:STOCKTAKE", label: "Інвентаризація" },
  ];
  const cards = items.map((it) => `
    <div style="display:inline-flex;flex-direction:column;align-items:center;border:1px solid #ccc;padding:18px;margin:10px;border-radius:8px;width:220px">
      <div id="qr-${it.code}"></div>
      <p style="font-family:sans-serif;font-size:22px;font-weight:bold;margin:12px 0 2px">${it.label}</p>
      <p style="font-family:monospace;font-size:11px;color:#888;margin:0">${it.code}</p>
    </div>`).join("");
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(`<html><head><title>QR дій складу</title></head><body>
    <h2 style="font-family:sans-serif">Функціональні QR-коди дій</h2>
    <div style="display:flex;flex-wrap:wrap">${cards}</div>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
    <script>${items.map((it) => `new QRCode(document.getElementById('qr-${it.code}'),{text:'${it.code}',width:170,height:170});`).join("")}</script>
  </body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 800);
}

// ── Scanned row ─────────────────────────────────────────────────────────────────

function ScanRow({
  badge, badgeClass, mono, sub, onClear,
}: { badge: string; badgeClass: string; mono: string; sub: string; onClear: () => void }) {
  return (
    <div className="flex items-center gap-4 px-7 py-3.5 text-lg">
      <span className={`shrink-0 rounded-md bg-[var(--surface-hi)] px-2.5 py-1 text-sm ${badgeClass}`}>{badge}</span>
      <span className="font-mono text-xl font-bold">{mono}</span>
      <span className="truncate text-[var(--text-faint)]">{sub}</span>
      <button onClick={onClear} className="ml-auto shrink-0 text-base text-[var(--text-faint)] hover:text-[var(--state-error)]">×</button>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ScannerModal({ onClose }: { onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value,   setValue]   = useState("");
  const [action,  setAction]  = useState<ScanAction | null>(null);
  const [cell,    setCell]    = useState<CellDetail | null>(null);
  const [product, setProduct] = useState<Product | null>(null);
  const [toCell,  setToCell]  = useState<CellDetail | null>(null);
  const [qty,     setQty]     = useState("1");
  const [price,   setPrice]   = useState("");
  const [loading, setLoading] = useState(false);
  const [busy,    setBusy]    = useState(false);
  const [done,    setDone]    = useState(false);
  const [err,     setErr]     = useState<string | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  const refocus = () => setTimeout(() => inputRef.current?.focus(), 80);

  const meta    = action ? ACTIONS[action] : null;
  const needsTo = !!meta?.needsTo;
  const ready   = !!product && !!cell && (!needsTo || !!toCell);

  function clearContext() { setCell(null); setProduct(null); setToCell(null); setQty("1"); setPrice(""); setDone(false); }

  async function scan(raw: string) {
    const q = raw.trim();
    if (!q) return;
    setValue(""); setErr(null); setDone(false);

    const up = q.toUpperCase();
    if (up.startsWith("ACTION:")) {
      const a = ACTION_QR[up.slice(7)];
      if (!a) { setErr("Невідомий QR дії"); refocus(); return; }
      setAction(a); clearContext(); refocus();
      return;
    }

    setLoading(true);
    try {
      const res = await api<ScanResult>(`/api/warehouse/scan?q=${encodeURIComponent(q)}`);
      if (res.type === "product" && res.product) {
        setProduct(res.product);
      } else if (res.type === "cell" && res.cell) {
        if (action === "transfer" && cell && res.cell.cell_id !== cell.cell_id) {
          setToCell(res.cell);
        } else {
          setCell(res.cell);
          if (action === "transfer") setToCell(null);
        }
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Не знайдено");
    } finally {
      setLoading(false);
      refocus();
    }
  }

  async function confirm() {
    if (!ready || busy || !cell || !product) return;
    setBusy(true);
    try {
      const quantity = parseFloat(qty) || 1;
      if (!action) {
        await api(`/api/warehouse/cells/${cell.cell_id}/assign`, {
          method: "POST",
          body: JSON.stringify({ product_id: product.id, quantity }),
        });
        toast.success(`✓ ${product.name} → ${cell.cell_code}`);
      } else {
        const body: Record<string, unknown> = { action, product_id: product.id, quantity, cell_id: cell.cell_id };
        if (needsTo && toCell) body.to_cell_id = toCell.cell_id;
        if (action === "receive" && price.trim()) body.unit_cost = parseFloat(price);
        const r = await api<{ message: string }>(`/api/warehouse/scan-action`, { method: "POST", body: JSON.stringify(body) });
        toast.success(r.message);
      }
      setDone(true);
      setTimeout(() => { clearContext(); refocus(); }, 1200);   // keep action for repeats
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Помилка");
    } finally {
      setBusy(false);
      refocus();
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "Enter" && value.trim()) { e.preventDefault(); scan(value); }
    else if (e.key === "Enter" && !value.trim() && ready) { e.preventDefault(); confirm(); }
  }

  function instruction(): string {
    if (needsTo) {
      if (!cell)    return "Скануй комірку-джерело";
      if (!product) return "Скануй товар";
      if (!toCell)  return "Скануй комірку призначення";
      return "Введи кількість і підтверди";
    }
    if (!cell && !product) return meta ? meta.idle : "Відскануй QR комірки або баркод товару";
    if (!cell)    return "Скануй комірку";
    if (!product) return "Скануй товар";
    return "Введи кількість і підтверди";
  }

  const hasContext = !!cell || !!product || !!toCell;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[8vh]" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative w-full max-w-[1040px] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Input row */}
        <div className="flex items-center gap-4 border-b border-[var(--border)] px-7 py-5">
          {loading ? (
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              className="shrink-0 animate-spin text-[var(--accent)]">
              <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
          ) : (
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-faint)]">
              <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
              <rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3"/><path d="M17 21v-4h4"/><path d="M21 14h-4"/>
            </svg>
          )}
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Скануй QR комірки, товар або QR дії…"
            className="flex-1 bg-transparent text-2xl outline-none placeholder:text-[var(--text-faint)]"
            autoComplete="off"
          />
          {(hasContext || action) && (
            <button onClick={() => { setAction(null); clearContext(); refocus(); }}
              className="text-sm text-[var(--text-faint)] hover:text-[var(--text)] transition-colors">
              ↺ скинути
            </button>
          )}
          <kbd className="rounded-md border border-[var(--border)] px-2.5 py-1 text-sm text-[var(--text-faint)]">esc</kbd>
        </div>

        {/* Action banner */}
        {action && meta && (
          <div className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--accent-soft)] px-7 py-2.5">
            <span className="text-sm font-medium text-[var(--accent)]">Режим: {meta.label}</span>
            <button onClick={() => { setAction(null); clearContext(); refocus(); }}
              className="ml-auto text-sm text-[var(--text-faint)] hover:text-[var(--state-error)]">вийти з режиму ×</button>
          </div>
        )}

        {/* State area */}
        <div className="min-h-[180px] py-3">
          {cell && (
            <ScanRow badge={needsTo ? "Звідки" : "Комірка"} badgeClass="text-[var(--accent)]"
              mono={cell.cell_code} sub={`${cell.zone_name} · ${cell.warehouse_name}`}
              onClear={() => { setCell(null); setToCell(null); }} />
          )}
          {product && (
            <ScanRow badge="Товар" badgeClass="text-[var(--state-ok)]"
              mono={product.sku} sub={product.name}
              onClear={() => setProduct(null)} />
          )}
          {needsTo && toCell && (
            <ScanRow badge="Куди" badgeClass="text-[var(--accent)]"
              mono={toCell.cell_code} sub={`${toCell.zone_name} · ${toCell.warehouse_name}`}
              onClear={() => setToCell(null)} />
          )}

          {/* Quantity + confirm */}
          {ready && !done && (
            <div className="flex flex-wrap items-center gap-4 border-t border-[var(--border)] px-7 py-5">
              <span className="text-lg text-[var(--text-muted)]">{meta ? meta.qtyLabel : "Кількість"}</span>
              <input
                type="number" min="0.01" step="1" inputMode="numeric"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); confirm(); } }}
                className="w-28 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-center font-mono text-xl outline-none focus:border-[var(--accent)]"
                autoFocus
              />
              {action === "receive" && (
                <>
                  <span className="text-lg text-[var(--text-muted)]">Ціна/од.</span>
                  <input
                    type="number" min="0" step="0.01" inputMode="decimal"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); confirm(); } }}
                    placeholder="опц."
                    className="w-32 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-center font-mono text-xl outline-none focus:border-[var(--accent)] placeholder:text-base placeholder:text-[var(--text-faint)]"
                  />
                </>
              )}
              <button onClick={confirm} disabled={busy}
                className="flex-1 rounded-xl bg-[var(--accent)] py-3 text-lg font-medium text-white hover:opacity-90 disabled:opacity-50">
                {busy ? "…" : `✓ ${meta ? meta.verb : "Призначити"}`}
              </button>
              <kbd className="shrink-0 rounded-md border border-[var(--border)] px-2.5 py-1 text-sm text-[var(--text-faint)]">↵</kbd>
            </div>
          )}

          {/* Done */}
          {done && (
            <div className="px-7 py-8 text-center text-xl text-[var(--state-ok)]">✓ Готово — скануй наступне</div>
          )}

          {/* Hint */}
          {!ready && !done && (
            <p className={["px-7 py-3 text-base text-[var(--text-faint)]",
              hasContext ? "border-t border-[var(--border)] animate-pulse" : "",
            ].join(" ")}>
              {instruction()}
            </p>
          )}

          {err && (
            <p className="border-t border-[var(--border)] px-7 py-3 text-base text-[var(--state-error)]">{err}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-6 border-t border-[var(--border)] px-7 py-3 text-sm text-[var(--text-faint)]">
          <button onClick={printActionSheet} className="hover:text-[var(--text)] transition-colors">🖨 Друк QR дій</button>
          <span className="ml-auto"><kbd className="rounded border border-[var(--border)] px-1.5 py-0.5">↵</kbd> підтвердити</span>
          <span><kbd className="rounded border border-[var(--border)] px-1.5 py-0.5">esc</kbd> закрити</span>
          <span className="opacity-60">монофарм · сканер</span>
        </div>
      </div>
    </div>
  );
}
