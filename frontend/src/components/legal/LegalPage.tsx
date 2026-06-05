"use client";

import Link from "next/link";
import {
  ArrowLeft,
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Cookie,
  CreditCard,
  Database,
  FileCheck2,
  KeyRound,
  LockKeyhole,
  Mail,
  Plug,
  Server,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import type { ComponentType } from "react";

import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { useLocale, type Locale } from "@/lib/i18n";

export interface LegalSection {
  id: string;
  title: string;
  body: Array<string | string[]>;
}

type SummaryIcon =
  | "alert"
  | "billing"
  | "database"
  | "file"
  | "integration"
  | "key"
  | "lock"
  | "server"
  | "shield"
  | "storage"
  | "support";

export interface LegalDocument {
  title: string;
  subtitle: string;
  updatedAt: string;
  sections: LegalSection[];
  summary: Array<{
    title: string;
    text: string;
    icon: SummaryIcon;
  }>;
}

interface LegalPageProps {
  documents: Record<Locale, LegalDocument>;
  type: "privacy" | "terms";
}

const ICONS = {
  alert: AlertTriangle,
  billing: CreditCard,
  database: Database,
  file: FileCheck2,
  integration: Plug,
  key: KeyRound,
  lock: LockKeyhole,
  server: Server,
  shield: ShieldCheck,
  storage: Cookie,
  support: Wrench,
} satisfies Record<SummaryIcon, ComponentType<{ size?: number; "aria-hidden"?: boolean }>>;

const UI = {
  uk: {
    back: "До входу",
    terms: "Умови",
    privacy: "Приватність",
    contact: "Контакт",
    legalDocs: "Юридичні документи Monofarm",
    updated: "Оновлено",
    summary: "Коротко",
    sections: "Розділи",
    printFarmSaas: "SaaS для 3D print farm",
    language: "Мова",
    brandTagline: "Контроль ферми 3D-друку",
    brandTitle: "Уся ферма, склад і правові межі — в одній системі.",
    brandText: "Документи Monofarm написані для команд, які керують принтерами, файлами, локальним агентом, складом і білінгом у production-процесі.",
    previewTitle: "monofarm · legal workspace",
    printers: "принтери",
    warehouse: "склад",
    zones: "зони A·B·C",
    printing: "друкують",
    ready: "готові забрати",
    attention: "потребують уваги",
    uk: "Українська",
    en: "English",
  },
  en: {
    back: "Back to sign in",
    terms: "Terms",
    privacy: "Privacy",
    contact: "Contact",
    legalDocs: "Monofarm legal documents",
    updated: "Updated",
    summary: "At a glance",
    sections: "Sections",
    printFarmSaas: "SaaS for 3D print farms",
    language: "Language",
    brandTagline: "3D print farm control",
    brandTitle: "The farm, warehouse, and legal boundaries in one system.",
    brandText: "Monofarm documents are written for teams that manage printers, files, local agents, inventory, and billing in a production workflow.",
    previewTitle: "monofarm · legal workspace",
    printers: "printers",
    warehouse: "warehouse",
    zones: "zones A·B·C",
    printing: "printing",
    ready: "ready to pick up",
    attention: "need attention",
    uk: "Українська",
    en: "English",
  },
} as const;

const MINI_PRINTERS: Array<"print" | "ok" | "err" | "idle"> = [
  "print", "print", "print", "print", "print", "print",
  "print", "print", "ok", "ok", "ok", "err",
];

const STATE_TOP: Record<(typeof MINI_PRINTERS)[number], string> = {
  print: "var(--state-print)",
  ok: "var(--state-ok)",
  err: "var(--state-error)",
  idle: "var(--state-idle)",
};

const ZONES = [
  { key: "filaments", pct: 73, color: "var(--accent)" },
  { key: "ready", pct: 48, color: "var(--state-ok)" },
  { key: "parts", pct: 61, color: "var(--state-print)" },
] as const;

const ZONE_LABELS = {
  uk: {
    filaments: "Філаменти",
    ready: "Готові",
    parts: "Деталі",
  },
  en: {
    filaments: "Filaments",
    ready: "Ready",
    parts: "Parts",
  },
} as const;

function FarmGridLogo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      {([[14,32],[50,32],[14,14],[32,14],[50,14],[14,50],[32,50],[50,50]]).map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r="4" stroke="var(--accent)" strokeWidth="1.7" opacity=".6" />
      ))}
      <circle cx="32" cy="32" r="7" fill="var(--accent)" />
    </svg>
  );
}

