export type UserRole = "admin" | "operator" | "manager";

export type OrgPlan = "free" | "starter" | "pro" | "farm";

export type PrinterKind = "snapmaker_u1" | "bambu" | "anycubic" | "other";

export type PrintTaskStatus = "queued" | "in_progress" | "done" | "cancelled";
export type FarmTaskStatus = "todo" | "in_progress" | "done";

export interface User {
  id: number;
  email: string;
  name: string;
  role: UserRole;
  organization_id: number | null;
  org_plan: OrgPlan | null;
  is_platform_admin: boolean;
  created_at: string;
  email_verified_at: string | null;
  telegram_chat_id: number | null;
  allowed_modules: string[] | null;
}

export interface AdminUser extends User {
  is_active: boolean;
  created_at: string;
  telegram_chat_id: number | null;
  allowed_modules: string[] | null;
  custom_role_id: number | null;
  custom_role_name: string | null;
}

export interface CustomRole {
  id: number;
  name: string;
  allowed_modules: string[];
  created_at: string;
}

export interface TelegramLink {
  code: string;
  bot_username: string | null;
  deep_link: string | null;
  expires_at: string;
}

export interface PrinterGroup {
  id: number;
  name: string;
  sort_order: number;
  printer_count: number;
  color: string | null;
  nozzle_diameter: number | null;
  build_x: number | null;
  build_y: number | null;
  build_z: number | null;
  supported_materials: string[];
}

export interface FilamentSlot {
  slot: number;
  color: string;
  color_name: string | null;
  type: string;
  brand: string | null;
  filament_id: number | null;
  empty: boolean;
  unit_id: number | null;
  /** Confirmed by the printer's own MQTT report — false means operator-declared only,
   *  not physically confirmed. Print dispatch must not target an unverified AMS slot. */
  verified?: boolean;
}

export type SlotState = "empty" | "loaded" | "loading" | "unloading" | "error" | "runout";

export interface PrinterSlotInfo {
  slot_index: number;
  filament_id: number | null;
  material: string | null;
  color: string | null;
  hex_color: string | null;
  brand: string | null;
  grams_at_load: number | null;
  state: SlotState;
  unit_index: number | null;
  is_external: boolean;
}

export interface FilamentColor {
  id: number;
  name: string;
  hex_color: string;
  sort_order: number;
}

export interface Printer {
  id: number;
  name: string;
  kind: PrinterKind;
  moonraker_url: string | null;
  bambu_dev_id: string | null;
  bambu_dev_ip: string | null;
  bambu_model: string | null;
  bambu_lan_mode: boolean;
  bambu_has_ams: boolean | null;
  anycubic_dev_ip: string | null;
  anycubic_model_name: string | null;
  is_active: boolean;
  is_out_of_order: boolean;
  sort_order: number;
  group_id: number | null;
  group_name: string | null;
  loaded_filaments: FilamentSlot[];
  state: string | null;
  state_stale: boolean;
  flags: string[];
  job: string | null;
  eta_minutes: number | null;
  updated_at: string | null;
  source: "moonraker" | "bambu" | "anycubic" | "manual" | "unknown";
  progress_pct: number | null;
  extruder_temp: number | null;
  extruder_target: number | null;
  bed_temp: number | null;
  bed_target: number | null;
  current_filament_meta: FilamentMeta | null;
  error_msg: string | null;
  active_tray: number | null;
  slots: PrinterSlotInfo[] | null;
  firmware_version: string | null;
  power_watts: number | null;
  firmware_features: Record<string, boolean | null> | null;
  build_x: number | null;
  build_y: number | null;
  build_z: number | null;
  nozzle_diameter: number | null;
  bed_type: string | null;
  last_gcode_file_id: number | null;
  autoprint_mode: string;
  autoprint_plates_remaining: number;
  autoprint_cooldown_temp_c: number;
  autoprint_delay_seconds: number;
  autoprint_eject_last_plate: boolean;
  autoprint_error: string | null;
  tags: { id: number; kind: string; label?: string | null; color?: string | null; meta?: Record<string, unknown> | null; display: string }[];
}

export interface AutoPrintQueueEntry {
  id: number;
  title: string;
  file_name: string | null;
  runs_total: number;
  runs_completed: number;
  active_run_index: number | null;
  is_active: boolean;
}

export interface AutoPrintStatus {
  enabled: boolean;
  plates_remaining: number;
  active_job_status: BambuCloudJobStatus | null;
  active_job_progress_pct: number | null;
  error: string | null;
  entries: AutoPrintQueueEntry[];
}

export interface FilamentMeta {
  types?: string[];
  colors?: string[];
  used_g?: number[];
  used_m?: number[];
  estimated_minutes?: number;
  total_layers?: number;
  layer_height?: number;
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
  started_at: string | null;
  completed_at: string | null;
  file_name: string | null;
  file_size: number | null;
  filament_meta: FilamentMeta | null;
  filament_consumptions: { filament_id: number; grams: number }[] | null;
  product_id: number | null;
  product_name: string | null;
  pieces_ok: number | null;
  pieces_defective: number | null;
  defect_reason: string | null;
  material_cost_uah: number | null;
  // Queue page fields
  gcode_file_id: number | null;
  has_thumbnail: boolean;
  created_by_name: string | null;
  printed_count: number;
  assigned_printer_id: number | null;
  assigned_printer_name: string | null;
  tags: { id: number; kind: string; label?: string | null; color?: string | null; meta?: Record<string, unknown> | null; display: string }[];
}

