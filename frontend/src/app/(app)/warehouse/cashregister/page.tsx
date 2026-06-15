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

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
    </svg>
  );
}

function CartIcon({ count }: { count: number }) {
  return (
    <span className="relative inline-flex">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/>
        <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
      </svg>
      {count > 0 && (
        <span className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--accent)] text-[10px] font-bold text-white">
          {count}
        </span>
      )}
    </span>
  );
}

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function CashRegisterPage() {
  const [panel, setPanel]               = useState<"products" | "cart">("products");
  const [q, setQ]                       = useState("");
  const [products, setProducts]         = useState<Product[]>([]);
  const [total, setTotal]               = useState(0);
  const [loading, setLoading]           = useState(false);
  const [cart, setCart]                 = useState<CartItem[]>([]);
  const [warehouses, setWarehouses]     = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId]   = useState<number | null>(null);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [bankAccountId, setBankAccountId] = useState<number | null>(null);
  const [selling, setSelling]           = useState(false);
  const [receipt, setReceipt]           = useState<Receipt | null>(null);
  const inFlight                        = useRef(false);
  const searchRef                       = useRef<HTMLInputElement>(null);

  const cartTotal = cart.reduce((s, i) => s + i.qty * i.unit_price, 0);
  const cartCount = cart.reduce((s, i) => s + i.qty, 0);

  // Load warehouses + bank accounts once
  useEffect(() => {
    api<Warehouse[]>("/api/warehouse/warehouses").then((list) => {
      setWarehouses(list);
      if (list.length === 1) setWarehouseId(list[0].id);
    }).catch(() => {});
    api<BankAccount[]>("/api/warehouse/bank-accounts").then((list) => {
      setBankAccounts(list.filter((a) => a.status === "open"));
      if (list.filter((a) => a.status === "open").length === 1) {
        setBankAccountId(list.filter((a) => a.status === "open")[0].id);
      }
    }).catch(() => {});
  }, []);

  // Search products with debounce
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
    }, 250);
    return () => clearTimeout(id);
  }, [q, warehouseId]);

  const addToCart = useCallback((p: Product) => {
    setCart((prev) => {
      const existing = prev.find((i) => i.product_id === p.id);
      if (existing) {
        return prev.map((i) =>
          i.product_id === p.id ? { ...i, qty: i.qty + 1 } : i
        );
      }
      return [
        ...prev,
        {
          product_id: p.id,
          name: p.name,
          unit: p.unit,
          qty: 1,
          unit_price: p.sale_price ?? 0,
        },
      ];
    });
  }, []);

  const setItemQty = (product_id: number, qty: number) => {
    if (qty <= 0) {
      setCart((prev) => prev.filter((i) => i.product_id !== product_id));
    } else {
      setCart((prev) =>
        prev.map((i) => (i.product_id === product_id ? { ...i, qty } : i))
      );
    }
  };

  const setItemPrice = (product_id: number, price: number) => {
    setCart((prev) =>
      prev.map((i) => (i.product_id === product_id ? { ...i, unit_price: price } : i))
    );
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
      // Refresh bank account balances
      api<BankAccount[]>("/api/warehouse/bank-accounts").then((list) => {
        setBankAccounts(list.filter((a) => a.status === "open"));
      }).catch(() => {});
    } catch (e: unknown) {
      const msg = (e as { detail?: string })?.detail ?? "Помилка продажу";
      alert(msg);
    } finally {
      inFlight.current = false;
      setSelling(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-[calc(100dvh-112px)] flex-col overflow-hidden -mx-6 -mt-5">

      {/* ── Receipt flash ─────────────────────────────────────────────────── */}
      {receipt && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-2xl bg-[var(--bg-elevated)] p-6 shadow-xl">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[var(--state-ok)]/15 mx-auto">
              <CheckIcon />
            </div>
            <p className="text-center text-lg font-semibold text-[var(--text)]">Продано!</p>
            <p className="mt-1 text-center text-3xl font-bold text-[var(--text)]">
              {receipt.total.toFixed(2)} ₴
            </p>
            <div className="mt-4 divide-y divide-[var(--border)] text-sm">
              {receipt.items.map((it, idx) => (
                <div key={idx} className="flex justify-between py-1.5">
                  <span className="text-[var(--text-muted)]">{it.product_name} × {it.qty}</span>
                  <span className="font-medium text-[var(--text)]">{it.total.toFixed(2)} ₴</span>
                </div>
              ))}
            </div>
            <button
              className="btn btn-primary mt-5 w-full"
              onClick={() => setReceipt(null)}
            >
              Закрити
            </button>
          </div>
        </div>
      )}

      {/* ── Top controls ──────────────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 flex flex-wrap gap-2 items-center">
        {/* Warehouse selector */}
        <select
          value={warehouseId ?? ""}
          onChange={(e) => setWarehouseId(e.target.value ? Number(e.target.value) : null)}
          className="input h-8 min-w-0 flex-1 text-sm"
        >
          <option value="">Склад...</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </select>

        {/* Bank account selector */}
        <select
          value={bankAccountId ?? ""}
          onChange={(e) => setBankAccountId(e.target.value ? Number(e.target.value) : null)}
          className="input h-8 min-w-0 flex-1 text-sm"
        >
          <option value="">Рахунок (необов'язково)</option>
          {bankAccounts.map((a) => (
            <option key={a.id} value={a.id}>{a.name} · {a.balance.toFixed(0)} ₴</option>
          ))}
        </select>

        {/* Mobile cart toggle */}
        <button
          className="lg:hidden shrink-0 flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 h-8 text-sm font-medium text-[var(--text-muted)] hover:bg-[var(--surface-hi)] transition-colors"
          onClick={() => setPanel((p) => (p === "cart" ? "products" : "cart"))}
        >
          <CartIcon count={cartCount} />
          {cartTotal > 0 && (
            <span className="font-semibold text-[var(--text)]">{cartTotal.toFixed(0)} ₴</span>
          )}
        </button>
      </div>

      {/* ── Two-panel layout ──────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── LEFT: Product list ─────────────────────────────────────────── */}
        <div className={[
          "flex flex-col overflow-hidden border-r border-[var(--border)]",
          "w-full lg:w-[58%]",
          panel === "cart" ? "hidden lg:flex" : "flex",
        ].join(" ")}>

          {/* Search */}
          <div className="shrink-0 p-3">
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-faint)]">
                <SearchIcon />
              </span>
              <input
                ref={searchRef}
                type="search"
                placeholder="Назва, SKU, штрих-код..."
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="input w-full pl-9 h-10"
              />
            </div>
          </div>

          {/* Product grid */}
          <div className="flex-1 overflow-y-auto px-3 pb-3">
            {loading && products.length === 0 && (
              <p className="py-10 text-center text-sm text-[var(--text-faint)]">Завантаження...</p>
            )}
            {!loading && products.length === 0 && (
              <p className="py-10 text-center text-sm text-[var(--text-faint)]">Нічого не знайдено</p>
            )}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3">
              {products.map((p) => {
                const inCart = cart.find((i) => i.product_id === p.id);
                return (
                  <button
                    key={p.id}
                    onClick={() => {
                      addToCart(p);
                      if (window.innerWidth < 1024) setPanel("cart");
                    }}
                    className={[
                      "relative flex flex-col rounded-xl border p-3 text-left transition-all active:scale-95",
                      inCart
                        ? "border-[var(--accent)] bg-[var(--accent)]/8"
                        : "border-[var(--border)] bg-[var(--bg-elevated)] hover:border-[var(--accent)]/40 hover:bg-[var(--surface-hi)]",
                    ].join(" ")}
                  >
                    {/* Image or placeholder */}
                    {p.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.image_url} alt={p.name} className="mb-2 h-16 w-full rounded-lg object-cover" />
                    ) : (
                      <div className="mb-2 flex h-16 w-full items-center justify-center rounded-lg bg-[var(--surface-hi)] text-2xl text-[var(--text-faint)]">
                        📦
                      </div>
                    )}

                    <span className="line-clamp-2 text-xs font-medium leading-tight text-[var(--text)]">
                      {p.name}
                    </span>
                    <span className="mt-0.5 text-[11px] text-[var(--text-faint)]">{p.sku}</span>

                    <div className="mt-1.5 flex items-center justify-between">
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
                      <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--accent)] text-[10px] font-bold text-white">
                        {inCart.qty}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {!loading && total > products.length && (
              <p className="mt-3 text-center text-xs text-[var(--text-faint)]">
                Показано {products.length} з {total} — уточніть пошук
              </p>
            )}
          </div>
        </div>

        {/* ── RIGHT: Cart / Чек ──────────────────────────────────────────── */}
        <div className={[
          "flex flex-col overflow-hidden bg-[var(--bg-elevated)]",
          "w-full lg:w-[42%]",
          panel === "products" ? "hidden lg:flex" : "flex",
        ].join(" ")}>

          <div className="shrink-0 flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
            <span className="font-semibold text-[var(--text)]">Чек</span>
            {cart.length > 0 && (
              <button
                onClick={() => setCart([])}
                className="text-xs text-[var(--text-faint)] hover:text-[var(--state-error)] transition-colors"
              >
                Очистити
              </button>
            )}
          </div>

          {/* Cart items */}
          <div className="flex-1 overflow-y-auto p-3">
            {cart.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                <CartIcon count={0} />
                <p className="text-sm text-[var(--text-faint)]">Оберіть товар ліворуч</p>
              </div>
            ) : (
              <div className="space-y-2">
                {cart.map((item) => (
                  <div key={item.product_id} className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm font-medium leading-snug text-[var(--text)] flex-1 min-w-0">
                        {item.name}
                      </span>
                      <button
                        onClick={() => setItemQty(item.product_id, 0)}
                        className="shrink-0 text-[var(--text-faint)] hover:text-[var(--state-error)] transition-colors"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                      </button>
                    </div>

                    <div className="mt-2 flex items-center gap-2">
                      {/* Qty controls */}
                      <div className="flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]">
                        <button
                          onClick={() => setItemQty(item.product_id, item.qty - 1)}
                          className="flex h-7 w-7 items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
                        >−</button>
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={item.qty}
                          onChange={(e) => setItemQty(item.product_id, Number(e.target.value))}
                          className="w-10 bg-transparent text-center text-sm font-medium text-[var(--text)] focus:outline-none"
                        />
                        <button
                          onClick={() => setItemQty(item.product_id, item.qty + 1)}
                          className="flex h-7 w-7 items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
                        >+</button>
                      </div>

                      <span className="text-xs text-[var(--text-faint)]">{item.unit}</span>

                      <span className="mx-1 text-[var(--text-faint)]">×</span>

                      {/* Price input */}
                      <div className="relative flex-1">
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          value={item.unit_price}
                          onChange={(e) => setItemPrice(item.product_id, Number(e.target.value))}
                          className="input h-7 w-full pr-5 text-right text-sm"
                        />
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-[var(--text-faint)]">₴</span>
                      </div>
                    </div>

                    <div className="mt-1.5 text-right text-sm font-semibold text-[var(--text)]">
                      = {(item.qty * item.unit_price).toFixed(2)} ₴
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Footer: total + sell button */}
          <div className="shrink-0 border-t border-[var(--border)] p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-[var(--text-muted)]">До сплати</span>
              <span className="text-2xl font-bold text-[var(--text)]">{cartTotal.toFixed(2)} ₴</span>
            </div>

            <button
              onClick={handleSell}
              disabled={cart.length === 0 || selling}
              className="btn btn-primary w-full h-12 text-base font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {selling ? "Продаємо..." : "Продати"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
