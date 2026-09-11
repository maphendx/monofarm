import { clearStoredImpersonation, getActiveImpersonationOrgId } from "@/lib/impersonation-store";
import { clearPrintTransfers } from "@/lib/printTransferStore";

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
  if (localStorage.getItem(TOKEN_KEY) !== token) clearPrivateClientState();
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  clearPrivateClientState();
}

function clearPrivateClientState() {
  localStorage.removeItem("printers_cache");
  localStorage.removeItem("monofarm_dashboard_filters");
  clearPrintTransfers();
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

const API_PAGE_SIZE = 500;

/** Fetch every page from an offset-paginated list endpoint.
 *
 * Existing warehouse screens still need complete collections for kanban
 * grouping and client-side filters. Keeping the loop here lets each backend
 * request stay bounded while those screens migrate independently to
 * server-driven paging.
 */
export async function apiAll<T>(path: string, options: RequestInit = {}): Promise<T[]> {
  const items: T[] = [];

  for (let skip = 0; ; skip += API_PAGE_SIZE) {
    const url = new URL(path, "http://monofarm.local");
    url.searchParams.set("skip", String(skip));
    url.searchParams.set("limit", String(API_PAGE_SIZE));
    const page = await api<T[]>(`${url.pathname}${url.search}`, options);
    items.push(...page);
    if (page.length < API_PAGE_SIZE) return items;
  }
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
  runs_total?: number;
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
    plan_date: string | null;
    printer_id: number | null;
    runs_total: number;
  }>,
): Promise<PlanEntry> {
  return api<PlanEntry>(`/api/plan/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export async function deletePlanEntry(id: number): Promise<void> {
  return api<void>(`/api/plan/${id}`, { method: "DELETE" });
}