export interface Filament {
  id: number;
  sku: string | null;
  label_id: string | null;
  material: string;
  color: string;
  hex_color: string | null;
  brand: string | null;
  grams_remaining: number;
  min_grams: number;
  cost_per_kg: number | null;
  note: string | null;
  updated_at: string;
  is_low: boolean;
  warehouse_product_id: number | null;
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

export interface GcodeFileMeta {
  types?: string[];
  colors?: string[];
  used_g?: number[];
  estimated_minutes?: number;
  total_layers?: number;
  layer_height?: number;
  nozzle_diameter?: number;
  print_size_x?: number;
  print_size_y?: number;
  print_size_z?: number;
  printer_model?: string;
}

export interface GcodeFile {
  id: number;
  original_name: string;
  stored_name: string;
  size_bytes: number;
  notes: string | null;
  filament_meta: GcodeFileMeta | null;
  has_thumbnail: boolean;
  uploaded_at: string;
  uploaded_by_name: string | null;
  folder_id: number | null;
  tags: { id: number; kind: string; label?: string | null; color?: string | null; meta?: Record<string, unknown> | null; display: string }[];
}

export interface GcodeFolder {
  id: number;
  name: string;
  file_count: number;
  created_at: string;
}

export type ScheduleMode = "asap" | "not_before" | "exact_time" | "window";

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
  // Scheduling fields (Phase 2)
  start_time: string | null;       // "HH:MM:SS" or null (asap)
  end_time: string | null;         // computed by backend (capped at 23:59:59)
  schedule_mode: ScheduleMode;
  window_start_at: string | null;
  window_end_at: string | null;
  priority: number;
  blocked_reason: string | null;
  runs_total: number;
  runs_completed: number;
  conflict: boolean;
}

// Calendar view types — returned by GET /api/plan/calendar
export type CalendarEntry = PlanEntry;

export interface CalendarDay {
  printer_id: number;
  printer_name: string;
  plan_date: string;             // "YYYY-MM-DD"
  entries: CalendarEntry[];
}

export interface CalendarLane {
  printer_id: number;
  printer_name: string;
  printer_kind: string;          // "bambu" | "snapmaker_u1" | "other"
  group_id: number | null;
  group_name: string | null;
  group_color: string | null;
  days: CalendarDay[];
}

// ── Bambu Cloud V2 ────────────────────────────────────────────────────────────

export type BambuCloudJobStatus =
  | "queued"
  | "validating"
  | "creating_project"
  | "uploading"
  | "task_creating"
  | "task_created"
  | "acknowledged"
  | "printing"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "lost";

export interface BambuCloudJob {
  id: number;
  organization_id: number;
  printer_id: number;
  printer_name: string | null;
  printer_model: string | null;
  gcode_file_id: number | null;
  created_by_user_id: number | null;
  printer_bambu_dev_id: string | null;
  file_name: string | null;
  file_sha256: string | null;
  file_size: number | null;
  region: string | null;
  dispatch_mode: string;
  status: BambuCloudJobStatus;
  status_reason: string | null;
  correlation_id: string;
  idempotency_key: string;
  bambu_project_id: string | null;
  bambu_model_id: string | null;
  bambu_task_id: string | null;
  error_code: string | null;
  retry_count: number;
  progress_pct: number | null;
  eta_minutes: number | null;
  created_at: string;
  updated_at: string | null;
  uploaded_at: string | null;
  task_created_at: string | null;
  printer_ack_at: string | null;
  started_printing_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  last_mqtt_at: string | null;
  is_terminal: boolean;
  is_active: boolean;
  can_retry: boolean;
  error_message: string | null;
}


export interface BambuRetryResult {
  ok: boolean;
  job: BambuCloudJob;
  message: string;
}

export interface BambuQueuedResult {
  ok: boolean;
  printer_id: number | null;
  printer_name: string;
  dispatch_mode: string;
  message: string;
  job_id: number;
  status: BambuCloudJobStatus;
  correlation_id: string;
}

export interface BambuHealthAuth {
  configured: boolean;
  reauth_required: boolean;
  auth_type: string | null;
  last_success_at: string | null;
  last_error: string | null;
  access_token_expires_at: string | null;
  region: string | null;
}

export interface BambuHealthMqtt {
  connected: boolean;
  last_message_at: string | null;
  tracked_devices: string[];
}

export interface BambuHealthPrinters {
  total: number;
  bambu_cloud: number;
  online: number;
  offline: number;
}

export interface BambuHealthJobs {
  active: number;
  stuck_or_lost: number;
  recent_failures: number;
  queued: number;
}

export interface BambuHealthOut {
  auth: BambuHealthAuth;
  mqtt: BambuHealthMqtt;
  printers: BambuHealthPrinters;
  jobs: BambuHealthJobs;
}

export interface PrintHistoryPause {
  at: string;
  resumed_at: string | null;
  duration_sec: number | null;
}

export interface PrintHistoryItem {
  id: number;
  printer_id: number;
  printer_name: string;
  printer_kind: string | null;
  file_name: string | null;
  started_at: string;
  finished_at: string | null;
  duration_minutes: number | null;
  result: string;
  result_reason: string | null;
  filament_g: number | null;
  material_cost: number | null;
  pauses: PrintHistoryPause[] | null;
  slots_used: { slot?: number; type?: string; color?: string; color_hex?: string; grams?: number }[] | null;
  source: string | null;
}
