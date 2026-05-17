"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";

// ── types ─────────────────────────────────────────────────────────────────────

type ConnectionType = "bambu" | "moonraker" | "manual";
type Step =
  | "choose"
  | "bambu_email" | "bambu_code"
  | "moonraker_form"
  | "manual_form"
  | "done";

// ── shared styles ─────────────────────────────────────────────────────────────

const inp =
  "w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100";

const primaryBtn =
  "rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300";

const ghostBtn =
  "rounded-md px-4 py-2 text-sm text-neutral-500 transition hover:bg-neutral-100 dark:hover:bg-neutral-800";

// ── mascot ────────────────────────────────────────────────────────────────────

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

// ── icons ─────────────────────────────────────────────────────────────────────

function IconBambu() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a10 10 0 1 0 10 10"/>
      <path d="M12 6v6l4 2"/>
      <path d="M18 2v4h4"/>
    </svg>
  );
}

function IconMoonraker() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2"/>
      <path d="M8 21h8M12 17v4"/>
      <path d="M7 8h10M7 11h6"/>
    </svg>
  );
}

function IconManual() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>
  );
}

function IconCheck() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5"/>
    </svg>
  );
}

function IconArrow() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18l6-6-6-6"/>
    </svg>
  );
}

// ── step dots ─────────────────────────────────────────────────────────────────

const STEP_INDEX: Record<Step, number> = {
  choose: 0,
  bambu_email: 1, bambu_code: 1,
  moonraker_form: 1,
  manual_form: 1,
  done: 2,
};

function StepDots({ step }: { step: Step }) {
  const cur = STEP_INDEX[step];
  return (
    <div className="flex items-center gap-1.5">
      {[0, 1, 2].map((i) => (
        <div key={i} className={`h-1.5 rounded-full transition-all duration-300 ${
          i === cur ? "w-5 bg-neutral-900 dark:bg-neutral-100"
          : i < cur  ? "w-1.5 bg-neutral-400"
                     : "w-1.5 bg-neutral-200 dark:bg-neutral-700"
        }`}/>
      ))}
    </div>
  );
}

// ── connection type card ──────────────────────────────────────────────────────

