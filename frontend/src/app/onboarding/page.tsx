"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

const API_BASE =
  typeof window !== "undefined"
    ? window.location.origin.replace(":3000", ":8000")
    : "https://api.monofarm.app";

const INSTALL_CMD = `curl -sSL ${typeof window !== "undefined" ? window.location.origin.replace(":3000", ":8000") : "https://api.monofarm.app"}/agent/install.sh | bash`;

const primaryBtn = "btn btn-primary btn-lg";
const ghostBtn = "btn btn-ghost btn-lg";

function Mascot({ size = 40 }: { size?: number }) {
  const h = size;
  const w = Math.round(size * 1.27);
  return (
    <svg width={w} height={h} viewBox="0 0 112 88" aria-hidden="true">
      <rect x="24" y="0"  width="24" height="8"  className="fill-neutral-900 dark:fill-neutral-100"/>
      <rect x="64" y="0"  width="24" height="8"  className="fill-neutral-900 dark:fill-neutral-100"/>
      <rect x="16" y="8"  width="80" height="16" className="fill-neutral-900 dark:fill-neutral-100"/>
      <rect x="0"  y="24" width="112" height="16" className="fill-neutral-900 dark:fill-neutral-100"/>
      <rect x="16" y="40" width="80" height="8"  className="fill-neutral-900 dark:fill-neutral-100"/>
      <rect x="16" y="48" width="80" height="8"  className="fill-neutral-900 dark:fill-neutral-100"/>
      <rect x="32" y="48" width="16" height="8"  className="fill-white dark:fill-neutral-950"/>
      <rect x="64" y="48" width="16" height="8"  className="fill-white dark:fill-neutral-950"/>
      <rect x="16" y="56" width="80" height="8"  className="fill-neutral-900 dark:fill-neutral-100"/>
      <rect x="32" y="56" width="16" height="8"  className="fill-white dark:fill-neutral-950"/>
      <rect x="64" y="56" width="16" height="8"  className="fill-white dark:fill-neutral-950"/>
      <rect x="16" y="64" width="80" height="8"  className="fill-neutral-900 dark:fill-neutral-100"/>
      <rect x="32" y="72" width="16" height="16" className="fill-neutral-900 dark:fill-neutral-100"/>
      <rect x="64" y="72" width="16" height="16" className="fill-neutral-900 dark:fill-neutral-100"/>
    </svg>
  );
}

