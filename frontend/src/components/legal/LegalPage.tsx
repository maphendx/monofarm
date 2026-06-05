import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  FileText,
  Mail,
  ShieldCheck,
} from "lucide-react";

export interface LegalSection {
  id: string;
  title: string;
  body: Array<string | string[]>;
}

interface LegalPageProps {
  title: string;
  subtitle: string;
  updatedAt: string;
  sections: LegalSection[];
  summary: Array<{
    title: string;
    text: string;
    icon: LucideIcon;
  }>;
}

export function LegalPage({ title, subtitle, updatedAt, sections, summary }: LegalPageProps) {
  return (
    <main className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <div className="mx-auto flex w-full max-w-6xl flex-col px-4 py-5 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-5 border-b border-[var(--border)] pb-5 sm:flex-row sm:items-center sm:justify-between">
          <Link
            href="/login"
            className="inline-flex items-center gap-2 text-sm font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]"
          >
            <ArrowLeft size={16} aria-hidden="true" />
            До входу
          </Link>
          <nav className="flex items-center gap-2 text-sm">
            <Link
              href="/terms"
              className="rounded-sm px-2 py-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hi)] hover:text-[var(--text-hi)]"
            >
              Умови
            </Link>
            <Link
              href="/privacy"
              className="rounded-sm px-2 py-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hi)] hover:text-[var(--text-hi)]"
            >
              Приватність
            </Link>
            <a
              href="mailto:support@monofarm.app"
              className="rounded-sm px-2 py-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hi)] hover:text-[var(--text-hi)]"
            >
              Контакт
            </a>
          </nav>
        </header>

        <section className="grid gap-8 py-10 lg:grid-cols-[minmax(0,1fr)_320px] lg:py-14">
          <div>
            <div className="mb-5 inline-flex items-center gap-2 text-sm text-[var(--text-muted)]">
              <FileText size={17} aria-hidden="true" />
              Юридичні документи Monofarm
            </div>
            <h1 className="max-w-3xl text-4xl font-semibold leading-tight tracking-normal text-[var(--text-hi)] sm:text-5xl">
              {title}
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-[var(--text-muted)] sm:text-lg">
              {subtitle}
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3 text-sm text-[var(--text-muted)]">
              <span className="inline-flex items-center gap-2 rounded-sm border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
                <CalendarDays size={15} aria-hidden="true" />
                Оновлено: {updatedAt}
              </span>
              <span className="inline-flex items-center gap-2 rounded-sm border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
                <ShieldCheck size={15} aria-hidden="true" />
                SaaS для 3D print farm
              </span>
            </div>
          </div>

          <aside className="surface h-fit p-4">
            <h2 className="text-sm font-semibold text-[var(--text-hi)]">Коротко</h2>
            <div className="mt-4 space-y-4">
              {summary.map((item) => {
                const Icon = item.icon;
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
                Розділи
              </div>
              <nav className="space-y-2">
                {sections.map((section, index) => (
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
            {sections.map((section, index) => (
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
