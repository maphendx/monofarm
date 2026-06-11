"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useWarehouseStream } from "@/hooks/useWarehouseStream";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useConfirm } from "@/hooks/useConfirm";
import { Modal } from "@/components/ui/Modal";
import { FilterDropdown } from "@/components/warehouse/FilterDropdown";
import { PageSkeleton } from "@/components/ui/ContentSkeleton";
import { CreateBatchModal, type Batch } from "@/components/warehouse/CreateBatchModal";
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
  manual: "Ручне", etsy: "Etsy", shopify: "Shopify", keycrm: "KeyCRM", horoshop: "Хорошоп", api: "API",
};

type OrderItem = {
  id: number; product_id: number; product_name: string; quantity: number;
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

type ProductCell = { cell_id: number; zone_name: string; code: string; quantity: string };
type ProductLocations = {
  product_id: number;
  warehouses: { warehouse_id: number; warehouse_name: string; cells: ProductCell[]; unassigned: string; total: string }[];
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

function money(value: string | null | undefined) {
  if (!value) return "—";
  return `${parseFloat(value).toLocaleString("uk-UA")} ₴`;
}

function totalQty(items: OrderItem[]) {
  return items.reduce((sum, item) => sum + item.quantity, 0);
}

function OrderItemsCell({
  order,
  expanded,
  onToggle,
}: {
  order: Order;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (order.items.length === 0) {
    return <span className="text-[var(--text-faint)]">—</span>;
  }

  const preview = order.items.slice(0, 3);
  const hidden = order.items.length - preview.length;

  return (
    <div className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded-md bg-[var(--surface-hi)] px-2 py-0.5 text-xs font-medium text-[var(--text-muted)]">
          {order.items.length} позицій
        </span>
        <span className="rounded-md bg-[var(--surface-hi)] px-2 py-0.5 text-xs text-[var(--text-faint)]">
          {totalQty(order.items)} шт
        </span>
        <button
          type="button"
          onClick={onToggle}
          className="rounded-md px-2 py-0.5 text-xs font-medium text-[var(--accent)] hover:bg-[var(--accent-soft)]"
        >
          {expanded ? "Сховати" : "Деталі"}
        </button>
      </div>
      <div className="flex min-w-0 flex-wrap gap-1.5">
        {preview.map((it) => (
          <span
            key={it.id}
            title={`${it.product_name} ×${it.quantity}`}
            className="max-w-[240px] truncate rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text-muted)]"
          >
            {it.product_name} ×{it.quantity}
          </span>
        ))}
        {hidden > 0 && (
          <span className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text-faint)]">
            +{hidden}
          </span>
        )}
      </div>
    </div>
  );
}

function OrderItemsDetails({ items }: { items: OrderItem[] }) {
  return (
    <div className="max-h-72 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--bg)]">
      <div className="grid grid-cols-[minmax(0,1fr)_64px_96px_104px] gap-3 border-b border-[var(--border)] px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">
        <span>Товар</span>
        <span className="text-right">К-сть</span>
        <span className="text-right">Ціна</span>
        <span className="text-right">Разом</span>
      </div>
      {items.map((it) => (
        <div
          key={it.id}
          className="grid grid-cols-[minmax(0,1fr)_64px_96px_104px] gap-3 border-b border-[var(--border)] px-4 py-2 text-xs last:border-0"
        >
          <span className="min-w-0 truncate text-[var(--text)]" title={it.product_name}>{it.product_name}</span>
          <span className="text-right font-mono text-[var(--text-muted)]">{it.quantity}</span>
          <span className="text-right tabular-nums text-[var(--text-muted)]">{money(it.unit_price)}</span>
          <span className="text-right tabular-nums font-medium">{money(it.total_price)}</span>
        </div>
      ))}
    </div>
  );
}

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
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)] ">Джерело</span>
            <select value={source} onChange={(e) => setSource(e.target.value)} className={inputCls}>
              {Object.entries(SOURCE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
        </div>

        {!counterpartyId && (
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)] ">Клієнт (вільний текст)</span>
            <input value={customerName} onChange={(e) => setCustomerName(e.target.value)}
              placeholder="Ім'я або компанія" className={inputCls} />
          </label>
        )}

        <label className="block">
          <span className="mb-1 block text-[var(--text-muted)] ">Дедлайн</span>
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={inputCls} />
        </label>

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
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)] ">Статус</span>
            <select value={status} onChange={(e) => setStatus(e.target.value as OrderStatus)} className={inputCls}>
              {EDITABLE_STATUSES.map((s) => (
                <option key={s} value={s}>{STATUS_META[s].label}</option>
              ))}
            </select>
          </label>
        </div>

        {!counterpartyId && (
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)] ">Клієнт (текст)</span>
            <input value={customerName} onChange={(e) => setCustomerName(e.target.value)}
              placeholder="Ім'я або компанія" className={inputCls} />
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
  const { confirm, dialog } = useConfirm();
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
    if (!order || !await confirm({ message: `Скасувати оплату ${parseFloat(pAmount).toLocaleString("uk-UA")} ₴?`, variant: "danger" })) return;
    try {
      await api(`/api/warehouse/orders/${order.id}/payments/${pid}`, { method: "DELETE" });
      setPayments(prev => prev.filter(p => p.id !== pid));
      const updated = await api<Order>(`/api/warehouse/orders/${order.id}`);
      onUpdated(updated);
    } catch { toast.error("Помилка видалення"); }
  }

  const outstanding = order ? parseFloat(order.outstanding) : 0;

  return (
    <>
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
    {dialog}
    </>
  );
}

