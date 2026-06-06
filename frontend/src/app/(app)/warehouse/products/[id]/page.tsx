"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { PageSkeleton } from "@/components/ui/ContentSkeleton";

// ── Types ─────────────────────────────────────────────────────────────────────

type Product = {
  id: number; name: string; sku: string; categories: string[];
  unit: string; sale_price: string | null; cost_price: string | null;
  direct_cost: string | null; full_cost: string | null;
};

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
  is_default: boolean; components: SpecComponent[]; operations: SpecOperation[];
};

type CostBreakdown = {
  material_cost: string; electricity_cost: string;
  labor_cost: string; other_cost: string;
  total: string; print_time_min: string; margin_pct: string | null;
};

type StockRow = {
  id: number; product_id: number; product_name: string; product_sku: string;
  product_unit: string; warehouse_id: number; warehouse_name: string;
  quantity: string; reserved_qty: string; available: string;
  min_stock: number | null; desired_stock: number | null;
};

type ProductCell = { cell_id: number; zone_name: string; code: string; quantity: string };
type WarehouseLocation = {
  warehouse_id: number; warehouse_name: string;
  cells: ProductCell[]; unassigned: string; total: string;
};
type ProductLocations = { product_id: number; warehouses: WarehouseLocation[] };

// ── Helpers ───────────────────────────────────────────────────────────────────

const OP_ICONS: Record<string, string> = { print: "🖨", manual: "✋", postprocess: "🎨" };
const ORG = { electricityRate: 4.5, laborRate: 150, printerWatts: 200 };

function fmtMin(min: number) {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h > 0 ? `${h}г ${m}хв` : `${m} хв`;
}
function fmt(v: string | number | null) {
  return v != null ? parseFloat(String(v)).toFixed(2) : "—";
}

