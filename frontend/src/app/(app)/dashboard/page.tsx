"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { DashboardPet } from "@/components/dashboard/DashboardPet";
import { FlowView } from "@/components/dashboard/FlowView";
import { PrinterCard } from "@/components/printers/PrinterCard";
import { PrinterDetailModal } from "@/components/printers/PrinterDetailModal";
import { PrinterGroupsModal } from "@/components/printers/PrinterGroupsModal";
import { StartPrintModal } from "@/components/printers/StartPrintModal";
import { ApiError, api } from "@/lib/api";
import { useUser } from "@/lib/auth-context";
import { useT } from "@/lib/i18n";
import {
  kindLabel,
  printerTone,
  stateLabel,
} from "@/lib/printerLabels";
import type { Printer, PrinterKind } from "@/lib/types";
import { usePageTitle } from "@/lib/usePageTitle";

// ── StatusCard ────────────────────────────────────────────────────────────────

function StatusCard({
  label,
  value,
  sub,
  color,
  active,
  onClick,
}: {
  label: string;
  value: string | number;
  sub?: string;
  color: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={[
        "relative overflow-hidden rounded-xl border px-4 py-3 transition-colors",
        onClick ? "cursor-pointer" : "",
        active
          ? "border-[var(--border-strong)] bg-[var(--surface-2)]"
          : "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hi)]",
      ].join(" ")}
    >
      <div className="absolute bottom-0 left-0 right-0 h-[3px] rounded-b-xl" style={{ background: color }} />
      <p className="text-[11px] font-medium text-[var(--text-faint)]">{label}</p>
      <p className="mt-0.5 text-lg font-semibold leading-tight text-[var(--text-hi)]">{value}</p>
      {sub && <p className="truncate text-[11px] text-[var(--text-muted)]">{sub}</p>}
    </div>
  );
}

// ── group stats ───────────────────────────────────────────────────────────────

interface GroupStats {
  printing: number;
  paused: number;
  action: number;  // awaiting_bed_clear / in_maintenance / error
  ready: number;   // operational / idle / online / print_pending
  offline: number; // offline / not_connected / unknown
}

function calcGroupStats(items: Printer[]): GroupStats {
  const s: GroupStats = { printing: 0, paused: 0, action: 0, ready: 0, offline: 0 };
  for (const p of items) {
    const st = p.state ?? "unknown";
    if (st === "printing") s.printing++;
    else if (st === "paused") s.paused++;
    else if (["awaiting_bed_clear", "in_maintenance", "error"].includes(st)) s.action++;
    else if (["operational", "idle", "online", "print_pending"].includes(st)) s.ready++;
    else s.offline++;
  }
  return s;
}

