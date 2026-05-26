"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Modal } from "@/components/Modal";

// ── Types ─────────────────────────────────────────────────────────────────────

type OrderStatus = "new" | "confirmed" | "in_production" | "ready" | "shipped" | "cancelled";

const STATUS_META: Record<OrderStatus, { label: string; cls: string }> = {
  new:           { label: "Нове",        cls: "bg-blue-500/15 text-blue-600 dark:text-blue-400" },
  confirmed:     { label: "Зарезервовано", cls: "bg-violet-500/15 text-violet-600 dark:text-violet-400" },
  in_production: { label: "Виробництво", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  ready:         { label: "Готово",      cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  shipped:       { label: "Відправлено", cls: "bg-neutral-500/15 text-[var(--text-muted)] " },
  cancelled:     { label: "Скасовано",   cls: "bg-red-500/15 text-red-600 dark:text-red-400" },
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
  due_date: string | null; notes: string | null;
  items: OrderItem[]; created_at: string;
};

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

  const inputCls = "w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-sm outline-none focus:border-[var(--border-focus)] ";

  return (
    <Modal open={open} onClose={onClose} title="Нове замовлення"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)]  ">
            Скасувати
          </button>
          <button type="submit" form="order-form" disabled={busy || validLines.length === 0}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:bg-[var(--accent-hi)] disabled:opacity-50  ">
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
              className="text-xs text-[var(--accent)] hover:text-cyan-500 ">
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
                    className="text-[var(--text-muted)] hover:text-red-500 ">✕</button>
                )}
              </div>
            ))}
          </div>
        </div>

        <label className="block">
          <span className="mb-1 block text-[var(--text-muted)] ">Нотатка</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls} />
        </label>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
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
  const [paidAmount,     setPaidAmount]     = useState("");
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
    setPaidAmount(order.paid_amount ?? "0");
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
        due_date:    dueDate || null,
        notes:       notes.trim() || null,
        paid_amount: parseFloat(paidAmount) || 0,
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

  const inputCls = "w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-sm outline-none focus:border-[var(--border-focus)] ";

  return (
    <Modal open={open} onClose={onClose} title={`Редагувати ${order?.order_number ?? ""}`}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)]  ">
            Скасувати
          </button>
          <button type="submit" form="edit-order-form" disabled={busy}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:bg-[var(--accent-hi)] disabled:opacity-50  ">
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
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)] ">Оплачено ₴</span>
            <input type="number" min={0} step="0.01" value={paidAmount}
              onChange={(e) => setPaidAmount(e.target.value)} className={inputCls} />
          </label>
        </div>

        <label className="block">
          <span className="mb-1 block text-[var(--text-muted)] ">Нотатка</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls} />
        </label>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
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

  const inputCls = "w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-sm outline-none focus:border-[var(--border-focus)] ";

  return (
    <Modal open={open} onClose={onClose} title={`Резервувати — ${order?.order_number ?? ""}`}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)]  ">
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
        {error && <p className="whitespace-pre-line text-sm text-red-600 dark:text-red-400">{error}</p>}
      </form>
    </Modal>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

const STATUS_FILTERS: Array<"Всі" | OrderStatus> = ["Всі", "new", "confirmed", "in_production", "ready", "shipped"];
const STATUS_FILTER_LABELS: Record<string, string> = {
  "Всі": "Всі", new: "Нові", confirmed: "Резерв",
  in_production: "Виробництво", ready: "Готові", shipped: "Відправлені",
};

export default function OrdersPage() {
  const [orders,      setOrders]      = useState<Order[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [filter,      setFilter]      = useState<"Всі" | OrderStatus>("Всі");
  const [createOpen,   setCreateOpen]   = useState(false);
  const [editOrder,    setEditOrder]    = useState<Order | null>(null);
  const [reserveOrder, setReserveOrder] = useState<Order | null>(null);
  const [actionBusy,   setActionBusy]   = useState<number | null>(null);

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
        <button onClick={() => setCreateOpen(true)}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs text-white hover:bg-[var(--accent-hi)]  ">
          + Замовлення
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]  ">
        <table className="w-full text-sm">
          <thead className="bg-[var(--bg)] text-left text-xs uppercase tracking-wider text-[var(--text-muted)]  ">
            <tr>
              <th className="px-4 py-3 font-medium">Номер</th>
              <th className="px-4 py-3 font-medium">Клієнт</th>
              <th className="px-4 py-3 font-medium">Джерело</th>
              <th className="px-4 py-3 font-medium">Позиції</th>
              <th className="px-4 py-3 font-medium">Статус</th>
              <th className="px-4 py-3 font-medium">До дати</th>
              <th className="px-4 py-3 font-medium text-right">Сума</th>
              <th className="px-4 py-3 font-medium text-right">Борг</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] dark:divide-neutral-800">
            {filtered.length === 0 ? (
              <tr><td colSpan={9} className="px-4 py-10 text-center text-[var(--text-faint)]">Немає замовлень</td></tr>
            ) : filtered.map((o) => {
              const meta = STATUS_META[o.status];
              const isBusy = actionBusy === o.id;
              const outstanding = parseFloat(o.outstanding);
              return (
                <tr key={o.id} className="hover:bg-[var(--surface-hi)] ">
                  <td className="px-4 py-3 font-mono text-xs font-medium">{o.order_number}</td>
                  <td className="px-4 py-3">
                    {o.counterparty_name ?? o.customer_name ?? <span className="text-[var(--text-faint)]">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-[var(--surface-hi)] px-2 py-0.5 text-xs ">
                      {SOURCE_LABELS[o.source] ?? o.source}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[var(--text-muted)] ">
                    {o.items.map((it) => `${it.product_name} ×${it.quantity}`).join(", ") || "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${meta.cls}`}>{meta.label}</span>
                  </td>
                  <td className="px-4 py-3 text-[var(--text-muted)]">
                    {o.due_date ? new Date(o.due_date).toLocaleDateString("uk-UA") : "—"}
                  </td>
                  <td className="px-4 py-3 text-right font-medium tabular-nums">
                    {o.total_amount ? `${parseFloat(o.total_amount).toLocaleString("uk-UA")} ₴` : "—"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {outstanding > 0
                      ? <span className="text-red-600 dark:text-red-400">{outstanding.toLocaleString("uk-UA")} ₴</span>
                      : <span className="text-[var(--text-faint)]">—</span>}
                  </td>
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
                          className="rounded-md bg-emerald-600/10 px-2 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-600/20 disabled:opacity-50 dark:text-emerald-400">
                          {isBusy ? "…" : "Відвантажити"}
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
                          className="rounded p-1 text-xs text-[var(--text-faint)] hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30 dark:hover:text-red-400">
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
    </div>
  );
}
