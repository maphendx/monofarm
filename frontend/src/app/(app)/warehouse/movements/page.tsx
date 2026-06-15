"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWarehouseStream } from "@/hooks/useWarehouseStream";
import { api } from "@/lib/api";
import { matchTokens } from "@/lib/search";
import { CreateMovementModal, Movement, MovementType, TYPE_META } from "@/components/warehouse/MovementModal";
import { FilterDropdown } from "@/components/warehouse/FilterDropdown";
import {
  useColumnVisibility,
  ColumnSettingsModal,
  TableSettingsButton,
  type ColDef,
} from "@/components/warehouse/TableSettings";

const TYPE_FILTERS = ["Всі", "Виробництво", "Продаж", "Закупка", "Брак", "Переміщення", "Коригування"] as const;
type TFilter = typeof TYPE_FILTERS[number];
const FILTER_MAP: Record<TFilter, MovementType[] | null> = {
  "Всі":         null,
  "Виробництво": ["PRODUCTION_IN", "PRODUCTION_OUT"],
  "Продаж":      ["SALE_OUT"],
  "Закупка":     ["PURCHASE_IN"],
  "Брак":        ["DEFECT"],
  "Переміщення": ["TRANSFER"],
  "Коригування": ["ADJUSTMENT"],
};

const COLS: ColDef[] = [
  { key: "date",    label: "Дата",   required: true },
  { key: "type",    label: "Тип" },
  { key: "product", label: "Товар",  required: true },
  { key: "qty",     label: "К-сть" },
  { key: "amount",  label: "Сума" },
  { key: "reason",  label: "Причина" },
];

const PAGE_SIZE = 50;

// ── Page ──────────────────────────────────────────────────────────────────────