// ── Return modal ──────────────────────────────────────────────────────────────

function ReturnModal({ open, onClose, order, onReturned }: {
  open: boolean; onClose: () => void;
  order: Order | null; onReturned: () => void;
}) {
  const [qtys,  setQtys]  = useState<Record<number, string>>({});
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!open || !order) return;
    setError(null);
    const init: Record<number, string> = {};
    order.items.forEach((it) => { init[it.id] = String(it.quantity); });
    setQtys(init);
  }, [open, order]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current || !order) return;
    const lines = order.items.filter((it) => parseInt(qtys[it.id] ?? "0") > 0);
    if (lines.length === 0) return;
    const overLimit = lines.find((it) => parseInt(qtys[it.id] ?? "0") > it.quantity);
    if (overLimit) {
      setError(`Кількість повернення «${overLimit.product_name}» перевищує відвантажену (${overLimit.quantity})`);
      return;
    }
    inFlight.current = true;
    setBusy(true); setError(null);
    try {
      await Promise.all(lines.map((it) =>
        api("/api/warehouse/movements", {
          method: "POST",
          body: JSON.stringify({
            type: "RETURN_IN",
            product_id: it.product_id,
            quantity: parseInt(qtys[it.id] ?? "0"),
            warehouse_to_id: it.warehouse_id,
            order_id: order.id,
            reason: `Повернення по замовленню ${order.order_number}`,
          }),
        })
      ));
      onReturned();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Помилка повернення");
    } finally { inFlight.current = false; setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Повернення — ${order?.order_number ?? ""}`}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="btn btn-ghost">Скасувати</button>
          <button type="submit" form="return-form" disabled={busy}
            className="rounded-md bg-[var(--state-warn)]/90 px-3 py-1.5 text-sm text-white hover:bg-[var(--state-warn)] disabled:opacity-50">
            {busy ? "Записую…" : "Записати повернення"}
          </button>
        </>
      }
    >
      <form id="return-form" onSubmit={submit} className="space-y-3 text-sm">
        <p className="text-[var(--text-muted)]">
          Вкажіть кількість одиниць що повертаються по кожній позиції.
        </p>
        <div className="rounded-lg border border-[rgba(245,158,11,.3)] bg-[rgba(245,158,11,.06)] px-3 py-2.5 text-xs text-[var(--state-warn)]">
          Оформлює лише складський рух (RETURN_IN). Повернення коштів або коригування боргу контрагента — окремо через розділ «Фінанси» або «Контрагенти».
        </div>
        <div className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
          {order?.items.map((it) => (
            <div key={it.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <span className="flex-1 text-[var(--text)]">{it.product_name}</span>
              <span className="text-xs text-[var(--text-faint)]">×{it.quantity}</span>
              <input
                type="number" min="0" max={it.quantity} step="1"
                value={qtys[it.id] ?? "0"}
                onChange={(e) => setQtys((prev) => ({ ...prev, [it.id]: e.target.value }))}
                className="w-20 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-right font-mono text-sm outline-none focus:border-[var(--accent)]"
              />
            </div>
          ))}
        </div>
        {error && <p className="text-sm text-[var(--state-error)]">{error}</p>}
      </form>
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

// ── ShipModal — confirm which bins the goods are pulled from ───────────────────

function ShipModal({ order, onClose, onShipped }: {
  order: Order;
  onClose: () => void;
  onShipped: (o: Order) => void;
}) {
  const [cellsByItem, setCellsByItem] = useState<Record<number, ProductCell[]>>({});
  const [picks,       setPicks]       = useState<Record<number, Record<number, string>>>({});
  const [loading,     setLoading]     = useState(true);
  const [busy,        setBusy]        = useState(false);
  const [err,         setErr]         = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all(order.items.map(async (it) => {
      if (!it.warehouse_id) return [it.id, [] as ProductCell[]] as const;
      const loc = await api<ProductLocations>(`/api/warehouse/products/${it.product_id}/locations`);
      const wh = loc.warehouses.find((w) => w.warehouse_id === it.warehouse_id);
      return [it.id, wh?.cells ?? []] as const;
    })).then((pairs) => {
      if (cancelled) return;
      const cmap: Record<number, ProductCell[]> = {};
      const pmap: Record<number, Record<number, string>> = {};
      for (const [itemId, cells] of pairs) {
        cmap[itemId] = cells;
        const item = order.items.find((i) => i.id === itemId)!;
        let remaining = item.quantity;           // FIFO prefill up to the ordered qty
        pmap[itemId] = {};
        for (const c of cells) {
          if (remaining <= 0) break;
          const take = Math.min(parseFloat(c.quantity), remaining);
          pmap[itemId][c.cell_id] = String(take);
          remaining -= take;
        }
      }
      setCellsByItem(cmap); setPicks(pmap); setLoading(false);
    }).catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [order]);

  const hasCells = Object.values(cellsByItem).some((c) => c.length > 0);

  function setPick(itemId: number, cellId: number, val: string) {
    setPicks((p) => ({ ...p, [itemId]: { ...p[itemId], [cellId]: val } }));
  }
  function itemPicked(itemId: number) {
    return Object.values(picks[itemId] || {}).reduce((s, q) => s + (parseFloat(q) || 0), 0);
  }

  const invalid = order.items.some((it) => {
    if (itemPicked(it.id) > it.quantity) return true;
    return (cellsByItem[it.id] || []).some((c) => (parseFloat(picks[it.id]?.[c.cell_id] || "0") || 0) > parseFloat(c.quantity));
  });

  async function submit() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setErr(null);
    try {
      const pickList: { product_id: number; cell_id: number; quantity: number }[] = [];
      for (const it of order.items) {
        for (const [cid, q] of Object.entries(picks[it.id] || {})) {
          const qty = parseFloat(q) || 0;
          if (qty > 0) pickList.push({ product_id: it.product_id, cell_id: parseInt(cid), quantity: qty });
        }
      }
      const updated = await api<Order>(`/api/warehouse/orders/${order.id}/ship`, {
        method: "POST", body: JSON.stringify({ picks: pickList }),
      });
      onShipped(updated); onClose();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Помилка відвантаження");
    } finally { inFlight.current = false; setBusy(false); }
  }

  return (
    <Modal
      open onClose={onClose} title={`Відвантажити — ${order.order_number}`}
      footer={
        <>
          <button onClick={onClose} disabled={busy} className="btn btn-ghost">Скасувати</button>
          <button onClick={submit} disabled={busy || loading || invalid} className="btn btn-primary disabled:opacity-50">
            {busy ? "Відвантажую…" : "Відвантажити"}
          </button>
        </>
      }
    >
      {loading ? (
        <p className="text-sm text-[var(--text-faint)]">Завантаження комірок…</p>
      ) : !hasCells ? (
        <p className="text-sm text-[var(--text-muted)]">
          Товари не розкладені по комірках — буде списано зі складу.
        </p>
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-xs text-[var(--text-faint)]">
            Вкажіть, з яких комірок фізично забрали товар (заповнено за FIFO). Решта спишеться зі складу.
          </p>
          {order.items.map((it) => {
            const cells = cellsByItem[it.id] || [];
            const picked = itemPicked(it.id);
            const fromFloor = Math.max(0, it.quantity - picked);
            return (
              <div key={it.id} className="rounded-lg border border-[var(--border)] p-3">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="font-medium">{it.product_name}</span>
                  <span className="font-mono text-xs text-[var(--text-faint)]">потрібно {it.quantity}</span>
                </div>
                {cells.length === 0 ? (
                  <p className="text-xs text-[var(--text-faint)]">нема в комірках — зі складу</p>
                ) : (
                  <div className="space-y-1">
                    {cells.map((c) => (
                      <div key={c.cell_id} className="flex items-center gap-2">
                        <span className="flex-1 font-mono text-xs text-[var(--text-muted)]">{c.zone_name} {c.code}</span>
                        <span className="font-mono text-[10px] text-[var(--text-faint)]">є {parseFloat(c.quantity).toFixed(0)}</span>
                        <input
                          type="number" min="0" max={parseFloat(c.quantity)} step="0.01"
                          value={picks[it.id]?.[c.cell_id] ?? "0"}
                          onChange={(e) => setPick(it.id, c.cell_id, e.target.value)}
                          className="w-16 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-right font-mono outline-none focus:border-[var(--accent)]"
                        />
                      </div>
                    ))}
                    {fromFloor > 0 && (
                      <p className="text-[10px] text-[var(--text-faint)]">+ {fromFloor.toFixed(0)} зі складу (нерозкладене)</p>
                    )}
                    {picked > it.quantity && (
                      <p className="text-[10px] text-[var(--state-error)]">забагато: {picked} &gt; {it.quantity}</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {err && <p className="text-[var(--state-error)]">{err}</p>}
        </div>
      )}
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
  const { confirm, dialog } = useConfirm();
  const [orders,      setOrders]      = useState<Order[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [filter,      setFilter]      = useState<"Всі" | OrderStatus>("Всі");
  const [createOpen,    setCreateOpen]    = useState(false);
  const [editOrder,     setEditOrder]     = useState<Order | null>(null);
  const [reserveOrder,  setReserveOrder]  = useState<Order | null>(null);
  const [shipModalOrder, setShipModalOrder] = useState<Order | null>(null);
  const [returnOrder,   setReturnOrder]   = useState<Order | null>(null);
  const [paymentOrder,  setPaymentOrder]  = useState<Order | null>(null);
  const [actionBusy,    setActionBusy]    = useState<number | null>(null);
  const [batchOrder,    setBatchOrder]    = useState<Order | null>(null);
  const [expandedItems, setExpandedItems] = useState<Set<number>>(() => new Set());

  const colVis = useColumnVisibility("orders", COLS);
  const [colSettingsOpen, setColSettingsOpen] = useState(false);

  const { version } = useWarehouseStream();

  const load = useCallback(async () => {
    try { setOrders(await api<Order[]>("/api/warehouse/orders")); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load, version]);

  function updateOrder(updated: Order) {
    setOrders((prev) => prev.map((o) => o.id === updated.id ? updated : o));
  }

  async function cancelOrder(order: Order) {
    if (actionBusy || !await confirm({ message: `Скасувати замовлення ${order.order_number}?`, variant: "danger" })) return;
    setActionBusy(order.id);
    try {
      const updated = await api<Order>(`/api/warehouse/orders/${order.id}/cancel`, { method: "POST" });
      updateOrder(updated);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Помилка");
    } finally { setActionBusy(null); }
  }

  const filtered = filter === "Всі" ? orders : orders.filter((o) => o.status === filter);
  const visibleColCount = COLS.filter((c) => colVis.isVisible(c.key)).length + 1;

  function toggleItems(orderId: number) {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  }

  if (loading) return <PageSkeleton cols={7} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FilterDropdown active={filter !== "Всі" ? 1 : 0}>
          <div className="p-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-[var(--text-faint)]">Статус</p>
            <div className="space-y-0.5">
              {STATUS_FILTERS.map((f) => (
                <label key={f} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-[var(--surface-hi)]">
                  <input
                    type="radio"
                    name="order-status-filter"
                    checked={filter === f}
                    onChange={() => setFilter(f)}
                    className="accent-[var(--accent)]"
                  />
                  <span className="text-sm">{STATUS_FILTER_LABELS[f]}</span>
                </label>
              ))}
            </div>
          </div>
          {filter !== "Всі" && (
            <div className="border-t border-[var(--border)] p-3">
              <button
                onClick={() => setFilter("Всі")}
                className="w-full rounded-md px-3 py-1.5 text-xs text-[var(--state-error)] hover:bg-[rgba(239,68,68,.08)]"
              >
                Скинути фільтри
              </button>
            </div>
          )}
        </FilterDropdown>
        <div className="flex gap-2">
          <TableSettingsButton onClick={() => setColSettingsOpen(true)} />
          <button onClick={() => setCreateOpen(true)}
            className="btn btn-primary btn-sm">
            + Замовлення
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]">
        <table className="w-full min-w-[1180px] table-fixed text-sm">
          <colgroup>
            {colVis.isVisible("number") && <col className="w-[96px]" />}
            {colVis.isVisible("client") && <col className="w-[160px]" />}
            {colVis.isVisible("source") && <col className="w-[116px]" />}
            {colVis.isVisible("items") && <col />}
            {colVis.isVisible("status") && <col className="w-[132px]" />}
            {colVis.isVisible("due_date") && <col className="w-[104px]" />}
            {colVis.isVisible("amount") && <col className="w-[120px]" />}
            {colVis.isVisible("debt") && <col className="w-[128px]" />}
            <col className="w-[320px]" />
          </colgroup>
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
              <tr><td colSpan={visibleColCount} className="px-4 py-10 text-center text-[var(--text-faint)]">Немає замовлень</td></tr>
            ) : filtered.map((o) => {
              const meta = STATUS_META[o.status];
              const isBusy = actionBusy === o.id;
              const outstanding = parseFloat(o.outstanding);
              const expanded = expandedItems.has(o.id);
              return (
                <Fragment key={o.id}>
                  <tr className="align-top hover:bg-[var(--surface-hi)]">
                    {colVis.isVisible("number") && (
                      <td className="px-4 py-3 font-mono text-xs font-semibold text-[var(--text)]">{o.order_number}</td>
                    )}
                    {colVis.isVisible("client") && (
                      <td className="px-4 py-3">
                        <div className="min-w-0 truncate font-medium" title={o.counterparty_name ?? o.customer_name ?? ""}>
                          {o.counterparty_name ?? o.customer_name ?? <span className="text-[var(--text-faint)]">—</span>}
                        </div>
                        <div className="mt-1 text-[11px] text-[var(--text-faint)]">
                          {new Date(o.created_at).toLocaleDateString("uk-UA")}
                        </div>
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
                        <OrderItemsCell order={o} expanded={expanded} onToggle={() => toggleItems(o.id)} />
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
                        {money(o.total_amount)}
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
                      <div className="flex flex-wrap items-center justify-end gap-1">
                      <button
                        onClick={() => {
                          const w = window.open("", "_blank");
                          if (!w) return;
                          w.document.write(`<html><head><title>QR ${o.order_number}</title></head><body style="text-align:center;font-family:sans-serif">
                            <div id="qr" style="display:inline-block;margin-top:40px"></div>
                            <h2 style="font-family:monospace">${o.order_number}</h2>
                            <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
                            <script>new QRCode(document.getElementById('qr'),{text:'ORDER:${o.id}',width:220,height:220});</script>
                          </body></html>`);
                          w.document.close();
                          setTimeout(() => w.print(), 600);
                        }}
                        title="Друк QR для сканера"
                        className="rounded p-1 text-xs text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)]">
                        ⊞
                      </button>
                      <button
                        onClick={() => window.open(`/print/order/${o.id}?auto=1`, "_blank", "noopener,noreferrer")}
                        title="Друк накладної"
                        className="rounded-md border border-[var(--border)] px-2 py-1 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)]">
                        Накладна
                      </button>
                      {o.status === "new" && (
                        <button
                          onClick={() => setReserveOrder(o)}
                          disabled={isBusy}
                          title="Зарезервувати"
                          className="rounded-md bg-violet-600/10 px-2 py-1 text-xs font-medium text-violet-600 hover:bg-violet-600/20 disabled:opacity-50 dark:text-violet-400">
                          Резерв
                        </button>
                      )}
                      {(o.status === "confirmed" || o.status === "in_production") && (
                        <button
                          onClick={() => setBatchOrder(o)}
                          disabled={isBusy}
                          title="Запустити у виробництво"
                          className="rounded-md bg-[var(--state-warn)]/10 px-2 py-1 text-xs font-medium text-[var(--state-warn)] hover:bg-[var(--state-warn)]/20 disabled:opacity-50">
                          → Виробництво
                        </button>
                      )}
                      {(o.status === "confirmed" || o.status === "ready" || o.status === "in_production") && (
                        <button
                          onClick={() => setShipModalOrder(o)}
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
                      {o.status === "shipped" && o.items.some((it) => it.warehouse_id) && (
                        <button
                          onClick={() => setReturnOrder(o)}
                          title="Повернення товару"
                          className="rounded-md bg-[var(--state-warn)]/10 px-2 py-1 text-xs font-medium text-[var(--state-warn)] hover:bg-[var(--state-warn)]/20">
                          ↩ Повернення
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
                  {expanded && colVis.isVisible("items") && (
                    <tr key={`${o.id}-items`} className="bg-[var(--bg)]">
                      <td colSpan={visibleColCount} className="px-4 py-3">
                        <OrderItemsDetails items={o.items} />
                      </td>
                    </tr>
                  )}
                </Fragment>
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

      {shipModalOrder && (
        <ShipModal
          order={shipModalOrder}
          onClose={() => setShipModalOrder(null)}
          onShipped={(updated) => { updateOrder(updated); setShipModalOrder(null); }}
        />
      )}

      <ReturnModal
        open={returnOrder !== null}
        onClose={() => setReturnOrder(null)}
        order={returnOrder}
        onReturned={() => { setReturnOrder(null); load(); }}
      />

      <PaymentModal
        open={paymentOrder !== null}
        onClose={() => setPaymentOrder(null)}
        order={paymentOrder}
        onUpdated={(updated) => { updateOrder(updated); setPaymentOrder(updated); }}
      />

      {batchOrder !== null && (
        <CreateBatchModal
          key={batchOrder.id}
          open
          onClose={() => setBatchOrder(null)}
          initialProductId={batchOrder.items[0]?.product_id?.toString()}
          initialOrderId={batchOrder.id}
          orderNumber={batchOrder.order_number}
          onCreated={(_b: Batch) => { setBatchOrder(null); load(); }}
        />
      )}

      <ColumnSettingsModal
        open={colSettingsOpen}
        onClose={() => setColSettingsOpen(false)}
        cols={colVis.cols}
        hidden={colVis.hidden}
        setVisibility={colVis.setVisibility}
        orderedCols={colVis.orderedCols}
        setOrder={colVis.setOrder}
      />
      {dialog}
    </div>
  );
}
