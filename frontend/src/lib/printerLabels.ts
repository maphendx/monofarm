import type { Printer } from "@/lib/types";

const STATE_LABEL: Record<string, string> = {
  printing: "друкує",
  pausing: "призупиняється…",
  resuming: "відновлюється…",
  cancelling: "скасовується…",
  operational: "готовий",
  print_pending: "очікує друку",
  online: "онлайн",
  awaiting_bed_clear: "очистити стіл",
  paused: "на паузі",
  in_maintenance: "обслуговування",
  not_connected: "не під'єднаний",
  offline: "офлайн",
  unknown: "невідомо",
  idle: "вільний",
  error: "помилка",
};

const FLAG_LABEL: Record<string, string> = {
  requires_attention: "Потребує уваги",
  ai_running: "AI спостерігає",
  ai_detected_low: "Можлива помилка",
  ai_detected_high: "Висока ймовірність помилки",
};

const KIND_LABEL: Record<string, string> = {
  snapmaker_u1: "Snapmaker U1",
  bambu: "Bambu Lab",
  other: "Інший",
};

export function stateLabel(s: string | null | undefined): string {
  if (!s) return "—";
  return STATE_LABEL[s] ?? s;
}

export function flagLabel(flag: string): string {
  return FLAG_LABEL[flag] ?? flag;
}

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

export type PrinterTone = "printing" | "ok" | "warn" | "bad" | "idle" | "muted";

export function printerTone(p: Printer): PrinterTone {
  if (!p.is_active) return "muted";
  const flags = p.flags ?? [];
  if (flags.includes("requires_attention") || flags.includes("ai_detected_high")) return "bad";
  if (flags.includes("ai_detected_low")) return "warn";
  switch (p.state) {
    case "printing":
    case "pausing":
    case "resuming":
    case "cancelling":
      return "printing";
    case "operational":
    case "online":
    case "print_pending":
      return "ok";
    case "awaiting_bed_clear":
    case "in_maintenance":
      return "warn";
    case "paused":
    case "error":
      return "bad";
    case "offline":
    case "not_connected":
      return "muted";
    case "idle":
      return "idle";
    default:
      return "idle";
  }
}

