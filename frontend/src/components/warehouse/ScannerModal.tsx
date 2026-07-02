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
import { WarehouseLabelModal, type WarehouseLabelItem } from "@/components/warehouse/WarehouseLabelModal";

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

type PickLocation = { warehouse_name: string; zone_name: string; cell_code: string; quantity: string };
type PickItem     = { product_id: number; product_name: string; sku: string | null; qty_needed: number; available: string; locations: PickLocation[] };
type PickList     = { order_id: number; order_number: string; items: PickItem[] };

// Keyboard-wedge scanners fire fast; short square-wave beeps confirm each scan
// without looking at the screen. High = ok, low+long = error.
function beep(ok: boolean) {
  try {
    type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext };
    const Ctor = window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "square";
    osc.frequency.value = ok ? 1318 : 220;
    gain.gain.setValueAtTime(0.06, ctx.currentTime);
    osc.start();
    osc.stop(ctx.currentTime + (ok ? 0.09 : 0.3));
    osc.onended = () => { void ctx.close(); };
  } catch {
    // audio unavailable (no user gesture yet / permissions) — stay silent
  }
}

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

// ── Action-QR label items ────────────────────────────────────────────────────

const ACTION_LABEL_ITEMS: WarehouseLabelItem[] = [
  { type: "action", id: 0, code: "ACTION:WRITE_OFF",      label: "Списання" },
  { type: "action", id: 1, code: "ACTION:TRANSFER",       label: "Переміщення" },
  { type: "action", id: 2, code: "ACTION:RECEIVE",        label: "Прийом" },
  { type: "action", id: 3, code: "ACTION:STOCKTAKE",      label: "Інвентаризація" },
  { type: "action", id: 4, code: "ACTION:SALE_OUT",       label: "Відвантаження" },
  { type: "action", id: 5, code: "ACTION:DEFECT",         label: "Брак" },
  { type: "action", id: 6, code: "ACTION:PRODUCTION_IN",  label: "Оприбуткування" },
  { type: "action", id: 7, code: "ACTION:PRODUCTION_OUT", label: "Видача у виробництво" },
];

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

