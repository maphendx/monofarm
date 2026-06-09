"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { setToken } from "@/lib/api";

function WebviewAuthInner() {
  const searchParams = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    const token = searchParams.get("token");
    const next = searchParams.get("next") ?? "/files";

    if (token) {
      setToken(token);
    }

    router.replace(next);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

export default function WebviewAuthPage() {
  return (
    <div className="flex h-screen items-center justify-center bg-[var(--bg)] text-[var(--text-muted)] text-sm">
      Завантаження…
      <Suspense>
        <WebviewAuthInner />
      </Suspense>
    </div>
  );
}
