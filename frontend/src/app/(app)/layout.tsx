"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Topbar } from "@/components/Topbar";
import { ApiError, api, getToken } from "@/lib/api";
import { AuthProvider } from "@/lib/auth-context";
import type { User } from "@/lib/types";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
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
      <div className="flex flex-1 items-center justify-center text-sm text-neutral-500">
        Завантаження…
      </div>
    );
  }

  return (
    <AuthProvider user={user}>
      <Topbar user={user} />
      <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6">
        {children}
      </main>
    </AuthProvider>
  );
}
