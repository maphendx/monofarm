export type UserRole = "admin" | "operator" | "manager";

export type PrinterKind = "simplyprint" | "snapmaker_u1" | "other";

export type PrintTaskStatus = "queued" | "in_progress" | "done" | "cancelled";
export type FarmTaskStatus = "todo" | "in_progress" | "done";

export interface User {
  id: number;
  email: string;
  name: string;
  role: UserRole;
}

export interface AdminUser extends User {
  is_active: boolean;
  created_at: string;
}

export interface Printer {
  id: number;
  name: string;
  kind: PrinterKind;
  sp_printer_id: string | null;
  is_active: boolean;
  state: string | null;
  flags: string[];
  job: string | null;
  eta_minutes: number | null;
  updated_at: string | null;
  source: "simplyprint" | "manual" | "unknown";
}

export interface PrintTask {
  id: number;
  title: string;
  quantity: number;
  filament_type: string | null;
  filament_color: string | null;
  estimated_minutes: number | null;
  deadline: string | null;
  notes: string | null;
  status: PrintTaskStatus;
  created_at: string;
}

export interface FarmTask {
  id: number;
  title: string;
  description: string | null;
  status: FarmTaskStatus;
  deadline: string | null;
  assignee_id: number | null;
  created_at: string;
}

export interface PlanEntry {
  id: number;
  plan_date: string;
  printer_id: number;
  printer_name: string;
  task_id: number;
  task: PrintTask;
  sequence: number;
  note: string | null;
  done: boolean;
  created_at: string;
}
