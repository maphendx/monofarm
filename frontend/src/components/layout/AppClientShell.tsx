"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Toaster } from "sonner";
import { DynamicFavicon } from "@/components/ui/DynamicFavicon";
import { SearchModal } from "@/components/ui/SearchModal";
import { ScannerModal } from "@/components/warehouse/ScannerModal";
import { PrintTransferStatus } from "@/components/files/PrintTransferStatus";
import { Sidebar, SidebarFallback } from "@/components/layout/Sidebar";
import { ApiError, api, getToken } from "@/lib/api";
import { AuthProvider } from "@/lib/auth-context";
import { getStoredImpersonation } from "@/lib/impersonation-store";
import type { User } from "@/lib/types";

export function AppClientShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();

  const [user,        setUser]        = useState<User | null>(null);
  const [ready,       setReady]       = useState(false);
  const [pinned,      setPinned]      = useState(false);
  const [searchOpen,  setSearchOpen]  = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [verifyDismissed, setVerifyDismissed] = useState(false);

  // Restore pinned state from localStorage after mount
  useEffect(() => {
    setPinned(localStorage.getItem("sidebar-pinned") === "true");
  }, []);

  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key === "monofarm_token" || event.key === null) {
        // Drop all in-memory data and connections when another tab changes the account.
        window.location.reload();
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // ⌘K / Ctrl+K — search  |  ⌘⇧S / Ctrl⇧S — scanner
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        setScannerOpen((v) => !v);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  function togglePin() {
    const next = !pinned;
    setPinned(next);
    localStorage.setItem("sidebar-pinned", String(next));
  }

  useEffect(() => {
    if (!getToken()) { router.replace("/login"); return; }
    api<User>("/api/auth/me")
      .then((u) => {
        if (u.is_platform_admin && !getStoredImpersonation()) {
          router.replace("/admin");
          return;
        }
        setUser(u);
        setReady(true);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) router.replace("/login");
        else setReady(true);
      });
  }, [router]);

  return (
    <AuthProvider user={user} ready={ready}>
      <DynamicFavicon />
      <div className="flex min-h-screen">
        <Suspense fallback={<SidebarFallback pinned={pinned} />}>
          <Sidebar
            user={user}
            pinned={pinned}
            onPinToggle={togglePin}
            onSearch={() => setSearchOpen(true)}
          />
        </Suspense>
        <main className={[
          "flex flex-col flex-1 min-w-0 transition-[padding-left] duration-200 ease-out",
          pinned ? "pl-[220px]" : "pl-14",
        ].join(" ")}>
          {user && !user.email_verified_at && !verifyDismissed && (
            <div className="flex items-center justify-between gap-3 border-b border-[var(--state-warn)]/30 bg-[var(--state-warn)]/10 px-6 py-2 text-sm text-[var(--state-warn)]">
              <span>Підтвердіть ваш email для повного доступу</span>
              <div className="flex shrink-0 items-center gap-3">
                <button
                  onClick={() => api("/api/auth/resend-verification", { method: "POST" })}
                  className="underline hover:no-underline"
                >
                  Надіслати знову
                </button>
                <button onClick={() => setVerifyDismissed(true)} className="opacity-60 hover:opacity-100">✕</button>
              </div>
            </div>
          )}
          <div className="flex-1 px-6 py-6">
            {children}
          </div>
        </main>
      </div>

      {searchOpen  && <SearchModal  onClose={() => setSearchOpen(false)} />}
      {scannerOpen && <ScannerModal onClose={() => setScannerOpen(false)} />}
      <PrintTransferStatus />
      <Toaster position="bottom-right" richColors closeButton />
    </AuthProvider>
  );
}
