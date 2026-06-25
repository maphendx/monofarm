"use client";

import { useCallback, useEffect, useState } from "react";

import { API_URL, api, getToken } from "@/lib/api";

export const WAREHOUSE_NOTICE_CHANGED_EVENT = "warehouse-notice:changed";

export type WarehouseNotice = {
  text: string;
  updated_at: string | null;
  expires_at: string | null;
  active: boolean;
};

type WarehouseNoticeChangedEvent = CustomEvent<WarehouseNotice>;

export function WarehouseNoticeOverlay() {
  const [notice, setNotice] = useState<WarehouseNotice | null>(null);

  const load = useCallback(async () => {
    try {
      setNotice(await api<WarehouseNotice>("/api/warehouse/notice"));
    } catch {
      setNotice(null);
    }
  }, []);

  useEffect(() => {
    const refresh = (event?: Event) => {
      const notice = (event as WarehouseNoticeChangedEvent | undefined)?.detail;
      if (notice) {
        setNotice(notice);
        return;
      }
      void load();
    };
    const initialTimer = window.setTimeout(refresh, 0);

    window.addEventListener(WAREHOUSE_NOTICE_CHANGED_EVENT, refresh);
    const timer = window.setInterval(refresh, 5_000);

    return () => {
      window.clearTimeout(initialTimer);
      window.removeEventListener(WAREHOUSE_NOTICE_CHANGED_EVENT, refresh);
      window.clearInterval(timer);
    };
  }, [load]);

  useEffect(() => {
    const token = getToken();
    if (!token) return;

    const controller = new AbortController();
    let buffer = "";

    async function connect() {
      try {
        const response = await fetch(`${API_URL}/api/warehouse/notice/stream`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) return;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() ?? "";

          for (const chunk of chunks) {
            const dataLine = chunk
              .split("\n")
              .find((line) => line.startsWith("data: "));
            if (!dataLine || dataLine === "data: {}") continue;
            setNotice(JSON.parse(dataLine.slice(6)) as WarehouseNotice);
          }
        }
      } catch {
        if (!controller.signal.aborted) {
          window.setTimeout(() => void load(), 1_000);
        }
      }
    }

    const timer = window.setTimeout(() => {
      void connect();
    }, 0);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [load]);

  useEffect(() => {
    if (!notice?.expires_at) return;
    const ms = new Date(notice.expires_at).getTime() - Date.now();
    if (ms <= 0) {
      const timer = window.setTimeout(() => {
        setNotice((current) => current ? { ...current, text: "", active: false } : current);
      }, 0);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => {
      setNotice((current) => current ? { ...current, text: "", active: false } : current);
    }, ms);
    return () => window.clearTimeout(timer);
  }, [notice?.expires_at]);

  const text = notice?.text.trim();
  if (!notice?.active || !text) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-50 flex justify-center px-3">
      <div className="pointer-events-auto max-h-[42vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-amber-300/80 bg-amber-50 px-4 py-3 text-sm font-medium leading-6 text-amber-950 shadow-2xl shadow-black/20">
        <p className="whitespace-pre-wrap break-words">{text}</p>
      </div>
    </div>
  );
}