export function ScannerModal({ onClose, fullscreen = false }: { onClose: () => void; fullscreen?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const qtyRef   = useRef<HTMLInputElement>(null);
  const [value,        setValue]        = useState("");
  const [actionLabelOpen, setActionLabelOpen] = useState(false);
  const [action,  setAction]  = useState<ScanAction | null>(null);
  const [cell,    setCell]    = useState<CellDetail | null>(null);
  const [product, setProduct] = useState<Product | null>(null);
  const [toCell,  setToCell]  = useState<CellDetail | null>(null);
  const [order,   setOrder]   = useState<OrderInfo | null>(null);
  const [pick,    setPick]    = useState<PickList | null>(null);
  const [qty,     setQty]     = useState("0");
  const [price,   setPrice]   = useState("");
  const [plusOne, setPlusOne] = useState(false);
  const [lastOp,  setLastOp]  = useState<{ id: number; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy,    setBusy]    = useState(false);
  const [done,    setDone]    = useState(false);
  const [err,     setErr]     = useState<string | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  const refocus = () => setTimeout(() => inputRef.current?.focus(), 80);

  const meta    = action ? ACTIONS[action] : null;
  const needsTo = !!meta?.needsTo;
  const ready   = !!product && !!cell && (!needsTo || !!toCell);

  function clearContext() { setCell(null); setProduct(null); setToCell(null); setOrder(null); setPick(null); setQty("1"); setPrice(""); setDone(false); }

  // Core action runner — used by the confirm button and by "+1 за скан".
  async function runAction(prod: Product, srcCell: CellDetail, quantity: number) {
    const body: Record<string, unknown> = { action, product_id: prod.id, quantity, cell_id: srcCell.cell_id };
    if (needsTo && toCell) body.to_cell_id = toCell.cell_id;
    if (meta?.priceField && price.trim()) body[meta.priceField] = parseFloat(price);
    const r = await api<{ message: string; movement_id: number | null }>(
      `/api/warehouse/scan-action`, { method: "POST", body: JSON.stringify(body) });
    if (r.movement_id) setLastOp({ id: r.movement_id, message: r.message });
    return r;
  }

  async function undoLast() {
    if (!lastOp || busy) return;
    setBusy(true);
    try {
      const r = await api<{ message: string }>(`/api/warehouse/movements/${lastOp.id}/reverse`, { method: "POST" });
      toast.success(r.message);
      beep(true);
      setLastOp(null);
      new BroadcastChannel("wh_cell_updated").postMessage(1);
    } catch (e: unknown) {
      beep(false);
      toast.error(e instanceof Error ? e.message : "Помилка сторно");
    } finally {
      setBusy(false);
      refocus();
    }
  }

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
        const [o, pl] = await Promise.all([
          api<OrderInfo>(`/api/warehouse/orders/${id}`),
          api<PickList>(`/api/warehouse/orders/${id}/pick-list`).catch(() => null),
        ]);
        setAction(null); setCell(null); setProduct(null); setToCell(null);
        setOrder(o); setPick(pl);
        beep(true);
      } catch (e: unknown) {
        beep(false);
        setErr(e instanceof Error ? e.message : "Замовлення не знайдено");
      } finally { setLoading(false); refocus(); }
      return;
    }

    setLoading(true);
    let focusQty = false;
    try {
      const res = await api<ScanResult>(`/api/warehouse/scan?q=${encodeURIComponent(q)}`);
      if (res.type === "product" && res.product) {
        setProduct(res.product);
        beep(true);
        // "+1 за скан": with an active action + source cell, every product scan
        // immediately executes the operation with qty 1 — no confirm needed.
        if (plusOne && action && cell && !needsTo && !busy) {
          setBusy(true);
          try {
            const r = await runAction(res.product, cell, 1);
            toast.success(r.message);
            beep(true);
            new BroadcastChannel("wh_cell_updated").postMessage(1);
          } catch (e: unknown) {
            beep(false);
            toast.error(e instanceof Error ? e.message : "Помилка");
          } finally {
            setBusy(false);
          }
        } else {
          focusQty = !!cell && (!needsTo || !!toCell);
        }
      } else if (res.type === "cell" && res.cell) {
        beep(true);
        if (action === "transfer" && cell && res.cell.cell_id !== cell.cell_id) {
          setToCell(res.cell);
          focusQty = !!product;
        } else {
          setCell(res.cell);
          if (action === "transfer") setToCell(null);
          focusQty = !!product && !needsTo;
        }
      }
    } catch (e: unknown) {
      beep(false);
      setErr(e instanceof Error ? e.message : "Не знайдено");
    } finally {
      setLoading(false);
      if (focusQty) {
        setTimeout(() => qtyRef.current?.focus(), 80);
      } else {
        refocus();
      }
    }
  }

  async function confirm() {
    if (!ready || busy || !cell || !product) return;
    setBusy(true);
    try {
      const quantity = parseFloat(qty) || 0;
      if (!action) {
        await api(`/api/warehouse/cells/${cell.cell_id}/assign`, {
          method: "POST",
          body: JSON.stringify({ product_id: product.id, quantity }),
        });
        toast.success(`✓ ${product.name} → ${cell.cell_code}`);
      } else {
        const r = await runAction(product, cell, quantity);
        toast.success(r.message);
      }
      beep(true);
      setDone(true);
      new BroadcastChannel("wh_cell_updated").postMessage(1);
      setTimeout(() => { clearContext(); refocus(); }, 1200);   // keep action for repeats
    } catch (e: unknown) {
      beep(false);
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
    <>
    <div
      className={fullscreen
        ? "fixed inset-0 z-50 flex items-stretch justify-center"
        : "fixed inset-0 z-50 flex items-start justify-center px-4 pt-[8vh]"}
      onClick={fullscreen ? undefined : onClose}
    >
      <div className="overlay-in absolute inset-0 bg-black/60" />
      <div
        className={fullscreen
          ? "relative flex w-full flex-col overflow-hidden bg-[var(--bg-elevated)]"
          : "relative w-full max-w-[1040px] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-2xl"}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Input row */}
        <div className="flex items-center gap-4 border-b border-[var(--border)] px-7 py-5">
          {loading ? (
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
              className="shrink-0 animate-spin text-[var(--accent)]">
              <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
          ) : (
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
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
            {!needsTo && (
              <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--text-muted)]"
                title="Кожен скан товару одразу виконує операцію з кількістю 1">
                <input type="checkbox" checked={plusOne} onChange={(e) => { setPlusOne(e.target.checked); refocus(); }} />
                +1 за скан
              </label>
            )}
            <button onClick={() => { setAction(null); setPlusOne(false); clearContext(); refocus(); }}
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
                <div className={`mt-3 overflow-y-auto rounded-xl border border-[var(--border)] ${fullscreen ? "max-h-[46vh]" : "max-h-[260px]"}`}>
                  {pick && pick.items.length > 0 ? (
                    /* Pick-list: what to take and from which cells */
                    pick.items.map((it) => {
                      const short = parseFloat(it.available) < it.qty_needed;
                      return (
                        <div key={it.product_id} className="border-b border-[var(--border)] px-4 py-2.5 last:border-0">
                          <div className="flex items-center gap-4">
                            <span className="truncate">{it.product_name}</span>
                            {it.sku && <span className="shrink-0 font-mono text-sm text-[var(--text-faint)]">{it.sku}</span>}
                            <span className={`ml-auto font-mono text-lg font-semibold ${short ? "text-[var(--state-error)]" : ""}`}>
                              ×{it.qty_needed}
                            </span>
                          </div>
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            {it.locations.length === 0 ? (
                              <span className="text-sm text-[var(--state-warn)]">не розкладено по комірках</span>
                            ) : it.locations.map((loc, j) => (
                              <span key={j}
                                className="rounded-md bg-[var(--surface-hi)] px-2 py-0.5 font-mono text-sm text-[var(--accent)]"
                                title={`${loc.warehouse_name} · ${loc.zone_name}`}>
                                {loc.cell_code} · {parseFloat(loc.quantity)}
                              </span>
                            ))}
                            {short && <span className="text-sm text-[var(--state-error)]">не вистачає (є {parseFloat(it.available)})</span>}
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <>
                      {order.items.map((it, i) => (
                        <div key={i} className="flex items-center gap-4 border-b border-[var(--border)] px-4 py-2.5 last:border-0">
                          <span className="truncate">{it.product_name}</span>
                          <span className="ml-auto font-mono text-lg font-semibold">×{it.quantity}</span>
                        </div>
                      ))}
                      {order.items.length === 0 && <div className="px-4 py-3 text-[var(--text-faint)]">Немає позицій</div>}
                    </>
                  )}
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
                    ref={qtyRef}
                    type="number" min="0" step="1" inputMode="numeric"
                    value={qty}
                    onChange={(e) => setQty(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); confirm(); } }}
                    className="w-28 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-center font-mono text-xl outline-none focus:border-[var(--accent)]"
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
        <div className={`flex items-center gap-6 border-t border-[var(--border)] px-7 py-3 text-sm text-[var(--text-faint)] ${fullscreen ? "mt-auto" : ""}`}>
          <button onClick={() => setActionLabelOpen(true)} className="hover:text-[var(--text)] transition-colors">🏷 Мітки QR дій</button>
          {lastOp && (
            <button onClick={undoLast} disabled={busy}
              title={lastOp.message}
              className="rounded-md border border-[var(--border-strong)] px-2.5 py-1 text-[var(--state-warn)] hover:bg-[var(--surface-hi)] transition-colors disabled:opacity-50">
              ↩ Сторно останньої
            </button>
          )}
          <span className="ml-auto"><kbd className="rounded border border-[var(--border)] px-1.5 py-0.5">↵</kbd> підтвердити</span>
          <span><kbd className="rounded border border-[var(--border)] px-1.5 py-0.5">esc</kbd> закрити</span>
          <span className="opacity-60">монофарм · сканер</span>
        </div>
      </div>
    </div>

    {actionLabelOpen && (
      <WarehouseLabelModal
        items={ACTION_LABEL_ITEMS}
        onClose={() => { setActionLabelOpen(false); inputRef.current?.focus(); }}
      />
    )}
    </>
  );
}
