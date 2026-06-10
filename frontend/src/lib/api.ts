import { clearStoredImpersonation, getActiveImpersonationOrgId } from "@/lib/impersonation-store";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const TOKEN_KEY = "monofarm_token";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  clearStoredImpersonation();
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken();
  const headers = new Headers(options.headers);
  // Don't set Content-Type for FormData — browser sets it with the multipart boundary
  if (!headers.has("Content-Type") && options.body && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const impersonatedOrgId = getActiveImpersonationOrgId();
  if (impersonatedOrgId && !path.startsWith("/api/admin") && !path.startsWith("/api/auth")) {
    headers.set("X-Impersonated-Org-Id", impersonatedOrgId);
  }
  const resp = await fetch(`${API_URL}${path}`, { ...options, headers });
  if (!resp.ok) {
    let detail = resp.statusText;
    try {
      const data = await resp.json();
      detail = data.detail ?? detail;
    } catch {
      /* ignore */
    }
    if (resp.status === 401) clearToken();
    throw new ApiError(resp.status, detail);
  }
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

// ── Calendar / Schedule helpers ───────────────────────────────────────────────

import type { CalendarLane, PlanEntry } from "@/lib/types";

export async function getPlanCalendar(start: string, end: string): Promise<CalendarLane[]> {
  return api<CalendarLane[]>(`/api/plan/calendar?start=${start}&end=${end}`);
}

export async function createPlanEntry(payload: {
  plan_date: string;
  printer_id: number;
  task_id: number;
  start_time?: string | null;
  schedule_mode?: string;
  window_start_at?: string | null;
  window_end_at?: string | null;
  priority?: number;
  note?: string | null;
}): Promise<PlanEntry> {
  return api<PlanEntry>("/api/plan", { method: "POST", body: JSON.stringify(payload) });
}

export async function updatePlanEntry(
  id: number,
  patch: Partial<{
    start_time: string | null;
    schedule_mode: string;
    window_start_at: string | null;
    window_end_at: string | null;
    priority: number;
    blocked_reason: string | null;
    done: boolean;
    note: string | null;
  }>,
): Promise<PlanEntry> {
  return api<PlanEntry>(`/api/plan/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export async function deletePlanEntry(id: number): Promise<void> {
  return api<void>(`/api/plan/${id}`, { method: "DELETE" });
}
