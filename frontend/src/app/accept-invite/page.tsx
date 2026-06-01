"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { ApiError, api } from "@/lib/api";
import { useT } from "@/lib/i18n";

interface InviteInfo { email: string; org_name: string; valid: boolean }

export default function AcceptInvitePage() {
  const t = useT();
  const router = useRouter();
  const [token, setToken] = useState("");
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const t = sp.get("token") ?? "";
    setToken(t);
    if (!t) { setInfo({ email: "", org_name: "", valid: false }); return; }
    api<InviteInfo>(`/api/auth/invite/${t}`).then(setInfo).catch(() =>
      setInfo({ email: "", org_name: "", valid: false })
    );
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    if (password !== confirm) { setError(t("auth.passwordsDontMatch")); return; }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/accept-invite", {
        method: "POST",
        body: JSON.stringify({ token, password }),
      });
      router.replace("/login?reset=1");
    } catch (err) {
      setError(err instanceof ApiError ? t("auth.inviteInvalid") : t("auth.inviteInvalid"));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (!info) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-16">
        <p className="text-sm text-[var(--text-muted)]">Завантаження…</p>
      </div>
    );
  }

  if (!info.valid) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-16">
        <div className="w-full max-w-sm space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-8">
          <p className="text-sm text-[var(--state-error)]">{t("auth.inviteInvalid")}</p>
          <Link href="/login" className="text-sm underline hover:text-[var(--text-hi)]">
            {t("auth.signIn")}
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
          <h1 className="text-xl font-semibold tracking-tight">{t("auth.inviteTitle")}</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            {info.org_name} · {info.email}
          </p>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-sm">{t("auth.newPassword")}</span>
            <input type="password" required minLength={8} value={password}
              onChange={e => setPassword(e.target.value)}
              className="input" autoComplete="new-password" autoFocus />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm">{t("auth.confirmPassword")}</span>
            <input type="password" required minLength={8} value={confirm}
              onChange={e => setConfirm(e.target.value)}
              className="input" autoComplete="new-password" />
          </label>
        </div>

        {error && <p className="text-sm text-[var(--state-error)]">{error}</p>}

        <button type="submit" disabled={busy} className="btn btn-primary w-full disabled:opacity-50">
          {busy ? t("auth.acceptingInvite") : t("auth.acceptInvite")}
        </button>
      </form>
    </div>
  );
}
