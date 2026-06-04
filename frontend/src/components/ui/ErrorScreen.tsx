"use client";

import Link from "next/link";
import { useEffect } from "react";

import { PixelSprite } from "@/components/dashboard/DashboardPet";

/**
 * Branded full-screen error fallback. Shared by app/error.tsx (segment crash)
 * and app/global-error.tsx (root-layout crash). Worried Mono + "Оновити".
 */
export function ErrorScreen({
  error,
  reset,
  code = "MONO-500",
}: {
  error?: Error & { digest?: string };
  reset?: () => void;
  code?: string;
}) {
  useEffect(() => {
    if (error) console.error(error);
  }, [error]);

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center gap-5 bg-[var(--bg)] px-6 py-12 text-center">
      <style>{`
        @keyframes errPulse { 0%,100% { opacity:1; } 50% { opacity:.35; } }
        @keyframes errFloat { 0%,100% { transform: translateY(0) scale(2.4); } 50% { transform: translateY(-6px) scale(2.4); } }
      `}</style>

      <span className="inline-flex items-center gap-2 rounded-full border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-1.5 text-[10.5px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
        <span
          className="size-1.5 rounded-full bg-[var(--state-error)]"
          style={{ boxShadow: "0 0 0 3px rgba(239,68,68,.15)", animation: "errPulse 1.8s ease-out infinite" }}
        />
        Помилка · {code}
      </span>

      <div className="my-2 origin-bottom" style={{ animation: "errFloat 2.8s ease-in-out infinite" }}>
        <PixelSprite hasAlert flip={false} walkFrame={false} antOn waveFrame={false} isWaving={false} />
      </div>

      <div>
        <h1 className="text-2xl font-semibold text-[var(--text-hi)]">Щось пішло не так</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-[var(--text-muted)]">
          Сталася неочікувана помилка. Спробуйте оновити — якщо повторюється, напишіть нам.
        </p>
        {error?.digest && (
          <p className="mt-3 font-mono text-[11px] text-[var(--text-faint)]">код: {error.digest}</p>
        )}
      </div>

      <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
        {reset && (
          <button onClick={reset} className="btn btn-primary">
            ↻ Оновити
          </button>
        )}
        <Link href="/" className="btn btn-ghost">На головну ферму</Link>
      </div>

      <p className="mt-3 font-mono text-[10.5px] tracking-[0.08em] text-[var(--text-dim)]">
        MONOFARM ·{" "}
        <Link href="/support" className="text-[var(--text-faint)] underline-offset-2 hover:text-[var(--accent)]">
          повідомити про збій
        </Link>
      </p>
    </div>
  );
}
