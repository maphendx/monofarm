import type { Route } from "next";

/** Only allow app-local paths; never forward a supplied script or external URL to the router. */
export function safeInternalRedirect(value: string | null): Route {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) {
    return "/files";
  }
  return value as Route;
}
