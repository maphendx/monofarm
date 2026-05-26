"use client";

import Link from "next/link";
import { useState } from "react";
import {
  CONNECTION_LABELS,
  OTHER_BRANDS,
  POPULAR_BRANDS,
  PRINTER_BRANDS,
  SETUP_GUIDES,
  type ConnectionType,
  type PrinterBrand,
  type PrinterModel,
} from "@/lib/printerSetupData";

// ── connection type badge ─────────────────────────────────────────────────────

const CONN_BADGE: Record<ConnectionType, string> = {
  cloud:            "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  klipper:          "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300",
  "klipper-custom": "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  "klipper-pad":    "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300",
  octoprint:        "bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300",
  prusalink:        "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  makerbase:        "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
  manual:           "bg-[var(--surface-hi)] text-[var(--text-muted)]  ",
};

const _cloudIcon = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>;
const _codeIcon  = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>;
const _warnIcon  = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>;
const _editIcon  = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>;
const _piIcon    = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>;

const CONN_ICON: Record<ConnectionType, React.ReactNode> = {
  cloud:            _cloudIcon,
  klipper:          _codeIcon,
  "klipper-custom": _warnIcon,
  "klipper-pad":    _codeIcon,
  octoprint:        _piIcon,
  prusalink:        _cloudIcon,
  makerbase:        _codeIcon,
  manual:           _editIcon,
};

// ── brand logo badge ──────────────────────────────────────────────────────────

function BrandBadge({ brand }: { brand: PrinterBrand }) {
  return (
    <div className={`flex size-10 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-white ${brand.color}`}>
      {brand.abbr}
    </div>
  );
}

// ── back button ───────────────────────────────────────────────────────────────

function Back({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} className="flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text-hi)] ">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 12H5M12 5l-7 7 7 7"/>
      </svg>
      {label}
    </button>
  );
}

// ── step number ───────────────────────────────────────────────────────────────

