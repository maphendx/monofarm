"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Modal } from "@/components/ui/Modal";
import {
  useColumnVisibility,
  ColumnSettingsModal,
  TableSettingsButton,
  type ColDef,
} from "@/components/warehouse/TableSettings";

// ── Types ─────────────────────────────────────────────────────────────────────

type OrderStatus = "new" | "confirmed" | "in_production" | "ready" | "shipped" | "cancelled";

const STATUS_META: Record<OrderStatus, { label: string; cls: string }> = {
  new:           { label: "Нове",        cls: "bg-[rgba(56,189,248,.08)] text-[var(--accent)]" },
  confirmed:     { label: "Зарезервовано", cls: "bg-violet-500/15 text-violet-600 dark:text-violet-400" },
  in_production: { label: "Виробництво", cls: "bg-[rgba(245,158,11,.08)] text-[var(--state-warn)]" },
  ready:         { label: "Готово",      cls: "bg-[rgba(34,197,94,.08)] text-[var(--state-ok)]" },
  shipped:       { label: "Відправлено", cls: "bg-[var(--surface-hi)] text-[var(--text-muted)] " },
  cancelled:     { label: "Скасовано",   cls: "bg-[rgba(239,68,68,.08)] text-[var(--state-error)]" },
};

const SOURCE_LABELS: Record<string, string> = {
  manual: "Ручне", etsy: "Etsy", shopify: "Shopify", keycrm: "KeyCRM", api: "API",
};

type OrderItem = {
  id: number; product_name: string; quantity: number;
  unit_price: string; total_price: string; warehouse_id: number | null;
};

type Order = {
  id: number; order_number: string;
  counterparty_id: number | null; counterparty_name: string | null;
  customer_name: string | null; source: string;
  status: OrderStatus; total_amount: string | null;
  paid_amount: string; outstanding: string;
  payment_status: "unpaid" | "partial" | "paid";
  due_date: string | null; notes: string | null;
  items: OrderItem[]; created_at: string;
};

type OrderPayment = {
  id: number; order_id: number; amount: string;
  paid_at: string; method: string | null; note: string | null;
  cashflow_id: number | null; created_at: string;
};

const PAYMENT_BADGE: Record<string, { label: string; cls: string }> = {
  unpaid:  { label: "Не оплачено", cls: "bg-[rgba(239,68,68,.08)] text-[var(--state-error)]" },
  partial: { label: "Частково",    cls: "bg-[rgba(245,158,11,.08)] text-[var(--state-warn)]" },
  paid:    { label: "Оплачено",    cls: "bg-[rgba(34,197,94,.08)] text-[var(--state-ok)]" },
};

const PAYMENT_METHODS = ["card", "cash", "bank", "other"] as const;
const METHOD_LABELS: Record<string, string> = { card: "Картка", cash: "Готівка", bank: "Банк", other: "Інше" };

type Product     = { id: number; name: string; sku: string; sale_price: string | null };
type Counterparty = { id: number; name: string; type: string };
type Warehouse   = { id: number; name: string; type: string };

// ── Create order modal ────────────────────────────────────────────────────────

type LineItem = { product_id: string; quantity: string; unit_price: string };

