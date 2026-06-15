"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { api } from "@/lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

type Product = {
  id: number;
  name: string;
  sku: string;
  barcode: string | null;
  sale_price: number | null;
  unit: string;
  image_url: string | null;
  stock_qty: number;
};

type BankAccount = {
  id: number;
  name: string;
  status: string;
  balance: number;
};

type Warehouse = {
  id: number;
  name: string;
};

type CartItem = {
  product_id: number;
  name: string;
  unit: string;
  qty: number;
  unit_price: number;
};

type Receipt = {
  total: number;
  items: { product_name: string; qty: number; unit_price: number; total: number }[];
  cash_tx_id: number | null;
  created_at: string;
};

// ── Icons ─────────────────────────────────────────────────────────────────────

function BackIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5m7-7-7 7 7 7"/>
    </svg>
  );
}

function ScanIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/>
      <line x1="8" y1="12" x2="8" y2="12.01"/><line x1="12" y1="12" x2="12" y2="12.01"/><line x1="16" y1="12" x2="16" y2="12.01"/>
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );
}

function XIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function CashRegisterPage() {
  const [panel, setPanel]                 = useState<"products" | "cart">("products");
  const [q, setQ]                         = useState("");
  const [products, setProducts]           = useState<Product[]>([]);
  const [total, setTotal]                 = useState(0);
  const [loading, setLoading]             = useState(false);
  const [cart, setCart]                   = useState<CartItem[]>([]);
  const [warehouses, setWarehouses]       = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId]     = useState<number | null>(null);
  const [bankAccounts, setBankAccounts]   = useState<BankAccount[]>([]);
  const [bankAccountId, setBankAccountId] = useState<number | null>(null);
  const [selling, setSelling]             = useState(false);
  const [receipt, setReceipt]             = useState<Receipt | null>(null);
  const [scanFlash, setScanFlash]         = useState<string | null>(null);

  const inFlight  = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const cartTotal = cart.reduce((s, i) => s + i.qty * i.unit_price, 0);
  const cartCount = cart.reduce((s, i) => s + i.qty, 0);

  // Focus search on mount
  useEffect(() => { searchRef.current?.focus(); }, []);

  // Load warehouses + bank accounts
  useEffect(() => {
    api<Warehouse[]>("/api/warehouse/warehouses").then((list) => {
      setWarehouses(list);
      if (list.length === 1) setWarehouseId(list[0].id);
    }).catch(() => {});
    api<BankAccount[]>("/api/warehouse/bank-accounts").then((list) => {
      const open = list.filter((a) => a.status === "open");
      setBankAccounts(open);
      if (open.length === 1) setBankAccountId(open[0].id);
    }).catch(() => {});
  }, []);

  // Debounced product search
  useEffect(() => {
    const id = setTimeout(() => {
      setLoading(true);
      const params = new URLSearchParams({ limit: "40" });
      if (q) params.set("q", q);
      if (warehouseId) params.set("warehouse_id", String(warehouseId));
      api<{ total: number; items: Product[] }>(`/api/warehouse/cashregister/products?${params}`)
        .then((r) => { setProducts(r.items); setTotal(r.total); })
        .catch(() => {})
        .finally(() => setLoading(false));
    }, 220);
    return () => clearTimeout(id);
  }, [q, warehouseId]);

  const addToCart = useCallback((p: Product, qty = 1) => {
    setCart((prev) => {
      const existing = prev.find((i) => i.product_id === p.id);
      if (existing) {
        return prev.map((i) =>
          i.product_id === p.id ? { ...i, qty: i.qty + qty } : i
        );
      }
      return [...prev, {
        product_id: p.id,
        name: p.name,
        unit: p.unit,
        qty,
        unit_price: p.sale_price ?? 0,
      }];
    });
  }, []);

  // Barcode scanner: Enter in search field → immediate lookup → auto-add
  async function handleScanEnter() {
    const code = q.trim();
    if (!code) return;
    try {
      const params = new URLSearchParams({ q: code, limit: "5" });
      if (warehouseId) params.set("warehouse_id", String(warehouseId));
      const r = await api<{ items: Product[] }>(`/api/warehouse/cashregister/products?${params}`);
      const exact = r.items.find(
        (p) => p.barcode === code || p.sku === code || p.name.toLowerCase() === code.toLowerCase()
      ) ?? (r.items.length === 1 ? r.items[0] : null);
      if (exact) {
        addToCart(exact);
        setQ("");
        setScanFlash(exact.name);
        setTimeout(() => setScanFlash(null), 1200);
        searchRef.current?.focus();
      }
    } catch { /* ignore */ }
  }

  const setItemQty = (product_id: number, qty: number) => {
    if (qty <= 0) {
      setCart((prev) => prev.filter((i) => i.product_id !== product_id));
    } else {
      setCart((prev) => prev.map((i) => i.product_id === product_id ? { ...i, qty } : i));
    }
  };

  const setItemPrice = (product_id: number, price: number) => {
    setCart((prev) => prev.map((i) => i.product_id === product_id ? { ...i, unit_price: price } : i));
  };

  async function handleSell() {
    if (inFlight.current || cart.length === 0) return;
    if (!warehouseId) { alert("Оберіть склад"); return; }
    inFlight.current = true;
    setSelling(true);
    try {
      const r = await api<Receipt>("/api/warehouse/cashregister/sell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          warehouse_id:    warehouseId,
          bank_account_id: bankAccountId,
          items: cart.map((i) => ({
            product_id: i.product_id,
            qty:        i.qty,
            unit_price: i.unit_price,
          })),
        }),
      });
      setReceipt(r);
      setCart([]);
      setPanel("products");
      api<BankAccount[]>("/api/warehouse/bank-accounts").then((list) => {
        setBankAccounts(list.filter((a) => a.status === "open"));
      }).catch(() => {});
    } catch (e: unknown) {
      alert((e as { detail?: string })?.detail ?? "Помилка продажу");
    } finally {
      inFlight.current = false;
      setSelling(false);
    }
  }

  function closeReceipt() {
    setReceipt(null);
    setTimeout(() => searchRef.current?.focus(), 100);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-[calc(100dvh-112px)] flex-col overflow-hidden -mx-6 -mt-5">

      {/* ── Receipt modal ──────────────────────────────────────────────────── */}
      {receipt && (
        <div className="absolute inset-0 z-50 flex items-end justify-center sm:items-center bg-black/50 p-0 sm:p-4">
          <div className="w-full max-w-sm rounded-t-3xl sm:rounded-2xl bg-[var(--bg-elevated)] p-6 shadow-2xl">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[var(--state-ok)]/15 mx-auto text-[var(--state-ok)]">
              <CheckIcon />
            </div>
            <p className="text-center text-xl font-semibold">Продано!</p>
            <p className="mt-1 text-center text-4xl font-bold tabular-nums">{receipt.total.toFixed(2)} ₴</p>
            <div className="mt-5 divide-y divide-[var(--border)] text-sm max-h-48 overflow-y-auto">
              {receipt.items.map((it, idx) => (
                <div key={idx} className="flex justify-between py-2">
                  <span className="text-[var(--text-muted)]">{it.product_name} × {it.qty}</span>
                  <span className="font-medium tabular-nums">{it.total.toFixed(2)} ₴</span>
                </div>
              ))}
            </div>
            <button className="btn btn-primary mt-5 w-full h-12 text-base" onClick={closeReceipt}>
              Новий продаж
            </button>
          </div>
        </div>
      )}

      {/* ── Scan flash ─────────────────────────────────────────────────────── */}
      {scanFlash && (
        <div className="absolute top-14 left-1/2 z-40 -translate-x-1/2 max-w-xs w-[90%]">
          <div className="flex items-center gap-2.5 rounded-xl bg-[var(--state-ok)] px-4 py-3 shadow-lg text-white text-sm font-medium">
            <CheckIcon />
            <span className="truncate">{scanFlash}</span>
          </div>
        </div>
      )}

      {/* ── Top bar ────────────────────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-[var(--border)] bg-[var(--bg-elevated)] px-3 pt-2 pb-2 space-y-2">
        {/* Selectors row */}
        <div className="flex gap-2">
          <select
            value={warehouseId ?? ""}
            onChange={(e) => setWarehouseId(e.target.value ? Number(e.target.value) : null)}
            className="input h-9 flex-1 min-w-0 text-sm"
          >
            <option value="">Склад...</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <select
            value={bankAccountId ?? ""}
            onChange={(e) => setBankAccountId(e.target.value ? Number(e.target.value) : null)}
            className="input h-9 flex-1 min-w-0 text-sm"
          >
            <option value="">Рахунок</option>
            {bankAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>

        {/* Search / barcode row */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-faint)]">
              <ScanIcon />
            </span>
            <input
              ref={searchRef}
              type="search"
              inputMode="none"
              placeholder="Сканер або пошук..."
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); handleScanEnter(); }
              }}
              className="input w-full pl-10 h-11 text-base"
              autoComplete="off"
              autoCorrect="off"
            />
            {q && (
              <button
                onClick={() => { setQ(""); searchRef.current?.focus(); }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-faint)]"
              >
                <XIcon size={15} />
              </button>
            )}
          </div>

          {/* Cart toggle button */}
          <button
            onClick={() => setPanel((p) => p === "cart" ? "products" : "cart")}
            className={[
              "lg:hidden shrink-0 relative flex h-11 min-w-[64px] items-center justify-center gap-1.5 rounded-xl border px-3 text-sm font-semibold transition-colors",
              cartCount > 0
                ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                : "border-[var(--border)] text-[var(--text-muted)]",
            ].join(" ")}
          >
            {cartCount > 0 ? (
              <>
                <span className="tabular-nums">{cartCount}</span>
                <span className="text-xs font-normal opacity-80">·</span>
                <span className="tabular-nums text-xs">{cartTotal.toFixed(0)} ₴</span>
              </>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/>
                <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* ── Two-panel layout ──────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── LEFT: Products ─────────────────────────────────────────────── */}
        <div className={[
          "flex flex-col overflow-hidden",
          "w-full lg:w-[58%] lg:border-r lg:border-[var(--border)]",
          panel === "cart" ? "hidden lg:flex" : "flex",
        ].join(" ")}>
          <div className="flex-1 overflow-y-auto px-3 pt-3 pb-3">
            {loading && products.length === 0 && (
              <p className="py-12 text-center text-sm text-[var(--text-faint)]">Завантаження...</p>
            )}
            {!loading && products.length === 0 && (
              <p className="py-12 text-center text-sm text-[var(--text-faint)]">Нічого не знайдено</p>
            )}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3">
              {products.map((p) => {
                const inCart = cart.find((i) => i.product_id === p.id);
                const outOfStock = p.stock_qty <= 0;
                return (
                  <button
                    key={p.id}
                    onClick={() => addToCart(p)}
                    disabled={outOfStock}
                    className={[
                      "relative flex flex-col rounded-xl border p-3 text-left transition-all active:scale-95 disabled:opacity-40",
                      inCart
                        ? "border-[var(--accent)] bg-[var(--accent)]/8"
                        : "border-[var(--border)] bg-[var(--bg-elevated)] hover:border-[var(--accent)]/40",
                    ].join(" ")}
                  >
                    {p.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.image_url} alt={p.name} className="mb-2 h-20 w-full rounded-lg object-cover" />
                    ) : (
                      <div className="mb-2 flex h-20 w-full items-center justify-center rounded-lg bg-[var(--surface-hi)] text-3xl">
                        📦
                      </div>
                    )}
                    <span className="line-clamp-2 text-xs font-semibold leading-tight text-[var(--text)]">{p.name}</span>
                    <span className="mt-0.5 text-[10px] text-[var(--text-faint)]">{p.sku}</span>
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-sm font-bold text-[var(--text)]">
                        {p.sale_price != null ? `${p.sale_price} ₴` : "—"}
                      </span>
                      <span className={[
                        "text-[10px] font-medium",
                        p.stock_qty > 0 ? "text-[var(--state-ok)]" : "text-[var(--state-error)]",
                      ].join(" ")}>
                        {p.stock_qty} {p.unit}
                      </span>
                    </div>
                    {inCart && (
                      <span className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-[var(--accent)] text-[11px] font-bold text-white">
                        {inCart.qty}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {!loading && total > products.length && (
              <p className="mt-3 text-center text-xs text-[var(--text-faint)]">
                {products.length} з {total} — уточніть пошук
              </p>
            )}
          </div>
        </div>

        {/* ── RIGHT: Cart ────────────────────────────────────────────────── */}
        <div className={[
          "flex flex-col overflow-hidden bg-[var(--bg-elevated)]",
          "w-full lg:w-[42%]",
          panel === "products" ? "hidden lg:flex" : "flex",
        ].join(" ")}>

          {/* Cart header */}
          <div className="shrink-0 flex items-center gap-3 border-b border-[var(--border)] px-4 py-3">
            <button
              onClick={() => setPanel("products")}
              className="lg:hidden flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-hi)] active:bg-[var(--surface-hi)]"
            >
              <BackIcon />
            </button>
            <span className="font-semibold flex-1">Чек</span>
            {cart.length > 0 && (
              <button
                onClick={() => setCart([])}
                className="text-xs text-[var(--text-faint)] hover:text-[var(--state-error)]"
              >
                Очистити
              </button>
            )}
          </div>

          {/* Cart items */}
          <div className="flex-1 overflow-y-auto p-3">
            {cart.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" className="text-[var(--text-faint)]" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/>
                  <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
                </svg>
                <p className="text-sm text-[var(--text-faint)]">Відскануйте або оберіть товар</p>
              </div>
            ) : (
              <div className="space-y-2">
                {cart.map((item) => (
                  <div key={item.product_id} className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3">
                    <div className="flex items-start justify-between gap-2">
                      <span className="flex-1 min-w-0 text-sm font-semibold leading-snug">{item.name}</span>
                      <button
                        onClick={() => setItemQty(item.product_id, 0)}
                        className="shrink-0 flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[rgba(239,68,68,.1)] hover:text-[var(--state-error)] active:bg-[rgba(239,68,68,.15)]"
                      >
                        <XIcon size={14} />
                      </button>
                    </div>

                    <div className="mt-2.5 flex items-center gap-2">
                      {/* Qty stepper — large for touch */}
                      <div className="flex items-center rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] overflow-hidden">
                        <button
                          onClick={() => setItemQty(item.product_id, item.qty - 1)}
                          className="flex h-10 w-10 items-center justify-center text-xl font-medium text-[var(--text-muted)] active:bg-[var(--surface-hi)]"
                        >−</button>
                        <input
                          type="number"
                          inputMode="numeric"
                          min={0}
                          step={1}
                          value={item.qty}
                          onChange={(e) => setItemQty(item.product_id, Number(e.target.value))}
                          className="w-10 bg-transparent text-center text-sm font-bold text-[var(--text)] focus:outline-none"
                        />
                        <button
                          onClick={() => setItemQty(item.product_id, item.qty + 1)}
                          className="flex h-10 w-10 items-center justify-center text-xl font-medium text-[var(--text-muted)] active:bg-[var(--surface-hi)]"
                        >+</button>
                      </div>

                      <span className="text-xs text-[var(--text-faint)] shrink-0">{item.unit}</span>
                      <span className="text-[var(--text-faint)] shrink-0">×</span>

                      {/* Price */}
                      <div className="relative flex-1">
                        <input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step={0.01}
                          value={item.unit_price}
                          onChange={(e) => setItemPrice(item.product_id, Number(e.target.value))}
                          className="input h-10 w-full pr-5 text-right text-sm font-medium"
                        />
                        <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-[var(--text-faint)]">₴</span>
                      </div>
                    </div>

                    <div className="mt-1.5 text-right text-base font-bold tabular-nums text-[var(--text)]">
                      = {(item.qty * item.unit_price).toFixed(2)} ₴
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="shrink-0 border-t border-[var(--border)] p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-[var(--text-muted)]">До сплати</span>
              <span className="text-3xl font-bold tabular-nums">{cartTotal.toFixed(2)} ₴</span>
            </div>
            <button
              onClick={handleSell}
              disabled={cart.length === 0 || selling}
              className="btn btn-primary w-full h-14 text-lg font-bold disabled:opacity-40 disabled:cursor-not-allowed rounded-xl"
            >
              {selling ? "Продаємо..." : `Продати · ${cartTotal.toFixed(2)} ₴`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
