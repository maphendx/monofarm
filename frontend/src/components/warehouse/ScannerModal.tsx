"use client";

/**
 * ScannerModal — universal barcode/QR scanner overlay.
 *
 * Architecture: scan anything → system detects type → shows context actions.
 * Currently handles: cell ↔ product assignment.
 * Extensible: add new scan types / actions by extending ScanResult and ACTION_MAP.
 */

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

type CellStock  = { product_id: number; product_name: string; product_sku: string; quantity: string };
type CellDetail = { cell_id: number; cell_code: string; cell_notes: string | null; zone_name: string; warehouse_name: string; stock: CellStock[] };
type Product    = { id: number; name: string; sku: string; barcode: string | null; unit: string };
type ScanResult = { type: "cell" | "product"; cell?: CellDetail; product?: Product };

// ── Scan state ────────────────────────────────────────────────────────────────

type Phase =
  | { kind: "idle" }
  | { kind: "cell";    cell: CellDetail }
  | { kind: "product"; product: Product }
  | { kind: "both";    cell: CellDetail; product: Product; qty: string }
  | { kind: "done" };

function nextPhase(phase: Phase, result: ScanResult): Phase {
  if (result.type === "cell" && result.cell) {
    if (phase.kind === "product") return { kind: "both", cell: result.cell, product: phase.product, qty: "1" };
    return { kind: "cell", cell: result.cell };
  }
  if (result.type === "product" && result.product) {
    if (phase.kind === "cell") return { kind: "both", cell: phase.cell, product: result.product, qty: "1" };
    return { kind: "product", product: result.product };
  }
  return phase;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function TypeBadge({ type }: { type: "cell" | "product" }) {
  return type === "cell"
    ? <span className="shrink-0 rounded bg-[var(--surface-hi)] px-1.5 py-0.5 text-[10px] text-[var(--accent)]">Комірка</span>
    : <span className="shrink-0 rounded bg-[var(--surface-hi)] px-1.5 py-0.5 text-[10px] text-[var(--state-ok)]">Товар</span>;
}

function phaseLabel(phase: Phase): string {
  switch (phase.kind) {
    case "idle":    return "Відскануй QR комірки або баркод товару";
    case "cell":    return `Тепер відскануй баркод товару → призначити в ${phase.cell.cell_code}`;
    case "product": return `Тепер відскануй QR комірки → помістити ${phase.product.sku}`;
    case "both":    return "";
    case "done":    return "Готово ✓ — скануй наступне";
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ScannerModal({ onClose }: { onClose: () => void }) {
  const inputRef   = useRef<HTMLInputElement>(null);
  const [value,    setValue]   = useState("");
  const [phase,    setPhase]   = useState<Phase>({ kind: "idle" });
  const [loading,  setLoading] = useState(false);
  const [err,      setErr]     = useState<string | null>(null);
  const [busy,     setBusy]    = useState(false);

  useEffect(() => { inputRef.current?.focus(); }, []);

  async function scan(raw: string) {
    const q = raw.trim();
    if (!q) return;
    setValue(""); setLoading(true); setErr(null);
    try {
      const res = await api<ScanResult>(`/api/warehouse/scan?q=${encodeURIComponent(q)}`);
      setPhase((prev) => nextPhase(prev, res));
      if (phase.kind === "done") setPhase({ kind: "done" });
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Не знайдено");
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 80);
    }
  }

  async function assign() {
    if (phase.kind !== "both" || busy) return;
    setBusy(true);
    try {
      await api(`/api/warehouse/cells/${phase.cell.cell_id}/assign`, {
        method: "POST",
        body: JSON.stringify({ product_id: phase.product.id, quantity: parseFloat(phase.qty) || 1 }),
      });
      toast.success(`✓ ${phase.product.name} → ${phase.cell.cell_code}`);
      setPhase({ kind: "done" });
      setTimeout(() => { setPhase({ kind: "idle" }); inputRef.current?.focus(); }, 1200);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Помилка");
    } finally {
      setBusy(false);
      setTimeout(() => inputRef.current?.focus(), 80);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    if (e.key === "Enter" && value.trim()) { e.preventDefault(); scan(value); }
    if (e.key === "Enter" && !value.trim() && phase.kind === "both") assign();
  }

  function reset() { setPhase({ kind: "idle" }); setErr(null); setValue(""); setTimeout(() => inputRef.current?.focus(), 50); }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative mx-4 w-full max-w-[560px] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Input row */}
        <div className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3">
          {loading ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              className="shrink-0 animate-spin text-[var(--accent)]">
              <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-faint)]">
              <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
              <rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3"/><path d="M17 21v-4h4"/><path d="M21 14h-4"/>
            </svg>
          )}
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Скануй QR комірки або баркод товару…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--text-faint)]"
            autoComplete="off"
          />
          {(phase.kind !== "idle" && phase.kind !== "done") && (
            <button onClick={reset}
              className="text-[10px] text-[var(--text-faint)] hover:text-[var(--text)] transition-colors">
              ↺ скинути
            </button>
          )}
          <kbd className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--text-faint)]">esc</kbd>
        </div>

        {/* State area */}
        <div className="min-h-[80px] py-2">

          {/* Scanned items */}
          {(phase.kind === "cell" || phase.kind === "both") && (
            <div className="flex items-center gap-3 px-4 py-2 text-sm">
              <TypeBadge type="cell" />
              <span className="font-mono font-bold text-[var(--accent)]">
                {(phase as { cell: CellDetail }).cell.cell_code}
              </span>
              <span className="truncate text-[var(--text-faint)]">
                {(phase as { cell: CellDetail }).cell.zone_name} · {(phase as { cell: CellDetail }).cell.warehouse_name}
              </span>
              <button onClick={() => setPhase(phase.kind === "both"
                ? { kind: "product", product: phase.product }
                : { kind: "idle" })}
                className="ml-auto shrink-0 text-[10px] text-[var(--text-faint)] hover:text-[var(--state-error)]">×</button>
            </div>
          )}
          {(phase.kind === "product" || phase.kind === "both") && (
            <div className="flex items-center gap-3 px-4 py-2 text-sm">
              <TypeBadge type="product" />
              <span className="font-mono font-bold">
                {(phase as { product: Product }).product.sku}
              </span>
              <span className="truncate text-[var(--text-faint)]">
                {(phase as { product: Product }).product.name}
              </span>
              <button onClick={() => setPhase(phase.kind === "both"
                ? { kind: "cell", cell: phase.cell }
                : { kind: "idle" })}
                className="ml-auto shrink-0 text-[10px] text-[var(--text-faint)] hover:text-[var(--state-error)]">×</button>
            </div>
          )}

          {/* Assign row */}
          {phase.kind === "both" && (
            <div className="flex items-center gap-3 border-t border-[var(--border)] px-4 py-3">
              <span className="text-sm text-[var(--text-muted)]">Кількість</span>
              <input
                type="number" min="0.01" step="1"
                value={phase.qty}
                onChange={(e) => setPhase({ ...phase, qty: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); assign(); } }}
                className="w-20 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-center font-mono text-sm outline-none focus:border-[var(--accent)]"
                autoFocus
              />
              <button onClick={assign} disabled={busy}
                className="flex-1 rounded-lg bg-[var(--accent)] py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">
                {busy ? "…" : "✓ Призначити"}
              </button>
              <kbd className="shrink-0 rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--text-faint)]">↵</kbd>
            </div>
          )}

          {/* Done */}
          {phase.kind === "done" && (
            <div className="px-4 py-4 text-center text-sm text-[var(--state-ok)]">✓ Призначено — скануй наступне</div>
          )}

          {/* Hint */}
          {(phase.kind === "idle" || phase.kind === "cell" || phase.kind === "product") && (
            <p className={["px-4 py-2 text-xs text-[var(--text-faint)]",
              phase.kind !== "idle" ? "border-t border-[var(--border)] animate-pulse" : "",
            ].join(" ")}>
              {phaseLabel(phase)}
            </p>
          )}

          {err && (
            <p className="border-t border-[var(--border)] px-4 py-2 text-xs text-[var(--state-error)]">{err}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-4 border-t border-[var(--border)] px-4 py-2 text-[10px] text-[var(--text-faint)]">
          <span><kbd className="rounded border border-[var(--border)] px-1 py-0.5">↵</kbd> підтвердити</span>
          <span><kbd className="rounded border border-[var(--border)] px-1 py-0.5">esc</kbd> закрити</span>
          <span><kbd className="rounded border border-[var(--border)] px-1 py-0.5">⌘⇧S</kbd> відкрити/закрити</span>
          <span className="ml-auto opacity-60">монофарм · сканер</span>
        </div>
      </div>
    </div>
  );
}
