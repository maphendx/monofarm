"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Mail, Lock, User, Building2, ArrowRight } from "lucide-react";

import { ApiError, api, getToken, setToken } from "@/lib/api";
import { useT } from "@/lib/i18n";
import AuthLayout from "@/components/ui/AuthLayout";

interface TokenResponse {
  access_token: string;
  token_type: string;
}

function passwordScore(pw: string): 0 | 1 | 2 | 3 | 4 {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 8) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return Math.max(1, s) as 0 | 1 | 2 | 3 | 4;
}

const PW_LABELS = ["Використайте літери, цифри та символи","Слабкий пароль","Можна надійніше","Добрий пароль","Надійний пароль"];
const PW_COLORS = ["var(--text-faint)","var(--state-error)","var(--state-warn)","var(--accent)","var(--state-ok)"];

export default function RegisterPage() {
  const router = useRouter();
  const t = useT();
  const [orgName,    setOrgName]    = useState("");
  const [adminName,  setAdminName]  = useState("");
  const [email,      setEmail]      = useState("");
  const [password,   setPassword]   = useState("");
  const [showPw,     setShowPw]     = useState(false);
  const [terms,      setTerms]      = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const [busy,       setBusy]       = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    if (getToken()) router.replace("/dashboard");
  }, [router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setBusy(true);
    try {
      const data = await api<TokenResponse>("/api/orgs/register", {
        method: "POST",
        body: JSON.stringify({
          org_name: orgName,
          admin_name: adminName,
          admin_email: email,
          admin_password: password,
        }),
      });
      setToken(data.access_token);
      router.replace("/onboarding");
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError(t("errors.networkError"));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const score = passwordScore(password);

  return (
    <AuthLayout activeTab="register">
      <form onSubmit={onSubmit}>
        <h1 style={{ fontSize: "22px", fontWeight: 600, color: "var(--text-hi)", letterSpacing: "-.02em", margin: "0 0 5px" }}>
          Створити робочий простір
        </h1>
        <p style={{ fontSize: "13px", color: "var(--text-muted)", margin: "0 0 20px" }}>
          14 днів безкоштовно. Без прив&apos;язки картки.
        </p>

        {/* Farm name */}
        <FieldWrap label={t("auth.farmName")} style={{ marginBottom: "13px" }}>
          <div className="auth-input-wrap">
            <Building2 size={15} style={{ color: "var(--text-faint)", flexShrink: 0 }} />
            <input type="text" required minLength={2} value={orgName} onChange={(e) => setOrgName(e.target.value)}
              placeholder="My 3D Farm" autoFocus style={inputStyle} />
          </div>
        </FieldWrap>

        {/* Full name */}
        <FieldWrap label={t("auth.name")} style={{ marginBottom: "13px" }}>
          <div className="auth-input-wrap">
            <User size={15} style={{ color: "var(--text-faint)", flexShrink: 0 }} />
            <input type="text" required value={adminName} onChange={(e) => setAdminName(e.target.value)}
              placeholder="Влад Левченко" autoComplete="name" style={inputStyle} />
          </div>
        </FieldWrap>

        {/* Email */}
        <FieldWrap label={t("auth.email")} style={{ marginBottom: "13px" }}>
          <div className="auth-input-wrap">
            <Mail size={15} style={{ color: "var(--text-faint)", flexShrink: 0 }} />
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@monofarm.ua" autoComplete="email" style={inputStyle} />
          </div>
        </FieldWrap>

        {/* Password + strength meter */}
        <FieldWrap label={t("auth.password")} style={{ marginBottom: "13px" }}>
          <div className="auth-input-wrap">
            <Lock size={15} style={{ color: "var(--text-faint)", flexShrink: 0 }} />
            <input type={showPw ? "text" : "password"} required minLength={8} value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Мінімум 8 символів" autoComplete="new-password" style={inputStyle} />
            <button type="button" onClick={() => setShowPw((v) => !v)}
              style={{ color: "var(--text-faint)", cursor: "pointer", display: "flex", background: "none", border: "none", padding: "2px" }}
              aria-label={showPw ? "Приховати пароль" : "Показати пароль"}>
              {showPw ? <EyeOff size={15}/> : <Eye size={15}/>}
            </button>
          </div>
          <div style={{ display: "flex", gap: "4px", marginTop: "8px" }}>
            {[1,2,3,4].map((i) => (
              <div key={i} style={{
                height: "3px", flex: 1, borderRadius: "2px",
                background: password && score >= i ? PW_COLORS[score] : "var(--surface-hi)",
                transition: "background var(--dur-base)",
              }}/>
            ))}
          </div>
          <div className="font-mono" style={{ fontSize: "11px", color: PW_COLORS[score], marginTop: "6px" }}>
            {PW_LABELS[score]}
          </div>
        </FieldWrap>

        {/* Terms */}
        <div
          role="checkbox"
          aria-checked={terms}
          tabIndex={0}
          onClick={() => setTerms((v) => !v)}
          onKeyDown={(e) => e.key === " " && setTerms((v) => !v)}
          style={{ display: "flex", alignItems: "center", gap: "9px", fontSize: "12.5px", color: "var(--text-muted)", margin: "4px 0 18px", cursor: "pointer", userSelect: "none" }}
        >
          <div style={{
            width: "17px", height: "17px", borderRadius: "5px",
            border: terms ? "1px solid var(--accent)" : "1px solid var(--border-strong)",
            background: terms ? "var(--accent)" : "var(--surface-2)",
            flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
            transition: "background 80ms, border-color 80ms",
          }}>
            {terms && (
              <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                <path d="M1 4l3 3 5-6" stroke="#052e2b" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </div>
          <span>
            Приймаю{" "}
            <a href="#" style={{ color: "var(--accent)", textDecoration: "none" }} onClick={(e) => e.stopPropagation()}>умови</a>
            {" "}та{" "}
            <a href="#" style={{ color: "var(--accent)", textDecoration: "none" }} onClick={(e) => e.stopPropagation()}>політику даних</a>
          </span>
        </div>

        {error && <p style={{ fontSize: "13px", color: "var(--state-error)", marginBottom: "12px" }}>{error}</p>}

        <button type="submit" disabled={busy} className="btn btn-primary btn-lg"
          style={{ width: "100%", gap: "8px", opacity: busy ? 0.6 : 1 }}>
          {busy ? t("auth.registering") : "Створити робочий простір"}
          {!busy && <ArrowRight size={15}/>}
        </button>

        <p style={{ textAlign: "center", fontSize: "12.5px", color: "var(--text-muted)", marginTop: "22px" }}>
          Вже є акаунт?{" "}
          <Link href="/login" style={{ color: "var(--accent)", fontWeight: 500, textDecoration: "none" }}>
            Увійти
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

function FieldWrap({ label, children, style }: { label: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={style}>
      <div style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-muted)", marginBottom: "7px" }}>{label}</div>
      {children}
    </div>
  );
}
