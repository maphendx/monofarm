export type UserRole = "admin" | "operator" | "manager";

export type PrinterKind = "snapmaker_u1" | "bambu" | "other";

export type PrintTaskStatus = "queued" | "in_progress" | "done" | "cancelled";
export type FarmTaskStatus = "todo" | "in_progress" | "done";

export interface User {
  id: number;
  email: string;
  name: string;
  role: UserRole;
  created_at: string;
  telegram_chat_id: number | null;
}

export interface AdminUser extends User {
  is_active: boolean;
  created_at: string;
  telegram_chat_id: number | null;
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
  is_active: boolean;
  sort_order: number;
  group_id: number | null;
  group_name: string | null;
  loaded_filaments: FilamentSlot[];
  state: string | null;
  flags: string[];
  job: string | null;
  eta_minutes: number | null;
  updated_at: string | null;
  source: "moonraker" | "bambu" | "manual" | "unknown";
  progress_pct: number | null;
  extruder_temp: number | null;
  extruder_target: number | null;
  bed_temp: number | null;
  bed_target: number | null;
  current_filament_meta: FilamentMeta | null;
  error_msg: string | null;
  active_tray: number | null;
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
  file_name: string | null;
  file_size: number | null;
  filament_meta: FilamentMeta | null;
  filament_consumptions: { filament_id: number; grams: number }[] | null;
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
}

export interface GcodeFolder {
  id: number;
  name: string;
  file_count: number;
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
