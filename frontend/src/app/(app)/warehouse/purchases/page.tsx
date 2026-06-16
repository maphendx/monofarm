"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

type PurchaseOrderItem = {
  id:           number;
  product_id:   number;
  product_name: string;
  quantity:     string;
  unit_cost:    string;
  total_cost:   string;
};

type PurchaseOrder = {
  id:                number;
  counterparty_id:   number | null;
  counterparty_name: string | null;
  warehouse_id:      number | null;
  warehouse_name:    string | null;
  status:            string;
  notes:             string | null;
  total_cost:        string;
  items:             PurchaseOrderItem[];
  received_at:       string | null;
  created_at:        string;
};

type Counterparty = { id: number; name: string; type: string };
type Warehouse    = { id: number; name: string };
type Product      = { id: number; name: string; sku: string | null };

type DraftItem = { product_id: number; quantity: string; unit_cost: string };

const STATUS_META: Record<string, { label: string; cls: string }> = {
  draft:     { label: "Чорновик",  cls: "badge badge-neutral" },
  received:  { label: "Отримано",  cls: "badge badge-ok"      },
  cancelled: { label: "Скасовано", cls: "badge badge-error"   },
};

function fmtDate(s: string) {
  return new Date(s).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" });
}

// ── Create Modal ──────────────────────────────────────────────────────────────

