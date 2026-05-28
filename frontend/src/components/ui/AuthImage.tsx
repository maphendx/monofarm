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
 * Renders an authenticated image.
 * - If src is an absolute URL (S3 presigned): renders <img> directly.
 * - If src is an API path (local storage): fetches with Bearer token → blob URL.
 *
 * This component is storage-agnostic — switching backends requires no UI changes.
 */
export function AuthImage({ src, alt = "", className, fallback }: Props) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError]     = useState(false);
  const prevBlob              = useRef<string | null>(null);

  const isAbsolute = src.startsWith("http");

  useEffect(() => {
    if (isAbsolute) return;
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
  }, [src, isAbsolute]);

  useEffect(() => () => { if (prevBlob.current) URL.revokeObjectURL(prevBlob.current); }, []);

  if (error) return <>{fallback ?? null}</>;

  const imgSrc = isAbsolute ? src : (blobUrl ?? null);
  if (!imgSrc) return <>{fallback ?? <div className={`${className ?? ""} animate-pulse bg-[var(--surface-hi)]`} />}</>;

  return <img src={imgSrc} alt={alt} className={className} />;
}
