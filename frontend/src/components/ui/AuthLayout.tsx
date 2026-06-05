"use client";

import Link from "next/link";

const MINI_PRINTERS: Array<"print" | "ok" | "err" | "idle"> = [
  "print","print","print","print","print","print",
  "print","print","ok","ok","ok","err",
];

const STATE_TOP: Record<string, string> = {
  print: "var(--state-print)",
  ok:    "var(--state-ok)",
  err:   "var(--state-error)",
  idle:  "var(--state-idle)",
};

const ZONES = [
  { name: "Філаменти", pct: 73, color: "var(--accent)" },
  { name: "Готові", pct: 48, color: "var(--state-ok)" },
  { name: "Деталі", pct: 61, color: "var(--state-print)" },
] as const;

function FarmGridLogo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      {([[14,32],[50,32],[14,14],[32,14],[50,14],[14,50],[32,50],[50,50]]).map(([cx,cy], i) => (
        <circle key={i} cx={cx} cy={cy} r="4" stroke="var(--accent)" strokeWidth="1.7" opacity=".6"/>
      ))}
      <circle cx="32" cy="32" r="7" fill="var(--accent)"/>
    </svg>
  );
}

interface AuthLayoutProps {
  children: React.ReactNode;
  /** Which tab is active. Omit to hide the tab switcher entirely. */
  activeTab?: "login" | "register";
}

