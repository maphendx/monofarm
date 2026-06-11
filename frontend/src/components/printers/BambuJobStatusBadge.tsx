import type { BambuCloudJobStatus } from "@/lib/types";

// Product-language labels: transport states (queued/uploading/task_creating…)
// stay technical in the API for diagnostics/retry, but the user sees calm
// progress wording — a send never looks like it's parked in a foreign queue.
const STATUS_LABEL: Record<BambuCloudJobStatus, string> = {
  queued: "Відправляється",
  validating: "Перевірка файлу",
  creating_project: "Підготовка проєкту",
  uploading: "Завантаження на принтер",
  task_creating: "Запуск друку",
  task_created: "Очікує принтер",
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
