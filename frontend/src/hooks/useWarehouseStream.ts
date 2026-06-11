"use client";

import { useEffect, useRef, useState } from "react";
import { API_URL, getToken } from "@/lib/api";

const WS_URL = API_URL.replace(/^http/, "ws");

/**
 * Connects to /ws/org and returns a version counter that increments
 * whenever the backend broadcasts a warehouse mutation event.
 *
 * Usage:
 *   const { version } = useWarehouseStream();
 *   useEffect(() => { load(); }, [load, version]);
 */
export function useWarehouseStream(): { version: number; entity: string | null } {
  const [version, setVersion] = useState(0);
  const [entity, setEntity] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(1000);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    function connect() {
      if (!mountedRef.current) return;
      const token = getToken();
      if (!token) return;

      const ws = new WebSocket(`${WS_URL}/ws/org?token=${token}`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) { ws.close(); return; }
        retryDelayRef.current = 1000;
      };

      ws.onmessage = (e) => {
        if (!mountedRef.current) return;
        try {
          const msg = JSON.parse(e.data as string);
          if (msg.type === "warehouse_update") {
            setEntity(msg.entity ?? null);
            setVersion((v) => v + 1);
          }
        } catch { /* ignore malformed frames */ }
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
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
  }, []);

  return { version, entity };
}
