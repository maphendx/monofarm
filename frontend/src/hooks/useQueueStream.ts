"use client";

import { useEffect, useRef, useState } from "react";
import { API_URL, getToken } from "@/lib/api";
import { getActiveImpersonationOrgId } from "@/lib/impersonation-store";

const WS_URL = API_URL.replace(/^http/, "ws");

/**
 * Connects to /ws/org and listens for queue_update events.
 * Returns a version counter that increments on every queue mutation —
 * callers re-fetch their data when version changes.
 */
export function useQueueStream(): { version: number; event: string | null; taskId: number | null } {
  const [version, setVersion] = useState(0);
  const [event, setEvent] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<number | null>(null);

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

      const params = new URLSearchParams({ token });
      const impersonatedOrgId = getActiveImpersonationOrgId();
      if (impersonatedOrgId) params.set("impersonated_org_id", impersonatedOrgId);

      const ws = new WebSocket(`${WS_URL}/ws/org?${params.toString()}`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) { ws.close(); return; }
        retryDelayRef.current = 1000;
      };

      ws.onmessage = (e) => {
        if (!mountedRef.current) return;
        try {
          const msg = JSON.parse(e.data as string);
          if (msg.type === "queue_update") {
            setEvent(msg.event ?? null);
            setTaskId(msg.task_id ?? null);
            setVersion((v) => v + 1);
          }
        } catch { /* ignore */ }
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

  return { version, event, taskId };
}
