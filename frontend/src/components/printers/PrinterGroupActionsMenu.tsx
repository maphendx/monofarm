"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Bot,
  Infinity as InfinityIcon,
  MoreHorizontal,
  Play,
  RotateCcw,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { ApiError, api } from "@/lib/api";
import { isA1Mini } from "@/lib/printerCapabilities";
import type { Printer } from "@/lib/types";

type GroupAction =
  | "mark_out_of_order"
  | "restore_service"
  | "create_maintenance"
  | "enable_autoprint"
  | "disable_autoprint";

interface GroupActionResult {
  action: GroupAction;
  group_id: number;
  group_name: string;
  affected: number;
  skipped: {
    printer_id: number;
    printer_name: string;
    reason: string;
  }[];
  task_id: number | null;
  message: string;
}

interface MenuPosition {
  left: number;
  top: number;
  compact: boolean;
}

function ActionItem({
  icon,
  label,
  detail,
  tone = "default",
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  detail: string;
  tone?: "default" | "danger" | "accent";
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={[
        "group flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
        disabled
          ? "cursor-not-allowed opacity-45"
          : "hover:bg-[var(--surface-hi)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]",
      ].join(" ")}
    >
      <span
        className={[
          "mt-0.5 grid size-7 shrink-0 place-items-center rounded-md",
          tone === "danger"
            ? "bg-[rgba(239,68,68,.10)] text-[var(--state-error)]"
            : tone === "accent"
              ? "bg-[var(--accent-soft)] text-[var(--accent)]"
              : "bg-[var(--surface-2)] text-[var(--text-muted)]",
        ].join(" ")}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-[var(--text-hi)]">{label}</span>
        <span className="mt-0.5 block text-xs leading-snug text-[var(--text-faint)]">{detail}</span>
      </span>
    </button>
  );
}

