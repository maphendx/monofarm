"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  WAREHOUSE_NOTICE_CHANGED_EVENT,
  type WarehouseNotice,
} from "@/components/warehouse/WarehouseNoticeOverlay";
import { api } from "@/lib/api";
import { useUser } from "@/lib/auth-context";

export default function WarehouseOpsConsolePage() {
  const user = useUser();
  const [text, setText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);
  const saveSeqRef = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    loadedRef.current = false;
    try {
      const notice = await api<WarehouseNotice>("/api/warehouse/notice");
      setText(notice.text);
      setSavedText(notice.text);
      setUpdatedAt(notice.updated_at);
    } catch {
      setError("Не вдалося завантажити повідомлення.");
    } finally {
      loadedRef.current = true;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const save = useCallback(async (nextText: string) => {
    const seq = ++saveSeqRef.current;
    setSaving(true);
    setError(null);
    try {
      const notice = await api<WarehouseNotice>("/api/warehouse/notice", {
        method: "PUT",
        body: JSON.stringify({ text: nextText }),
      });
      if (seq !== saveSeqRef.current) return;
      setSavedText(notice.text);
      setUpdatedAt(notice.updated_at);
      window.dispatchEvent(
        new CustomEvent(WAREHOUSE_NOTICE_CHANGED_EVENT, { detail: notice }),
      );
    } catch {
      if (seq !== saveSeqRef.current) return;
      setError("Не вдалося зберегти. Перевір права адміністратора.");
    } finally {
      if (seq === saveSeqRef.current) setSaving(false);
    }
  }, []);

  function handleTextChange(nextText: string) {
    setText(nextText);
    const trimmed = nextText.trim();
    window.dispatchEvent(
      new CustomEvent<WarehouseNotice>(WAREHOUSE_NOTICE_CHANGED_EVENT, {
        detail: {
          text: trimmed,
          updated_at: updatedAt,
          expires_at: null,
          active: trimmed.length > 0,
        },
      }),
    );
  }

  useEffect(() => {
    if (!loadedRef.current) return;
    if (text.trim() === savedText) return;
    const timer = window.setTimeout(() => {
      void save(text);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [save, savedText, text]);

  const changed = text.trim() !== savedText;
  const status = loading
    ? "Завантаження..."
    : saving
      ? "Синхронізується..."
      : changed
        ? "Очікує синхронізації..."
        : text.trim()
          ? "Показується"
          : "Вимкнено";

  if (user.role !== "admin") {
    return (
      <div className="mx-auto max-w-xl rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-6">
        <h1 className="text-lg font-semibold text-[var(--text)]">Доступ закрито</h1>
        <p className="mt-2 text-sm text-[var(--text-muted)]">Ця сторінка доступна тільки адміністратору.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--text)]">Службове повідомлення складу</h1>
      </div>

      <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-5 shadow-sm">
        <label className="mb-2 block text-sm font-medium text-[var(--text-muted)]" htmlFor="warehouse-notice">
          Текст поверх складу
        </label>
        <textarea
          id="warehouse-notice"
          value={text}
          onChange={(event) => handleTextChange(event.target.value)}
          disabled={loading}
          rows={8}
          maxLength={2000}
          className="w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm leading-6 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)] disabled:opacity-60"
          placeholder="Повідомлення..."
        />

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-[var(--text-muted)]">
            {status}
            {updatedAt && (
              <>
                <span className="mx-2">·</span>
                {new Date(updatedAt).toLocaleString("uk-UA")}
              </>
            )}
            <span className="mx-2">·</span>
            {text.length}/2000
          </div>
        </div>

        {error && <p className="mt-3 text-sm text-[var(--state-error)]">{error}</p>}
      </div>
    </div>
  );
}
