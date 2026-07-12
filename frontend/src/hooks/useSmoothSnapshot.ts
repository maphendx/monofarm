"use client";

import { useEffect, useRef, useState } from "react";

type SmoothSnapshotState = {
  frameSrc: string | null;
  loading: boolean;
  error: boolean;
};

/** Poll a JPEG endpoint without replacing the visible frame until the next one is ready. */
export function useSmoothSnapshot(src: string | null, intervalMs = 1800): SmoothSnapshotState {
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(src));
  const [error, setError] = useState(false);
  const hasFrameRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let sequence = 0;

    hasFrameRef.current = false;
    setFrameSrc(null);
    setLoading(Boolean(src));
    setError(false);

    if (!src) return () => {};

    const schedule = () => {
      timer = setTimeout(load, intervalMs);
    };

    const load = () => {
      if (disposed) return;
      if (document.hidden) {
        schedule();
        return;
      }
      if (inFlight) {
        schedule();
        return;
      }

      inFlight = true;
      const separator = src.includes("?") ? "&" : "?";
      const frameUrl = `${src}${separator}t=${Date.now()}-${sequence++}`;
      const image = new Image();
      image.onload = () => {
        inFlight = false;
        if (disposed) return;
        hasFrameRef.current = true;
        setFrameSrc(frameUrl);
        setLoading(false);
        setError(false);
        schedule();
      };
      image.onerror = () => {
        inFlight = false;
        if (disposed) return;
        setLoading(false);
        if (!hasFrameRef.current) setError(true);
        schedule();
      };
      image.src = frameUrl;
    };

    load();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [intervalMs, src]);

  return { frameSrc, loading, error };
}
