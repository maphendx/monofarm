const STORAGE_KEY = "monofarm_impersonation";
const CHANGE_EVENT = "monofarm:impersonation";

export interface ImpersonationState {
  organizationId: number;
  organizationName: string;
  organizationSlug: string;
}

function emitChange() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }
}

export function getStoredImpersonation(): ImpersonationState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ImpersonationState>;
    if (!parsed.organizationId || !parsed.organizationName || !parsed.organizationSlug) return null;
    return {
      organizationId: parsed.organizationId,
      organizationName: parsed.organizationName,
      organizationSlug: parsed.organizationSlug,
    };
  } catch {
    return null;
  }
}

export function setStoredImpersonation(state: ImpersonationState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  emitChange();
}

export function clearStoredImpersonation() {
  localStorage.removeItem(STORAGE_KEY);
  emitChange();
}

export function getActiveImpersonationOrgId(): string | null {
  return getStoredImpersonation()?.organizationId.toString() ?? null;
}

export function subscribeToImpersonation(callback: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}
