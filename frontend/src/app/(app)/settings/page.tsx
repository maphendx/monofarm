"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, api, getToken } from "@/lib/api";
import { useUser } from "@/lib/auth-context";

interface OrgSettings {
  id: number;
  name: string;
  slug: string;
  bambu_email: string;
  bambu_region: string;
  bambu_configured: boolean;
}

const inputCls =
  "w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100";

function Badge({ ok }: { ok: boolean }) {
  return ok ? (
    <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-700 dark:bg-green-900/40 dark:text-green-400">
      налаштовано
    </span>
  ) : (
    <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">
      не налаштовано
    </span>
  );
}

interface BillingStatus {
  plan: string;
  usage: { printers: number; users: number };
  limits: { printers: number; users: number };
  price_usd: number;
  plans: Array<{ key: string; price_usd: number; limits: { printers: number; users: number } }>;
}

const PLAN_LABELS: Record<string, string> = { free: "Free", starter: "Starter", pro: "Pro", farm: "Farm" };
const PLAN_DESC: Record<string, string> = {
  free: "Для ознайомлення",
  starter: "Мала ферма",
  pro: "Середня ферма",
  farm: "Велика ферма",
};

function UsageBar({ used, limit, label }: { used: number; limit: number; label: string }) {
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const warn = pct >= 80;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-neutral-500">
        <span>{label}</span>
        <span className={warn ? "font-medium text-amber-600 dark:text-amber-400" : ""}>{used} / {limit}</span>
      </div>
      <div className="h-1.5 rounded-full bg-neutral-100 dark:bg-neutral-800">
        <div
          className={`h-1.5 rounded-full transition-all ${warn ? "bg-amber-500" : "bg-neutral-900 dark:bg-neutral-100"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function BillingSection() {
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [upgrading, setUpgrading] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const inFlight = useRef(false);

  const billingMsg = typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("billing")
    : null;

  useEffect(() => {
    api<BillingStatus>("/api/billing/status").then(setBilling).catch(() => {});
  }, []);

  async function upgrade(plan: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setUpgrading(plan);
    try {
      const { url } = await api<{ url: string }>("/api/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ plan }),
      });
      window.location.assign(url);
    } catch {
      setUpgrading(null);
      inFlight.current = false;
    }
  }

  async function cancelSub() {
    if (inFlight.current) return;
    inFlight.current = true;
    setCancelling(true);
    try {
      await api("/api/billing/cancel", { method: "POST" });
      const updated = await api<BillingStatus>("/api/billing/status");
      setBilling(updated);
      setConfirmCancel(false);
    } catch {
      // ignore
    } finally {
      setCancelling(false);
      inFlight.current = false;
    }
  }

  if (!billing) return null;

  return (
    <section className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <div className="mb-5 flex items-center justify-between">
        <h2 className="font-medium">Підписка</h2>
        <span className="rounded-full bg-neutral-900 px-3 py-0.5 text-xs font-medium text-white dark:bg-neutral-100 dark:text-neutral-900">
          {PLAN_LABELS[billing.plan]} {billing.price_usd > 0 ? `$${billing.price_usd}/міс` : "Безкоштовно"}
        </span>
      </div>

      {billingMsg === "success" && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700 dark:border-green-900/40 dark:bg-green-900/20 dark:text-green-300">
          Підписку оформлено! Ваш план оновлено.
        </div>
      )}
      {billingMsg === "cancel" && (
        <div className="mb-4 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800">
          Оплата скасована — план не змінено.
        </div>
      )}

      {/* Usage */}
      <div className="mb-6 space-y-3 rounded-xl border border-neutral-100 bg-neutral-50 px-4 py-4 dark:border-neutral-800 dark:bg-neutral-800/40">
        <UsageBar used={billing.usage.printers} limit={billing.limits.printers} label="Принтери" />
        <UsageBar used={billing.usage.users} limit={billing.limits.users} label="Користувачі" />
      </div>

      {/* Plan cards */}
      <div className="grid grid-cols-2 gap-3">
        {billing.plans.map((p) => {
          const isCurrent = p.key === billing.plan;
          const isUpgrade = billing.plans.findIndex(x => x.key === billing.plan) < billing.plans.findIndex(x => x.key === p.key);
          return (
            <div key={p.key}
              className={`rounded-xl border p-4 transition ${isCurrent
                ? "border-neutral-900 bg-neutral-50 dark:border-neutral-100 dark:bg-neutral-800"
                : "border-neutral-200 dark:border-neutral-700"}`}
            >
              <div className="mb-1 flex items-center justify-between">
                <span className="text-sm font-medium">{PLAN_LABELS[p.key]}</span>
                {isCurrent && (
                  <span className="rounded bg-neutral-900 px-1.5 py-0.5 text-[10px] text-white dark:bg-neutral-100 dark:text-neutral-900">
                    Поточний
                  </span>
                )}
              </div>
              <p className="mb-1 text-[11px] text-neutral-500">{PLAN_DESC[p.key]}</p>
              <p className="mb-3 text-xs text-neutral-600 dark:text-neutral-400">
                до {p.limits.printers} принтерів · {p.limits.users === 999 ? "∞" : p.limits.users} користувач{p.limits.users === 1 ? "" : "ів"}
              </p>
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">
                  {p.price_usd === 0 ? "Free" : `$${p.price_usd}/міс`}
                </span>
                {!isCurrent && isUpgrade && (
                  <button
                    onClick={() => upgrade(p.key)}
                    disabled={upgrading !== null}
                    className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
                  >
                    {upgrading === p.key ? "…" : "Upgrade"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Cancel subscription */}
      {billing.plan !== "free" && (
        <div className="mt-4 border-t border-neutral-100 pt-4 dark:border-neutral-800">
          {confirmCancel ? (
            <div className="flex items-center gap-3 text-sm">
              <span className="text-neutral-600 dark:text-neutral-400">Скасувати підписку? (план стане Free)</span>
              <button onClick={cancelSub} disabled={cancelling}
                className="text-red-600 hover:underline disabled:opacity-50">
                {cancelling ? "…" : "Так, скасувати"}
              </button>
              <button onClick={() => setConfirmCancel(false)} className="text-neutral-500 hover:underline">
                Ні
              </button>
            </div>
          ) : (
            <button onClick={() => setConfirmCancel(true)}
              className="text-xs text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300">
              Скасувати підписку
            </button>
          )}
        </div>
      )}
    </section>
  );
}

const API_BASE =
  typeof window !== "undefined"
    ? window.location.origin.replace(":3000", ":8000")
    : "http://localhost:8000";

const IS_LOCAL = typeof window !== "undefined" && (
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1"
);

function AgentSection() {
  const token = getToken() ?? "";
  const [copied, setCopied] = useState<string | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [tab, setTab] = useState<"linux" | "docker">("linux");

  const installCmd = `curl -sSL ${API_BASE}/agent/install.sh | sudo bash -s -- --token ${token} --server ${API_BASE}`;
  const dockerCmd  = `docker run --network host --restart unless-stopped \\\n  monofarm/agent \\\n  --server ${API_BASE} \\\n  --token ${token}`;

  useEffect(() => {
    api<{ connected: boolean }>("/api/agent/status")
      .then((r) => setConnected(r.connected))
      .catch(() => setConnected(false));
    const id = setInterval(() => {
      api<{ connected: boolean }>("/api/agent/status")
        .then((r) => setConnected(r.connected))
        .catch(() => setConnected(false));
    }, 5000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  }, []);

  function copy(text: string, key: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    });
  }

  return (
    <section className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-neutral-500">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
          <h2 className="font-medium">Локальний агент</h2>
          <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
            Klipper / Moonraker
          </span>
        </div>
        {connected === null ? (
          <span className="text-xs text-neutral-400">Перевірка…</span>
        ) : connected ? (
          <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            <span className="size-2 rounded-full bg-emerald-500 animate-pulse"/>
            Агент підключений
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-xs text-neutral-400">
            <span className="size-2 rounded-full bg-neutral-300 dark:bg-neutral-600"/>
            Не підключений
          </span>
        )}
      </div>

      <p className="mb-4 text-sm text-neutral-500">
        Запусти агент на Raspberry Pi або PC у мережі принтерів — одна команда, і всі Klipper-принтери з'являться віддалено.
      </p>

      {IS_LOCAL && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-300">
          <strong>Локальна розробка:</strong> сервер на <code>localhost:8000</code>. Агент на тому самому PC підключиться, але для тесту з іншого пристрою потрібна реальна IP-адреса сервера.
        </div>
      )}

      {/* tab switcher */}
      <div className="mb-4 flex gap-1 rounded-lg border border-neutral-100 bg-neutral-50 p-1 dark:border-neutral-800 dark:bg-neutral-800/50">
        {(["linux", "docker"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 rounded-md py-1.5 text-xs font-medium transition ${tab === t ? "bg-white shadow-sm dark:bg-neutral-700" : "text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"}`}>
            {t === "linux" ? "Raspberry Pi / Linux" : "Docker"}
          </button>
        ))}
      </div>

      {tab === "linux" && (
        <div className="space-y-3">
          <p className="text-xs text-neutral-500">
            Одна команда: встановлює залежності, завантажує агент і додає його в <strong>systemd</strong> (автозапуск при перезавантаженні).
          </p>
          <div className="relative">
            <pre className="overflow-x-auto rounded-lg border border-neutral-200 bg-neutral-950 px-4 py-3 text-xs text-emerald-400 dark:border-neutral-700 whitespace-pre-wrap break-all">{installCmd}</pre>
            <button onClick={() => copy(installCmd, "linux")}
              className="absolute right-2 top-2 rounded bg-neutral-800 px-2 py-1 text-[10px] text-neutral-300 hover:bg-neutral-700">
              {copied === "linux" ? "✓" : "Копіювати"}
            </button>
          </div>
          <p className="text-[11px] text-neutral-400">
            Після запуску: <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-800">sudo journalctl -u monofarm-agent -f</code> — перегляд логів
          </p>
        </div>
      )}

      {tab === "docker" && (
        <div className="space-y-3">
          <p className="text-xs text-neutral-500">
            Якщо на Pi вже є Docker — ще простіше.
          </p>
          <div className="relative">
            <pre className="overflow-x-auto rounded-lg border border-neutral-200 bg-neutral-950 px-4 py-3 text-xs text-emerald-400 dark:border-neutral-700 whitespace-pre-wrap break-all">{dockerCmd}</pre>
            <button onClick={() => copy(dockerCmd.replace(/\\\n\s+/g, " "), "docker")}
              className="absolute right-2 top-2 rounded bg-neutral-800 px-2 py-1 text-[10px] text-neutral-300 hover:bg-neutral-700">
              {copied === "docker" ? "✓" : "Копіювати"}
            </button>
          </div>
          <p className="text-[11px] text-neutral-400">
            <code>--network host</code> потрібен щоб агент міг дістатись до Moonraker у локальній мережі.
          </p>
        </div>
      )}

      <p className="mt-4 text-[11px] text-neutral-400">
        Токен надає доступ до твого акаунту — не передавай його третім особам.
      </p>
    </section>
  );
}

