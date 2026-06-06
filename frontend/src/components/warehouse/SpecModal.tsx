"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

// ── local types ───────────────────────────────────────────────────────────────

type SpecComponent = {
  id: number; name: string; quantity: string; unit: string;
  unit_price: string | null; waste_pct: string; sort_order: number;
  material_id: number | null; product_id: number | null; product_name: string | null;
};
type SpecOperation = {
  id: number; type: string; name: string; sort_order: number;
  print_time_min: string | null; power_watts: number | null;
  labor_minutes: string | null; labor_rate_per_hour: string | null;
  explicit_cost: string | null; notes: string | null;
};
type Spec = {
  id: number; product_id: number; version: number; name: string;
  is_default: boolean; notes: string | null;
  components: SpecComponent[]; operations: SpecOperation[];
};
type CostBreakdown = {
  material_cost: string; electricity_cost: string;
  labor_cost: string; other_cost: string;
  total: string; print_time_min: string; margin_pct: string | null;
};

export type SpecModalProduct = {
  id: number; name: string; sku: string; sale_price?: string | null;
};

type CatalogItem = {
  id: number; name: string; sku: string; unit: string; cost_price: string | null;
};

// ── helpers ───────────────────────────────────────────────────────────────────

const OP_LABELS: Record<string, string> = {
  print: "Друк", manual: "Ручна", postprocess: "Постобробка",
};

function fmtMin(min: number) {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h > 0 ? `${h}г ${m}хв` : `${m} хв`;
}

// ── component ─────────────────────────────────────────────────────────────────

