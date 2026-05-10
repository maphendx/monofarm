"use client";

import { useEffect, useState } from "react";

import { Modal } from "@/components/Modal";
import { ApiError, api } from "@/lib/api";
import type { AdminUser, TelegramLink } from "@/lib/types";

export function TelegramLinkModal({
  user,
  onClose,
}: {
  user: AdminUser | null;
  onClose: () => void;
}) {
  const [link, setLink] = useState<TelegramLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!user) {
      setLink(null);
      setError(null);
      setCopied(false);
      return;
    }
    setBusy(true);
    setError(null);
    api<TelegramLink>(`/api/users/${user.id}/telegram/link`, { method: "POST" })
      .then(setLink)
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : "Помилка"),
      )
      .finally(() => setBusy(false));
  }, [user]);

  function copy() {
    if (!link?.deep_link) return;
    navigator.clipboard.writeText(link.deep_link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Modal
      open={!!user}
      onClose={onClose}
      title={`Telegram-лінк для ${user?.email ?? ""}`}
    >
      <div className="space-y-3 text-sm">
        {busy && <div className="text-neutral-500">Генерую…</div>}
        {error && <div className="text-red-600 dark:text-red-400">{error}</div>}
        {link && link.deep_link && (
          <>
            <p className="text-neutral-600 dark:text-neutral-400">
              Надішли це посилання користувачу. Він відкриє його в Telegram, натисне
              <b> Start</b> — і його чат привʼяжеться до акаунта.
            </p>
            <div className="rounded-md border border-neutral-300 bg-neutral-50 p-3 dark:border-neutral-700 dark:bg-neutral-950">
              <div className="break-all text-xs">{link.deep_link}</div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={copy}
                className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900"
              >
                {copied ? "Скопійовано ✓" : "Скопіювати"}
              </button>
              <a
                href={link.deep_link}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md border border-neutral-200 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                Відкрити у Telegram
              </a>
            </div>
            <p className="text-xs text-neutral-400">
              Дійсне 24 години. Можеш згенерувати нове в будь-який момент.
            </p>
          </>
        )}
        {link && !link.deep_link && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
            Telegram-бот не запущено. Перевір TG_BOT_TOKEN у бекенді.
          </div>
        )}
      </div>
    </Modal>
  );
}
