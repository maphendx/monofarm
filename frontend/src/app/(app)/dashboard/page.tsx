"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { usePrinterStream } from "@/hooks/usePrinterStream";
import { useRouter, useSearchParams } from "next/navigation";

import { DashboardPet } from "@/components/dashboard/DashboardPet";
import { FlowView } from "@/components/dashboard/FlowView";
import { AutoDispatchModal } from "@/components/files/AutoDispatchModal";
import { SendModal } from "@/components/files/SendModal";
import { PrinterCard } from "@/components/printers/PrinterCard";
import { printerCanStartPrint, printerCover as getPrinterCover, printerNeedsClearBed } from "@/components/printers/printerCardModel";
import { PrinterDetailModal } from "@/components/printers/PrinterDetailModal";
import { PrinterGroupActionsMenu } from "@/components/printers/PrinterGroupActionsMenu";
import { PrinterGroupsModal } from "@/components/printers/PrinterGroupsModal";
import { StartPrintModal } from "@/components/printers/StartPrintModal";
import { EmptyState } from "@/components/ui/EmptyState";
import { ApiError, api } from "@/lib/api";
import { useUser } from "@/lib/auth-context";
import { useT } from "@/lib/i18n";
import {
  kindLabel,
  printerTone,
  stateLabel,
} from "@/lib/printerLabels";
import type { GcodeFile, Printer, PrinterKind } from "@/lib/types";
import { usePageTitle } from "@/lib/usePageTitle";

// ── StatusCard ────────────────────────────────────────────────────────────────

