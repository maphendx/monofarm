"use client";

import { useRef, useState } from "react";
import { ArrowLeft, Maximize, MoreHorizontal, Pause, Play, Settings, Square, Video } from "lucide-react";
import { toast } from "sonner";

import { PrinterQuickMenu, type QuickMenuPos } from "@/components/printers/PrinterQuickMenu";
import { SkipObjectsModal } from "@/components/printers/SkipObjectsModal";
import { SlotStrip } from "@/components/printers/SlotStrip";
import { API_URL, ApiError, api, getToken } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useUser } from "@/lib/auth-context";
import { flagLabel, kindLabel, stateLabel } from "@/lib/printerLabels";
import { normalizedPrinterSlots } from "@/lib/printerSlots";
import { useSmoothSnapshot } from "@/hooks/useSmoothSnapshot";
import type { Printer } from "@/lib/types";
import {
  canSkipObject,
  formatEtaShort,
  formatFinishTime,
  getPrinterCardTone,
  printerCover,
  printerCardUsesPersistentSlots,
  printerCanStartPrint,
  printerNeedsClearBed,
} from "./printerCardModel";

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
  const needsClearBed = printerNeedsClearBed(printer);
  const canStartPrint = printerCanStartPrint(printer);
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
  const [skipObjectsOpen, setSkipObjectsOpen] = useState(false);
  const [streamLoaded, setStreamLoaded] = useState(false);
  const [streamError, setStreamError] = useState(false);
  const inFlight = useRef(false);

  const camSrc = printer.kind === "bambu"
    ? `${API_URL}/api/printers/${printer.id}/camera/stream?token=${getToken()}`
    : `${API_URL}/api/printers/${printer.id}/webcam/snapshot?token=${getToken()}`;
  const snapshot = useSmoothSnapshot(
    camOpen && printer.kind !== "bambu" && hasCamera ? camSrc : null,
  );
  const camLoaded = printer.kind === "bambu" ? streamLoaded : snapshot.frameSrc !== null;
  const camError = printer.kind === "bambu" ? streamError : snapshot.error;

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
    setStreamLoaded(false);
    setStreamError(false);
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
  const filamentSlots = normalizedPrinterSlots(printer).map((slot) => ({
    key: `loaded-${slot.slot}`,
    label: slot.isExternal ? "EXT" : String(slot.slot + 1),
    color: slot.color?.startsWith("#") ? slot.color.slice(0, 7) : slot.color,
    empty: slot.empty,
    title: `${slot.isExternal ? "External" : slot.slot + 1}: ${slot.colorName ?? slot.material ?? ""}`,
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
            <MoreHorizontal size={15} strokeWidth={1.8} aria-hidden="true" />
          </button>
          {onSettings && (
            <button type="button" className="pc-tool" title="Налаштування" aria-label="Налаштування" onClick={(e) => { e.stopPropagation(); onSettings(printer); }}>
              <Settings size={15} strokeWidth={1.8} aria-hidden="true" />
            </button>
          )}
          {hasCamera && (
            <button type="button" className={["pc-tool", camOpen ? "active" : ""].filter(Boolean).join(" ")} title={t("common.camera")} aria-label={t("common.camera")} aria-pressed={camOpen} onClick={toggleCamera}>
              <Video size={15} strokeWidth={1.8} aria-hidden="true" />
            </button>
          )}
          <button type="button" className="pc-tool" title="Відкрити принтер" aria-label="Відкрити принтер" onClick={(e) => { e.stopPropagation(); onClick?.(printer); }}>
            <Maximize size={15} strokeWidth={1.8} aria-hidden="true" />
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

        {printerCardUsesPersistentSlots(printer) ? (
          <div className="pc-slots" aria-label={t("common.slots")}>
            <SlotStrip
              slots={printer.slots ?? []}
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
              <span key={slot.key} className={["pc-slot", slot.empty ? "is-empty" : ""].filter(Boolean).join(" ")} title={slot.title}>
                <span className={['pc-slot-dot', slot.empty ? 'is-empty' : ''].filter(Boolean).join(' ')} style={{ backgroundColor: slot.empty ? undefined : slot.color ?? undefined }} />
                <span>{slot.label}</span>
              </span>
            ))}
          </div>
        ) : null}

        {printer.error_msg && <div className="pc-error">{printer.error_msg}</div>}
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
            {(eta || finish) && (
              <span className="pc-file-eta">
                {eta && <strong>{eta}</strong>}
                {finish && <span>{finish}</span>}
              </span>
            )}
          </div>
        )}

        {isHeating && (
          <div className="pc-substate"><span className="pc-substate-dot" />{t("printers.heatingBed")}</div>
        )}

        {showProgress && (
          <div className="pc-progress-wrap">
            <div className="pc-progress">
              <div className="pc-progress-fill" style={{ width: `${Math.max(0, Math.min(100, printer.progress_pct ?? 0))}%` }} />
              <span className="pc-progress-label">{Math.round(printer.progress_pct ?? 0)}%</span>
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
                <Play size={14} strokeWidth={2} aria-hidden="true" /> {t("common.print")}
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
                <Pause size={14} strokeWidth={2} aria-hidden="true" /> {busy === "pause" ? "…" : t("printers.pause")}
              </button>
            )}
            {isPaused && (
              <button type="button" className="pc-action start" disabled={busy !== null} onClick={(e) => act(e, "resume")}>
                <Play size={14} strokeWidth={2} aria-hidden="true" /> {busy === "resume" ? "…" : t("printers.resume")}
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
                  <Square size={14} strokeWidth={2.5} fill="currentColor" aria-hidden="true" /> {t("common.stop")}
                </button>
              )
            )}
            {canSkip && (
              <button type="button" className="pc-action skip" disabled={busy !== null} title={t("printers.skipObjects.title")} onClick={(e) => { e.stopPropagation(); setSkipObjectsOpen(true); }}>
                {t("printers.skip")}
              </button>
            )}
          </div>}
        </footer>
      </div>

      {camOpen && (
        <div className="pc-camera" onClick={(e) => e.stopPropagation()}>
          <div className="pc-camera-feed">
            {printer.kind === "bambu" && !streamError && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={camSrc} alt="" onLoad={() => setStreamLoaded(true)} onError={() => setStreamError(true)} />
            )}
            {printer.kind !== "bambu" && snapshot.frameSrc && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={snapshot.frameSrc} alt="" />
            )}
            {(!camLoaded || camError) && <span className="pc-camera-placeholder"><Video size={34} strokeWidth={1.5} aria-hidden="true" /></span>}
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
            <button type="button" className="pc-camera-btn pc-camera-back" onClick={() => setCamOpen(false)}><ArrowLeft size={15} strokeWidth={1.8} aria-hidden="true" /> <span>{t("printers.backToStatus")}</span></button>
            {canEdit && isPrinting && <button type="button" className="pc-camera-btn" title={t("common.pause")} disabled={busy !== null} onClick={(e) => act(e, "pause")}><Pause size={15} strokeWidth={1.8} aria-hidden="true" /></button>}
            {canEdit && isPaused && <button type="button" className="pc-camera-btn" title={t("common.resume")} disabled={busy !== null} onClick={(e) => act(e, "resume")}><Play size={15} strokeWidth={1.8} aria-hidden="true" /></button>}
            {canEdit && (isPrinting || isPaused) && <button type="button" className="pc-camera-btn stop" title={t("common.stop")} disabled={busy !== null} onClick={(e) => act(e, "cancel")}><Square size={15} strokeWidth={2.5} fill="currentColor" aria-hidden="true" /></button>}
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
      {skipObjectsOpen && (
        <div onClick={(event) => event.stopPropagation()}>
          <SkipObjectsModal open printer={printer} onClose={() => setSkipObjectsOpen(false)} />
        </div>
      )}
    </div>
  );
}
