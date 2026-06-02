"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Lock, Eye, EyeOff, ArrowRight } from "lucide-react";

import { ApiError, api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import AuthLayout from "@/components/ui/AuthLayout";

const inputStyle: React.CSSProperties = {
  flex: 1, background: "transparent", border: "none", outline: "none",
  color: "var(--text)", fontSize: "14px", fontFamily: "inherit",
};

export default function ResetPasswordPage() {
  const t = useT();
  const router = useRouter();
  const [token, setToken]       = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm]   = useState("");
  const [showPw, setShowPw]     = useState(false);
  const [showCf, setShowCf]     = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [busy, setBusy]         = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    setToken(sp.get("token") ?? "");
  }, []);

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
    } catch {
      setError(t("auth.resetInvalid"));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (token === "") {
    return (
      <AuthLayout>
        <div>
          <p style={{ fontSize: "13px", color: "var(--state-error)", marginBottom: "16px" }}>{t("auth.resetInvalid")}</p>
          <Link href="/forgot-password" style={{ color: "var(--accent)", fontSize: "13px", textDecoration: "none" }}>
            {t("auth.forgotTitle")}
          </Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <form onSubmit={onSubmit}>
        <h1 style={{ fontSize: "22px", fontWeight: 600, color: "var(--text-hi)", letterSpacing: "-.02em", margin: "0 0 5px" }}>
          {t("auth.resetTitle")}
        </h1>
        <p style={{ fontSize: "13px", color: "var(--text-muted)", margin: "0 0 24px" }}>
          Введіть новий пароль для вашого акаунта.
        </p>

        <div style={{ marginBottom: "15px" }}>
          <div style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-muted)", marginBottom: "7px" }}>{t("auth.newPassword")}</div>
          <div className="auth-input-wrap">
            <Lock size={15} style={{ color: "var(--text-faint)", flexShrink: 0 }} />
            <input type={showPw ? "text" : "password"} required minLength={8}
              value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder="Мінімум 8 символів" autoComplete="new-password" autoFocus style={inputStyle} />
            <button type="button" onClick={() => setShowPw((v) => !v)}
              style={{ color: "var(--text-faint)", cursor: "pointer", display: "flex", background: "none", border: "none", padding: "2px" }}
              aria-label={showPw ? "Приховати пароль" : "Показати пароль"}>
              {showPw ? <EyeOff size={15}/> : <Eye size={15}/>}
            </button>
          </div>
        </div>

        <div style={{ marginBottom: "20px" }}>
          <div style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-muted)", marginBottom: "7px" }}>{t("auth.confirmPassword")}</div>
          <div className="auth-input-wrap">
            <Lock size={15} style={{ color: "var(--text-faint)", flexShrink: 0 }} />
            <input type={showCf ? "text" : "password"} required minLength={8}
              value={confirm} onChange={(e) => setConfirm(e.target.value)}
              placeholder="Повторіть пароль" autoComplete="new-password" style={inputStyle} />
            <button type="button" onClick={() => setShowCf((v) => !v)}
              style={{ color: "var(--text-faint)", cursor: "pointer", display: "flex", background: "none", border: "none", padding: "2px" }}
              aria-label={showCf ? "Приховати пароль" : "Показати пароль"}>
              {showCf ? <EyeOff size={15}/> : <Eye size={15}/>}
            </button>
          </div>
        </div>

        {error && <p style={{ fontSize: "13px", color: "var(--state-error)", marginBottom: "12px" }}>{error}</p>}

        <button type="submit" disabled={busy} className="btn btn-primary btn-lg"
          style={{ width: "100%", gap: "8px", opacity: busy ? 0.6 : 1 }}>
          {busy ? t("auth.savingPassword") : t("auth.savePassword")}
          {!busy && <ArrowRight size={15}/>}
        </button>
      </form>
    </AuthLayout>
  );
}