export function LegalPage({ documents, type }: LegalPageProps) {
  const { locale, setLocale } = useLocale();
  const document = documents[locale];
  const ui = UI[locale];

  return (
    <main
      className="auth-layout min-h-screen bg-[var(--bg)] text-[var(--text)]"
      style={{ display: "grid", gridTemplateColumns: "minmax(360px,.95fr) minmax(0,1.25fr)" }}
    >
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
          minHeight: "100vh",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "40px",
          gap: "40px",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage: "radial-gradient(rgba(255,255,255,.045) 1px, transparent 1px)",
            backgroundSize: "24px 24px",
            maskImage: "radial-gradient(ellipse 80% 70% at 30% 30%, #000 40%, transparent 100%)",
            pointerEvents: "none",
          }}
        />

        <div style={{ position: "relative", display: "flex", alignItems: "center", gap: "11px" }}>
          <FarmGridLogo size={30} />
          <div>
            <div style={{ fontSize: "16px", fontWeight: 600, color: "var(--text-hi)", letterSpacing: "-.01em" }}>
              monofarm
            </div>
            <div className="font-mono" style={{ fontSize: "9.5px", letterSpacing: ".14em", textTransform: "uppercase", color: "var(--text-faint)", fontWeight: 400, marginTop: "1px", whiteSpace: "nowrap" }}>
              {ui.brandTagline}
            </div>
          </div>
        </div>

        <div style={{ position: "relative", flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", maxWidth: "440px" }}>
          <h2 style={{ fontSize: "clamp(20px, 2.2vw, 30px)", lineHeight: 1.18, fontWeight: 600, color: "var(--text-hi)", letterSpacing: "-.025em", margin: 0 }}>
            {ui.brandTitle}
          </h2>
          <p style={{ fontSize: "14px", color: "var(--text-muted)", lineHeight: 1.6, margin: "16px 0 0", maxWidth: "410px" }}>
            {ui.brandText}
          </p>

          <div
            style={{
              marginTop: "34px",
              border: "1px solid var(--border)",
              borderRadius: "var(--r-lg)",
              background: "var(--surface)",
              boxShadow: "var(--shadow-md)",
              overflow: "hidden",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "9px 13px", borderBottom: "1px solid var(--border)" }}>
              <div style={{ display: "flex", gap: "5px" }}>
                {["var(--state-error)", "var(--state-warn)", "var(--state-ok)"].map((color) => (
                  <div key={color} style={{ width: "9px", height: "9px", borderRadius: "50%", background: color }} />
                ))}
              </div>
              <span className="font-mono" style={{ fontSize: "10px", color: "var(--text-faint)", marginLeft: "6px" }}>
                {ui.previewTitle}
              </span>
            </div>

            <div style={{ padding: "13px 14px 15px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "9px" }}>
                <span className="font-mono" style={{ fontSize: "9.5px", letterSpacing: ".12em", textTransform: "uppercase", color: "var(--text-faint)" }}>{ui.printers}</span>
                <span style={{ display: "flex", gap: "9px" }}>
                  {([["var(--state-print)", "8"], ["var(--state-ok)", "3"], ["var(--state-error)", "1"]] as const).map(([color, count]) => (
                    <span key={color} style={{ display: "inline-flex", alignItems: "center", gap: "4px", color: "var(--text-muted)", fontSize: "11px" }}>
                      <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: color, display: "inline-block" }} />
                      {count}
                    </span>
                  ))}
                </span>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: "6px" }}>
                {MINI_PRINTERS.map((state, index) => (
                  <div
                    key={`${state}-${index}`}
                    style={{
                      aspectRatio: "1",
                      borderRadius: "var(--r-xs)",
                      border: "1px solid var(--border)",
                      borderTopWidth: "2px",
                      borderTopColor: STATE_TOP[state],
                      background: "var(--surface-2)",
                      opacity: state === "idle" ? 0.6 : 1,
                    }}
                  />
                ))}
              </div>

              <div style={{ height: "1px", background: "var(--border)", margin: "14px 0" }} />

              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "9px" }}>
                <span className="font-mono" style={{ fontSize: "9.5px", letterSpacing: ".12em", textTransform: "uppercase", color: "var(--text-faint)" }}>{ui.warehouse}</span>
                <span style={{ fontSize: "10px", color: "var(--text-faint)" }}>{ui.zones}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {ZONES.map((zone) => (
                  <div key={zone.key} style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <span style={{ fontSize: "11.5px", color: "var(--text-muted)", minWidth: "84px" }}>{ZONE_LABELS[locale][zone.key]}</span>
                    <div style={{ flex: 1, height: "6px", background: "var(--surface-hi)", borderRadius: "99px", overflow: "hidden" }}>
                      <div style={{ width: `${zone.pct}%`, height: "100%", background: zone.color, borderRadius: "99px" }} />
                    </div>
                    <span className="font-mono" style={{ fontSize: "10.5px", color: "var(--text-hi)", minWidth: "34px", textAlign: "right" }}>{zone.pct}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", marginTop: "24px", borderTop: "1px solid var(--border)", paddingTop: "20px" }}>
            {[
              { value: "8", label: ui.printing },
              { value: "3", label: ui.ready },
              { value: "1", label: ui.attention },
            ].map((stat, index, arr) => (
              <div
                key={stat.label}
                style={{
                  paddingRight: index < arr.length - 1 ? "28px" : 0,
                  marginRight: index < arr.length - 1 ? "28px" : 0,
                  borderRight: index < arr.length - 1 ? "1px solid var(--border)" : "none",
                }}
              >
                <div style={{ fontSize: "22px", fontWeight: 600, color: "var(--text-hi)", letterSpacing: "-.02em" }}>{stat.value}</div>
                <div className="font-mono" style={{ fontSize: "10px", letterSpacing: ".06em", textTransform: "uppercase", color: "var(--text-faint)", marginTop: "3px" }}>{stat.label}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px", fontSize: "12px", color: "var(--text-faint)" }}>
          <span>© 2026 Monofarm</span>
          <div style={{ display: "flex", gap: "12px" }}>
            <Link href="/terms" style={{ color: type === "terms" ? "var(--accent)" : "var(--text-muted)", textDecoration: "none" }}>{ui.terms}</Link>
            <Link href="/privacy" style={{ color: type === "privacy" ? "var(--accent)" : "var(--text-muted)", textDecoration: "none" }}>{ui.privacy}</Link>
          </div>
        </div>
      </aside>

      <section style={{ minWidth: 0, padding: "32px", overflow: "auto" }}>
        <div style={{ margin: "0 auto", maxWidth: "880px" }}>
          <header className="surface" style={{ padding: "16px", marginBottom: "18px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "14px", flexWrap: "wrap" }}>
              <Link href="/login" className="btn btn-ghost btn-sm">
                <ArrowLeft size={13} aria-hidden="true" />
                {ui.back}
              </Link>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <Link href="/terms" className={["btn btn-sm", type === "terms" ? "btn-primary" : "btn-secondary"].join(" ")}>
                  {ui.terms}
                </Link>
                <Link href="/privacy" className={["btn btn-sm", type === "privacy" ? "btn-primary" : "btn-secondary"].join(" ")}>
                  {ui.privacy}
                </Link>
                <a href="mailto:support@monofarm.app" className="btn btn-ghost btn-sm">
                  <Mail size={13} aria-hidden="true" />
                  {ui.contact}
                </a>
                <ThemeToggle />
              </div>
            </div>
          </header>

          <div className="surface" style={{ padding: "26px", marginBottom: "18px" }}>
            <div className="badge badge-accent" style={{ marginBottom: "18px" }}>{ui.legalDocs}</div>
            <h1 style={{ margin: 0, maxWidth: "720px", fontSize: "clamp(26px,4vw,38px)", lineHeight: 1.12, fontWeight: 600, color: "var(--text-hi)", letterSpacing: "-.025em" }}>
              {document.title}
            </h1>
            <p style={{ margin: "14px 0 0", maxWidth: "680px", fontSize: "14px", lineHeight: 1.65, color: "var(--text-muted)" }}>
              {document.subtitle}
            </p>
            <div style={{ marginTop: "20px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px" }}>
              <span className="badge badge-neutral">
                <CalendarDays size={12} aria-hidden="true" />
                {ui.updated}: {document.updatedAt}
              </span>
              <span className="badge badge-accent">
                <ShieldCheck size={12} aria-hidden="true" />
                {ui.printFarmSaas}
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", color: "var(--text-faint)", fontSize: "12px" }}>
                {ui.language}
              </span>
              {(["uk", "en"] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setLocale(item)}
                  className={["btn btn-sm", locale === item ? "btn-primary" : "btn-secondary"].join(" ")}
                >
                  {ui[item]}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-[18px] lg:grid-cols-[minmax(180px,220px)_minmax(0,1fr)]">
            <aside className="surface" style={{ height: "fit-content", padding: "14px", position: "sticky", top: "24px" }}>
              <h2 style={{ margin: "0 0 12px", fontSize: "13px", fontWeight: 600, color: "var(--text-hi)" }}>{ui.summary}</h2>
              <div style={{ display: "flex", flexDirection: "column", gap: "12px", paddingBottom: "14px", borderBottom: "1px solid var(--border)" }}>
                {document.summary.map((item) => {
                  const Icon = ICONS[item.icon];
                  return (
                    <div key={item.title} style={{ display: "flex", gap: "10px" }}>
                      <div style={{ marginTop: "2px", display: "flex", width: "26px", height: "26px", flexShrink: 0, alignItems: "center", justifyContent: "center", borderRadius: "var(--r-sm)", border: "1px solid var(--accent-ring)", background: "var(--accent-soft)", color: "var(--accent)" }}>
                        <Icon size={14} aria-hidden="true" />
                      </div>
                      <div>
                        <h3 style={{ margin: 0, fontSize: "12.5px", fontWeight: 500, color: "var(--text-hi)" }}>{item.title}</h3>
                        <p style={{ margin: "2px 0 0", fontSize: "12px", lineHeight: 1.5, color: "var(--text-muted)" }}>{item.text}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="font-mono" style={{ marginTop: "14px", marginBottom: "9px", fontSize: "10px", letterSpacing: ".12em", textTransform: "uppercase", color: "var(--text-faint)" }}>
                {ui.sections}
              </div>
              <nav style={{ display: "flex", flexDirection: "column", gap: "7px" }}>
                {document.sections.map((section, index) => (
                  <a
                    key={section.id}
                    href={`#${section.id}`}
                    style={{ display: "block", fontSize: "12px", lineHeight: 1.35, color: "var(--text-muted)", textDecoration: "none" }}
                  >
                    <span className="font-mono" style={{ marginRight: "6px", color: "var(--text-faint)" }}>{String(index + 1).padStart(2, "0")}</span>
                    {section.title}
                  </a>
                ))}
              </nav>
            </aside>

            <article className="surface" style={{ overflow: "hidden" }}>
              {document.sections.map((section, index) => (
                <section
                  id={section.id}
                  key={section.id}
                  style={{ scrollMarginTop: "24px", borderBottom: index === document.sections.length - 1 ? "none" : "1px solid var(--border)", padding: "22px 24px" }}
                >
                  <div style={{ marginBottom: "12px", display: "flex", alignItems: "flex-start", gap: "12px" }}>
                    <span className="font-mono" style={{ marginTop: "4px", fontSize: "11px", color: "var(--text-faint)" }}>
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <h2 style={{ margin: 0, fontSize: "20px", lineHeight: 1.25, fontWeight: 600, color: "var(--text-hi)", letterSpacing: "-.01em" }}>
                      {section.title}
                    </h2>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "14px", fontSize: "14px", lineHeight: 1.7, color: "var(--text)" }}>
                    {section.body.map((block, blockIndex) =>
                      Array.isArray(block) ? (
                        <ul key={blockIndex} style={{ display: "flex", flexDirection: "column", gap: "8px", margin: 0, padding: 0, listStyle: "none" }}>
                          {block.map((item) => (
                            <li key={item} style={{ display: "flex", gap: "10px" }}>
                              <CheckCircle2 size={15} style={{ marginTop: "4px", flexShrink: 0, color: "var(--accent)" }} aria-hidden="true" />
                              <span>{item}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p key={blockIndex} style={{ margin: 0 }}>{block}</p>
                      ),
                    )}
                  </div>
                </section>
              ))}
            </article>
          </div>
        </div>
      </section>
    </main>
  );
}
