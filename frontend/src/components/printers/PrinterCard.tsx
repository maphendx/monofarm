"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { PrinterQuickMenu, type QuickMenuPos } from "@/components/printers/PrinterQuickMenu";
import { SlotStrip } from "@/components/printers/SlotStrip";
import { API_URL, ApiError, api, getToken } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useUser } from "@/lib/auth-context";
import { flagLabel, kindLabel, stateLabel } from "@/lib/printerLabels";
import type { Printer } from "@/lib/types";
import {
  canSkipObject,
  formatEtaShort,
  formatFinishTime,
  getPrinterCardTone,
  printerCover,
} from "./printerCardModel";

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1.17 1.58V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15H4.5a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 6 9.4l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a2 2 0 0 1 3-1.43 2 2 0 0 1 1 1.43 1.65 1.65 0 0 0 1.17 1.17 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.58 1.17H21a2 2 0 0 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15Z" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="m23 7-7 5 7 5V7Z" />
      <rect x="1" y="5" width="15" height="14" rx="2" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
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
  const t = useT();
  const user = useUser();
  const tone = getPrinterCardTone(printer);
  const isPrinting = printer.state === "printing";
  const isPaused = printer.state === "paused";
  const isError = printer.state === "error";
  const needsClearBed = tone === "collect";
  const canStartPrint = (printer.state === "idle" || printer.state === "operational") && !needsClearBed && !printer.is_out_of_order;
  const canEdit = user.role === "admin" || user.role === "operator";
  const hasCamera = printer.kind === "bambu" && !!printer.bambu_dev_ip || !!printer.moonraker_url;
  const cover = printerCover(printer);
  const eta = printer.eta_minutes != null && printer.eta_minutes > 0 ? formatEtaShort(printer.eta_minutes) : null;
  const finish = printer.eta_minutes != null && printer.eta_minutes > 0 ? formatFinishTime(printer.eta_minutes) : null;
  const showProgress = (isPrinting || isPaused || needsClearBed) && printer.progress_pct != null;
  const isHeating = isPrinting && (printer.progress_pct ?? 0) <= 1 && printer.bed_target != null && printer.bed_temp != null && printer.bed_temp < printer.bed_target;
  const canSkip = canSkipObject(printer);
  const thumbnailSrc = printer.job && printer.last_gcode_file_id
    ? `${API_URL}/api/files/${printer.last_gcode_file_id}/thumbnail`
    : null;

  const [busy, setBusy] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmClearBed, setConfirmClearBed] = useState(false);
  const [menuPos, setMenuPos] = useState<QuickMenuPos | null>(null);
  const [camOpen, setCamOpen] = useState(false);
  const [camTick, setCamTick] = useState(0);
  const [camLoaded, setCamLoaded] = useState(false);
  const [camError, setCamError] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!camOpen || printer.kind === "bambu" || !hasCamera) return;
    const id = setInterval(() => {
      if (!document.hidden) setCamTick((n) => n + 1);
    }, 2500);
    return () => clearInterval(id);
  }, [camOpen, hasCamera, printer.kind]);

  const camSrc = printer.kind === "bambu"
    ? `${API_URL}/api/printers/${printer.id}/camera/stream?token=${getToken()}`
    : `${API_URL}/api/printers/${printer.id}/webcam/snapshot?t=${camTick}&token=${getToken()}`;

  async function act(e: React.MouseEvent, action: string) {
    e.stopPropagation();
    if (inFlight.current) return;
    setConfirmCancel(false);
    setConfirmClearBed(false);
    inFlight.current = true;
    setBusy(action);
    try {
      await api(`/api/printers/${printer.id}/print/${action}`, { method: "POST" });
      const list = await api<Printer[]>("/api/printers");
      const updated = list.find((p) => p.id === printer.id);
      if (updated) onUpdated?.(updated);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Помилка");
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  async function reprint(e: React.MouseEvent) {
    e.stopPropagation();
    if (inFlight.current || !printer.last_gcode_file_id) return;
    inFlight.current = true;
    setBusy("reprint");
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
      inFlight.current = false;
      setBusy(null);
    }
  }

  function openMenu(e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setMenuPos((current) => current ? null : { x: rect.right - 248, y: rect.bottom + 4 });
  }

  function toggleCamera(e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    setCamLoaded(false);
    setCamError(false);
    setCamOpen((open) => !open);
  }

  const statusText = needsClearBed
    ? t("printers.completed")
    : printer.state === "printing"
      ? t("printers.printing")
      : printer.state === "paused"
        ? t("printers.paused")
        : printer.state === "error" || tone === "error"
          ? t("printers.error")
          : printer.state === "offline" || printer.state === "not_connected"
            ? t("printers.offline")
          : ["operational", "online", "print_pending"].includes(printer.state ?? "")
              ? t("printers.operational")
              : printer.state === "idle"
                ? t("printers.idle")
              : stateLabel(printer.state).replace(/^./, (c) => c.toUpperCase());

  const statusLive = isPrinting;
  const filamentSlots = (printer.loaded_filaments ?? []).map((slot, index) => ({
        key: `loaded-${slot.slot}-${index}`,
        label: String(index + 1),
        color: slot.color?.startsWith("#") ? slot.color.slice(0, 7) : slot.color,
        empty: slot.empty,
        title: `${index + 1}: ${slot.color_name ?? slot.type}`,
      }));

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
      className={["printer-card", tone, camOpen ? "cam-open" : "", "group cursor-pointer text-left"].filter(Boolean).join(" ")}
    >
      <header className="pc-band">
        <div className="pc-band-id">
          <div className="pc-name" title={printer.name}>{printer.name}</div>
          <div className="pc-pill">
            <span className={["pc-pill-dot", statusLive ? "live" : ""].filter(Boolean).join(" ")} />
            {statusText}
          </div>
        </div>
        <div className="pc-tools">
          <button type="button" className="pc-tool" title="Швидке меню" aria-label="Швидке меню" onClick={openMenu}>
            <span aria-hidden="true">⋯</span>
          </button>
          {onSettings && (
            <button type="button" className="pc-tool" title="Налаштування" aria-label="Налаштування" onClick={(e) => { e.stopPropagation(); onSettings(printer); }}>
              <GearIcon />
            </button>
          )}
          {hasCamera && (
            <button type="button" className={["pc-tool", camOpen ? "active" : ""].filter(Boolean).join(" ")} title={t("common.camera")} aria-label={t("common.camera")} aria-pressed={camOpen} onClick={toggleCamera}>
              <CameraIcon />
            </button>
          )}
          <button type="button" className="pc-tool" title="Відкрити принтер" aria-label="Відкрити принтер" onClick={(e) => { e.stopPropagation(); onClick?.(printer); }}>
            <ExpandIcon />
          </button>
        </div>
      </header>

      <div className="pc-body">
        <div className="pc-overview">
          <div className="pc-cover" aria-hidden="true">
            {cover ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={cover} alt="" />
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                <path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6" />
                <rect x="6" y="18" width="12" height="4" rx="1" />
              </svg>
            )}
          </div>
          <div className="pc-overview-main">
            <div className="pc-model">{printer.bambu_model ?? kindLabel(printer.kind)}</div>
            <div className="pc-temps">
              {printer.extruder_temp != null && (
                <span title={t("printers.nozzle")}>
                  {t("printers.nozzle")} {Math.round(printer.extruder_temp)}°{printer.extruder_target ? `→${Math.round(printer.extruder_target)}°` : ""}
                </span>
              )}
              {printer.bed_temp != null && (
                <span title={t("printers.bed")}>
                  {t("printers.bed")} {Math.round(printer.bed_temp)}°{printer.bed_target ? `→${Math.round(printer.bed_target)}°` : ""}
                </span>
              )}
            </div>
          </div>
          <div className="pc-specs">
            {printer.bed_type && <span className="pc-chip">{printer.bed_type}</span>}
            {printer.nozzle_diameter != null && <span className="pc-chip">{printer.nozzle_diameter}</span>}
          </div>
        </div>

        {printer.slots?.length ? (
          <div className="pc-slots" aria-label={t("common.slots")}>
            <SlotStrip
              slots={printer.slots}
              kind={printer.kind}
              showLabels
              editable={canEdit}
              printerId={printer.id}
              onSlotUpdated={(updated) => onUpdated?.({
                ...printer,
                slots: printer.slots?.map((slot) => slot.slot_index === updated.slot_index ? updated : slot) ?? null,
              })}
            />
          </div>
        ) : filamentSlots.length > 0 ? (
          <div className="pc-slots" aria-label="Філаменти">
            {filamentSlots.map((slot) => (
              <span key={slot.key} className={["pc-slot", slot.empty ? "empty" : ""].filter(Boolean).join(" ")} title={slot.title}>
                <span className="pc-slot-dot" style={{ backgroundColor: slot.empty ? undefined : slot.color }} />
                <span>{slot.label}</span>
              </span>
            ))}
          </div>
        ) : null}

        {printer.error_msg && <div className="pc-error" title={printer.error_msg}>{printer.error_msg}</div>}
        {printer.is_out_of_order && <div className="pc-error">Не працює</div>}
        {printer.flags?.length > 0 && (
          <div className="pc-flags">
            {printer.flags.map((flag) => <span key={flag}>{flagLabel(flag)}</span>)}
          </div>
        )}

        {printer.job && (
          <div className="pc-file-row">
            {thumbnailSrc && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="pc-thumb" src={thumbnailSrc} alt="" />
            )}
            <span className="pc-file" title={printer.job}>{printer.job}</span>
          </div>
        )}

        {isHeating && (
          <div className="pc-substate"><span className="pc-substate-dot" />{t("printers.heatingBed")}</div>
        )}

        {showProgress && (
          <div>
            <div className="pc-progress"><div className="pc-progress-fill" style={{ width: `${Math.max(0, Math.min(100, printer.progress_pct ?? 0))}%` }} /></div>
            <div className="pc-progress-meta">
              <span className="pct">{Math.round(printer.progress_pct ?? 0)}%</span>
              <span className="eta">{needsClearBed ? t("printers.completed") : eta && finish ? `${eta} · ${finish}` : isPaused ? t("printers.paused") : ""}</span>
            </div>
          </div>
        )}

        <div className="pc-tags">
          <span className="pc-tags-label">{t("common.tags")}</span>
          {canEdit && (
            <button type="button" className="pc-tag-add" title={t("common.add")} aria-label={t("common.add")} onClick={openMenu}>+</button>
          )}
          {printer.tags?.map((tag) => (
            <span key={tag.id} className={["pc-tag", tag.color ? "color" : ""].filter(Boolean).join(" ")} style={tag.color ? { backgroundColor: tag.color } : undefined}>
              {tag.display || tag.label}
            </span>
          ))}
          {printer.bed_type && <span className="pc-tag">{printer.bed_type}</span>}
          {printer.nozzle_diameter != null && <span className="pc-tag">{printer.nozzle_diameter}</span>}
        </div>

        <footer className="pc-foot">
          <span className="pc-foot-meta">
            {printer.power_watts != null ? `${Math.round(printer.power_watts)} W` : printer.state === "offline" ? t("printers.offline") : ""}
          </span>
          {canEdit && <div className="pc-foot-actions" onClick={(e) => e.stopPropagation()}>
            {canStartPrint && onPrint && (
              <button type="button" className="pc-action start" onClick={(e) => { e.stopPropagation(); onPrint(printer); }}>
                <PlayIcon /> {t("common.print")}
              </button>
            )}
            {needsClearBed && (
              confirmClearBed ? (
                <>
                  <button type="button" className="pc-action collect" disabled={busy !== null} onClick={(e) => act(e, "clear-bed")}>{busy === "clear-bed" ? "…" : t("common.confirm")}</button>
                  {printer.last_gcode_file_id && <button type="button" className="pc-action start" disabled={busy !== null} onClick={reprint}>{busy === "reprint" ? "…" : t("printers.reprint")}</button>}
                  <button type="button" className="pc-action" disabled={busy !== null} onClick={() => setConfirmClearBed(false)}>{t("common.no")}</button>
                </>
              ) : (
                <button type="button" className="pc-action collect" disabled={busy !== null} onClick={(e) => { e.stopPropagation(); setConfirmClearBed(true); }}>
                  {t("printers.collectBed")}
                </button>
              )
            )}
            {isPrinting && (
              <button type="button" className="pc-action pause" disabled={busy !== null} onClick={(e) => act(e, "pause")}>
                <PauseIcon /> {busy === "pause" ? "…" : t("printers.pause")}
              </button>
            )}
            {isPaused && (
              <button type="button" className="pc-action start" disabled={busy !== null} onClick={(e) => act(e, "resume")}>
                <PlayIcon /> {busy === "resume" ? "…" : t("printers.resume")}
              </button>
            )}
            {isError && (
              <button type="button" className="pc-action reset" disabled={busy !== null} onClick={(e) => act(e, "clear-error")}>
                {busy === "clear-error" ? "…" : t("printers.resetError")}
              </button>
            )}
            {(isPrinting || isPaused || isError) && (
              confirmCancel ? (
                <>
                  <button type="button" className="pc-action stop" disabled={busy !== null} onClick={(e) => act(e, "cancel")}>{busy === "cancel" ? "…" : t("common.confirm")}</button>
                  <button type="button" className="pc-action" disabled={busy !== null} onClick={() => setConfirmCancel(false)}>{t("common.no")}</button>
                </>
              ) : (
                <button type="button" className="pc-action stop" disabled={busy !== null} onClick={(e) => { e.stopPropagation(); setConfirmCancel(true); }}>
                  <StopIcon /> {t("common.stop")}
                </button>
              )
            )}
            {canSkip && (
              <button type="button" className="pc-action skip" disabled={busy !== null} title={t("printers.skipObjectFull")} onClick={(e) => act(e, "skip-object")}>
                {busy === "skip-object" ? "…" : t("printers.skip")}
              </button>
            )}
          </div>}
        </footer>
      </div>

      {camOpen && (
        <div className="pc-camera" onClick={(e) => e.stopPropagation()}>
          <div className="pc-camera-feed">
            {!camError && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={camSrc} alt="" onLoad={() => setCamLoaded(true)} onError={() => setCamError(true)} />
            )}
            {(!camLoaded || camError) && <span className="pc-camera-placeholder"><CameraIcon /></span>}
            {camLoaded && !camError && <span className="pc-camera-live"><span className="pc-camera-live-dot" />LIVE</span>}
            {(printer.extruder_temp != null || printer.bed_temp != null) && (
              <span className="pc-camera-temps">
                {printer.extruder_temp != null && `🔥 ${Math.round(printer.extruder_temp)}°`}
                {printer.extruder_temp != null && printer.bed_temp != null && " · "}
                {printer.bed_temp != null && `🛏 ${Math.round(printer.bed_temp)}°`}
              </span>
            )}
          </div>
          <div className="pc-camera-controls">
            <button type="button" className="pc-camera-btn pc-camera-back" onClick={() => setCamOpen(false)}><BackIcon /> <span>{t("printers.backToStatus")}</span></button>
            {canEdit && isPrinting && <button type="button" className="pc-camera-btn" title={t("common.pause")} disabled={busy !== null} onClick={(e) => act(e, "pause")}><PauseIcon /></button>}
            {canEdit && isPaused && <button type="button" className="pc-camera-btn" title={t("common.resume")} disabled={busy !== null} onClick={(e) => act(e, "resume")}><PlayIcon /></button>}
            {canEdit && (isPrinting || isPaused) && <button type="button" className="pc-camera-btn stop" title={t("common.stop")} disabled={busy !== null} onClick={(e) => act(e, "cancel")}><StopIcon /></button>}
          </div>
        </div>
      )}

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
