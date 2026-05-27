"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import Link from "next/link";
import { CreateMovementModal, Movement, MovementType } from "@/components/warehouse/MovementModal";

// ── Types ─────────────────────────────────────────────────────────────────────

type CellLocation = {
  name: string;
  quantity: string;
};

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: string | number | null): string {
  if (n == null) return "—";
  const v = typeof n === "string" ? parseFloat(n) : n;
  return isNaN(v) ? "—" : v.toLocaleString("uk-UA", { maximumFractionDigits: 2 });
}

// ── Page ──────────────────────────────────────────────────────────────────────

type FilterMode = "all" | "out" | "low" | "order";

export default function StockPage() {
  const [stock,    setStock]    = useState<StockEntry[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [whFilter, setWhFilter] = useState("Всі");
  const [mode,     setMode]     = useState<FilterMode>("all");
  const [search,   setSearch]   = useState("");
  
  // Movement Modal state
  const [movementOpen, setMovementOpen] = useState(false);
  const [movementType, setMovementType] = useState<MovementType>("PURCHASE_IN");

  const load = useCallback(async () => {
    try { setStock(await api<StockEntry[]>("/api/warehouse/stock")); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  function updateThreshold(pid: number, field: string, val: number | null) {
    setStock((prev) => prev.map((e) =>
      e.product_id === pid ? { ...e, [field]: val } : e,
    ));
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

  if (loading) return <div className="text-sm text-[var(--text-muted)]">Завантаження…</div>;

  return (
    <div className="space-y-4">

      {/* Top Actions */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-bold">Залишки на складі</h1>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => openMovement("PURCHASE_IN")} className="btn btn-primary btn-sm">
            + Отримання
          </button>
          <button onClick={() => openMovement("SALE_OUT")} className="btn btn-primary btn-sm">
            + Продаж
          </button>
          <button onClick={() => openMovement("DEFECT")} className="btn btn-primary btn-sm bg-[var(--state-error)] hover:bg-red-600 border-none text-white">
            + Списання
          </button>
          <button onClick={() => openMovement("TRANSFER")} className="btn btn-primary btn-sm bg-[var(--state-warn)] hover:bg-amber-600 border-none text-white">
            + Переміщення
          </button>
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
                <th className="px-3 py-3 font-medium">Назва</th>
                <th className="px-3 py-3 font-medium">Код</th>
                <th className="px-2 py-3 font-medium" title="Історія рухів">Іст.</th>
                <th className="px-3 py-3 font-medium">Категорії</th>
                <th className="px-3 py-3 font-medium">Склад</th>
                <th className="px-3 py-3 font-medium">Локація</th>
                <th className="px-3 py-3 text-right font-medium">В наявності</th>
                <th className="px-3 py-3 text-right font-medium">Вартість</th>
                <th className="px-3 py-3 text-right font-medium">Резерв</th>
                <th className="px-3 py-3 text-right font-medium">Доступний залишок</th>
                <th className="px-3 py-3 text-right font-medium">Загальний залишок</th>
                <th className="px-3 py-3 text-right font-medium">Собівартість за одиницю</th>
                
                {/* Threshold columns (kept from previous implementation) */}
                <th className="px-3 py-3 text-right font-medium text-[var(--state-warn)]">Мін ✎</th>
                <th className="px-3 py-3 text-right font-medium text-[var(--state-ok)]">Бажаний ✎</th>
                <th className="px-3 py-3 text-right font-medium text-[var(--accent)]">Коробка ✎</th>
                <th className="px-3 py-3 text-right font-medium">Замовити</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {filtered.length === 0 ? (
                <tr><td colSpan={17} className="px-4 py-12 text-center text-sm text-[var(--text-faint)]">
                  {search || mode !== "all" || whFilter !== "Всі" ? "Нічого не знайдено" : "Залишків немає"}
                </td></tr>
              ) : filtered.map((e) => {
                const avail  = parseFloat(e.available);
                const status = getStatus(e);
                const meta   = STATUS_META[status];
                const totalCost = e.full_cost ? parseFloat(e.quantity) * parseFloat(e.full_cost) : null;
                
                return (
                  <tr key={e.id} className={["transition-colors hover:bg-[var(--surface-hi)]", meta.row].join(" ")}>
                    <td className="px-3 py-2.5">
                      <input type="checkbox" className="rounded bg-[var(--surface-hi)] border-[var(--border)] text-[var(--accent)]" />
                    </td>
                    <td className="px-3 py-2.5">
                      <p className="font-medium leading-tight">{e.product_name}</p>
                      <p className="font-mono text-xs text-[var(--text-faint)]">{e.product_sku}</p>
                      <StockBar avail={avail} min={e.min_stock} desired={e.desired_stock} />
                    </td>
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
                    <td className="px-2 py-2.5 text-center">
                      <Link href={`/warehouse/movements?search=${encodeURIComponent(e.product_sku)}`}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)] transition-colors"
                        title="Історія рухів">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                          <path d="M3 3v5h5" />
                          <path d="M12 7v5l4 2" />
                        </svg>
                      </Link>
                    </td>
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
                    <td className="px-3 py-2.5">
                      <span className="text-sm font-medium">{e.warehouse_name}</span>
                    </td>
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
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <span className={["font-mono text-sm font-semibold tabular-nums",
                        status === "out" ? "text-[var(--state-error)]" : status === "low" ? "text-[var(--state-warn)]" : "text-[var(--text)]",
                      ].join(" ")}>
                        {fmt(e.quantity)}
                      </span>
                      <span className="ml-1 text-[10px] text-[var(--text-faint)]">{e.product_unit}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap font-mono tabular-nums text-sm">
                      {totalCost != null ? fmt(totalCost) : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-[var(--text-faint)] whitespace-nowrap">
                      {parseFloat(e.reserved_qty) > 0 ? fmt(e.reserved_qty) : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <span className="font-mono text-sm font-semibold tabular-nums text-[var(--text)]">
                        {fmt(e.available)}
                      </span>
                      <span className="ml-1 text-[10px] text-[var(--text-faint)]">{e.product_unit}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <span className="font-mono text-sm font-semibold tabular-nums text-[var(--text-muted)]">
                        {fmt(e.total_stock)}
                      </span>
                      <span className="ml-1 text-[10px] text-[var(--text-faint)]">{e.product_unit}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap font-mono tabular-nums text-sm">
                      {e.full_cost != null ? fmt(e.full_cost) : "—"}
                    </td>
                    
                    {/* Extra Threshold Columns */}
                    <td className="px-3 py-2.5 text-right">
                      <ThresholdCell value={e.min_stock} productId={e.product_id}
                        field="min_stock" onSaved={updateThreshold} />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <ThresholdCell value={e.desired_stock} productId={e.product_id}
                        field="desired_stock" onSaved={updateThreshold} />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <ThresholdCell value={e.box_limit} productId={e.product_id}
                        field="box_limit" onSaved={updateThreshold} />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {e.boxes_to_order != null ? (
                        <span className="inline-flex items-center gap-1 font-mono text-sm font-bold text-[var(--accent)] tabular-nums">
                          {e.boxes_to_order}
                          <span className="text-base">📦</span>
                        </span>
                      ) : <span className="text-[var(--text-faint)]">—</span>}
                    </td>
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
        onClose={() => setMovementOpen(false)}
        initialType={movementType}
        onCreated={() => {
          load(); // Reload stock after new movement
        }}
      />
    </div>
  );
}
