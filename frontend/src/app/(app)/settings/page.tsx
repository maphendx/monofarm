"use client";

import { useRouter } from "next/navigation";

import { PrintersManager } from "@/components/printers/PrintersManager";
import { UsersSection } from "@/components/users/UsersSection";
import { ApiError, api, clearToken, getToken } from "@/lib/api";
import { useUser } from "@/lib/auth-context";
import { useLocale } from "@/lib/i18n";
import { useEffect, useRef, useState } from "react";
import { usePageTitle } from "@/lib/usePageTitle";

// ── Types ──────────────────────────────────────────────────────────────────

interface OrgSettings {
  electricity_rate: string;
  labor_rate: string;
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
  plans: Array<{ key: string; price_usd: number; yearly_price_usd: number; limits: { printers: number; users: number } }>;
  extra_slots?: number;
  extra_price_usd?: number | null;
  max_printers?: number | null;
  yearly_discount_pct?: number;
}

type SectionId =
  | "profile" | "general"
  | "organization" | "printers" | "users" | "filament"
  | "queue" | "notifications" | "maintenance" | "integrations" | "billing";

// ── Nav config ─────────────────────────────────────────────────────────────

const NAV_ITEMS: Array<{ id: SectionId; label: string; d: string[]; adminOnly?: boolean }> = [
  {
    id: "profile", label: "Профіль",
    d: ["M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2", "M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"],
  },
  {
    id: "general", label: "Загальне",
    d: ["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"],
  },
  {
    id: "organization", label: "Організація",
    d: ["M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "M9 22V12h6v10"],
    adminOnly: true,
  },
  {
    id: "printers", label: "Принтери",
    d: ["M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2", "M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6", "M6 18h12v3H6z"],
    adminOnly: true,
  },
  {
    id: "users", label: "Користувачі",
    d: ["M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2", "M9 7a4 4 0 1 0 8 0 4 4 0 0 0-8 0", "M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"],
    adminOnly: true,
  },
  {
    id: "filament", label: "Пластик",
    d: ["M12 2a10 10 0 1 0 10 10", "M12 8a4 4 0 1 0 4 4", "M12 12h.01"],
    adminOnly: true,
  },
  {
    id: "queue", label: "Черга",
    d: ["M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"],
    adminOnly: true,
  },
  {
    id: "notifications", label: "Сповіщення",
    d: ["M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9", "M13.73 21a2 2 0 0 1-3.46 0"],
    adminOnly: true,
  },
  {
    id: "maintenance", label: "Обслуговування",
    d: ["M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"],
    adminOnly: true,
  },
  {
    id: "integrations", label: "Вебхуки & API",
    d: ["M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"],
    adminOnly: true,
  },
  {
    id: "billing", label: "Білінг",
    d: ["M21 4H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z", "M1 10h22"],
    adminOnly: true,
  },
];

// ── Shared UI ──────────────────────────────────────────────────────────────

const inputCls = "input";

function SectionCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-10 shadow-sm">
      {children}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-6 text-xl font-semibold">{children}</h2>;
}

