"use client";

/**
 * ScannerModal — universal barcode/QR scanner overlay.
 *
 * Default mode: scan a cell + a product → assign product to that cell.
 * Action mode: scan a functional ACTION QR first → the chosen operation runs
 * after the keeper scans the cell(s) + product and enters a quantity. Action
 * stays active after each confirm so repeated operations need only one ACTION
 * scan.
 * Order mode: scan an ORDER QR → show the order and ship it whole.
 *
 * ACTION QR format: "ACTION:WRITE_OFF | TRANSFER | RECEIVE | STOCKTAKE |
 * SALE_OUT | DEFECT | PRODUCTION_IN | PRODUCTION_OUT" (print via footer).
 * ORDER QR format: "ORDER:{id}".
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
type ScanAction = "write_off" | "transfer" | "receive" | "stocktake" | "sale_out" | "defect" | "production_in" | "production_out";
type PriceField = "unit_cost" | "unit_price";

type OrderItem  = { product_name: string; quantity: number };
type OrderInfo  = {
  id: number; order_number: string; status: string;
  customer_name: string | null; counterparty_name: string | null;
  total_amount: string | null; currency: string; items: OrderItem[];
};

const SHIPPABLE = new Set(["confirmed", "ready"]);
const ORDER_STATUS_LABEL: Record<string, string> = {
  new: "Новий", confirmed: "Підтверджено", in_production: "Виробництво",
  ready: "Готове", shipped: "Відвантажено", cancelled: "Скасовано",
};

const ACTIONS: Record<ScanAction, { label: string; verb: string; idle: string; qtyLabel: string; needsTo: boolean; priceField?: PriceField; priceLabel?: string }> = {
  write_off:      { label: "Списання",       verb: "Списати",        idle: "Списання: скануй комірку, потім товар",        qtyLabel: "Кількість",          needsTo: false },
  transfer:       { label: "Переміщення",    verb: "Перемістити",    idle: "Переміщення: скануй комірку-джерело",          qtyLabel: "Кількість",          needsTo: true  },
  receive:        { label: "Прийом",         verb: "Прийняти",       idle: "Прийом: скануй комірку, потім товар",          qtyLabel: "Кількість",          needsTo: false, priceField: "unit_cost",  priceLabel: "Ціна/од." },
  stocktake:      { label: "Інвентаризація", verb: "Зберегти факт",  idle: "Інвентаризація: скануй комірку, потім товар",  qtyLabel: "Фактично в комірці", needsTo: false },
  sale_out:       { label: "Відвантаження",  verb: "Відвантажити",   idle: "Відвантаження: скануй комірку, потім товар",   qtyLabel: "Кількість",          needsTo: false, priceField: "unit_price", priceLabel: "Ціна продажу/од." },
  defect:         { label: "Брак",           verb: "Списати в брак", idle: "Брак: скануй комірку, потім товар",            qtyLabel: "Кількість",          needsTo: false },
  production_in:  { label: "Оприбуткування", verb: "Оприбуткувати",  idle: "Оприбуткування: скануй комірку, потім товар",  qtyLabel: "Кількість",          needsTo: false },
  production_out: { label: "Видача у виробництво", verb: "Видати",   idle: "Видача у виробництво: скануй комірку, потім товар", qtyLabel: "Кількість",     needsTo: false },
};

// ACTION QR suffix → action.
const ACTION_QR: Record<string, ScanAction> = {
  WRITE_OFF: "write_off", TRANSFER: "transfer", RECEIVE: "receive", STOCKTAKE: "stocktake",
  SALE_OUT: "sale_out", DEFECT: "defect", PRODUCTION_IN: "production_in", PRODUCTION_OUT: "production_out",
};

// ── Action-QR print sheet (wall poster) ─────────────────────────────────────────

function printActionSheet() {
  const items = [
    { code: "ACTION:WRITE_OFF",      label: "Списання" },
    { code: "ACTION:TRANSFER",       label: "Переміщення" },
    { code: "ACTION:RECEIVE",        label: "Прийом" },
    { code: "ACTION:STOCKTAKE",      label: "Інвентаризація" },
    { code: "ACTION:SALE_OUT",       label: "Відвантаження" },
    { code: "ACTION:DEFECT",         label: "Брак" },
    { code: "ACTION:PRODUCTION_IN",  label: "Оприбуткування" },
    { code: "ACTION:PRODUCTION_OUT", label: "Видача у виробництво" },
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
  const [order,   setOrder]   = useState<OrderInfo | null>(null);
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

  function clearContext() { setCell(null); setProduct(null); setToCell(null); setOrder(null); setQty("1"); setPrice(""); setDone(false); }

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
    if (up.startsWith("ORDER:")) {
      const id = parseInt(q.slice(6), 10);
      if (!id) { setErr("Невірний QR замовлення"); refocus(); return; }
      setLoading(true);
      try {
        const o = await api<OrderInfo>(`/api/warehouse/orders/${id}`);
        setAction(null); setCell(null); setProduct(null); setToCell(null); setOrder(o);
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : "Замовлення не знайдено");
      } finally { setLoading(false); refocus(); }
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
        if (meta?.priceField && price.trim()) body[meta.priceField] = parseFloat(price);
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

  async function shipOrder() {
    if (!order || busy) return;
    setBusy(true);
    try {
      await api(`/api/warehouse/orders/${order.id}/ship`, { method: "POST" });
      toast.success(`✓ Відвантажено ${order.order_number}`);
      setDone(true);
      setTimeout(() => { clearContext(); refocus(); }, 1400);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Помилка відвантаження");
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
    if (!cell && !product) return meta ? meta.idle : "Відскануй QR комірки, товар або QR замовлення";
    if (!cell)    return "Скануй комірку";
    if (!product) return "Скануй товар";
    return "Введи кількість і підтверди";
  }

  const hasContext = !!cell || !!product || !!toCell || !!order;
  const customer = order ? (order.counterparty_name || order.customer_name || "—") : "";
  const canShip  = !!order && SHIPPABLE.has(order.status);

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
            placeholder="Скануй QR комірки, товар, QR дії або замовлення…"
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
          {/* Order ship flow */}
          {order ? (
            done ? (
              <div className="px-7 py-8 text-center text-xl text-[var(--state-ok)]">✓ Відвантажено — скануй наступне</div>
            ) : (
              <div className="px-7 py-2">
                <div className="flex items-center gap-4">
                  <span className="shrink-0 rounded-md bg-[var(--surface-hi)] px-2.5 py-1 text-sm text-[var(--accent)]">Замовлення</span>
                  <span className="font-mono text-xl font-bold">{order.order_number}</span>
                  <span className="truncate text-[var(--text-faint)]">{customer}</span>
                  <span className="ml-auto text-base text-[var(--text-muted)]">{ORDER_STATUS_LABEL[order.status] || order.status}</span>
                </div>
                <div className="mt-3 max-h-[220px] overflow-y-auto rounded-xl border border-[var(--border)]">
                  {order.items.map((it, i) => (
                    <div key={i} className="flex items-center gap-4 border-b border-[var(--border)] px-4 py-2.5 last:border-0">
                      <span className="truncate">{it.product_name}</span>
                      <span className="ml-auto font-mono text-lg font-semibold">×{it.quantity}</span>
                    </div>
                  ))}
                  {order.items.length === 0 && <div className="px-4 py-3 text-[var(--text-faint)]">Немає позицій</div>}
                </div>
                <div className="mt-4 flex items-center gap-4">
                  {order.total_amount && (
                    <span className="text-lg text-[var(--text-muted)]">Сума: <span className="font-mono font-semibold text-[var(--text)]">{order.total_amount} {order.currency}</span></span>
                  )}
                  <button onClick={shipOrder} disabled={busy || !canShip}
                    className="ml-auto rounded-xl bg-[var(--accent)] px-6 py-3 text-lg font-medium text-white hover:opacity-90 disabled:opacity-50">
                    {busy ? "…" : "✓ Відвантажити замовлення"}
                  </button>
                </div>
                {!canShip && (
                  <p className="mt-2 text-base text-[var(--state-warn)]">
                    Відвантаження можливе лише для зарезервованого замовлення (статус «підтверджено» / «готове»).
                  </p>
                )}
              </div>
            )
          ) : (
            <>
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
                  {meta?.priceField && (
                    <>
                      <span className="text-lg text-[var(--text-muted)]">{meta.priceLabel}</span>
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
            </>
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
