"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import Link from "next/link";
import { CreateMovementModal, MovementType } from "@/components/warehouse/MovementModal";
import { CreateBatchModal } from "@/components/warehouse/CreateBatchModal";
import {
  useColumnVisibility,
  ColumnSettingsModal,
  TableSettingsButton,
  type ColDef,
} from "@/components/warehouse/TableSettings";

// ── Types ─────────────────────────────────────────────────────────────────────

type CellLocation = { name: string; quantity: string };

type StockEntry = {
  id:                 number;
  product_id:         number;
  product_name:       string;
  product_sku:        string;
  product_barcode:    string | null;
  product_categories: string[];
  product_unit:       string;
  warehouse_id:       number;
  warehouse_name:     string;
  locations:          CellLocation[];
  quantity:           string;
  reserved_qty:       string;
  available:          string;
  total_stock:        string;
  full_cost:          string | null;
  min_stock:          number | null;
  desired_stock:      number | null;
  box_limit:          number | null;
  boxes_to_order:     number | null;
  updated_at:         string;
};

type StockStatus = "out" | "low" | "ok" | "desired";

function getStatus(e: StockEntry): StockStatus {
  const avail = parseFloat(e.available);
  if (avail <= 0) return "out";
  if (e.min_stock != null && avail < e.min_stock) return "low";
  if (e.desired_stock != null && avail >= e.desired_stock) return "desired";
  return "ok";
}

const STATUS_META: Record<StockStatus, { label: string; dot: string; row: string }> = {
  out:     { label: "Немає",    dot: "bg-[var(--state-error)]", row: "bg-[rgba(239,68,68,.04)]" },
  low:     { label: "Мало",     dot: "bg-[var(--state-warn)]",  row: "bg-[rgba(245,158,11,.04)]" },
  ok:      { label: "Норма",    dot: "bg-[var(--state-ok)]",    row: "" },
  desired: { label: "Цільовий", dot: "bg-[var(--accent)]",      row: "" },
};

// ── Column defs ───────────────────────────────────────────────────────────────

const COLS: ColDef[] = [
  { key: "name",          label: "Назва",                  required: true },
  { key: "barcode",       label: "Штрих-код" },
  { key: "history",       label: "Історія" },
  { key: "categories",    label: "Категорії" },
  { key: "warehouse",     label: "Склад" },
  { key: "location",      label: "Локація" },
  { key: "quantity",      label: "В наявності" },
  { key: "total_cost",    label: "Вартість" },
  { key: "reserved",      label: "Резерв" },
  { key: "available",     label: "Доступний залишок" },
  { key: "total_stock",   label: "Загальний залишок" },
  { key: "unit_cost",     label: "Собівартість за од." },
  { key: "min_stock",     label: "Мін ✎" },
  { key: "desired_stock", label: "Бажаний ✎" },
  { key: "box_limit",     label: "Коробка ✎" },
  { key: "order",         label: "Замовити" },
];

// ── Inline threshold editor ───────────────────────────────────────────────────