function CreateOrderModal({ open, onClose, onCreated }: {
  open: boolean; onClose: () => void; onCreated: (o: Order) => void;
}) {
  const [products,       setProducts]       = useState<Product[]>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [counterpartyId, setCounterpartyId] = useState("");
  const [customerName,   setCustomerName]   = useState("");
  const [source,         setSource]         = useState("manual");
  const [dueDate,        setDueDate]        = useState("");
  const [notes,          setNotes]          = useState("");
  const [lines,          setLines]          = useState<LineItem[]>([{ product_id: "", quantity: "1", unit_price: "" }]);
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!open) return;
    setCounterpartyId(""); setCustomerName(""); setSource("manual");
    setDueDate(""); setNotes("");
    setLines([{ product_id: "", quantity: "1", unit_price: "" }]);
    setError(null);
    Promise.all([
      api<Product[]>("/api/warehouse/products"),
      api<Counterparty[]>("/api/warehouse/counterparties"),
    ]).then(([p, c]) => { setProducts(p); setCounterparties(c); }).catch(() => {});
  }, [open]);

  function setLine(idx: number, field: keyof LineItem, value: string) {
    setLines((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      if (field === "product_id" && value) {
        const p = products.find((p) => p.id === parseInt(value));
        if (p?.sale_price) next[idx].unit_price = parseFloat(p.sale_price).toFixed(2);
      }
      return next;
    });
  }

  const validLines = lines.filter((l) => l.product_id && parseInt(l.quantity) > 0 && parseFloat(l.unit_price) >= 0);
  const total      = validLines.reduce((s, l) => s + parseInt(l.quantity || "0") * parseFloat(l.unit_price || "0"), 0);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current || validLines.length === 0) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const body = {
        counterparty_id: counterpartyId ? parseInt(counterpartyId) : null,
        customer_name:   !counterpartyId && customerName.trim() ? customerName.trim() : null,
        source,
        due_date: dueDate || null,
        notes:    notes.trim() || null,
        items: validLines.map((l) => ({
          product_id: parseInt(l.product_id),
          quantity:   parseInt(l.quantity),
          unit_price: parseFloat(l.unit_price),
        })),
      };
      const o = await api<Order>("/api/warehouse/orders", { method: "POST", body: JSON.stringify(body) });
      onCreated(o);
      onClose();
    } catch { setError("Помилка збереження"); }
    finally { inFlight.current = false; setBusy(false); }
  }

  const inputCls = "input";

  return (
    <Modal open={open} onClose={onClose} title="Нове замовлення"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}
            className="btn btn-ghost">
            Скасувати
          </button>
          <button type="submit" form="order-form" disabled={busy || validLines.length === 0}
            className="btn btn-primary disabled:opacity-50">
            {busy ? "Зберігаю…" : `Створити · ₴${total.toLocaleString("uk-UA")}`}
          </button>
        </>
      }
    >
      <form id="order-form" onSubmit={submit} className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)] ">Контрагент</span>
            <select value={counterpartyId} onChange={(e) => setCounterpartyId(e.target.value)} className={inputCls}>
              <option value="">— без контрагента —</option>
              {counterparties.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          {!counterpartyId && (
            <label className="block">
              <span className="mb-1 block text-[var(--text-muted)] ">Клієнт (вільний текст)</span>
              <input value={customerName} onChange={(e) => setCustomerName(e.target.value)}
                placeholder="Ім'я або компанія" className={inputCls} />
            </label>
          )}
          {counterpartyId && (
            <label className="block">
              <span className="mb-1 block text-[var(--text-muted)] ">Джерело</span>
              <select value={source} onChange={(e) => setSource(e.target.value)} className={inputCls}>
                {Object.entries(SOURCE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          {!counterpartyId && (
            <label className="block">
              <span className="mb-1 block text-[var(--text-muted)] ">Джерело</span>
              <select value={source} onChange={(e) => setSource(e.target.value)} className={inputCls}>
                {Object.entries(SOURCE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
          )}
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)] ">Дедлайн</span>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={inputCls} />
          </label>
        </div>

        {/* Line items */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[var(--text-muted)] ">Позиції</span>
            <button type="button"
              onClick={() => setLines((prev) => [...prev, { product_id: "", quantity: "1", unit_price: "" }])}
              className="text-xs text-[var(--accent)] hover:text-[var(--accent)] ">
              + Позиція
            </button>
          </div>
          <div className="space-y-2">
            {lines.map((line, idx) => (
              <div key={idx} className="flex gap-2">
                <select value={line.product_id} onChange={(e) => setLine(idx, "product_id", e.target.value)}
                  className="flex-1 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2 py-1.5 text-sm   ">
                  <option value="">— товар —</option>
                  {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <input type="number" min={1} value={line.quantity} onChange={(e) => setLine(idx, "quantity", e.target.value)}
                  placeholder="К-сть" title="Кількість"
                  className="w-16 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2 py-1.5 text-sm   " />
                <input type="number" min={0} step="0.01" value={line.unit_price} onChange={(e) => setLine(idx, "unit_price", e.target.value)}
                  placeholder="Ціна" title="Ціна"
                  className="w-20 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2 py-1.5 text-sm   " />
                {lines.length > 1 && (
                  <button type="button" onClick={() => setLines((prev) => prev.filter((_, i) => i !== idx))}
                    className="text-[var(--text-muted)] hover:text-[var(--state-error)] ">✕</button>
                )}
              </div>
            ))}
          </div>
        </div>

        <label className="block">
          <span className="mb-1 block text-[var(--text-muted)] ">Нотатка</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls} />
        </label>

        {error && <p className="text-sm text-[var(--state-error)]">{error}</p>}
      </form>
    </Modal>
  );
}

// ── Edit order modal ──────────────────────────────────────────────────────────

const EDITABLE_STATUSES: OrderStatus[] = ["new", "confirmed", "in_production", "ready"];

function EditOrderModal({ open, onClose, order, onSaved }: {
  open: boolean; onClose: () => void;
  order: Order | null; onSaved: (o: Order) => void;
}) {
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [counterpartyId, setCounterpartyId] = useState("");
  const [customerName,   setCustomerName]   = useState("");
  const [status,         setStatus]         = useState<OrderStatus>("new");
  const [dueDate,        setDueDate]        = useState("");
  const [notes,          setNotes]          = useState("");
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!open || !order) return;
    setError(null);
    setCounterpartyId(order.counterparty_id ? String(order.counterparty_id) : "");
    setCustomerName(order.customer_name ?? "");
    setStatus(order.status);
    setDueDate(order.due_date ?? "");
    setNotes(order.notes ?? "");
    api<Counterparty[]>("/api/warehouse/counterparties").then(setCounterparties).catch(() => {});
  }, [open, order]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current || !order) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        status,
        due_date: dueDate || null,
        notes:    notes.trim() || null,
      };
      if (counterpartyId) {
        body.counterparty_id = parseInt(counterpartyId);
      } else {
        body.counterparty_id = null;
        body.customer_name   = customerName.trim() || null;
      }
      const updated = await api<Order>(`/api/warehouse/orders/${order.id}`, {
        method: "PATCH", body: JSON.stringify(body),
      });
      onSaved(updated);
      onClose();
    } catch { setError("Помилка збереження"); }
    finally { inFlight.current = false; setBusy(false); }
  }

  const inputCls = "input";

  return (
    <Modal open={open} onClose={onClose} title={`Редагувати ${order?.order_number ?? ""}`}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}
            className="btn btn-ghost">
            Скасувати
          </button>
          <button type="submit" form="edit-order-form" disabled={busy}
            className="btn btn-primary disabled:opacity-50">
            {busy ? "Зберігаю…" : "Зберегти"}
          </button>
        </>
      }
    >
      <form id="edit-order-form" onSubmit={submit} className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)] ">Контрагент</span>
            <select value={counterpartyId} onChange={(e) => setCounterpartyId(e.target.value)} className={inputCls}>
              <option value="">— без контрагента —</option>
              {counterparties.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          {!counterpartyId && (
            <label className="block">
              <span className="mb-1 block text-[var(--text-muted)] ">Клієнт (текст)</span>
              <input value={customerName} onChange={(e) => setCustomerName(e.target.value)}
                placeholder="Ім'я або компанія" className={inputCls} />
            </label>
          )}
          {counterpartyId && (
            <label className="block">
              <span className="mb-1 block text-[var(--text-muted)] ">Статус</span>
              <select value={status} onChange={(e) => setStatus(e.target.value as OrderStatus)} className={inputCls}>
                {EDITABLE_STATUSES.map((s) => (
                  <option key={s} value={s}>{STATUS_META[s].label}</option>
                ))}
              </select>
            </label>
          )}
        </div>

        {!counterpartyId && (
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)] ">Статус</span>
            <select value={status} onChange={(e) => setStatus(e.target.value as OrderStatus)} className={inputCls}>
              {EDITABLE_STATUSES.map((s) => (
                <option key={s} value={s}>{STATUS_META[s].label}</option>
              ))}
            </select>
          </label>
        )}

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)] ">Дедлайн</span>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={inputCls} />
          </label>
        </div>

        <label className="block">
          <span className="mb-1 block text-[var(--text-muted)] ">Нотатка</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls} />
        </label>

        {error && <p className="text-sm text-[var(--state-error)]">{error}</p>}
      </form>
    </Modal>
  );
}

