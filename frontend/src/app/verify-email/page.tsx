"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle, XCircle, Loader } from "lucide-react";

import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import AuthLayout from "@/components/ui/AuthLayout";

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
    <AuthLayout>
      <div style={{ textAlign: "center" }}>
        {status === "loading" && (
          <>
            <Loader size={36} style={{ color: "var(--accent)", marginBottom: "16px", animation: "spin 1s linear infinite" }} />
            <p style={{ fontSize: "14px", color: "var(--text-muted)" }}>{t("common.loading")}</p>
          </>
        )}
        {status === "ok" && (
          <>
            <CheckCircle size={40} style={{ color: "var(--state-ok)", marginBottom: "16px" }} />
            <h1 style={{ fontSize: "22px", fontWeight: 600, color: "var(--text-hi)", letterSpacing: "-.02em", margin: "0 0 8px" }}>
              Email підтверджено
            </h1>
            <p style={{ fontSize: "13px", color: "var(--text-muted)", margin: "0 0 24px" }}>
              Ваш акаунт активовано. Можна увійти.
            </p>
            <Link href="/dashboard" className="btn btn-primary btn-lg" style={{ textDecoration: "none" }}>
              {t("nav.dashboard")}
            </Link>
          </>
        )}
        {status === "error" && (
          <>
            <XCircle size={40} style={{ color: "var(--state-error)", marginBottom: "16px" }} />
            <h1 style={{ fontSize: "22px", fontWeight: 600, color: "var(--text-hi)", letterSpacing: "-.02em", margin: "0 0 8px" }}>
              Невалідне посилання
            </h1>
            <p style={{ fontSize: "13px", color: "var(--text-muted)", margin: "0 0 24px" }}>
              {t("auth.resetInvalid")}
            </p>
            <Link href="/dashboard" style={{ color: "var(--accent)", fontSize: "13px", fontWeight: 500, textDecoration: "none" }}>
              {t("nav.dashboard")}
            </Link>
          </>
        )}
      </div>
    </AuthLayout>
  );
}