function StepNumber({ n, done }: { n: number; done?: boolean }) {
  return (
    <div className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
      done
        ? "bg-emerald-500 text-white"
        : "border-2 border-[var(--border-strong)] text-[var(--text-muted)] "
    }`}>
      {done
        ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
        : n}
    </div>
  );
}

// ── code block ────────────────────────────────────────────────────────────────

function CodeBlock({ code }: { code: string }) {
  return (
    <pre className="mt-2 overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--bg)] px-4 py-3 text-xs leading-relaxed text-emerald-400 ">
      {code}
    </pre>
  );
}

// ── main page ─────────────────────────────────────────────────────────────────

type PageStep = "brands" | "models" | "guide";

export default function SetupPage() {
  const [step, setStep] = useState<PageStep>("brands");
  const [brand, setBrand] = useState<PrinterBrand | null>(null);
  const [model, setModel] = useState<PrinterModel | null>(null);
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);

  function selectBrand(b: PrinterBrand) {
    setBrand(b);
    setModel(null);
    // if brand has only one model, skip model step
    if (b.models.length === 1) {
      setModel(b.models[0]);
      setStep("guide");
    } else {
      setStep("models");
    }
  }

  function selectModel(m: PrinterModel) {
    setModel(m);
    setStep("guide");
  }

  function reset() {
    setStep("brands");
    setBrand(null);
    setModel(null);
    setSearch("");
    setShowAll(false);
  }

  // ── brand search ──────────────────────────────────────────────────────────

  const filteredBrands = search.trim()
    ? PRINTER_BRANDS.filter((b) =>
        b.name.toLowerCase().includes(search.toLowerCase()) ||
        b.models.some((m) => m.name.toLowerCase().includes(search.toLowerCase()))
      )
    : null;

  // ── guide ──────────────────────────────────────────────────────────────────

  const guide = model ? SETUP_GUIDES[model.connection] : null;
  const guideSteps = guide && brand && model ? guide.steps(model, brand) : [];

  return (
    <div className="mx-auto max-w-2xl space-y-6">

      {/* page header */}
      <div>
        <h1 className="text-xl font-bold">Гід підключення принтера</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Оберіть бренд і модель — отримаєш покрокову інструкцію підключення до monofarm
        </p>
      </div>

      {/* breadcrumb */}
      {step !== "brands" && (
        <div className="flex items-center gap-2 text-sm text-[var(--text-faint)]">
          <button onClick={reset} className="hover:text-[var(--text)] ">Бренди</button>
          {brand && (
            <>
              <span>/</span>
              {step === "guide"
                ? <button onClick={() => brand.models.length > 1 && setStep("models")} className="hover:text-[var(--text)] ">{brand.name}</button>
                : <span className="text-[var(--text)] ">{brand.name}</span>
              }
            </>
          )}
          {model && step === "guide" && (
            <>
              <span>/</span>
              <span className="text-[var(--text)] ">{model.name}</span>
            </>
          )}
        </div>
      )}

      {/* ── STEP: brand grid ── */}
      {step === "brands" && (
        <div className="space-y-6">
          {/* search */}
          <div className="relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-faint)]" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <input
              type="text"
              placeholder="Пошук бренду або моделі…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] py-2.5 pl-10 pr-4 text-sm outline-none focus:border-[var(--border-strong)]  "
            />
          </div>

          {filteredBrands ? (
            /* search results */
            filteredBrands.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">Нічого не знайдено</p>
            ) : (
              <div className="grid grid-cols-1 gap-2">
                {filteredBrands.map((b) => (
                  <BrandRow key={b.id} brand={b} onClick={() => selectBrand(b)} />
                ))}
              </div>
            )
          ) : (
            <>
              <div>
                <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--text-faint)]">Популярні бренди</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {POPULAR_BRANDS.map((b) => (
                    <BrandCard key={b.id} brand={b} onClick={() => selectBrand(b)} />
                  ))}
                </div>
              </div>

              <div>
                <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--text-faint)]">Інші бренди</p>
                <div className="grid grid-cols-1 gap-1.5">
                  {(showAll ? OTHER_BRANDS : OTHER_BRANDS.slice(0, 4)).map((b) => (
                    <BrandRow key={b.id} brand={b} onClick={() => selectBrand(b)} />
                  ))}
                </div>
                {!showAll && OTHER_BRANDS.length > 4 && (
                  <button
                    onClick={() => setShowAll(true)}
                    className="mt-2 text-sm text-[var(--text-faint)] hover:text-[var(--text)] "
                  >
                    Показати всі ({OTHER_BRANDS.length}) →
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── STEP: model list ── */}
      {step === "models" && brand && (
        <div className="space-y-4">
          <Back onClick={reset} label="Всі бренди" />
          <div className="flex items-center gap-3">
            <BrandBadge brand={brand} />
            <div>
              <h2 className="font-semibold">{brand.name}</h2>
              <p className="text-xs text-[var(--text-muted)]">Оберіть модель</p>
            </div>
          </div>
          <div className="space-y-1.5">
            {brand.models.map((m) => (
              <button
                key={m.id}
                onClick={() => selectModel(m)}
                className="flex w-full items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-3 text-left transition hover:border-[var(--border-strong)] hover:shadow-sm   dark:hover:border-[var(--border-strong)]"
              >
                <div>
                  <span className="text-sm font-medium">{m.name}</span>
                  {m.note && <span className="ml-2 text-xs text-[var(--text-faint)]">{m.note}</span>}
                </div>
                <span className={`flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${CONN_BADGE[m.connection]}`}>
                  {CONN_ICON[m.connection]}
                  {CONNECTION_LABELS[m.connection]}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── STEP: setup guide ── */}
      {step === "guide" && brand && model && guide && (
        <div className="space-y-6">
          <Back onClick={() => brand.models.length > 1 ? setStep("models") : reset()} label={brand.models.length > 1 ? brand.name : "Всі бренди"} />

          {/* guide header */}
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5  ">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <BrandBadge brand={brand} />
                <div>
                  <h2 className="font-bold">{brand.name} {model.name}</h2>
                  <p className="text-xs text-[var(--text-muted)]">{guide.title}</p>
                </div>
              </div>
              <div className="flex flex-col items-end gap-1.5">
                <span className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${guide.badgeColor}`}>
                  {CONN_ICON[model.connection]}
                  {guide.badge}
                </span>
                <span className="text-xs text-[var(--text-faint)]">~{guide.estimatedTime}</span>
              </div>
            </div>

            {model.connection === "klipper-custom" && (
              <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-300">
                <strong>Потрібна підготовка:</strong> ця модель вимагає встановлення кастомної прошивки перед підключенням до monofarm. Це займе 15–30 хвилин. Процес безпечний, але технічний — ми проведемо тебе крок за кроком.
              </div>
            )}

            {model.connection === "manual" && (
              <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-4 py-3 text-xs text-[var(--text-muted)]   ">
                <strong>{brand.name} {model.name}</strong> не має API для автоматичного відстеження. Принтер можна додати для ручного керування — оператор оновлює статус вручну.
              </div>
            )}
            {guide.monofarmNote && model.connection !== "manual" && model.connection !== "cloud" && model.connection !== "klipper" && model.connection !== "klipper-custom" && model.connection !== "klipper-pad" && (
              <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-800 dark:border-blue-900/40 dark:bg-blue-900/20 dark:text-blue-300">
                <strong>monofarm:</strong> {guide.monofarmNote}
              </div>
            )}
          </div>

          {/* steps */}
          <div className="space-y-3">
            {guideSteps.map((s, i) => (
              <div key={i} className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5  ">
                <div className="flex gap-4">
                  <StepNumber n={i + 1} />
                  <div className="min-w-0 flex-1 space-y-2">
                    <h3 className="font-semibold text-sm">{s.title}</h3>
                    {s.warning && (
                      <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-300">
                        <svg className="mt-0.5 shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                        {s.warning}
                      </div>
                    )}
                    <p className="text-sm text-[var(--text-muted)] ">{s.content}</p>
                    {s.code && <CodeBlock code={s.code} />}
                    {s.link && (
                      <a
                        href={s.link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-xs text-blue-600 hover:underline dark:text-blue-400"
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                        {s.link.label}
                      </a>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* CTA */}
          <div className="rounded-2xl border border-[var(--border-strong)] bg-[var(--surface)] p-5  ">
            <p className="text-sm font-semibold text-white ">Готовий до підключення?</p>
            <p className="mt-0.5 text-xs text-[var(--text-faint)] ">
              {model.connection === "cloud"
                ? "Перейди в Налаштування щоб підключити Bambu Cloud."
                : model.connection === "manual"
                ? "Додай принтер вручну — займе хвилину."
                : "Після налаштування Moonraker — додай принтер в monofarm."}
            </p>
            <div className="mt-3 flex gap-2">
              {model.connection === "cloud" ? (
                <Link href="/settings" className="rounded-md bg-[var(--bg-elevated)] px-4 py-2 text-xs font-medium text-[var(--text-hi)] hover:bg-[var(--surface-hi)]   ">
                  Відкрити Налаштування →
                </Link>
              ) : (
                <Link href="/printers" className="rounded-md bg-[var(--bg-elevated)] px-4 py-2 text-xs font-medium text-[var(--text-hi)] hover:bg-[var(--surface-hi)]   ">
                  Перейти до Принтерів →
                </Link>
              )}
              <button onClick={reset} className="rounded-md px-4 py-2 text-xs text-[var(--text-faint)] hover:bg-[var(--surface-hi)] ">
                Інший принтер
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── sub-components ────────────────────────────────────────────────────────────

function BrandCard({ brand, onClick }: { brand: PrinterBrand; onClick: () => void }) {
  const conns = [...new Set(brand.models.map((m) => m.connection))];
  return (
    <button
      onClick={onClick}
      className="flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4 text-left transition hover:border-[var(--border-strong)] hover:shadow-sm   dark:hover:border-[var(--border-strong)]"
    >
      <div className="flex items-center gap-3">
        <BrandBadge brand={brand} />
        <span className="font-semibold text-sm">{brand.name}</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {conns.map((c) => (
          <span key={c} className={`flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-medium ${CONN_BADGE[c]}`}>
            {CONN_ICON[c]}
            {c === "cloud" ? "Хмара" : c === "klipper" ? "Klipper" : c === "klipper-custom" ? "Custom" : "Ручний"}
          </span>
        ))}
      </div>
      <p className="text-xs text-[var(--text-faint)]">{brand.models.length} {brand.models.length === 1 ? "модель" : "моделей"}</p>
    </button>
  );
}

function BrandRow({ brand, onClick }: { brand: PrinterBrand; onClick: () => void }) {
  const conns = [...new Set(brand.models.map((m) => m.connection))];
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-3 text-left transition hover:border-[var(--border-strong)]   dark:hover:border-[var(--border-strong)]"
    >
      <BrandBadge brand={brand} />
      <div className="flex-1 min-w-0">
        <span className="text-sm font-medium">{brand.name}</span>
        <div className="mt-0.5 flex flex-wrap gap-1">
          {conns.map((c) => (
            <span key={c} className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${CONN_BADGE[c]}`}>
              {CONNECTION_LABELS[c]}
            </span>
          ))}
        </div>
      </div>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-faint)]">
        <path d="M9 18l6-6-6-6"/>
      </svg>
    </button>
  );
}
