"use client";

import { usePageTitle } from "@/lib/usePageTitle";

// ── Налаштування контактів — заміни на свої ────────────────────────────────────
const SUPPORT_EMAIL    = "support@monofarm.app";    // TODO: робочий email на домені

export default function SupportPage() {
  usePageTitle("nav.support");

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-[var(--text-hi)]">Підтримка</h1>

      {/* Toolbar — like Printforge: filter left, new-message right */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-1.5 text-sm text-[var(--text-muted)]">
            Усі звернення
          </span>
          <span className="text-sm text-[var(--text-faint)]">0 звернень</span>
        </div>
        <a href={`mailto:${SUPPORT_EMAIL}`} className="btn btn-primary btn-sm">
          Написати email
        </a>
      </div>

      {/* Empty state */}
      <div className="flex min-h-[340px] flex-col items-center justify-center gap-4 rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-8 text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-[var(--surface-hi)] text-[var(--text-faint)]">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-medium text-[var(--text)]">Поки що немає звернень</p>
          <p className="mt-1 text-sm text-[var(--text-muted)]">Потрібна допомога? Напишіть нам на email — відповідаємо протягом доби.</p>
        </div>
        <a href={`mailto:${SUPPORT_EMAIL}`} className="btn btn-primary">
          Надіслати email
        </a>
      </div>
    </div>
  );
}
