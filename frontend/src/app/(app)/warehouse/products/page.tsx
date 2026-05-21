"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

type Product = {
  id:          number;
  name:        string;
  sku:         string;
  categories:  string[];
  unit:        string;
  sale_price:  string | null;
  direct_cost: string | null;
  full_cost:   string | null;
  is_active:   boolean;
};

function fmtPrice(v: string | null) {
  return v ? `${parseFloat(v).toFixed(2)} ₴` : "—";
}

function fmtMargin(sale: string | null, cost: string | null) {
  if (!sale || !cost || parseFloat(sale) === 0) return null;
  const m = ((parseFloat(sale) - parseFloat(cost)) / parseFloat(sale)) * 100;
  return m.toFixed(0) + "%";
}

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [search,   setSearch]   = useState("");
  const [category, setCategory] = useState("Всі");

  const load = useCallback(async () => {
    try { setProducts(await api<Product[]>("/api/warehouse/products")); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const allCategories = ["Всі", ...Array.from(new Set(products.flatMap((p) => p.categories)))];

  const filtered = products.filter((p) => {
    if (category !== "Всі" && !p.categories.includes(category)) return false;
    if (search && !p.name.toLowerCase().includes(search.toLowerCase()) && !p.sku.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  if (loading) return <div className="text-sm text-neutral-500">Завантаження…</div>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <input type="search" placeholder="Назва або артикул…" value={search} onChange={(e) => setSearch(e.target.value)}
            className="rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200" />
          <div className="flex gap-1">
            {allCategories.map((c) => (
              <button key={c} onClick={() => setCategory(c)}
                className={["rounded-md px-2.5 py-1.5 text-xs transition-colors",
                  category === c
                    ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                    : "border border-neutral-200 text-neutral-600 hover:border-neutral-400 dark:border-neutral-800 dark:text-neutral-400",
                ].join(" ")}>
                {c}
              </button>
            ))}
          </div>
        </div>
        <button className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900">
          + Номенклатура
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wider text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
            <tr>
              <th className="px-4 py-3 font-medium">Назва</th>
              <th className="px-4 py-3 font-medium">Артикул</th>
              <th className="px-4 py-3 font-medium">Категорія</th>
              <th className="px-4 py-3 font-medium text-right">Собів.</th>
              <th className="px-4 py-3 font-medium text-right">Ціна</th>
              <th className="px-4 py-3 font-medium text-right">Маржа</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {filtered.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-neutral-400">Нічого не знайдено</td></tr>
            ) : (
              filtered.map((p) => {
                const margin = fmtMargin(p.sale_price, p.full_cost);
                return (
                  <tr key={p.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-800/50">
                    <td className="px-4 py-3 font-medium">
                      <Link href={`/warehouse/products/${p.id}`} className="hover:text-cyan-600 dark:hover:text-cyan-400">
                        {p.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-neutral-500">{p.sku}</td>
                    <td className="px-4 py-3">
                      {p.categories.map((c) => (
                        <span key={c} className="mr-1 rounded-full bg-neutral-100 px-2 py-0.5 text-xs dark:bg-neutral-800">{c}</span>
                      ))}
                    </td>
                    <td className="px-4 py-3 text-right text-neutral-500">{fmtPrice(p.full_cost)}</td>
                    <td className="px-4 py-3 text-right font-medium">{fmtPrice(p.sale_price)}</td>
                    <td className="px-4 py-3 text-right">
                      {margin ? (
                        <span className={parseFloat(margin) >= 50 ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}>
                          {margin}
                        </span>
                      ) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link href={`/warehouse/products/${p.id}`} className="rounded p-1 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800">✎</Link>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
