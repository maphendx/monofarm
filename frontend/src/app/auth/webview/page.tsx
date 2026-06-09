"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * Landing page for OrcaSlicer's Device tab webview after file upload.
 * Saves the short-lived JWT from ?token= into localStorage, then
 * redirects to ?next= (typically /files?highlight={id}).
 *
 * This page is intentionally outside the (app) auth group so the auth
 * guard doesn't intercept the request before the token is stored.
 */
export default function WebviewAuthPage() {
  const searchParams = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    const token = searchParams.get("token");
    const next = searchParams.get("next") ?? "/files";

    if (token) {
      localStorage.setItem("access_token", token);
    }

    router.replace(next);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-screen items-center justify-center bg-[var(--bg)] text-[var(--text-muted)] text-sm">
      Завантаження…
    </div>
  );
}
