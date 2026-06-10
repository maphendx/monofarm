"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { BambuJobDetailModal } from "@/components/printers/BambuJobDetailModal";
import { BambuJobStatusBadge } from "@/components/printers/BambuJobStatusBadge";
import { api } from "@/lib/api";
import { usePageTitle } from "@/lib/usePageTitle";
import type { BambuCloudJob, BambuCloudJobStatus, Printer } from "@/lib/types";

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtDt(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("uk-UA", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

function fmtEta(min: number | null): string {
  if (!min || min <= 0) return "—";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} год ${m} хв` : `${m} хв`;
}

// ── status filter tabs ────────────────────────────────────────────────────────

type StatusFilter = "all" | "active" | "completed" | "failed" | "cancelled";

const STATUS_TABS: { id: StatusFilter; label: string; statuses: BambuCloudJobStatus[] | null }[] = [
  { id: "all",       label: "Всі",        statuses: null },
  { id: "active",    label: "Активні",    statuses: ["queued", "validating", "creating_project", "uploading", "task_creating", "task_created", "acknowledged", "printing", "paused"] },
  { id: "completed", label: "Завершені",  statuses: ["completed"] },
  { id: "failed",    label: "Помилки",    statuses: ["failed", "lost"] },
  { id: "cancelled", label: "Скасовані",  statuses: ["cancelled"] },
];

const PAGE_LIMIT = 25;

// ── page ──────────────────────────────────────────────────────────────────────

export default function PrinterJobsPage() {
  usePageTitle("nav.printers");

  const searchParams = useSearchParams();
  const initPrinter = searchParams.get("printer_id") ?? "";

  const [jobs, setJobs] = useState<BambuCloudJob[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [printerFilter, setPrinterFilter] = useState(initPrinter);
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [openJobId, setOpenJobId] = useState<number | null>(null);
  const offsetRef = useRef(0);

  // load printer list for filter dropdown
  useEffect(() => {
    api<Printer[]>("/api/printers").then((list) => {
      setPrinters(list.filter((p) => p.kind === "bambu" || !!p.moonraker_url));
    }).catch(() => {});
  }, []);

  function buildUrl(offset: number) {
    const tab = STATUS_TABS.find((t) => t.id === statusFilter)!;
    const params = new URLSearchParams();
    params.set("limit", String(PAGE_LIMIT));
    params.set("offset", String(offset));
    if (printerFilter) params.set("printer_id", printerFilter);
    if (tab.statuses?.length === 1) params.set("status", tab.statuses[0]);
    return `/api/bambu-jobs?${params}`;
  }

  const loadFresh = useCallback(async () => {
    setLoading(true);
    offsetRef.current = 0;
    try {
      const data = await api<{ items: BambuCloudJob[]; total: number }>(buildUrl(0));
      setJobs(data.items);
      setTotal(data.total);
      offsetRef.current = data.items.length;
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, printerFilter]);

  useEffect(() => { void loadFresh(); }, [loadFresh]);

  // auto-refresh active tab every 8s
  useEffect(() => {
    if (statusFilter !== "active" && statusFilter !== "all") return;
    const t = setInterval(() => { if (!document.hidden) void loadFresh(); }, 8000);
    return () => clearInterval(t);
  }, [loadFresh, statusFilter]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const data = await api<{ items: BambuCloudJob[]; total: number }>(buildUrl(offsetRef.current));
      setJobs((prev) => [...prev, ...data.items]);
      setTotal(data.total);
      offsetRef.current += data.items.length;
    } catch { /* ignore */ } finally {
      setLoadingMore(false);
    }
  }

  // filter multi-status tabs client-side (API only takes single status param)
  const tab = STATUS_TABS.find((t) => t.id === statusFilter)!;
  const displayJobs = tab.statuses && tab.statuses.length > 1
    ? jobs.filter((j) => tab.statuses!.includes(j.status))
    : jobs;

  const hasMore = jobs.length < total;

  return (
    <div className="space-y-4">
      {/* ── header ── */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] pb-4">
        <div className="flex items-center gap-3">
          <Link href="/printers"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] text-[var(--text-faint)] transition hover:border-[var(--border-strong)] hover:text-[var(--text)]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7"/>
            </svg>
          </Link>
          <div>
            <h1 className="text-xl font-bold text-[var(--text-hi)]">Завдання друку</h1>
            {total > 0 && (
              <p className="text-xs text-[var(--text-faint)]">{total} завдань</p>
            )}
          </div>
        </div>

        {/* printer filter */}
        {printers.length > 1 && (
          <select
            value={printerFilter}
            onChange={(e) => { setPrinterFilter(e.target.value); }}
            className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-sm outline-none"
          >
            <option value="">Всі принтери</option>
            {printers.map((p) => (
              <option key={p.id} value={String(p.id)}>{p.name}</option>
            ))}
          </select>
        )}
      </div>

      {/* ── status tabs ── */}
      <div className="flex gap-px overflow-hidden rounded-lg border border-[var(--border)]">
        {STATUS_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setStatusFilter(t.id)}
            className={[
              "flex-1 px-3 py-2 text-xs font-medium transition",
              statusFilter === t.id
                ? "bg-[var(--accent)] text-white"
                : "bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:bg-[var(--surface-hi)]",
            ].join(" ")}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── table ── */}
      {loading ? (
        <div className="flex min-h-[30vh] items-center justify-center text-sm text-[var(--text-muted)]">
          Завантаження…
        </div>
      ) : displayJobs.length === 0 ? (
        <div className="flex min-h-[20vh] flex-col items-center justify-center gap-2 text-sm text-[var(--text-faint)]">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
          </svg>
          Завдань не знайдено
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--border)]">
          <table className="ds-table w-full text-sm">
            <thead>
              <tr>
                <th>Файл</th>
                <th>Принтер</th>
                <th>Статус</th>
                <th>Прогрес</th>
                <th>Залишилось</th>
                <th>Створено</th>
                <th>Оновлено</th>
              </tr>
            </thead>
            <tbody>
              {displayJobs.map((j) => (
                <tr
                  key={j.id}
                  className="cursor-pointer transition hover:bg-[var(--surface-hi)]"
                  onClick={() => setOpenJobId(j.id)}
                >
                  <td className="max-w-[220px]">
                    <p className="truncate font-mono text-[12px] text-[var(--text)]" title={j.file_name ?? ""}>
                      {j.file_name ?? `#${j.id}`}
                    </p>
                    {j.error_message && (
                      <p className="truncate text-[10px] text-[var(--state-error)]" title={j.error_message}>
                        {j.error_message}
                      </p>
                    )}
                  </td>
                  <td className="text-[var(--text-muted)]">
                    <span className="text-xs">{j.printer_name ?? "—"}</span>
                    {j.printer_model && (
                      <span className="ml-1 text-[10px] text-[var(--text-faint)]">· {j.printer_model}</span>
                    )}
                  </td>
                  <td>
                    <BambuJobStatusBadge status={j.status} />
                  </td>
                  <td>
                    {j.progress_pct != null ? (
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-[var(--surface-hi)]">
                          <div
                            className="h-full rounded-full"
                            style={{ background: "var(--state-print)", width: `${j.progress_pct}%` }}
                          />
                        </div>
                        <span className="font-mono text-[11px] tabular-nums text-[var(--text-muted)]">
                          {j.progress_pct}%
                        </span>
                      </div>
                    ) : (
                      <span className="text-[var(--text-faint)]">—</span>
                    )}
                  </td>
                  <td className="font-mono text-[11px] tabular-nums text-[var(--text-muted)]">
                    {fmtEta(j.eta_minutes)}
                  </td>
                  <td className="font-mono text-[11px] tabular-nums text-[var(--text-faint)]">
                    {fmtDt(j.created_at)}
                  </td>
                  <td className="font-mono text-[11px] tabular-nums text-[var(--text-faint)]">
                    {fmtDt(j.last_mqtt_at ?? j.updated_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── load more ── */}
      {!loading && hasMore && (
        <button
          onClick={loadMore}
          disabled={loadingMore}
          className="w-full rounded-xl border border-[var(--border)] py-2.5 text-sm text-[var(--text-muted)] transition hover:bg-[var(--surface-hi)] disabled:opacity-50"
        >
          {loadingMore ? "Завантаження…" : `Завантажити ще (${total - jobs.length})`}
        </button>
      )}

      {openJobId != null && (
        <BambuJobDetailModal
          jobId={openJobId}
          onClose={() => setOpenJobId(null)}
          onChanged={loadFresh}
        />
      )}
    </div>
  );
}