export default function AuthLayout({ children, activeTab }: AuthLayoutProps) {
  return (
    <div
      className="auth-layout"
      style={{
        display: "grid",
        gridTemplateColumns: "1.05fr 1fr",
        minHeight: "100vh",
        flex: 1,
      }}
    >
      {/* ── Left brand panel ── */}
      <aside
        style={{
          position: "relative",
          overflow: "hidden",
          background: `
            radial-gradient(900px 500px at 18% 12%, rgba(34,211,238,.10), transparent 55%),
            radial-gradient(700px 600px at 95% 100%, rgba(34,211,238,.06), transparent 60%),
            var(--bg-elevated)
          `,
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "40px",
          gap: "40px",
        }}
      >
        {/* dot-grid bg */}
        <div style={{
          position: "absolute", inset: 0,
          backgroundImage: "radial-gradient(rgba(255,255,255,.045) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
          maskImage: "radial-gradient(ellipse 80% 70% at 30% 30%, #000 40%, transparent 100%)",
          pointerEvents: "none",
        }} />

        {/* Logo + wordmark */}
        <div style={{ position: "relative", display: "flex", alignItems: "center", gap: "11px" }}>
          <FarmGridLogo size={30} />
          <div>
            <div style={{ fontSize: "16px", fontWeight: 600, color: "var(--text-hi)", letterSpacing: "-.01em" }}>
              monofarm
            </div>
            <div className="font-mono" style={{ fontSize: "9.5px", letterSpacing: ".14em", textTransform: "uppercase", color: "var(--text-faint)", fontWeight: 400, marginTop: "1px", whiteSpace: "nowrap" }}>
              Контроль ферми 3D-друку
            </div>
          </div>
        </div>

        {/* Hero + preview */}
        <div style={{ position: "relative", flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", maxWidth: "440px" }}>
          <h2 style={{ fontSize: "clamp(20px, 2.2vw, 30px)", lineHeight: 1.18, fontWeight: 600, color: "var(--text-hi)", letterSpacing: "-.025em", margin: 0 }}>
            Уся ферма, склад і потік виробництва — в одній системі.
          </h2>
          <p style={{ fontSize: "14px", color: "var(--text-muted)", lineHeight: 1.6, margin: "16px 0 0", maxWidth: "400px" }}>
            Керуйте десятками принтерів у реальному часі, відстежуйте кожен грам філаменту й приймайте готові вироби на склад одним скануванням.
          </p>

          {/* Mini farm preview window */}
          <div style={{
            marginTop: "34px",
            border: "1px solid var(--border)",
            borderRadius: "var(--r-lg)",
            background: "var(--surface)",
            boxShadow: "var(--shadow-md)",
            overflow: "hidden",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "9px 13px", borderBottom: "1px solid var(--border)" }}>
              <div style={{ display: "flex", gap: "5px" }}>
                {["#ef4444","#f59e0b","#22c55e"].map((c) => (
                  <div key={c} style={{ width: "9px", height: "9px", borderRadius: "50%", background: c }} />
                ))}
              </div>
              <span className="font-mono" style={{ fontSize: "10px", color: "var(--text-faint)", marginLeft: "6px" }}>
                monofarm · огляд ферми · live
              </span>
            </div>

            <div style={{ padding: "13px 14px 15px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "9px" }}>
                <span className="font-mono" style={{ fontSize: "9.5px", letterSpacing: ".12em", textTransform: "uppercase", color: "var(--text-faint)" }}>принтери</span>
                <span style={{ display: "flex", gap: "9px" }}>
                  {([["var(--state-print)","8"],["var(--state-ok)","3"],["var(--state-error)","1"]] as const).map(([col,cnt]) => (
                    <span key={col} style={{ display: "inline-flex", alignItems: "center", gap: "4px", color: "var(--text-muted)", fontSize: "11px" }}>
                      <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: col, display: "inline-block" }}/>
                      {cnt}
                    </span>
                  ))}
                </span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: "6px" }}>
                {MINI_PRINTERS.map((state, i) => (
                  <div key={i} style={{
                    aspectRatio: "1",
                    borderRadius: "var(--r-xs)",
                    border: "1px solid var(--border)",
                    borderTopWidth: "2px",
                    borderTopColor: STATE_TOP[state],
                    background: "var(--surface-2)",
                    opacity: state === "idle" ? 0.6 : 1,
                  }}/>
                ))}
              </div>

              <div style={{ height: "1px", background: "var(--border)", margin: "14px 0" }}/>

              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "9px" }}>
                <span className="font-mono" style={{ fontSize: "9.5px", letterSpacing: ".12em", textTransform: "uppercase", color: "var(--text-faint)" }}>склад</span>
                <span style={{ fontSize: "10px", color: "var(--text-faint)" }}>зони A·B·C</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {ZONES.map((z) => (
                  <div key={z.name} style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <span style={{ fontSize: "11.5px", color: "var(--text-muted)", minWidth: "84px" }}>{z.name}</span>
                    <div style={{ flex: 1, height: "6px", background: "var(--surface-hi)", borderRadius: "99px", overflow: "hidden" }}>
                      <div style={{ width: `${z.pct}%`, height: "100%", background: z.color, borderRadius: "99px" }}/>
                    </div>
                    <span className="font-mono" style={{ fontSize: "10.5px", color: "var(--text-hi)", minWidth: "34px", textAlign: "right" }}>{z.pct}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Stats row */}
          <div style={{ display: "flex", marginTop: "24px", borderTop: "1px solid var(--border)", paddingTop: "20px" }}>
            {[
              { v: "8", l: "друкують" },
              { v: "3", l: "готові забрати" },
              { v: "1", l: "потребують уваги" },
            ].map((s, i, arr) => (
              <div key={i} style={{
                paddingRight: i < arr.length - 1 ? "28px" : 0,
                marginRight: i < arr.length - 1 ? "28px" : 0,
                borderRight: i < arr.length - 1 ? "1px solid var(--border)" : "none",
              }}>
                <div style={{ fontSize: "22px", fontWeight: 600, color: "var(--text-hi)", letterSpacing: "-.02em" }}>{s.v}</div>
                <div className="font-mono" style={{ fontSize: "10px", letterSpacing: ".06em", textTransform: "uppercase", color: "var(--text-faint)", marginTop: "3px" }}>{s.l}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "12px", color: "var(--text-faint)" }}>
          <span>© 2026 Monofarm</span>
          <div style={{ display: "flex", gap: "12px" }}>
            <a href="#" style={{ color: "var(--text-muted)", textDecoration: "none" }}>Документація</a>
            <a href="#" style={{ color: "var(--text-muted)", textDecoration: "none" }}>Підтримка</a>
          </div>
        </div>
      </aside>

      {/* ── Right form area ── */}
      <main style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "40px 32px", position: "relative" }}>
        <div style={{ width: "100%", maxWidth: "380px" }}>
          {/* Tab switcher — only shown for login / register */}
          {activeTab && (
            <div style={{
              display: "inline-flex",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: "var(--r-md)",
              padding: "3px",
              gap: "2px",
              marginBottom: "26px",
              width: "100%",
            }}>
              {([
                { label: "Вхід",        href: "/login",    key: "login" as const },
                { label: "Реєстрація",  href: "/register", key: "register" as const },
              ]).map((tab) => {
                const isActive = activeTab === tab.key;
                return (
                  <Link
                    key={tab.href}
                    href={tab.href}
                    style={{
                      flex: 1,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: "7px 0",
                      borderRadius: "var(--r-sm)",
                      fontSize: "13px",
                      fontWeight: 500,
                      textDecoration: "none",
                      color: isActive ? "var(--text-hi)" : "var(--text-muted)",
                      background: isActive ? "var(--surface-hi)" : "transparent",
                      boxShadow: isActive ? "var(--shadow-sm)" : "none",
                      transition: "background 80ms, color 80ms",
                    }}
                  >
                    {tab.label}
                  </Link>
                );
              })}
            </div>
          )}

          {children}
        </div>
      </main>
    </div>
  );
}