export default function SettingsPage() {
  const user = useUser();
  const [settings, setSettings] = useState<OrgSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Danger zone — bulk delete
  const [bulkConfirm, setBulkConfirm] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const bulkInFlight = useRef(false);

  // Bambu email-code flow
  const [codeEmail, setCodeEmail] = useState("");
  const [codeRegion, setCodeRegion] = useState("eu");
  const [codeStep, setCodeStep] = useState<"idle" | "sent" | "done">("idle");
  const [code, setCode] = useState("");
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    api<OrgSettings>("/api/orgs/me")
      .then((s) => {
        setSettings(s);
        setCodeEmail(s.bambu_email || "");
        setCodeRegion(s.bambu_region || "eu");
      })
      .catch((err) => {
        setLoadError(err instanceof ApiError ? err.message : "Помилка завантаження");
      });
  }, []);

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setCodeError(null);
    setCodeBusy(true);
    try {
      await api("/api/orgs/me/bambu-send-code", {
        method: "POST",
        body: JSON.stringify({ email: codeEmail, region: codeRegion }),
      });
      setCodeStep("sent");
      setCode("");
    } catch (err) {
      setCodeError(err instanceof ApiError ? err.message : "Помилка відправки коду");
    } finally {
      setCodeBusy(false);
    }
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setCodeError(null);
    setCodeBusy(true);
    try {
      const updated = await api<OrgSettings>("/api/orgs/me/bambu-verify-code", {
        method: "POST",
        body: JSON.stringify({ email: codeEmail, code: code.trim(), region: codeRegion }),
      });
      setSettings(updated);
      setCodeEmail(updated.bambu_email || "");
      setCodeRegion(updated.bambu_region || "eu");
      setCodeStep("done");
      setReconnecting(false);
    } catch (err) {
      setCodeError(err instanceof ApiError ? err.message : "Помилка перевірки коду");
    } finally {
      setCodeBusy(false);
    }
  }

  async function bulkDelete(kind?: string) {
    if (bulkInFlight.current) return;
    bulkInFlight.current = true;
    setBulkBusy(true);
    setBulkMsg(null);
    setBulkConfirm(null);
    try {
      const url = kind ? `/api/printers?kind=${kind}` : "/api/printers";
      const res = await api<{ deleted: number }>(url, { method: "DELETE" });
      setBulkMsg(`Видалено ${res.deleted} принтерів`);
    } catch (err) {
      setBulkMsg(err instanceof ApiError ? err.message : "Помилка видалення");
    } finally {
      setBulkBusy(false);
      bulkInFlight.current = false;
    }
  }

  if (user?.role !== "admin") {
    return <p className="text-sm text-neutral-500">Тільки для адміністраторів.</p>;
  }

  if (loadError) {
    return <p className="text-sm text-red-600">{loadError}</p>;
  }

  if (!settings) {
    return <p className="text-sm text-neutral-500">Завантаження…</p>;
  }

  return (
    <div className="mx-auto max-w-lg space-y-8">
      <div>
        <h1 className="text-lg font-semibold">{settings.name}</h1>
        <p className="text-sm text-neutral-500">slug: {settings.slug}</p>
      </div>

      {/* Bambu Lab */}
      <section className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <div className="mb-5 flex items-center gap-2">
          <h2 className="font-medium">Bambu Lab</h2>
          <Badge ok={settings.bambu_configured} />
        </div>

        {(codeStep === "done" || settings.bambu_configured) && codeStep !== "sent" && !reconnecting ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700 dark:bg-green-900/20 dark:text-green-300">
              <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              <span>Підключено як <strong>{settings.bambu_email}</strong> ({settings.bambu_region?.toUpperCase()})</span>
            </div>
            <button
              onClick={() => { setReconnecting(true); setCodeStep("idle"); setCodeError(null); }}
              className="text-sm text-neutral-500 underline hover:text-neutral-900 dark:hover:text-neutral-100"
            >
              Перепідключити інший акаунт
            </button>
          </div>
        ) : (
          codeStep === "sent" ? (
            <form onSubmit={verifyCode} className="space-y-3">
              <p className="text-sm text-neutral-500">
                Код надіслано на <strong>{codeEmail}</strong>. Перевір пошту (і папку Спам).
              </p>
              <label className="block">
                <span className="mb-1 block text-sm">6-значний код</span>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  required
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="123456"
                  className={inputCls}
                />
              </label>
              {codeError && <p className="text-sm text-red-600 dark:text-red-400">{codeError}</p>}
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={codeBusy || code.length < 6}
                  className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
                >
                  {codeBusy ? "Перевірка…" : "Підтвердити"}
                </button>
                <button
                  type="button"
                  onClick={() => { setCodeStep("idle"); setCodeError(null); }}
                  className="rounded-md px-4 py-2 text-sm text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  Назад
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={sendCode} className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-sm">Email Bambu-акаунту</span>
                <input
                  type="email"
                  required
                  value={codeEmail}
                  onChange={(e) => setCodeEmail(e.target.value)}
                  placeholder="you@gmail.com"
                  className={inputCls}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm">Регіон</span>
                <select
                  value={codeRegion}
                  onChange={(e) => setCodeRegion(e.target.value)}
                  className={inputCls}
                >
                  <option value="us">US</option>
                  <option value="eu">EU</option>
                  <option value="cn">CN</option>
                </select>
              </label>
              {codeError && <p className="text-sm text-red-600 dark:text-red-400">{codeError}</p>}
              <button
                type="submit"
                disabled={codeBusy || !codeEmail}
                className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
              >
                {codeBusy ? "Надсилання…" : "Надіслати код"}
              </button>
            </form>
          )
        )}
      </section>

      {/* Billing */}
      <BillingSection />

      {/* Agent Connection */}
      <AgentSection />

      {/* Danger zone */}
      <section className="rounded-2xl border border-red-200 bg-white p-6 shadow-sm dark:border-red-900/50 dark:bg-neutral-900">
        <h2 className="mb-4 font-medium text-red-600 dark:text-red-400">Небезпечна зона</h2>
        <div className="space-y-3">
          {(["bambu", "snapmaker_u1", "other", "all"] as const).map((kind) => {
            const label =
              kind === "bambu" ? "Всі Bambu Lab принтери" :
              kind === "snapmaker_u1" ? "Всі Moonraker/Klipper принтери" :
              kind === "other" ? "Всі ручні принтери" :
              "Всі принтери";
            const key = kind === "all" ? undefined : kind;
            return (
              <div key={kind} className="flex items-center justify-between gap-4 rounded-lg border border-neutral-100 px-4 py-3 dark:border-neutral-800">
                <span className="text-sm text-neutral-700 dark:text-neutral-300">{label}</span>
                {bulkConfirm === kind ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-neutral-500">Впевнені?</span>
                    <button
                      onClick={() => bulkDelete(key)}
                      disabled={bulkBusy}
                      className="rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-40 dark:hover:bg-red-900/20"
                    >
                      {bulkBusy && bulkConfirm === kind ? "…" : "Видалити"}
                    </button>
                    <button
                      onClick={() => setBulkConfirm(null)}
                      className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                    >
                      Скасувати
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setBulkMsg(null); setBulkConfirm(kind); }}
                    className="rounded-md border border-red-200 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 dark:border-red-900/50 dark:hover:bg-red-900/20"
                  >
                    Видалити
                  </button>
                )}
              </div>
            );
          })}
          {bulkMsg && (
            <p className="text-sm text-neutral-600 dark:text-neutral-400">{bulkMsg}</p>
          )}
        </div>
      </section>
    </div>
  );
}