export function SpecModal({
  product,
  onClose,
}: {
  product: SpecModalProduct;
  onClose: () => void;
}) {
  const [spec,     setSpec]     = useState<Spec | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [cost,     setCost]     = useState<CostBreakdown | null>(null);
  const [costBusy, setCostBusy] = useState(false);

  // catalog for material autocomplete
  const [catalog,    setCatalog]    = useState<CatalogItem[]>([]);
  const [cSearch,    setCSearch]    = useState("");
  const [cDropOpen,  setCDropOpen]  = useState(false);

  // add component
  const [addComp, setAddComp] = useState(false);
  const [cName,   setCName]   = useState("");
  const [cQty,    setCQty]    = useState("");
  const [cUnit,   setCUnit]   = useState("г");
  const [cPrice,  setCPrice]  = useState("");
  const [cWaste,  setCWaste]  = useState("0");
  const [cProductId, setCProductId] = useState<number | null>(null);
  const [cBusy,   setCBusy]   = useState(false);

  // add operation
  const [addOp,   setAddOp]   = useState(false);
  const [oType,   setOType]   = useState<"print" | "manual" | "postprocess">("print");
  const [oName,   setOName]   = useState("Друк");
  const [oMin,    setOMin]    = useState("");
  const [oLabMin, setOLabMin] = useState("");
  const [oExp,    setOExp]    = useState("");
  const [oBusy,   setOBusy]   = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const specs = await api<Spec[]>(`/api/warehouse/products/${product.id}/specs`);
      const def   = specs.find((s) => s.is_default) ?? specs[0] ?? null;
      if (!def) {
        const created = await api<Spec>(`/api/warehouse/products/${product.id}/specs`, {
          method: "POST",
          body: JSON.stringify({ product_id: product.id, name: "Основна" }),
        });
        setSpec(created);
      } else {
        setSpec(def);
      }
    } finally { setLoading(false); }
  }, [product.id]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (addComp && catalog.length === 0) {
      api<CatalogItem[]>("/api/warehouse/products").then(setCatalog).catch(() => {});
    }
    if (!addComp) { setCSearch(""); setCDropOpen(false); }
  }, [addComp]); // eslint-disable-line react-hooks/exhaustive-deps

  function pickCatalog(item: CatalogItem) {
    setCName(item.name);
    setCProductId(item.id);
    setCUnit(item.unit || "г");
    setCPrice(item.cost_price ? parseFloat(item.cost_price).toFixed(4) : "");
    setCSearch(item.name);
    setCDropOpen(false);
  }

  async function computeCost() {
    setCostBusy(true);
    try {
      const c = await api<CostBreakdown>(`/api/warehouse/products/${product.id}/cost`);
      setCost(c);
    } finally { setCostBusy(false); }
  }

  async function deleteComponent(id: number) {
    if (!spec) return;
    await api(`/api/warehouse/specs/${spec.id}/components/${id}`, { method: "DELETE" });
    setSpec((s) => s ? { ...s, components: s.components.filter((c) => c.id !== id) } : s);
    setCost(null);
  }

  async function deleteOperation(id: number) {
    if (!spec) return;
    await api(`/api/warehouse/specs/${spec.id}/operations/${id}`, { method: "DELETE" });
    setSpec((s) => s ? { ...s, operations: s.operations.filter((o) => o.id !== id) } : s);
    setCost(null);
  }

  async function submitComponent(e: React.FormEvent) {
    e.preventDefault();
    if (!spec || !cName.trim() || !cQty) return;
    setCBusy(true);
    try {
      const updated = await api<Spec>(`/api/warehouse/specs/${spec.id}/components`, {
        method: "POST",
        body: JSON.stringify({
          name: cName.trim(), quantity: parseFloat(cQty),
          product_id: cProductId,
          unit: cUnit.trim() || "г",
          unit_price: cPrice ? parseFloat(cPrice) : null,
          waste_pct: parseFloat(cWaste) || 0,
          sort_order: spec.components.length,
        }),
      });
      setSpec(updated);
      setCName(""); setCProductId(null); setCQty(""); setCUnit("г"); setCPrice(""); setCWaste("0"); setCSearch("");
      setAddComp(false);
      setCost(null);
    } finally { setCBusy(false); }
  }

  async function submitOperation(e: React.FormEvent) {
    e.preventDefault();
    if (!spec || !oName.trim()) return;
    setOBusy(true);
    try {
      const updated = await api<Spec>(`/api/warehouse/specs/${spec.id}/operations`, {
        method: "POST",
        body: JSON.stringify({
          type: oType, name: oName.trim(),
          print_time_min: oType === "print" && oMin    ? parseFloat(oMin)    : null,
          labor_minutes:  oType !== "print" && oLabMin ? parseFloat(oLabMin) : null,
          explicit_cost:  oExp ? parseFloat(oExp) : null,
          sort_order: spec.operations.length,
        }),
      });
      setSpec(updated);
      setOName("Друк"); setOMin(""); setOLabMin(""); setOExp("");
      setAddOp(false);
      setCost(null);
    } finally { setOBusy(false); }
  }

  const totalCost = cost ? parseFloat(cost.total) : null;
  const salePrice = product.sale_price ? parseFloat(product.sale_price) : null;

  const catalogHits = cDropOpen && cSearch.trim().length > 0
    ? (() => {
        const q = cSearch.toLowerCase();
        return catalog.filter((c) => c.name.toLowerCase().includes(q) || c.sku.toLowerCase().includes(q)).slice(0, 8);
      })()
    : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-2xl">

        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-6 py-4">
          <div>
            <h2 className="font-semibold text-[var(--text)]">Специфікація</h2>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">{product.name} · <span className="font-mono">{product.sku}</span></p>
          </div>
          <button onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)]">
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="px-6 py-10 text-center text-sm text-[var(--text-faint)]">Завантаження…</div>
          ) : !spec ? null : (
            <div className="divide-y divide-[var(--border)]">

              {/* Materials */}
              <div className="px-6 py-5">
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-widest text-[var(--text-faint)]">Матеріали</p>
                  <button onClick={() => setAddComp((v) => !v)}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)]">
                    <span className="text-base leading-none">+</span> Додати
                  </button>
                </div>

                <div className="overflow-hidden rounded-xl border border-[var(--border)]">
                  <table className="w-full text-sm">
                    <thead className="bg-[var(--bg)] text-xs text-[var(--text-faint)]">
                      <tr>
                        <th className="px-4 py-2.5 text-left font-medium">Матеріал</th>
                        <th className="px-3 py-2.5 text-right font-medium">К-сть</th>
                        <th className="px-3 py-2.5 text-right font-medium">Од.</th>
                        <th className="px-3 py-2.5 text-right font-medium">Ціна/од.</th>
                        <th className="px-3 py-2.5 text-right font-medium">Відходи</th>
                        <th className="w-8 px-2 py-2.5" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border)]">
                      {spec.components.length === 0 && !addComp ? (
                        <tr>
                          <td colSpan={6} className="px-4 py-4 text-center text-xs text-[var(--text-faint)]">
                            Матеріалів ще немає — натисніть + Додати
                          </td>
                        </tr>
                      ) : (
                        spec.components.map((c) => (
                          <tr key={c.id} className="group">
                            <td className="px-4 py-2.5">
                              <div className="flex flex-col gap-1">
                                <span>{c.product_name ?? c.name}</span>
                                <span className="w-fit rounded bg-[var(--surface-hi)] px-1.5 py-0.5 text-[10px] text-[var(--text-faint)]">
                                  {c.product_id ? "номенклатура" : "кастомний компонент"}
                                </span>
                              </div>
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums">{parseFloat(c.quantity).toFixed(3)}</td>
                            <td className="px-3 py-2.5 text-right text-[var(--text-muted)]">{c.unit}</td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-[var(--text-muted)]">
                              {c.unit_price ? `₴${parseFloat(c.unit_price).toFixed(4)}` : "—"}
                            </td>
                            <td className="px-3 py-2.5 text-right text-[var(--text-faint)]">
                              {parseFloat(c.waste_pct) > 0 ? `${c.waste_pct}%` : "—"}
                            </td>
                            <td className="px-2 py-2.5">
                              <button onClick={() => deleteComponent(c.id)}
                                className="flex size-6 items-center justify-center rounded text-[var(--text-faint)] opacity-0 group-hover:opacity-100 hover:bg-[rgba(239,68,68,.08)] hover:text-[var(--state-error)] transition-opacity">
                                −
                              </button>
                            </td>
                          </tr>
                        ))
                      )}

                      {/* inline add row */}
                      {addComp && (
                        <tr className="bg-[var(--bg)]">
                          <td className="relative px-4 py-2">
                            <input
                              autoFocus
                              value={cSearch}
                              onChange={(e) => {
                                setCSearch(e.target.value);
                                setCName(e.target.value);
                                setCProductId(null);
                                setCDropOpen(true);
                              }}
                              onFocus={() => setCDropOpen(true)}
                              onBlur={() => setTimeout(() => setCDropOpen(false), 150)}
                              placeholder="Назва або SKU…"
                              className="w-full rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-sm outline-none focus:border-[var(--accent)]"
                            />
                            {catalogHits.length > 0 && (
                              <div className="absolute left-0 top-full z-30 mt-0.5 w-72 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elevated)] py-1 shadow-xl">
                                {catalogHits.map((item) => (
                                  <button
                                    key={item.id}
                                    type="button"
                                    onMouseDown={() => pickCatalog(item)}
                                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--surface-hi)]"
                                  >
                                    <span className="flex-1 truncate">{item.name}</span>
                                    <span className="shrink-0 font-mono text-[10px] text-[var(--text-faint)]">{item.sku}</span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <input type="number" step="0.001" min="0" value={cQty} onChange={(e) => setCQty(e.target.value)}
                              placeholder="0"
                              className="w-20 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-right text-sm outline-none focus:border-[var(--accent)]" />
                          </td>
                          <td className="px-3 py-2">
                            <input value={cUnit} onChange={(e) => setCUnit(e.target.value)}
                              className="w-12 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-sm outline-none focus:border-[var(--accent)]" />
                          </td>
                          <td className="px-3 py-2">
                            <input type="number" step="0.0001" min="0" value={cPrice} onChange={(e) => setCPrice(e.target.value)}
                              placeholder="—"
                              className="w-24 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-right text-sm outline-none focus:border-[var(--accent)]" />
                          </td>
                          <td className="px-3 py-2">
                            <input type="number" step="0.1" min="0" max="100" value={cWaste} onChange={(e) => setCWaste(e.target.value)}
                              className="w-16 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-right text-sm outline-none focus:border-[var(--accent)]" />
                          </td>
                          <td className="px-2 py-2">
                            <button onClick={submitComponent} disabled={cBusy || !cName.trim() || !cQty}
                              className="flex size-6 items-center justify-center rounded bg-[var(--state-ok)] text-white hover:opacity-90 disabled:opacity-40 text-sm">
                              ✓
                            </button>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Operations */}
              <div className="px-6 py-5">
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-widest text-[var(--text-faint)]">Операції</p>
                  <button onClick={() => setAddOp((v) => !v)}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)]">
                    <span className="text-base leading-none">+</span> Додати
                  </button>
                </div>

                <div className="space-y-2">
                  {spec.operations.length === 0 && !addOp && (
                    <p className="text-sm text-[var(--text-faint)]">Операцій ще немає — натисніть + Додати</p>
                  )}
                  {spec.operations.map((op) => (
                    <div key={op.id}
                      className="group flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3.5">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="rounded bg-[var(--surface-hi)] px-1.5 py-0.5 text-xs text-[var(--text-muted)]">
                            {OP_LABELS[op.type] ?? op.type}
                          </span>
                          <span className="font-medium text-sm">{op.name}</span>
                        </div>
                        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-[var(--text-faint)]">
                          {op.print_time_min && <span>⏱ {fmtMin(parseFloat(op.print_time_min))}</span>}
                          {op.labor_minutes  && <span>👷 {op.labor_minutes} хв</span>}
                          {op.explicit_cost  && <span>₴ {parseFloat(op.explicit_cost).toFixed(2)}</span>}
                          {op.notes          && <span className="italic">{op.notes}</span>}
                        </div>
                      </div>
                      <button onClick={() => deleteOperation(op.id)}
                        className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded text-[var(--text-faint)] opacity-0 group-hover:opacity-100 hover:bg-[rgba(239,68,68,.08)] hover:text-[var(--state-error)] transition-opacity">
                        −
                      </button>
                    </div>
                  ))}

                  {addOp && (
                    <form onSubmit={submitOperation}
                      className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-4 space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="mb-1 block text-xs text-[var(--text-muted)]">Тип</label>
                          <select value={oType} onChange={(e) => {
                            const t = e.target.value as typeof oType;
                            setOType(t); setOName(OP_LABELS[t] ?? "");
                          }} className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-sm">
                            <option value="print">Друк</option>
                            <option value="manual">Ручна</option>
                            <option value="postprocess">Постобробка</option>
                          </select>
                        </div>
                        <div>
                          <label className="mb-1 block text-xs text-[var(--text-muted)]">Назва</label>
                          <input required value={oName} onChange={(e) => setOName(e.target.value)}
                            className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--accent)]" />
                        </div>
                        {oType === "print" ? (
                          <div>
                            <label className="mb-1 block text-xs text-[var(--text-muted)]">Час друку (хв)</label>
                            <input type="number" step="0.1" min="0" value={oMin} onChange={(e) => setOMin(e.target.value)}
                              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--accent)]" />
                          </div>
                        ) : (
                          <div>
                            <label className="mb-1 block text-xs text-[var(--text-muted)]">Трудозатрати (хв)</label>
                            <input type="number" step="0.1" min="0" value={oLabMin} onChange={(e) => setOLabMin(e.target.value)}
                              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--accent)]" />
                          </div>
                        )}
                        <div>
                          <label className="mb-1 block text-xs text-[var(--text-muted)]">Дод. витрати ₴</label>
                          <input type="number" step="0.01" min="0" value={oExp} onChange={(e) => setOExp(e.target.value)}
                            className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--accent)]" />
                        </div>
                      </div>
                      <div className="flex justify-end gap-2">
                        <button type="button" onClick={() => setAddOp(false)} className="btn btn-ghost">Скасувати</button>
                        <button type="submit" disabled={oBusy || !oName.trim()} className="btn btn-primary disabled:opacity-50">
                          {oBusy ? "Зберігаю…" : "Додати"}
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              </div>

              {/* Cost */}
              <div className="px-6 py-5">
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-widest text-[var(--text-faint)]">Собівартість</p>
                  <button onClick={computeCost} disabled={costBusy}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)] disabled:opacity-50">
                    ↻ {costBusy ? "Рахую…" : "Розрахувати"}
                  </button>
                </div>
                {cost ? (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {([
                      ["Матеріали",   cost.material_cost],
                      ["Електрика",   cost.electricity_cost],
                      ["Праця",       cost.labor_cost],
                      ["Інше",        cost.other_cost],
                    ] as [string, string][]).map(([label, value]) => (
                      <div key={label} className="rounded-lg border border-[var(--border)] p-3">
                        <p className="text-xs text-[var(--text-faint)]">{label}</p>
                        <p className="mt-0.5 font-mono text-sm font-medium tabular-nums">{parseFloat(value).toFixed(2)} ₴</p>
                      </div>
                    ))}
                    <div className="col-span-2 sm:col-span-4 flex items-center justify-between rounded-lg bg-[var(--accent)] px-4 py-3 text-white">
                      <span className="text-sm font-medium">Загалом / шт</span>
                      <span className="font-mono text-lg font-bold tabular-nums">
                        {totalCost?.toFixed(2)} ₴
                        {salePrice && totalCost && (
                          <span className="ml-3 text-sm font-normal opacity-80">
                            маржа {(((salePrice - totalCost) / salePrice) * 100).toFixed(0)}%
                          </span>
                        )}
                      </span>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-[var(--text-faint)]">Натисніть «↻ Розрахувати» щоб побачити розбивку</p>
                )}
              </div>

            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border)] px-6 py-4">
          {spec && !cost && (
            <button onClick={computeCost} disabled={costBusy}
              className="btn btn-ghost disabled:opacity-50">
              {costBusy ? "Рахую…" : "↻ Розрахувати собівартість"}
            </button>
          )}
          <button onClick={onClose} className="btn btn-primary">Закрити</button>
        </div>
      </div>
    </div>
  );
}