function TypeCard({
  icon, title, desc, badge, onClick,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group flex w-full items-center gap-4 rounded-xl border border-neutral-200 bg-white px-5 py-4 text-left transition hover:border-neutral-400 hover:shadow-sm dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-600"
    >
      <div className="flex size-12 shrink-0 items-center justify-center rounded-lg border border-neutral-100 bg-neutral-50 text-neutral-600 dark:border-neutral-800 dark:bg-neutral-800/50 dark:text-neutral-400">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{title}</span>
          {badge && (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
              {badge}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-neutral-500">{desc}</p>
      </div>
      <IconArrow />
    </button>
  );
}

// ── main page ─────────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("choose");
  const [connType, setConnType] = useState<ConnectionType | null>(null);

  // Bambu state
  const [bambuEmail, setBambuEmail] = useState("");
  const [bambuRegion, setBambuRegion] = useState("eu");
  const [bambuCode, setBambuCode] = useState("");

  // Moonraker state
  const [mrName, setMrName] = useState("");
  const [mrUrl, setMrUrl] = useState("");

  // Manual state
  const [manualName, setManualName] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function choose(type: ConnectionType) {
    setConnType(type);
    setError(null);
    if (type === "bambu") setStep("bambu_email");
    else if (type === "moonraker") setStep("moonraker_form");
    else setStep("manual_form");
  }

  function back() {
    setError(null);
    if (step === "bambu_code") { setStep("bambu_email"); setBambuCode(""); return; }
    setStep("choose");
    setConnType(null);
  }

  // Bambu: send code
  async function sendBambuCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/api/orgs/me/bambu-send-code", {
        method: "POST",
        body: JSON.stringify({ email: bambuEmail, region: bambuRegion }),
      });
      setStep("bambu_code");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка відправки");
    } finally {
      setBusy(false);
    }
  }

  // Bambu: verify code
  async function verifyBambuCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/api/orgs/me/bambu-verify-code", {
        method: "POST",
        body: JSON.stringify({ email: bambuEmail, code: bambuCode.trim(), region: bambuRegion }),
      });
      setStep("done");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Невірний або прострочений код");
    } finally {
      setBusy(false);
    }
  }

  // Moonraker: create printer
  async function addMoonraker(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/api/printers", {
        method: "POST",
        body: JSON.stringify({
          name: mrName.trim(),
          kind: "snapmaker_u1",
          moonraker_url: mrUrl.trim(),
        }),
      });
      setStep("done");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка створення принтера");
    } finally {
      setBusy(false);
    }
  }

  // Manual: create printer
  async function addManual(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/api/printers", {
        method: "POST",
        body: JSON.stringify({ name: manualName.trim(), kind: "other" }),
      });
      setStep("done");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка створення принтера");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4 py-16 dark:bg-neutral-950">
      <div className="w-full max-w-md">

        {/* header */}
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Mascot size={36} />
            <div>
              <p className="text-[11px] font-medium uppercase tracking-widest text-neutral-400">monofarm</p>
              <h1 className="text-lg font-bold leading-tight">Підключення принтерів</h1>
            </div>
          </div>
          <StepDots step={step} />
        </div>

        <div className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">

          {/* ── STEP: choose ── */}
          {step === "choose" && (
            <div className="space-y-3">
              <div className="mb-5">
                <p className="text-sm font-medium">Який тип принтера підключаємо?</p>
                <p className="mt-0.5 text-xs text-neutral-400">Оберіть спосіб підключення — кроки відрізняються залежно від типу</p>
              </div>

              <TypeCard
                icon={<IconBambu />}
                title="Bambu Lab"
                desc="P1S, A1, X1C, A1 Mini — підключення через хмарний акаунт"
                badge="Авто-імпорт"
                onClick={() => choose("bambu")}
              />
              <TypeCard
                icon={<IconMoonraker />}
                title="Klipper / Moonraker"
                desc="Snapmaker, Voron, Rat Rig та будь-який Klipper принтер — пряме REST підключення"
                onClick={() => choose("moonraker")}
              />
              <TypeCard
                icon={<IconManual />}
                title="Ручне відстеження"
                desc="Будь-який принтер без API — оператор оновлює стан вручну"
                onClick={() => choose("manual")}
              />

              <div className="pt-2">
                <button
                  onClick={() => router.replace("/dashboard")}
                  className="w-full text-center text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                >
                  Пропустити, додам принтери пізніше →
                </button>
              </div>
            </div>
          )}

          {/* ── STEP: bambu email ── */}
          {step === "bambu_email" && (
            <form onSubmit={sendBambuCode} className="space-y-5">
              <div className="flex items-start gap-3 rounded-lg border border-neutral-100 bg-neutral-50 px-4 py-3 dark:border-neutral-800 dark:bg-neutral-800/40">
                <IconBambu />
                <div>
                  <p className="text-sm font-semibold">Bambu Lab</p>
                  <p className="text-xs text-neutral-500">Крок 1 з 2 — підтвердження email</p>
                </div>
              </div>

              <div className="space-y-1 text-xs text-neutral-500">
                <p className="font-medium text-neutral-700 dark:text-neutral-300">Як це працює:</p>
                <ol className="list-decimal space-y-0.5 pl-4">
                  <li>Введіть email вашого Bambu-акаунту</li>
                  <li>Отримайте 6-значний код на пошту</li>
                  <li>Принтери з'являться автоматично</li>
                </ol>
              </div>

              <div className="space-y-3">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400">Email акаунту Bambu Lab</span>
                  <input type="email" required autoFocus value={bambuEmail} onChange={(e) => setBambuEmail(e.target.value)} placeholder="you@gmail.com" className={inp} />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400">Регіон сервера</span>
                  <select value={bambuRegion} onChange={(e) => setBambuRegion(e.target.value)} className={inp}>
                    <option value="eu">EU — Європа</option>
                    <option value="us">US — США</option>
                    <option value="cn">CN — Китай</option>
                  </select>
                </label>
              </div>

              {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

              <div className="flex gap-2">
                <button type="submit" disabled={busy || !bambuEmail} className={primaryBtn}>
                  {busy ? "Надсилання…" : "Надіслати код"}
                </button>
                <button type="button" onClick={back} className={ghostBtn}>Назад</button>
              </div>
            </form>
          )}

          {/* ── STEP: bambu code ── */}
          {step === "bambu_code" && (
            <form onSubmit={verifyBambuCode} className="space-y-5">
              <div className="flex items-start gap-3 rounded-lg border border-neutral-100 bg-neutral-50 px-4 py-3 dark:border-neutral-800 dark:bg-neutral-800/40">
                <IconBambu />
                <div>
                  <p className="text-sm font-semibold">Bambu Lab</p>
                  <p className="text-xs text-neutral-500">Крок 2 з 2 — введіть код</p>
                </div>
              </div>

              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-300">
                Код надіслано на <strong>{bambuEmail}</strong>. Перевір пошту та папку &quot;Спам&quot;. Код діє кілька хвилин.
              </div>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400">6-значний код підтвердження</span>
                <input
                  type="text" inputMode="numeric" maxLength={6} required autoFocus
                  value={bambuCode}
                  onChange={(e) => setBambuCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="123456"
                  className={`${inp} text-center text-xl font-mono tracking-[0.4em]`}
                />
              </label>

              {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

              <div className="flex gap-2">
                <button type="submit" disabled={busy || bambuCode.length < 6} className={primaryBtn}>
                  {busy ? "Перевірка…" : "Підтвердити"}
                </button>
                <button type="button" onClick={back} className={ghostBtn}>Назад</button>
              </div>
              <button
                type="button"
                onClick={(e) => sendBambuCode(e as unknown as React.FormEvent)}
                className="text-xs text-neutral-400 underline hover:text-neutral-600"
              >
                Надіслати код повторно
              </button>
            </form>
          )}

          {/* ── STEP: moonraker form ── */}
          {step === "moonraker_form" && (
            <form onSubmit={addMoonraker} className="space-y-5">
              <div className="flex items-start gap-3 rounded-lg border border-neutral-100 bg-neutral-50 px-4 py-3 dark:border-neutral-800 dark:bg-neutral-800/40">
                <IconMoonraker />
                <div>
                  <p className="text-sm font-semibold">Klipper / Moonraker</p>
                  <p className="text-xs text-neutral-500">Підключення через Moonraker REST API</p>
                </div>
              </div>

              <div className="space-y-1 text-xs text-neutral-500">
                <p className="font-medium text-neutral-700 dark:text-neutral-300">Що потрібно:</p>
                <ol className="list-decimal space-y-0.5 pl-4">
                  <li>Принтер з Klipper + Moonraker</li>
                  <li>URL Moonraker (зазвичай <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-800">http://192.168.x.x:7125</code>)</li>
                  <li>Принтер і сервер — в одній мережі</li>
                </ol>
              </div>

              <div className="space-y-3">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400">Назва принтера</span>
                  <input type="text" required autoFocus value={mrName} onChange={(e) => setMrName(e.target.value)} placeholder="Snapmaker J1s" className={inp} />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400">Moonraker URL</span>
                  <input type="url" required value={mrUrl} onChange={(e) => setMrUrl(e.target.value)} placeholder="http://192.168.1.100:7125" className={inp} />
                  <span className="mt-1 block text-[11px] text-neutral-400">Знайди у Mainsail → Settings → прокрути до адреси</span>
                </label>
              </div>

              {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

              <div className="flex gap-2">
                <button type="submit" disabled={busy || !mrName || !mrUrl} className={primaryBtn}>
                  {busy ? "Додавання…" : "Додати принтер"}
                </button>
                <button type="button" onClick={back} className={ghostBtn}>Назад</button>
              </div>
            </form>
          )}

          {/* ── STEP: manual form ── */}
          {step === "manual_form" && (
            <form onSubmit={addManual} className="space-y-5">
              <div className="flex items-start gap-3 rounded-lg border border-neutral-100 bg-neutral-50 px-4 py-3 dark:border-neutral-800 dark:bg-neutral-800/40">
                <IconManual />
                <div>
                  <p className="text-sm font-semibold">Ручне відстеження</p>
                  <p className="text-xs text-neutral-500">Стан оновлюється оператором</p>
                </div>
              </div>

              <div className="rounded-lg border border-neutral-100 bg-neutral-50 px-4 py-3 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-800/40">
                Підходить для будь-якого принтера: Ender, Prusa, Bambu без хмари, тощо. Оператор вручну вказує що друкується і коли готово.
              </div>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400">Назва принтера</span>
                <input type="text" required autoFocus value={manualName} onChange={(e) => setManualName(e.target.value)} placeholder="Ender-3 #1" className={inp} />
              </label>

              {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

              <div className="flex gap-2">
                <button type="submit" disabled={busy || !manualName} className={primaryBtn}>
                  {busy ? "Додавання…" : "Додати принтер"}
                </button>
                <button type="button" onClick={back} className={ghostBtn}>Назад</button>
              </div>
            </form>
          )}

          {/* ── STEP: done ── */}
          {step === "done" && (
            <div className="space-y-5">
              <div className="flex flex-col items-center gap-3 py-4 text-center">
                <div className="flex size-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400">
                  <IconCheck />
                </div>
                <div>
                  <p className="font-semibold">
                    {connType === "bambu" && "Bambu Lab підключено!"}
                    {connType === "moonraker" && "Принтер додано!"}
                    {connType === "manual" && "Принтер додано!"}
                  </p>
                  <p className="mt-1 text-sm text-neutral-500">
                    {connType === "bambu"
                      ? "Принтери з'являться на дашборді автоматично."
                      : "Принтер доступний у вашій фермі."}
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <button onClick={() => router.replace("/dashboard")} className={`w-full ${primaryBtn}`}>
                  Перейти до дашборду
                </button>
                <button
                  onClick={() => { setStep("choose"); setConnType(null); setError(null); setBambuCode(""); setMrName(""); setMrUrl(""); setManualName(""); }}
                  className={`w-full ${ghostBtn} text-center`}
                >
                  Додати ще один принтер
                </button>
              </div>
            </div>
          )}

        </div>

        {/* footer */}
        <p className="mt-4 text-center text-xs text-neutral-400">
          Принтери можна додати та налаштувати пізніше в розділі{" "}
          <button onClick={() => router.replace("/printers")} className="underline hover:text-neutral-600">Принтери</button>
        </p>
      </div>
    </div>
  );
}
