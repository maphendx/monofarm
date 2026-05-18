"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Sidebar } from "@/components/Sidebar";
import { ApiError, api, getToken } from "@/lib/api";
import { AuthProvider } from "@/lib/auth-context";
import { useT } from "@/lib/i18n";
import type { User } from "@/lib/types";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const t = useT();
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    api<User>("/api/auth/me")
      .then((u) => {
        setUser(u);
        setReady(true);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/login");
        } else {
          setReady(true);
        }
      });
  }, [router]);

  if (!ready || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-neutral-500">
        {t("common.loading")}
      </div>
    );
  }

  return (
    <AuthProvider user={user}>
      <div className="flex min-h-screen">
        <Sidebar user={user} />
        {/* pl-14 = collapsed sidebar width; sidebar expands on hover over itself only */}
        <main className="flex-1 pl-14">
          <div className="mx-auto w-full max-w-[1400px] px-6 py-6">
            {children}
          </div>
        </main>
      </div>
    </AuthProvider>
  );
}