export default function MovementsPage() {
  const [items,          setItems]          = useState<Movement[]>([]);
  const [nextCursor,     setNextCursor]     = useState<string | null>(null);
  const [hasMore,        setHasMore]        = useState(false);
  const [total,          setTotal]          = useState<number | null>(null);
  const [filter,         setFilter]         = useState<TFilter>("Всі");
  const [search,         setSearch]         = useState("");
  const [loading,        setLoading]        = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [createOpen,     setCreateOpen]     = useState(false);
  const [colSettingsOpen, setColSettingsOpen] = useState(false);

  const colVis   = useColumnVisibility("movements", COLS);
  const inFlight = useRef(false);

  function buildParams(cursor: string | null) {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    const types  = FILTER_MAP[filter];
    if (types?.length === 1) params.set("movement_type", types[0]);
    if (cursor) params.set("cursor", cursor);
    return params.toString();
  }

  const loadFirst = useCallback(async (f: TFilter) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setInitialLoading(true);
    try {
      const types  = FILTER_MAP[f];
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (types?.length === 1) params.set("movement_type", types[0]);
      const res = await api<{ items: Movement[]; next_cursor: string | null; has_more: boolean; total: number | null }>(
        `/api/warehouse/movements?${params}`,
      );
      setItems(res.items);
      setNextCursor(res.next_cursor);
      setHasMore(res.has_more);
      if (res.total != null) setTotal(res.total);
    } finally { inFlight.current = false; setInitialLoading(false); }
  }, []);

  async function loadMore() {
    if (inFlight.current || !nextCursor) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const res = await api<{ items: Movement[]; next_cursor: string | null; has_more: boolean; total: number | null }>(
        `/api/warehouse/movements?${buildParams(nextCursor)}`,
      );
      setItems(prev => [...prev, ...res.items]);
      setNextCursor(res.next_cursor);
      setHasMore(res.has_more);
    } finally { inFlight.current = false; setLoading(false); }
  }

  const { version } = useWarehouseStream();

  // reset on filter change or WS event
  useEffect(() => {
    setItems([]); setNextCursor(null); setHasMore(false); setTotal(null);
    loadFirst(filter);
  }, [filter, loadFirst, version]);

  const displayed = search.trim()
    ? items.filter((m) => matchTokens(m.product_name, search))
    : items;

  const colSpan = COLS.filter(c => colVis.isVisible(c.key)).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <svg className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-faint)]"
              width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <input
              type="search"
              placeholder="Товар…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-52 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] pl-8 pr-3 text-xs outline-none placeholder:text-[var(--text-faint)] focus:border-[var(--border-strong)]"
            />
          </div>
          <FilterDropdown active={filter !== "Всі" ? 1 : 0}>
            <div className="p-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-[var(--text-faint)]">Тип руху</p>
              <div className="space-y-0.5">
                {TYPE_FILTERS.map((f) => (
                  <label key={f} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-[var(--surface-hi)]">
                    <input
                      type="radio"
                      name="move-type-filter"
                      checked={filter === f}
                      onChange={() => setFilter(f)}
                      className="accent-[var(--accent)]"
                    />
                    <span className="text-sm">{f}</span>
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
        </div>
        <div className="flex items-center gap-2">
          {total != null && (
            <span className="text-xs text-[var(--text-faint)]">
              {displayed.length}{search ? ` з ${items.length}` : total != null ? ` з ${total}` : ""}
            </span>
          )}
          <TableSettingsButton onClick={() => setColSettingsOpen(true)} />
          <button onClick={() => loadFirst(filter)}
            className="rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs hover:bg-[var(--surface-hi)]">↻</button>
          <button onClick={() => setCreateOpen(true)} className="btn btn-primary btn-sm">
            + Рух
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]">
        <table className="min-w-[520px] w-full text-sm">
          <thead className="bg-[var(--bg)] text-left text-xs uppercase tracking-wider text-[var(--text-muted)]">
            <tr>
              {colVis.isVisible("date")    && <th className="px-4 py-3 font-medium">Дата</th>}
              {colVis.isVisible("type")    && <th className="px-4 py-3 font-medium">Тип</th>}
              {colVis.isVisible("product") && <th className="px-4 py-3 font-medium">Товар</th>}
              {colVis.isVisible("qty")     && <th className="px-4 py-3 font-medium text-right">К-сть</th>}
              {colVis.isVisible("amount")  && <th className="px-4 py-3 font-medium text-right">Сума</th>}
              {colVis.isVisible("reason")  && <th className="px-4 py-3 font-medium">Причина</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {initialLoading ? (
              <tr><td colSpan={colSpan} className="px-4 py-10 text-center text-[var(--text-faint)]">Завантаження…</td></tr>
            ) : displayed.length === 0 ? (
              <tr><td colSpan={colSpan} className="px-4 py-10 text-center text-[var(--text-faint)]">Немає записів</td></tr>
            ) : displayed.map(m => {
              const meta   = TYPE_META[m.type];
              const qty    = parseFloat(m.quantity);
              const isOut  = m.direction === "out";
              const isXfer = m.direction === "transfer";
              const signed = isOut ? -qty : qty;
              return (
                <tr key={m.id} className="hover:bg-[var(--surface-hi)]">
                  {colVis.isVisible("date") && (
                    <td className="px-4 py-3 font-mono text-xs text-[var(--text-faint)]">
                      {new Date(m.created_at).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                    </td>
                  )}
                  {colVis.isVisible("type") && (
                    <td className="px-4 py-3">
                      <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${meta.cls}`}>{meta.label}</span>
                    </td>
                  )}
                  {colVis.isVisible("product") && (
                    <td className="px-4 py-3 font-medium">{m.product_name}</td>
                  )}
                  {colVis.isVisible("qty") && (
                    <td className={[
                      "px-4 py-3 text-right tabular-nums font-medium",
                      isOut  ? "text-[var(--state-error)]" : isXfer ? "text-[var(--state-warn)]" : "text-[var(--state-ok)]",
                    ].join(" ")}>
                      {isXfer ? "⇄ " : signed > 0 ? "+" : ""}{signed.toFixed(0)} {m.unit}
                    </td>
                  )}
                  {colVis.isVisible("amount") && (
                    <td className="px-4 py-3 text-right tabular-nums text-[var(--text-muted)]">
                      {m.total_cost ? `${parseFloat(m.total_cost).toFixed(2)} ₴` : "—"}
                    </td>
                  )}
                  {colVis.isVisible("reason") && (
                    <td className="px-4 py-3 text-xs text-[var(--text-faint)]">
                      {m.reason
                        ? m.reason.startsWith("Задача #")
                          ? <span className="inline-flex items-center gap-1"><span className="rounded bg-[var(--accent)]/10 px-1 py-px text-[10px] text-[var(--accent)]">авто</span>{m.reason}</span>
                          : m.reason
                        : "—"}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {hasMore && (
        <div className="flex justify-center">
          <button onClick={loadMore} disabled={loading}
            className="rounded-md border border-[var(--border)] px-4 py-2 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)] disabled:opacity-50">
            {loading ? "Завантаження…" : "Завантажити ще"}
          </button>
        </div>
      )}

      {createOpen && (
        <CreateMovementModal
          key="new"
          open
          onClose={() => setCreateOpen(false)}
          onCreated={m => { setItems(prev => [m, ...prev]); setTotal(t => t != null ? t + 1 : null); }}
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
    </div>
  );
}
