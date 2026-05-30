"use client";

/**
 * ScannerModal — universal barcode/QR scanner overlay.
 *
 * Architecture: scan anything → system detects type → shows context actions.
 * Currently handles: cell ↔ product assignment.
 * Extensible: add new scan types / actions by extending ScanResult and ACTION_MAP.
 *
 * UX target: a non-technical warehouse keeper using a DS6878 handheld scanner
 * (keyboard-wedge — types the code + Enter into the focused field). Big-enough,
 * plain-language steps; no keyboard shortcuts to remember.
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

// ── Derived view helpers ────────────────────────────────────────────────────────

function cellOf(phase: Phase): CellDetail | null {
  return phase.kind === "cell" || phase.kind === "both" ? phase.cell : null;
}
function productOf(phase: Phase): Product | null {
  return phase.kind === "product" || phase.kind === "both" ? phase.product : null;
}

/** What the keeper should scan next — drives the highlighted step + instruction. */
function nextTarget(phase: Phase): "cell" | "product" | "any" | null {
  const cell = cellOf(phase), product = productOf(phase);
  if (cell && product) return null;
  if (cell) return "product";
  if (product) return "cell";
  return "any";
}

function instructionText(phase: Phase): string {
  switch (nextTarget(phase)) {
    case "any":     return "Скануй комірку, потім товар (можна навпаки)";
    case "product": return "Тепер скануй товар";
    case "cell":    return "Тепер скануй комірку";
    default:        return "";
  }
}

// ── Step row ──────────────────────────────────────────────────────────────────

function StepRow({
  kind, label, main, sub, active,
}: { kind: "cell" | "product"; label: string; main?: string; sub?: string; active: boolean }) {
  return (
    <div
      className={[
        "flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors",
        active
          ? "border-[var(--accent)] bg-[var(--accent-weak)]"
          : "border-[var(--border)] bg-[var(--surface)]",
      ].join(" ")}
    >
      <span className={kind === "cell" ? "badge badge-accent" : "badge badge-ok"}>{label}</span>
      {main ? (
        <div className="min-w-0">
          <div className="truncate font-mono text-base font-semibold text-[var(--text)]">{main}</div>
          {sub && <div className="truncate text-sm text-[var(--text-muted)]">{sub}</div>}
        </div>
      ) : (
        <span className="text-sm text-[var(--text-faint)]">
          {active ? "← піднеси сканер сюди" : "очікує сканування"}
        </span>
      )}
    </div>
  );
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
      setTimeout(() => { setPhase({ kind: "idle" }); inputRef.current?.focus(); }, 1400);
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

  const cell = cellOf(phase);
  const product = productOf(phase);
  const target = nextTarget(phase);
  const canClear = phase.kind !== "idle" && phase.kind !== "done";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative mx-4 w-full max-w-[560px] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-2xl"
        onClick={(e) => { e.stopPropagation(); inputRef.current?.focus(); }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-3">
          <div className="flex items-center gap-2.5">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round" className="text-[var(--accent)]">
              <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
              <rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3"/><path d="M17 21v-4h4"/><path d="M21 14h-4"/>
            </svg>
            <h2 className="text-base font-semibold text-[var(--text)]">Сканер складу</h2>
          </div>
          <button onClick={onClose} className="btn btn-ghost">Закрити</button>
        </div>

        {/* Input row */}
        <div className="flex items-center gap-3 px-5 pt-4">
          {loading ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              className="shrink-0 animate-spin text-[var(--accent)]">
              <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
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
            placeholder="Піднеси сканер до коду…"
            className="input text-base"
            autoComplete="off"
          />
        </div>

        {/* State area */}
        <div className="px-5 pb-4 pt-3">
          {phase.kind === "done" ? (
            <div className="py-6 text-center">
              <div className="text-2xl text-[var(--state-ok)]">✓</div>
              <p className="mt-1 text-base font-semibold text-[var(--state-ok)]">Готово!</p>
              <p className="text-sm text-[var(--text-muted)]">Можна сканувати наступне</p>
            </div>
          ) : (
            <>
              {/* Two steps — always visible */}
              <div className="space-y-2">
                <StepRow
                  kind="cell" label="Комірка"
                  main={cell?.cell_code}
                  sub={cell ? `${cell.zone_name} · ${cell.warehouse_name}` : undefined}
                  active={target === "cell" || target === "any"}
                />
                <StepRow
                  kind="product" label="Товар"
                  main={product?.sku}
                  sub={product?.name}
                  active={target === "product" || target === "any"}
                />
              </div>

              {/* Quantity + confirm */}
              {phase.kind === "both" ? (
                <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="shrink-0 text-sm font-medium text-[var(--text-muted)]">Скільки штук?</label>
                    {/* Touch-friendly stepper — number stays tappable for manual entry */}
                    <div className="flex items-center gap-1">
                      <button type="button" aria-label="Менше"
                        onClick={() => setPhase({ ...phase, qty: String(Math.max(1, (parseFloat(phase.qty) || 1) - 1)) })}
                        className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border-strong)] bg-[var(--surface-2)] text-lg text-[var(--text-muted)] hover:bg-[var(--surface-hi)] active:scale-95">
                        −
                      </button>
                      <input
                        type="number" min="1" step="1" inputMode="numeric"
                        value={phase.qty}
                        onChange={(e) => setPhase({ ...phase, qty: e.target.value })}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); assign(); } }}
                        className="h-9 w-16 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-2)] text-center font-mono text-base text-[var(--text-hi)] outline-none focus:border-[var(--accent)] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                      />
                      <button type="button" aria-label="Більше"
                        onClick={() => setPhase({ ...phase, qty: String((parseFloat(phase.qty) || 1) + 1) })}
                        className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border-strong)] bg-[var(--surface-2)] text-lg text-[var(--text-muted)] hover:bg-[var(--surface-hi)] active:scale-95">
                        +
                      </button>
                    </div>
                    <button onClick={assign} disabled={busy} className="btn btn-primary btn-lg min-w-[180px] flex-1">
                      {busy ? "Зберігаю…" : "Призначити в комірку"}
                    </button>
                  </div>
                </div>
              ) : (
                /* Instruction line */
                <div className="mt-3 flex items-center justify-between gap-3">
                  <p className="text-[15px] font-medium text-[var(--text)]">{instructionText(phase)}</p>
                  {canClear && (
                    <button onClick={reset} className="btn btn-ghost shrink-0">Очистити</button>
                  )}
                </div>
              )}

              {err && (
                <div className="mt-3 rounded-lg border border-[var(--border)] px-3 py-2.5 text-sm font-medium text-[var(--state-error)]">
                  {err}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer — plain reassurance, no keyboard jargon */}
        <div className="border-t border-[var(--border)] px-5 py-2.5 text-center text-[13px] text-[var(--text-faint)]">
          Піднеси сканер DS6878 до коду — він зчитається сам
        </div>
      </div>
    </div>
  );
}