// ── Payment modal ─────────────────────────────────────────────────────────────

function PaymentModal({ open, onClose, order, onUpdated }: {
  open: boolean; onClose: () => void;
  order: Order | null; onUpdated: (o: Order) => void;
}) {
  const [payments, setPayments] = useState<OrderPayment[]>([]);
  const [amount,   setAmount]   = useState("");
  const [method,   setMethod]   = useState("card");
  const [note,     setNote]     = useState("");
  const [busy,     setBusy]     = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!open || !order) return;
    setAmount(""); setMethod("card"); setNote(""); setError(null);
    api<OrderPayment[]>(`/api/warehouse/orders/${order.id}/payments`).then(setPayments).catch(() => {});
  }, [open, order]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current || !order) return;
    inFlight.current = true;
    setBusy(true); setError(null);
    try {
      const p = await api<OrderPayment>(`/api/warehouse/orders/${order.id}/payments`, {
        method: "POST",
        body: JSON.stringify({ amount: parseFloat(amount), method, note: note.trim() || null }),
      });
      setPayments(prev => [p, ...prev]);
      setAmount(""); setNote("");
      // refresh order to update paid_amount / outstanding / payment_status
      const updated = await api<Order>(`/api/warehouse/orders/${order.id}`);
      onUpdated(updated);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Помилка збереження");
    } finally { inFlight.current = false; setBusy(false); }
  }

  async function deletePayment(pid: number, pAmount: string) {
    if (!order || !confirm(`Скасувати оплату ${parseFloat(pAmount).toLocaleString("uk-UA")} ₴?`)) return;
    try {
      await api(`/api/warehouse/orders/${order.id}/payments/${pid}`, { method: "DELETE" });
      setPayments(prev => prev.filter(p => p.id !== pid));
      const updated = await api<Order>(`/api/warehouse/orders/${order.id}`);
      onUpdated(updated);
    } catch { alert("Помилка видалення"); }
  }

  const outstanding = order ? parseFloat(order.outstanding) : 0;

  return (
    <Modal open={open} onClose={onClose} title={`Оплати — ${order?.order_number ?? ""}`}
      footer={<button type="button" onClick={onClose} className="btn btn-ghost">Закрити</button>}
    >
      <div className="space-y-4 text-sm">
        {/* History */}
        {payments.length > 0 && (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] divide-y divide-[var(--border)]">
            {payments.map(p => (
              <div key={p.id} className="flex items-center justify-between px-3 py-2">
                <div>
                  <span className="font-medium tabular-nums">{parseFloat(p.amount).toLocaleString("uk-UA")} ₴</span>
                  <span className="ml-2 text-xs text-[var(--text-faint)]">{METHOD_LABELS[p.method ?? ""] ?? p.method ?? ""}</span>
                  {p.note && <span className="ml-2 text-xs italic text-[var(--text-faint)]">{p.note}</span>}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--text-faint)]">{p.paid_at}</span>
                  {!p.cashflow_id ? (
                    <span className="text-[10px] text-[var(--text-faint)]">(hist)</span>
                  ) : (
                    <button onClick={() => deletePayment(p.id, p.amount)}
                      className="text-[var(--text-faint)] hover:text-[var(--state-error)] text-xs">✕</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Add payment form */}
        {order?.status !== "cancelled" && (
          <form onSubmit={submit} className="space-y-3">
            <p className="text-xs text-[var(--text-muted)]">
              Залишок до оплати: <span className="font-medium">{outstanding.toLocaleString("uk-UA")} ₴</span>
            </p>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-[var(--text-muted)]">Сума ₴ *</span>
                <input type="number" required min="0.01" step="0.01" value={amount}
                  onChange={e => setAmount(e.target.value)}
                  className="input w-full" />
              </label>
              <label className="block">
                <span className="mb-1 block text-[var(--text-muted)]">Метод</span>
                <select value={method} onChange={e => setMethod(e.target.value)} className="input w-full">
                  {PAYMENT_METHODS.map(m => <option key={m} value={m}>{METHOD_LABELS[m]}</option>)}
                </select>
              </label>
            </div>
            <label className="block">
              <span className="mb-1 block text-[var(--text-muted)]">Нотатка</span>
              <input value={note} onChange={e => setNote(e.target.value)} className="input w-full" />
            </label>
            {error && <p className="text-sm text-[var(--state-error)]">{error}</p>}
            <button type="submit" disabled={busy || !amount}
              className="btn btn-primary w-full disabled:opacity-50">
              {busy ? "Зберігаю…" : "Записати оплату"}
            </button>
          </form>
        )}
      </div>
    </Modal>
  );
}

// ── Reserve modal ─────────────────────────────────────────────────────────────

function ReserveModal({ open, onClose, order, onReserved }: {
  open: boolean; onClose: () => void;
  order: Order | null; onReserved: (o: Order) => void;
}) {
  const [warehouses,   setWarehouses]   = useState<Warehouse[]>([]);
  const [warehouseId,  setWarehouseId]  = useState("");
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!open) return;
    setError(null); setWarehouseId("");
    api<Warehouse[]>("/api/warehouse/warehouses").then(setWarehouses).catch(() => {});
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current || !order || !warehouseId) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const updated = await api<Order>(`/api/warehouse/orders/${order.id}/reserve`, {
        method: "POST",
        body: JSON.stringify({ warehouse_id: parseInt(warehouseId) }),
      });
      onReserved(updated);
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Помилка резервування";
      setError(msg);
    } finally { inFlight.current = false; setBusy(false); }
  }

  const inputCls = "input";

  return (
    <Modal open={open} onClose={onClose} title={`Резервувати — ${order?.order_number ?? ""}`}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}
            className="btn btn-ghost">
            Скасувати
          </button>
          <button type="submit" form="reserve-form" disabled={busy || !warehouseId}
            className="rounded-md bg-violet-600 px-3 py-1.5 text-sm text-white hover:bg-violet-500 disabled:opacity-50">
            {busy ? "Резервую…" : "Зарезервувати"}
          </button>
        </>
      }
    >
      <form id="reserve-form" onSubmit={submit} className="space-y-3 text-sm">
        <p className="text-[var(--text-muted)] ">
          Оберіть склад, з якого зарезервувати товари для цього замовлення.
        </p>
        <label className="block">
          <span className="mb-1 block text-[var(--text-muted)] ">Склад</span>
          <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className={inputCls}>
            <option value="">— оберіть склад —</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
        {error && <p className="whitespace-pre-line text-sm text-[var(--state-error)]">{error}</p>}
      </form>
    </Modal>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

