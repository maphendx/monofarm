"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";

type CellStock  = { product_id: number; product_name: string; product_sku: string; quantity: string };
type CellDetail = { cell_id: number; cell_code: string; cell_notes: string | null; zone_name: string; warehouse_name: string; stock: CellStock[] };
type Product    = { id: number; name: string; sku: string; barcode: string | null; unit: string };
type ScanResult = { type: "cell" | "product"; cell?: CellDetail; product?: Product };

export function ScannerPanel({ onClose }: { onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value,     setValue]     = useState("");
  const [loading,   setLoading]   = useState(false);
  const [err,       setErr]       = useState<string | null>(null);
  const [cell,      setCell]      = useState<CellDetail | null>(null);
  const [prod,      setProd]      = useState<Product | null>(null);
  const [qty,       setQty]       = useState("1");
  const [assigning, setAssigning] = useState(false);

  const focus = useCallback(() => inputRef.current?.focus(), []);
  useEffect(() => { setTimeout(focus, 100); }, [focus]);

  async function scan(raw: string) {
    const q = raw.trim();
    if (!q) return;
    setValue(""); setLoading(true); setErr(null);
    try {
      const res = await api<ScanResult>(`/api/warehouse/scan?q=${encodeURIComponent(q)}`);
      if (res.type === "cell" && res.cell)       setCell(res.cell);
      else if (res.type === "product" && res.product) setProd(res.product);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Не знайдено");
    } finally { setLoading(false); setTimeout(focus, 80); }
  }

  async function assign() {
    if (!cell || !prod || assigning) return;
    setAssigning(true);
    try {
      await api(`/api/warehouse/cells/${cell.cell_id}/assign`, {
        method: "POST",
        body: JSON.stringify({ product_id: prod.id, quantity: parseFloat(qty) || 1 }),
      });
      toast.success(`✓ ${prod.name} → ${cell.cell_code}`);
      setCell(null); setProd(null); setQty("1");
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : "Помилка"); }
    finally { setAssigning(false); setTimeout(focus, 80); }
  }

  return (
    <>
      {/* backdrop */}
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />

      {/* panel */}
      <div className="fixed right-0 top-0 z-50 flex h-full w-full max-w-sm flex-col border-l border-[var(--border)] bg-[var(--bg-elevated)] shadow-2xl">

        {/* header */}
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <div>
            <p className="font-semibold text-sm">Сканер</p>
            <p className="text-[11px] text-[var(--text-faint)]">Скануй комірку та товар у будь-якому порядку</p>
          </div>
          <button onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[var(--surface-hi)]">
            ✕
          </button>
        </div>

        {/* hidden scanner input */}
        <input ref={inputRef} value={value} className="sr-only" autoComplete="off" inputMode="none"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); scan(value); } }} />

        <div className="flex-1 overflow-y-auto p-4 space-y-3">

          {/* cell card */}
          <div onClick={() => { setTimeout(focus, 50); }}
            className={["rounded-xl border-2 p-4 transition-all cursor-pointer",
              cell ? "border-[var(--state-ok)] bg-[var(--state-ok)]/5" : "border-dashed border-[var(--border-strong)]",
            ].join(" ")}>
            <p className="text-[10px] font-bold tracking-widest text-[var(--text-faint)] mb-1">КОМІРКА</p>
            {cell ? (
              <>
                <p className="font-mono text-2xl font-bold text-[var(--state-ok)]">{cell.cell_code}</p>
                <p className="text-xs text-[var(--text-muted)]">{cell.zone_name} · {cell.warehouse_name}</p>
                {cell.stock.length > 0 && (
                  <div className="mt-2 space-y-0.5">
                    {cell.stock.map((s) => (
                      <p key={s.product_id} className="text-[11px] text-[var(--text-faint)]">
                        {s.product_sku} — {parseFloat(s.quantity)} {" "}{s.product_name}
                      </p>
                    ))}
                  </div>
                )}
                <button onClick={(e) => { e.stopPropagation(); setCell(null); }}
                  className="mt-2 text-[10px] text-[var(--text-faint)] hover:text-[var(--state-error)]">
                  × очистити
                </button>
              </>
            ) : (
              <p className="text-sm text-[var(--text-faint)]">Відскануй QR комірки</p>
            )}
          </div>

          {/* product card */}
          <div onClick={() => { setTimeout(focus, 50); }}
            className={["rounded-xl border-2 p-4 transition-all cursor-pointer",
              prod ? "border-[var(--state-ok)] bg-[var(--state-ok)]/5" : "border-dashed border-[var(--border-strong)]",
            ].join(" ")}>
            <p className="text-[10px] font-bold tracking-widest text-[var(--text-faint)] mb-1">ТОВАР</p>
            {prod ? (
              <>
                <p className="font-mono text-sm font-bold">{prod.sku}</p>
                <p className="text-sm text-[var(--text-muted)]">{prod.name}</p>
                <button onClick={(e) => { e.stopPropagation(); setProd(null); }}
                  className="mt-1 text-[10px] text-[var(--text-faint)] hover:text-[var(--state-error)]">
                  × очистити
                </button>
              </>
            ) : (
              <p className="text-sm text-[var(--text-faint)]">Відскануй баркод товару</p>
            )}
          </div>

          {/* status */}
          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-4 py-2.5 text-center text-sm">
            {loading ? <span className="text-[var(--text-muted)]">Шукаю…</span>
              : err   ? <span className="text-[var(--state-error)]">{err}</span>
              : !cell && !prod ? <span className="text-[var(--text-faint)]">Готовий — скануй будь-що</span>
              : !cell ? <span className="animate-pulse text-[var(--accent)]">Тепер відскануй QR комірки…</span>
              : !prod ? <span className="animate-pulse text-[var(--accent)]">Тепер відскануй товар…</span>
              : <span className="text-[var(--state-ok)] font-medium">Готово до призначення ↓</span>}
          </div>

          {/* assign */}
          {cell && prod && (
            <div className="rounded-xl border border-[var(--state-ok)]/30 bg-[var(--state-ok)]/5 p-4 space-y-2">
              <p className="text-sm font-medium">
                <span className="text-[var(--text-muted)]">{prod.name}</span>
                <span className="mx-2 text-[var(--text-faint)]">→</span>
                <span className="font-mono">{cell.cell_code}</span>
              </p>
              <div className="flex gap-2">
                <input type="number" min="0.01" step="1" value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  onClick={(e) => e.stopPropagation()} onFocus={(e) => e.stopPropagation()}
                  className="w-24 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-center font-mono text-lg outline-none focus:border-[var(--accent)]" />
                <button onClick={assign} disabled={assigning}
                  className="flex-1 rounded-lg bg-[var(--state-ok)] py-2 font-semibold text-white hover:opacity-90 disabled:opacity-50">
                  {assigning ? "…" : "✓ Призначити"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