export function PrinterGroupActionsMenu({
  groupId,
  groupName,
  printers,
  onChanged,
}: {
  groupId: number;
  groupName: string;
  printers: Printer[];
  onChanged: () => void;
}) {
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const [confirmAction, setConfirmAction] = useState<Exclude<GroupAction, "create_maintenance"> | null>(null);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const [maintenanceTitle, setMaintenanceTitle] = useState(`Обслуговування: ${groupName}`);
  const [maintenanceDescription, setMaintenanceDescription] = useState("");
  const [maintenanceDeadline, setMaintenanceDeadline] = useState("");
  const [autoPrintOpen, setAutoPrintOpen] = useState(false);
  const [platesLoaded, setPlatesLoaded] = useState(1);
  const [cooldownTemp, setCooldownTemp] = useState(40);
  const [delaySeconds, setDelaySeconds] = useState(0);
  const [ejectLastPlate, setEjectLastPlate] = useState(true);
  const [busy, setBusy] = useState(false);

  const outOfOrderCount = printers.filter((printer) => printer.is_out_of_order).length;
  const autoPrintEligible = printers.filter(
    (printer) =>
      printer.kind === "bambu"
      && isA1Mini(printer.bambu_model, printer.bambu_dev_id),
  );
  const autoPrintActive = autoPrintEligible.filter(
    (printer) => printer.autoprint_mode !== "off",
  );
  const autoPrintInactiveCount = autoPrintEligible.length - autoPrintActive.length;

  useEffect(() => {
    if (!position) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPosition(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [position]);

  function openMenu(event: React.MouseEvent<HTMLButtonElement>) {
    if (position) {
      setPosition(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const compact = window.innerWidth < 640;
    setPosition({
      compact,
      left: compact ? 12 : Math.max(12, Math.min(rect.right - 340, window.innerWidth - 352)),
      top: compact ? 0 : Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - 520)),
    });
  }

  async function runAction(
    action: GroupAction,
    extra: Record<string, unknown> = {},
  ) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api<GroupActionResult>(
        `/api/printer-groups/${groupId}/actions`,
        {
          method: "POST",
          body: JSON.stringify({ action, ...extra }),
        },
      );
      const suffix = result.skipped.length > 0
        ? ` · пропущено ${result.skipped.length}`
        : "";
      if (result.skipped.length > 0) toast.warning(`${result.message}${suffix}`);
      else toast.success(result.message);
      setPosition(null);
      setConfirmAction(null);
      setMaintenanceOpen(false);
      setAutoPrintOpen(false);
      onChanged();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Не вдалося виконати групову дію");
    } finally {
      setBusy(false);
    }
  }

  function submitMaintenance() {
    const title = maintenanceTitle.trim();
    if (!title) return;
    void runAction("create_maintenance", {
      title,
      description: maintenanceDescription.trim() || null,
      deadline: maintenanceDeadline || null,
    });
  }

  function submitAutoPrint() {
    void runAction("enable_autoprint", {
      plates_loaded: platesLoaded,
      cooldown_temp_c: cooldownTemp,
      delay_seconds: delaySeconds,
      eject_last_plate: ejectLastPlate,
    });
  }

  const confirmOptions = confirmAction === "mark_out_of_order"
    ? {
        title: `Позначити групу «${groupName}» як несправну?`,
        message: `${printers.length - outOfOrderCount} принтерів перестануть приймати нові завдання та AutoPrint.`,
        confirmLabel: "Позначити всі",
        variant: "warn" as const,
      }
    : confirmAction === "restore_service"
      ? {
          title: `Повернути групу «${groupName}» в роботу?`,
          message: `${outOfOrderCount} принтерів знову зможуть приймати завдання.`,
          confirmLabel: "Повернути в роботу",
          variant: "default" as const,
        }
      : confirmAction === "disable_autoprint"
        ? {
            title: `Вимкнути AutoPrint для «${groupName}»?`,
            message: `AutoPrint буде вимкнено на ${autoPrintActive.length} принтерах. Поточний друк не зупиниться.`,
            confirmLabel: "Вимкнути AutoPrint",
            variant: "warn" as const,
          }
        : null;

  return (
    <>
      <button
        type="button"
        title="Дії групи"
        aria-label={`Дії групи ${groupName}`}
        aria-haspopup="menu"
        aria-expanded={position !== null}
        onClick={openMenu}
        className={[
          "grid size-7 place-items-center rounded-md border transition-colors",
          position
            ? "border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text-hi)]"
            : "border-transparent text-[var(--text-muted)] hover:border-[var(--border)] hover:bg-[var(--surface-hi)] hover:text-[var(--text-hi)]",
        ].join(" ")}
      >
        <MoreHorizontal size={16} />
      </button>

      {position && createPortal(
        <>
          <div
            className="fixed inset-0 z-40 bg-black/10"
            onClick={() => setPosition(null)}
          />
          <div
            role="menu"
            data-testid="printer-group-actions"
            className={[
              "fixed z-50 overflow-y-auto rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-2 shadow-lg",
              position.compact ? "bottom-3 max-h-[calc(100vh-24px)]" : "max-h-[calc(100vh-24px)]",
            ].join(" ")}
            style={position.compact
              ? { left: 12, right: 12 }
              : { left: position.left, top: position.top, width: 340 }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="px-3 pb-2 pt-1">
              <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--text-faint)]">
                Дії для групи
              </p>
              <div className="mt-1 flex items-center justify-between gap-3">
                <p className="truncate text-sm font-semibold text-[var(--text-hi)]">{groupName}</p>
                <span className="shrink-0 rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[11px] text-[var(--text-muted)]">
                  {printers.length} принт.
                </span>
              </div>
            </div>

            {outOfOrderCount < printers.length && (
              <ActionItem
                icon={<AlertTriangle size={16} />}
                label={outOfOrderCount > 0 ? "Позначити решту як несправні" : "Позначити всі як несправні"}
                detail={`${printers.length - outOfOrderCount} принтерів буде зупинено для нових завдань`}
                tone="danger"
                onClick={() => setConfirmAction("mark_out_of_order")}
              />
            )}
            {outOfOrderCount > 0 && (
              <ActionItem
                icon={<RotateCcw size={16} />}
                label="Повернути всі в роботу"
                detail={`${outOfOrderCount} принтерів зараз позначені несправними`}
                onClick={() => setConfirmAction("restore_service")}
              />
            )}
            <ActionItem
              icon={<Wrench size={16} />}
              label="Створити обслуговування"
              detail={`Одне завдання для всіх ${printers.length} принтерів групи`}
              onClick={() => {
                setPosition(null);
                setMaintenanceOpen(true);
              }}
            />
            <ActionItem
              icon={<Play size={16} />}
              label="Почати заплановане ТО"
              detail="Потрібна привʼязка графіка ТО до груп принтерів"
              disabled
            />

            <div className="my-1.5 border-t border-[var(--border)]" />

            <ActionItem
              icon={<Bot size={16} />}
              label="Увімкнути AI для всіх"
              detail="AI failure-detection engine ще не підключений"
              disabled
            />
            {autoPrintInactiveCount > 0 && (
              <ActionItem
                icon={<InfinityIcon size={17} />}
                label="Увімкнути AutoPrint"
                detail={`${autoPrintInactiveCount} сумісних A1 Mini · ${printers.length - autoPrintEligible.length} буде пропущено`}
                tone="accent"
                onClick={() => {
                  setPosition(null);
                  setAutoPrintOpen(true);
                }}
              />
            )}
            {autoPrintActive.length > 0 && (
              <ActionItem
                icon={<InfinityIcon size={17} />}
                label="Вимкнути AutoPrint"
                detail={`${autoPrintActive.length} принтерів зараз працюють у PlateCycler mode`}
                onClick={() => setConfirmAction("disable_autoprint")}
              />
            )}
            {autoPrintEligible.length === 0 && (
              <ActionItem
                icon={<InfinityIcon size={17} />}
                label="Увімкнути AutoPrint"
                detail="У групі немає сумісних Bambu A1 Mini"
                disabled
              />
            )}
          </div>
        </>,
        document.body,
      )}

      <ConfirmDialog
        open={confirmOptions !== null}
        opts={confirmOptions ?? { message: "" }}
        onConfirm={() => {
          if (confirmAction) void runAction(confirmAction);
        }}
        onCancel={() => setConfirmAction(null)}
      />

      <Modal
        open={maintenanceOpen}
        onClose={() => setMaintenanceOpen(false)}
        title={`Обслуговування · ${groupName}`}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setMaintenanceOpen(false)}>
              Скасувати
            </button>
            <button
              type="button"
              className="btn btn-primary disabled:opacity-50"
              disabled={busy || !maintenanceTitle.trim()}
              onClick={submitMaintenance}
            >
              {busy ? "Створюю…" : "Створити завдання"}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <label className="field">
            <span className="field-label">Назва</span>
            <input
              className="input w-full"
              value={maintenanceTitle}
              onChange={(event) => setMaintenanceTitle(event.target.value)}
              autoFocus
            />
          </label>
          <label className="field">
            <span className="field-label">Термін</span>
            <input
              type="date"
              className="input w-full"
              value={maintenanceDeadline}
              onChange={(event) => setMaintenanceDeadline(event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">Що потрібно зробити</span>
            <textarea
              className="textarea-field w-full"
              rows={4}
              value={maintenanceDescription}
              onChange={(event) => setMaintenanceDescription(event.target.value)}
              placeholder="Очищення, змащення, перевірка вузлів…"
            />
          </label>
          <p className="text-xs text-[var(--text-faint)]">
            У завдання автоматично потраплять назва групи та список її принтерів.
          </p>
        </div>
      </Modal>

      <Modal
        open={autoPrintOpen}
        onClose={() => setAutoPrintOpen(false)}
        title={`AutoPrint · ${groupName}`}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setAutoPrintOpen(false)}>
              Скасувати
            </button>
            <button
              type="button"
              className="btn btn-primary disabled:opacity-50"
              disabled={busy || autoPrintEligible.length === 0}
              onClick={submitAutoPrint}
            >
              {busy ? "Застосовую…" : `Увімкнути для ${autoPrintEligible.length}`}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--text-muted)]">
            <span className="font-semibold text-[var(--text-hi)]">{autoPrintEligible.length}</span> сумісних A1 Mini
            {printers.length > autoPrintEligible.length && (
              <> · {printers.length - autoPrintEligible.length} інших моделей буде пропущено</>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <label className="field">
              <span className="field-label">Столів</span>
              <input
                type="number"
                min={1}
                max={10}
                className="input w-full"
                value={platesLoaded}
                onChange={(event) => setPlatesLoaded(Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span className="field-label">Cooling, °C</span>
              <input
                type="number"
                min={20}
                max={80}
                className="input w-full"
                value={cooldownTemp}
                onChange={(event) => setCooldownTemp(Number(event.target.value))}
              />
            </label>
            <label className="field col-span-2 sm:col-span-1">
              <span className="field-label">Затримка, сек</span>
              <input
                type="number"
                min={0}
                max={3600}
                className="input w-full"
                value={delaySeconds}
                onChange={(event) => setDelaySeconds(Number(event.target.value))}
              />
            </label>
          </div>
          <label className="inline-flex items-center gap-2 text-sm text-[var(--text-muted)]">
            <input
              type="checkbox"
              checked={ejectLastPlate}
              onChange={(event) => setEjectLastPlate(event.target.checked)}
              className="size-4 accent-[var(--accent)]"
            />
            Виштовхувати останній стіл
          </label>
        </div>
      </Modal>
    </>
  );
}
