"use client";

// Thin wrapper around the View Transitions API. Returns false when the API is
// unavailable or the user prefers reduced motion — callers then fall back to a
// plain state update (existing CSS fades still apply).
type DocWithVT = Document & {
  startViewTransition?: (update: () => void | Promise<void>) => { finished: Promise<void> };
};

export function startViewTransition(update: () => void | Promise<void>): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  const doc = document as DocWithVT;
  if (!doc.startViewTransition) return false;
  const vt = doc.startViewTransition(update);
  // A skipped/aborted transition (e.g. DOM-update timeout) must not surface as
  // an unhandled rejection — falling back to the plain render is fine.
  vt.updateCallbackDone.catch(() => {});
  vt.finished.catch(() => {});
  return true;
}
