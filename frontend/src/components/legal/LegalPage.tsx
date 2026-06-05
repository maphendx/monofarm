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
    uk: "Українська",
    en: "English",
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
    <main className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <div className="mx-auto flex w-full max-w-6xl flex-col px-4 py-5 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-5 border-b border-[var(--border)] pb-5 sm:flex-row sm:items-center sm:justify-between">
          <Link
            href="/login"
            className="inline-flex items-center gap-2 text-sm font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]"
          >
            <ArrowLeft size={16} aria-hidden="true" />
            {ui.back}
          </Link>
          <nav className="flex flex-wrap items-center gap-2 text-sm">
            <Link
              href="/terms"
              className={[
                "rounded-sm px-2 py-1 transition-colors hover:bg-[var(--surface-hi)] hover:text-[var(--text-hi)]",
                type === "terms" ? "text-[var(--accent)]" : "text-[var(--text-muted)]",
              ].join(" ")}
            >
              {ui.terms}
            </Link>
            <Link
              href="/privacy"
              className={[
                "rounded-sm px-2 py-1 transition-colors hover:bg-[var(--surface-hi)] hover:text-[var(--text-hi)]",
                type === "privacy" ? "text-[var(--accent)]" : "text-[var(--text-muted)]",
              ].join(" ")}
            >
              {ui.privacy}
            </Link>
            <a
              href="mailto:support@monofarm.app"
              className="rounded-sm px-2 py-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hi)] hover:text-[var(--text-hi)]"
            >
              {ui.contact}
            </a>
            <ThemeToggle />
          </nav>
        </header>

        <section className="grid gap-8 py-10 lg:grid-cols-[minmax(0,1fr)_340px] lg:py-14">
          <div>
            <div className="mb-6 flex items-center gap-3">
              <FarmGridLogo size={31} />
              <div>
                <div className="text-base font-semibold tracking-normal text-[var(--text-hi)]">monofarm</div>
                <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
                  {ui.legalDocs}
                </div>
              </div>
            </div>
            <h1 className="max-w-3xl text-4xl font-semibold leading-tight tracking-normal text-[var(--text-hi)] sm:text-5xl">
              {document.title}
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-[var(--text-muted)] sm:text-lg">
              {document.subtitle}
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3 text-sm text-[var(--text-muted)]">
              <span className="inline-flex items-center gap-2 rounded-sm border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
                <CalendarDays size={15} aria-hidden="true" />
                {ui.updated}: {document.updatedAt}
              </span>
              <span className="inline-flex items-center gap-2 rounded-sm border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
                <ShieldCheck size={15} aria-hidden="true" />
                {ui.printFarmSaas}
              </span>
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-2 text-sm">
              <span className="text-[var(--text-faint)]">{ui.language}</span>
              {(["uk", "en"] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setLocale(item)}
                  className={[
                    "rounded-sm border px-3 py-2 font-medium transition-colors",
                    locale === item
                      ? "border-[var(--accent-ring)] bg-[var(--accent-soft)] text-[var(--accent)]"
                      : "border-[var(--border-strong)] bg-[var(--surface)] text-[var(--text-muted)] hover:border-[var(--accent-ring)] hover:text-[var(--accent)]",
                  ].join(" ")}
                >
                  {ui[item]}
                </button>
              ))}
            </div>
          </div>

          <aside className="surface h-fit p-4">
            <h2 className="text-sm font-semibold text-[var(--text-hi)]">{ui.summary}</h2>
            <div className="mt-4 space-y-4">
              {document.summary.map((item) => {
                const Icon = ICONS[item.icon];
                return (
                  <div key={item.title} className="flex gap-3">
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-[var(--accent-ring)] bg-[var(--accent-soft)] text-[var(--accent)]">
                      <Icon size={16} aria-hidden="true" />
                    </div>
                    <div>
                      <h3 className="text-sm font-medium text-[var(--text-hi)]">{item.title}</h3>
                      <p className="mt-1 text-sm leading-6 text-[var(--text-muted)]">{item.text}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </aside>
        </section>

        <div className="grid gap-8 pb-16 lg:grid-cols-[220px_minmax(0,1fr)]">
          <aside className="hidden lg:block">
            <div className="sticky top-6 border-l border-[var(--border)] pl-4">
              <div className="mb-3 text-xs font-medium uppercase tracking-wider text-[var(--text-faint)]">
                {ui.sections}
              </div>
              <nav className="space-y-2">
                {document.sections.map((section, index) => (
                  <a
                    key={section.id}
                    href={`#${section.id}`}
                    className="block text-sm leading-5 text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]"
                  >
                    {index + 1}. {section.title}
                  </a>
                ))}
              </nav>
            </div>
          </aside>

          <article className="surface overflow-hidden">
            {document.sections.map((section, index) => (
              <section
                id={section.id}
                key={section.id}
                className="scroll-mt-8 border-b border-[var(--border)] p-5 last:border-b-0 sm:p-7"
              >
                <div className="mb-4 flex items-start gap-3">
                  <span className="font-mono mt-1 text-xs text-[var(--text-faint)]">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <h2 className="text-xl font-semibold leading-snug tracking-normal text-[var(--text-hi)]">
                    {section.title}
                  </h2>
                </div>
                <div className="space-y-4 text-sm leading-7 text-[var(--text)] sm:text-[15px]">
                  {section.body.map((block, blockIndex) =>
                    Array.isArray(block) ? (
                      <ul key={blockIndex} className="space-y-2 pl-1">
                        {block.map((item) => (
                          <li key={item} className="flex gap-3">
                            <CheckCircle2
                              size={16}
                              className="mt-1 shrink-0 text-[var(--accent)]"
                              aria-hidden="true"
                            />
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p key={blockIndex}>{block}</p>
                    ),
                  )}
                </div>
              </section>
            ))}
          </article>
        </div>

        <footer className="flex flex-col gap-3 border-t border-[var(--border)] py-6 text-sm text-[var(--text-muted)] sm:flex-row sm:items-center sm:justify-between">
          <span>© 2026 Monofarm</span>
          <a
            href="mailto:support@monofarm.app"
            className="inline-flex items-center gap-2 transition-colors hover:text-[var(--accent)]"
          >
            <Mail size={15} aria-hidden="true" />
            support@monofarm.app
          </a>
        </footer>
      </div>
    </main>
  );
}