function StatusCard({
  label,
  value,
  sub,
  color,
  active,
  dimmed,
  onClick,
}: {
  label: string;
  value: string | number;
  sub?: string;
  color: string;
  active?: boolean;
  dimmed?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={[
        "relative overflow-hidden rounded-xl border px-4 py-3 transition",
        onClick ? "cursor-pointer" : "",
        active
          ? "border-[var(--border-strong)] bg-[var(--surface-2)]"
          : "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hi)]",
        dimmed ? "opacity-50 hover:opacity-90" : "",
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
  awaiting: number; // needs bed clear
  action: number;  // in_maintenance / error
  ready: number;   // operational / idle / online / print_pending, excluding those awaiting bed clear
  offline: number; // offline / not_connected / unknown
}

function calcGroupStats(items: Printer[]): GroupStats {
  const s: GroupStats = { printing: 0, paused: 0, awaiting: 0, action: 0, ready: 0, offline: 0 };
  for (const p of items) {
    const st = p.state ?? "unknown";
    if (st === "printing") s.printing++;
    else if (st === "paused") s.paused++;
    else if (printerNeedsClearBed(p)) s.awaiting++;
    else if (["in_maintenance", "error"].includes(st)) s.action++;
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
      <StatBadge count={stats.awaiting} label={t("dashboard.awaiting")} className="badge badge-warn" />
      <StatBadge count={stats.action}   label={t("dashboard.action")}   className="badge badge-warn" />
      <StatBadge count={stats.ready}    label={t("dashboard.ready")}    className="badge badge-ok" />
      <StatBadge count={stats.offline}  label={t("dashboard.offline")}  className="badge badge-offline" />
    </div>
  );
}

// ── filter ───────────────────────────────────────────────────────────────────

type Filter = "printing" | "attention" | "idle" | "paused" | "awaiting" | "offline";
type GroupBy = "mygroup" | "none" | "kind" | "state";

const FILTER_VALUES: Filter[] = ["printing", "attention", "idle", "paused", "awaiting", "offline"];

const FILTER_LABEL: Record<Filter, string> = {
  printing: "Printing",
  attention: "Requires attention",
  idle: "Idle & ready",
  paused: "Paused",
  awaiting: "Awaiting",
  offline: "Offline / not connected",
};

function matchesFilter(p: Printer, f: Filter): boolean {
  switch (f) {
    case "printing": return p.state === "printing";
    case "attention": return p.state === "error";
    case "idle": return p.state === "idle" || p.state === "operational";
    case "paused": return p.state === "paused";
    case "awaiting": return printerNeedsClearBed(p);
    case "offline": return p.state === "offline" || p.state === "unknown";
  }
}

function sortByEta(items: Printer[]): Printer[] {
  return [...items].sort((a, b) => {
    if (a.eta_minutes == null && b.eta_minutes == null) return 0;
    if (a.eta_minutes == null) return 1;
    if (b.eta_minutes == null) return -1;
    return a.eta_minutes - b.eta_minutes;
  });
}

function useIsNarrowScreen(breakpointPx: number): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpointPx}px)`);
    setNarrow(mq.matches);
    const handler = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [breakpointPx]);
  return narrow;
}

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
  onPrint,
}: {
  printer: Printer;
  onClick: () => void;
  onUpdated: (p: Printer) => void;
  onPrint?: (p: Printer) => void;
}) {
  const cover      = getPrinterCover(printer);
  const tone       = printerTone(printer);
  const isPrinting = printer.state === "printing";
  const isPaused   = printer.state === "paused";
  const isError    = printer.state === "error";
  const needsClearBed = printerNeedsClearBed(printer);
  const canStartPrint = printerCanStartPrint(printer);
  const pct        = printer.progress_pct ?? 0;
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmClearBed, setConfirmClearBed] = useState(false);

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
    setConfirmClearBed(false);
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
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-faint)] ">
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
      {canStartPrint && onPrint && (
        <div className="pt-0.5" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onPrint(printer); }}
            className="flex w-full items-center justify-center rounded-lg border border-[var(--state-ok)] bg-[rgba(34,197,94,.08)] py-1.5 text-xs font-semibold text-[var(--state-ok)] transition hover:bg-[rgba(34,197,94,.15)]"
          >
            ▶ Друк
          </button>
        </div>
      )}

      {(needsClearBed || isError) && (
        <div className="flex gap-1.5 pt-0.5" onClick={(e) => e.stopPropagation()}>
          {confirmClearBed ? (
            <>
              <button
                onClick={(e) => act(e, "clear-bed")}
                disabled={!!busy}
                className="flex flex-1 items-center justify-center rounded-lg border py-1.5 text-xs font-semibold transition disabled:opacity-40"
                style={{ borderColor: "var(--state-ok)", color: "var(--state-ok)" }}
              >
                {busy === "clear-bed" ? "…" : "Так"}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setConfirmClearBed(false); }}
                disabled={!!busy}
                className="flex flex-1 items-center justify-center rounded-lg border border-[var(--border)] py-1.5 text-xs font-semibold text-[var(--text-muted)] transition hover:bg-[var(--surface-hi)] disabled:opacity-40"
              >
                Ні
              </button>
            </>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); setConfirmClearBed(true); }}
              disabled={!!busy}
              className="flex flex-1 items-center justify-center rounded-lg border py-1.5 text-xs font-semibold transition disabled:opacity-40"
              style={{ borderColor: "var(--state-ok)", color: "var(--state-ok)" }}
            >
              Стіл очищено
            </button>
          )}
        </div>
      )}

      {(isPrinting || isPaused || isError) && (
        <div className="flex gap-1.5 pt-0.5" onClick={(e) => e.stopPropagation()}>
          {isError ? (
            <button
              onClick={(e) => act(e, "clear-error")}
              disabled={!!busy}
              className="flex flex-1 items-center justify-center rounded-lg border py-1.5 text-xs font-semibold transition disabled:opacity-40"
              style={{ borderColor: "var(--state-warn)", color: "var(--state-warn)" }}
              title="Скинути помилку"
            >
              {busy === "clear-error" ? "…" : "↺"}
            </button>
          ) : (
            <button
              onClick={(e) => act(e, isPaused ? "resume" : "pause")}
              disabled={!!busy}
              className="flex flex-1 items-center justify-center rounded-lg border py-1.5 text-xs font-semibold transition disabled:opacity-40"
              style={isPaused
                ? { borderColor: "var(--state-ok)", color: "var(--state-ok)" }
                : { borderColor: "var(--state-warn)", color: "var(--state-warn)" }}
              title={isPaused ? "Продовжити" : "Пауза"}
            >
              {busy === (isPaused ? "resume" : "pause") ? "…" : isPaused ? "▶" : "⏸"}
            </button>
          )}
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
  const searchParams = useSearchParams();
  const t = useT();

  const GROUP_OPTS: { id: GroupBy; label: string }[] = [
    { id: "mygroup", label: t("dashboard.byMyGroups") },
    { id: "none",    label: t("dashboard.noGrouping") },
    { id: "kind",    label: t("dashboard.byType") },
    { id: "state",   label: t("dashboard.byState") },
  ];

  const { printers, connected, loading, reload, upsertPrinter } = usePrinterStream();
  const [activeFilters, setActiveFilters] = useState<Filter[]>([]);
  const [tagFilter, setTagFilter] = useState<number[]>([]);
  const [groupBy, setGroupBy] = useState<GroupBy>("mygroup");
  const isNarrowScreen = useIsNarrowScreen(768);
  useEffect(() => {
    try {
      const saved = localStorage.getItem("monofarm_printer_group_by") as GroupBy;
      if (saved && (["mygroup", "none", "kind", "state"] as GroupBy[]).includes(saved)) setGroupBy(saved);
    } catch {}
  }, []);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("monofarm_dashboard_filters") ?? "[]");
      if (Array.isArray(saved) && saved.every((v) => FILTER_VALUES.includes(v))) {
        setActiveFilters(saved as Filter[]);
      }
    } catch {}
  }, []);
  function toggleFilter(f: Filter) {
    setActiveFilters((prev) => {
      const next = prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f];
      try { localStorage.setItem("monofarm_dashboard_filters", JSON.stringify(next)); } catch {}
      return next;
    });
  }
  function handleGroupByChange(v: GroupBy) {
    setGroupBy(v);
    setLocalOrder(null);
    try { localStorage.setItem("monofarm_printer_group_by", v); } catch {}
  }
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [autoDispatchOpen, setAutoDispatchOpen] = useState(false);
  const [selected, setSelected] = useState<Printer | null>(null);
  const [printPrinter, setPrintPrinter] = useState<Printer | null>(null);
  const [view, setView] = useState<"cards" | "photos" | "flow">("cards");
  const [dragPrinterId, setDragPrinterId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const [localOrder, setLocalOrder] = useState<number[] | null>(null);
  const [slicerFile, setSlicerFile] = useState<GcodeFile | null>(null);
  const [slicerError, setSlicerError] = useState<string | null>(null);
  const dismissedSlicerFileIdRef = useRef<number | null>(null);
  const slicerRequestSeqRef = useRef(0);

  const slicerFileParam = searchParams.get("slicerFile");
  const slicerPrinterParam = searchParams.get("printer");
  const parsedSlicerFileId = slicerFileParam ? Number(slicerFileParam) : null;
  const parsedSlicerPrinterId = slicerPrinterParam ? Number(slicerPrinterParam) : undefined;
  const slicerFileId = parsedSlicerFileId && !Number.isNaN(parsedSlicerFileId) ? parsedSlicerFileId : null;
  const slicerPrinterId = parsedSlicerPrinterId && !Number.isNaN(parsedSlicerPrinterId) ? parsedSlicerPrinterId : undefined;
  const slicerAskMode = searchParams.get("slicerAction") === "choose";

  // One-time Bambu LAN discovery to populate missing IPs.
  useEffect(() => {
    api<unknown>("/api/printers/bambu-discover")
      .then((r) => {
        const devices = Array.isArray(r) ? r : (r as { devices?: unknown[] }).devices;
        if (devices?.length) reload();
      })
      .catch(() => {});
  }, [reload]);

  useEffect(() => {
    if (!slicerFileId || Number.isNaN(slicerFileId)) return;
    if (dismissedSlicerFileIdRef.current === slicerFileId) return;
    let cancelled = false;
    const requestSeq = ++slicerRequestSeqRef.current;
    api<GcodeFile>(`/api/files/${slicerFileId}`)
      .then((file) => {
        if (
          !cancelled
          && slicerRequestSeqRef.current === requestSeq
          && dismissedSlicerFileIdRef.current !== slicerFileId
        ) {
          setSlicerError(null);
          setSlicerFile(file);
        }
      })
      .catch((err) => {
        if (
          !cancelled
          && slicerRequestSeqRef.current === requestSeq
          && dismissedSlicerFileIdRef.current !== slicerFileId
        ) {
          setSlicerError(err instanceof ApiError ? err.message : "Не вдалося відкрити файл з OrcaSlicer");
        }
      });
    return () => { cancelled = true; };
  }, [slicerFileId]);

  const displayPrinters = useMemo(() => {
    if (!localOrder) return printers;
    const byId = new Map(printers.map(p => [p.id, p]));
    const ordered = localOrder.map(id => byId.get(id)).filter(Boolean) as Printer[];
    const knownIds = new Set(localOrder);
    return [...ordered, ...printers.filter(p => !knownIds.has(p.id))];
  }, [localOrder, printers]);

  const filtered = useMemo(() => {
    let result = activeFilters.length === 0
      ? displayPrinters
      : displayPrinters.filter((p) => activeFilters.some((f) => matchesFilter(p, f)));

    if (tagFilter.length > 0) {
      result = result.filter((p) => tagFilter.every((id) => p.tags?.some((t) => t.id === id)));
    }

    if (activeFilters.length === 1 && activeFilters[0] === "printing") {
      return sortByEta(result);
    }
    return result;
  }, [displayPrinters, activeFilters, tagFilter]);

  // 2+ active filters in cards view → split the board into resizable "magnetic window" panels
  const splitPanels = useMemo(() => {
    if (activeFilters.length < 2 || view !== "cards") return null;
    return activeFilters.map((f) => {
      const items = filtered.filter((p) => matchesFilter(p, f));
      return { key: f, label: FILTER_LABEL[f], items: f === "printing" ? sortByEta(items) : items };
    });
  }, [activeFilters, filtered, view]);

  // All tags currently assigned to at least one printer (for the filter chips)
  const availableTags = useMemo(() => {
    const byId = new Map<number, Printer["tags"][number]>();
    for (const p of printers) for (const t of p.tags ?? []) byId.set(t.id, t);
    return [...byId.values()].sort((a, b) => (a.display || "").localeCompare(b.display || ""));
  }, [printers]);

  const counts = useMemo(() => {
    const c = { all: printers.length, snapmaker_u1: 0, problems: 0 };
    for (const p of printers) {
      if (p.kind === "snapmaker_u1") c.snapmaker_u1++;
      const t = printerTone(p);
      if (t === "bad" || t === "warn") c.problems++;
    }
    return c;
  }, [printers]);

  async function handlePrinterDropInGroup(items: Printer[], targetId: number) {
    if (!dragPrinterId || dragPrinterId === targetId) return;
    const fromIdx = items.findIndex(p => p.id === dragPrinterId);
    const toIdx = items.findIndex(p => p.id === targetId);
    if (fromIdx < 0 || toIdx < 0) { setDragPrinterId(null); setDragOverId(null); return; }
    const next = [...items];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    const groupIdSet = new Set(items.map(p => p.id));
    const cur = localOrder
      ? (localOrder.map(id => printers.find(p => p.id === id)).filter(Boolean) as Printer[])
      : printers;
    let gi = 0;
    const newFull = cur.map(p => groupIdSet.has(p.id) ? next[gi++] : p);
    setDragPrinterId(null);
    setDragOverId(null);
    setLocalOrder(newFull.map(p => p.id));
    try {
      await api("/api/printers/reorder", {
        method: "POST",
        body: JSON.stringify(next.map((p, i) => ({ id: p.id, sort_order: i }))),
      });
    } catch {
      setLocalOrder(null);
    }
  }

  const GRID = "printer-card-grid";
  const isGrouped = groupBy !== "none";

  const statusStats = useMemo(() => {
    let attention = 0, idle = 0, paused = 0, printing = 0, awaiting = 0, offline = 0;
    let nextFinish: { name: string; eta: number } | null = null;
    for (const p of printers) {
      const s = p.state ?? "unknown";
      if (s === "error") attention++;
      else if (printerNeedsClearBed(p)) awaiting++;
      else if (s === "idle" || s === "operational") idle++;
      else if (s === "paused") paused++;
      else if (s === "printing") {
        printing++;
        if (p.eta_minutes != null && (!nextFinish || p.eta_minutes < nextFinish.eta))
          nextFinish = { name: p.name, eta: p.eta_minutes };
      }
      if (s === "offline" || s === "unknown") offline++;
    }
    return { attention, idle, paused, printing, awaiting, offline, nextFinish };
  }, [printers]);

  function renderPrinterSection(items: Printer[]) {
    if (!isGrouped) {
      return (
        <div className={GRID}>
          {items.map((p) => (
            <PrinterCard key={p.id} printer={p} onClick={(p) => router.push(`/printers/${p.id}`)} onSettings={setSelected} onUpdated={upsertPrinter} onPrint={setPrintPrinter} onDeleted={() => reload()} />
          ))}
        </div>
      );
    }
    const sectionGroups = groupPrinters(items, groupBy);
    return (
      <div className="space-y-5">
        {sectionGroups.map((g) => {
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
                {groupBy === "mygroup" && g.key.startsWith("g") && user.role === "admin" && (
                  <PrinterGroupActionsMenu
                    groupId={Number(g.key.slice(1))}
                    groupName={g.label}
                    printers={g.items}
                    onChanged={reload}
                  />
                )}
              </div>
              <div className={GRID}>
                {g.items.map((p) => (
                  <div
                    key={p.id}
                    draggable={groupBy === "mygroup"}
                    onDragStart={() => setDragPrinterId(p.id)}
                    onDragOver={(e) => { e.preventDefault(); setDragOverId(p.id); }}
                    onDragEnd={() => { setDragPrinterId(null); setDragOverId(null); }}
                    onDrop={(e) => { e.preventDefault(); handlePrinterDropInGroup(g.items, p.id); }}
                    className={[
                      "transition-opacity",
                      dragPrinterId === p.id ? "opacity-40" : "",
                      dragOverId === p.id && dragPrinterId !== p.id ? "ring-2 ring-[var(--accent)] rounded-xl" : "",
                    ].join(" ")}
                  >
                    <PrinterCard printer={p} onClick={(p) => router.push(`/printers/${p.id}`)} onSettings={setSelected} onUpdated={upsertPrinter} onPrint={setPrintPrinter} onDeleted={() => reload()} />
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    );
  }

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
            active={activeFilters.includes("printing")}
            dimmed={activeFilters.length > 0 && !activeFilters.includes("printing")}
            onClick={() => toggleFilter("printing")}
          />
          <StatusCard label="Requires attention" value={statusStats.attention} color="var(--state-error)" active={activeFilters.includes("attention")} dimmed={activeFilters.length > 0 && !activeFilters.includes("attention")} onClick={() => toggleFilter("attention")} />
          <StatusCard label="Idle & ready" value={statusStats.idle} color="var(--state-ok)" active={activeFilters.includes("idle")} dimmed={activeFilters.length > 0 && !activeFilters.includes("idle")} onClick={() => toggleFilter("idle")} />
          <StatusCard label="Paused" value={statusStats.paused} color="var(--state-warn)" active={activeFilters.includes("paused")} dimmed={activeFilters.length > 0 && !activeFilters.includes("paused")} onClick={() => toggleFilter("paused")} />
          <StatusCard label="Awaiting" value={statusStats.awaiting} color="var(--state-warn)" active={activeFilters.includes("awaiting")} dimmed={activeFilters.length > 0 && !activeFilters.includes("awaiting")} onClick={() => toggleFilter("awaiting")} />
          <StatusCard label="Printing" value={statusStats.printing} color="var(--state-print)" active={activeFilters.includes("printing")} dimmed={activeFilters.length > 0 && !activeFilters.includes("printing")} onClick={() => toggleFilter("printing")} />
          <StatusCard label="Offline / not connected" value={statusStats.offline} color="var(--state-offline)" active={activeFilters.includes("offline")} dimmed={activeFilters.length > 0 && !activeFilters.includes("offline")} onClick={() => toggleFilter("offline")} />
        </div>
      )}
      {activeFilters.length >= 2 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--text-faint)]">
          <span>{splitPanels ? "Розбито на панелі:" : "Активні фільтри:"}</span>
          {activeFilters.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => toggleFilter(f)}
              className="inline-flex items-center gap-1 rounded-full border border-[var(--accent)] bg-[var(--accent-soft)] px-2 py-0.5 text-[var(--text-hi)] transition hover:opacity-80"
            >
              {FILTER_LABEL[f]} ✕
            </button>
          ))}
          <button
            type="button"
            onClick={() => { setActiveFilters([]); try { localStorage.setItem("monofarm_dashboard_filters", "[]"); } catch {} }}
            className="rounded-full px-1.5 py-0.5 text-[var(--text-faint)] hover:text-[var(--text)]"
          >
            Скинути все
          </button>
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
          <CompactSelect value={groupBy} onChange={handleGroupByChange} options={GROUP_OPTS} />
          {availableTags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              {availableTags.map((t) => {
                const active = tagFilter.includes(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() =>
                      setTagFilter(active ? tagFilter.filter((id) => id !== t.id) : [...tagFilter, t.id])
                    }
                    className={[
                      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition",
                      active
                        ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text-hi)]"
                        : "border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:bg-[var(--surface-hi)]",
                    ].join(" ")}
                  >
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: t.color ?? "var(--text-faint)" }}
                    />
                    {t.display || t.label}
                  </button>
                );
              })}
              {tagFilter.length > 0 && (
                <button
                  type="button"
                  onClick={() => setTagFilter([])}
                  className="rounded-full px-1.5 py-0.5 text-[11px] text-[var(--text-faint)] hover:text-[var(--text)]"
                >
                  ✕
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <span
            className={`inline-block size-2 rounded-full transition-colors ${connected ? "bg-[var(--state-ok)]" : "animate-pulse bg-[var(--text-faint)]"}`}
            title={connected ? "Live" : "Reconnecting…"}
          />
          <button
            onClick={reload}
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
          {statusStats.idle > 0 && (user.role === "admin" || user.role === "operator") && (
            <button
              onClick={() => setAutoDispatchOpen(true)}
              className="rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--text-muted)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
              title="Авто-розподіл завдань по вільних принтерах"
            >
              ⚡ Розподілити
            </button>
          )}
          {/* view toggle */}
          <div className="flex rounded-md border border-[var(--border)] overflow-hidden">
            <button
              onClick={() => setView("cards")}
              title="Картки"
              className={`px-2.5 py-1.5 text-xs transition ${view === "cards" ? "bg-[var(--surface-2)] text-[var(--text-hi)]" : "text-[var(--text-muted)] hover:bg-[var(--surface-hi)]"}`}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
            </button>
            <button
              onClick={() => setView("photos")}
              title="Фото"
              className={`px-2.5 py-1.5 text-xs transition border-l border-[var(--border)] ${view === "photos" ? "bg-[var(--surface-2)] text-[var(--text-hi)]" : "text-[var(--text-muted)] hover:bg-[var(--surface-hi)]"}`}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
            </button>
            <button
              onClick={() => setView("flow")}
              title="Потік виробництва"
              className={`px-2.5 py-1.5 text-xs transition border-l border-[var(--border)] ${view === "flow" ? "bg-[var(--surface-2)] text-[var(--text-hi)]" : "text-[var(--text-muted)] hover:bg-[var(--surface-hi)]"}`}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/></svg>
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

      {slicerError && (
        <div className="rounded-md border border-[rgba(239,68,68,.25)] bg-[rgba(239,68,68,.08)] px-3 py-2 text-sm text-[var(--state-error)]">
          {slicerError}
        </div>
      )}

      {/* ── content ── */}
      {view === "flow" ? (
        <FlowView printers={printers} />
      ) : loading && printers.length === 0 ? (
        <div className="text-sm text-[var(--text-muted)]">{t("common.loading")}</div>
      ) : printers.length === 0 ? (
        <EmptyState
          icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/></svg>}
          title={t("dashboard.noPrinters")}
          description={t("dashboard.addFirstPrinter")}
          action={{ label: t("printers.add"), href: "/settings" }}
        />
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--border-strong)] px-4 py-12 text-center text-sm text-[var(--text-muted)] ">
          {t("dashboard.noMatch")}
        </div>
      ) : view === "photos" ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4">
          {filtered.map((p) => (
            <PrinterPhotoCard key={p.id} printer={p} onClick={() => router.push(`/printers/${p.id}`)} onUpdated={upsertPrinter} onPrint={setPrintPrinter} />
          ))}
        </div>
      ) : splitPanels ? (
        <PanelGroup
          key={splitPanels.map((p) => p.key).join("-")}
          direction={isNarrowScreen ? "vertical" : "horizontal"}
          autoSaveId="monofarm-dashboard-split"
          className={isNarrowScreen ? "dashboard-split-group-v" : "dashboard-split-group"}
        >
          {splitPanels.map((panel, i) => (
            <Fragment key={panel.key}>
              {i > 0 && (
                <PanelResizeHandle className={isNarrowScreen ? "dashboard-split-handle-v" : "dashboard-split-handle"} />
              )}
              <Panel id={panel.key} order={i} minSize={18} className="dashboard-split-panel">
                <div className="mb-2 flex items-center gap-2 px-1">
                  <span className="text-sm font-semibold">{panel.label}</span>
                  <span className="rounded-full bg-[var(--surface-hi)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
                    {panel.items.length}
                  </span>
                  <div className="h-px flex-1 bg-[var(--surface-hi)]" />
                  <button
                    type="button"
                    onClick={() => toggleFilter(panel.key)}
                    title="Прибрати панель"
                    className="rounded-md px-1.5 py-0.5 text-xs text-[var(--text-faint)] transition hover:bg-[var(--surface-hi)] hover:text-[var(--text)]"
                  >
                    ✕
                  </button>
                </div>
                <div className="dashboard-split-panel-body">
                  {panel.items.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-[var(--border-strong)] px-4 py-10 text-center text-sm text-[var(--text-muted)]">
                      {t("dashboard.noMatch")}
                    </div>
                  ) : (
                    renderPrinterSection(panel.items)
                  )}
                </div>
              </Panel>
            </Fragment>
          ))}
        </PanelGroup>
      ) : (
        renderPrinterSection(filtered)
      )}

      <PrinterGroupsModal
        open={groupsOpen}
        onClose={() => setGroupsOpen(false)}
        onChange={() => { setLocalOrder(null); reload(); }}
        externalPrinters={printers}
      />

      {autoDispatchOpen && (
        <AutoDispatchModal
          printers={printers}
          onClose={() => setAutoDispatchOpen(false)}
        />
      )}

      <PrinterDetailModal
        printer={selected}
        onClose={() => setSelected(null)}
        onUpdated={upsertPrinter}
        onDeleted={() => reload()}
      />

      {!loading && printers.length > 0 && <div className="hidden dark:block"><DashboardPet printers={printers} /></div>}

      {printPrinter && (
        <StartPrintModal
          printer={printPrinter}
          printers={printers}
          onClose={() => setPrintPrinter(null)}
        />
      )}

      {slicerFile && slicerFile.id === slicerFileId && (
        <SendModal
          key={slicerFile.id}
          file={slicerFile}
          printers={printers}
          defaultPrinterId={slicerPrinterId}
          askMode={slicerAskMode}
          deleteOnCancel={slicerAskMode}
          onClose={() => {
            if (slicerFileId) dismissedSlicerFileIdRef.current = slicerFileId;
            slicerRequestSeqRef.current += 1;
            setSlicerFile(null);
            setSlicerError(null);
            router.replace("/dashboard", { scroll: false });
          }}
        />
      )}
    </div>
  );
}
