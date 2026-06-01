"use client";

import { useRef, useState } from "react";
import Link from "next/link";

import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";

export default function ForgotPasswordPage() {
  const t = useT();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await api("/api/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
    } catch {
      // always show the same neutral message (anti-enumeration)
    } finally {
      inFlight.current = false;
      setBusy(false);
      setSent(true);
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm space-y-5 rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-8 shadow-sm">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t("auth.forgotTitle")}</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">{t("auth.forgotSubtitle")}</p>
        </div>

        {sent ? (
          <p className="rounded-lg bg-[var(--surface-hi)] px-4 py-3 text-sm">
            {t("auth.resetSent")}
          </p>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <label className="block">
              <span className="mb-1 block text-sm">{t("auth.email")}</span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input"
                autoComplete="email"
                autoFocus
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="btn btn-primary w-full disabled:opacity-50"
            >
              {busy ? t("auth.sendingResetLink") : t("auth.sendResetLink")}
            </button>
          </form>
        )}

        <p className="text-center text-sm text-[var(--text-muted)]">
          <Link href="/login" className="underline hover:text-[var(--text-hi)]">
            {t("auth.signIn")}
          </Link>
        </p>
      </div>
    </div>
  );
}
