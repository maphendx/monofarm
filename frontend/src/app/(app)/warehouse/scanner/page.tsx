"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "react-qr-code";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { usePageTitle } from "@/lib/usePageTitle";

// ── Types ─────────────────────────────────────────────────────────────────────

type CellStock  = { product_id: number; product_name: string; product_sku: string; quantity: string };
type CellDetail = { cell_id: number; cell_code: string; cell_notes: string | null; zone_name: string; warehouse_name: string; stock: CellStock[] };
type Product    = { id: number; name: string; sku: string; barcode: string | null; unit: string; categories: string[]; image_url: string | null; sale_price: string | null };
type ScanResult = { type: "cell" | "product"; cell?: CellDetail; product?: Product };
type Warehouse  = { id: number; name: string };
type CellOut    = { id: number; code: string; notes: string | null; stock: CellStock[] };
type ZoneWithCells = { id: number; name: string; rows: number; cols: number; cell_count: number; cells: CellOut[] };
type Filament   = { id: number; material: string; color: string; brand: string | null; sku: string | null; hex_color: string | null; grams_remaining: number; label_id: string | null };

// ── Barcode canvas hook ───────────────────────────────────────────────────────

function useBarcode(text: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!text) { setUrl(null); return; }
    let cancelled = false;
    import("jsbarcode").then((mod) => {
      if (cancelled) return;
      try {
        const JsBarcode = (mod as { default: unknown }).default ?? mod;
        const canvas = document.createElement("canvas");
        (JsBarcode as (el: HTMLCanvasElement, v: string, o: object) => void)(canvas, text, {
          format: "CODE128", displayValue: true, fontSize: 11,
          margin: 5, width: 2, height: 55, background: "#fff", lineColor: "#000",
        });
        if (!cancelled) setUrl(canvas.toDataURL("image/png"));
      } catch { if (!cancelled) setUrl(null); }
    }).catch(() => { if (!cancelled) setUrl(null); });
    return () => { cancelled = true; };
  }, [text]);
  return url;
}

// ── Tab: Scanner ──────────────────────────────────────────────────────────────

