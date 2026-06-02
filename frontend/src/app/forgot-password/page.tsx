"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Mail, ArrowRight, CheckCircle } from "lucide-react";

import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import AuthLayout from "@/components/ui/AuthLayout";

export default function ForgotPasswordPage() {
  const t = useT();
  const [email, setEmail] = useState("");
  const [sent, setSent]   = useState(false);
  const [busy, setBusy]   = useState(false);
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
      // always show neutral message (anti-enumeration)
    } finally {
      inFlight.current = false;
      setBusy(false);
      setSent(true);
    }
  }

  return (
    <AuthLayout>
      {sent ? (
        <div style={{ textAlign: "center" }}>
          <CheckCircle size={40} style={{ color: "var(--state-ok)", marginBottom: "16px" }} />
          <h1 style={{ fontSize: "22px", fontWeight: 600, color: "var(--text-hi)", letterSpacing: "-.02em", margin: "0 0 8px" }}>
            Лист надіслано
          </h1>
          <p style={{ fontSize: "13px", color: "var(--text-muted)", margin: "0 0 24px", lineHeight: 1.6 }}>
            {t("auth.resetSent")}
          </p>
          <Link href="/login" className="btn btn-secondary" style={{ textDecoration: "none" }}>
            {t("auth.signIn")}
          </Link>
        </div>
      ) : (
        <form onSubmit={onSubmit}>
          <h1 style={{ fontSize: "22px", fontWeight: 600, color: "var(--text-hi)", letterSpacing: "-.02em", margin: "0 0 5px" }}>
            {t("auth.forgotTitle")}
          </h1>
          <p style={{ fontSize: "13px", color: "var(--text-muted)", margin: "0 0 24px" }}>
            {t("auth.forgotSubtitle")}
          </p>

          <div style={{ marginBottom: "20px" }}>
            <div style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-muted)", marginBottom: "7px" }}>
              {t("auth.email")}
            </div>
            <div className="auth-input-wrap">
              <Mail size={15} style={{ color: "var(--text-faint)", flexShrink: 0 }} />
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@monofarm.ua"
                autoComplete="email"
                autoFocus
                style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "var(--text)", fontSize: "14px", fontFamily: "inherit" }}
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={busy}
            className="btn btn-primary btn-lg"
            style={{ width: "100%", gap: "8px", opacity: busy ? 0.6 : 1 }}
          >
            {busy ? t("auth.sendingResetLink") : t("auth.sendResetLink")}
            {!busy && <ArrowRight size={15}/>}
          </button>

          <p style={{ textAlign: "center", fontSize: "12.5px", color: "var(--text-muted)", marginTop: "22px" }}>
            <Link href="/login" style={{ color: "var(--accent)", fontWeight: 500, textDecoration: "none" }}>
              {t("auth.signIn")}
            </Link>
          </p>
        </form>
      )}
    </AuthLayout>
  );
}
