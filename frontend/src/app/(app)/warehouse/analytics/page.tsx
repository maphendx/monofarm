"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

type Period = "month" | "quarter" | "year";

type Analytics = {
  revenue:        string;
  cogs:           string;
  gross_profit:   string;
  margin_pct:     string;
  units_produced: number;
  units_sold:     number;
  defect_rate:    string;
  top_products:   { product_id: number; product_name: string; revenue: string; units: number }[];
  material_costs: { name: string; cost: string }[];
  cash_flow:      { label: string; inflow: string; outflow: string }[];
};

const PERIOD_LABELS: Record<Period, string> = {
  month:   "Цей місяць",
  quarter: "Квартал",
  year:    "Рік",
};

// ── Components ────────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, highlight }: {
  label: string; value: string; sub?: string; highlight?: boolean;
}) {
  return (
    <div className={`rounded-xl border p-4 ${highlight ? "border-[var(--border-focus)] bg-[var(--accent-soft)]  " : "border-[var(--border)] bg-[var(--bg-elevated)]  "}`}>
      <p className="text-xs text-[var(--text-muted)]">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${highlight ? "text-[var(--accent)] " : ""}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-[var(--text-faint)]">{sub}</p>}
    </div>
  );
}

function MiniBar({ value, max, cls }: { value: number; max: number; cls: string }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-hi)] ">
      <div className={`h-full rounded-full ${cls}`} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <p className="py-4 text-center text-xs text-[var(--text-faint)]">{label}</p>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
  const [period,   setPeriod]   = useState<Period>("month");
  const [data,     setData]     = useState<Analytics | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);

  const load = useCallback(async (p: Period) => {
    setLoading(true); setError(null);
    try {
      setData(await api<Analytics>(`/api/warehouse/analytics?period=${p}`));
    } catch { setError("Не вдалось завантажити аналітику"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(period); }, [load, period]);

  const fmt = (v: string) => parseFloat(v).toLocaleString("uk-UA", { maximumFractionDigits: 0 });

  if (loading) return <div className="text-sm text-[var(--text-muted)]">Завантаження…</div>;
  if (error || !data) return (
    <div className="rounded-xl border border-dashed border-[var(--border-strong)] px-4 py-12 text-center text-sm text-[var(--text-faint)] ">
      {error ?? "Немає даних"}
    </div>
  );

  const maxRevenue  = Math.max(...data.top_products.map((p) => parseFloat(p.revenue)), 1);
  const maxCost     = Math.max(...data.material_costs.map((m) => parseFloat(m.cost)), 1);
  const maxCash     = Math.max(...data.cash_flow.flatMap((w) => [parseFloat(w.inflow), parseFloat(w.outflow)]), 1);
  const margin      = parseFloat(data.margin_pct);
  const defect      = parseFloat(data.defect_rate);

  return (
    <div className="space-y-6">

      {/* Period */}
      <div className="flex gap-1">
        {(Object.keys(PERIOD_LABELS) as Period[]).map((p) => (
          <button key={p} onClick={() => setPeriod(p)}
            className={["rounded-md px-3 py-1.5 text-xs transition-colors",
              period === p
                ? "bg-[var(--surface)] text-white  "
                : "border border-[var(--border)] text-[var(--text-muted)] hover:border-neutral-400  ",
            ].join(" ")}>
            {PERIOD_LABELS[p]}
          </button>
        ))}
      </div>

      {/* KPI */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Виручка"           value={`${fmt(data.revenue)} ₴`} />
        <KpiCard label="Валовий прибуток"  value={`${fmt(data.gross_profit)} ₴`}
          sub={`${margin.toFixed(1)}% маржа`} highlight />
        <KpiCard label="Вироблено"         value={`${data.units_produced} шт`}
          sub={`продано ${data.units_sold}`} />
        <KpiCard label="Відсоток браку"    value={`${defect.toFixed(1)}%`}
          sub={defect < 4 ? "норма" : "⚠ вище норми"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">

        {/* Top products */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4  ">
          <h2 className="mb-4 text-sm font-medium">Топ товарів (виручка)</h2>
          {data.top_products.length === 0 ? <EmptyState label="Немає продажів за цей період" /> : (
            <div className="space-y-3">
              {data.top_products.map((p) => (
                <div key={p.product_id}>
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="truncate text-[var(--text)] ">{p.product_name}</span>
                    <span className="ml-2 shrink-0 tabular-nums text-[var(--text-muted)]">
                      {fmt(p.revenue)} ₴ · {p.units} шт
                    </span>
                  </div>
                  <MiniBar value={parseFloat(p.revenue)} max={maxRevenue} cls="bg-cyan-500" />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Material costs */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4  ">
          <h2 className="mb-4 text-sm font-medium">Витрати на матеріали</h2>
          {data.material_costs.length === 0 ? <EmptyState label="Немає закупок за цей період" /> : (
            <div className="space-y-3">
              {data.material_costs.map((m) => (
                <div key={m.name}>
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="truncate text-[var(--text)] ">{m.name}</span>
                    <span className="ml-2 shrink-0 tabular-nums text-[var(--text-muted)]">{fmt(m.cost)} ₴</span>
                  </div>
                  <MiniBar value={parseFloat(m.cost)} max={maxCost} cls="bg-violet-500" />
                </div>
              ))}
              <div className="border-t border-[var(--border)] pt-2 ">
                <div className="flex justify-between text-xs">
                  <span className="text-[var(--text-muted)]">COGS</span>
                  <span className="font-medium tabular-nums">{fmt(data.cogs)} ₴</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Cash flow */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4   lg:col-span-2">
          <h2 className="mb-4 text-sm font-medium">Грошовий потік</h2>
          {data.cash_flow.length === 0 ? <EmptyState label="Немає рухів за цей період" /> : (
            <>
              <div className="flex items-end gap-3">
                {data.cash_flow.map((w) => {
                  const inH  = (parseFloat(w.inflow)  / maxCash) * 120;
                  const outH = (parseFloat(w.outflow) / maxCash) * 120;
                  return (
                    <div key={w.label} className="flex flex-1 flex-col items-center gap-1">
                      <div className="flex w-full items-end justify-center gap-1">
                        <div className="w-4 rounded-t bg-cyan-500/70" style={{ height: `${inH}px` }}
                          title={`Надходження: ${fmt(w.inflow)} ₴`} />
                        <div className="w-4 rounded-t bg-red-400/60" style={{ height: `${outH}px` }}
                          title={`Витрати: ${fmt(w.outflow)} ₴`} />
                      </div>
                      <p className="text-center text-[10px] text-[var(--text-faint)]">{w.label}</p>
                    </div>
                  );
                })}
              </div>
              <div className="mt-3 flex gap-4 text-xs text-[var(--text-faint)]">
                <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded bg-cyan-500/70" /> Надходження</span>
                <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded bg-red-400/60" /> Витрати</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