function ScannerTab() {
  const inputRef  = useRef<HTMLInputElement>(null);
  const [value,   setValue]   = useState("");
  const [loading, setLoading] = useState(false);
  const [err,     setErr]     = useState<string | null>(null);

  const [cell,       setCell]       = useState<CellDetail | null>(null);
  const [prod,       setProd]       = useState<Product | null>(null);
  const [mode,       setMode]       = useState<"idle" | "want_product" | "want_cell">("idle");
  const [qty,        setQty]        = useState("1");
  const [assigning,  setAssigning]  = useState(false);

  const focus = useCallback(() => inputRef.current?.focus(), []);
  useEffect(() => { focus(); }, [focus]);

  async function scan(raw: string) {
    const q = raw.trim();
    if (!q) return;
    setValue(""); setLoading(true); setErr(null);
    try {
      const res = await api<ScanResult>(`/api/warehouse/scan?q=${encodeURIComponent(q)}`);
      if (res.type === "cell" && res.cell) {
        setCell(res.cell);
        if (mode === "want_cell") setMode("idle");
        else if (!prod) setMode("want_product");
      } else if (res.type === "product" && res.product) {
        setProd(res.product);
        if (mode === "want_product") setMode("idle");
        else if (!cell) setMode("want_cell");
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Не знайдено — перевір код");
    } finally { setLoading(false); setTimeout(focus, 80); }
  }

  async function doAssign() {
    if (!cell || !prod || assigning) return;
    setAssigning(true);
    try {
      await api(`/api/warehouse/cells/${cell.cell_id}/assign`, {
        method: "POST",
        body: JSON.stringify({ product_id: prod.id, quantity: parseFloat(qty) || 1 }),
      });
      toast.success(`✓ ${prod.name} → ${cell.cell_code}`);
      setCell(null); setProd(null); setQty("1"); setMode("idle");
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : "Помилка"); }
    finally { setAssigning(false); setTimeout(focus, 80); }
  }

  function reset() { setCell(null); setProd(null); setQty("1"); setMode("idle"); setErr(null); setValue(""); setTimeout(focus, 50); }

  const ready = cell && prod;

  return (
    <div className="mx-auto max-w-md space-y-3" onClick={focus}>
      <input ref={inputRef} value={value} className="sr-only" autoComplete="off" inputMode="none"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); scan(value); } }} />

      {/* Two scan targets */}
      <div className="grid grid-cols-2 gap-3">
        {([
          { label: "КОМІРКА", icon: "🗄", data: cell, setFn: () => { setMode("want_cell"); setTimeout(focus, 50); },
            content: cell ? <><p className="font-mono text-xl font-bold text-[var(--state-ok)]">{cell.cell_code}</p><p className="truncate text-xs text-[var(--text-muted)]">{cell.zone_name} · {cell.warehouse_name}</p></> : null,
            active: mode === "want_cell" },
          { label: "ТОВАР",   icon: "📦", data: prod, setFn: () => { setMode("want_product"); setTimeout(focus, 50); },
            content: prod ? <><p className="font-mono text-sm font-bold text-[var(--state-ok)]">{prod.sku}</p><p className="truncate text-xs text-[var(--text-muted)]">{prod.name}</p></> : null,
            active: mode === "want_product" },
        ] as const).map((card) => (
          <div key={card.label} onClick={(e) => { e.stopPropagation(); card.setFn(); }}
            className={["cursor-pointer rounded-xl border-2 p-4 transition-all select-none",
              card.active ? "border-[var(--accent)] bg-[var(--accent)]/5 ring-2 ring-[var(--accent)]/20"
              : card.data ? "border-[var(--state-ok)] bg-[var(--state-ok)]/5"
              : "border-dashed border-[var(--border-strong)] hover:border-[var(--accent)]/40",
            ].join(" ")}>
            <p className="text-[10px] font-bold tracking-wider text-[var(--text-faint)]">{card.icon} {card.label}</p>
            {card.content ? <div className="mt-1">{card.content}</div>
              : <p className="mt-2 text-sm text-[var(--text-faint)]">{card.active ? "✦ Скануй…" : "Скануй"}</p>}
          </div>
        ))}
      </div>

      {/* Assign row */}
      {ready && (
        <div className="rounded-xl border border-[var(--state-ok)]/30 bg-[var(--state-ok)]/5 p-4 space-y-2">
          <p className="text-sm font-medium">{prod!.name} <span className="text-[var(--text-faint)]">→</span> {cell!.cell_code}</p>
          <div className="flex gap-2">
            <input type="number" min="0.01" step="1" value={qty} placeholder="К-сть"
              onChange={(e) => setQty(e.target.value)}
              onClick={(e) => e.stopPropagation()} onFocus={(e) => e.stopPropagation()}
              className="w-28 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2.5 text-center font-mono text-lg outline-none focus:border-[var(--accent)]" />
            <button onClick={(e) => { e.stopPropagation(); doAssign(); }} disabled={assigning}
              className="flex-1 rounded-lg bg-[var(--state-ok)] py-2.5 font-semibold text-white hover:opacity-90 disabled:opacity-50">
              {assigning ? "…" : "✓ Призначити"}
            </button>
          </div>
        </div>
      )}

      {/* Status */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-3 text-center text-sm">
        {loading ? <span className="text-[var(--text-muted)]">Пошук…</span>
          : err    ? <span className="text-[var(--state-error)]">{err}</span>
          : mode !== "idle" ? <span className="animate-pulse text-[var(--accent)]">{mode === "want_cell" ? "Очікую QR комірки…" : "Очікую баркод товару…"}</span>
          : <span className="text-[var(--text-faint)]">Готовий до сканування</span>}
      </div>

      {(cell || prod || err) && (
        <button onClick={(e) => { e.stopPropagation(); reset(); }}
          className="w-full rounded-lg border border-[var(--border)] py-2 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)]">
          ↺ Скинути
        </button>
      )}
    </div>
  );
}

