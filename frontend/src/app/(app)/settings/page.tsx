"use client";

import { ApiError, api, getToken } from "@/lib/api";
import { useUser } from "@/lib/auth-context";
import { useEffect, useRef, useState } from "react";

// ── Types ──────────────────────────────────────────────────────────────────

interface OrgSettings {
  id: number;
  name: string;
  slug: string;
  bambu_email: string;
  bambu_region: string;
  bambu_configured: boolean;
  tg_configured: boolean;
  tg_bot_username: string | null;
}

interface BillingStatus {
  plan: string;
  usage: { printers: number; users: number };
  limits: { printers: number; users: number };
  price_usd: number;
  plans: Array<{ key: string; price_usd: number; limits: { printers: number; users: number } }>;
  extra_slots?: number;
  extra_price_usd?: number | null;
  max_printers?: number | null;
}

type SectionId =
  | "general" | "organization" | "printers" | "filament"
  | "queue" | "notifications" | "maintenance" | "integrations" | "billing";

// ── Nav config ─────────────────────────────────────────────────────────────

const NAV_ITEMS: Array<{ id: SectionId; label: string; d: string[] }> = [
  {
    id: "general", label: "Загальне",
    d: ["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"],
  },
  {
    id: "organization", label: "Організація",
    d: ["M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "M9 22V12h6v10"],
  },
  {
    id: "printers", label: "Принтери",
    d: ["M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2", "M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6", "M6 18h12v3H6z"],
  },
  {
    id: "filament", label: "Пластик",
    d: ["M12 2a10 10 0 1 0 10 10", "M12 8a4 4 0 1 0 4 4", "M12 12h.01"],
  },
  {
    id: "queue", label: "Черга",
    d: ["M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"],
  },
  {
    id: "notifications", label: "Сповіщення",
    d: ["M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9", "M13.73 21a2 2 0 0 1-3.46 0"],
  },
  {
    id: "maintenance", label: "Обслуговування",
    d: ["M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"],
  },
  {
    id: "integrations", label: "Вебхуки & API",
    d: ["M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"],
  },
  {
    id: "billing", label: "Білінг",
    d: ["M21 4H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z", "M1 10h22"],
  },
];

// ── Shared UI ──────────────────────────────────────────────────────────────

const inputCls =
  "w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100";

function SectionCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      {children}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-5 font-semibold">{children}</h2>;
}

function ComingSoon({ label }: { label: string }) {
  return (
    <SectionCard>
      <SectionTitle>{label}</SectionTitle>
      <p className="text-sm text-neutral-400">Незабаром</p>
    </SectionCard>
  );
}

function NavIcon({ d }: { d: string[] }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      {d.map((p, i) => <path key={i} d={p} />)}
    </svg>
  );
}

// ── Billing ────────────────────────────────────────────────────────────────

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
  const [extraSlots, setExtraSlots] = useState(0);
  const [savingSlots, setSavingSlots] = useState(false);
  const inFlight = useRef(false);

  const billingMsg = typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("billing")
    : null;

  useEffect(() => {
    api<BillingStatus>("/api/billing/status").then((b) => {
      setBilling(b);
      setExtraSlots(b.extra_slots ?? 0);
    }).catch(() => { });
  }, []);

  async function saveExtraSlots() {
    if (savingSlots) return;
    setSavingSlots(true);
    try {
      await api("/api/orgs/me/extra-printer-slots", {
        method: "POST",
        body: JSON.stringify({ slots: extraSlots }),
      });
      const updated = await api<BillingStatus>("/api/billing/status");
      setBilling(updated);
      setExtraSlots(updated.extra_slots ?? 0);
    } catch {
      // ignore
    } finally {
      setSavingSlots(false);
    }
  }

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
    <SectionCard>
      <div className="mb-5 flex items-center justify-between">
        <SectionTitle>Білінг</SectionTitle>
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

      <div className="mb-6 space-y-3 rounded-xl border border-neutral-100 bg-neutral-50 px-4 py-4 dark:border-neutral-800 dark:bg-neutral-800/40">
        <UsageBar used={billing.usage.printers} limit={billing.limits.printers} label="Принтери" />
        <UsageBar used={billing.usage.users} limit={billing.limits.users} label="Користувачі" />
      </div>

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

      {/* ── Extra printer slots ── */}
      {billing.extra_price_usd != null && (
        <div className="mt-4 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-800/40">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Додаткові принтери</p>
              <p className="text-xs text-neutral-500">
                ${billing.extra_price_usd}/принтер/міс · база {billing.limits.printers - (billing.extra_slots ?? 0)} +{" "}
                {billing.extra_slots ?? 0} extra
                {billing.max_printers != null && ` · макс ${billing.max_printers}`}
              </p>
            </div>
            <span className="text-sm font-semibold">
              ${(billing.price_usd + (extraSlots * (billing.extra_price_usd ?? 0))).toFixed(0)}/міс
            </span>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-900">
              <button
                onClick={() => setExtraSlots((n) => Math.max(0, n - 1))}
                className="px-3 py-1.5 text-sm font-medium text-neutral-600 transition hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800 rounded-l-lg"
              >−</button>
              <span className="w-8 text-center text-sm font-semibold">{extraSlots}</span>
              <button
                onClick={() => setExtraSlots((n) => {
                  const base = billing.limits.printers - (billing.extra_slots ?? 0);
                  const maxExtra = billing.max_printers != null ? billing.max_printers - base : 999;
                  return Math.min(maxExtra, n + 1);
                })}
                className="px-3 py-1.5 text-sm font-medium text-neutral-600 transition hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800 rounded-r-lg"
              >+</button>
            </div>
            <button
              onClick={saveExtraSlots}
              disabled={savingSlots || extraSlots === (billing.extra_slots ?? 0)}
              className="rounded-lg bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              {savingSlots ? "…" : "Зберегти"}
            </button>
            {extraSlots !== (billing.extra_slots ?? 0) && (
              <span className="text-xs text-neutral-400">
                {extraSlots > (billing.extra_slots ?? 0) ? "+" : ""}{extraSlots - (billing.extra_slots ?? 0)} слот{Math.abs(extraSlots - (billing.extra_slots ?? 0)) === 1 ? "" : "и"}
              </span>
            )}
          </div>
        </div>
      )}

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
    </SectionCard>
  );
}