function CreateModal({
  counterparties,
  warehouses,
  products,
  onClose,
  onCreated,
}: {
  counterparties: Counterparty[];
  warehouses:     Warehouse[];
  products:       Product[];
  onClose:        () => void;
  onCreated:      (po: PurchaseOrder) => void;
}) {
  const [cpId,   setCpId]   = useState<number | "">("");
  const [whId,   setWhId]   = useState<number | "">("");
  const [notes,  setNotes]  = useState("");
  const [items,  setItems]  = useState<DraftItem[]>([{ product_id: 0, quantity: "1", unit_cost: "0" }]);
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState("");

  const suppliers = counterparties.filter(c => c.type === "supplier");

  function setItem(i: number, patch: Partial<DraftItem>) {
    setItems(prev => prev.map((it, idx) => idx === i ? { ...it, ...patch } : it));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const valid = items.filter(it => it.product_id > 0 && parseFloat(it.quantity) > 0);
    if (!valid.length) { setError("Додайте хоча б одну позицію"); return; }
    setSaving(true);
    setError("");
    try {
      const po = await api<PurchaseOrder>("/api/warehouse/purchases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          counterparty_id: cpId || null,
          warehouse_id:    whId || null,
          notes:           notes || null,
          items: valid.map(it => ({
            product_id: it.product_id,
            quantity:   parseFloat(it.quantity),
            unit_cost:  parseFloat(it.unit_cost),
          })),
        }),
      });
      onCreated(po);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Помилка");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-2xl rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Нова закупівля</h2>
          <button type="button" onClick={onClose} className="text-[var(--text-faint)] hover:text-[var(--text)]">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-[var(--text-muted)]">Постачальник</label>
              <select className="input w-full" value={cpId} onChange={e => setCpId(e.target.value ? Number(e.target.value) : "")}>
                <option value="">— не вибрано —</option>
                {suppliers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-[var(--text-muted)]">Склад призначення</label>
              <select className="input w-full" value={whId} onChange={e => setWhId(e.target.value ? Number(e.target.value) : "")}>
                <option value="">— не вибрано —</option>
                {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs text-[var(--text-muted)]">Примітка</label>
            <input className="input w-full" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Необов'язково" />
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium">Позиції</span>
              <button type="button" onClick={() => setItems(prev => [...prev, { product_id: 0, quantity: "1", unit_cost: "0" }])} className="btn text-xs">
                + Додати рядок
              </button>
            </div>
            <div className="space-y-2">
              {items.map((it, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select
                    className="input min-w-[8rem] flex-1"
                    value={it.product_id || ""}
                    onChange={e => setItem(i, { product_id: Number(e.target.value) })}
                  >
                    <option value="">— товар —</option>
                    {products.map(p => <option key={p.id} value={p.id}>{p.name}{p.sku ? ` (${p.sku})` : ""}</option>)}
                  </select>
                  <input
                    className="input w-20 text-right"
                    type="number" min="0.001" step="1" placeholder="Кільк."
                    value={it.quantity}
                    onChange={e => setItem(i, { quantity: e.target.value })}
                  />
                  <input
                    className="input w-24 text-right"
                    type="number" min="0" step="0.01" placeholder="Ціна"
                    value={it.unit_cost}
                    onChange={e => setItem(i, { unit_cost: e.target.value })}
                  />
                  {items.length > 1 && (
                    <button type="button" onClick={() => setItems(prev => prev.filter((_, idx) => idx !== i))} className="text-[var(--state-error)] hover:opacity-75">✕</button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {error && <p className="text-sm text-[var(--state-error)]">{error}</p>}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="btn">Скасувати</button>
            <button type="submit" disabled={saving} className="btn btn-primary">
              {saving ? "Збереження…" : "Створити"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PurchasesPage() {
  const [orders,         setOrders]         = useState<PurchaseOrder[]>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [warehouses,     setWarehouses]     = useState<Warehouse[]>([]);
  const [products,       setProducts]       = useState<Product[]>([]);
  const [loading,        setLoading]        = useState(true);
  const [showCreate,     setShowCreate]     = useState(false);
  const [expanded,       setExpanded]       = useState<number | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    try {
      const [pos, cps, whs, prods] = await Promise.all([
        api<PurchaseOrder[]>("/api/warehouse/purchases"),
        api<Counterparty[]>("/api/warehouse/counterparties"),
        api<Warehouse[]>("/api/warehouse/warehouses"),
        api<Product[]>("/api/warehouse/products"),
      ]);
      setOrders(pos);
      setCounterparties(cps);
      setWarehouses(whs);
      setProducts(prods);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleReceive(id: number) {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const updated = await api<PurchaseOrder>(`/api/warehouse/purchases/${id}/receive`, { method: "POST" });
      setOrders(prev => prev.map(o => o.id === id ? updated : o));
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Помилка");
    } finally {
      inFlight.current = false;
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("Видалити закупівлю?")) return;
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await api(`/api/warehouse/purchases/${id}`, { method: "DELETE" });
      setOrders(prev => prev.filter(o => o.id !== id));
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Помилка");
    } finally {
      inFlight.current = false;
    }
  }

  if (loading) {
    return <div className="text-sm text-[var(--text-faint)]">Завантаження…</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Закупівлі</h1>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ Нова закупівля</button>
      </div>

      {orders.length === 0 ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-8 text-center text-sm text-[var(--text-faint)]">
          Немає закупівель. Натисніть «+ Нова закупівля», щоб створити першу.
        </div>
      ) : (
        <div className="space-y-2">
          {orders.map(po => {
            const meta = STATUS_META[po.status] ?? { label: po.status, cls: "badge badge-neutral" };
            const isOpen = expanded === po.id;
            return (
              <div key={po.id} className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]">
                <div
                  className="flex cursor-pointer items-center gap-3 px-4 py-3"
                  onClick={() => setExpanded(isOpen ? null : po.id)}
                >
                  <span className={meta.cls}>{meta.label}</span>
                  <span className="flex-1 text-sm font-medium">
                    #{po.id}{po.counterparty_name ? ` · ${po.counterparty_name}` : ""}
                  </span>
                  {po.warehouse_name && (
                    <span className="text-xs text-[var(--text-muted)]">{po.warehouse_name}</span>
                  )}
                  <span className="font-mono text-sm tabular-nums">
                    {parseFloat(po.total_cost).toFixed(2)} грн
                  </span>
                  <span className="text-xs text-[var(--text-faint)]">{fmtDate(po.created_at)}</span>
                  <span className="text-xs text-[var(--text-faint)]">{isOpen ? "▲" : "▼"}</span>
                </div>

                {isOpen && (
                  <div className="border-t border-[var(--border)] px-4 pb-4 pt-3">
                    {po.notes && (
                      <p className="mb-3 text-sm text-[var(--text-muted)]">{po.notes}</p>
                    )}

                    <table className="ds-table w-full text-sm">
                      <thead>
                        <tr>
                          <th>Товар</th>
                          <th className="text-right">Кількість</th>
                          <th className="text-right">Ціна</th>
                          <th className="text-right">Сума</th>
                        </tr>
                      </thead>
                      <tbody>
                        {po.items.map(it => (
                          <tr key={it.id}>
                            <td>{it.product_name}</td>
                            <td className="text-right tabular-nums">{parseFloat(it.quantity).toFixed(0)}</td>
                            <td className="text-right tabular-nums">{parseFloat(it.unit_cost).toFixed(2)}</td>
                            <td className="text-right tabular-nums font-medium">{parseFloat(it.total_cost).toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    <div className="mt-3 flex items-center justify-end gap-2">
                      {po.status === "draft" && (
                        <>
                          <button className="btn btn-primary text-sm" onClick={() => handleReceive(po.id)}>
                            Прийняти на склад
                          </button>
                          <button className="btn text-sm text-[var(--state-error)]" onClick={() => handleDelete(po.id)}>
                            Видалити
                          </button>
                        </>
                      )}
                      {po.received_at && (
                        <span className="text-xs text-[var(--text-faint)]">Отримано: {fmtDate(po.received_at)}</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showCreate && (
        <CreateModal
          counterparties={counterparties}
          warehouses={warehouses}
          products={products}
          onClose={() => setShowCreate(false)}
          onCreated={po => {
            setOrders(prev => [po, ...prev]);
            setShowCreate(false);
          }}
        />
      )}
    </div>
  );
}