function ComingSoon({ label }: { label: string }) {
  return (
    <SectionCard>
      <SectionTitle>{label}</SectionTitle>
      <p className="text-sm text-[var(--text-faint)]">Незабаром</p>
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
      <div className="flex justify-between text-xs text-[var(--text-muted)]">
        <span>{label}</span>
        <span className={warn ? "font-medium text-[var(--state-warn)]" : ""}>{used} / {limit}</span>
      </div>
      <div className="h-1.5 rounded-full bg-[var(--surface-hi)] ">
        <div
          className={`h-1.5 rounded-full transition-all ${warn ? "bg-[var(--state-warn)]" : "bg-[var(--surface)] "}`}
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
  const [billingInterval, setBillingInterval] = useState<"month" | "year">("month");
  const inFlight = useRef(false);

  const billingMsg = typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("billing")
    : null;

  useEffect(() => {
    api<BillingStatus>("/api/billing/status").then((b) => {
      setBilling(b);
      setExtraSlots(b.extra_slots ?? 0);
    }).catch(() => {});
  }, []);

  async function saveExtraSlots() {
    if (savingSlots) return;
    setSavingSlots(true);
    try {
      await api("/api/orgs/me/extra-printer-slots", { method: "POST", body: JSON.stringify({ slots: extraSlots }) });
      const updated = await api<BillingStatus>("/api/billing/status");
      setBilling(updated); setExtraSlots(updated.extra_slots ?? 0);
    } catch { } finally { setSavingSlots(false); }
  }

  async function upgrade(plan: string) {
    if (inFlight.current) return;
    inFlight.current = true; setUpgrading(plan);
    try {
      await api("/api/billing/upgrade-free", { method: "POST", body: JSON.stringify({ plan }) });
      setBilling(await api<BillingStatus>("/api/billing/status"));
    } catch { } finally { setUpgrading(null); inFlight.current = false; }
  }

  async function cancelSub() {
    if (inFlight.current) return;
    inFlight.current = true; setCancelling(true);
    try {
      await api("/api/billing/cancel", { method: "POST" });
      setBilling(await api<BillingStatus>("/api/billing/status"));
      setConfirmCancel(false);
    } catch { } finally { setCancelling(false); inFlight.current = false; }
  }

  if (!billing) return null;

  const currentIdx = billing.plans.findIndex((p) => p.key === billing.plan);

  return (
    <div className="space-y-4">

      {billingMsg === "success" && (
        <div className="rounded-xl border border-[rgba(34,197,94,.25)] bg-[rgba(34,197,94,.08)] px-4 py-3 text-sm text-[var(--state-ok)]">
          Підписку оформлено! Ваш план оновлено.
        </div>
      )}
      {billingMsg === "cancel" && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-3 text-sm text-[var(--text-muted)]">
          Оплата скасована — план не змінено.
        </div>
      )}

      {/* ── Current plan ── */}
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-6">
        <h3 className="mb-4 font-semibold">Підписка</h3>
        <div className="flex items-center gap-4 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-5 py-4">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--accent)]">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
            </svg>
          </div>
          <div className="flex-1">
            <p className="text-xs text-[var(--text-faint)]">Поточний план</p>
            <p className="font-semibold">{PLAN_LABELS[billing.plan]}</p>
          </div>
          <span className="text-sm font-medium text-[var(--text-muted)]">
            {billing.price_usd > 0 ? `$${billing.price_usd}/міс` : "Безкоштовно"}
          </span>
        </div>
        <div className="mt-4 space-y-3">
          <UsageBar used={billing.usage.printers} limit={billing.limits.printers} label="Принтери" />
          <UsageBar used={billing.usage.users} limit={billing.limits.users} label="Користувачі" />
        </div>
      </div>

      {/* ── Plans grid ── */}
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 className="font-semibold">Змінити план</h3>
          {/* Monthly / yearly toggle */}
          <div className="flex items-center rounded-lg border border-[var(--border)] p-0.5 text-xs">
            <button
              onClick={() => setBillingInterval("month")}
              className={[
                "rounded-md px-3 py-1 font-medium transition",
                billingInterval === "month" ? "bg-[var(--accent)] text-white" : "text-[var(--text-muted)] hover:text-[var(--text)]",
              ].join(" ")}
            >
              Місяць
            </button>
            <button
              onClick={() => setBillingInterval("year")}
              className={[
                "flex items-center gap-1 rounded-md px-3 py-1 font-medium transition",
                billingInterval === "year" ? "bg-[var(--accent)] text-white" : "text-[var(--text-muted)] hover:text-[var(--text)]",
              ].join(" ")}
            >
              Рік
              <span className={[
                "rounded px-1 py-0.5 text-[10px] font-semibold leading-none",
                billingInterval === "year" ? "bg-white/20 text-white" : "bg-[var(--state-ok)]/15 text-[var(--state-ok)]",
              ].join(" ")}>
                −{billing.yearly_discount_pct ?? 20}%
              </span>
            </button>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-3">
          {billing.plans.map((p, idx) => {
            const isCurrent = p.key === billing.plan;
            const isUpgrade = currentIdx < idx;
            return (
              <div
                key={p.key}
                className={[
                  "flex flex-col rounded-xl border p-4 transition",
                  isCurrent
                    ? "border-[var(--accent)] bg-[rgba(56,189,248,.05)]"
                    : "border-[var(--border)] bg-[var(--bg)]",
                ].join(" ")}
              >
                <div className="mb-3 flex items-start justify-between gap-1">
                  <span className="font-medium">{PLAN_LABELS[p.key]}</span>
                  {isCurrent && (
                    <span className="rounded-md bg-[var(--accent)] px-1.5 py-0.5 text-[10px] font-medium text-white">
                      Активний
                    </span>
                  )}
                </div>
                <p className="mb-1 text-xl font-bold">
                  {p.price_usd === 0
                    ? "Free"
                    : billingInterval === "year"
                      ? <>${p.yearly_price_usd}<span className="text-xs font-normal text-[var(--text-faint)]">/рік</span></>
                      : <>${p.price_usd}<span className="text-xs font-normal text-[var(--text-faint)]">/міс</span></>}
                </p>
                {p.price_usd > 0 && billingInterval === "year" && (
                  <p className="mb-1 text-[11px] text-[var(--state-ok)]">
                    ≈ ${(p.yearly_price_usd / 12).toFixed(1)}/міс · економія ${p.price_usd * 12 - p.yearly_price_usd}
                  </p>
                )}
                <p className="mb-3 text-xs text-[var(--text-muted)]">{PLAN_DESC[p.key]}</p>
                <p className="mb-4 text-xs text-[var(--text-faint)]">
                  до {p.limits.printers} принтерів
                </p>
                <div className="mt-auto">
                  {isCurrent ? (
                    <div className="rounded-lg border border-[var(--accent)] py-1.5 text-center text-xs font-medium text-[var(--accent)]">
                      Поточний
                    </div>
                  ) : isUpgrade ? (
                    <button
                      onClick={() => upgrade(p.key)}
                      disabled={upgrading !== null}
                      className="w-full rounded-lg bg-[var(--accent)] py-1.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
                    >
                      {upgrading === p.key ? "…" : "Upgrade"}
                    </button>
                  ) : (
                    <button
                      onClick={() => upgrade(p.key)}
                      disabled={upgrading !== null}
                      className="w-full rounded-lg border border-[var(--border)] py-1.5 text-xs font-medium text-[var(--text-muted)] transition hover:bg-[var(--surface-hi)] disabled:opacity-50"
                    >
                      {upgrading === p.key ? "…" : "Перейти"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Extra printer slots ── */}
      {billing.extra_price_usd != null && (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-6">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h3 className="font-semibold">Додаткові принтери</h3>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                ${billing.extra_price_usd}/принтер/міс · база {billing.limits.printers - (billing.extra_slots ?? 0)}{billing.max_printers != null && ` · макс ${billing.max_printers}`}
              </p>
            </div>
            <span className="text-sm font-semibold">
              ${(billing.price_usd + (extraSlots * (billing.extra_price_usd ?? 0))).toFixed(0)}/міс
            </span>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center rounded-lg border border-[var(--border)] bg-[var(--bg)]">
              <button onClick={() => setExtraSlots((n) => Math.max(0, n - 1))} className="px-3 py-1.5 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)] rounded-l-lg">−</button>
              <span className="w-8 text-center text-sm font-semibold">{extraSlots}</span>
              <button onClick={() => setExtraSlots((n) => {
                const base = billing.limits.printers - (billing.extra_slots ?? 0);
                const max = billing.max_printers != null ? billing.max_printers - base : 999;
                return Math.min(max, n + 1);
              })} className="px-3 py-1.5 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)] rounded-r-lg">+</button>
            </div>
            <button onClick={saveExtraSlots} disabled={savingSlots || extraSlots === (billing.extra_slots ?? 0)} className="btn btn-primary disabled:opacity-50">
              {savingSlots ? "…" : "Зберегти"}
            </button>
          </div>
        </div>
      )}

      {/* ── Cancel ── */}
      {billing.plan !== "free" && (
        <div className="rounded-2xl border border-[rgba(239,68,68,.2)] bg-[var(--bg-elevated)] p-6">
          <h3 className="mb-1.5 font-semibold text-[var(--state-error)]">Скасувати підписку</h3>
          <p className="mb-4 text-sm text-[var(--text-muted)]">
            Після скасування план повернеться до Free. Ваші дані залишаться.
          </p>
          {confirmCancel ? (
            <div className="flex items-center gap-3">
              <button onClick={cancelSub} disabled={cancelling}
                className="rounded-lg border border-[rgba(239,68,68,.3)] bg-[rgba(239,68,68,.08)] px-4 py-2 text-sm font-medium text-[var(--state-error)] hover:bg-[rgba(239,68,68,.14)] disabled:opacity-50">
                {cancelling ? "…" : "Так, скасувати"}
              </button>
              <button onClick={() => setConfirmCancel(false)} className="text-sm text-[var(--text-muted)] hover:underline">
                Назад
              </button>
            </div>
          ) : (
            <button onClick={() => setConfirmCancel(true)}
              className="rounded-lg border border-[rgba(239,68,68,.3)] px-4 py-2 text-sm text-[var(--state-error)] hover:bg-[rgba(239,68,68,.08)]">
              Скасувати підписку →
            </button>
          )}
        </div>
      )}

    </div>
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
      <pre className="overflow-x-auto rounded-lg bg-[var(--bg)] px-4 py-3 text-xs text-[var(--state-ok)] whitespace-pre-wrap break-all leading-relaxed">{cmd}</pre>
      <button
        onClick={() => onCopy(cmd.replace(/\\\n\s+/g, " "), id)}
        className="absolute right-2 top-2 rounded bg-[var(--surface-2)] px-2 py-1 text-[10px] text-[var(--text-faint)] transition hover:bg-[var(--accent-hi)] hover:text-[var(--text-hi)]"
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
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-6  ">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Додати принтери</h3>
          <p className="mt-0.5 text-xs text-[var(--text-faint)]">Агент сканує локальну мережу і знаходить Bambu + Klipper принтери</p>
        </div>
        {limit && (
          <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${atLimit ? "bg-[rgba(239,68,68,.12)] text-[var(--state-error)]" : "bg-[var(--surface-hi)] text-[var(--text-muted)]  "}`}>
            {limit.count}/{limit.limit} принтерів
          </span>
        )}
      </div>

      {atLimit && (
        <div className="mb-4 rounded-lg border border-[rgba(245,158,11,.25)] bg-[rgba(245,158,11,.08)] px-4 py-3 text-xs text-[var(--state-warn)]">
          Досягнуто ліміт плану <strong>{orgPlan}</strong>. Оновіть план щоб додати більше принтерів.
        </div>
      )}

      <button
        onClick={scan}
        disabled={discovering || atLimit}
        className="btn btn-primary disabled:opacity-50"
      >
        {discovering ? "Сканування… (до 60 с)" : "Сканувати мережу"}
      </button>

      {err && <p className="mt-3 text-xs text-[var(--state-error)]">{err}</p>}

      {result && total === 0 && (
        <p className="mt-4 text-xs text-[var(--text-faint)]">Нових принтерів не знайдено. Переконайся що принтери увімкнені та в одній мережі з агентом.</p>
      )}

      {result && total > 0 && (
        <div className="mt-4 space-y-3">
          {result.bambu.map((d) => {
            const key = d.dev_id;
            const done = addedKeys.has(key);
            const inp  = inputs[key] ?? { name: d.name, access_code: "" };
            return (
              <div key={key} className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-4  ">
                <div className="mb-3 flex items-center gap-2">
                  <span className="badge badge-ok text-[10px]">Bambu</span>
                  <span className="text-xs font-medium">{d.model || d.dev_id}</span>
                  <span className="text-[11px] text-[var(--text-faint)]">{d.ip}</span>
                </div>
                {!done && (
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      placeholder="Назва"
                      value={inp.name}
                      onChange={(e) => setInputs((p) => ({ ...p, [key]: { ...inp, name: e.target.value } }))}
                      className="input"
                    />
                    <input
                      placeholder="Access Code (з принтера)"
                      value={inp.access_code}
                      onChange={(e) => setInputs((p) => ({ ...p, [key]: { ...inp, access_code: e.target.value } }))}
                      className="input"
                    />
                  </div>
                )}
                <div className="mt-2 flex justify-end">
                  {done ? (
                    <span className="text-xs font-medium text-[var(--state-ok)]">✓ Додано</span>
                  ) : (
                    <button
                      onClick={() => addBambu(d)}
                      disabled={addingKey === key || !inp.access_code}
                      className="btn btn-primary btn-sm disabled:opacity-50"
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
              <div key={key} className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-4  ">
                <div className="mb-3 flex items-center gap-2">
                  <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-900/30 dark:text-violet-400">Klipper</span>
                  <span className="text-xs font-medium text-[var(--text-muted)] ">{d.url}</span>
                </div>
                {!done && (
                  <input
                    placeholder="Назва принтера"
                    value={inp.name}
                    onChange={(e) => setInputs((p) => ({ ...p, [key]: { ...inp, name: e.target.value } }))}
                    className="input"
                  />
                )}
                <div className="mt-2 flex justify-end">
                  {done ? (
                    <span className="text-xs font-medium text-[var(--state-ok)]">✓ Додано</span>
                  ) : (
                    <button
                      onClick={() => addMoonraker(d)}
                      disabled={addingKey === key}
                      className="btn btn-primary btn-sm disabled:opacity-50"
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
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-6  ">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="mb-1.5 flex items-center gap-2.5">
              <h2 className="text-base font-semibold">Локальний агент</h2>
              <span className="rounded-full bg-violet-100 px-2.5 py-0.5 text-[11px] font-medium text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
                Klipper · Moonraker
              </span>
            </div>
            <p className="max-w-xl text-sm text-[var(--text-muted)] ">
              Тунель між локальними принтерами і хмарою. Встанови на Raspberry Pi або будь-якому PC у мережі принтерів — і вони з&apos;являться в monofarm автоматично.
            </p>
          </div>
          {/* Status badge */}
          <div className="shrink-0">
            {connected === null ? (
              <span className="rounded-full border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-faint)] ">
                Перевірка…
              </span>
            ) : connected ? (
              <span className="flex items-center gap-2 rounded-full border border-[rgba(34,197,94,.25)] bg-[rgba(34,197,94,.08)] px-3 py-1.5 text-xs font-medium text-[var(--state-ok)]">
                <span className="size-1.5 animate-pulse rounded-full bg-[var(--state-ok)]" />
                Агент підключений
              </span>
            ) : (
              <span className="flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-xs text-[var(--text-muted)]  ">
                <span className="size-1.5 rounded-full bg-[var(--state-idle)]" />
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
              <div className="flex shrink-0 items-center gap-2 rounded-xl bg-[rgba(34,197,94,.10)] px-4 py-2.5 text-sm font-medium text-[var(--state-ok)]">
                <span className="size-2 rounded-full bg-[var(--state-ok)]" />
                Підключено!
              </div>
            ) : pairStatus === "error" ? (
              <div className="shrink-0 text-right">
                <p className="mb-1 text-xs text-[var(--state-error)]">Агент більше не чекає — перезапусти його.</p>
                <button onClick={() => setPairStatus("idle")} className="text-xs text-[var(--text-muted)] hover:underline">Скинути</button>
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
        <div className="flex flex-col rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5  ">
          <div className="mb-3 flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-lg bg-[var(--surface-hi)] ">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10A15.3 15.3 0 0 1 12 2z"/>
              </svg>
            </span>
            <div>
              <p className="text-sm font-semibold">Linux / Raspberry Pi</p>
              <p className="text-[11px] text-[var(--text-faint)]">systemd автозапуск</p>
            </div>
          </div>
          <p className="mb-1 text-xs text-[var(--text-muted)] ">
            Одна команда — встановлює залежності, агент і systemd-сервіс.
          </p>
          <CmdBlock cmd={cmds.linux} id="linux" copied={copied} onCopy={copy} />
          <p className="mt-3 text-[11px] text-[var(--text-faint)]">
            Логи: <code className="rounded bg-[var(--surface-hi)] px-1 py-0.5 ">journalctl --user -u monofarm-agent -f</code>
          </p>
        </div>

        {/* Windows */}
        <div className="flex flex-col rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5  ">
          <div className="mb-3 flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-lg bg-[var(--surface-hi)] ">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-13.051-1.801"/>
              </svg>
            </span>
            <div>
              <p className="text-sm font-semibold">Windows</p>
              <p className="text-[11px] text-[var(--text-faint)]">Task Scheduler автозапуск</p>
            </div>
          </div>
          <p className="mb-1 text-xs text-[var(--text-muted)] ">
            PowerShell (не CMD). Встановлює Python якщо потрібно, реєструє завдання при вході.
          </p>
          <CmdBlock cmd={cmds.windows} id="windows" copied={copied} onCopy={copy} />
          <p className="mt-3 text-[11px] text-[var(--text-faint)]">
            Логи: <code className="rounded bg-[var(--surface-hi)] px-1 py-0.5 ">Get-Content ~\.monofarm-agent\agent.log -Wait</code>
          </p>
        </div>

        {/* Docker */}
        <div className="flex flex-col rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5  ">
          <div className="mb-3 flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-lg bg-[var(--surface-hi)] ">
              <svg width="18" height="14" viewBox="0 0 24 19" fill="currentColor">
                <path d="M13 7h2V5h-2v2zm-3 0h2V5h-2v2zM7 7h2V5H7v2zm3-3h2V2h-2v2zM7 4h2V2H7v2zM2.6 19C1.2 19 0 17.9 0 16.6c0-.2 0-.4.1-.6L1.5 9h21l1.4 6c0 .2.1.4.1.6 0 1.3-1.2 2.4-2.6 2.4H2.6zM22 7H4c-.6 0-1 .4-1 1v.5L1.5 9h21L21 8.5V8c0-.6-.4-1-1-1z"/>
              </svg>
            </span>
            <div>
              <p className="text-sm font-semibold">Docker</p>
              <p className="text-[11px] text-[var(--text-faint)]">--network host потрібен</p>
            </div>
          </div>
          <p className="mb-1 text-xs text-[var(--text-muted)] ">
            Якщо на Pi вже є Docker — найпростіший варіант.
          </p>
          <CmdBlock cmd={cmds.docker} id="docker" copied={copied} onCopy={copy} />
          <p className="mt-3 text-[11px] text-[var(--text-faint)]">
            <code>--network host</code> потрібен щоб агент дістався до Moonraker у LAN.
          </p>
        </div>

      </div>

      {/* ── How it works ── */}
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg)] p-5  ">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--text-faint)]">Як це працює</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {[
            { n: "1", t: "Запусти агент", d: "Без токена — браузер відкривається автоматично" },
            { n: "2", t: "Натисни кнопку", d: "У вкладці Settings → натисни «Підключити агент»" },
            { n: "3", t: "Готово", d: "Токен збережено, наступні запуски — без аргументів" },
          ].map(({ n, t, d }) => (
            <div key={n} className="flex gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--surface-hi)] text-xs font-bold text-[var(--text-muted)]  ">
                {n}
              </span>
              <div>
                <p className="text-xs font-medium text-[var(--text)] ">{t}</p>
                <p className="text-[11px] text-[var(--text-faint)]">{d}</p>
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
    <span className="badge badge-ok text-xs">
      налаштовано
    </span>
  ) : (
    <span className="rounded bg-[var(--surface-hi)] px-1.5 py-0.5 text-xs text-[var(--text-muted)] ">
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
      <p className="mb-4 text-sm text-[var(--text-muted)] ">
        Налаштуйте вебхук у KeyCRM щоб замовлення автоматично потрапляли до системи.
      </p>

      {data && (
        <div className="mb-5 rounded-lg bg-[var(--bg)] p-3 ">
          <p className="mb-1 text-xs font-medium text-[var(--text-muted)] ">Webhook URL для KeyCRM</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-xs  ">
              {data.webhook_url}
            </code>
            <button onClick={copyWebhook}
              className="shrink-0 rounded-md border border-[var(--border)] px-2 py-1.5 text-xs hover:bg-[var(--surface-hi)]  ">
              {copied ? "✓" : "Копіювати"}
            </button>
          </div>
          <p className="mt-1.5 text-xs text-[var(--text-faint)]">
            В KeyCRM: Налаштування → Вебхуки → Додати → вставте цей URL. Метод: POST, Подія: order_created / order_updated.
          </p>
        </div>
      )}

      <form onSubmit={save} className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-sm text-[var(--text-muted)] ">API ключ KeyCRM</span>
          <input value={apiKey} onChange={(e) => setApiKey(e.target.value)}
            placeholder="eyJ..." className={inputCls} />
          <p className="mt-1 text-xs text-[var(--text-faint)]">KeyCRM → Налаштування → API ключ</p>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-[var(--text-muted)] ">
            Webhook Secret {data?.keycrm_configured && <span className="text-xs text-[var(--text-faint)]">(залиште порожнім щоб не змінювати)</span>}
          </span>
          <input value={secret} onChange={(e) => setSecret(e.target.value)}
            type="password" autoComplete="new-password"
            placeholder={data?.keycrm_configured ? "••••••••" : "Секрет для підпису вебхука"}
            className={inputCls} />
          <p className="mt-1 text-xs text-[var(--text-faint)]">Придумайте будь-який рядок — вставте його ж у KeyCRM у полі "Secret"</p>
        </label>
        {error && <p className="text-sm text-[var(--state-error)]">{error}</p>}
        <button type="submit" disabled={saving}
          className="btn btn-primary disabled:opacity-50">
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
            <label className="text-sm text-[var(--text-muted)] ">Назва</label>
            <input
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              maxLength={120}
              className={inputCls}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm text-[var(--text-muted)] ">Slug</label>
            <input
              value={settings.slug}
              readOnly
              className={`${inputCls} cursor-default font-mono text-xs text-[var(--text-faint)] `}
            />
            <p className="text-xs text-[var(--text-faint)] ">Використовується в URL та API · не редагується</p>
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={!nameChanged || nameSaving}
              className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white transition hover:bg-[var(--accent-hi)] disabled:opacity-40"
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
            <span className="badge badge-ok">
              ✓ Налаштовано
            </span>
          ) : (
            <span className="rounded-full bg-[var(--surface-hi)] px-2.5 py-0.5 text-xs text-[var(--text-muted)] ">
              Не налаштовано
            </span>
          )}
        </div>

        {(codeStep === "done" || settings.bambu_configured) && codeStep !== "sent" && !reconnecting ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-[rgba(34,197,94,.2)] bg-[rgba(34,197,94,.08)] px-4 py-3 text-sm text-[var(--state-ok)]">
              Підключено як <strong>{settings.bambu_email}</strong>
              <span className="ml-1.5 text-[var(--state-ok)] opacity-70">({settings.bambu_region?.toUpperCase()})</span>
            </div>
            <button
              onClick={() => { setReconnecting(true); setCodeStep("idle"); setCodeError(null); }}
              className="text-sm text-[var(--text-muted)] transition hover:text-[var(--text-hi)] "
            >
              Перепідключити інший акаунт →
            </button>
          </div>
        ) : codeStep === "sent" ? (
          <form onSubmit={verifyCode} className="space-y-3">
            <p className="text-sm text-[var(--text-muted)]">
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
            {codeError && <p className="text-sm text-[var(--state-error)]">{codeError}</p>}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={codeBusy || code.length < 6}
                className="btn btn-primary disabled:opacity-50"
              >
                {codeBusy ? "Перевірка…" : "Підтвердити"}
              </button>
              <button
                type="button"
                onClick={() => { setCodeStep("idle"); setCodeError(null); }}
                className="btn btn-ghost"
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
            {codeError && <p className="text-sm text-[var(--state-error)]">{codeError}</p>}
            <button
              type="submit"
              disabled={codeBusy || !codeEmail}
              className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white transition hover:bg-[var(--accent-hi)] disabled:opacity-50   "
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
            <span className="badge badge-ok">
              ✓ Налаштовано
            </span>
          ) : (
            <span className="rounded-full bg-[var(--surface-hi)] px-2.5 py-0.5 text-xs text-[var(--text-muted)] ">
              Не налаштовано
            </span>
          )}
        </div>

        {!agentConnected ? (
          <p className="text-sm text-[var(--text-muted)] ">
            Telegram-бот запускається локально на твоєму агенті.{" "}
            <a href="/settings#integrations" className="underline hover:text-[var(--text-hi)] ">
              Спочатку встанови агента.
            </a>
          </p>
        ) : settings.tg_configured && !tgShowInput ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-[rgba(34,197,94,.2)] bg-[rgba(34,197,94,.08)] px-4 py-3 text-sm text-[var(--state-ok)]">
              {settings.tg_bot_username
                ? <>Бот <strong>@{settings.tg_bot_username}</strong> підключено</>
                : <span className="text-[var(--text-muted)]">Бот запускається… зачекай кілька секунд</span>}
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => { setTgShowInput(true); setTgToken(""); setTgError(null); }}
                className="text-sm text-[var(--text-muted)] transition hover:text-[var(--text-hi)] "
              >
                Замінити токен →
              </button>
              <button
                onClick={disableTg}
                disabled={tgSaving}
                className="text-sm text-[var(--state-error)] transition hover:opacity-80 disabled:opacity-50"
              >
                Відключити
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={saveTgToken} className="space-y-3">
            <p className="text-sm text-[var(--text-muted)] ">
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
            {tgError && <p className="text-sm text-[var(--state-error)]">{tgError}</p>}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={tgSaving || !tgToken.trim()}
                className="btn btn-primary disabled:opacity-50"
              >
                {tgSaving ? "Зберігаю…" : "Зберегти"}
              </button>
              {settings.tg_configured && (
                <button
                  type="button"
                  onClick={() => { setTgShowInput(false); setTgError(null); }}
                  className="btn btn-ghost"
                >
                  Назад
                </button>
              )}
            </div>
          </form>
        )}
      </SectionCard>

      {/* Costing rates */}
      <CostingRatesCard settings={settings} onUpdate={onUpdate} />
    </div>
  );
}

function CostingRatesCard({ settings, onUpdate }: { settings: OrgSettings; onUpdate: (s: OrgSettings) => void }) {
  const [elRate,   setElRate]   = useState(parseFloat(settings.electricity_rate || "4.5").toString());
  const [labRate,  setLabRate]  = useState(parseFloat(settings.labor_rate || "150").toString());
  const [saving,   setSaving]   = useState(false);
  const [saved,    setSaved]    = useState(false);
  const inFlight = useRef(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    try {
      const updated = await api<OrgSettings>("/api/orgs/me/settings", {
        method: "PUT",
        body: JSON.stringify({
          electricity_rate: parseFloat(elRate) || 4.5,
          labor_rate:       parseFloat(labRate) || 150,
        }),
      });
      onUpdate(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally { inFlight.current = false; setSaving(false); }
  }

  return (
    <SectionCard>
      <h2 className="mb-4 font-semibold">Тарифи для розрахунку собівартості</h2>
      <form onSubmit={save} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-sm text-[var(--text-muted)]">Електрика (₴/кВт·год)</span>
            <input type="number" step="0.01" min="0" value={elRate}
              onChange={e => setElRate(e.target.value)}
              className="input w-full" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm text-[var(--text-muted)]">Ставка праці (₴/год)</span>
            <input type="number" step="1" min="0" value={labRate}
              onChange={e => setLabRate(e.target.value)}
              className="input w-full" />
          </label>
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" disabled={saving} className="btn btn-primary disabled:opacity-50">
            {saving ? "Зберігаю…" : "Зберегти"}
          </button>
          {saved && <span className="text-sm text-[var(--state-ok)]">✓ Збережено</span>}
        </div>
      </form>
    </SectionCard>
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
      <PrintersManager />

      <div className="rounded-2xl border border-[rgba(239,68,68,.2)] bg-[var(--bg-elevated)] p-6 shadow-sm">
        <h2 className="mb-4 font-semibold text-[var(--state-error)]">Небезпечна зона</h2>
        <div className="space-y-3">
          {(["bambu", "snapmaker_u1", "other", "all"] as const).map((kind) => {
            const label =
              kind === "bambu" ? "Всі Bambu Lab принтери" :
                kind === "snapmaker_u1" ? "Всі Moonraker/Klipper принтери" :
                  kind === "other" ? "Всі ручні принтери" :
                    "Всі принтери";
            const key = kind === "all" ? undefined : kind;
            return (
              <div key={kind} className="flex items-center justify-between gap-4 rounded-lg border border-[var(--border)] px-4 py-3 ">
                <span className="text-sm text-[var(--text)] ">{label}</span>
                {bulkConfirm === kind ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-[var(--text-muted)]">Впевнені?</span>
                    <button
                      onClick={() => bulkDelete(key)}
                      disabled={bulkBusy}
                      className="rounded px-2 py-1 text-xs font-medium text-[var(--state-error)] hover:bg-[rgba(239,68,68,.08)] disabled:opacity-40"
                    >
                      {bulkBusy && bulkConfirm === kind ? "…" : "Видалити"}
                    </button>
                    <button
                      onClick={() => setBulkConfirm(null)}
                      className="rounded px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)] "
                    >
                      Скасувати
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setBulkMsg(null); setBulkConfirm(kind); }}
                    className="rounded-md border border-[rgba(239,68,68,.3)] px-3 py-1.5 text-xs text-[var(--state-error)] hover:bg-[rgba(239,68,68,.08)]"
                  >
                    Видалити
                  </button>
                )}
              </div>
            );
          })}
          {bulkMsg && <p className="text-sm text-[var(--text-muted)] ">{bulkMsg}</p>}
        </div>
      </div>
    </div>
  );
}

// ── Profile section ────────────────────────────────────────────────────────

const ROLE_LABEL: Record<string, string> = { admin: "Адмін", operator: "Оператор", manager: "Менеджер" };
const PLAN_LABEL: Record<string, string> = { free: "Free", starter: "Starter", pro: "Pro", farm: "Farm" };

function ProfileSection() {
  const user = useUser();
  const router = useRouter();
  const [name, setName] = useState(user.name);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [plan, setPlan] = useState<string | null>(null);
  const inFlight = useRef(false);

  const initials = user.name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const joinedDate = new Date(user.created_at).toLocaleDateString("uk-UA", { day: "numeric", month: "long", year: "numeric" });
  const memberSince = new Date(user.created_at).toLocaleDateString("uk-UA", { month: "long", year: "numeric" });

  useEffect(() => {
    api<{ plan: string }>("/api/billing/status")
      .then((b) => setPlan(b.plan))
      .catch(() => {});
  }, []);

  const changed = name.trim() !== user.name && name.trim().length >= 2;

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    try {
      await api(`/api/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: name.trim() }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch { /* ignore */ } finally {
      setSaving(false);
      inFlight.current = false;
    }
  }

  function logout() {
    clearToken();
    router.push("/login");
  }

  return (
    <div className="space-y-5">

      {/* ── Header card ── */}
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-8">
        <div className="flex items-start gap-5">
          <div className="flex size-20 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-2xl font-bold text-white">
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="text-2xl font-semibold">{user.name}</h2>
              <span className="rounded-md border border-[var(--border)] px-2.5 py-0.5 text-sm text-[var(--text-muted)]">
                {ROLE_LABEL[user.role] ?? user.role}
              </span>
              {plan && (
                <span className="flex items-center gap-1 rounded-md border border-[rgba(34,197,94,.3)] bg-[rgba(34,197,94,.08)] px-2.5 py-0.5 text-sm font-medium text-[var(--state-ok)]">
                  {PLAN_LABEL[plan] ?? plan}
                </span>
              )}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-6 text-base text-[var(--text-muted)]">
              <span className="flex items-center gap-2">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>
                </svg>
                {user.email}
              </span>
              <span className="flex items-center gap-2">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
                </svg>
                Joined {joinedDate}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Edit Profile card ── */}
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-8">
        <div className="mb-6 flex items-center gap-2.5">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-muted)]">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
          </svg>
          <h3 className="text-lg font-semibold">Редагувати профіль</h3>
        </div>
        <form onSubmit={saveName}>
          <div className="grid grid-cols-2 gap-5">
            <div>
              <label className="mb-2 block text-base text-[var(--text-muted)]">Повне ім&apos;я</label>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className="input" />
            </div>
            <div>
              <label className="mb-2 block text-base text-[var(--text-muted)]">Email адреса</label>
              <input value={user.email} readOnly className="input cursor-default opacity-60" />
            </div>
          </div>
          <div className="mt-6 flex items-center justify-between border-t border-[var(--border)] pt-5">
            <button type="button" onClick={logout} className="flex items-center gap-2 text-base text-[var(--state-error)] hover:opacity-80">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                <polyline points="16 17 21 12 16 7"/>
                <line x1="21" y1="12" x2="9" y2="12"/>
              </svg>
              Вийти
            </button>
            <button type="submit" disabled={!changed || saving} className="btn btn-primary disabled:opacity-50">
              {saved ? "✓ Збережено" : saving ? "…" : "Зберегти зміни"}
            </button>
          </div>
        </form>
      </div>

      {/* ── Subscription card ── */}
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-8">
        <div className="mb-6 flex items-center gap-2.5">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-muted)]">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
          </svg>
          <h3 className="text-lg font-semibold">Підписка</h3>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg)] px-5 py-5">
            <p className="text-xs font-semibold uppercase tracking-widest text-[var(--text-faint)]">ПЛАН</p>
            <p className="mt-2 text-xl font-semibold">{plan ? (PLAN_LABEL[plan] ?? plan) : "—"}</p>
          </div>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg)] px-5 py-5">
            <p className="text-xs font-semibold uppercase tracking-widest text-[var(--text-faint)]">РОЛЬ</p>
            <p className="mt-2 text-xl font-semibold">{ROLE_LABEL[user.role] ?? user.role}</p>
          </div>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg)] px-5 py-5">
            <p className="text-xs font-semibold uppercase tracking-widest text-[var(--text-faint)]">УЧАСНИК З</p>
            <p className="mt-2 text-xl font-semibold capitalize">{memberSince}</p>
          </div>
        </div>
      </div>

    </div>
  );
}