function StatBadge({
  count,
  label,
  className,
}: {
  count: number;
  label: string;
  className: string;
}) {
  if (count === 0) return null;
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${className}`}>
      {count} {label}
    </span>
  );
}

function GroupStatsBadges({ stats }: { stats: GroupStats }) {
  const t = useT();
  return (
    <div className="flex items-center gap-1.5">
      <StatBadge count={stats.printing} label={t("dashboard.printing")} className="badge badge-print" />
      <StatBadge count={stats.paused}   label={t("dashboard.paused")}   className="badge badge-warn" />
      <StatBadge count={stats.action}   label={t("dashboard.action")}   className="badge badge-warn" />
      <StatBadge count={stats.ready}    label={t("dashboard.ready")}    className="badge badge-ok" />
      <StatBadge count={stats.offline}  label={t("dashboard.offline")}  className="badge badge-offline" />
    </div>
  );
}

// ── filter ───────────────────────────────────────────────────────────────────

type Filter = "all" | "printing" | "attention" | "idle" | "paused" | "awaiting" | "offline";
type GroupBy = "mygroup" | "none" | "kind" | "state";

const KIND_ORDER: PrinterKind[] = ["bambu", "snapmaker_u1", "other"];

const STATE_ORDER = [
  "printing", "paused", "error", "awaiting_bed_clear",
  "in_maintenance", "operational", "online", "print_pending",
  "idle", "not_connected", "offline", "unknown",
];

function groupPrinters(
  printers: Printer[],
  by: GroupBy,
): { key: string; label: string; items: Printer[] }[] {
  if (by === "none") return [{ key: "all", label: "", items: printers }];

  if (by === "mygroup") {
    // Printers arrive from the API already sorted: by group sort_order then name,
    // ungrouped printers last. We just need to segment them into sections.
    const sections: { key: string; label: string; items: Printer[] }[] = [];
    const seen = new Map<string, number>(); // key → index in sections

    for (const p of printers) {
      const key = p.group_id !== null ? `g${p.group_id}` : "__ungrouped__";
      const label = p.group_name ?? "";
      if (!seen.has(key)) {
        seen.set(key, sections.length);
        sections.push({ key, label, items: [] });
      }
      sections[seen.get(key)!].items.push(p);
    }
    return sections;
  }

  const map = new Map<string, Printer[]>();
  if (by === "kind") {
    for (const p of printers) {
      if (!map.has(p.kind)) map.set(p.kind, []);
      map.get(p.kind)!.push(p);
    }
    return KIND_ORDER.filter((k) => map.has(k)).map((k) => ({
      key: k, label: kindLabel(k), items: map.get(k)!,
    }));
  }

  // by === "state"
  for (const p of printers) {
    const s = p.state ?? "unknown";
    if (!map.has(s)) map.set(s, []);
    map.get(s)!.push(p);
  }
  const ordered = STATE_ORDER.filter((s) => map.has(s));
  for (const s of map.keys()) if (!ordered.includes(s)) ordered.push(s);
  return ordered.map((s) => ({
    key: s, label: stateLabel(s), items: map.get(s)!,
  }));
}

// ── printer photo view ────────────────────────────────────────────────────────

const BAMBU_COVER: [RegExp, string][] = [
  [/a1[\s_-]*mini/i,  "/printers/a1_mini.png"],
  [/a1[\s_-]*combo/i, "/printers/a1_mini.png"],
  [/\ba1\b/i,         "/printers/a1.png"],
  [/p1s/i,            "/printers/p1s.png"],
  [/p1p/i,            "/printers/p1p.png"],
  [/x1[\s_-]*carbon/i,"/printers/x1c.png"],
  [/x1c/i,            "/printers/x1c.png"],
  [/x1e/i,            "/printers/x1e.png"],
  [/\bx1\b/i,         "/printers/x1.png"],
  [/h2d[\s_-]*pro/i,  "/printers/h2d_pro.png"],
  [/h2d/i,            "/printers/h2d.png"],
];

function bambuCover(model: string | null | undefined): string | null {
  if (!model) return null;
  for (const [re, path] of BAMBU_COVER) {
    if (re.test(model)) return path;
  }
  return null;
}

function printerCover(printer: Printer): string | null {
  if (printer.kind === "bambu") return bambuCover(printer.bambu_model);
  if (printer.kind === "snapmaker_u1") return "/printers/snapmaker_u1.png";
  return null;
}


function fmtFinish(eta_minutes: number): string {
  const finish = new Date(Date.now() + eta_minutes * 60_000);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrowStart = new Date(todayStart.getTime() + 86_400_000);
  const dayAfter = new Date(todayStart.getTime() + 2 * 86_400_000);
  const time = finish.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
  if (finish < tomorrowStart) return `Сьогодні, ${time}`;
  if (finish < dayAfter) return `Завтра, ${time}`;
  return finish.toLocaleDateString("uk-UA", { weekday: "short", day: "numeric", month: "short" }) + `, ${time}`;
}

function fmtEtaShort(min: number): string {
  if (min < 60) return `${min}хв`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}г ${m}хв` : `${h}год`;
}

