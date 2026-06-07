import type { BambuCloudJobStatus } from "@/lib/types";

const STATUS_LABEL: Record<BambuCloudJobStatus, string> = {
  queued: "У черзі",
  validating: "Перевірка",
  creating_project: "Створення проєкту",
  uploading: "Завантаження",
  task_creating: "Створення завдання",
  task_created: "Завдання створено",
  acknowledged: "Прийнято принтером",
  printing: "Друкується",
  paused: "Пауза",
  completed: "Завершено",
  failed: "Помилка",
  cancelled: "Скасовано",
  lost: "Втрачено",
};

const STATUS_CLS: Record<BambuCloudJobStatus, string> = {
  queued: "badge badge-neutral",
  validating: "badge badge-accent",
  creating_project: "badge badge-accent",
  uploading: "badge badge-accent",
  task_creating: "badge badge-accent",
  task_created: "badge badge-accent",
  acknowledged: "badge badge-print",
  printing: "badge badge-print",
  paused: "badge badge-warn",
  completed: "badge badge-ok",
  failed: "badge badge-error",
  cancelled: "badge badge-offline",
  lost: "badge badge-error",
};

export function bambuJobStatusLabel(status: BambuCloudJobStatus): string {
  return STATUS_LABEL[status] ?? status;
}

export function BambuJobStatusBadge({ status, className = "" }: { status: BambuCloudJobStatus; className?: string }) {
  return (
    <span className={`${STATUS_CLS[status] ?? "badge badge-neutral"} ${className}`}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}
