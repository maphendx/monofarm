"use client";

import { useCallback, useEffect, useState } from "react";
import { api, apiAll } from "@/lib/api";
import { useWarehouseStream } from "@/hooks/useWarehouseStream";
import { PageSkeleton } from "@/components/ui/ContentSkeleton";

// ── Types ─────────────────────────────────────────────────────────────────────

type LowStockItem = {
  product_id:   number;
  product_name: string;
  available:    string;
};

type DashboardSummary = {
  sku_count:   number;
  total_units: string;
  low_stock:   LowStockItem[];
};

type Batch = {
  id:           number;
  product_name: string;
  target_qty:   number;
  printed_qty:  number;
  status:       string;
  due_date:     string | null;
};

type Movement = {
  id:              number;
  type:            string;
  product_name:    string;
  quantity:        string;
  warehouse_to_id: number | null;
  created_at:      string;
};

type MovementListOut = { items: Movement[]; next_cursor: string | null };

type OrderListItem = { id: number; status: string };

const TYPE_META: Record<string, { label: string; cls: string }> = {
  PRODUCTION_IN:  { label: "Виробництво +", cls: "badge badge-ok" },
  PRODUCTION_OUT: { label: "Сировина −",    cls: "badge badge-print" },
  SALE_OUT:       { label: "Продаж",        cls: "badge badge-accent" },
  PURCHASE_IN:    { label: "Закупка",       cls: "badge badge-accent" },
  DEFECT:         { label: "Брак",          cls: "badge badge-error" },
  ADJUSTMENT:     { label: "Коригування",   cls: "badge badge-neutral" },
  TRANSFER:       { label: "Переміщення",   cls: "badge badge-warn" },
};

// ── Components ────────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4  ">
      <p className="text-xs text-[var(--text-muted)]">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
      <p className="mt-0.5 text-xs text-[var(--text-faint)]">{sub}</p>
    </div>
  );
}

function ProgressBar({ value }: { value: number }) {
  const pct = Math.min(100, Math.round(value));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-hi)] ">
      <div className="h-full rounded-full bg-[var(--accent)] transition-[width]" style={{ width: `${pct}%` }} />
    </div>
  );
}

