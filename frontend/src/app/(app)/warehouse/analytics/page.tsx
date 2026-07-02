"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useWarehouseStream } from "@/hooks/useWarehouseStream";
import { PageSkeleton } from "@/components/ui/ContentSkeleton";

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

type TurnoverRow = {
  product_id: number; product_name: string; sku: string | null;
  sold_qty: string; revenue: string; cogs: string;
  current_stock: string; avg_stock: string;
  turnover: string | null; days_of_stock: string | null;
};

type CustomerRow = {
  counterparty_id: number | null; name: string; orders: number;
  revenue: string; cogs: string; margin: string; margin_pct: string | null;
};

type SeriesPoint = { day: string; revenue: string; cogs: string; margin: string; stock_value: string };

const PERIOD_LABELS: Record<Period, string> = {
  month:   "Цей місяць",
  quarter: "Квартал",
  year:    "Рік",
};

type Tab = "overview" | "turnover" | "customers" | "dynamics";

const TAB_LABELS: Record<Tab, string> = {
  overview:  "Огляд",
  turnover:  "Оборотність",
  customers: "Клієнти",
  dynamics:  "Динаміка",
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

// ── Report views ──────────────────────────────────────────────────────────────

const fmtN = (v: string | null, digits = 0) =>
  v == null ? "—" : parseFloat(v).toLocaleString("uk-UA", { maximumFractionDigits: digits });

function TurnoverView({ days }: { days: number }) {
  const [rows, setRows] = useState<TurnoverRow[] | null>(null);
  useEffect(() => {
    api<TurnoverRow[]>(`/api/warehouse/reports/turnover?days=${days}`).then(setRows).catch(() => setRows([]));
  }, [days]);
  if (!rows) return <PageSkeleton cols={1} />;
  if (rows.length === 0) return <EmptyState label="Немає продажів за період" />;
  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]">
      <table className="ds-table w-full">
        <thead>
          <tr>
            <th className="text-left">Товар</th>
            <th className="text-right">Продано</th>
            <th className="text-right">Виручка</th>
            <th className="text-right">Залишок</th>
            <th className="text-right">Сер. запас</th>
            <th className="text-right" title="Продано ÷ середній запас за період">Оборотність</th>
            <th className="text-right" title="На скільки днів вистачить залишку за поточним темпом">Днів запасу</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const dos = r.days_of_stock ? parseFloat(r.days_of_stock) : null;
            const dosCls = dos == null ? "text-[var(--text-faint)]"
              : dos < 14 ? "text-[var(--state-error)]"
              : dos > 120 ? "text-[var(--state-warn)]" : "";
            return (
              <tr key={r.product_id}>
                <td>
                  <span className="text-sm">{r.product_name}</span>
                  {r.sku && <span className="ml-2 font-mono text-xs text-[var(--text-faint)]">{r.sku}</span>}
                </td>
                <td className="text-right font-mono">{fmtN(r.sold_qty)}</td>
                <td className="text-right font-mono">{fmtN(r.revenue)} ₴</td>
                <td className="text-right font-mono">{fmtN(r.current_stock)}</td>
                <td className="text-right font-mono">{fmtN(r.avg_stock)}</td>
                <td className="text-right font-mono">{r.turnover ? `×${fmtN(r.turnover, 2)}` : "—"}</td>
                <td className={`text-right font-mono ${dosCls}`}>{dos == null ? "∞" : fmtN(r.days_of_stock, 1)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CustomersView({ days }: { days: number }) {
  const [rows, setRows] = useState<CustomerRow[] | null>(null);
  useEffect(() => {
    api<CustomerRow[]>(`/api/warehouse/reports/customers?days=${days}`).then(setRows).catch(() => setRows([]));
  }, [days]);
  if (!rows) return <PageSkeleton cols={1} />;
  if (rows.length === 0) return <EmptyState label="Немає продажів за період" />;
  const maxMargin = Math.max(...rows.map(r => Math.abs(parseFloat(r.margin))), 1);
  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]">
      <table className="ds-table w-full">
        <thead>
          <tr>
            <th className="text-left">Клієнт</th>
            <th className="text-right">Замовлень</th>
            <th className="text-right">Виручка</th>
            <th className="text-right">Собівартість</th>
            <th className="text-right">Прибуток</th>
            <th className="text-right">Маржа</th>
            <th className="w-32"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="text-sm">{r.name}</td>
              <td className="text-right font-mono">{r.orders || "—"}</td>
              <td className="text-right font-mono">{fmtN(r.revenue)} ₴</td>
              <td className="text-right font-mono text-[var(--text-muted)]">{fmtN(r.cogs)} ₴</td>
              <td className={`text-right font-mono ${parseFloat(r.margin) >= 0 ? "text-[var(--state-ok)]" : "text-[var(--state-error)]"}`}>
                {fmtN(r.margin)} ₴
              </td>
              <td className="text-right font-mono">{r.margin_pct ? `${fmtN(r.margin_pct, 1)}%` : "—"}</td>
              <td><MiniBar value={Math.abs(parseFloat(r.margin))} max={maxMargin}
                    cls={parseFloat(r.margin) >= 0 ? "bg-[var(--state-ok)]" : "bg-[var(--state-error)]"} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DynamicsView({ days }: { days: number }) {
  const [points, setPoints] = useState<SeriesPoint[] | null>(null);
  useEffect(() => {
    api<SeriesPoint[]>(`/api/warehouse/reports/margin-series?days=${days}`).then(setPoints).catch(() => setPoints([]));
  }, [days]);
  if (!points) return <PageSkeleton cols={1} />;
  if (points.length === 0) return <EmptyState label="Немає даних" />;

  const maxMoney = Math.max(...points.map(p => Math.max(parseFloat(p.revenue), parseFloat(p.cogs))), 1);
  const maxStock = Math.max(...points.map(p => parseFloat(p.stock_value)), 1);
  const stockPath = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${(i / (points.length - 1)) * 100} ${100 - (parseFloat(p.stock_value) / maxStock) * 95}`)
    .join(" ");
  const label = (s: string) =>
    new Date(s).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit" });

  return (
    <div className="space-y-4">
      {/* Margin bars */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4">
        <h2 className="mb-4 text-sm font-medium">Маржинальний прибуток по днях</h2>
        <div className="flex items-end gap-px overflow-hidden" style={{ height: 140 }}>
          {points.map(p => {
            const rev = parseFloat(p.revenue), cg = parseFloat(p.cogs);
            return (
              <div key={p.day} className="group relative flex flex-1 items-end justify-center gap-px"
                title={`${label(p.day)}: виручка ${fmtN(p.revenue)} ₴, прибуток ${fmtN(p.margin)} ₴`}>
                <div className="w-full rounded-t bg-[var(--accent)]/70" style={{ height: `${(rev / maxMoney) * 130}px` }} />
                <div className="w-full rounded-t bg-[var(--state-error)]/40" style={{ height: `${(cg / maxMoney) * 130}px` }} />
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex justify-between text-[10px] text-[var(--text-faint)]">
          <span>{label(points[0].day)}</span>
          <span>{label(points[points.length - 1].day)}</span>
        </div>
        <div className="mt-2 flex gap-4 text-xs text-[var(--text-faint)]">
          <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded bg-[var(--accent)]/70" /> Виручка</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded bg-[var(--state-error)]/40" /> Собівартість</span>
        </div>
      </div>

      {/* Stock value line */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4">
        <h2 className="mb-1 text-sm font-medium">Динаміка вартості запасу</h2>
        <p className="mb-3 text-xs text-[var(--text-faint)]">
          Зараз: {fmtN(points[points.length - 1].stock_value)} ₴ (за собівартістю)
        </p>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-32 w-full">
          <path d={stockPath} fill="none" stroke="var(--state-production)" strokeWidth="1.5"
            vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="mt-1 flex justify-between text-[10px] text-[var(--text-faint)]">
          <span>{label(points[0].day)}</span>
          <span>{label(points[points.length - 1].day)}</span>
        </div>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
  const [period,   setPeriod]   = useState<Period>("month");
  const [tab,      setTab]      = useState<Tab>("overview");
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

  const { version } = useWarehouseStream();
  useEffect(() => { load(period); }, [load, period, version]);

  const fmt = (v: string) => parseFloat(v).toLocaleString("uk-UA", { maximumFractionDigits: 0 });
  const days = period === "month" ? 30 : period === "quarter" ? 90 : 365;

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex gap-1">
        {(Object.keys(TAB_LABELS) as Tab[]).map((k) => (
          <button key={k} onClick={() => setTab(k)}
            className={["rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              tab === k
                ? "bg-[var(--surface-hi)] text-[var(--text-hi)]"
                : "text-[var(--text-muted)] hover:text-[var(--text)]",
            ].join(" ")}>
            {TAB_LABELS[k]}
          </button>
        ))}
      </div>
      <div className="flex gap-1">
        {(Object.keys(PERIOD_LABELS) as Period[]).map((p) => (
          <button key={p} onClick={() => setPeriod(p)}
            className={["rounded-md px-3 py-1.5 text-xs transition-colors",
              period === p
                ? "bg-[var(--accent)] text-white  "
                : "border border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-strong)]  ",
            ].join(" ")}>
            {PERIOD_LABELS[p]}
          </button>
        ))}
      </div>
    </div>
  );

  if (tab !== "overview") {
    return (
      <div className="space-y-6">
        {header}
        {tab === "turnover"  && <TurnoverView days={days} />}
        {tab === "customers" && <CustomersView days={days} />}
        {tab === "dynamics"  && <DynamicsView days={days} />}
      </div>
    );
  }

  if (loading) return <PageSkeleton cols={4} withStats statsCount={4} />;
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

      {header}

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
                  <MiniBar value={parseFloat(p.revenue)} max={maxRevenue} cls="bg-[var(--accent)]" />
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
                        <div className="w-4 rounded-t bg-[rgba(34,211,238,.7)]" style={{ height: `${inH}px` }}
                          title={`Надходження: ${fmt(w.inflow)} ₴`} />
                        <div className="w-4 rounded-t bg-[rgba(239,68,68,.5)]" style={{ height: `${outH}px` }}
                          title={`Витрати: ${fmt(w.outflow)} ₴`} />
                      </div>
                      <p className="text-center text-[10px] text-[var(--text-faint)]">{w.label}</p>
                    </div>
                  );
                })}
              </div>
              <div className="mt-3 flex gap-4 text-xs text-[var(--text-faint)]">
                <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded bg-[rgba(34,211,238,.7)]" /> Надходження</span>
                <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded bg-[rgba(239,68,68,.5)]" /> Витрати</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
