"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

type Product = {
  id: number; name: string; sku: string; categories: string[];
  unit: string; sale_price: string | null;
  direct_cost: string | null; full_cost: string | null;
};

type SpecComponent = {
  id: number; name: string; quantity: string; unit: string;
  unit_price: string | null; waste_pct: string; sort_order: number;
};

type SpecOperation = {
  id: number; type: string; name: string; sort_order: number;
  print_time_min: string | null; power_watts: number | null;
  labor_minutes: string | null; labor_rate_per_hour: string | null;
  explicit_cost: string | null; notes: string | null;
};

type Spec = {
  id: number; product_id: number; version: number; name: string;
  is_default: boolean; components: SpecComponent[]; operations: SpecOperation[];
};

type CostBreakdown = {
  material_cost: string; electricity_cost: string;
  labor_cost: string; other_cost: string;
  total: string; print_time_min: string; margin_pct: string | null;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const OP_ICONS: Record<string, string> = { print: "🖨", manual: "✋", postprocess: "🎨" };
const ORG = { electricityRate: 4.5, laborRate: 150, printerWatts: 200 };

function fmtMin(min: number) {
  const h = Math.floor(min / 60), m = min % 60;
  return h > 0 ? `${h}г ${m}хв` : `${m} хв`;
}
function fmt(v: string | number | null) {
  return v != null ? parseFloat(String(v)).toFixed(2) : "—";
}

function CostBar({ pct, cls }: { pct: number; cls: string }) {
  return (
    <div className="h-1.5 w-24 overflow-hidden rounded-full bg-[var(--surface-hi)] ">
      <div className={`h-full rounded-full ${cls}`} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

type Tab = "overview" | "specification" | "history";

export default function ProductDetailPage() {
  const { id }    = useParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>("specification");
  const [product,  setProduct]  = useState<Product | null>(null);
  const [spec,     setSpec]     = useState<Spec | null>(null);
  const [cost,     setCost]     = useState<CostBreakdown | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [costBusy, setCostBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, specs] = await Promise.all([
        api<Product>(`/api/warehouse/products/${id}`),
        api<Spec[]>(`/api/warehouse/products/${id}/specs`),
      ]);
      setProduct(p);
      const defaultSpec = specs.find((s) => s.is_default) ?? specs[0] ?? null;
      setSpec(defaultSpec);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function computeCost() {
    setCostBusy(true);
    try {
      const c = await api<CostBreakdown>(`/api/warehouse/products/${id}/cost`);
      setCost(c);
      // Refresh product to get updated cached costs
      const p = await api<Product>(`/api/warehouse/products/${id}`);
      setProduct(p);
    } finally { setCostBusy(false); }
  }

  if (loading) return <div className="text-sm text-[var(--text-muted)]">Завантаження…</div>;
  if (!product) return <div className="text-sm text-red-500">Товар не знайдено</div>;

  const TABS: { id: Tab; label: string }[] = [
    { id: "overview",       label: "Огляд" },
    { id: "specification",  label: "Специфікація" },
    { id: "history",        label: "Історія" },
  ];

  const salePrice  = product.sale_price  ? parseFloat(product.sale_price)  : null;
  const fullCost   = product.full_cost   ? parseFloat(product.full_cost)   : null;
  const printTotal = spec
    ? spec.operations
        .filter((op) => op.type === "print" && op.print_time_min)
        .reduce((s, op) => s + parseFloat(op.print_time_min!), 0)
    : 0;

  const margin = salePrice && fullCost && salePrice > 0
    ? ((salePrice - fullCost) / salePrice * 100)
    : null;

  const costData = cost ?? (product.full_cost ? {
    material_cost: product.direct_cost ?? "0",
    electricity_cost: "0", labor_cost: "0", other_cost: "0",
    total: product.full_cost, print_time_min: String(printTotal), margin_pct: null,
  } : null);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
        <Link href="/warehouse/products" className="hover:text-[var(--text)] ">Номенклатура</Link>
        <span>/</span>
        <span className="text-[var(--text-hi)] ">{product.name}</span>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">{product.name}</h2>
          <div className="mt-1 flex items-center gap-3 text-sm text-[var(--text-muted)]">
            <span className="font-mono">{product.sku}</span>
            {product.categories.map((c) => (
              <span key={c} className="rounded-full bg-[var(--surface-hi)] px-2 py-0.5 text-xs ">{c}</span>
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={computeCost} disabled={!spec || costBusy}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--surface-hi)] disabled:opacity-50  ">
            {costBusy ? "Рахую…" : "↻ Собівартість"}
          </button>
          <button className="rounded-md bg-[var(--surface)] px-3 py-1.5 text-sm text-white hover:bg-neutral-700  ">
            + Партія
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-0.5 border-b border-[var(--border)] ">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={["relative px-3 py-2 text-sm transition-colors",
              tab === t.id
                ? "text-[var(--text-hi)]  after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-cyan-500"
                : "text-[var(--text-muted)] hover:text-[var(--text)] ",
            ].join(" ")}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Overview */}
      {tab === "overview" && (
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            { label: "Собівартість/шт", value: fullCost ? `${fullCost.toFixed(2)} ₴` : "не розраховано" },
            { label: "Ціна продажу",    value: salePrice ? `${salePrice.toFixed(2)} ₴` : "—" },
            { label: "Маржа",           value: margin ? `${margin.toFixed(1)}%` : "—", highlight: (margin ?? 0) > 50 },
            { label: "Час друку",       value: printTotal > 0 ? fmtMin(printTotal) : "—" },
            { label: "Специфікацій",    value: spec ? "1" : "0" },
            { label: "Версія",          value: spec ? `v${spec.version} · ${spec.is_default ? "активна" : ""}` : "—" },
          ].map((k) => (
            <div key={k.label} className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4  ">
              <p className="text-xs text-[var(--text-muted)]">{k.label}</p>
              <p className={`mt-1 text-xl font-bold tabular-nums ${"highlight" in k && k.highlight ? "text-[var(--accent)] " : ""}`}>
                {k.value}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Specification */}
      {tab === "specification" && (
        !spec ? (
          <div className="rounded-xl border border-dashed border-[var(--border-strong)] px-4 py-12 text-center text-sm text-[var(--text-faint)] ">
            Специфікацію ще не додано. Натисни «+ Специфікацію».
          </div>
        ) : (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                v{spec.version} · {spec.name}
              </span>
              <button className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)]  ">
                + Нова версія
              </button>
            </div>

            <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
              <div className="space-y-5">
                {/* Materials */}
                <div>
                  <div className="mb-3 flex items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-widest text-[var(--text-faint)]">Матеріали</span>
                    <div className="flex-1 border-t border-[var(--border)] " />
                  </div>
                  <div className="overflow-hidden rounded-xl border border-[var(--border)] ">
                    <table className="w-full text-sm">
                      <thead className="bg-[var(--bg)] text-xs text-[var(--text-faint)] ">
                        <tr>
                          <th className="px-4 py-2.5 text-left font-medium">Матеріал</th>
                          <th className="px-4 py-2.5 text-right font-medium">К-сть</th>
                          <th className="px-4 py-2.5 text-right font-medium">Відходи</th>
                          <th className="px-4 py-2.5 text-right font-medium">Ціна/од.</th>
                          <th className="px-4 py-2.5 text-right font-medium">Вартість</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--border)] dark:divide-neutral-800">
                        {spec.components.length === 0 ? (
                          <tr><td colSpan={5} className="px-4 py-4 text-center text-xs text-[var(--text-faint)]">Немає компонентів</td></tr>
                        ) : (
                          spec.components.map((c) => {
                            const waste    = 1 + parseFloat(c.waste_pct) / 100;
                            const lineCost = c.unit_price ? parseFloat(c.quantity) * parseFloat(c.unit_price) * waste : null;
                            return (
                              <tr key={c.id}>
                                <td className="px-4 py-3"><span className="mr-1.5 text-[var(--text-faint)]">🧵</span>{c.name}</td>
                                <td className="px-4 py-3 text-right tabular-nums text-[var(--text-muted)]">{parseFloat(c.quantity).toFixed(2)} {c.unit}</td>
                                <td className="px-4 py-3 text-right tabular-nums text-[var(--text-faint)]">{parseFloat(c.waste_pct) > 0 ? `${c.waste_pct}%` : "—"}</td>
                                <td className="px-4 py-3 text-right tabular-nums text-[var(--text-faint)]">{c.unit_price ? `₴${fmt(c.unit_price)}` : "—"}</td>
                                <td className="px-4 py-3 text-right tabular-nums font-medium">{lineCost != null ? `₴${lineCost.toFixed(4)}` : "—"}</td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Operations */}
                <div>
                  <div className="mb-3 flex items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-widest text-[var(--text-faint)]">Операції</span>
                    <div className="flex-1 border-t border-[var(--border)] " />
                  </div>
                  <div className="space-y-2">
                    {spec.operations.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-[var(--border)] px-4 py-4 text-center text-xs text-[var(--text-faint)] ">
                        Немає операцій
                      </div>
                    ) : (
                      spec.operations.map((op) => {
                        const pMin = op.print_time_min ? parseFloat(op.print_time_min) : 0;
                        const kwh  = op.type === "print" ? ((op.power_watts ?? ORG.printerWatts) * pMin / 60) / 1000 : 0;
                        const elCost  = kwh * ORG.electricityRate;
                        const labRate = op.labor_rate_per_hour ? parseFloat(op.labor_rate_per_hour) : ORG.laborRate;
                        const labCost = op.labor_minutes ? (parseFloat(op.labor_minutes) / 60) * labRate : 0;
                        const opTotal = elCost + labCost + (op.explicit_cost ? parseFloat(op.explicit_cost) : 0);

                        return (
                          <div key={op.id} className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4  ">
                            <div className="mb-2 flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span className="text-[var(--text-faint)]">{op.sort_order + 1}.</span>
                                <span className="text-lg">{OP_ICONS[op.type] ?? "⚙"}</span>
                                <span className="font-medium">{op.name}</span>
                              </div>
                              <span className="text-sm font-semibold tabular-nums">₴{opTotal.toFixed(4)}</span>
                            </div>
                            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-[var(--text-muted)] sm:grid-cols-3">
                              {pMin > 0 && <span>⏱ {fmtMin(pMin)}</span>}
                              {op.type === "print" && kwh > 0 && (
                                <span>⚡ {kwh.toFixed(3)} кВт·год = <span className="text-[var(--text)] ">₴{elCost.toFixed(4)}</span></span>
                              )}
                              {op.labor_minutes && (
                                <span>👷 {op.labor_minutes} хв = <span className="text-[var(--text)] ">₴{labCost.toFixed(4)}</span></span>
                              )}
                              {op.explicit_cost && (
                                <span>🏷 ₴{fmt(op.explicit_cost)}</span>
                              )}
                              {op.notes && <span className="italic text-[var(--text-faint)]">{op.notes}</span>}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>

              {/* Cost sidebar */}
              <div>
                <div className="sticky top-6 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5  ">
                  <p className="mb-4 text-sm font-medium">Собівартість / шт</p>

                  {!costData ? (
                    <button onClick={computeCost} disabled={costBusy}
                      className="w-full rounded-md border border-[var(--border)] py-2 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)] disabled:opacity-50  ">
                      {costBusy ? "Рахую…" : "↻ Розрахувати"}
                    </button>
                  ) : (
                    <>
                      {[
                        { label: "Матеріали",     value: parseFloat(costData.material_cost),     cls: "bg-blue-500",    pct: 0 },
                        { label: "Електрика",     value: parseFloat(costData.electricity_cost),  cls: "bg-amber-400",   pct: 0 },
                        { label: "Трудовитрати",  value: parseFloat(costData.labor_cost),        cls: "bg-emerald-500", pct: 0 },
                        { label: "Постпроцесинг", value: parseFloat(costData.other_cost),        cls: "bg-violet-500",  pct: 0 },
                      ].map((row) => {
                        const total = parseFloat(costData.total);
                        const pct   = total > 0 ? (row.value / total) * 100 : 0;
                        return (
                          <div key={row.label} className="mb-3">
                            <div className="mb-1 flex justify-between text-xs">
                              <span className="text-[var(--text-muted)]">{row.label}</span>
                              <span className="tabular-nums font-medium text-[var(--text)] ">
                                ₴{row.value.toFixed(4)}
                                <span className="ml-1.5 text-[var(--text-faint)]">{pct.toFixed(0)}%</span>
                              </span>
                            </div>
                            <CostBar pct={pct} cls={row.cls} />
                          </div>
                        );
                      })}

                      <div className="mt-4 border-t border-[var(--border)] pt-4 ">
                        <div className="flex justify-between">
                          <span className="text-sm text-[var(--text-muted)]">Собівартість/шт</span>
                          <span className="text-base font-bold tabular-nums">₴{fmt(costData.total)}</span>
                        </div>
                        {salePrice && (
                          <>
                            <div className="mt-2 flex justify-between text-sm">
                              <span className="text-[var(--text-muted)]">Ціна продажу</span>
                              <span className="tabular-nums">₴{salePrice.toFixed(2)}</span>
                            </div>
                            {margin != null && (
                              <div className="mt-2 flex items-center justify-between">
                                <span className="text-sm text-[var(--text-muted)]">Маржа</span>
                                <span className={`text-sm font-semibold ${margin >= 50 ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>
                                  {margin.toFixed(1)}% {margin >= 50 ? "🟢" : "🟡"}
                                </span>
                              </div>
                            )}
                          </>
                        )}
                      </div>

                      {parseFloat(costData.print_time_min) > 0 && (
                        <div className="mt-3 border-t border-[var(--border)] pt-3 ">
                          <div className="flex justify-between text-sm">
                            <span className="text-[var(--text-muted)]">Час друку</span>
                            <span className="tabular-nums">{fmtMin(parseFloat(costData.print_time_min))}</span>
                          </div>
                        </div>
                      )}

                      <button onClick={computeCost} disabled={costBusy}
                        className="mt-4 w-full rounded-md border border-[var(--border)] py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)] disabled:opacity-50  ">
                        {costBusy ? "Рахую…" : "↻ Оновити"}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        )
      )}

      {tab === "history" && (
        <div className="rounded-xl border border-dashed border-[var(--border-strong)] px-4 py-12 text-center text-sm text-[var(--text-faint)] ">
          Тут буде зв'язок з print_history для цього товару
        </div>
      )}
    </div>
  );
}