const COLS: ColDef[] = [
  { key: "number",   label: "Номер",   required: true },
  { key: "client",   label: "Клієнт" },
  { key: "source",   label: "Джерело" },
  { key: "items",    label: "Позиції" },
  { key: "status",   label: "Статус" },
  { key: "due_date", label: "До дати" },
  { key: "amount",   label: "Сума" },
  { key: "debt",     label: "Борг" },
];

const STATUS_FILTERS: Array<"Всі" | OrderStatus> = ["Всі", "new", "confirmed", "in_production", "ready", "shipped"];
const STATUS_FILTER_LABELS: Record<string, string> = {
  "Всі": "Всі", new: "Нові", confirmed: "Резерв",
  in_production: "Виробництво", ready: "Готові", shipped: "Відправлені",
};

export default function OrdersPage() {
  const [orders,      setOrders]      = useState<Order[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [filter,      setFilter]      = useState<"Всі" | OrderStatus>("Всі");
  const [createOpen,    setCreateOpen]    = useState(false);
  const [editOrder,     setEditOrder]     = useState<Order | null>(null);
  const [reserveOrder,  setReserveOrder]  = useState<Order | null>(null);
  const [paymentOrder,  setPaymentOrder]  = useState<Order | null>(null);
  const [actionBusy,    setActionBusy]    = useState<number | null>(null);

  const colVis = useColumnVisibility("orders", COLS);
  const [colSettingsOpen, setColSettingsOpen] = useState(false);

  const load = useCallback(async () => {
    try { setOrders(await api<Order[]>("/api/warehouse/orders")); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  function updateOrder(updated: Order) {
    setOrders((prev) => prev.map((o) => o.id === updated.id ? updated : o));
  }

  async function shipOrder(order: Order) {
    if (actionBusy) return;
    setActionBusy(order.id);
    try {
      const updated = await api<Order>(`/api/warehouse/orders/${order.id}/ship`, { method: "POST" });
      updateOrder(updated);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Помилка відвантаження");
    } finally { setActionBusy(null); }
  }

  async function cancelOrder(order: Order) {
    if (actionBusy || !confirm(`Скасувати замовлення ${order.order_number}?`)) return;
    setActionBusy(order.id);
    try {
      const updated = await api<Order>(`/api/warehouse/orders/${order.id}/cancel`, { method: "POST" });
      updateOrder(updated);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Помилка");
    } finally { setActionBusy(null); }
  }

  const filtered = filter === "Всі" ? orders : orders.filter((o) => o.status === filter);

  if (loading) return <div className="text-sm text-[var(--text-muted)]">Завантаження…</div>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {STATUS_FILTERS.map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={[
                "rounded-md px-2.5 py-1.5 text-xs transition-colors",
                filter === f
                  ? "bg-[var(--accent)] text-white  "
                  : "border border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-strong)]  ",
              ].join(" ")}>
              {STATUS_FILTER_LABELS[f]}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <TableSettingsButton onClick={() => setColSettingsOpen(true)} />
          <button onClick={() => setCreateOpen(true)}
            className="btn btn-primary btn-sm">
            + Замовлення
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--bg)] text-left text-xs uppercase tracking-wider text-[var(--text-muted)]">
            <tr>
              {colVis.isVisible("number")   && <th className="px-4 py-3 font-medium">Номер</th>}
              {colVis.isVisible("client")   && <th className="px-4 py-3 font-medium">Клієнт</th>}
              {colVis.isVisible("source")   && <th className="px-4 py-3 font-medium">Джерело</th>}
              {colVis.isVisible("items")    && <th className="px-4 py-3 font-medium">Позиції</th>}
              {colVis.isVisible("status")   && <th className="px-4 py-3 font-medium">Статус</th>}
              {colVis.isVisible("due_date") && <th className="px-4 py-3 font-medium">До дати</th>}
              {colVis.isVisible("amount")   && <th className="px-4 py-3 font-medium text-right">Сума</th>}
              {colVis.isVisible("debt")     && <th className="px-4 py-3 font-medium text-right">Борг</th>}
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {filtered.length === 0 ? (
              <tr><td colSpan={1 + COLS.filter((c) => colVis.isVisible(c.key)).length} className="px-4 py-10 text-center text-[var(--text-faint)]">Немає замовлень</td></tr>
            ) : filtered.map((o) => {
              const meta = STATUS_META[o.status];
              const isBusy = actionBusy === o.id;
              const outstanding = parseFloat(o.outstanding);
              return (
                <tr key={o.id} className="hover:bg-[var(--surface-hi)]">
                  {colVis.isVisible("number") && (
                    <td className="px-4 py-3 font-mono text-xs font-medium">{o.order_number}</td>
                  )}
                  {colVis.isVisible("client") && (
                    <td className="px-4 py-3">
                      {o.counterparty_name ?? o.customer_name ?? <span className="text-[var(--text-faint)]">—</span>}
                    </td>
                  )}
                  {colVis.isVisible("source") && (
                    <td className="px-4 py-3">
                      <span className="rounded-full bg-[var(--surface-hi)] px-2 py-0.5 text-xs">
                        {SOURCE_LABELS[o.source] ?? o.source}
                      </span>
                    </td>
                  )}
                  {colVis.isVisible("items") && (
                    <td className="px-4 py-3 text-[var(--text-muted)]">
                      {o.items.map((it) => `${it.product_name} ×${it.quantity}`).join(", ") || "—"}
                    </td>
                  )}
                  {colVis.isVisible("status") && (
                    <td className="px-4 py-3">
                      <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${meta.cls}`}>{meta.label}</span>
                    </td>
                  )}
                  {colVis.isVisible("due_date") && (
                    <td className="px-4 py-3 text-[var(--text-muted)]">
                      {o.due_date ? new Date(o.due_date).toLocaleDateString("uk-UA") : "—"}
                    </td>
                  )}
                  {colVis.isVisible("amount") && (
                    <td className="px-4 py-3 text-right font-medium tabular-nums">
                      {o.total_amount ? `${parseFloat(o.total_amount).toLocaleString("uk-UA")} ₴` : "—"}
                    </td>
                  )}
                  {colVis.isVisible("debt") && (
                    <td className="px-4 py-3 text-right">
                      <div className="flex flex-col items-end gap-0.5">
                        {(() => { const b = PAYMENT_BADGE[o.payment_status]; return b ? (
                          <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${b.cls}`}>{b.label}</span>
                        ) : null; })()}
                        {outstanding > 0 && (
                          <span className="tabular-nums text-xs text-[var(--state-error)]">{outstanding.toLocaleString("uk-UA")} ₴</span>
                        )}
                      </div>
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      {o.status === "new" && (
                        <button
                          onClick={() => setReserveOrder(o)}
                          disabled={isBusy}
                          title="Зарезервувати"
                          className="rounded-md bg-violet-600/10 px-2 py-1 text-xs font-medium text-violet-600 hover:bg-violet-600/20 disabled:opacity-50 dark:text-violet-400">
                          Резерв
                        </button>
                      )}
                      {(o.status === "confirmed" || o.status === "ready") && (
                        <button
                          onClick={() => shipOrder(o)}
                          disabled={isBusy}
                          title="Відвантажити"
                          className="rounded-md bg-[var(--state-ok)]/10 px-2 py-1 text-xs font-medium text-[var(--state-ok)] hover:bg-[var(--state-ok)]/20 disabled:opacity-50 dark:text-[var(--state-ok)]">
                          {isBusy ? "…" : "Відвантажити"}
                        </button>
                      )}
                      {o.status !== "cancelled" && (
                        <button
                          onClick={() => setPaymentOrder(o)}
                          title="Оплати"
                          className="rounded p-1 text-xs text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)]">
                          💳
                        </button>
                      )}
                      {o.status !== "shipped" && o.status !== "cancelled" && (
                        <button
                          onClick={() => setEditOrder(o)}
                          title="Редагувати"
                          className="rounded p-1 text-xs text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)] ">
                          ✎
                        </button>
                      )}
                      {(o.status === "new" || o.status === "confirmed" || o.status === "in_production") && (
                        <button
                          onClick={() => cancelOrder(o)}
                          disabled={isBusy}
                          title="Скасувати"
                          className="rounded p-1 text-xs text-[var(--text-faint)] hover:bg-[rgba(239,68,68,.08)] hover:text-[var(--state-error)]  dark:hover:text-[var(--state-error)]">
                          ✕
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <CreateOrderModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(o) => setOrders((prev) => [o, ...prev])}
      />

      <EditOrderModal
        open={editOrder !== null}
        onClose={() => setEditOrder(null)}
        order={editOrder}
        onSaved={(updated) => { updateOrder(updated); setEditOrder(null); }}
      />

      <ReserveModal
        open={reserveOrder !== null}
        onClose={() => setReserveOrder(null)}
        order={reserveOrder}
        onReserved={(updated) => { updateOrder(updated); setReserveOrder(null); }}
      />

      <PaymentModal
        open={paymentOrder !== null}
        onClose={() => setPaymentOrder(null)}
        order={paymentOrder}
        onUpdated={(updated) => { updateOrder(updated); setPaymentOrder(updated); }}
      />

      <ColumnSettingsModal
        open={colSettingsOpen}
        onClose={() => setColSettingsOpen(false)}
        cols={colVis.cols}
        hidden={colVis.hidden}
        setVisibility={colVis.setVisibility}
        orderedCols={colVis.orderedCols}
        setOrder={colVis.setOrder}
      />
    </div>
  );
}