function ThresholdCell({
  value, productId, field, onSaved,
}: {
  value:     number | null;
  productId: number;
  field:     "min_stock" | "desired_stock" | "box_limit";
  onSaved:   (pid: number, field: string, val: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState(value != null ? String(value) : "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  async function commit() {
    setEditing(false);
    const parsed = draft.trim() === "" ? null : parseInt(draft);
    if (parsed === value) return;
    try {
      await api(`/api/warehouse/products/${productId}/thresholds`, {
        method: "PATCH",
        body: JSON.stringify({ [field]: parsed }),
      });
      onSaved(productId, field, parsed);
    } catch { /* revert silently */ }
  }

  if (editing) {
    return (
      <input
        ref={inputRef} type="number" min={0} value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
        className="w-16 rounded border border-[var(--accent)] bg-[var(--bg-elevated)] px-1.5 py-0.5 font-mono text-xs outline-none text-right"
      />
    );
  }

  return (
    <button onClick={() => { setDraft(value != null ? String(value) : ""); setEditing(true); }}
      className="group inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-[var(--surface-hi)]"
      title="Клік щоб змінити">
      <span className="font-mono text-xs tabular-nums">
        {value != null ? value : <span className="text-[var(--text-faint)]">—</span>}
      </span>
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
        className="opacity-0 group-hover:opacity-40 transition-opacity">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
      </svg>
    </button>
  );
}

// ── StockBar ──────────────────────────────────────────────────────────────────

function StockBar({ avail, min, desired }: { avail: number; min: number | null; desired: number | null }) {
  if (!desired) return null;
  const pct   = Math.min(100, (avail / desired) * 100);
  const color = avail <= 0          ? "var(--state-error)"
    : min != null && avail < min    ? "var(--state-warn)"
    : avail >= desired              ? "var(--accent)"
    : "var(--state-ok)";
  return (
    <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-[var(--surface-hi)]">
      <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

function fmt(n: string | number | null): string {
  if (n == null) return "—";
  const v = typeof n === "string" ? parseFloat(n) : n;
  return isNaN(v) ? "—" : v.toLocaleString("uk-UA", { maximumFractionDigits: 2 });
}

// ── Replenishment ─────────────────────────────────────────────────────────────

type ReplenishItem = {
  product_id:       number;
  product_name:     string;
  product_sku:      string;
  unit:             string;
  available:        number;
  min_stock:        number;
  desired_stock:    number | null;
  qty_needed:       number;
  kind:             "batch" | "purchase";
  specification_id: number | null;
  warehouse_id:     number | null;
  warehouse_name:   string | null;
};

function ReplenishModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [items,    setItems]    = useState<ReplenishItem[]>([]);
  const [qtys,     setQtys]     = useState<Record<number, string>>({});
  const [costs,    setCosts]    = useState<Record<number, string>>({});
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading,  setLoading]  = useState(true);
  const [busy,     setBusy]     = useState(false);
  const [result,   setResult]   = useState<{ batches: number; movements: number } | null>(null);

  useEffect(() => {
    api<ReplenishItem[]>("/api/warehouse/stock/replenish-preview")
      .then((data) => {
        setItems(data);
        const initQtys: Record<number, string> = {};
        const initSel = new Set<number>();
        data.forEach((it) => { initQtys[it.product_id] = String(it.qty_needed); initSel.add(it.product_id); });
        setQtys(initQtys);
        setSelected(initSel);
      })
      .finally(() => setLoading(false));
  }, []);

  async function confirm() {
    setBusy(true);
    try {
      const payload = items
        .filter((it) => selected.has(it.product_id))
        .map((it) => ({
          product_id:       it.product_id,
          qty:              parseInt(qtys[it.product_id] ?? "0") || 0,
          kind:             it.kind,
          warehouse_id:     it.warehouse_id,
          specification_id: it.specification_id,
          unit_cost:        it.kind === "purchase" && costs[it.product_id]
                              ? parseFloat(costs[it.product_id])
                              : null,
        }))
        .filter((it) => it.qty > 0);
      const res = await api<{ batches: number; movements: number }>("/api/warehouse/stock/replenish", { method: "POST", body: JSON.stringify({ items: payload }) });
      setResult(res);
      onDone();
    } finally {
      setBusy(false);
    }
  }

  const selectedItems = items.filter((it) => selected.has(it.product_id));
  const batchCount    = selectedItems.filter((it) => it.kind === "batch").length;
  const purchaseCount = selectedItems.filter((it) => it.kind === "purchase").length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-2xl">

        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-6 py-4">
          <div>
            <h2 className="font-semibold text-[var(--text-hi)]">Поповнення запасів</h2>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">Товари нижче мінімального залишку</p>
          </div>
          <button onClick={onClose} className="flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[var(--surface-hi)]">×</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="px-6 py-12 text-center text-sm text-[var(--text-faint)]">Завантаження…</div>
          ) : items.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-[var(--text-faint)]">Всі залишки в нормі 🎉</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-[var(--bg)] text-xs uppercase tracking-wider text-[var(--text-faint)]">
                <tr>
                  <th className="w-9 px-4 py-3">
                    <input type="checkbox"
                      checked={selected.size === items.length && items.length > 0}
                      onChange={(e) => setSelected(e.target.checked ? new Set(items.map((i) => i.product_id)) : new Set())}
                      className="rounded accent-[var(--accent)]" />
                  </th>
                  <th className="px-3 py-3 text-left font-medium">Товар</th>
                  <th className="px-3 py-3 text-right font-medium">Наявно</th>
                  <th className="px-3 py-3 text-right font-medium">Мін / Бажаний</th>
                  <th className="px-3 py-3 text-right font-medium">Замовити</th>
                  <th className="px-3 py-3 text-right font-medium">Ціна/од. ₴</th>
                  <th className="px-3 py-3 text-center font-medium">Тип</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {items.map((it) => (
                  <tr key={it.product_id} className={selected.has(it.product_id) ? "bg-[var(--accent)]/5" : "opacity-40"}>
                    <td className="px-4 py-3">
                      <input type="checkbox" checked={selected.has(it.product_id)}
                        onChange={(e) => setSelected((prev) => { const n = new Set(prev); e.target.checked ? n.add(it.product_id) : n.delete(it.product_id); return n; })}
                        className="rounded accent-[var(--accent)]" />
                    </td>
                    <td className="px-3 py-3">
                      <p className="font-medium text-[var(--text-hi)]">{it.product_name}</p>
                      <p className="text-xs text-[var(--text-faint)]">{it.product_sku}{it.warehouse_name ? ` · ${it.warehouse_name}` : ""}</p>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <span className={["font-mono tabular-nums text-xs", it.available <= 0 ? "text-[var(--state-error)]" : "text-[var(--state-warn)]"].join(" ")}>
                        {it.available.toFixed(0)} {it.unit}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs text-[var(--text-muted)]">
                      {it.min_stock}{it.desired_stock ? ` / ${it.desired_stock}` : ""}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <input
                        type="number" min="1" step="1"
                        value={qtys[it.product_id] ?? ""}
                        onChange={(e) => setQtys((prev) => ({ ...prev, [it.product_id]: e.target.value }))}
                        className="w-20 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-right font-mono text-sm outline-none focus:border-[var(--accent)]"
                      />
                    </td>
                    <td className="px-3 py-3 text-right">
                      {it.kind === "purchase" ? (
                        <input
                          type="number" min="0" step="0.01"
                          value={costs[it.product_id] ?? ""}
                          onChange={(e) => setCosts((prev) => ({ ...prev, [it.product_id]: e.target.value }))}
                          placeholder="0.00"
                          className="w-24 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-right font-mono text-sm outline-none focus:border-[var(--accent)]"
                        />
                      ) : (
                        <span className="text-[var(--text-faint)] text-xs">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-center">
                      <span className={["rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                        it.kind === "batch" ? "bg-[var(--accent)]/10 text-[var(--accent)]" : "bg-[var(--state-ok)]/10 text-[var(--state-ok)]",
                      ].join(" ")}>
                        {it.kind === "batch" ? "Партія" : "Прихід"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        {items.length > 0 && (
          <div className="flex shrink-0 items-center justify-between border-t border-[var(--border)] px-6 py-4">
            <p className="text-xs text-[var(--text-muted)]">
              {selected.size} обрано
              {batchCount > 0 && <> · {batchCount} партій</>}
              {purchaseCount > 0 && <> · {purchaseCount} приходів</>}
            </p>
            <div className="flex gap-2">
              <button onClick={onClose} className="btn btn-ghost btn-sm">Скасувати</button>
              <button onClick={confirm} disabled={busy || selected.size === 0} className="btn btn-primary btn-sm disabled:opacity-50">
                {busy ? "Створюю…" : "Створити все"}
              </button>
            </div>
          </div>
        )}

        {result && (
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-between border-t border-[var(--border)] bg-[rgba(34,197,94,.06)] px-6 py-3">
            <span className="text-sm text-[var(--state-ok)]">
              Створено: {result.batches} партій, {result.movements} приходів
            </span>
            <button onClick={onClose} className="btn btn-ghost btn-sm">Закрити</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

type FilterMode = "all" | "out" | "low" | "order";

export default function StockPage() {
  const [stock,    setStock]    = useState<StockEntry[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [whFilter, setWhFilter] = useState("Всі");
  const [mode,     setMode]     = useState<FilterMode>("all");
  const [search,   setSearch]   = useState("");

  const [movementOpen,      setMovementOpen]      = useState(false);
  const [movementType,      setMovementType]      = useState<MovementType>("PURCHASE_IN");
  const [movementProductId, setMovementProductId] = useState<string | null>(null);
  const [movementQuantity,  setMovementQuantity]  = useState<string | null>(null);
  const [batchProductId,    setBatchProductId]    = useState<string | null>(null);
  const [colSettingsOpen,   setColSettingsOpen]   = useState(false);
  const [replenishOpen,     setReplenishOpen]     = useState(false);

  const colVis = useColumnVisibility("stock", COLS);

  const load = useCallback(async () => {
    try { setStock(await api<StockEntry[]>("/api/warehouse/stock")); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  function updateThreshold(pid: number, field: string, val: number | null) {
    setStock((prev) => prev.map((e) => e.product_id === pid ? { ...e, [field]: val } : e));
  }

  function openMovement(type: MovementType) {
    setMovementType(type);
    setMovementOpen(true);
  }

  const warehouses = ["Всі", ...Array.from(new Set(stock.map((s) => s.warehouse_name)))];
  const outCount   = stock.filter((e) => getStatus(e) === "out").length;
  const lowCount   = stock.filter((e) => getStatus(e) === "low").length;
  const orderCount = stock.filter((e) => e.boxes_to_order != null).length;

  const filtered = stock.filter((e) => {
    if (whFilter !== "Всі" && e.warehouse_name !== whFilter) return false;
    const st = getStatus(e);
    if (mode === "out"   && st !== "out") return false;
    if (mode === "low"   && (st !== "low" && st !== "out")) return false;
    if (mode === "order" && e.boxes_to_order == null) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!e.product_name.toLowerCase().includes(q) &&
          !e.product_sku.toLowerCase().includes(q) &&
          !(e.product_barcode || "").toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const colSpan = 1 + COLS.filter((c) => colVis.isVisible(c.key)).length;

  if (loading) return <div className="text-sm text-[var(--text-muted)]">Завантаження…</div>;

  return (
    <div className="space-y-4">

      {/* Top Actions */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-bold">Залишки на складі</h1>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setReplenishOpen(true)} className="btn btn-ghost btn-sm flex items-center gap-1.5">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2v20M2 12h20"/><path d="M17 7 12 2l-5 5"/>
            </svg>
            Поповнити запаси
            {(outCount + lowCount) > 0 && (
              <span className="flex size-4 items-center justify-center rounded-full bg-[var(--state-warn)] text-[9px] font-bold text-white leading-none">
                {outCount + lowCount}
              </span>
            )}
          </button>
          <button onClick={() => openMovement("PURCHASE_IN")} className="btn btn-primary btn-sm">+ Отримання</button>
          <button onClick={() => openMovement("SALE_OUT")} className="btn btn-primary btn-sm">+ Продаж</button>
          <button onClick={() => openMovement("DEFECT")} className="btn btn-primary btn-sm bg-[var(--state-error)] hover:bg-red-600 border-none text-white">+ Списання</button>
          <button onClick={() => openMovement("TRANSFER")} className="btn btn-primary btn-sm bg-[var(--state-warn)] hover:bg-amber-600 border-none text-white">+ Переміщення</button>
        </div>
      </div>

      {/* Summary alert strip */}
      {(outCount > 0 || lowCount > 0 || orderCount > 0) && (
        <div className="flex flex-wrap gap-2">
          {outCount > 0 && (
            <button onClick={() => setMode(mode === "out" ? "all" : "out")}
              className={["flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors",
                mode === "out"
                  ? "border-[var(--state-error)] bg-[rgba(239,68,68,.10)] text-[var(--state-error)]"
                  : "border-[rgba(239,68,68,.3)] text-[var(--state-error)] hover:bg-[rgba(239,68,68,.06)]",
              ].join(" ")}>
              <span className="size-2 rounded-full bg-[var(--state-error)]" />
              {outCount} немає на складі
            </button>
          )}
          {lowCount > 0 && (
            <button onClick={() => setMode(mode === "low" ? "all" : "low")}
              className={["flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors",
                mode === "low"
                  ? "border-[var(--state-warn)] bg-[rgba(245,158,11,.10)] text-[var(--state-warn)]"
                  : "border-[rgba(245,158,11,.3)] text-[var(--state-warn)] hover:bg-[rgba(245,158,11,.06)]",
              ].join(" ")}>
              <span className="size-2 rounded-full bg-[var(--state-warn)]" />
              {lowCount} нижче мінімуму
            </button>
          )}
          {orderCount > 0 && (
            <button onClick={() => setMode(mode === "order" ? "all" : "order")}
              className={["flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors",
                mode === "order"
                  ? "border-[var(--accent)] bg-[rgba(34,211,238,.10)] text-[var(--accent)]"
                  : "border-[rgba(34,211,238,.3)] text-[var(--accent)] hover:bg-[rgba(34,211,238,.06)]",
              ].join(" ")}>
              <span>📦</span>
              {orderCount} потребують замовлення
            </button>
          )}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <svg className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-faint)]"
            width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <input type="search" placeholder="Назва або код…" value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-64 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] pl-8 pr-3 text-xs outline-none placeholder:text-[var(--text-faint)] focus:border-[var(--border-strong)]" />
        </div>
        <div className="flex gap-1">
          {warehouses.map((w) => (
            <button key={w} onClick={() => setWhFilter(w)}
              className={["rounded-md px-2.5 py-1.5 text-xs transition-colors",
                whFilter === w
                  ? "bg-[var(--accent)] text-white"
                  : "border border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-strong)]",
              ].join(" ")}>
              {w}
            </button>
          ))}
        </div>
        {mode !== "all" && (
          <button onClick={() => setMode("all")}
            className="rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--text-faint)] hover:bg-[var(--surface-hi)]">
            × Скинути
          </button>
        )}
        <TableSettingsButton onClick={() => setColSettingsOpen(true)} />
        <button onClick={load}
          className="ml-auto rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs hover:bg-[var(--surface-hi)]">
          ↻ Оновити
        </button>
        <span className="text-xs text-[var(--text-faint)]">{filtered.length} рядків</span>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-max text-sm">
            <thead className="bg-[var(--bg)] text-left text-xs uppercase tracking-wider text-[var(--text-faint)]">
              <tr>
                <th className="px-3 py-3 font-medium">
                  <input type="checkbox" className="rounded bg-[var(--surface-hi)] border-[var(--border)] text-[var(--accent)]" />
                </th>
                {colVis.isVisible("name")          && <th className="px-3 py-3 font-medium">Назва</th>}
                {colVis.isVisible("barcode")        && <th className="px-3 py-3 font-medium">Код</th>}
                {colVis.isVisible("history")        && <th className="px-2 py-3 font-medium" title="Історія рухів">Іст.</th>}
                {colVis.isVisible("categories")     && <th className="px-3 py-3 font-medium">Категорії</th>}
                {colVis.isVisible("warehouse")      && <th className="px-3 py-3 font-medium">Склад</th>}
                {colVis.isVisible("location")       && <th className="px-3 py-3 font-medium">Локація</th>}
                {colVis.isVisible("quantity")       && <th className="px-3 py-3 text-right font-medium">В наявності</th>}
                {colVis.isVisible("total_cost")     && <th className="px-3 py-3 text-right font-medium">Вартість</th>}
                {colVis.isVisible("reserved")       && <th className="px-3 py-3 text-right font-medium">Резерв</th>}
                {colVis.isVisible("available")      && <th className="px-3 py-3 text-right font-medium">Доступний залишок</th>}
                {colVis.isVisible("total_stock")    && <th className="px-3 py-3 text-right font-medium">Загальний залишок</th>}
                {colVis.isVisible("unit_cost")      && <th className="px-3 py-3 text-right font-medium">Собівартість за одиницю</th>}
                {colVis.isVisible("min_stock")      && <th className="px-3 py-3 text-right font-medium text-[var(--state-warn)]">Мін ✎</th>}
                {colVis.isVisible("desired_stock")  && <th className="px-3 py-3 text-right font-medium text-[var(--state-ok)]">Бажаний ✎</th>}
                {colVis.isVisible("box_limit")      && <th className="px-3 py-3 text-right font-medium text-[var(--accent)]">Коробка ✎</th>}
                {colVis.isVisible("order")          && <th className="px-3 py-3 text-right font-medium">Замовити</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {filtered.length === 0 ? (
                <tr><td colSpan={colSpan} className="px-4 py-12 text-center text-sm text-[var(--text-faint)]">
                  {search || mode !== "all" || whFilter !== "Всі" ? "Нічого не знайдено" : "Залишків немає"}
                </td></tr>
              ) : filtered.map((e) => {
                const avail     = parseFloat(e.available);
                const status    = getStatus(e);
                const meta      = STATUS_META[status];
                const totalCost = e.full_cost ? parseFloat(e.quantity) * parseFloat(e.full_cost) : null;

                return (
                  <tr key={e.id} className={["transition-colors hover:bg-[var(--surface-hi)]", meta.row].join(" ")}>
                    <td className="px-3 py-2.5">
                      <input type="checkbox" className="rounded bg-[var(--surface-hi)] border-[var(--border)] text-[var(--accent)]" />
                    </td>
                    {colVis.isVisible("name") && (
                      <td className="px-3 py-2.5">
                        <p className="font-medium leading-tight">{e.product_name}</p>
                        <p className="font-mono text-xs text-[var(--text-faint)]">{e.product_sku}</p>
                        <StockBar avail={avail} min={e.min_stock} desired={e.desired_stock} />
                      </td>
                    )}
                    {colVis.isVisible("barcode") && (
                      <td className="px-3 py-2.5">
                        {e.product_barcode ? (
                          <div className="flex items-center gap-1.5 whitespace-nowrap font-mono text-xs text-[var(--text-muted)]">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M3 5v14M8 5v14M12 5v14M17 5v14M21 5v14" />
                            </svg>
                            #{e.product_barcode}
                          </div>
                        ) : (
                          <span className="text-[var(--text-faint)] text-xs">—</span>
                        )}
                      </td>
                    )}
                    {colVis.isVisible("history") && (
                      <td className="px-2 py-2.5 text-center">
                        <Link href={`/warehouse/movements?search=${encodeURIComponent(e.product_sku)}`}
                          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)] transition-colors"
                          title="Історія рухів">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                            <path d="M3 3v5h5" /><path d="M12 7v5l4 2" />
                          </svg>
                        </Link>
                      </td>
                    )}
                    {colVis.isVisible("categories") && (
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-1 max-w-[140px]">
                          {e.product_categories && e.product_categories.length > 0 ? (
                            e.product_categories.map((cat, i) => (
                              <span key={i} className="rounded-full bg-[var(--surface-hi)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] whitespace-nowrap">
                                {cat}
                              </span>
                            ))
                          ) : (
                            <span className="text-[var(--text-faint)]">—</span>
                          )}
                        </div>
                      </td>
                    )}
                    {colVis.isVisible("warehouse") && (
                      <td className="px-3 py-2.5">
                        <span className="text-sm font-medium">{e.warehouse_name}</span>
                      </td>
                    )}
                    {colVis.isVisible("location") && (
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {e.locations && e.locations.length > 0 ? (
                            e.locations.map((loc, i) => (
                              <span key={i} className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-hi)] border border-[var(--border)] px-1.5 py-0.5 text-[10px] font-mono whitespace-nowrap">
                                <span className="text-[var(--text-muted)]">{loc.name}</span>
                                <span className="font-bold">{fmt(loc.quantity)} {e.product_unit}</span>
                              </span>
                            ))
                          ) : (
                            <span className="text-[var(--text-faint)]">—</span>
                          )}
                        </div>
                      </td>
                    )}
                    {colVis.isVisible("quantity") && (
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        <span className={["font-mono text-sm font-semibold tabular-nums",
                          status === "out" ? "text-[var(--state-error)]" : status === "low" ? "text-[var(--state-warn)]" : "text-[var(--text)]",
                        ].join(" ")}>
                          {fmt(e.quantity)}
                        </span>
                        <span className="ml-1 text-[10px] text-[var(--text-faint)]">{e.product_unit}</span>
                      </td>
                    )}
                    {colVis.isVisible("total_cost") && (
                      <td className="px-3 py-2.5 text-right whitespace-nowrap font-mono tabular-nums text-sm">
                        {totalCost != null ? fmt(totalCost) : "—"}
                      </td>
                    )}
                    {colVis.isVisible("reserved") && (
                      <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-[var(--text-faint)] whitespace-nowrap">
                        {parseFloat(e.reserved_qty) > 0 ? fmt(e.reserved_qty) : "—"}
                      </td>
                    )}
                    {colVis.isVisible("available") && (
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        <span className="font-mono text-sm font-semibold tabular-nums text-[var(--text)]">
                          {fmt(e.available)}
                        </span>
                        <span className="ml-1 text-[10px] text-[var(--text-faint)]">{e.product_unit}</span>
                      </td>
                    )}
                    {colVis.isVisible("total_stock") && (
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        <span className="font-mono text-sm font-semibold tabular-nums text-[var(--text-muted)]">
                          {fmt(e.total_stock)}
                        </span>
                        <span className="ml-1 text-[10px] text-[var(--text-faint)]">{e.product_unit}</span>
                      </td>
                    )}
                    {colVis.isVisible("unit_cost") && (
                      <td className="px-3 py-2.5 text-right whitespace-nowrap font-mono tabular-nums text-sm">
                        {e.full_cost != null ? fmt(e.full_cost) : "—"}
                      </td>
                    )}
                    {colVis.isVisible("min_stock") && (
                      <td className="px-3 py-2.5 text-right">
                        <ThresholdCell value={e.min_stock} productId={e.product_id} field="min_stock" onSaved={updateThreshold} />
                      </td>
                    )}
                    {colVis.isVisible("desired_stock") && (
                      <td className="px-3 py-2.5 text-right">
                        <ThresholdCell value={e.desired_stock} productId={e.product_id} field="desired_stock" onSaved={updateThreshold} />
                      </td>
                    )}
                    {colVis.isVisible("box_limit") && (
                      <td className="px-3 py-2.5 text-right">
                        <ThresholdCell value={e.box_limit} productId={e.product_id} field="box_limit" onSaved={updateThreshold} />
                      </td>
                    )}
                    {colVis.isVisible("order") && (
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-3">
                          {e.boxes_to_order != null ? (
                            <button
                              onClick={() => {
                                setMovementProductId(e.product_id.toString());
                                setMovementQuantity((e.boxes_to_order! * (e.box_limit || 1)).toString());
                                setMovementType("PURCHASE_IN");
                                setMovementOpen(true);
                              }}
                              className="inline-flex items-center gap-1 font-mono text-sm font-bold text-[var(--accent)] tabular-nums hover:underline"
                              title="Створити рух 'Отримання' на цю кількість"
                            >
                              {e.boxes_to_order}
                              <span className="text-base">📦</span>
                            </button>
                          ) : <span className="text-[var(--text-faint)] w-8 text-center">—</span>}
                          <button
                            onClick={() => setBatchProductId(e.product_id.toString())}
                            className="rounded border border-[var(--border)] px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--accent)] hover:text-white hover:border-transparent transition-colors"
                            title="Відправити у виробництво"
                          >
                            + Партія
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs text-[var(--text-faint)]">
        ✎ Клікніть Мін / Бажаний / Коробка щоб редагувати прямо в таблиці · «Замовити» = кількість коробок до бажаного рівня
      </p>

      <CreateMovementModal
        open={movementOpen}
        onClose={() => { setMovementOpen(false); setMovementProductId(null); setMovementQuantity(null); }}
        initialType={movementType}
        initialProductId={movementProductId ?? undefined}
        initialQuantity={movementQuantity ?? undefined}
        onCreated={() => { load(); }}
      />

      <CreateBatchModal
        open={batchProductId !== null}
        onClose={() => setBatchProductId(null)}
        initialProductId={batchProductId ?? undefined}
        onCreated={() => {}}
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

      {replenishOpen && (
        <ReplenishModal
          onClose={() => setReplenishOpen(false)}
          onDone={() => { setReplenishOpen(false); load(); }}
        />
      )}
    </div>
  );
}
