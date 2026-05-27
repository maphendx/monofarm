"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_URL, api, getToken } from "@/lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

type Product = {
  id: number; name: string; sku: string; categories: string[];
  unit: string; description: string | null; is_active: boolean;
  sale_price: string | null; cost_price: string | null;
  direct_cost: string | null; full_cost: string | null;
};

type StockEntry = { product_id: number; available: string };
type ProductCat = { id: number; name: string; color: string | null };

type Spec = {
  id: number; product_id: number; version: number; name: string; is_default: boolean;
  notes: string | null;
  components: SpecComponent[];
  operations: SpecOperation[];
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
type CostBreakdown = {
  material_cost: string; electricity_cost: string;
  labor_cost: string; other_cost: string;
  total: string; print_time_min: string; margin_pct: string | null;
};

type SortKey = "name" | "sku" | "stock" | "full_cost" | "sale_price" | "margin";
type SortDir = "asc" | "desc";

type PreviewItem  = { name: string; sku: string; unit?: string; sale_price?: string; cost_price?: string };
type ExistingItem = { id: number; name: string; sku: string; changes: Record<string, { from: string; to: string }> };
type MissingItem  = { id: number; name: string; sku: string };
type ImportPreview = { new: PreviewItem[]; existing: ExistingItem[]; missing: MissingItem[] };
type ActionNew      = "import" | "skip";
type ActionExisting = "update"  | "skip";
type ActionMissing  = "nothing" | "hide";
const PAGE_SIZES = [25, 50, 100] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPrice(v: string | null) {
  if (!v || parseFloat(v) === 0) return "—";
  return `${parseFloat(v).toFixed(2)} ₴`;
}
function calcMargin(sale: string | null, cost: string | null): number | null {
  if (!sale || !cost || parseFloat(sale) === 0) return null;
  return ((parseFloat(sale) - parseFloat(cost)) / parseFloat(sale)) * 100;
}
function fmtMin(min: number) {
  const h = Math.floor(min / 60), m = min % 60;
  return h > 0 ? `${h}г ${m}хв` : `${m}хв`;
}

// ── FormRow — label-left / input-right like Ordg ───────────────────────────────

function FormRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4">
      <span className="w-36 shrink-0 pt-2 text-right text-sm text-[var(--text-muted)] ">
        {label}
      </span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

const INPUT = "w-full rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-sm outline-none focus:border-[var(--border-strong)]   ";
const SEC   = "flex flex-col gap-3.5 px-6 py-4";
const HR    = "border-[var(--border)] ";

// ── CategoryInput ─────────────────────────────────────────────────────────────

function CategoryInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [input, setInput] = useState("");

  function add(raw: string) {
    const tag = raw.trim();
    if (tag && !value.includes(tag)) onChange([...value, tag]);
    setInput("");
  }
  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(input); }
    if (e.key === "Backspace" && !input && value.length) onChange(value.slice(0, -1));
  }

  return (
    <div className="flex min-h-[38px] flex-wrap items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-1.5 focus-within:border-[var(--border-strong)]  ">
      {value.map((t) => (
        <span key={t} className="flex items-center gap-1 rounded bg-[var(--surface-hi)] px-2 py-0.5 text-xs ">
          {t}
          <button type="button" onClick={() => onChange(value.filter((x) => x !== t))}
            className="text-[var(--text-faint)] hover:text-[var(--text)] ">×</button>
        </span>
      ))}
      <input
        value={input} onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKey} onBlur={() => add(input)}
        placeholder={value.length === 0 ? "Категорія, Enter щоб додати…" : ""}
        className="flex-1 min-w-24 bg-transparent text-sm outline-none placeholder:text-[var(--text-faint)]"
      />
    </div>
  );
}

// ── ProductModal ──────────────────────────────────────────────────────────────

