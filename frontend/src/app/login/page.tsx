"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Mail, Lock, ArrowRight } from "lucide-react";

import { ApiError, api, getToken, setToken } from "@/lib/api";
import { useT } from "@/lib/i18n";
import AuthLayout from "@/components/ui/AuthLayout";

interface TokenResponse {
  access_token: string;
  token_type: string;
}

export default function LoginPage() {
  const router = useRouter();
  const t = useT();
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw]     = useState(false);
  const [remember, setRemember] = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [info, setInfo]         = useState<string | null>(null);
  const [busy, setBusy]         = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    if (getToken()) router.replace("/dashboard");
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("reset") === "1") setInfo(t("auth.resetSuccess"));
  }, [router, t]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setBusy(true);
    try {
      const data = await api<TokenResponse>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setToken(data.access_token);
      router.replace("/dashboard");
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError(t("errors.networkError"));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <AuthLayout activeTab="login">
      <form onSubmit={onSubmit}>
        <h1 style={{ fontSize: "22px", fontWeight: 600, color: "var(--text-hi)", letterSpacing: "-.02em", margin: "0 0 5px" }}>
          З поверненням
        </h1>
        <p style={{ fontSize: "13px", color: "var(--text-muted)", margin: "0 0 24px" }}>
          {t("auth.loginSubtitle")}
        </p>

        {/* Email */}
        <div style={{ marginBottom: "15px" }}>
          <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "12px", fontWeight: 500, color: "var(--text-muted)", marginBottom: "7px" }}>
            {t("auth.email")}
          </label>
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
              style={inputStyle}
            />
          </div>
        </div>

        {/* Password */}
        <div style={{ marginBottom: "15px" }}>
          <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "12px", fontWeight: 500, color: "var(--text-muted)", marginBottom: "7px" }}>
            {t("auth.password")}
            <Link href="/forgot-password" style={{ fontSize: "11.5px", color: "var(--accent)", textDecoration: "none", whiteSpace: "nowrap" }}>
              {t("auth.forgotPassword")}
            </Link>
          </label>
          <div className="auth-input-wrap">
            <Lock size={15} style={{ color: "var(--text-faint)", flexShrink: 0 }} />
            <input
              type={showPw ? "text" : "password"}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              style={inputStyle}
            />
            <button
              type="button"
              onClick={() => setShowPw((v) => !v)}
              style={{ color: "var(--text-faint)", cursor: "pointer", display: "flex", background: "none", border: "none", padding: "2px" }}
              aria-label={showPw ? "Приховати пароль" : "Показати пароль"}
            >
              {showPw ? <EyeOff size={15}/> : <Eye size={15}/>}
            </button>
          </div>
        </div>

        {/* Remember me */}
        <div
          role="checkbox"
          aria-checked={remember}
          tabIndex={0}
          onClick={() => setRemember((v) => !v)}
          onKeyDown={(e) => e.key === " " && setRemember((v) => !v)}
          style={{ display: "flex", alignItems: "center", gap: "9px", fontSize: "12.5px", color: "var(--text-muted)", margin: "4px 0 20px", cursor: "pointer", userSelect: "none" }}
        >
          <div style={{
            width: "17px", height: "17px", borderRadius: "5px",
            border: remember ? "1px solid var(--accent)" : "1px solid var(--border-strong)",
            background: remember ? "var(--accent)" : "var(--surface-2)",
            flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
            transition: "background 80ms, border-color 80ms",
          }}>
            {remember && (
              <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                <path d="M1 4l3 3 5-6" stroke="#052e2b" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </div>
          Запам&apos;ятати на цьому пристрої
        </div>

        {info  && <p style={{ fontSize: "13px", color: "var(--state-ok)",    marginBottom: "12px" }}>{info}</p>}
        {error && <p style={{ fontSize: "13px", color: "var(--state-error)", marginBottom: "12px" }}>{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="btn btn-primary btn-lg"
          style={{ width: "100%", gap: "8px", opacity: busy ? 0.6 : 1 }}
        >
          {busy ? t("auth.loggingIn") : t("auth.loginBtn")}
          {!busy && <ArrowRight size={15}/>}
        </button>

        <p style={{ textAlign: "center", fontSize: "12.5px", color: "var(--text-muted)", marginTop: "22px" }}>
          Немає акаунта?{" "}
          <Link href="/register" style={{ color: "var(--accent)", fontWeight: 500, textDecoration: "none" }}>
            Створити робочий простір
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}

const inputStyle: React.CSSProperties = {
  flex: 1, background: "transparent", border: "none", outline: "none",
  color: "var(--text)", fontSize: "14px", fontFamily: "inherit",
};
