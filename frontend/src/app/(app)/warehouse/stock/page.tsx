"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

type StockEntry = {
  id:             number;
  product_id:     number;
  product_name:   string;
  product_sku:    string;
  product_unit:   string;
  warehouse_id:   number;
  warehouse_name: string;
  quantity:       string;
  reserved_qty:   string;
  available:      string;
  min_stock:      number | null;
  desired_stock:  number | null;
  box_limit:      number | null;
  boxes_to_order: number | null;
  updated_at:     string;
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

// ── Page ──────────────────────────────────────────────────────────────────────

type FilterMode = "all" | "out" | "low" | "order";

export default function StockPage() {
  const [stock,    setStock]    = useState<StockEntry[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [whFilter, setWhFilter] = useState("Всі");
  const [mode,     setMode]     = useState<FilterMode>("all");
  const [search,   setSearch]   = useState("");

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
      if (!e.product_name.toLowerCase().includes(q) && !e.product_sku.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  if (loading) return <div className="text-sm text-[var(--text-muted)]">Завантаження…</div>;

  return (
    <div className="space-y-4">

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
          <input type="search" placeholder="Назва або артикул…" value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] pl-8 pr-3 text-xs outline-none placeholder:text-[var(--text-faint)] focus:border-[var(--border-strong)]" />
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
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-[var(--bg)] text-left text-xs uppercase tracking-wider text-[var(--text-faint)]">
              <tr>
                <th className="px-4 py-3 font-medium">Товар</th>
                <th className="px-3 py-3 font-medium">Склад</th>
                <th className="px-3 py-3 text-right font-medium">Залишок</th>
                <th className="px-3 py-3 text-right font-medium">Резерв</th>
                <th className="px-3 py-3 text-right font-medium text-[var(--state-warn)]">Мін ✎</th>
                <th className="px-3 py-3 text-right font-medium text-[var(--state-ok)]">Бажаний ✎</th>
                <th className="px-3 py-3 text-right font-medium text-[var(--accent)]">Коробка ✎</th>
                <th className="px-3 py-3 text-right font-medium">Замовити</th>
                <th className="px-3 py-3 font-medium">Статус</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {filtered.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-12 text-center text-sm text-[var(--text-faint)]">
                  {search || mode !== "all" || whFilter !== "Всі" ? "Нічого не знайдено" : "Залишків немає"}
                </td></tr>
              ) : filtered.map((e) => {
                const avail  = parseFloat(e.available);
                const status = getStatus(e);
                const meta   = STATUS_META[status];
                return (
                  <tr key={e.id} className={["transition-colors hover:bg-[var(--surface-hi)]", meta.row].join(" ")}>
                    <td className="px-4 py-2.5">
                      <p className="font-medium leading-tight">{e.product_name}</p>
                      <p className="font-mono text-xs text-[var(--text-faint)]">{e.product_sku}</p>
                      <StockBar avail={avail} min={e.min_stock} desired={e.desired_stock} />
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="rounded-full bg-[var(--surface-hi)] px-2 py-0.5 text-xs">
                        {e.warehouse_name}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <span className={["font-mono text-sm font-semibold tabular-nums",
                        status === "out" ? "text-[var(--state-error)]"
                          : status === "low" ? "text-[var(--state-warn)]"
                          : "text-[var(--text)]",
                      ].join(" ")}>
                        {Math.round(avail)}
                      </span>
                      <span className="ml-1 text-[10px] text-[var(--text-faint)]">{e.product_unit}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs text-[var(--text-faint)]">
                      {parseFloat(e.reserved_qty) > 0 ? Math.round(parseFloat(e.reserved_qty)) : "—"}
                    </td>
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
                    <td className="px-3 py-2.5">
                      <span className="flex items-center gap-1.5">
                        <span className={["size-2 shrink-0 rounded-full", meta.dot].join(" ")} />
                        <span className="text-xs">{meta.label}</span>
                      </span>
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
    </div>
  );
}