function ProductModal({
  product, onClose, onSaved,
}: {
  product: Product | null;  // null = create mode
  onClose: () => void;
  onSaved: (p: Product) => void;
}) {
  const isEdit = product !== null;

  const [name,  setName]  = useState(product?.name  ?? "");
  const [sku,   setSku]   = useState(product?.sku   ?? "");
  const [cats,  setCats]  = useState<string[]>(product?.categories ?? []);
  const [unit,  setUnit]  = useState(product?.unit  ?? "шт");
  const [price, setPrice] = useState(product?.sale_price ? parseFloat(product.sale_price).toString() : "");
  const [desc,  setDesc]  = useState(product?.description ?? "");
  const [busy,  setBusy]  = useState(false);
  const [err,   setErr]   = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const body = {
        name: name.trim(), sku: sku.trim(), categories: cats,
        unit: unit.trim() || "шт",
        sale_price: price ? parseFloat(price) : null,
        description: desc.trim() || null,
      };
      const p = isEdit
        ? await api<Product>(`/api/warehouse/products/${product!.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : await api<Product>("/api/warehouse/products", { method: "POST", body: JSON.stringify(body) });
      onSaved(p);
      onClose();
    } catch {
      setErr("Помилка збереження. Перевірте поля.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-2xl  ">

        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-6 py-4 ">
          <h2 className="font-semibold text-[var(--text-hi)] ">
            {isEdit ? "Редагувати номенклатуру" : "Нова номенклатура"}
          </h2>
          <button onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)] ">
            ×
          </button>
        </div>

        {/* Body */}
        <form id="product-form" onSubmit={save} className="flex-1 overflow-y-auto">

          {/* Section 1: identification */}
          <div className={SEC}>
            <FormRow label="Назва">
              <input required autoFocus value={name} onChange={(e) => setName(e.target.value)}
                className={INPUT} />
            </FormRow>
            <FormRow label="SKU">
              <input required value={sku} onChange={(e) => setSku(e.target.value)}
                className={INPUT} />
            </FormRow>
            <FormRow label="Категорії">
              <CategoryInput value={cats} onChange={setCats} />
            </FormRow>
          </div>

          <hr className={HR} />

          {/* Section 2: pricing */}
          <div className={SEC}>
            <FormRow label="Ціна роздрібна">
              <div className="relative">
                <input type="number" step="0.01" min="0" value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  className={`${INPUT} pr-6`} />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-[var(--text-faint)]">₴</span>
              </div>
            </FormRow>
            {isEdit && product!.full_cost && (
              <FormRow label="Собівартість">
                <div className="flex items-center gap-2 py-2 text-sm text-[var(--text-muted)]">
                  <span className="tabular-nums">{parseFloat(product!.full_cost).toFixed(2)} ₴</span>
                  <span className="text-xs text-[var(--text-faint)]">(розраховується зі специфікації)</span>
                </div>
              </FormRow>
            )}
          </div>

          <hr className={HR} />

          {/* Section 3: unit */}
          <div className={SEC}>
            <FormRow label="Одиниця">
              <select value={unit} onChange={(e) => setUnit(e.target.value)}
                className={`${INPUT} cursor-pointer`}>
                {["шт", "г", "кг", "м", "см", "мм", "л", "мл", "пара"].map((u) => (
                  <option key={u} value={u}>{u}</option>
                ))}
                {!["шт","г","кг","м","см","мм","л","мл","пара"].includes(unit) && (
                  <option value={unit}>{unit}</option>
                )}
              </select>
            </FormRow>
          </div>

          <hr className={HR} />

          {/* Section 4: description */}
          <div className={SEC}>
            <FormRow label="Опис">
              <textarea rows={3} value={desc} onChange={(e) => setDesc(e.target.value)}
                className={`${INPUT} resize-none`} />
            </FormRow>
          </div>

          {err && <p className="px-6 pb-4 text-sm text-[var(--state-error)]">{err}</p>}
        </form>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border)] px-6 py-4 ">
          <button type="button" onClick={onClose} disabled={busy}
            className="btn btn-ghost">
            Скасувати
          </button>
          <button type="submit" form="product-form" disabled={busy || !name.trim() || !sku.trim()}
            className="btn btn-primary disabled:opacity-50">
            {busy ? "Зберігаю…" : isEdit ? "Змінити" : "Додати"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── SpecModal ─────────────────────────────────────────────────────────────────

const OP_TYPE_LABELS: Record<string, string> = { print: "Друк", manual: "Ручна", postprocess: "Постобробка" };

function SpecModal({ product, onClose }: { product: Product; onClose: () => void }) {
  const [spec,     setSpec]     = useState<Spec | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [cost,     setCost]     = useState<CostBreakdown | null>(null);
  const [costBusy, setCostBusy] = useState(false);

  // Add component form state
  const [addComp, setAddComp] = useState(false);
  const [cName,   setCName]   = useState("");
  const [cQty,    setCQty]    = useState("");
  const [cUnit,   setCUnit]   = useState("г");
  const [cPrice,  setCPrice]  = useState("");
  const [cWaste,  setCWaste]  = useState("0");
  const [cBusy,   setCBusy]   = useState(false);

  // Add operation form state
  const [addOp,   setAddOp]   = useState(false);
  const [oType,   setOType]   = useState<"print"|"manual"|"postprocess">("print");
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
        // Auto-create default spec
        const created = await api<Spec>(`/api/warehouse/products/${product.id}/specs`, {
          method: "POST",
          body: JSON.stringify({ product_id: product.id, name: "Основна" }),
        });
        setSpec(created);
      } else {
        setSpec(def);
      }
    } finally {
      setLoading(false);
    }
  }, [product.id]);

  useEffect(() => { load(); }, [load]);

  async function computeCost() {
    if (!spec) return;
    setCostBusy(true);
    try {
      const c = await api<CostBreakdown>(`/api/warehouse/products/${product.id}/cost`);
      setCost(c);
    } finally { setCostBusy(false); }
  }

  async function deleteComponent(compId: number) {
    if (!spec) return;
    await api(`/api/warehouse/specs/${spec.id}/components/${compId}`, { method: "DELETE" });
    setSpec((s) => s ? { ...s, components: s.components.filter((c) => c.id !== compId) } : s);
    setCost(null);
  }

  async function deleteOperation(opId: number) {
    if (!spec) return;
    await api(`/api/warehouse/specs/${spec.id}/operations/${opId}`, { method: "DELETE" });
    setSpec((s) => s ? { ...s, operations: s.operations.filter((o) => o.id !== opId) } : s);
    setCost(null);
  }

  async function submitComponent(e: React.FormEvent) {
    e.preventDefault();
    if (!spec) return;
    setCBusy(true);
    try {
      const updated = await api<Spec>(`/api/warehouse/specs/${spec.id}/components`, {
        method: "POST",
        body: JSON.stringify({
          name: cName.trim(), quantity: parseFloat(cQty), unit: cUnit.trim() || "г",
          unit_price: cPrice ? parseFloat(cPrice) : null,
          waste_pct: parseFloat(cWaste) || 0, sort_order: spec.components.length,
        }),
      });
      setSpec(updated);
      setCName(""); setCQty(""); setCUnit("г"); setCPrice(""); setCWaste("0");
      setAddComp(false);
      setCost(null);
    } finally { setCBusy(false); }
  }

  async function submitOperation(e: React.FormEvent) {
    e.preventDefault();
    if (!spec) return;
    setOBusy(true);
    try {
      const updated = await api<Spec>(`/api/warehouse/specs/${spec.id}/operations`, {
        method: "POST",
        body: JSON.stringify({
          type: oType, name: oName.trim(),
          print_time_min: oType === "print" && oMin  ? parseFloat(oMin)    : null,
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-2xl  ">

        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-6 py-4 ">
          <div>
            <h2 className="font-semibold text-[var(--text-hi)] ">Специфікація</h2>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">{product.name} · {product.sku}</p>
          </div>
          <button onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)] ">
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="px-6 py-10 text-center text-sm text-[var(--text-faint)]">Завантаження…</div>
          ) : !spec ? null : (
            <div className="space-y-0 divide-y divide-[var(--border)]">

              {/* ── Materials ── */}
              <div className="px-6 py-5">
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-widest text-[var(--text-faint)]">Матеріали</p>
                  <button onClick={() => setAddComp((v) => !v)}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)] ">
                    <span className="text-base leading-none">+</span> Додати
                  </button>
                </div>

                {spec.components.length === 0 && !addComp ? (
                  <p className="text-sm text-[var(--text-faint)]">Матеріалів ще немає</p>
                ) : (
                  <div className="overflow-hidden rounded-xl border border-[var(--border)] ">
                    <table className="w-full text-sm">
                      <thead className="bg-[var(--bg)] text-xs text-[var(--text-faint)] ">
                        <tr>
                          <th className="px-4 py-2.5 text-left font-medium">Матеріал</th>
                          <th className="px-3 py-2.5 text-right font-medium">К-сть</th>
                          <th className="px-3 py-2.5 text-right font-medium">Од.</th>
                          <th className="px-3 py-2.5 text-right font-medium">Ціна/од. ₴</th>
                          <th className="px-3 py-2.5 text-right font-medium">Відходи %</th>
                          <th className="w-8 px-2 py-2.5" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--border)]">
                        {spec.components.map((c) => (
                          <tr key={c.id} className="group">
                            <td className="px-4 py-2.5">{c.name}</td>
                            <td className="px-3 py-2.5 text-right tabular-nums">{parseFloat(c.quantity).toFixed(3)}</td>
                            <td className="px-3 py-2.5 text-right text-[var(--text-muted)]">{c.unit}</td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-[var(--text-muted)]">{c.unit_price ? parseFloat(c.unit_price).toFixed(4) : "—"}</td>
                            <td className="px-3 py-2.5 text-right text-[var(--text-faint)]">{parseFloat(c.waste_pct) > 0 ? `${c.waste_pct}%` : "—"}</td>
                            <td className="px-2 py-2.5">
                              <button onClick={() => deleteComponent(c.id)}
                                className="opacity-0 group-hover:opacity-100 flex size-6 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[rgba(239,68,68,.08)] hover:text-[var(--state-error)]  transition-opacity">
                                −
                              </button>
                            </td>
                          </tr>
                        ))}

                        {/* Add component form row */}
                        {addComp && (
                          <tr className="bg-[var(--bg)] ">
                            <td className="px-4 py-2">
                              <input autoFocus value={cName} onChange={(e) => setCName(e.target.value)}
                                placeholder="Назва матеріалу"
                                className="w-full rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-sm outline-none focus:border-[var(--border-strong)]  " />
                            </td>
                            <td className="px-3 py-2">
                              <input type="number" step="0.001" min="0" value={cQty} onChange={(e) => setCQty(e.target.value)}
                                placeholder="0"
                                className="w-20 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-right text-sm outline-none focus:border-[var(--border-strong)]  " />
                            </td>
                            <td className="px-3 py-2">
                              <input value={cUnit} onChange={(e) => setCUnit(e.target.value)}
                                className="w-12 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-sm outline-none focus:border-[var(--border-strong)]  " />
                            </td>
                            <td className="px-3 py-2">
                              <input type="number" step="0.0001" min="0" value={cPrice} onChange={(e) => setCPrice(e.target.value)}
                                placeholder="—"
                                className="w-24 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-right text-sm outline-none focus:border-[var(--border-strong)]  " />
                            </td>
                            <td className="px-3 py-2">
                              <input type="number" step="0.1" min="0" max="100" value={cWaste} onChange={(e) => setCWaste(e.target.value)}
                                className="w-16 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-right text-sm outline-none focus:border-[var(--border-strong)]  " />
                            </td>
                            <td className="px-2 py-2">
                              <form onSubmit={submitComponent} className="flex gap-1">
                                <button type="submit" disabled={cBusy || !cName.trim() || !cQty}
                                  className="flex size-6 items-center justify-center rounded bg-[rgba(34,197,94,.08)]0 text-white hover:bg-[var(--state-ok)] disabled:opacity-40 text-sm">
                                  ✓
                                </button>
                              </form>
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* ── Operations ── */}
              <div className="px-6 py-5">
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-widest text-[var(--text-faint)]">Операції</p>
                  <button onClick={() => setAddOp((v) => !v)}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)] ">
                    <span className="text-base leading-none">+</span> Додати
                  </button>
                </div>

                <div className="space-y-2">
                  {spec.operations.map((op) => (
                    <div key={op.id}
                      className="group flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-3.5  ">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="rounded bg-[var(--surface-hi)] px-1.5 py-0.5 text-xs text-[var(--text-muted)] ">
                            {OP_TYPE_LABELS[op.type] ?? op.type}
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
                        className="opacity-0 group-hover:opacity-100 mt-0.5 flex size-6 shrink-0 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[rgba(239,68,68,.08)] hover:text-[var(--state-error)]  transition-opacity">
                        −
                      </button>
                    </div>
                  ))}

                  {spec.operations.length === 0 && !addOp && (
                    <p className="text-sm text-[var(--text-faint)]">Операцій ще немає</p>
                  )}

                  {/* Add operation form */}
                  {addOp && (
                    <form onSubmit={submitOperation}
                      className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-4 space-y-3  ">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="mb-1 block text-xs text-[var(--text-muted)]">Тип</label>
                          <select value={oType} onChange={(e) => {
                            const t = e.target.value as typeof oType;
                            setOType(t);
                            setOName(OP_TYPE_LABELS[t] ?? "");
                          }} className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-sm  ">
                            <option value="print">Друк</option>
                            <option value="manual">Ручна</option>
                            <option value="postprocess">Постобробка</option>
                          </select>
                        </div>
                        <div>
                          <label className="mb-1 block text-xs text-[var(--text-muted)]">Назва</label>
                          <input required value={oName} onChange={(e) => setOName(e.target.value)}
                            className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--border-strong)]  " />
                        </div>
                        {oType === "print" ? (
                          <div>
                            <label className="mb-1 block text-xs text-[var(--text-muted)]">Час друку (хв)</label>
                            <input type="number" step="0.1" min="0" value={oMin} onChange={(e) => setOMin(e.target.value)}
                              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--border-strong)]  " />
                          </div>
                        ) : (
                          <div>
                            <label className="mb-1 block text-xs text-[var(--text-muted)]">Трудозатрати (хв)</label>
                            <input type="number" step="0.1" min="0" value={oLabMin} onChange={(e) => setOLabMin(e.target.value)}
                              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--border-strong)]  " />
                          </div>
                        )}
                        <div>
                          <label className="mb-1 block text-xs text-[var(--text-muted)]">Додаткові витрати ₴</label>
                          <input type="number" step="0.01" min="0" value={oExp} onChange={(e) => setOExp(e.target.value)}
                            className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--border-strong)]  " />
                        </div>
                      </div>
                      <div className="flex justify-end gap-2">
                        <button type="button" onClick={() => setAddOp(false)}
                          className="btn btn-ghost">
                          Скасувати
                        </button>
                        <button type="submit" disabled={oBusy || !oName.trim()}
                          className="btn btn-primary disabled:opacity-50">
                          {oBusy ? "Зберігаю…" : "Додати"}
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              </div>

              {/* ── Cost ── */}
              <div className="px-6 py-5">
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-widest text-[var(--text-faint)]">Собівартість</p>
                  <button onClick={computeCost} disabled={costBusy}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)] disabled:opacity-50 ">
                    ↻ {costBusy ? "Рахую…" : "Розрахувати"}
                  </button>
                </div>

                {cost ? (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {[
                      { label: "Матеріали",    value: cost.material_cost },
                      { label: "Електрика",    value: cost.electricity_cost },
                      { label: "Праця",        value: cost.labor_cost },
                      { label: "Інше",         value: cost.other_cost },
                    ].map((row) => (
                      <div key={row.label} className="rounded-lg border border-[var(--border)] p-3 ">
                        <p className="text-xs text-[var(--text-faint)]">{row.label}</p>
                        <p className="mt-0.5 font-mono text-sm font-medium tabular-nums">
                          {parseFloat(row.value).toFixed(2)} ₴
                        </p>
                      </div>
                    ))}
                    <div className="col-span-2 sm:col-span-4 flex items-center justify-between rounded-lg border border-[var(--border-strong)] bg-[var(--accent)] px-4 py-3 text-white   ">
                      <span className="text-sm font-medium">Загалом / шт</span>
                      <span className="font-mono text-lg font-bold tabular-nums">
                        {totalCost?.toFixed(2)} ₴
                        {product.sale_price && totalCost && (
                          <span className="ml-3 text-sm font-normal opacity-70">
                            маржа {(((parseFloat(product.sale_price) - totalCost) / parseFloat(product.sale_price)) * 100).toFixed(0)}%
                          </span>
                        )}
                      </span>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-[var(--text-faint)]">
                    Натисни «↻ Розрахувати» щоб побачити розбивку собівартості
                  </p>
                )}
              </div>

            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-end border-t border-[var(--border)] px-6 py-4 ">
          <button onClick={onClose}
            className="btn btn-primary">
            Закрити
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Sort helpers ──────────────────────────────────────────────────────────────

function SortIndicator({ col, sortKey, sortDir }: { col: SortKey; sortKey: SortKey; sortDir: SortDir }) {
  if (col !== sortKey) return <span className="ml-1 text-[var(--text-muted)] ">↕</span>;
  return <span className="ml-1 text-[var(--accent)]">{sortDir === "asc" ? "↑" : "↓"}</span>;
}

function Th({ col, sortKey, sortDir, onSort, children, className = "" }: {
  col: SortKey; sortKey: SortKey; sortDir: SortDir;
  onSort: (c: SortKey) => void; children: React.ReactNode; className?: string;
}) {
  return (
    <th onClick={() => onSort(col)}
      className={`cursor-pointer select-none px-4 py-3 font-medium hover:text-[var(--text)]  ${className}`}>
      {children}<SortIndicator col={col} sortKey={sortKey} sortDir={sortDir} />
    </th>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

// ── Import preview helpers ────────────────────────────────────────────────────

const FIELD_LABEL: Record<string, string> = {
  name: "Назва", unit: "Одиниця", sale_price: "Роздрібна ціна",
  cost_price: "Сер. ціна", direct_cost: "Собівартість",
  description: "Опис", categories: "Категорії",
};

function ActionToggle<T extends string>({
  options, value, onChange,
}: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-1 shrink-0">
      {options.map((o) => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)}
          className={["rounded-md px-3 py-1 text-sm font-medium transition-colors",
            value === o.value
              ? "bg-[var(--accent)] text-white"
              : "bg-[var(--surface-hi)] text-[var(--text-muted)] hover:text-[var(--text)]",
          ].join(" ")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function PreviewSection<T extends string>({
  title, subtitle, count, options, action, onAction, children,
}: {
  title: string; subtitle: string; count: number;
  options: { value: T; label: string }[];
  action: T; onAction: (v: T) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)]">
      <div className="flex flex-wrap items-start justify-between gap-3 bg-[var(--bg-elevated)] px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{title}</span>
            <span className="rounded-full bg-[var(--surface-hi)] px-1.5 py-0.5 font-mono text-xs text-[var(--text-muted)]">{count}</span>
          </div>
          <div className="mt-0.5 text-xs text-[var(--text-faint)]">{subtitle}</div>
        </div>
        <ActionToggle options={options} value={action} onChange={onAction} />
      </div>
      {count > 0 && (
        <details className="group">
          <summary className="flex cursor-pointer select-none list-none items-center gap-1.5 border-t border-[var(--border)] px-4 py-2 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)]">
            <svg className="size-3.5 transition-transform group-open:rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
            Показати список
          </summary>
          <div className="max-h-52 overflow-y-auto border-t border-[var(--border)]">{children}</div>
        </details>
      )}
    </div>
  );
}

function ImportPreviewModal({
  preview,
  actionNew, setActionNew,
  actionExisting, setActionExisting,
  actionMissing, setActionMissing,
  onConfirm, onClose, busy,
}: {
  preview: ImportPreview;
  actionNew: ActionNew; setActionNew: (v: ActionNew) => void;
  actionExisting: ActionExisting; setActionExisting: (v: ActionExisting) => void;
  actionMissing: ActionMissing; setActionMissing: (v: ActionMissing) => void;
  onConfirm: () => void; onClose: () => void; busy: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-6 py-4">
          <h2 className="font-semibold">Операції з товарами</h2>
          <button onClick={onClose} className="flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)]">×</button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-6 py-4">
          <PreviewSection
            title="Нові товари" subtitle="Товари з файлу, яких поки що немає на сайті"
            count={preview.new.length}
            options={[{ value: "import", label: "Імпортувати" }, { value: "skip", label: "Не імпортувати" }]}
            action={actionNew} onAction={setActionNew}
          >
            {preview.new.map((item, i) => (
              <div key={i} className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-2 text-sm last:border-0">
                <span className="w-20 shrink-0 truncate font-mono text-xs text-[var(--text-faint)]">{item.sku || "—"}</span>
                <span className="flex-1 truncate">{item.name}</span>
                {item.sale_price && <span className="shrink-0 text-xs text-[var(--text-muted)]">{parseFloat(item.sale_price).toFixed(2)} ₴</span>}
              </div>
            ))}
          </PreviewSection>

          <PreviewSection
            title="Існуючі товари" subtitle="Товари з файлу, які вже є на сайті"
            count={preview.existing.length}
            options={[{ value: "update", label: "Оновити" }, { value: "skip", label: "Не оновлювати" }]}
            action={actionExisting} onAction={setActionExisting}
          >
            {preview.existing.map((item) => (
              <div key={item.id} className="border-b border-[var(--border)] px-4 py-2 last:border-0">
                <div className="flex items-center gap-3 text-sm">
                  <span className="w-20 shrink-0 truncate font-mono text-xs text-[var(--text-faint)]">{item.sku}</span>
                  <span className="flex-1 truncate">{item.name}</span>
                  {Object.keys(item.changes).length > 0 && (
                    <span className="shrink-0 text-xs text-[var(--state-warn)]">{Object.keys(item.changes).length} змін</span>
                  )}
                </div>
                {Object.entries(item.changes).map(([field, { from, to }]) => (
                  <div key={field} className="mt-1 flex items-center gap-1.5 pl-24 text-xs text-[var(--text-faint)]">
                    <span className="text-[var(--text-muted)]">{FIELD_LABEL[field] ?? field}:</span>
                    <span className="line-through opacity-60">{from || "—"}</span>
                    <span>→</span>
                    <span className="text-[var(--text)]">{to}</span>
                  </div>
                ))}
              </div>
            ))}
          </PreviewSection>

          <PreviewSection
            title="Відсутні товари" subtitle="Товари на сайті, але відсутні у файлі"
            count={preview.missing.length}
            options={[{ value: "nothing", label: "Нічого не робити" }, { value: "hide", label: "Сховати товари" }]}
            action={actionMissing} onAction={setActionMissing}
          >
            {preview.missing.map((item) => (
              <div key={item.id} className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-2 text-sm last:border-0">
                <span className="w-20 shrink-0 truncate font-mono text-xs text-[var(--text-faint)]">{item.sku || "—"}</span>
                <span className="flex-1 truncate">{item.name}</span>
              </div>
            ))}
          </PreviewSection>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border)] px-6 py-4">
          <button onClick={onClose} className="btn btn-ghost">Скасувати</button>
          <button onClick={onConfirm} disabled={busy} className="btn btn-primary disabled:opacity-50">
            {busy ? "Імпортуємо…" : "Підтвердити імпорт"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ProductsPage() {
  const [products,   setProducts]   = useState<Product[]>([]);
  const [stock,      setStock]      = useState<StockEntry[]>([]);
  const [cats,       setCats]       = useState<ProductCat[]>([]);
  const [loading,    setLoading]    = useState(true);

  const [search,   setSearch]   = useState("");
  const [category, setCategory] = useState("Всі");
  const [sortKey,  setSortKey]  = useState<SortKey>("name");
  const [sortDir,  setSortDir]  = useState<SortDir>("asc");
  const [pageSize, setPageSize] = useState<number>(25);
  const [page,     setPage]     = useState(1);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState(false);

  // Modal state
  const [editProduct,  setEditProduct]  = useState<Product | null | "create">(null);
  const [specProduct,  setSpecProduct]  = useState<Product | null>(null);
  const [importResult, setImportResult] = useState<{ created: number; updated: number; skipped: number; hidden: number; new_categories: number } | null>(null);
  const [importing,    setImporting]    = useState(false);
  const [importPreview,  setImportPreview]  = useState<ImportPreview | null>(null);
  const [importFile,     setImportFile]     = useState<File | null>(null);
  const [actionNew,      setActionNew]      = useState<ActionNew>("import");
  const [actionExisting, setActionExisting] = useState<ActionExisting>("update");
  const [actionMissing,  setActionMissing]  = useState<ActionMissing>("nothing");
  const importRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [prods, stk, cs] = await Promise.all([
        api<Product[]>("/api/warehouse/products"),
        api<StockEntry[]>("/api/warehouse/stock"),
        api<ProductCat[]>("/api/warehouse/categories"),
      ]);
      setProducts(prods);
      setStock(stk);
      setCats(cs);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const stockByProduct = useMemo(() => {
    const map = new Map<number, number>();
    for (const s of stock) map.set(s.product_id, (map.get(s.product_id) ?? 0) + parseFloat(s.available));
    return map;
  }, [stock]);

  // Merge: API categories + any ad-hoc tags from products not yet in registry
  const allCategories = useMemo(() => {
    const fromApi  = cats.map((c) => c.name);
    const fromProds = Array.from(new Set(products.flatMap((p) => p.categories)));
    const extra = fromProds.filter((n) => !fromApi.includes(n));
    return ["Всі", ...fromApi, ...extra.sort()];
  }, [cats, products]);

  const catColorMap = useMemo(() => {
    const m = new Map<string, string | null>();
    cats.forEach((c) => m.set(c.name, c.color));
    return m;
  }, [cats]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return products.filter((p) => {
      if (category !== "Всі" && !p.categories.includes(category)) return false;
      if (q && !p.name.toLowerCase().includes(q) && !p.sku.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [products, search, category]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      switch (sortKey) {
        case "name":      return sortDir === "asc" ? a.name.localeCompare(b.name, "uk") : b.name.localeCompare(a.name, "uk");
        case "sku":       return sortDir === "asc" ? a.sku.localeCompare(b.sku) : b.sku.localeCompare(a.sku);
        default: {
          let av = 0, bv = 0;
          if (sortKey === "stock")      { av = stockByProduct.get(a.id) ?? 0; bv = stockByProduct.get(b.id) ?? 0; }
          if (sortKey === "full_cost")  { av = parseFloat(a.full_cost  ?? "0"); bv = parseFloat(b.full_cost  ?? "0"); }
          if (sortKey === "sale_price") { av = parseFloat(a.sale_price ?? "0"); bv = parseFloat(b.sale_price ?? "0"); }
          if (sortKey === "margin")     {
            av = calcMargin(a.sale_price, a.full_cost) ?? -Infinity;
            bv = calcMargin(b.sale_price, b.full_cost) ?? -Infinity;
          }
          return sortDir === "asc" ? av - bv : bv - av;
        }
      }
    });
    return arr;
  }, [filtered, sortKey, sortDir, stockByProduct]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const paginated  = useMemo(() => sorted.slice((page - 1) * pageSize, page * pageSize), [sorted, page, pageSize]);

  useEffect(() => { setPage(1); }, [search, category, sortKey, sortDir, pageSize]);

  function toggleSort(col: SortKey) {
    if (sortKey === col) setSortDir((d) => d === "asc" ? "desc" : "asc");
    else { setSortKey(col); setSortDir("asc"); }
  }

  const allPageSelected = paginated.length > 0 && paginated.every((p) => selected.has(p.id));
  function toggleAll() {
    if (allPageSelected) setSelected((s) => { const n = new Set(s); paginated.forEach((p) => n.delete(p.id)); return n; });
    else setSelected((s) => { const n = new Set(s); paginated.forEach((p) => n.add(p.id)); return n; });
  }
  function toggleOne(id: number) {
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  async function deleteSelected() {
    if (!window.confirm(`Деактивувати ${selected.size} позицій?`)) return;
    setDeleting(true);
    try {
      await Promise.all([...selected].map((id) => api(`/api/warehouse/products/${id}`, { method: "DELETE" })));
      setProducts((prev) => prev.filter((p) => !selected.has(p.id)));
      setSelected(new Set());
    } finally { setDeleting(false); }
  }

  function handleSaved(p: Product) {
    setProducts((prev) => {
      const idx = prev.findIndex((x) => x.id === p.id);
      return idx >= 0 ? prev.map((x) => x.id === p.id ? p : x) : [p, ...prev];
    });
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setImporting(true);
    setImportResult(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const preview = await api<ImportPreview>("/api/warehouse/products/import/preview", { method: "POST", body });
      setImportFile(file);
      setImportPreview(preview);
      setActionNew("import");
      setActionExisting("update");
      setActionMissing("nothing");
    } catch {
      alert("Помилка читання файлу");
    } finally {
      setImporting(false);
    }
  }

  async function handleImportConfirm() {
    if (!importFile) return;
    setImporting(true);
    try {
      const body = new FormData();
      body.append("file", importFile);
      const params = new URLSearchParams({ action_new: actionNew, action_existing: actionExisting, action_missing: actionMissing });
      const result = await api<{ created: number; updated: number; skipped: number; hidden: number; new_categories: number }>(
        `/api/warehouse/products/import?${params}`,
        { method: "POST", body },
      );
      setImportResult(result);
      setImportPreview(null);
      setImportFile(null);
      await load();
    } catch {
      alert("Помилка імпорту");
    } finally {
      setImporting(false);
    }
  }

  function handleExport() {
    const token = getToken();
    fetch(`${API_URL}/api/warehouse/products/export`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => r.blob())
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "products.tsv";
        a.click();
        URL.revokeObjectURL(url);
      });
  }

  if (loading) return <div className="text-sm text-[var(--text-muted)]">Завантаження…</div>;

  return (
    <>
      <div className="space-y-4">

        {/* Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <svg className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-faint)]"
                width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
              </svg>
              <input type="search" placeholder="Назва або артикул…"
                value={search} onChange={(e) => setSearch(e.target.value)}
                className="h-9 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] pl-8 pr-3 text-sm outline-none placeholder:text-[var(--text-faint)] focus:border-[var(--border-strong)]   " />
            </div>
            <div className="flex flex-wrap gap-1">
              {allCategories.map((c) => {
                const color  = c === "Всі" ? null : catColorMap.get(c);
                const active = category === c;
                return (
                  <button
                    key={c}
                    onClick={() => setCategory(c)}
                    className={color ? [
                      "h-7 rounded-full px-2.5 text-xs font-medium transition-colors",
                      active ? "ring-2 ring-offset-1 ring-[var(--bg)] " : "opacity-70 hover:opacity-100",
                    ].join(" ") : [
                      "h-7 rounded-full px-2.5 text-xs font-medium transition-colors border",
                      active
                        ? "bg-[var(--accent)] text-white border-[var(--border-strong)]   "
                        : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-strong)]  ",
                    ].join(" ")}
                    style={color ? { background: color, color: "#111" } : undefined}
                  >
                    {c}
                  </button>
                );
              })}
            </div>
            <span className="text-sm text-[var(--text-faint)]">{filtered.length} позицій</span>
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={importRef}
              type="file"
              accept=".tsv,.csv,.txt,.xlsx,.xls"
              className="hidden"
              onChange={handleImport}
            />
            <button
              onClick={handleExport}
              className="btn btn-ghost btn-sm"
              title="Експорт TSV (Ordage)"
            >
              ↓ Експорт
            </button>
            <button
              onClick={() => importRef.current?.click()}
              disabled={importing}
              className="btn btn-ghost btn-sm disabled:opacity-50"
              title="Імпорт TSV/CSV (Ordage)"
            >
              {importing ? "…" : "↑ Імпорт"}
            </button>
            <button onClick={() => setEditProduct("create")}
              className="btn btn-primary">
              + Номенклатура
            </button>
          </div>
        </div>

        {/* Import result banner */}
        {importResult && (
          <div className="flex items-center gap-3 rounded-lg border border-[rgba(34,197,94,.25)] bg-[rgba(34,197,94,.08)] px-4 py-2.5">
            <span className="text-sm text-[var(--state-ok)]">
              Імпорт завершено: додано {importResult.created}, оновлено {importResult.updated}{importResult.hidden ? `, сховано ${importResult.hidden}` : ""}{importResult.new_categories ? `, нових категорій ${importResult.new_categories}` : ""}, пропущено {importResult.skipped}
            </span>
            <button
              onClick={() => setImportResult(null)}
              className="ml-auto text-sm text-[var(--text-faint)] hover:text-[var(--text)]"
            >
              ✕
            </button>
          </div>
        )}

        {/* Bulk bar */}
        {selected.size > 0 && (
          <div className="flex items-center gap-3 rounded-lg border border-[rgba(245,158,11,.25)] bg-[rgba(245,158,11,.08)] px-4 py-2.5  ">
            <span className="text-sm font-medium text-[var(--state-warn)]">Вибрано {selected.size}</span>
            <button onClick={() => setSelected(new Set())}
              className="text-sm text-[var(--state-warn)] underline underline-offset-2 hover:text-[var(--state-warn)] dark:text-[var(--state-warn)]">
              Скасувати
            </button>
            <div className="ml-auto">
              <button onClick={deleteSelected} disabled={deleting}
                className="rounded-md bg-[var(--state-error)] px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50">
                {deleting ? "Деактивую…" : "Деактивувати"}
              </button>
            </div>
          </div>
        )}

        {/* Table */}
        <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]  ">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[780px] text-sm">
              <thead className="bg-[var(--bg)] text-left text-xs uppercase tracking-wider text-[var(--text-muted)]  ">
                <tr>
                  <th className="w-10 px-4 py-3">
                    <input type="checkbox" checked={allPageSelected} onChange={toggleAll}
                      className="rounded border-[var(--border-strong)] " />
                  </th>
                  <Th col="name"       sortKey={sortKey} sortDir={sortDir} onSort={toggleSort}>Назва</Th>
                  <Th col="sku"        sortKey={sortKey} sortDir={sortDir} onSort={toggleSort}>Артикул</Th>
                  <th className="px-4 py-3 font-medium">Категорія</th>
                  <th className="px-4 py-3 font-medium">Од.</th>
                  <Th col="stock"      sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-right">Залишок</Th>
                  <Th col="full_cost"  sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-right">Собів.</Th>
                  <Th col="sale_price" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-right">Ціна</Th>
                  <Th col="margin"     sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-right">Маржа</Th>
                  <th className="w-20 px-3 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {paginated.length === 0 ? (
                  <tr><td colSpan={10} className="px-4 py-12 text-center text-sm text-[var(--text-faint)]">
                    {search || category !== "Всі" ? "Нічого не знайдено" : "Номенклатури ще немає"}
                  </td></tr>
                ) : paginated.map((p) => {
                  const avail  = stockByProduct.get(p.id) ?? 0;
                  const margin = calcMargin(p.sale_price, p.full_cost);
                  const isOut  = avail === 0 && stock.some((s) => s.product_id === p.id);
                  return (
                    <tr key={p.id}
                      className={selected.has(p.id) ? "bg-[var(--accent-soft)]/50 " : "hover:bg-[var(--surface-hi)]/80 "}>
                      <td className="px-4 py-3">
                        <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleOne(p.id)}
                          className="rounded border-[var(--border-strong)] " />
                      </td>
                      <td className="px-4 py-3">
                        <button onClick={() => setEditProduct(p)}
                          className="text-left font-medium text-[var(--text-hi)] hover:text-[var(--accent)] ">
                          {p.name}
                        </button>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-[var(--text-muted)]">{p.sku}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {p.categories.map((c) => {
                            const color = catColorMap.get(c);
                            return (
                              <span
                                key={c}
                                onClick={() => setCategory(c)}
                                className={color
                                  ? "cursor-pointer rounded-full px-2 py-0.5 text-xs font-medium transition-opacity hover:opacity-80"
                                  : "cursor-pointer rounded-full bg-[var(--surface-hi)] px-2 py-0.5 text-xs hover:bg-[var(--surface-hi)]  transition-opacity"}
                                style={color ? { background: color, color: "#111" } : undefined}
                              >
                                {c}
                              </span>
                            );
                          })}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-[var(--text-muted)]">{p.unit}</td>
                      <td className="px-4 py-3 text-right">
                        <span className={[
                          "font-mono text-sm tabular-nums",
                          isOut ? "font-semibold text-[var(--state-error)]"
                            : avail < 5 ? "text-[var(--state-warn)]"
                            : "text-[var(--text)] ",
                        ].join(" ")}>{Math.round(avail)}</span>
                      </td>
                      <td className="px-4 py-3 text-right text-sm tabular-nums text-[var(--text-muted)]">{fmtPrice(p.full_cost)}</td>
                      <td className="px-4 py-3 text-right text-sm tabular-nums font-medium">{fmtPrice(p.sale_price)}</td>
                      <td className="px-4 py-3 text-right text-sm">
                        {margin !== null ? (
                          <span className={["font-medium tabular-nums",
                            margin >= 50 ? "text-[var(--state-ok)]"
                              : margin >= 20 ? "text-[var(--state-warn)]"
                              : "text-[var(--state-error)]",
                          ].join(" ")}>{margin.toFixed(0)}%</span>
                        ) : "—"}
                      </td>
                      {/* Row actions */}
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-1 justify-end">
                          {/* Edit product */}
                          <button onClick={() => setEditProduct(p)} title="Редагувати"
                            className="flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)]  ">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                          </button>
                          {/* Spec */}
                          <button onClick={() => setSpecProduct(p)} title="Специфікація"
                            className="flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)]  ">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/>
                            </svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {sorted.length > 0 && (
            <div className="flex items-center justify-between border-t border-[var(--border)] px-4 py-3 ">
              <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                <span>Рядків:</span>
                {PAGE_SIZES.map((s) => (
                  <button key={s} onClick={() => setPageSize(s)}
                    className={["rounded px-2 py-0.5 text-sm",
                      pageSize === s ? "bg-[var(--accent)] text-white  "
                        : "hover:bg-[var(--surface-hi)] "].join(" ")}>
                    {s}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1">
                <span className="mr-2 text-sm text-[var(--text-faint)]">
                  {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, sorted.length)} з {sorted.length}
                </span>
                <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
                  className="flex size-7 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--surface-hi)] disabled:opacity-30 ">‹</button>
                {totalPages <= 7 && Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                  <button key={p} onClick={() => setPage(p)}
                    className={["flex size-7 items-center justify-center rounded-md text-sm",
                      page === p ? "bg-[var(--accent)] text-white  "
                        : "text-[var(--text-muted)] hover:bg-[var(--surface-hi)] "].join(" ")}>
                    {p}
                  </button>
                ))}
                {totalPages > 7 && <span className="px-1 text-sm text-[var(--text-faint)]">{page} / {totalPages}</span>}
                <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                  className="flex size-7 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--surface-hi)] disabled:opacity-30 ">›</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Import preview modal */}
      {importPreview && (
        <ImportPreviewModal
          preview={importPreview}
          actionNew={actionNew} setActionNew={setActionNew}
          actionExisting={actionExisting} setActionExisting={setActionExisting}
          actionMissing={actionMissing} setActionMissing={setActionMissing}
          onConfirm={handleImportConfirm}
          onClose={() => { setImportPreview(null); setImportFile(null); }}
          busy={importing}
        />
      )}

      {/* Product modal */}
      {editProduct !== null && (
        <ProductModal
          product={editProduct === "create" ? null : editProduct}
          onClose={() => setEditProduct(null)}
          onSaved={handleSaved}
        />
      )}

      {/* Spec modal */}
      {specProduct !== null && (
        <SpecModal
          product={specProduct}
          onClose={() => setSpecProduct(null)}
        />
      )}
    </>
  );
}