function fmtDate(s: string) {
  return new Date(s).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

const LOW_STOCK_PREVIEW = 8;

function pluralPositions(n: number): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "позиція";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "позиції";
  return "позицій";
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function WarehouseDashboard() {
  const [summary,        setSummary]        = useState<DashboardSummary | null>(null);
  const [batches,        setBatches]        = useState<Batch[]>([]);
  const [movements,      setMovements]      = useState<Movement[]>([]);
  const [pendingOrders,  setPendingOrders]  = useState(0);
  const [loading,        setLoading]        = useState(true);
  const [showAllLow,     setShowAllLow]     = useState(false);

  const load = useCallback(async () => {
    try {
      const [d, b, m, orders] = await Promise.all([
        api<DashboardSummary>("/api/warehouse/dashboard"),
        apiAll<Batch>("/api/warehouse/batches"),
        api<MovementListOut>("/api/warehouse/movements?limit=5"),
        apiAll<OrderListItem>("/api/warehouse/orders?order_status=new"),
      ]);
      setSummary(d);
      setBatches(b);
      setMovements(m.items);
      setPendingOrders(orders.length);
    } finally {
      setLoading(false);
    }
  }, []);

  const { version } = useWarehouseStream();
  useEffect(() => { load(); }, [load, version]);

  const activeBatches = batches.filter((b) => ["draft", "active", "paused"].includes(b.status));
  const totalUnits    = parseFloat(summary?.total_units ?? "0");

  const lowStock = summary?.low_stock ?? [];

  if (loading) return <PageSkeleton cols={5} withStats statsCount={4} />;

  return (
    <div className="space-y-6">

      {/* KPI */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Товари (SKU)"       value={String(summary?.sku_count ?? 0)} sub="активних позицій" />
        <KpiCard label="Готова продукція"   value={String(Math.round(totalUnits))} sub="одиниць на складах" />
        <KpiCard label="Активні партії"     value={String(activeBatches.length)} sub="у виробництві" />
        <KpiCard label="Нові замовлення"    value={String(pendingOrders)} sub="очікують обробки" />
      </div>

      {/* Low stock alert */}
      {lowStock.length > 0 && (
        <div className="rounded-xl border border-[rgba(245,158,11,.25)] bg-[rgba(245,158,11,.08)] px-4 py-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-[var(--state-warn)]">
              ⚠ {lowStock.length} {pluralPositions(lowStock.length)} нижче мінімального залишку
            </p>
            {lowStock.length > LOW_STOCK_PREVIEW && (
              <button
                onClick={() => setShowAllLow((v) => !v)}
                className="shrink-0 text-xs font-medium text-[var(--state-warn)] underline-offset-2 hover:underline"
              >
                {showAllLow ? "Згорнути" : `Показати всі (${lowStock.length})`}
              </button>
            )}
          </div>
          <div className={`flex flex-wrap gap-1.5 ${showAllLow ? "max-h-40 overflow-y-auto pr-1" : ""}`}>
            {(showAllLow ? lowStock : lowStock.slice(0, LOW_STOCK_PREVIEW)).map((s) => (
              <span
                key={s.product_id}
                className="inline-flex items-center gap-1.5 rounded-full border border-[rgba(245,158,11,.25)] bg-[rgba(245,158,11,.1)] px-2.5 py-0.5 text-xs text-[var(--state-warn)]"
              >
                <span className="font-medium">{s.product_name}</span>
                <span className="tabular-nums opacity-75">{parseFloat(s.available).toFixed(0)} шт</span>
              </span>
            ))}
            {!showAllLow && lowStock.length > LOW_STOCK_PREVIEW && (
              <button
                onClick={() => setShowAllLow(true)}
                className="inline-flex items-center rounded-full border border-[rgba(245,158,11,.25)] px-2.5 py-0.5 text-xs font-medium text-[var(--state-warn)] hover:bg-[rgba(245,158,11,.1)]"
              >
                +{lowStock.length - LOW_STOCK_PREVIEW} ще
              </button>
            )}
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">

        {/* Active batches */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4  ">
          <h2 className="mb-3 text-sm font-medium">Активні партії</h2>
          {activeBatches.length === 0 ? (
            <p className="text-sm text-[var(--text-faint)]">Немає активних партій</p>
          ) : (
            <div className="space-y-4">
              {activeBatches.map((b) => {
                const pct = b.target_qty > 0 ? (b.printed_qty / b.target_qty) * 100 : 0;
                return (
                  <div key={b.id}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span className="font-medium">{b.product_name}</span>
                      {b.due_date && (
                        <span className="text-xs text-[var(--text-faint)]">до {new Date(b.due_date).toLocaleDateString("uk-UA")}</span>
                      )}
                    </div>
                    <ProgressBar value={pct} />
                    <p className="mt-1 text-xs text-[var(--text-faint)]">
                      {b.printed_qty} / {b.target_qty} шт · {pct.toFixed(0)}%
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Recent movements */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4  ">
          <h2 className="mb-3 text-sm font-medium">Останні рухи</h2>
          {movements.length === 0 ? (
            <p className="text-sm text-[var(--text-faint)]">Немає рухів</p>
          ) : (
            <div className="space-y-2">
              {movements.map((m) => {
                const meta = TYPE_META[m.type] ?? { label: m.type, cls: "bg-[var(--surface-hi)] text-[var(--text-muted)]" };
                return (
                  <div key={m.id} className="flex items-center gap-3 text-sm">
                    <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-medium ${meta.cls}`}>
                      {meta.label}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[var(--text)] ">
                      {m.product_name}
                    </span>
                    <span className="shrink-0 font-mono text-xs tabular-nums text-[var(--text-muted)]">
                      {parseFloat(m.quantity) > 0 ? "+" : ""}{parseFloat(m.quantity).toFixed(0)}
                    </span>
                    <span className="shrink-0 text-xs text-[var(--text-faint)]">{fmtDate(m.created_at)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