// ── Agent ──────────────────────────────────────────────────────────────────

const API_BASE =
  typeof window !== "undefined"
    ? window.location.origin.replace(":3000", ":8000")
    : "http://localhost:8000";

const IS_LOCAL = typeof window !== "undefined" && (
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1"
);

function CmdBlock({ cmd, id, copied, onCopy }: { cmd: string; id: string; copied: string | null; onCopy: (t: string, k: string) => void }) {
  return (
    <div className="relative mt-3">
      <pre className="overflow-x-auto rounded-lg bg-neutral-950 px-4 py-3 text-xs text-emerald-400 whitespace-pre-wrap break-all leading-relaxed">{cmd}</pre>
      <button
        onClick={() => onCopy(cmd.replace(/\\\n\s+/g, " "), id)}
        className="absolute right-2 top-2 rounded bg-neutral-800 px-2 py-1 text-[10px] text-neutral-400 transition hover:bg-neutral-700 hover:text-white"
      >
        {copied === id ? "✓ Скопійовано" : "Копіювати"}
      </button>
    </div>
  );
}

// ── Discover sub-component ─────────────────────────────────────────────────

type BambuDev = { dev_id: string; ip: string; name: string; model: string };
type MrDev    = { url: string; name: string };

function DiscoverSection({ orgPlan }: { orgPlan?: string }) {
  const [discovering, setDiscovering] = useState(false);
  const [result, setResult]   = useState<{ bambu: BambuDev[]; moonraker: MrDev[] } | null>(null);
  const [limit,  setLimit]    = useState<{ count: number; limit: number } | null>(null);
  const [err, setErr]         = useState<string | null>(null);
  const [addingKey, setAddingKey]   = useState<string | null>(null);
  const [addedKeys, setAddedKeys]   = useState<Set<string>>(new Set());
  const [inputs, setInputs]         = useState<Record<string, { name: string; access_code: string }>>({});

  useEffect(() => {
    api<{ count: number; limit: number; plan: string }>("/api/printers/limit")
      .then((r) => setLimit({ count: r.count, limit: r.limit }))
      .catch(() => {});
  }, [addedKeys]);

  async function scan() {
    setDiscovering(true); setErr(null); setResult(null);
    try {
      const r = await api<{ bambu: BambuDev[]; moonraker: MrDev[] }>("/api/printers/discover");
      setResult(r);
      const init: Record<string, { name: string; access_code: string }> = {};
      r.bambu.forEach((d) => { init[d.dev_id] = { name: d.name || d.model || d.dev_id, access_code: "" }; });
      r.moonraker.forEach((d) => { init[d.url] = { name: d.name || d.url, access_code: "" }; });
      setInputs(init);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Помилка сканування");
    } finally {
      setDiscovering(false);
    }
  }

  async function addBambu(d: BambuDev) {
    const inp = inputs[d.dev_id] ?? { name: d.name, access_code: "" };
    setAddingKey(d.dev_id);
    try {
      await api("/api/printers", {
        method: "POST",
        body: JSON.stringify({
          name: inp.name || d.name || d.dev_id,
          kind: "bambu",
          bambu_dev_id: d.dev_id,
          bambu_dev_ip: d.ip,
          bambu_access_code: inp.access_code,
          bambu_model: d.model,
        }),
      });
      setAddedKeys((prev) => new Set(prev).add(d.dev_id));
    } catch (e) {
      alert(e instanceof Error ? e.message : "Помилка додавання");
    } finally {
      setAddingKey(null);
    }
  }

  async function addMoonraker(d: MrDev) {
    const inp = inputs[d.url] ?? { name: d.name, access_code: "" };
    setAddingKey(d.url);
    try {
      await api("/api/printers", {
        method: "POST",
        body: JSON.stringify({
          name: inp.name || d.name || d.url,
          kind: "snapmaker_u1",
          moonraker_url: d.url,
        }),
      });
      setAddedKeys((prev) => new Set(prev).add(d.url));
    } catch (e) {
      alert(e instanceof Error ? e.message : "Помилка додавання");
    } finally {
      setAddingKey(null);
    }
  }

  const atLimit = limit !== null && limit.count >= limit.limit;
  const total   = (result?.bambu.length ?? 0) + (result?.moonraker.length ?? 0);

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Додати принтери</h3>
          <p className="mt-0.5 text-xs text-neutral-400">Агент сканує локальну мережу і знаходить Bambu + Klipper принтери</p>
        </div>
        {limit && (
          <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${atLimit ? "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400" : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"}`}>
            {limit.count}/{limit.limit} принтерів
          </span>
        )}
      </div>

      {atLimit && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-800/40 dark:bg-amber-950/20 dark:text-amber-300">
          Досягнуто ліміт плану <strong>{orgPlan}</strong>. Оновіть план щоб додати більше принтерів.
        </div>
      )}

      <button
        onClick={scan}
        disabled={discovering || atLimit}
        className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
      >
        {discovering ? "Сканування… (до 60 с)" : "Сканувати мережу"}
      </button>

      {err && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{err}</p>}

      {result && total === 0 && (
        <p className="mt-4 text-xs text-neutral-400">Нових принтерів не знайдено. Переконайся що принтери увімкнені та в одній мережі з агентом.</p>
      )}

      {result && total > 0 && (
        <div className="mt-4 space-y-3">
          {result.bambu.map((d) => {
            const key = d.dev_id;
            const done = addedKeys.has(key);
            const inp  = inputs[key] ?? { name: d.name, access_code: "" };
            return (
              <div key={key} className="rounded-xl border border-neutral-100 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-800/40">
                <div className="mb-3 flex items-center gap-2">
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">Bambu</span>
                  <span className="text-xs font-medium">{d.model || d.dev_id}</span>
                  <span className="text-[11px] text-neutral-400">{d.ip}</span>
                </div>
                {!done && (
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      placeholder="Назва"
                      value={inp.name}
                      onChange={(e) => setInputs((p) => ({ ...p, [key]: { ...inp, name: e.target.value } }))}
                      className="rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-900"
                    />
                    <input
                      placeholder="Access Code (з принтера)"
                      value={inp.access_code}
                      onChange={(e) => setInputs((p) => ({ ...p, [key]: { ...inp, access_code: e.target.value } }))}
                      className="rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-900"
                    />
                  </div>
                )}
                <div className="mt-2 flex justify-end">
                  {done ? (
                    <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">✓ Додано</span>
                  ) : (
                    <button
                      onClick={() => addBambu(d)}
                      disabled={addingKey === key || !inp.access_code}
                      className="rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
                    >
                      {addingKey === key ? "Додавання…" : "Додати"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {result.moonraker.map((d) => {
            const key = d.url;
            const done = addedKeys.has(key);
            const inp  = inputs[key] ?? { name: d.name, access_code: "" };
            return (
              <div key={key} className="rounded-xl border border-neutral-100 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-800/40">
                <div className="mb-3 flex items-center gap-2">
                  <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-900/30 dark:text-violet-400">Klipper</span>
                  <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{d.url}</span>
                </div>
                {!done && (
                  <input
                    placeholder="Назва принтера"
                    value={inp.name}
                    onChange={(e) => setInputs((p) => ({ ...p, [key]: { ...inp, name: e.target.value } }))}
                    className="w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-900"
                  />
                )}
                <div className="mt-2 flex justify-end">
                  {done ? (
                    <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">✓ Додано</span>
                  ) : (
                    <button
                      onClick={() => addMoonraker(d)}
                      disabled={addingKey === key}
                      className="rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
                    >
                      {addingKey === key ? "Додавання…" : "Додати"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AgentSection() {
  const token = getToken() ?? "";
  const [copied, setCopied] = useState<string | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [pairStatus, setPairStatus] = useState<"idle" | "busy" | "done" | "error">("idle");

  const pairPort = typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("agent_pair")
    : null;

  async function connectAgent() {
    if (!pairPort || !token) return;
    setPairStatus("busy");
    try {
      await fetch(`http://127.0.0.1:${pairPort}/?token=${encodeURIComponent(token)}`);
      setPairStatus("done");
      const url = new URL(window.location.href);
      url.searchParams.delete("agent_pair");
      window.history.replaceState({}, "", url.toString());
    } catch {
      setPairStatus("error");
    }
  }

  const cmds = {
    linux:   `curl -sSL ${API_BASE}/agent/install.sh | sudo bash -s -- --server ${API_BASE}`,
    windows: `irm ${API_BASE}/agent/install.ps1 | iex`,
    docker:  `docker run --network host --restart unless-stopped \\\n  monofarm/agent \\\n  --server ${API_BASE}`,
  };

  useEffect(() => {
    const poll = () =>
      api<{ connected: boolean }>("/api/agent/status")
        .then((r) => setConnected(r.connected))
        .catch(() => setConnected(false));
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);

  function copy(text: string, key: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    });
  }

  return (
    <div className="space-y-5">

      {/* ── Header ── */}
      <div className="rounded-2xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="mb-1.5 flex items-center gap-2.5">
              <h2 className="text-base font-semibold">Локальний агент</h2>
              <span className="rounded-full bg-violet-100 px-2.5 py-0.5 text-[11px] font-medium text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
                Klipper · Moonraker
              </span>
            </div>
            <p className="max-w-xl text-sm text-neutral-500 dark:text-neutral-400">
              Тунель між локальними принтерами і хмарою. Встанови на Raspberry Pi або будь-якому PC у мережі принтерів — і вони з&apos;являться в monofarm автоматично.
            </p>
          </div>
          {/* Status badge */}
          <div className="shrink-0">
            {connected === null ? (
              <span className="rounded-full border border-neutral-200 px-3 py-1.5 text-xs text-neutral-400 dark:border-neutral-700">
                Перевірка…
              </span>
            ) : connected ? (
              <span className="flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 dark:border-emerald-800/50 dark:bg-emerald-950/30 dark:text-emerald-400">
                <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
                Агент підключений
              </span>
            ) : (
              <span className="flex items-center gap-2 rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-xs text-neutral-500 dark:border-neutral-700 dark:bg-neutral-800">
                <span className="size-1.5 rounded-full bg-neutral-400" />
                Не підключений
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── Pairing banner ── */}
      {pairPort && (
        <div className="rounded-2xl border-2 border-violet-300 bg-violet-50 p-6 dark:border-violet-700/60 dark:bg-violet-950/20">
          <div className="flex items-center justify-between gap-6">
            <div>
              <p className="mb-1 text-sm font-semibold text-violet-900 dark:text-violet-200">
                Агент очікує підключення
              </p>
              <p className="text-xs text-violet-600 dark:text-violet-400">
                Натисни кнопку — токен передасться агенту автоматично, більше нічого вводити не потрібно.
              </p>
            </div>
            {pairStatus === "done" ? (
              <div className="flex shrink-0 items-center gap-2 rounded-xl bg-emerald-500/10 px-4 py-2.5 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                <span className="size-2 rounded-full bg-emerald-500" />
                Підключено!
              </div>
            ) : pairStatus === "error" ? (
              <div className="shrink-0 text-right">
                <p className="mb-1 text-xs text-red-600 dark:text-red-400">Агент більше не чекає — перезапусти його.</p>
                <button onClick={() => setPairStatus("idle")} className="text-xs text-neutral-500 hover:underline">Скинути</button>
              </div>
            ) : (
              <button
                onClick={connectAgent}
                disabled={pairStatus === "busy"}
                className="shrink-0 rounded-xl bg-violet-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700 disabled:opacity-50"
              >
                {pairStatus === "busy" ? "Підключення…" : "Підключити агент →"}
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Setup cards grid ── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">

        {/* Linux / Pi */}
        <div className="flex flex-col rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="mb-3 flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-lg bg-neutral-100 dark:bg-neutral-800">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10A15.3 15.3 0 0 1 12 2z"/>
              </svg>
            </span>
            <div>
              <p className="text-sm font-semibold">Linux / Raspberry Pi</p>
              <p className="text-[11px] text-neutral-400">systemd автозапуск</p>
            </div>
          </div>
          <p className="mb-1 text-xs text-neutral-500 dark:text-neutral-400">
            Одна команда — встановлює залежності, агент і systemd-сервіс.
          </p>
          <CmdBlock cmd={cmds.linux} id="linux" copied={copied} onCopy={copy} />
          <p className="mt-3 text-[11px] text-neutral-400">
            Логи: <code className="rounded bg-neutral-100 px-1 py-0.5 dark:bg-neutral-800">journalctl --user -u monofarm-agent -f</code>
          </p>
        </div>

        {/* Windows */}
        <div className="flex flex-col rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="mb-3 flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-lg bg-neutral-100 dark:bg-neutral-800">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-13.051-1.801"/>
              </svg>
            </span>
            <div>
              <p className="text-sm font-semibold">Windows</p>
              <p className="text-[11px] text-neutral-400">Task Scheduler автозапуск</p>
            </div>
          </div>
          <p className="mb-1 text-xs text-neutral-500 dark:text-neutral-400">
            PowerShell (не CMD). Встановлює Python якщо потрібно, реєструє завдання при вході.
          </p>
          <CmdBlock cmd={cmds.windows} id="windows" copied={copied} onCopy={copy} />
          <p className="mt-3 text-[11px] text-neutral-400">
            Логи: <code className="rounded bg-neutral-100 px-1 py-0.5 dark:bg-neutral-800">Get-Content ~\.monofarm-agent\agent.log -Wait</code>
          </p>
        </div>

        {/* Docker */}
        <div className="flex flex-col rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="mb-3 flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-lg bg-neutral-100 dark:bg-neutral-800">
              <svg width="18" height="14" viewBox="0 0 24 19" fill="currentColor">
                <path d="M13 7h2V5h-2v2zm-3 0h2V5h-2v2zM7 7h2V5H7v2zm3-3h2V2h-2v2zM7 4h2V2H7v2zM2.6 19C1.2 19 0 17.9 0 16.6c0-.2 0-.4.1-.6L1.5 9h21l1.4 6c0 .2.1.4.1.6 0 1.3-1.2 2.4-2.6 2.4H2.6zM22 7H4c-.6 0-1 .4-1 1v.5L1.5 9h21L21 8.5V8c0-.6-.4-1-1-1z"/>
              </svg>
            </span>
            <div>
              <p className="text-sm font-semibold">Docker</p>
              <p className="text-[11px] text-neutral-400">--network host потрібен</p>
            </div>
          </div>
          <p className="mb-1 text-xs text-neutral-500 dark:text-neutral-400">
            Якщо на Pi вже є Docker — найпростіший варіант.
          </p>
          <CmdBlock cmd={cmds.docker} id="docker" copied={copied} onCopy={copy} />
          <p className="mt-3 text-[11px] text-neutral-400">
            <code>--network host</code> потрібен щоб агент дістався до Moonraker у LAN.
          </p>
        </div>

      </div>

      {/* ── How it works ── */}
      <div className="rounded-2xl border border-neutral-100 bg-neutral-50 p-5 dark:border-neutral-800 dark:bg-neutral-800/40">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-400">Як це працює</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {[
            { n: "1", t: "Запусти агент", d: "Без токена — браузер відкривається автоматично" },
            { n: "2", t: "Натисни кнопку", d: "У вкладці Settings → натисни «Підключити агент»" },
            { n: "3", t: "Готово", d: "Токен збережено, наступні запуски — без аргументів" },
          ].map(({ n, t, d }) => (
            <div key={n} className="flex gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-xs font-bold text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
                {n}
              </span>
              <div>
                <p className="text-xs font-medium text-neutral-700 dark:text-neutral-300">{t}</p>
                <p className="text-[11px] text-neutral-400">{d}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Discover printers (only when agent connected) ── */}
      {connected && <DiscoverSection />}

    </div>
  );
}

// ── Organisation section ───────────────────────────────────────────────────

function BadgeStatus({ ok }: { ok: boolean }) {
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

// ── KeyCRM Section ─────────────────────────────────────────────────────────

function KeyCRMSection() {
  const [data,         setData]         = useState<{ keycrm_api_key: string; webhook_url: string; keycrm_configured: boolean } | null>(null);
  const [apiKey,       setApiKey]       = useState("");
  const [secret,       setSecret]       = useState("");
  const [copied,       setCopied]       = useState(false);
  const [saving,       setSaving]       = useState(false);
  const [saved,        setSaved]        = useState(false);
  const [error,        setError]        = useState<string | null>(null);

  useEffect(() => {
    api<typeof data>("/api/orgs/me/keycrm-settings")
      .then((d) => { setData(d); setApiKey(d?.keycrm_api_key ?? ""); })
      .catch(() => {});
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null); setSaved(false);
    try {
      const updated = await api<typeof data>("/api/orgs/me/keycrm-settings", {
        method: "PUT",
        body: JSON.stringify({ keycrm_api_key: apiKey.trim(), keycrm_webhook_secret: secret.trim() || undefined }),
      });
      setData(updated);
      if (secret) setSecret("");
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch { setError("Помилка збереження"); }
    finally { setSaving(false); }
  }

  function copyWebhook() {
    if (!data?.webhook_url) return;
    navigator.clipboard.writeText(data.webhook_url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <SectionCard>
      <div className="mb-4 flex items-center gap-3">
        <SectionTitle>KeyCRM</SectionTitle>
        {data && <BadgeStatus ok={data.keycrm_configured} />}
      </div>
      <p className="mb-4 text-sm text-neutral-500 dark:text-neutral-400">
        Налаштуйте вебхук у KeyCRM щоб замовлення автоматично потрапляли до системи.
      </p>

      {data && (
        <div className="mb-5 rounded-lg bg-neutral-50 p-3 dark:bg-neutral-800">
          <p className="mb-1 text-xs font-medium text-neutral-600 dark:text-neutral-300">Webhook URL для KeyCRM</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded border border-neutral-200 bg-white px-2 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-900">
              {data.webhook_url}
            </code>
            <button onClick={copyWebhook}
              className="shrink-0 rounded-md border border-neutral-200 px-2 py-1.5 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-700">
              {copied ? "✓" : "Копіювати"}
            </button>
          </div>
          <p className="mt-1.5 text-xs text-neutral-400">
            В KeyCRM: Налаштування → Вебхуки → Додати → вставте цей URL. Метод: POST, Подія: order_created / order_updated.
          </p>
        </div>
      )}

      <form onSubmit={save} className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-sm text-neutral-600 dark:text-neutral-400">API ключ KeyCRM</span>
          <input value={apiKey} onChange={(e) => setApiKey(e.target.value)}
            placeholder="eyJ..." className={inputCls} />
          <p className="mt-1 text-xs text-neutral-400">KeyCRM → Налаштування → API ключ</p>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-neutral-600 dark:text-neutral-400">
            Webhook Secret {data?.keycrm_configured && <span className="text-xs text-neutral-400">(залиште порожнім щоб не змінювати)</span>}
          </span>
          <input value={secret} onChange={(e) => setSecret(e.target.value)}
            type="password" autoComplete="new-password"
            placeholder={data?.keycrm_configured ? "••••••••" : "Секрет для підпису вебхука"}
            className={inputCls} />
          <p className="mt-1 text-xs text-neutral-400">Придумайте будь-який рядок — вставте його ж у KeyCRM у полі "Secret"</p>
        </label>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <button type="submit" disabled={saving}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900">
          {saving ? "Зберігаю…" : saved ? "✓ Збережено" : "Зберегти"}
        </button>
      </form>
    </SectionCard>
  );
}


function OrgSection({
  settings,
  onUpdate,
}: {
  settings: OrgSettings;
  onUpdate: (s: OrgSettings) => void;
}) {
  const [orgName, setOrgName] = useState(settings.name);
  const [nameSaving, setNameSaving] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);

  const [codeEmail, setCodeEmail] = useState(settings.bambu_email || "");
  const [codeRegion, setCodeRegion] = useState(settings.bambu_region || "eu");
  const [codeStep, setCodeStep] = useState<"idle" | "sent" | "done">("idle");
  const [code, setCode] = useState("");
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);

  // Telegram bot state
  const [agentConnected, setAgentConnected] = useState(false);
  const [tgToken, setTgToken] = useState("");
  const [tgShowInput, setTgShowInput] = useState(false);
  const [tgSaving, setTgSaving] = useState(false);
  const [tgError, setTgError] = useState<string | null>(null);
  const [tgPollCount, setTgPollCount] = useState(0);

  useEffect(() => {
    api<{ connected: boolean }>("/api/agent/status")
      .then((r) => setAgentConnected(r.connected))
      .catch(() => setAgentConnected(false));
  }, []);

  // Poll for tg_bot_username after saving (up to ~30s)
  useEffect(() => {
    if (tgPollCount <= 0 || settings.tg_bot_username) return;
    const t = setTimeout(async () => {
      try {
        const s = await api<OrgSettings>("/api/orgs/me");
        if (s.tg_bot_username) { onUpdate(s); setTgPollCount(0); return; }
      } catch { /* ignore */ }
      setTgPollCount((n) => n - 1);
    }, 3000);
    return () => clearTimeout(t);
  }, [tgPollCount, settings.tg_bot_username, onUpdate]);

  async function saveTgToken(e: React.FormEvent) {
    e.preventDefault();
    setTgError(null);
    setTgSaving(true);
    try {
      const updated = await api<OrgSettings>("/api/orgs/me/settings", {
        method: "PUT",
        body: JSON.stringify({ tg_bot_token: tgToken.trim() }),
      });
      onUpdate(updated);
      setTgToken("");
      setTgShowInput(false);
      if (!updated.tg_bot_username) setTgPollCount(10); // poll up to 10×3s = 30s
    } catch (err) {
      setTgError(err instanceof ApiError ? err.message : "Помилка збереження");
    } finally {
      setTgSaving(false);
    }
  }

  async function disableTg() {
    setTgError(null);
    setTgSaving(true);
    try {
      const updated = await api<OrgSettings>("/api/orgs/me/settings", {
        method: "PUT",
        body: JSON.stringify({ tg_bot_token: "" }),
      });
      onUpdate(updated);
    } catch (err) {
      setTgError(err instanceof ApiError ? err.message : "Помилка");
    } finally {
      setTgSaving(false);
    }
  }

  const nameChanged = orgName.trim() !== settings.name && orgName.trim().length >= 2;

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    if (!nameChanged) return;
    setNameSaving(true);
    try {
      const updated = await api<OrgSettings>("/api/orgs/me/settings", {
        method: "PUT",
        body: JSON.stringify({ name: orgName.trim() }),
      });
      onUpdate(updated);
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 2000);
    } catch {
      // ignore
    } finally {
      setNameSaving(false);
    }
  }

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
      onUpdate(updated);
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

  return (
    <div className="space-y-6">
      {/* Org name */}
      <SectionCard>
        <SectionTitle>Організація</SectionTitle>
        <form onSubmit={saveName} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm text-neutral-500 dark:text-neutral-400">Назва</label>
            <input
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              maxLength={120}
              className={inputCls}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm text-neutral-500 dark:text-neutral-400">Slug</label>
            <input
              value={settings.slug}
              readOnly
              className={`${inputCls} cursor-default font-mono text-xs text-neutral-400 dark:text-neutral-500`}
            />
            <p className="text-xs text-neutral-400 dark:text-neutral-600">Використовується в URL та API · не редагується</p>
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={!nameChanged || nameSaving}
              className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-cyan-700 disabled:opacity-40"
            >
              {nameSaved ? "Збережено ✓" : nameSaving ? "…" : "Зберегти зміни"}
            </button>
          </div>
        </form>
      </SectionCard>

      {/* Bambu Lab */}
      <SectionCard>
        <div className="mb-5 flex items-center gap-3">
          <h2 className="font-semibold">Bambu Lab</h2>
          {settings.bambu_configured ? (
            <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
              ✓ Налаштовано
            </span>
          ) : (
            <span className="rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">
              Не налаштовано
            </span>
          )}
        </div>

        {(codeStep === "done" || settings.bambu_configured) && codeStep !== "sent" && !reconnecting ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-400">
              Підключено як <strong>{settings.bambu_email}</strong>
              <span className="ml-1.5 text-emerald-500/70">({settings.bambu_region?.toUpperCase()})</span>
            </div>
            <button
              onClick={() => { setReconnecting(true); setCodeStep("idle"); setCodeError(null); }}
              className="text-sm text-neutral-500 transition hover:text-neutral-900 dark:hover:text-neutral-100"
            >
              Перепідключити інший акаунт →
            </button>
          </div>
        ) : codeStep === "sent" ? (
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
              <select value={codeRegion} onChange={(e) => setCodeRegion(e.target.value)} className={inputCls}>
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
        )}
      </SectionCard>

      {/* Telegram bot */}
      <SectionCard>
        <div className="mb-5 flex items-center gap-3">
          <h2 className="font-semibold">Telegram-бот</h2>
          {settings.tg_configured ? (
            <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
              ✓ Налаштовано
            </span>
          ) : (
            <span className="rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">
              Не налаштовано
            </span>
          )}
        </div>

        {!agentConnected ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Telegram-бот запускається локально на твоєму агенті.{" "}
            <a href="/settings#integrations" className="underline hover:text-neutral-900 dark:hover:text-neutral-100">
              Спочатку встанови агента.
            </a>
          </p>
        ) : settings.tg_configured && !tgShowInput ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-400">
              {settings.tg_bot_username
                ? <>Бот <strong>@{settings.tg_bot_username}</strong> підключено</>
                : <span className="text-neutral-500">Бот запускається… зачекай кілька секунд</span>}
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => { setTgShowInput(true); setTgToken(""); setTgError(null); }}
                className="text-sm text-neutral-500 transition hover:text-neutral-900 dark:hover:text-neutral-100"
              >
                Замінити токен →
              </button>
              <button
                onClick={disableTg}
                disabled={tgSaving}
                className="text-sm text-red-500 transition hover:text-red-700 disabled:opacity-50"
              >
                Відключити
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={saveTgToken} className="space-y-3">
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              Створи бота у{" "}
              <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="underline">
                @BotFather
              </a>
              , скопіюй HTTP API token, встав сюди.
            </p>
            <label className="block">
              <span className="mb-1 block text-sm">Bot token</span>
              <input
                type="password"
                autoComplete="new-password"
                required
                value={tgToken}
                onChange={(e) => setTgToken(e.target.value)}
                placeholder="1234567890:AAF..."
                className={inputCls}
              />
            </label>
            {tgError && <p className="text-sm text-red-600 dark:text-red-400">{tgError}</p>}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={tgSaving || !tgToken.trim()}
                className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
              >
                {tgSaving ? "Зберігаю…" : "Зберегти"}
              </button>
              {settings.tg_configured && (
                <button
                  type="button"
                  onClick={() => { setTgShowInput(false); setTgError(null); }}
                  className="rounded-md px-4 py-2 text-sm text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  Назад
                </button>
              )}
            </div>
          </form>
        )}
      </SectionCard>
    </div>
  );
}

// ── Printers section ───────────────────────────────────────────────────────

function PrintersSection() {
  const [bulkConfirm, setBulkConfirm] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const bulkInFlight = useRef(false);

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

  return (
    <div className="space-y-6">
      <ComingSoon label="Принтери" />

      <div className="rounded-2xl border border-red-200 bg-white p-6 shadow-sm dark:border-red-900/50 dark:bg-neutral-900">
        <h2 className="mb-4 font-semibold text-red-600 dark:text-red-400">Небезпечна зона</h2>
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
          {bulkMsg && <p className="text-sm text-neutral-600 dark:text-neutral-400">{bulkMsg}</p>}
        </div>
      </div>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

function defaultSection(): SectionId {
  if (typeof window === "undefined") return "organization";
  const billing = new URLSearchParams(window.location.search).get("billing");
  return billing ? "billing" : "organization";
}

export default function SettingsPage() {
  const user = useUser();
  const [settings, setSettings] = useState<OrgSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [active, setActive] = useState<SectionId>(defaultSection);

  useEffect(() => {
    api<OrgSettings>("/api/orgs/me")
      .then(setSettings)
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Помилка завантаження"));
  }, []);

  if (user?.role !== "admin") {
    return <p className="text-sm text-neutral-500">Тільки для адміністраторів.</p>;
  }
  if (loadError) return <p className="text-sm text-red-600">{loadError}</p>;
  if (!settings) return <p className="text-sm text-neutral-500">Завантаження…</p>;

  return (
    <div className="flex gap-8">
      {/* Left nav */}
      <nav className="w-48 shrink-0">
        <ul className="flex flex-col gap-0.5">
          {NAV_ITEMS.map((item) => (
            <li key={item.id}>
              <button
                onClick={() => setActive(item.id)}
                className={[
                  "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
                  active === item.id
                    ? "bg-cyan-500/10 font-medium text-cyan-600 dark:text-cyan-400"
                    : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-200",
                ].join(" ")}
              >
                <NavIcon d={item.d} />
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {/* Content */}
      <div className={`min-w-0 flex-1 ${active === "integrations" ? "" : "max-w-[720px]"}`}>
        {active === "general" && <ComingSoon label="Загальне" />}
        {active === "organization" && <OrgSection settings={settings} onUpdate={setSettings} />}
        {active === "printers" && <PrintersSection />}
        {active === "filament" && <ComingSoon label="Пластик" />}
        {active === "queue" && <ComingSoon label="Черга" />}
        {active === "notifications" && <ComingSoon label="Сповіщення" />}
        {active === "maintenance" && <ComingSoon label="Обслуговування" />}
        {active === "integrations" && (
          <div className="space-y-6">
            <AgentSection />
            <KeyCRMSection />
          </div>
        )}
        {active === "billing" && <BillingSection />}
      </div>
    </div>
  );
}
