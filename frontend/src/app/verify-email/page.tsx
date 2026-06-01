"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";

export default function VerifyEmailPage() {
  const t = useT();
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const token = sp.get("token") ?? "";
    if (!token) { setStatus("error"); return; }
    api("/api/auth/verify-email", { method: "POST", body: JSON.stringify({ token }) })
      .then(() => setStatus("ok"))
      .catch(() => setStatus("error"));
  }, []);

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-8 shadow-sm">
        {status === "loading" && <p className="text-sm text-[var(--text-muted)]">{t("common.loading")}</p>}
        {status === "ok" && (
          <>
            <p className="text-sm text-[var(--state-ok)]">✓ Email підтверджено!</p>
            <Link href="/dashboard" className="btn btn-primary block text-center">{t("nav.dashboard")}</Link>
          </>
        )}
        {status === "error" && (
          <>
            <p className="text-sm text-[var(--state-error)]">{t("auth.resetInvalid")}</p>
            <Link href="/dashboard" className="text-sm underline hover:text-[var(--text-hi)]">{t("nav.dashboard")}</Link>
          </>
        )}
      </div>
    </div>
  );
}