function CostBar({ pct, cls }: { pct: number; cls: string }) {
  return (
    <div className="h-1.5 w-24 overflow-hidden rounded-full bg-[var(--surface-hi)]">
      <div className={`h-full rounded-full ${cls}`} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

// ── AddComponentForm ──────────────────────────────────────────────────────────

type WProduct = { id: number; name: string; sku: string; unit: string; cost_price: string | null };

function AddComponentForm({
  specId, onAdded, nextOrder,
}: {
  specId: number; onAdded: (s: Spec) => void; nextOrder: number;
}) {
  const [open, setOpen]         = useState(false);
  const [name, setName]         = useState("");
  const [qty,  setQty]          = useState("1");
  const [unit, setUnit]         = useState("g");
  const [price, setPrice]       = useState("");
  const [waste, setWaste]       = useState("0");
  const [productId, setProductId] = useState("");
  const [products, setProducts] = useState<WProduct[]>([]);
  const [busy, setBusy]         = useState(false);

  function handleOpen() {
    setOpen(true);
    api<WProduct[]>("/api/warehouse/products").then(setProducts).catch(() => {});
  }

  function handleProductChange(id: string) {
    setProductId(id);
    const product = products.find((p) => String(p.id) === id);
    if (!product) return;
    setName(product.name);
    setUnit(product.unit || "g");
    setPrice(product.cost_price ? parseFloat(product.cost_price).toFixed(4) : "");
  }

  if (!open) {
    return (
      <button onClick={handleOpen}
        className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-[var(--accent)] hover:bg-[rgba(34,211,238,.08)]">
        <span className="text-sm">+</span> Матеріал
      </button>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const spec = await api<Spec>(`/api/warehouse/specs/${specId}/components`, {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          product_id: productId ? parseInt(productId) : null,
          quantity: parseFloat(qty) || 0,
          unit,
          unit_price: price ? parseFloat(price) : null,
          waste_pct: parseFloat(waste) || 0,
          sort_order: nextOrder,
        }),
      });
      onAdded(spec);
      setName(""); setQty("1"); setPrice(""); setWaste("0"); setProductId("");
      setOpen(false);
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-[var(--accent)] bg-[rgba(34,211,238,.04)] p-3">
      <label className="flex-1 min-w-[140px]">
        <span className="mb-0.5 block text-[10px] text-[var(--text-faint)]">Назва</span>
        <input autoFocus value={name} onChange={e => setName(e.target.value)} required
          placeholder="PLA Polydream Чорний"
          className="w-full rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-xs outline-none focus:border-[var(--accent)]" />
      </label>
      <label className="w-20">
        <span className="mb-0.5 block text-[10px] text-[var(--text-faint)]">К-сть</span>
        <input type="number" step="0.01" min="0" value={qty} onChange={e => setQty(e.target.value)}
          className="w-full rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-xs outline-none focus:border-[var(--accent)]" />
      </label>
      <label className="w-16">
        <span className="mb-0.5 block text-[10px] text-[var(--text-faint)]">Од.</span>
        <select value={unit} onChange={e => setUnit(e.target.value)}
          className="w-full rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-xs">
          <option value="g">г</option>
          <option value="kg">кг</option>
          <option value="шт">шт</option>
          <option value="м">м</option>
          <option value="мл">мл</option>
        </select>
      </label>
      <label className="w-20">
        <span className="mb-0.5 block text-[10px] text-[var(--text-faint)]">Ціна/од.</span>
        <input type="number" step="0.0001" min="0" value={price} onChange={e => setPrice(e.target.value)}
          placeholder="0.00"
          className="w-full rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-xs outline-none focus:border-[var(--accent)]" />
      </label>
      <label className="w-16">
        <span className="mb-0.5 block text-[10px] text-[var(--text-faint)]">Відхід %</span>
        <input type="number" step="0.1" min="0" value={waste} onChange={e => setWaste(e.target.value)}
          className="w-full rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-xs outline-none focus:border-[var(--accent)]" />
      </label>
      {products.length > 0 && (
        <label className="flex-1 min-w-[160px]">
          <span className="mb-0.5 block text-[10px] text-[var(--text-faint)]">Продукт на складі</span>
          <select value={productId} onChange={e => handleProductChange(e.target.value)}
            className="w-full rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-xs">
            <option value="">— не прив’язано —</option>
            {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      )}
      <div className="flex gap-1">
        <button type="submit" disabled={busy || !name.trim()}
          className="rounded bg-[var(--accent)] px-2.5 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-hi)] disabled:opacity-50">
          {busy ? "…" : "Додати"}
        </button>
        <button type="button" onClick={() => setOpen(false)}
          className="rounded px-2 py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)]">
          ✕
        </button>
      </div>
    </form>
  );
}

// ── AddOperationForm ──────────────────────────────────────────────────────────

function AddOperationForm({
  specId, onAdded, nextOrder,
}: {
  specId: number; onAdded: (s: Spec) => void; nextOrder: number;
}) {
  const [open, setOpen]   = useState(false);
  const [opType, setOpType] = useState("print");
  const [name, setName]   = useState("Друк");
  const [printMin, setPrintMin] = useState("");
  const [laborMin, setLaborMin] = useState("");
  const [laborRate, setLaborRate] = useState("");
  const [explCost, setExplCost] = useState("");
  const [notes, setNotes]       = useState("");
  const [busy, setBusy]   = useState(false);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-[var(--accent)] hover:bg-[rgba(34,211,238,.08)]">
        <span className="text-sm">+</span> Операція
      </button>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const spec = await api<Spec>(`/api/warehouse/specs/${specId}/operations`, {
        method: "POST",
        body: JSON.stringify({
          type: opType,
          name: name.trim(),
          sort_order: nextOrder,
          print_time_min: printMin ? parseFloat(printMin) : null,
          labor_minutes: laborMin ? parseFloat(laborMin) : null,
          labor_rate_per_hour: laborRate ? parseFloat(laborRate) : null,
          explicit_cost: explCost ? parseFloat(explCost) : null,
          notes: notes.trim() || null,
        }),
      });
      onAdded(spec);
      setName("Друк"); setPrintMin(""); setLaborMin(""); setLaborRate(""); setExplCost(""); setNotes("");
      setOpen(false);
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded-lg border border-dashed border-[var(--accent)] bg-[rgba(34,211,238,.04)] p-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="w-24">
          <span className="mb-0.5 block text-[10px] text-[var(--text-faint)]">Тип</span>
          <select value={opType} onChange={e => { setOpType(e.target.value); if (e.target.value === "print") setName("Друк"); else if (e.target.value === "manual") setName("Ручна робота"); else setName("Постобробка"); }}
            className="w-full rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-xs">
            <option value="print">🖨 Друк</option>
            <option value="manual">✋ Ручна</option>
            <option value="postprocess">🎨 Пост.</option>
          </select>
        </label>
        <label className="flex-1 min-w-[120px]">
          <span className="mb-0.5 block text-[10px] text-[var(--text-faint)]">Назва</span>
          <input autoFocus value={name} onChange={e => setName(e.target.value)} required
            className="w-full rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-xs outline-none focus:border-[var(--accent)]" />
        </label>
        {opType === "print" && (
          <label className="w-24">
            <span className="mb-0.5 block text-[10px] text-[var(--text-faint)]">Час друку (хв)</span>
            <input type="number" step="0.01" min="0" value={printMin} onChange={e => setPrintMin(e.target.value)}
              placeholder="74.75"
              className="w-full rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-xs outline-none focus:border-[var(--accent)]" />
          </label>
        )}
        <label className="w-24">
          <span className="mb-0.5 block text-[10px] text-[var(--text-faint)]">Праця (хв)</span>
          <input type="number" step="0.01" min="0" value={laborMin} onChange={e => setLaborMin(e.target.value)}
            className="w-full rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-xs outline-none focus:border-[var(--accent)]" />
        </label>
        <label className="w-24">
          <span className="mb-0.5 block text-[10px] text-[var(--text-faint)]">Ставка ₴/год</span>
          <input type="number" step="0.01" min="0" value={laborRate} onChange={e => setLaborRate(e.target.value)}
            placeholder="150"
            className="w-full rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-xs outline-none focus:border-[var(--accent)]" />
        </label>
        <label className="w-24">
          <span className="mb-0.5 block text-[10px] text-[var(--text-faint)]">Дод. витрата ₴</span>
          <input type="number" step="0.01" min="0" value={explCost} onChange={e => setExplCost(e.target.value)}
            className="w-full rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-xs outline-none focus:border-[var(--accent)]" />
        </label>
      </div>
      <div className="flex items-end gap-2">
        <label className="flex-1">
          <span className="mb-0.5 block text-[10px] text-[var(--text-faint)]">Примітка</span>
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Опціонально"
            className="w-full rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-xs outline-none focus:border-[var(--accent)]" />
        </label>
        <button type="submit" disabled={busy || !name.trim()}
          className="rounded bg-[var(--accent)] px-2.5 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-hi)] disabled:opacity-50">
          {busy ? "…" : "Додати"}
        </button>
        <button type="button" onClick={() => setOpen(false)}
          className="rounded px-2 py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)]">
          ✕
        </button>
      </div>
    </form>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

type Tab = "overview" | "specification" | "stock" | "history";

export default function ProductDetailPage() {
  const { id }    = useParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>("specification");
  const [product,  setProduct]  = useState<Product | null>(null);
  const [spec,     setSpec]     = useState<Spec | null>(null);
  const [cost,     setCost]     = useState<CostBreakdown | null>(null);
  const [stock,    setStock]    = useState<StockRow[]>([]);
  const [locations, setLocations] = useState<ProductLocations | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [costBusy, setCostBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const delBusy = useRef(false);

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

  // Lazy load stock only when tab is opened
  const stockLoaded = useRef(false);
  useEffect(() => {
    if (tab === "stock" && !stockLoaded.current) {
      stockLoaded.current = true;
      api<StockRow[]>(`/api/warehouse/stock?product_id=${id}`).then(setStock).catch(() => {});
      api<ProductLocations>(`/api/warehouse/products/${id}/locations`).then(setLocations).catch(() => {});
    }
  }, [tab, id]);

  async function createSpec() {
    setCreating(true);
    try {
      const newSpec = await api<Spec>(`/api/warehouse/products/${id}/specs`, {
        method: "POST",
        body: JSON.stringify({ product_id: parseInt(id), name: "Основна" }),
      });
      setSpec(newSpec);
    } finally { setCreating(false); }
  }

  async function computeCost() {
    setCostBusy(true);
    try {
      const c = await api<CostBreakdown>(`/api/warehouse/products/${id}/cost`);
      setCost(c);
      const p = await api<Product>(`/api/warehouse/products/${id}`);
      setProduct(p);
    } finally { setCostBusy(false); }
  }

  async function deleteComponent(compId: number) {
    if (!spec || delBusy.current) return;
    delBusy.current = true;
    try {
      await api(`/api/warehouse/specs/${spec.id}/components/${compId}`, { method: "DELETE" });
      setSpec(prev => prev ? { ...prev, components: prev.components.filter(c => c.id !== compId) } : prev);
    } finally { delBusy.current = false; }
  }

  async function deleteOperation(opId: number) {
    if (!spec || delBusy.current) return;
    delBusy.current = true;
    try {
      await api(`/api/warehouse/specs/${spec.id}/operations/${opId}`, { method: "DELETE" });
      setSpec(prev => prev ? { ...prev, operations: prev.operations.filter(o => o.id !== opId) } : prev);
    } finally { delBusy.current = false; }
  }

  if (loading) return <PageSkeleton cols={5} rows={6} />;
  if (!product) return <div className="text-sm text-[var(--state-error)]">Товар не знайдено</div>;

  const TABS: { id: Tab; label: string }[] = [
    { id: "overview",       label: "Огляд" },
    { id: "specification",  label: "Специфікація" },
    { id: "stock",          label: "Залишки" },
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

  const totalStock = stock.reduce((s, r) => s + parseFloat(r.available), 0);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
        <Link href="/warehouse/products" className="hover:text-[var(--text)]">Номенклатура</Link>
        <span>/</span>
        <span className="text-[var(--text-hi)]">{product.name}</span>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">{product.name}</h2>
          <div className="mt-1 flex items-center gap-3 text-sm text-[var(--text-muted)]">
            <span className="font-mono">{product.sku}</span>
            {product.categories.map((c) => (
              <span key={c} className="rounded-full bg-[var(--surface-hi)] px-2 py-0.5 text-xs">{c}</span>
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={computeCost} disabled={!spec || costBusy}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--surface-hi)] disabled:opacity-50">
            {costBusy ? "Рахую…" : "↻ Собівартість"}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-0.5 border-b border-[var(--border)]">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={["relative px-3 py-2 text-sm transition-colors",
              tab === t.id
                ? "text-[var(--text-hi)] after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-[var(--accent)]"
                : "text-[var(--text-muted)] hover:text-[var(--text)]",
            ].join(" ")}>
            {t.label}
            {t.id === "stock" && totalStock > 0 && (
              <span className="ml-1.5 rounded-full bg-[var(--surface-hi)] px-1.5 py-0.5 text-[10px] tabular-nums font-medium">
                {Math.round(totalStock)}
              </span>
            )}
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
            { label: "Залишок",         value: `${Math.round(totalStock)} ${product.unit}` },
            { label: "Версія",          value: spec ? `v${spec.version} · ${spec.is_default ? "активна" : ""}` : "—" },
          ].map((k) => (
            <div key={k.label} className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4">
              <p className="text-xs text-[var(--text-muted)]">{k.label}</p>
              <p className={`mt-1 text-xl font-bold tabular-nums ${"highlight" in k && k.highlight ? "text-[var(--accent)]" : ""}`}>
                {k.value}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Specification */}
      {tab === "specification" && (
        !spec ? (
          <div className="rounded-xl border border-dashed border-[var(--border-strong)] px-4 py-12 text-center">
            <p className="text-sm text-[var(--text-faint)]">Специфікацію ще не додано</p>
            <button onClick={createSpec} disabled={creating}
              className="mt-3 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hi)] disabled:opacity-50">
              {creating ? "Створюю…" : "+ Створити специфікацію"}
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <span className="rounded-full bg-[rgba(34,197,94,.10)] px-2.5 py-0.5 text-xs font-medium text-[var(--state-ok)]">
                v{spec.version} · {spec.name}
              </span>
            </div>

            <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
              <div className="space-y-5">
                {/* Materials */}
                <div>
                  <div className="mb-3 flex items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-widest text-[var(--text-faint)]">Матеріали</span>
                    <div className="flex-1 border-t border-[var(--border)]" />
                  </div>
                  <div className="overflow-hidden rounded-xl border border-[var(--border)]">
                    <table className="w-full text-sm">
                      <thead className="bg-[var(--bg)] text-xs text-[var(--text-faint)]">
                        <tr>
                          <th className="w-8 px-2 py-2.5"></th>
                          <th className="px-4 py-2.5 text-left font-medium">Матеріал</th>
                          <th className="px-4 py-2.5 text-right font-medium">К-сть</th>
                          <th className="px-4 py-2.5 text-right font-medium">Відходи</th>
                          <th className="px-4 py-2.5 text-right font-medium">Ціна/од.</th>
                          <th className="px-4 py-2.5 text-right font-medium">Вартість</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--border)]">
                        {spec.components.length === 0 ? (
                          <tr><td colSpan={6} className="px-4 py-4 text-center text-xs text-[var(--text-faint)]">Немає компонентів</td></tr>
                        ) : (
                          spec.components.map((c) => {
                            const waste    = 1 + parseFloat(c.waste_pct) / 100;
                            const lineCost = c.unit_price ? parseFloat(c.quantity) * parseFloat(c.unit_price) * waste : null;
                            return (
                              <tr key={c.id} className="group">
                                <td className="px-2 py-3 text-center">
                                  <button onClick={() => deleteComponent(c.id)}
                                    className="flex size-5 items-center justify-center rounded text-[var(--text-faint)] opacity-0 group-hover:opacity-100 hover:bg-[rgba(239,68,68,.08)] hover:text-[var(--state-error)]"
                                    title="Видалити">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><line x1="5" y1="12" x2="19" y2="12"/></svg>
                                  </button>
                                </td>
                                <td className="px-4 py-3">
                                  <div className="flex flex-col gap-1">
                                    <span><span className="mr-1.5 text-[var(--text-faint)]">🧵</span>{c.product_name ?? c.name}</span>
                                    <span className="w-fit rounded bg-[var(--surface-hi)] px-1.5 py-0.5 text-[10px] text-[var(--text-faint)]">
                                      номенклатура
                                    </span>
                                  </div>
                                </td>
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
                  <div className="mt-2">
                    <AddComponentForm specId={spec.id} onAdded={setSpec} nextOrder={spec.components.length} />
                  </div>
                </div>

                {/* Operations */}
                <div>
                  <div className="mb-3 flex items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-widest text-[var(--text-faint)]">Операції</span>
                    <div className="flex-1 border-t border-[var(--border)]" />
                  </div>
                  <div className="space-y-2">
                    {spec.operations.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-[var(--border)] px-4 py-4 text-center text-xs text-[var(--text-faint)]">
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
                          <div key={op.id} className="group rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4">
                            <div className="mb-2 flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span className="text-[var(--text-faint)]">{op.sort_order + 1}.</span>
                                <span className="text-lg">{OP_ICONS[op.type] ?? "⚙"}</span>
                                <span className="font-medium">{op.name}</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-semibold tabular-nums">₴{opTotal.toFixed(4)}</span>
                                <button onClick={() => deleteOperation(op.id)}
                                  className="flex size-5 items-center justify-center rounded text-[var(--text-faint)] opacity-0 group-hover:opacity-100 hover:bg-[rgba(239,68,68,.08)] hover:text-[var(--state-error)]"
                                  title="Видалити операцію">
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><line x1="5" y1="12" x2="19" y2="12"/></svg>
                                </button>
                              </div>
                            </div>
                            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-[var(--text-muted)] sm:grid-cols-3">
                              {pMin > 0 && <span>⏱ {fmtMin(pMin)}</span>}
                              {op.type === "print" && kwh > 0 && (
                                <span>⚡ {kwh.toFixed(3)} кВт·год = <span className="text-[var(--text)]">₴{elCost.toFixed(4)}</span></span>
                              )}
                              {op.labor_minutes && (
                                <span>👷 {op.labor_minutes} хв = <span className="text-[var(--text)]">₴{labCost.toFixed(4)}</span></span>
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
                  <div className="mt-2">
                    <AddOperationForm specId={spec.id} onAdded={setSpec} nextOrder={spec.operations.length} />
                  </div>
                </div>
              </div>

              {/* Cost sidebar */}
              <div>
                <div className="sticky top-6 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5">
                  <p className="mb-4 text-sm font-medium">Собівартість / шт</p>

                  {!costData ? (
                    <button onClick={computeCost} disabled={costBusy}
                      className="w-full rounded-md border border-[var(--border)] py-2 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)] disabled:opacity-50">
                      {costBusy ? "Рахую…" : "↻ Розрахувати"}
                    </button>
                  ) : (
                    <>
                      {[
                        { label: "Матеріали",     value: parseFloat(costData.material_cost),     cls: "bg-[rgba(56,189,248,.6)]",    pct: 0 },
                        { label: "Електрика",     value: parseFloat(costData.electricity_cost),  cls: "bg-[var(--state-warn)]",   pct: 0 },
                        { label: "Трудовитрати",  value: parseFloat(costData.labor_cost),        cls: "bg-[rgba(34,197,94,.6)]", pct: 0 },
                        { label: "Постпроцесинг", value: parseFloat(costData.other_cost),        cls: "bg-violet-500",  pct: 0 },
                      ].map((row) => {
                        const total = parseFloat(costData.total);
                        const pct   = total > 0 ? (row.value / total) * 100 : 0;
                        return (
                          <div key={row.label} className="mb-3">
                            <div className="mb-1 flex justify-between text-xs">
                              <span className="text-[var(--text-muted)]">{row.label}</span>
                              <span className="tabular-nums font-medium text-[var(--text)]">
                                ₴{row.value.toFixed(4)}
                                <span className="ml-1.5 text-[var(--text-faint)]">{pct.toFixed(0)}%</span>
                              </span>
                            </div>
                            <CostBar pct={pct} cls={row.cls} />
                          </div>
                        );
                      })}

                      <div className="mt-4 border-t border-[var(--border)] pt-4">
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
                                <span className={`text-sm font-semibold ${margin >= 50 ? "text-[var(--state-ok)]" : "text-[var(--state-warn)]"}`}>
                                  {margin.toFixed(1)}% {margin >= 50 ? "🟢" : "🟡"}
                                </span>
                              </div>
                            )}
                          </>
                        )}
                      </div>

                      {parseFloat(costData.print_time_min) > 0 && (
                        <div className="mt-3 border-t border-[var(--border)] pt-3">
                          <div className="flex justify-between text-sm">
                            <span className="text-[var(--text-muted)]">Час друку</span>
                            <span className="tabular-nums">{fmtMin(parseFloat(costData.print_time_min))}</span>
                          </div>
                        </div>
                      )}

                      <button onClick={computeCost} disabled={costBusy}
                        className="mt-4 w-full rounded-md border border-[var(--border)] py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)] disabled:opacity-50">
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

      {/* Stock / Залишки */}
      {tab === "stock" && (
        stock.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--border-strong)] px-4 py-12 text-center text-sm text-[var(--text-faint)]">
            Залишків по цьому товару ще немає. Створіть рух (надходження) на сторінці «Рухи».
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-[var(--border)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--bg)] text-xs text-[var(--text-faint)]">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium">Склад</th>
                  <th className="px-4 py-2.5 text-right font-medium">Кількість</th>
                  <th className="px-4 py-2.5 text-right font-medium">Резерв</th>
                  <th className="px-4 py-2.5 text-right font-medium">Доступно</th>
                  <th className="px-4 py-2.5 text-right font-medium">Мін.</th>
                  <th className="px-4 py-2.5 text-right font-medium">Бажано</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {stock.map((r) => {
                  const avail = parseFloat(r.available);
                  const isLow = r.min_stock != null && avail < r.min_stock;
                  return (
                    <tr key={r.id}>
                      <td className="px-4 py-3 font-medium">{r.warehouse_name}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{parseFloat(r.quantity).toFixed(0)}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-[var(--text-faint)]">
                        {parseFloat(r.reserved_qty) > 0 ? parseFloat(r.reserved_qty).toFixed(0) : "—"}
                      </td>
                      <td className={`px-4 py-3 text-right tabular-nums font-medium ${isLow ? "text-[var(--state-error)]" : ""}`}>
                        {avail.toFixed(0)} {product.unit}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-[var(--text-faint)]">{r.min_stock ?? "—"}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-[var(--text-faint)]">{r.desired_stock ?? "—"}</td>
                    </tr>
                  );
                })}
                {stock.length > 1 && (
                  <tr className="bg-[var(--bg)]">
                    <td className="px-4 py-3 text-xs font-semibold uppercase text-[var(--text-faint)]">Всього</td>
                    <td className="px-4 py-3 text-right tabular-nums font-bold">
                      {stock.reduce((s, r) => s + parseFloat(r.quantity), 0).toFixed(0)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums font-bold text-[var(--text-faint)]">
                      {stock.reduce((s, r) => s + parseFloat(r.reserved_qty), 0).toFixed(0)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums font-bold">
                      {totalStock.toFixed(0)} {product.unit}
                    </td>
                    <td colSpan={2}></td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )
      )}

      {tab === "stock" && locations && locations.warehouses.some((w) => w.cells.length > 0 || parseFloat(w.unassigned) > 0) && (
        <div className="mt-4 space-y-3">
          <h3 className="text-sm font-semibold text-[var(--text-muted)]" title="Після відвантажень розташування орієнтовне — точне після впровадження pick-list">
            Розташування по комірках
            <span className="ml-1 text-[10px] font-normal text-[var(--text-faint)]">≈ орієнтовне</span>
          </h3>
          {locations.warehouses.map((w) => (
            <div key={w.warehouse_id} className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium">{w.warehouse_name}</span>
                <span className="font-mono text-xs text-[var(--text-faint)]">всього {parseFloat(w.total).toFixed(0)} {product.unit}</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {w.cells.map((c) => (
                  <span key={c.cell_id}
                    className="inline-flex items-center gap-1 rounded-full border border-[var(--accent)] bg-[rgba(34,211,238,.06)] px-2 py-0.5 text-[11px] font-mono">
                    <span className="text-[var(--text-muted)]">{c.zone_name} {c.code}</span>
                    <span className="font-bold text-[var(--accent)]">{parseFloat(c.quantity).toFixed(0)}</span>
                  </span>
                ))}
                {parseFloat(w.unassigned) > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-[rgba(245,158,11,.4)] bg-[rgba(245,158,11,.10)] px-2 py-0.5 text-[11px] font-mono text-[var(--state-warn)]">
                    нерозкладено {parseFloat(w.unassigned).toFixed(0)}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "history" && (
        <div className="rounded-xl border border-dashed border-[var(--border-strong)] px-4 py-12 text-center text-sm text-[var(--text-faint)]">
          Тут буде зв&#39;язок з print_history для цього товару
        </div>
      )}
    </div>
  );
}
