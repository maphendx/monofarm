"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { CreateMovementModal, Movement, MovementType, TYPE_META } from "@/components/warehouse/MovementModal";
import {
  useColumnVisibility,
  ColumnSettingsModal,
  TableSettingsButton,
  type ColDef,
} from "@/components/warehouse/TableSettings";

const TYPE_FILTERS = ["Всі", "Виробництво", "Продаж", "Закупка", "Брак", "Переміщення", "Коригування"] as const;
type TFilter = typeof TYPE_FILTERS[number];
const FILTER_MAP: Record<TFilter, MovementType[] | null> = {
  "Всі": null,
  "Виробництво": ["PRODUCTION_IN", "PRODUCTION_OUT"],
  "Продаж":      ["SALE_OUT"],
  "Закупка":     ["PURCHASE_IN"],
  "Брак":        ["DEFECT"],
  "Переміщення": ["TRANSFER"],
  "Коригування": ["ADJUSTMENT"],
};

const COLS: ColDef[] = [
  { key: "date",    label: "Дата",      required: true },
  { key: "type",    label: "Тип" },
  { key: "product", label: "Товар",     required: true },
  { key: "qty",     label: "К-сть" },
  { key: "amount",  label: "Сума" },
  { key: "reason",  label: "Причина" },
];

// ── Page ──────────────────────────────────────────────────────────────────────

export default function MovementsPage() {
  const [movements,      setMovements]      = useState<Movement[]>([]);
  const [loading,        setLoading]        = useState(true);
  const [filter,         setFilter]         = useState<TFilter>("Всі");
  const [createOpen,     setCreateOpen]     = useState(false);
  const [colSettingsOpen, setColSettingsOpen] = useState(false);

  const colVis = useColumnVisibility("movements", COLS);

  const load = useCallback(async () => {
    try { setMovements(await api<Movement[]>("/api/warehouse/movements?limit=200")); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const allowed  = FILTER_MAP[filter];
  const filtered = allowed ? movements.filter((m) => allowed.includes(m.type)) : movements;
  const colSpan  = COLS.filter((c) => colVis.isVisible(c.key)).length;

  if (loading) return <div className="text-sm text-[var(--text-muted)]">Завантаження…</div>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {TYPE_FILTERS.map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={["rounded-md px-2.5 py-1.5 text-xs transition-colors",
                filter === f
                  ? "bg-[var(--accent)] text-white"
                  : "border border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-strong)]",
              ].join(" ")}>
              {f}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <TableSettingsButton onClick={() => setColSettingsOpen(true)} />
          <button onClick={load} className="rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs hover:bg-[var(--surface-hi)]">↻</button>
          <button onClick={() => setCreateOpen(true)} className="btn btn-primary btn-sm">
            + Рух
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]">
        <table className="w-full text-sm">
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
            {filtered.length === 0 ? (
              <tr><td colSpan={colSpan} className="px-4 py-10 text-center text-[var(--text-faint)]">Немає записів</td></tr>
            ) : filtered.map((m) => {
              const meta = TYPE_META[m.type];
              const qty  = parseFloat(m.quantity);
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
                    <td className="px-4 py-3 text-right tabular-nums">
                      {qty > 0 ? "+" : ""}{qty.toFixed(0)} {m.unit}
                    </td>
                  )}
                  {colVis.isVisible("amount") && (
                    <td className="px-4 py-3 text-right tabular-nums text-[var(--text-muted)]">
                      {m.total_cost ? `${parseFloat(m.total_cost).toFixed(2)} ₴` : "—"}
                    </td>
                  )}
                  {colVis.isVisible("reason") && (
                    <td className="px-4 py-3 text-xs text-[var(--text-faint)]">{m.reason ?? "—"}</td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <CreateMovementModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(m) => { setMovements((prev) => [m, ...prev]); }}
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