type Step = "install" | "waiting" | "done";

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("install");
  const [copied, setCopied] = useState(false);
  const [connected, setConnected] = useState(false);
  const [os, setOs] = useState<"windows" | "linux">("windows");

  // Poll for agent connection
  useEffect(() => {
    if (step !== "waiting") return;
    const id = setInterval(async () => {
      try {
        const r = await api<{ connected: boolean }>("/api/agent/status");
        if (r.connected) {
          setConnected(true);
          setStep("done");
          clearInterval(id);
        }
      } catch {
        // ignore
      }
    }, 3000);
    return () => clearInterval(id);
  }, [step]);

  function installCmd(platform: "windows" | "linux") {
    return platform === "windows"
      ? `irm https://monofarm.app/agent/install.ps1 | iex`
      : `curl -sSL ${API_BASE}/agent/install.sh | bash`;
  }

  function copy() {
    navigator.clipboard.writeText(installCmd(os)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const stepIndex = step === "install" ? 0 : step === "waiting" ? 1 : 2;

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4 py-16 ">
      <div className="w-full max-w-md">

        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Mascot size={36} />
            <div>
              <p className="text-[11px] font-medium uppercase tracking-widest text-[var(--text-faint)]">monofarm</p>
              <h1 className="text-lg font-bold leading-tight">Налаштування агента</h1>
            </div>
          </div>
          {/* Step dots */}
          <div className="flex items-center gap-1.5">
            {[0, 1, 2].map((i) => (
              <div key={i} className={`h-1.5 rounded-full transition-all duration-300 ${
                i === stepIndex ? "w-5 bg-[var(--surface)] "
                : i < stepIndex ? "w-1.5 bg-[var(--state-idle)]"
                                : "w-1.5 bg-[var(--surface-hi)] "
              }`}/>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-6 shadow-sm  ">

          {/* ── Step: install ── */}
          {step === "install" && (
            <div className="space-y-5">
              <div>
                <p className="text-sm font-semibold">Встанови локального агента</p>
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  Агент запускається на PC або Raspberry Pi у мережі принтерів і дає доступ до Bambu + Klipper принтерів через хмару.
                </p>
              </div>

              <div className="space-y-2 text-xs text-[var(--text-muted)]">
                <div className="flex gap-2">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--surface-hi)] text-[10px] font-bold ">1</span>
                  <span>Запусти команду нижче на PC у мережі принтерів</span>
                </div>
                <div className="flex gap-2">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--surface-hi)] text-[10px] font-bold ">2</span>
                  <span>Агент відкриє браузер і автоматично підключиться до твого акаунту</span>
                </div>
                <div className="flex gap-2">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--surface-hi)] text-[10px] font-bold ">3</span>
                  <span>Потім поверніться сюди і натисніть «Далі»</span>
                </div>
              </div>

              {/* OS tabs + install command */}
              <div>
                <div className="mb-2 flex gap-1">
                  {(["windows", "linux"] as const).map((platform) => (
                    <button key={platform} onClick={() => setOs(platform)}
                      className={[
                        "rounded-md px-3 py-1 text-xs font-medium transition",
                        os === platform
                          ? "bg-[var(--accent)] text-white  "
                          : "border border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-strong)]  ",
                      ].join(" ")}>
                      {platform === "windows" ? "Windows" : "Linux / macOS"}
                    </button>
                  ))}
                </div>
                <div className="relative">
                  <pre className="overflow-x-auto rounded-lg bg-[var(--bg)] px-4 py-3 text-xs text-[var(--state-ok)] whitespace-pre-wrap break-all leading-relaxed">
                    {installCmd(os)}
                  </pre>
                  <button onClick={copy}
                    className="absolute right-2 top-2 rounded bg-[var(--surface-2)] px-2 py-1 text-[10px] text-[var(--text-faint)] transition hover:bg-[var(--accent-hi)] hover:text-[var(--text-hi)]">
                    {copied ? "✓" : "Копіювати"}
                  </button>
                </div>
                {os === "windows" && (
                  <p className="mt-1.5 text-[10px] text-[var(--text-faint)]">
                    Запусти в PowerShell (не cmd). Після встановлення значок з’явиться в системному треї.
                  </p>
                )}
              </div>

              <div className="flex items-center gap-3">
                <button onClick={() => setStep("waiting")} className={primaryBtn}>
                  Далі — агент запущено →
                </button>
                <button onClick={() => router.replace("/dashboard")} className={ghostBtn}>
                  Пропустити
                </button>
              </div>
            </div>
          )}

          {/* ── Step: waiting ── */}
          {step === "waiting" && (
            <div className="space-y-5">
              <div>
                <p className="text-sm font-semibold">Очікуємо підключення агента…</p>
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  Переконайся що агент запущений на PC у мережі принтерів. Статус оновлюється автоматично.
                </p>
              </div>

              <div className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-4 py-4  ">
                <span className="size-2.5 animate-pulse rounded-full bg-[var(--state-warn)]" />
                <span className="text-sm text-[var(--text-muted)] ">Очікування агента…</span>
              </div>

              <p className="text-xs text-[var(--text-faint)]">
                Після запуску агент автоматично підключиться — ця сторінка оновиться.
              </p>

              <div className="flex items-center gap-3">
                <button onClick={() => setStep("install")} className={ghostBtn}>
                  ← Назад
                </button>
                <button onClick={() => router.replace("/dashboard")} className="text-xs text-[var(--text-faint)] hover:text-[var(--text-muted)] ">
                  Пропустити →
                </button>
              </div>
            </div>
          )}

          {/* ── Step: done ── */}
          {step === "done" && (
            <div className="space-y-5">
              <div className="flex flex-col items-center gap-3 py-4 text-center">
                <div className="flex size-14 items-center justify-center rounded-full bg-[rgba(34,197,94,.15)] text-[var(--state-ok)]">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5"/>
                  </svg>
                </div>
                <div>
                  <p className="font-semibold">Агент підключений!</p>
                  <p className="mt-1 text-sm text-[var(--text-muted)]">
                    Тепер можна додавати принтери через Settings → Агент → Сканувати мережу.
                  </p>
                </div>
              </div>

              <button onClick={() => router.replace("/settings")} className={`w-full ${primaryBtn}`}>
                Перейти до Settings → Додати принтери
              </button>
              <button onClick={() => router.replace("/dashboard")} className={`w-full ${ghostBtn} text-center`}>
                Перейти до дашборду
              </button>
            </div>
          )}

        </div>

        <p className="mt-4 text-center text-xs text-[var(--text-faint)]">
          Принтери додаються через{" "}
          <button onClick={() => router.replace("/settings")} className="underline hover:text-[var(--text-muted)]">
            Settings → Агент
          </button>{" "}
          після підключення агента
        </p>
      </div>
    </div>
  );
}
