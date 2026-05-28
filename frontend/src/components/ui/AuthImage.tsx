"use client";

import { useEffect, useRef, useState } from "react";
import { API_URL, getToken } from "@/lib/api";

type Props = {
  src: string;           // presigned URL (https://) or API path (/api/...)
  alt?: string;
  className?: string;
  fallback?: React.ReactNode;
};

/**
 * Renders an authenticated image with lazy loading:
 * - Absolute URL (S3 presigned): <img loading="lazy"> — browser handles caching/multiplexing.
 * - API path (local storage): IntersectionObserver defers the Bearer-auth fetch
 *   until the element is ~200px from the viewport, then converts to a blob URL.
 */
export function AuthImage({ src, alt = "", className, fallback }: Props) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error,   setError]   = useState(false);
  const [visible, setVisible] = useState(false);
  const prevBlob    = useRef<string | null>(null);
  const placeholderRef = useRef<HTMLDivElement>(null);

  const isAbsolute = src.startsWith("http");

  // Observe placeholder until it enters the viewport (API-path only).
  useEffect(() => {
    if (isAbsolute) return;
    const el = placeholderRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [isAbsolute, src]); // re-observe if src changes while not yet visible

  // Fetch when visible (API-path only).
  useEffect(() => {
    if (isAbsolute || !visible) return;
    let alive = true;
    setError(false);
    setBlobUrl(null);

    fetch(API_URL + src, {
      headers: { Authorization: `Bearer ${getToken() ?? ""}` },
    })
      .then((r) => {
        if (!r.ok) throw new Error("not ok");
        return r.blob();
      })
      .then((blob) => {
        if (!alive) return;
        const url = URL.createObjectURL(blob);
        if (prevBlob.current) URL.revokeObjectURL(prevBlob.current);
        prevBlob.current = url;
        setBlobUrl(url);
      })
      .catch(() => { if (alive) setError(true); });

    return () => { alive = false; };
  }, [src, isAbsolute, visible]);

  // Revoke blob URL on unmount.
  useEffect(() => () => { if (prevBlob.current) URL.revokeObjectURL(prevBlob.current); }, []);

  if (error) return <>{fallback ?? null}</>;

  // S3 presigned URL — let the browser handle lazy loading natively.
  if (isAbsolute) {
    return <img src={src} alt={alt} className={className} loading="lazy" decoding="async" />;
  }

  // API path — show animated placeholder until blob is ready.
  if (!blobUrl) {
    return (
      <div
        ref={placeholderRef}
        className={`${className ?? ""} animate-pulse bg-[var(--surface-hi)]`}
      />
    );
  }

  return <img src={blobUrl} alt={alt} className={className} decoding="async" />;
}
