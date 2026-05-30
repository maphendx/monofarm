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
  step, label, main, sub, done, active,
}: { step: number; label: string; main?: string; sub?: string; done: boolean; active: boolean }) {
  return (
    <div
      className={[
        "flex items-center gap-3.5 rounded-xl border px-4 py-3.5 transition-colors",
        active
          ? "border-[var(--accent)] bg-[var(--accent-soft)]"
          : "border-[var(--border)] bg-[var(--surface)]",
      ].join(" ")}
    >
      {/* Step number / check */}
      <div
        className={[
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
          done
            ? "bg-[var(--state-ok)] text-white"
            : active
              ? "bg-[var(--accent)] text-[var(--bg-elevated)]"
              : "bg-[var(--surface-hi)] text-[var(--text-faint)]",
        ].join(" ")}
      >
        {done ? "✓" : step}
      </div>

      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-faint)]">{label}</div>
        {main ? (
          <>
            <div className="truncate font-mono text-base font-semibold text-[var(--text)]">{main}</div>
            {sub && <div className="truncate text-sm text-[var(--text-muted)]">{sub}</div>}
          </>
        ) : (
          <div className="text-sm text-[var(--text-faint)]">
            {active ? "Піднеси сканер сюди →" : "очікує сканування"}
          </div>
        )}
      </div>
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
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[10vh]" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative w-full max-w-[640px] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-2xl"
        onClick={(e) => { e.stopPropagation(); inputRef.current?.focus(); }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
          <div className="flex items-center gap-2.5">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round" className="text-[var(--accent)]">
              <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
              <rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3"/><path d="M17 21v-4h4"/><path d="M21 14h-4"/>
            </svg>
            <h2 className="text-lg font-semibold text-[var(--text)]">Сканер складу</h2>
          </div>
          <button onClick={onClose} className="btn btn-ghost btn-icon" aria-label="Закрити">✕</button>
        </div>

        <div className="px-6 py-5">
          {/* Hero scan field */}
          <div className="relative">
            <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2">
              {loading ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  className="animate-spin text-[var(--accent)]">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                </svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-faint)]">
                  <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
                  <rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3"/><path d="M17 21v-4h4"/><path d="M21 14h-4"/>
                </svg>
              )}
            </span>
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Піднеси сканер до коду…"
              className="h-14 w-full rounded-xl border border-[var(--border-strong)] bg-[var(--surface)] pl-12 pr-4 text-lg text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-dim)] focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_var(--accent-ring)]"
              autoComplete="off"
            />
          </div>

          {/* State area */}
          {phase.kind === "done" ? (
            <div className="py-10 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[var(--state-ok)] text-2xl text-white">✓</div>
              <p className="mt-3 text-lg font-semibold text-[var(--state-ok)]">Готово!</p>
              <p className="text-sm text-[var(--text-muted)]">Можна сканувати наступне</p>
            </div>
          ) : (
            <>
              {/* Two steps — always visible */}
              <div className="mt-5 space-y-2.5">
                <StepRow
                  step={1} label="Комірка"
                  main={cell?.cell_code}
                  sub={cell ? `${cell.zone_name} · ${cell.warehouse_name}` : undefined}
                  done={!!cell}
                  active={!cell && (target === "cell" || target === "any")}
                />
                <StepRow
                  step={2} label="Товар"
                  main={product?.sku}
                  sub={product?.name}
                  done={!!product}
                  active={!product && (target === "product" || target === "any")}
                />
              </div>

              {/* Quantity + confirm */}
              {phase.kind === "both" ? (
                <div className="mt-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-4">
                  <div className="flex flex-wrap items-center gap-4">
                    <label className="shrink-0 text-base font-medium text-[var(--text)]">Скільки штук?</label>
                    {/* Touch-friendly stepper — number stays tappable for manual entry */}
                    <div className="flex items-center gap-1.5">
                      <button type="button" aria-label="Менше"
                        onClick={() => setPhase({ ...phase, qty: String(Math.max(1, (parseFloat(phase.qty) || 1) - 1)) })}
                        className="flex h-11 w-11 items-center justify-center rounded-lg border border-[var(--border-strong)] bg-[var(--surface-2)] text-xl text-[var(--text-muted)] hover:bg-[var(--surface-hi)] active:scale-95">
                        −
                      </button>
                      <input
                        type="number" min="1" step="1" inputMode="numeric"
                        value={phase.qty}
                        onChange={(e) => setPhase({ ...phase, qty: e.target.value })}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); assign(); } }}
                        className="h-11 w-20 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-2)] text-center font-mono text-lg text-[var(--text-hi)] outline-none focus:border-[var(--accent)] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                      />
                      <button type="button" aria-label="Більше"
                        onClick={() => setPhase({ ...phase, qty: String((parseFloat(phase.qty) || 1) + 1) })}
                        className="flex h-11 w-11 items-center justify-center rounded-lg border border-[var(--border-strong)] bg-[var(--surface-2)] text-xl text-[var(--text-muted)] hover:bg-[var(--surface-hi)] active:scale-95">
                        +
                      </button>
                    </div>
                    <button onClick={assign} disabled={busy} className="btn btn-primary h-11 min-w-[200px] flex-1 text-base">
                      {busy ? "Зберігаю…" : "Призначити в комірку"}
                    </button>
                  </div>
                </div>
              ) : (
                /* Instruction line */
                <div className="mt-4 flex items-center justify-between gap-3">
                  <p className="text-base font-medium text-[var(--text)]">{instructionText(phase)}</p>
                  {canClear && (
                    <button onClick={reset} className="btn btn-ghost shrink-0">Очистити</button>
                  )}
                </div>
              )}

              {err && (
                <div className="mt-4 rounded-xl border border-[var(--state-error)]/30 bg-[var(--state-error)]/5 px-4 py-3 text-sm font-medium text-[var(--state-error)]">
                  {err}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer — plain reassurance, no keyboard jargon */}
        <div className="border-t border-[var(--border)] px-6 py-3 text-center text-[13px] text-[var(--text-faint)]">
          Піднеси сканер DS6878 до коду — він зчитається сам
        </div>
      </div>
    </div>
  );
}