// ── General section ────────────────────────────────────────────────────────

function GeneralSection() {
  const { locale, setLocale } = useLocale();
  const [currency, setCurrencyState] = useState<string>(() =>
    typeof window !== "undefined" ? (localStorage.getItem("currency") ?? "UAH") : "UAH"
  );

  function pickCurrency(c: string) {
    setCurrencyState(c);
    localStorage.setItem("currency", c);
  }

  return (
    <SectionCard>
      <SectionTitle>Загальні налаштування</SectionTitle>
      <div className="space-y-6">
        <div>
          <p className="mb-2 text-sm text-[var(--text-muted)]">Мова інтерфейсу</p>
          <div className="flex gap-2">
            {(["uk", "en"] as const).map((l) => (
              <button
                key={l}
                onClick={() => setLocale(l)}
                className={[
                  "rounded-lg border px-4 py-2 text-sm transition-colors",
                  locale === l
                    ? "border-[var(--accent)] bg-[rgba(56,189,248,.08)] font-medium text-[var(--accent)]"
                    : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--surface-hi)]",
                ].join(" ")}
              >
                {l === "uk" ? "Українська" : "English"}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-2 text-sm text-[var(--text-muted)]">Валюта</p>
          <div className="flex gap-2">
            {["UAH", "USD"].map((c) => (
              <button
                key={c}
                onClick={() => pickCurrency(c)}
                className={[
                  "rounded-lg border px-4 py-2 text-sm transition-colors",
                  currency === c
                    ? "border-[var(--accent)] bg-[rgba(56,189,248,.08)] font-medium text-[var(--accent)]"
                    : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--surface-hi)]",
                ].join(" ")}
              >
                {c === "UAH" ? "₴ UAH" : "$ USD"}
              </button>
            ))}
          </div>
        </div>
      </div>
    </SectionCard>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

function defaultSection(): SectionId {
  if (typeof window === "undefined") return "profile";
  const params = new URLSearchParams(window.location.search);
  if (params.get("billing")) return "billing";
  const section = params.get("section") as SectionId | null;
  if (section) return section;
  return "profile";
}

export default function SettingsPage() {
  usePageTitle("nav.settings");
  const user = useUser();
  const [settings, setSettings] = useState<OrgSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [active, setActive] = useState<SectionId>(defaultSection);
  const isAdmin = user?.role === "admin";

  useEffect(() => {
    if (!isAdmin) return;
    api<OrgSettings>("/api/orgs/me")
      .then(setSettings)
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Помилка завантаження"));
  }, [isAdmin]);

  const visibleItems = NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin);

  return (
    <div className="-mx-6 -mt-6">

      {/* ── Horizontal tab nav ── */}
      <div className="sticky top-0 z-20 border-b border-[var(--border)] bg-[var(--bg-elevated)]">
        <div className="flex justify-center overflow-x-auto px-4 scrollbar-none">
          {visibleItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setActive(item.id)}
              className={[
                "flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-2.5 text-sm transition-colors",
                active === item.id
                  ? "border-b-2 border-[var(--accent)] font-medium text-[var(--accent)]"
                  : "border-b-2 border-transparent text-[var(--text-muted)] hover:text-[var(--text)]",
              ].join(" ")}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                {item.d.map((p, i) => <path key={i} d={p} />)}
              </svg>
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Content ── */}
      <div className="px-8 py-6">
        <div className="mx-auto max-w-6xl">
        {active === "profile" && <ProfileSection />}
        {active === "general" && <GeneralSection />}
        {active === "organization" && (
          loadError ? <p className="text-sm text-[var(--state-error)]">{loadError}</p>
          : !settings ? <p className="text-sm text-[var(--text-muted)]">Завантаження…</p>
          : <OrgSection settings={settings} onUpdate={setSettings} />
        )}
        {active === "printers" && <PrintersSection />}
        {active === "users" && <UsersSection />}
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


    </div>
  );
}
