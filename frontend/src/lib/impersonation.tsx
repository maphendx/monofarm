"use client";

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";

import {
  clearStoredImpersonation,
  getStoredImpersonation,
  setStoredImpersonation,
  subscribeToImpersonation,
  type ImpersonationState,
} from "@/lib/impersonation-store";

interface ImpersonationContextValue {
  state: ImpersonationState | null;
  setImpersonation: (state: ImpersonationState) => void;
  clearImpersonation: () => void;
}

const ImpersonationContext = createContext<ImpersonationContextValue | null>(null);

export function ImpersonationProvider({ children }: { children: React.ReactNode }) {
  const state = useSyncExternalStore(subscribeToImpersonation, getStoredImpersonation, () => null);

  const setImpersonation = useCallback((next: ImpersonationState) => {
    setStoredImpersonation(next);
  }, []);

  const clearImpersonation = useCallback(() => {
    clearStoredImpersonation();
  }, []);

  const value = useMemo(
    () => ({ state, setImpersonation, clearImpersonation }),
    [clearImpersonation, setImpersonation, state],
  );

  return <ImpersonationContext.Provider value={value}>{children}</ImpersonationContext.Provider>;
}

export function useImpersonation() {
  const value = useContext(ImpersonationContext);
  if (!value) throw new Error("useImpersonation must be used inside ImpersonationProvider");
  return value;
}