// ── Tab: Cell labels ──────────────────────────────────────────────────────────

function CellLabelsTab() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [whId,       setWhId]       = useState<number | null>(null);
  const [zones,      setZones]      = useState<ZoneWithCells[]>([]);
  const [loading,    setLoading]    = useState(false);
  const [selected,   setSelected]   = useState<Set<number>>(new Set());

  useEffect(() => { api<Warehouse[]>("/api/warehouse/warehouses").then(setWarehouses).catch(() => {}); }, []);

  useEffect(() => {
    if (!whId) { setZones([]); return; }
    setLoading(true);
    api<ZoneWithCells[]>(`/api/warehouse/warehouses/${whId}/zones-with-cells`)
      .then((r) => { setZones(r); setSelected(new Set()); })
      .catch(() => setZones([]))
      .finally(() => setLoading(false));
  }, [whId]);

  const allCells = zones.flatMap((z) => z.cells.map((c) => ({ ...c, zoneName: z.name })));
  const printCells = selected.size > 0 ? allCells.filter((c) => selected.has(c.id)) : allCells;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <select value={whId ?? ""} onChange={(e) => setWhId(e.target.value ? Number(e.target.value) : null)}
          className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]">
          <option value="">— Оберіть склад —</option>
          {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        {allCells.length > 0 && <>
          <button onClick={() => setSelected(selected.size === allCells.length ? new Set() : new Set(allCells.map((c) => c.id)))}
            className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)]">
            {selected.size === allCells.length ? "Зняти всі" : "Вибрати всі"}
          </button>
          <button onClick={() => window.print()}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90">
            🖨 Друк ({printCells.length})
          </button>
        </>}
      </div>

      {loading && <p className="text-sm text-[var(--text-muted)]">Завантаження…</p>}

      {zones.map((zone) => (
        <div key={zone.id} className="rounded-xl border border-[var(--border)] overflow-hidden">
          <div className="flex items-center gap-3 bg-[var(--bg-elevated)] px-4 py-2.5 print:bg-white print:border-b">
            <span className="font-medium text-sm">{zone.name}</span>
            <span className="text-xs text-[var(--text-faint)] print:hidden">{zone.cells.length} комірок</span>
          </div>
          <div className="grid grid-cols-3 gap-3 p-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 print:grid-cols-4 print:gap-2 print:p-2">
            {zone.cells.map((cell) => {
              const isSel = selected.has(cell.id);
              const show  = selected.size === 0 || isSel;
              return (
                <div key={cell.id} onClick={() => setSelected((prev) => { const n = new Set(prev); n.has(cell.id) ? n.delete(cell.id) : n.add(cell.id); return n; })}
                  className={["cursor-pointer rounded-lg border-2 p-2 text-center transition-all print:cursor-default print:border print:border-gray-400 print:rounded",
                    isSel ? "border-[var(--accent)] bg-[var(--accent)]/8" : show ? "border-[var(--border)] hover:border-[var(--accent)]/40" : "opacity-25 print:opacity-100",
                  ].join(" ")}
                >
                  <div className="flex justify-center print:justify-center">
                    <QRCode value={`CELL:${cell.id}`} size={72} level="M" />
                  </div>
                  <p className="mt-1 font-mono text-[11px] font-bold">{cell.code}</p>
                  <p className="text-[9px] text-[var(--text-faint)] print:text-gray-500">{zone.name}</p>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Tab: Product cards ────────────────────────────────────────────────────────

function ProductCardItem({ p }: { p: Product }) {
  const barcodeText = p.barcode || `PROD:${p.id}`;
  const barcodeUrl  = useBarcode(barcodeText);
  const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] print:border print:border-gray-400 print:rounded print:break-inside-avoid">
      {p.image_url && (
        <img src={p.image_url.startsWith("/") ? `${API}${p.image_url}` : p.image_url}
          alt={p.name} className="h-28 w-full object-cover" />
      )}
      <div className="flex-1 p-2.5 space-y-1">
        <p className="font-semibold text-sm leading-tight">{p.name}</p>
        <p className="font-mono text-xs text-[var(--text-faint)]">{p.sku}</p>
        {p.categories.length > 0 && <p className="text-[10px] text-[var(--text-faint)]">{p.categories.slice(0, 2).join(", ")}</p>}
        {p.sale_price && <p className="text-xs font-medium text-[var(--accent)]">{parseFloat(p.sale_price).toLocaleString("uk-UA")} ₴</p>}
      </div>
      {barcodeUrl && (
        <div className="border-t border-[var(--border)] p-1.5 flex justify-center print:border-gray-300">
          <img src={barcodeUrl} alt={barcodeText} className="h-12 max-w-full object-contain" />
        </div>
      )}
    </div>
  );
}

function ProductCardsTab() {
  const [products, setProducts] = useState<Product[]>([]);
  const [search,   setSearch]   = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    api<Product[]>("/api/warehouse/products").then(setProducts).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const filtered = search.trim()
    ? products.filter((p) => { const q = search.toLowerCase(); return p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q); })
    : products;

  const printList = selected.size > 0 ? products.filter((p) => selected.has(p.id)) : filtered;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <input type="search" placeholder="Пошук…" value={search}
          onChange={(e) => { setSearch(e.target.value); setSelected(new Set()); }}
          className="h-9 w-52 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 text-sm outline-none placeholder:text-[var(--text-faint)] focus:border-[var(--accent)]" />
        {filtered.length > 0 && <>
          <button onClick={() => setSelected(selected.size === filtered.length ? new Set() : new Set(filtered.map((p) => p.id)))}
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)]">
            {selected.size === filtered.length ? "Зняти всі" : "Вибрати всі"}
          </button>
          <button onClick={() => window.print()}
            className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-white hover:opacity-90">
            🖨 Друк ({printList.length})
          </button>
        </>}
      </div>
      {loading ? <p className="text-sm text-[var(--text-muted)]">Завантаження…</p> : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 print:grid-cols-3 print:gap-2">
          {(selected.size > 0 ? products.filter((p) => selected.has(p.id)) : filtered).map((p) => (
            <div key={p.id} onClick={() => setSelected((prev) => { const n = new Set(prev); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; })}
              className={["cursor-pointer rounded-xl transition-all print:cursor-default",
                selected.size > 0 && !selected.has(p.id) ? "opacity-30 print:opacity-100" : "",
                selected.has(p.id) ? "ring-2 ring-[var(--accent)]" : "",
              ].join(" ")}>
              <ProductCardItem p={p} />
            </div>
          ))}
          {filtered.length === 0 && <p className="col-span-full text-sm text-[var(--text-faint)]">Нічого не знайдено</p>}
        </div>
      )}
    </div>
  );
}

