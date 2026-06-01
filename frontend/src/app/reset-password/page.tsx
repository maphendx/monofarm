"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { ApiError, api } from "@/lib/api";
import { useT } from "@/lib/i18n";

export default function ResetPasswordPage() {
  const t = useT();
  const router = useRouter();
  const [token, setToken] = useState("");

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    setToken(sp.get("token") ?? "");
  }, []);

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    if (password !== confirm) { setError(t("auth.passwordsDontMatch")); return; }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token, new_password: password }),
      });
      router.replace("/login?reset=1");
    } catch (err) {
      setError(err instanceof ApiError ? t("auth.resetInvalid") : t("auth.resetInvalid"));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-16">
        <div className="w-full max-w-sm space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-8 shadow-sm">
          <p className="text-sm text-[var(--state-error)]">{t("auth.resetInvalid")}</p>
          <Link href="/forgot-password" className="text-sm underline hover:text-[var(--text-hi)]">
            {t("auth.forgotTitle")}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm space-y-5 rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-8 shadow-sm"
      >
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t("auth.resetTitle")}</h1>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-sm">{t("auth.newPassword")}</span>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input"
              autoComplete="new-password"
              autoFocus
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm">{t("auth.confirmPassword")}</span>
            <input
              type="password"
              required
              minLength={8}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="input"
              autoComplete="new-password"
            />
          </label>
        </div>

        {error && <p className="text-sm text-[var(--state-error)]">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="btn btn-primary w-full disabled:opacity-50"
        >
          {busy ? t("auth.savingPassword") : t("auth.savePassword")}
        </button>
      </form>
    </div>
  );
}
