"use client";

import { ErrorScreen } from "@/components/ui/ErrorScreen";
import "./globals.css";

// Catches crashes in the root layout itself — must render its own <html>/<body>.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="uk" className="dark">
      <body>
        <ErrorScreen error={error} reset={reset} />
      </body>
    </html>
  );
}
