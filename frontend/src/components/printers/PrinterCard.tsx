"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";

import { SlotStrip } from "@/components/printers/SlotStrip";
import { PrinterQuickMenu, type QuickMenuPos } from "@/components/printers/PrinterQuickMenu";
import { API_URL, ApiError, api, getToken } from "@/lib/api";
import { useUser } from "@/lib/auth-context";
import {
  flagLabel,
  kindLabel,
  printerTone,
  stateLabel,
} from "@/lib/printerLabels";
import { StateIcon } from "@/components/printers/StateIcon";
import type { Printer } from "@/lib/types";

// Maps printerTone → .printer-card state modifier class (also used for .pc-status)
const TONE_CLASS: Record<string, string> = {
  printing: "printing",
  ok:       "ok",
  warn:     "warn",
  bad:      "error",
  idle:     "",
  muted:    "muted",
};

function formatEta(min: number | null): string | null {
  if (!min || min <= 0) return null;
  if (min < 60) return `${min}хв`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}г ${m}хв` : `${h}год`;
}

export function PrinterCard({
  printer,
  onClick,
  onSettings,
  onUpdated,
  onPrint,
  onDeleted,
}: {
  printer: Printer;
  onClick?: (p: Printer) => void;
  onSettings?: (p: Printer) => void;
  onUpdated?: (p: Printer) => void;
  onPrint?: (p: Printer) => void;
  onDeleted?: (id: number) => void;
}) {
  const user = useUser();
  const tone = printerTone(printer);
  const eta = formatEta(printer.eta_minutes);

  const isPrinting = printer.state === "printing";
  const isPaused = printer.state === "paused";
  const isIdle = printer.state === "idle";
  const isError = printer.state === "error";
  const needsClearBed = printer.state === "awaiting_bed_clear" ||
    (printer.state === "operational" && (!!printer.job || (printer.progress_pct ?? 0) >= 100));
  const canStartPrint = (isIdle || printer.state === "operational") && !needsClearBed && !printer.is_out_of_order;
  const hasMoonraker = !!printer.moonraker_url;
  const canEdit = user.role === "admin" || user.role === "operator";
  const isActionable = (isPrinting || isPaused || isError || needsClearBed || canStartPrint) && canEdit;
  const showProgress = isPrinting && printer.progress_pct != null;

  const [busy, setBusy] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmClearBed, setConfirmClearBed] = useState(false);
  const [menuPos, setMenuPos] = useState<QuickMenuPos | null>(null);

  // ── in-card live camera (reuses detail-page stream/snapshot endpoints) ──
  const isBambuCam = printer.kind === "bambu" && !!printer.bambu_dev_ip;
  const hasCamera = hasMoonraker || isBambuCam;
  const [camOpen, setCamOpen] = useState(false);
  const [camTick, setCamTick] = useState(0);
  const [camLoaded, setCamLoaded] = useState(false);
  const [camError, setCamError] = useState(false);
  useEffect(() => {
    if (!camOpen || isBambuCam || !hasCamera) return;
    const id = setInterval(() => { if (!document.hidden) setCamTick((n) => n + 1); }, 2500);
    return () => clearInterval(id);
  }, [camOpen, isBambuCam, hasCamera]);
  useEffect(() => { if (!isBambuCam) setCamLoaded(false); }, [camTick, isBambuCam]);
  const camSrc = isBambuCam
    ? `${API_URL}/api/printers/${printer.id}/camera/stream?token=${getToken()}`
    : `${API_URL}/api/printers/${printer.id}/webcam/snapshot?t=${camTick}&token=${getToken()}`;

  async function act(e: React.MouseEvent, action: string) {
    e.stopPropagation();
    if (busy) return;
    setConfirmCancel(false);
    setConfirmClearBed(false);
    setBusy(action);
    try {
      await api(`/api/printers/${printer.id}/print/${action}`, { method: "POST" });
      const list = await api<Printer[]>("/api/printers");
      const updated = list.find((p) => p.id === printer.id);
      if (updated) onUpdated?.(updated);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Помилка");
    } finally {
      setBusy(null);
    }
  }

  const toneClass = TONE_CLASS[tone];

  return (
    <div
      data-printer-id={printer.id}
      role="button"
      tabIndex={0}
      onClick={() => onClick?.(printer)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenuPos({ x: e.clientX, y: e.clientY });
      }}
      onKeyDown={(e) => e.key === "Enter" && onClick?.(printer)}
      className={["printer-card group cursor-pointer text-left", toneClass, tone === "muted" ? "opacity-60" : ""].join(" ")}
    >
      {/* Header */}
      <div className="pc-head">
        <div className="min-w-0 flex-1">
          <div className="pc-id truncate">{printer.name}</div>
          <div className="pc-model">{kindLabel(printer.kind)}</div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              setMenuPos((current) =>
                current ? null : { x: r.right - 248, y: r.bottom + 4 },
              );
            }}
            aria-label="Швидке меню"
            aria-haspopup="menu"
            aria-expanded={menuPos !== null}
            title="Швидке меню"
            className="grid size-7 shrink-0 place-items-center rounded text-[var(--text-muted)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)]"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
            </svg>
          </button>
          {hasCamera && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setCamError(false); setCamOpen((v) => !v); }}
              title="Камера"
              aria-label="Камера"
              aria-pressed={camOpen}
              className={[
                "grid size-7 shrink-0 place-items-center rounded transition",
                camOpen
                  ? "bg-[var(--accent)] text-white"
                  : "text-[var(--text-muted)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)]",
              ].join(" ")}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="m23 7-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/>
              </svg>
            </button>
          )}
          {onSettings && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onSettings(printer); }}
              title="Налаштування"
              className="rounded p-0.5 text-[var(--text-muted)] opacity-0 transition hover:text-[var(--text)] group-hover:opacity-100"
              tabIndex={-1}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 7h8.4"/><path d="M16.6 7H20"/><circle cx="14.5" cy="7" r="2.1"/>
                <path d="M4 17h3.4"/><path d="M11.6 17H20"/><circle cx="9.5" cy="17" r="2.1"/>
              </svg>
            </button>
          )}
          <StateIcon state={printer.state} size={14} />
        </div>
      </div>

      {/* State label */}
      <div className={["pc-status", toneClass].filter(Boolean).join(" ")}>
        {stateLabel(printer.state)}
      </div>

      {/* Error — compact single line */}
      {printer.error_msg && (
        <div className="truncate rounded px-1.5 py-0.5 text-xs bg-[rgba(239,68,68,.10)] text-[var(--state-error)]" title={printer.error_msg}>
          {printer.error_msg}
        </div>
      )}
      {printer.state === "error" && !printer.error_msg && (
        <div className="rounded px-1.5 py-0.5 text-xs bg-[rgba(239,68,68,.10)] text-[var(--state-error)]">
          Невідома помилка
        </div>
      )}

      {/* Slot strip — all printer kinds; falls back to loaded_filaments dots for Bambu */}
      {printer.slots && printer.slots.length > 0 ? (
        <SlotStrip
          slots={printer.slots}
          kind={printer.kind}
          editable={canEdit}
          printerId={printer.id}
          onSlotUpdated={(updated) =>
            onUpdated?.({
              ...printer,
              slots: (printer.slots ?? []).map((s) =>
                s.slot_index === updated.slot_index ? updated : s
              ),
            })
          }
        />
      ) : printer.kind !== "snapmaker_u1" && printer.loaded_filaments?.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {printer.loaded_filaments.map((s, i) => {
            const hex = s.color.startsWith("#") ? s.color.slice(0, 7) : s.color;
            return (
              <span
                key={i}
                title={`#${i + 1} ${s.color_name ?? s.type}${s.brand ? ` · ${s.brand}` : ""}`}
                className="size-3 rounded-full ring-1 ring-[var(--border-strong)]"
                style={{ backgroundColor: hex }}
              />
            );
          })}
        </div>
      ) : null}

      {/* Out of order */}
      {printer.is_out_of_order && (
        <div className="rounded px-1.5 py-0.5 text-xs bg-[rgba(239,68,68,.10)] text-[var(--state-error)]">
          ⛔ Не працює
        </div>
      )}

      {/* Tags — label + add + chips (colour tags filled, like the reference) */}
      {printer.tags?.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-faint)]">
            Теги
          </span>
          {canEdit && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                const r = e.currentTarget.getBoundingClientRect();
                setMenuPos((cur) => (cur ? null : { x: r.right - 248, y: r.bottom + 4 }));
              }}
              title="Додати тег"
              aria-label="Додати тег"
              className="grid size-4 place-items-center rounded-full border border-dashed border-[var(--border-strong)] text-[12px] leading-none text-[var(--text-faint)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              +
            </button>
          )}
          {printer.tags.map((tag) =>
            tag.color ? (
              <span
                key={tag.id}
                className="rounded-full px-2 py-0.5 text-[11px] font-medium text-white"
                style={{ backgroundColor: tag.color }}
              >
                {tag.display || tag.label}
              </span>
            ) : (
              <span
                key={tag.id}
                className="rounded-full border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[11px] text-[var(--text-muted)]"
              >
                {tag.display || tag.label}
              </span>
            ),
          )}
        </div>
      )}

      {/* Flags */}
      {printer.flags?.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {printer.flags.map((f) => (
            <span
              key={f}
              className="rounded px-1 py-0.5 text-xs bg-[rgba(245,158,11,.10)] text-[var(--state-warn)]"
            >
              {flagLabel(f)}
            </span>
          ))}
        </div>
      )}

      {/* Job + ETA */}
      {(printer.job || eta) && (
        <div className="border-t border-[var(--border)] pt-1.5">
          {printer.job && <div className="pc-file truncate">{printer.job}</div>}
          {eta && <div className="pc-eta">{eta} залишилось</div>}
        </div>
      )}

      {/* Temps */}
      {(printer.extruder_temp != null || printer.bed_temp != null) && (
        <div className="pc-temps flex gap-2">
          {printer.extruder_temp != null && (
            <span title="Сопло">
              {Math.round(printer.extruder_temp)}°
              {printer.extruder_target ? `→${Math.round(printer.extruder_target)}°` : ""}
            </span>
          )}
          {printer.bed_temp != null && (
            <span title="Стіл">
              {Math.round(printer.bed_temp)}°
              {printer.bed_target ? `→${Math.round(printer.bed_target)}°` : ""}
            </span>
          )}
        </div>
      )}

      {/* Progress bar */}
      {showProgress && (
        <div>
          <div className="progress">
            <div
              className="progress-fill transition-[width] duration-1000 ease-linear"
              style={{ width: `${printer.progress_pct}%` }}
            />
          </div>
          <div className="pc-prog-meta">
            <span className="pct">{Math.round(printer.progress_pct ?? 0)}%</span>
            {eta && <span className="eta">{eta}</span>}
          </div>
        </div>
      )}

      {/* Action strip */}
      {isActionable && (
        <div className="border-t border-[var(--border)] pt-1.5">
          <div className="pc-actions flex-wrap">
            {canStartPrint && onPrint && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onPrint(printer); }}
                className="btn btn-primary btn-sm flex-1"
              >
                ▶ Друк
              </button>
            )}
            {(needsClearBed || isError) && (
              confirmClearBed ? (
                <>
                  <button
                    type="button"
                    onClick={(e) => act(e, "clear-bed")}
                    disabled={busy !== null}
                    className="btn btn-sm flex-1 border-[rgba(34,197,94,.20)] bg-[rgba(34,197,94,.08)] text-[var(--state-ok)] hover:bg-[rgba(34,197,94,.15)] disabled:opacity-40"
                  >
                    {busy === "clear-bed" ? "…" : "Очистити"}
                  </button>
                  {printer.last_gcode_file_id && (
                    <button
                      type="button"
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (busy) return;
                        setBusy("reprint");
                        setConfirmClearBed(false);
                        try {
                          await api(`/api/files/${printer.last_gcode_file_id}/send/${printer.id}`, {
                            method: "POST",
                            body: JSON.stringify({ slot_map: {} }),
                          });
                          const list = await api<Printer[]>("/api/printers");
                          const updated = list.find((p) => p.id === printer.id);
                          if (updated) onUpdated?.(updated);
                        } catch (err) {
                          toast.error(err instanceof ApiError ? err.message : "Помилка");
                        } finally {
                          setBusy(null);
                        }
                      }}
                      disabled={busy !== null}
                      className="btn btn-primary btn-sm flex-1 disabled:opacity-40"
                    >
                      {busy === "reprint" ? "…" : "↺ Ріпрінт"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setConfirmClearBed(false); }}
                    className="btn btn-sm disabled:opacity-40"
                  >
                    Ні
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setConfirmClearBed(true); }}
                  disabled={busy !== null}
                  className="btn btn-sm flex-1 border-[rgba(34,197,94,.20)] bg-[rgba(34,197,94,.08)] text-[var(--state-ok)] hover:bg-[rgba(34,197,94,.15)] disabled:opacity-40"
                >
                  Очистити стіл
                </button>
              )
            )}
            {isPrinting && (
              <button
                type="button"
                onClick={(e) => act(e, "pause")}
                disabled={busy !== null}
                className="btn btn-warn btn-sm flex-1 disabled:opacity-40"
              >
                {busy === "pause" ? "…" : "Пауза"}
              </button>
            )}
            {isPaused && (
              <button
                type="button"
                onClick={(e) => act(e, "resume")}
                disabled={busy !== null}
                className="btn btn-primary btn-sm flex-1 disabled:opacity-40"
              >
                {busy === "resume" ? "…" : "▶ Продовж."}
              </button>
            )}
            {isError && (
              <button
                type="button"
                onClick={(e) => act(e, "clear-error")}
                disabled={busy !== null}
                className="btn btn-warn btn-sm flex-1 disabled:opacity-40"
              >
                {busy === "clear-error" ? "…" : "Скинути"}
              </button>
            )}
            {(isPrinting || isPaused || isError) && (
              confirmCancel ? (
                <>
                  <button
                    type="button"
                    onClick={(e) => act(e, "cancel")}
                    disabled={busy !== null}
                    className="btn btn-danger btn-sm flex-1 disabled:opacity-40"
                  >
                    {busy === "cancel" ? "…" : "Підтвердити"}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setConfirmCancel(false); }}
                    className="btn btn-sm disabled:opacity-40"
                  >
                    Ні
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setConfirmCancel(true); }}
                  disabled={busy !== null}
                  className="btn btn-danger btn-sm flex-1 disabled:opacity-40"
                >
                  Стоп
                </button>
              )
            )}
            {isPrinting && hasMoonraker && (
              <button
                type="button"
                onClick={(e) => act(e, "skip-object")}
                disabled={busy !== null}
                title="Пропустити об'єкт ([exclude_object] в printer.cfg)"
                className="btn btn-sm text-[var(--text-muted)] disabled:opacity-40"
              >
                {busy === "skip-object" ? "…" : "Скіп"}
              </button>
            )}
          </div>
        </div>
      )}

      {/* In-card camera overlay */}
      {camOpen && (
        <div className="cam-view" onClick={(e) => e.stopPropagation()}>
          <div className="cam-feed">
            {!camError && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={camSrc}
                alt=""
                onLoad={() => setCamLoaded(true)}
                onError={() => setCamError(true)}
                style={{
                  position: "absolute", inset: 0, width: "100%", height: "100%",
                  objectFit: "cover", opacity: camLoaded ? 1 : 0, transition: "opacity .3s",
                }}
              />
            )}
            {(!camLoaded || camError) && (
              <span className="glyph">
                <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/>
                </svg>
              </span>
            )}
            {camLoaded && !camError && (
              <span className="cam-live"><span className="dot" />LIVE</span>
            )}
            {(printer.extruder_temp != null || printer.bed_temp != null) && (
              <span className="cam-temps">
                {printer.extruder_temp != null && `🔥 ${Math.round(printer.extruder_temp)}°`}
                {printer.extruder_temp != null && printer.bed_temp != null && " · "}
                {printer.bed_temp != null && `🛏 ${Math.round(printer.bed_temp)}°`}
              </span>
            )}
          </div>
          <div className="cam-bar">
            <button type="button" className="cam-btn" title="Назад" onClick={() => setCamOpen(false)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
            </button>
            {isPrinting && (
              <button type="button" className="cam-btn" title="Пауза" disabled={busy !== null} onClick={(e) => act(e, "pause")}>
                <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
              </button>
            )}
            {isPaused && (
              <button type="button" className="cam-btn" title="Продовжити" disabled={busy !== null} onClick={(e) => act(e, "resume")}>
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              </button>
            )}
            {(isPrinting || isPaused) && (
              <button type="button" className="cam-btn" title="Стоп" disabled={busy !== null} onClick={(e) => act(e, "cancel")}>
                <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Quick menu (⋯ button or right-click) — rendered via portal */}
      {menuPos && (
        <PrinterQuickMenu
          printer={printer}
          pos={menuPos}
          onClose={() => setMenuPos(null)}
          onUpdated={onUpdated}
          onDeleted={onDeleted}
          onOpenSettings={onSettings}
          onOpenInfo={onClick}
        />
      )}
    </div>
  );
}
