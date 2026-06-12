"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { API_URL, getToken } from "@/lib/api";
import { getActiveImpersonationOrgId } from "@/lib/impersonation-store";
import type { Printer } from "@/lib/types";

const WS_URL = API_URL.replace(/^http/, "ws");

interface StreamState {
  printers: Printer[];
  connected: boolean;
  loading: boolean;
}

export function usePrinterStream(): StreamState & { reload: () => void } {
  const [printers, setPrinters] = useState<Printer[]>(() => {
    try {
      const cached = localStorage.getItem("printers_cache");
      return cached ? JSON.parse(cached) : [];
    } catch { return []; }
  });
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);

  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(1000);
  const mountedRef = useRef(true);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => {
    setReloadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    function connect() {
      if (!mountedRef.current) return;
      const token = getToken();
      if (!token) return;

      const params = new URLSearchParams({ token });
      const impersonatedOrgId = getActiveImpersonationOrgId();
      if (impersonatedOrgId) params.set("impersonated_org_id", impersonatedOrgId);

      const ws = new WebSocket(`${WS_URL}/ws/printers?${params.toString()}`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) { ws.close(); return; }
        retryDelayRef.current = 1000;
        setConnected(true);
      };

      ws.onmessage = (e) => {
        if (!mountedRef.current) return;
        try {
          const msg = JSON.parse(e.data as string);
          if (msg.type === "printers") {
            const data = msg.data as Printer[];
            setPrinters(data);
            setLoading(false);
            try { localStorage.setItem("printers_cache", JSON.stringify(data)); } catch {}
          }
        } catch { /* ignore malformed frames */ }
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        setConnected(false);
        // Exponential backoff, cap at 30 s
        const delay = retryDelayRef.current;
        retryDelayRef.current = Math.min(delay * 2, 30_000);
        retryRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => ws.close();
    }

    connect();

    return () => {
      mountedRef.current = false;
      wsRef.current?.close();
      wsRef.current = null;
      if (retryRef.current) clearTimeout(retryRef.current);
    };
  // reloadKey triggers a reconnect (e.g. after Bambu discover adds new printers)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  return { printers, connected, loading, reload };
}