function PrinterPhotoCard({
  printer,
  onClick,
  onUpdated,
}: {
  printer: Printer;
  onClick: () => void;
  onUpdated: (p: Printer) => void;
}) {
  const cover      = printerCover(printer);
  const tone       = printerTone(printer);
  const isPrinting = printer.state === "printing";
  const isPaused   = printer.state === "paused";
  const pct        = printer.progress_pct ?? 0;
  const [busy, setBusy] = useState<string | null>(null);

  const TOP: Record<string, string> = {
    printing: "var(--state-print)", ok: "var(--state-ok)", warn: "var(--state-warn)", bad: "var(--state-error)",
    idle: "transparent", muted: "transparent",
  };
  const STATE_LABEL: Record<string, string> = {
    printing: "text-[var(--state-print)]", ok: "text-[var(--state-ok)]", warn: "text-[var(--state-warn)]",
    bad: "text-[var(--state-error)]", idle: "text-[var(--text-muted)]", muted: "text-[var(--text-faint)]",
  };

  async function act(e: React.MouseEvent, action: string) {
    e.stopPropagation();
    if (busy) return;
    setBusy(action);
    try {
      await api(`/api/printers/${printer.id}/print/${action}`, { method: "POST" });
      const list = await api<Printer[]>("/api/printers");
      const updated = list.find((p) => p.id === printer.id);
      if (updated) onUpdated(updated);
    } catch { /* ignore */ }
    finally { setBusy(null); }
  }

  return (
    <div
      onClick={onClick}
      className={[
        "group flex cursor-pointer flex-col gap-1.5 rounded-xl border bg-[var(--bg-elevated)] p-3",
        "border-[var(--border-strong)]  ",
        tone === "muted" ? "opacity-60" : "",
        "text-left transition-shadow hover:shadow-md",
      ].join(" ")}
      style={{ borderTopWidth: 2, borderTopColor: TOP[tone] }}
    >
      {/* ── header: name + photo ── */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold leading-tight">{printer.name}</div>
          <div className="text-xs text-[var(--text-faint)]">{printer.bambu_model ?? printer.kind}</div>
        </div>
        {/* model photo */}
        <div className="shrink-0 h-10 w-10 flex items-center justify-center">
          {cover ? (
            <img src={cover} alt="" className="h-10 w-10 object-contain drop-shadow" />
          ) : (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-faint)] ">
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
              <path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/>
              <rect x="6" y="18" width="12" height="4" rx="1"/>
            </svg>
          )}
        </div>
      </div>

      {/* ── state label ── */}
      <div className={`text-[11px] font-medium ${STATE_LABEL[tone]}`}>
        {printer.state === "printing" ? "Друкує" :
         printer.state === "paused"   ? "На паузі" :
         printer.state === "error"    ? (printer.error_msg ?? "Помилка") :
         printer.state === "idle" || printer.state === "operational" ? "Готовий" :
         printer.state === "awaiting_bed_clear" ? "Очікує стіл" : "Офлайн"}
      </div>

      {/* ── filament dots ── */}
      {(printer.loaded_filaments?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1">
          {printer.loaded_filaments.map((s, i) => (
            <span key={i}
              className="size-3 rounded-full ring-1 ring-black/10 dark:ring-white/10"
              style={{ backgroundColor: s.color.startsWith("#") ? s.color.slice(0,7) : s.color }}
            />
          ))}
        </div>
      )}

      {/* ── progress bar ── */}
      {(isPrinting || isPaused) && (
        <div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-hi)] ">
            <div
              style={{ background: isPrinting ? "var(--state-print)" : "var(--state-warn)", width: `${Math.max(pct, 1)}%` }}
            />
          </div>
          <div className="mt-0.5 flex justify-between text-[10px] text-[var(--text-faint)]">
            <span>{Math.round(pct)}%</span>
            {printer.eta_minutes != null && (
              <span>{fmtEtaShort(printer.eta_minutes)} · {fmtFinish(printer.eta_minutes)}</span>
            )}
          </div>
        </div>
      )}

      {/* ── action buttons ── */}
      {(isPrinting || isPaused) && (
        <div className="flex gap-1.5 pt-0.5" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={(e) => act(e, isPaused ? "resume" : "pause")}
            disabled={!!busy}
            className="flex flex-1 items-center justify-center rounded-lg border py-1.5 text-xs font-semibold transition disabled:opacity-40"
            style={isPaused
              ? { borderColor: "var(--state-ok)", color: "var(--state-ok)" }
              : { borderColor: "var(--state-warn)", color: "var(--state-warn)" }}
          >
            {busy === (isPaused ? "resume" : "pause") ? "…" : isPaused ? "▶" : "⏸"}
          </button>
          <button
            onClick={(e) => act(e, "cancel")}
            disabled={!!busy}
            className="flex flex-1 items-center justify-center rounded-lg border py-1.5 text-xs font-semibold transition disabled:opacity-40"
            style={{ borderColor: "var(--state-error)", color: "var(--state-error)" }}
          >
            {busy === "cancel" ? "…" : "⏹"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── compact select ────────────────────────────────────────────────────────────

function CompactSelect<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-sm text-[var(--text)] outline-none hover:border-[var(--border-strong)]   "
    >
      {options.map((o) => (
        <option key={o.id} value={o.id}>{o.label}</option>
      ))}
    </select>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  usePageTitle("nav.dashboard");
  const user = useUser();
  const router = useRouter();
  const t = useT();

  const GROUP_OPTS: { id: GroupBy; label: string }[] = [
    { id: "mygroup", label: t("dashboard.byMyGroups") },
    { id: "none",    label: t("dashboard.noGrouping") },
    { id: "kind",    label: t("dashboard.byType") },
    { id: "state",   label: t("dashboard.byState") },
  ];

  const [printers, setPrinters] = useState<Printer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [groupBy, setGroupBy] = useState<GroupBy>("mygroup");
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [selected, setSelected] = useState<Printer | null>(null);
  const [printPrinter, setPrintPrinter] = useState<Printer | null>(null);
  const [view, setView] = useState<"cards" | "photos" | "flow">("cards");

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api<Printer[]>("/api/printers");
      setPrinters(data);
      setRefreshedAt(new Date());
      try { localStorage.setItem("printers_cache", JSON.stringify(data)); } catch {}
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError(t("errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, []);

  // Show cached printers instantly on first render while fresh data loads
  useEffect(() => {
    try {
      const cached = localStorage.getItem("printers_cache");
      if (cached) { setPrinters(JSON.parse(cached)); setLoading(false); }
    } catch {}
  }, []);

  useEffect(() => {
    load();
    // One-time background Bambu LAN discovery to populate missing IPs.
    api<{ devices: unknown[] }>("/api/printers/bambu-discover")
      .then((r) => { if (r.devices?.length) load(); })
      .catch(() => {});
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  const filtered = useMemo(() => {
    let result: Printer[];
    if (filter === "all") result = printers;
    else if (filter === "printing") result = printers.filter((p) => p.state === "printing");
    else if (filter === "attention") result = printers.filter((p) => p.state === "error");
    else if (filter === "idle") result = printers.filter((p) => p.state === "idle" || p.state === "operational");
    else if (filter === "paused") result = printers.filter((p) => p.state === "paused");
    else if (filter === "awaiting") result = printers.filter((p) => p.state === "awaiting_bed_clear");
    else if (filter === "offline") result = printers.filter((p) => p.state === "offline" || p.state === "unknown");
    else result = printers;

    if (filter === "printing") {
      return [...result].sort((a, b) => {
        if (a.eta_minutes == null && b.eta_minutes == null) return 0;
        if (a.eta_minutes == null) return 1;
        if (b.eta_minutes == null) return -1;
        return a.eta_minutes - b.eta_minutes;
      });
    }
    return result;
  }, [printers, filter]);

  const groups = useMemo(
    () => groupPrinters(filtered, groupBy),
    [filtered, groupBy],
  );

  const counts = useMemo(() => {
    const c = { all: printers.length, snapmaker_u1: 0, problems: 0 };
    for (const p of printers) {
      if (p.kind === "snapmaker_u1") c.snapmaker_u1++;
      const t = printerTone(p);
      if (t === "bad" || t === "warn") c.problems++;
    }
    return c;
  }, [printers]);

  function upsertPrinter(p: Printer) {
    setPrinters((prev) => {
      const idx = prev.findIndex((x) => x.id === p.id);
      if (idx === -1) return [...prev, p];
      const copy = [...prev];
      copy[idx] = p;
      return copy;
    });
  }

  const GRID = "grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6";
  const isGrouped = groupBy !== "none";

  const statusStats = useMemo(() => {
    let attention = 0, idle = 0, paused = 0, printing = 0, awaiting = 0, offline = 0;
    let nextFinish: { name: string; eta: number } | null = null;
    for (const p of printers) {
      const s = p.state ?? "unknown";
      if (s === "error") attention++;
      else if (s === "idle" || s === "operational") idle++;
      else if (s === "paused") paused++;
      else if (s === "awaiting_bed_clear") awaiting++;
      else if (s === "printing") {
        printing++;
        if (p.eta_minutes != null && (!nextFinish || p.eta_minutes < nextFinish.eta))
          nextFinish = { name: p.name, eta: p.eta_minutes };
      }
      if (s === "offline" || s === "unknown") offline++;
    }
    return { attention, idle, paused, printing, awaiting, offline, nextFinish };
  }, [printers]);

  return (
    <div className="space-y-4">
      {/* ── status cards ── */}
      {printers.length > 0 && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-7">
          <StatusCard
            label="Next printer finish"
            value={statusStats.nextFinish
              ? statusStats.nextFinish.eta >= 60
                ? `${Math.floor(statusStats.nextFinish.eta / 60)}h ${statusStats.nextFinish.eta % 60}m`
                : `${statusStats.nextFinish.eta}m`
              : "—"}
            sub={statusStats.nextFinish?.name}
            color="var(--state-print)"
            active={filter === "printing"}
            onClick={() => setFilter(filter === "printing" ? "all" : "printing")}
          />
          <StatusCard label="Requires attention" value={statusStats.attention} color="var(--state-error)" active={filter === "attention"} onClick={() => setFilter(filter === "attention" ? "all" : "attention")} />
          <StatusCard label="Idle & ready" value={statusStats.idle} color="var(--state-ok)" active={filter === "idle"} onClick={() => setFilter(filter === "idle" ? "all" : "idle")} />
          <StatusCard label="Paused" value={statusStats.paused} color="var(--state-warn)" active={filter === "paused"} onClick={() => setFilter(filter === "paused" ? "all" : "paused")} />
          <StatusCard label="Awaiting" value={statusStats.awaiting} color="var(--state-warn)" active={filter === "awaiting"} onClick={() => setFilter(filter === "awaiting" ? "all" : "awaiting")} />
          <StatusCard label="Printing" value={statusStats.printing} color="var(--state-print)" active={filter === "printing"} onClick={() => setFilter(filter === "printing" ? "all" : "printing")} />
          <StatusCard label="Offline / not connected" value={statusStats.offline} color="var(--state-offline)" active={filter === "offline"} onClick={() => setFilter(filter === "offline" ? "all" : "offline")} />
        </div>
      )}

      {/* ── toolbar ── */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--text-faint)]">
            {filtered.length !== counts.all
              ? `${filtered.length} з ${counts.all}`
              : counts.all}
          </span>
          <CompactSelect value={groupBy} onChange={setGroupBy} options={GROUP_OPTS} />
        </div>

        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          {refreshedAt && (
            <span className="text-xs">{refreshedAt.toLocaleTimeString("uk-UA")}</span>
          )}
          <button
            onClick={load}
            className="rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs transition hover:bg-[var(--surface-hi)]  "
          >
            ↻ {t("common.update")}
          </button>
          {(user.role === "admin" || user.role === "operator") && (
            <button
              onClick={() => setGroupsOpen(true)}
              className="rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--text-muted)] transition hover:bg-[var(--surface-hi)]   "
              title={t("dashboard.manageGroups")}
            >
              {t("printers.groups")}
            </button>
          )}
          {/* view toggle */}
          <div className="flex rounded-md border border-[var(--border)] overflow-hidden">
            <button
              onClick={() => setView("cards")}
              title="Картки"
              className={`px-2.5 py-1.5 text-xs transition ${view === "cards" ? "bg-[var(--surface-2)] text-[var(--text-hi)]" : "text-[var(--text-muted)] hover:bg-[var(--surface-hi)]"}`}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
            </button>
            <button
              onClick={() => setView("photos")}
              title="Фото"
              className={`px-2.5 py-1.5 text-xs transition border-l border-[var(--border)] ${view === "photos" ? "bg-[var(--surface-2)] text-[var(--text-hi)]" : "text-[var(--text-muted)] hover:bg-[var(--surface-hi)]"}`}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
            </button>
            <button
              onClick={() => setView("flow")}
              title="Потік виробництва"
              className={`px-2.5 py-1.5 text-xs transition border-l border-[var(--border)] ${view === "flow" ? "bg-[var(--surface-2)] text-[var(--text-hi)]" : "text-[var(--text-muted)] hover:bg-[var(--surface-hi)]"}`}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/></svg>
            </button>
          </div>

          {user.role === "admin" && (
            <button
              onClick={() => router.push("/settings?section=printers")}
              className="btn btn-primary btn-sm"
            >
              + {t("printers.add")}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-[rgba(239,68,68,.25)] bg-[rgba(239,68,68,.08)] px-3 py-2 text-sm text-[var(--state-error)]">
          {error}
        </div>
      )}

      {/* ── content ── */}
      {view === "flow" ? (
        <FlowView printers={printers} />
      ) : loading && printers.length === 0 ? (
        <div className="text-sm text-[var(--text-muted)]">{t("common.loading")}</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--border-strong)] px-4 py-12 text-center text-sm text-[var(--text-muted)] ">
          {t("dashboard.noPrinters")}
        </div>
      ) : view === "photos" ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {filtered.map((p) => (
            <PrinterPhotoCard key={p.id} printer={p} onClick={() => router.push(`/printers/${p.id}`)} onUpdated={upsertPrinter} />
          ))}
        </div>
      ) : !isGrouped ? (
        <div className={GRID}>
          {filtered.map((p) => (
            <PrinterCard key={p.id} printer={p} onClick={(p) => router.push(`/printers/${p.id}`)} onSettings={setSelected} onUpdated={upsertPrinter} onPrint={setPrintPrinter} />
          ))}
        </div>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => {
            const stats = calcGroupStats(g.items);
            return (
              <section key={g.key}>
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-sm font-semibold">{g.label}</span>
                  <span className="rounded-full bg-[var(--surface-hi)] px-2 py-0.5 text-xs text-[var(--text-muted)]  ">
                    {g.items.length}
                  </span>
                  <div className="h-px flex-1 bg-[var(--surface-hi)] " />
                  <GroupStatsBadges stats={stats} />
                </div>
                <div className={GRID}>
                  {g.items.map((p) => (
                    <PrinterCard key={p.id} printer={p} onClick={(p) => router.push(`/printers/${p.id}`)} onSettings={setSelected} onUpdated={upsertPrinter} onPrint={setPrintPrinter} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <PrinterGroupsModal
        open={groupsOpen}
        onClose={() => setGroupsOpen(false)}
        onChange={load}
      />

      <PrinterDetailModal
        printer={selected}
        onClose={() => setSelected(null)}
        onUpdated={(p) => { upsertPrinter(p); load(); }}
        onDeleted={(id) => setPrinters((prev) => prev.filter((p) => p.id !== id))}
      />

      {!loading && printers.length > 0 && <div className="hidden dark:block"><DashboardPet printers={printers} /></div>}

      {printPrinter && (
        <StartPrintModal
          printer={printPrinter}
          printers={printers}
          onClose={() => setPrintPrinter(null)}
        />
      )}
    </div>
  );
}