// ── Tab: Filament (spool) labels ──────────────────────────────────────────────

function SpoolCard({ f }: { f: Filament }) {
  const barcodeText = f.sku || f.label_id || `SPOOL:${f.id}`;
  const barcodeUrl  = useBarcode(barcodeText);
  const pct = Math.min(100, Math.round((f.grams_remaining / 1000) * 100));
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] text-xs print:border print:border-gray-400 print:rounded print:break-inside-avoid">
      {f.hex_color && <div className="h-2 w-full" style={{ background: f.hex_color }} />}
      <div className="flex-1 p-2.5 space-y-1">
        <p className="font-semibold">{f.color}</p>
        <p className="text-[var(--text-faint)]">{[f.brand, f.material].filter(Boolean).join(" · ")}</p>
        {f.sku && <p className="font-mono text-[10px] text-[var(--text-faint)]">{f.sku}</p>}
        <div className="mt-1 flex items-center gap-1.5">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-hi)]">
            <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${pct}%` }} />
          </div>
          <span className="tabular-nums text-[10px] text-[var(--text-faint)]">{f.grams_remaining}г</span>
        </div>
      </div>
      {barcodeUrl && (
        <div className="border-t border-[var(--border)] p-1.5 flex justify-center">
          <img src={barcodeUrl} alt={barcodeText} className="h-10 max-w-full object-contain" />
        </div>
      )}
    </div>
  );
}

function SpoolLabelsTab() {
  const [spools,   setSpools]   = useState<Filament[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    api<Filament[]>("/api/materials").then(setSpools).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const printList = selected.size > 0 ? spools.filter((f) => selected.has(f.id)) : spools;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 print:hidden">
        {spools.length > 0 && <>
          <button onClick={() => setSelected(selected.size === spools.length ? new Set() : new Set(spools.map((f) => f.id)))}
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)]">
            {selected.size === spools.length ? "Зняти всі" : "Вибрати всі"}
          </button>
          <button onClick={() => window.print()}
            className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-white hover:opacity-90">
            🖨 Друк ({printList.length})
          </button>
        </>}
      </div>
      {loading ? <p className="text-sm text-[var(--text-muted)]">Завантаження…</p> : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 print:grid-cols-4 print:gap-2">
          {(selected.size > 0 ? spools.filter((f) => selected.has(f.id)) : spools).map((f) => (
            <div key={f.id} onClick={() => setSelected((prev) => { const n = new Set(prev); n.has(f.id) ? n.delete(f.id) : n.add(f.id); return n; })}
              className={["cursor-pointer rounded-xl transition-all print:cursor-default",
                selected.size > 0 && !selected.has(f.id) ? "opacity-30 print:opacity-100" : "",
                selected.has(f.id) ? "ring-2 ring-[var(--accent)]" : "",
              ].join(" ")}>
              <SpoolCard f={f} />
            </div>
          ))}
          {spools.length === 0 && <p className="col-span-full text-sm text-[var(--text-faint)]">Немає котушок</p>}
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

type Tab = "scanner" | "cell_labels" | "product_cards" | "spool_labels";

const TABS: { id: Tab; icon: string; label: string }[] = [
  { id: "scanner",       icon: "📷", label: "Сканер" },
  { id: "cell_labels",   icon: "🏷",  label: "Комірки" },
  { id: "product_cards", icon: "📦", label: "Товари" },
  { id: "spool_labels",  icon: "🧵", label: "Котушки" },
];

export default function ScannerPage() {
  usePageTitle("nav.warehouse");
  const [tab, setTab] = useState<Tab>("scanner");

  return (
    <>
      <style>{`
        @media print {
          nav, header, aside, [class*="sidebar"], [class*="topbar"], [class*="Sidebar"], [class*="Topbar"] { display: none !important; }
          .print\\:hidden { display: none !important; }
          @page { margin: 8mm; size: A4; }
        }
      `}</style>

      {/* Tab bar — hidden when printing */}
      <div className="mb-5 flex gap-1 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-1 print:hidden">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={["flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-medium transition-all",
              tab === t.id ? "bg-[var(--accent)] text-white shadow-sm" : "text-[var(--text-muted)] hover:bg-[var(--surface-hi)]",
            ].join(" ")}>
            <span>{t.icon}</span>
            <span className="hidden sm:inline">{t.label}</span>
          </button>
        ))}
      </div>

      {tab === "scanner"       && <ScannerTab />}
      {tab === "cell_labels"   && <CellLabelsTab />}
      {tab === "product_cards" && <ProductCardsTab />}
      {tab === "spool_labels"  && <SpoolLabelsTab />}
    </>
  );
}
