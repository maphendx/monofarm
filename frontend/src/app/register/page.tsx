"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { ApiError, api, getToken, setToken } from "@/lib/api";

interface TokenResponse {
  access_token: string;
  token_type: string;
}

export default function RegisterPage() {
  const router = useRouter();
  const [orgName, setOrgName] = useState("");
  const [adminName, setAdminName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (getToken()) router.replace("/dashboard");
  }, [router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const data = await api<TokenResponse>("/api/orgs/register", {
        method: "POST",
        body: JSON.stringify({
          org_name: orgName,
          admin_name: adminName,
          admin_email: email,
          admin_password: password,
        }),
      });
      setToken(data.access_token);
      router.replace("/onboarding");
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError("Не вдалося з'єднатися з сервером");
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100";

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm space-y-5 rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
      >
        <div className="flex items-center gap-3">
          <svg width="36" height="28" viewBox="0 0 112 88" aria-hidden="true">
            <rect x="24" y="0"  width="24" height="8"  className="fill-neutral-900 dark:fill-neutral-100"/>
            <rect x="64" y="0"  width="24" height="8"  className="fill-neutral-900 dark:fill-neutral-100"/>
            <rect x="16" y="8"  width="80" height="16" className="fill-neutral-900 dark:fill-neutral-100"/>
            <rect x="0"  y="24" width="112" height="16" className="fill-neutral-900 dark:fill-neutral-100"/>
            <rect x="16" y="40" width="80" height="8"  className="fill-neutral-900 dark:fill-neutral-100"/>
            <rect x="16" y="48" width="80" height="8"  className="fill-neutral-900 dark:fill-neutral-100"/>
            <rect x="32" y="48" width="16" height="8"  className="fill-white dark:fill-neutral-950"/>
            <rect x="64" y="48" width="16" height="8"  className="fill-white dark:fill-neutral-950"/>
            <rect x="16" y="56" width="80" height="8"  className="fill-neutral-900 dark:fill-neutral-100"/>
            <rect x="32" y="56" width="16" height="8"  className="fill-white dark:fill-neutral-950"/>
            <rect x="64" y="56" width="16" height="8"  className="fill-white dark:fill-neutral-950"/>
            <rect x="16" y="64" width="80" height="8"  className="fill-neutral-900 dark:fill-neutral-100"/>
            <rect x="32" y="72" width="16" height="16" className="fill-neutral-900 dark:fill-neutral-100"/>
            <rect x="64" y="72" width="16" height="16" className="fill-neutral-900 dark:fill-neutral-100"/>
          </svg>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">monofarm</h1>
            <p className="text-xs text-neutral-500">Реєстрація нової ферми</p>
          </div>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-sm">Назва ферми</span>
            <input
              type="text"
              required
              minLength={2}
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="My 3D Farm"
              className={inputCls}
              autoFocus
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm">Ваше ім&apos;я</span>
            <input
              type="text"
              required
              value={adminName}
              onChange={(e) => setAdminName(e.target.value)}
              placeholder="Iван Іваненко"
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm">Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputCls}
              autoComplete="email"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm">Пароль</span>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputCls}
              autoComplete="new-password"
            />
            <span className="mt-1 block text-xs text-neutral-400">Мінімум 8 символів</span>
          </label>
        </div>

        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          {busy ? "Реєстрація…" : "Зареєструватись"}
        </button>

        <p className="text-center text-sm text-neutral-500">
          Вже є акаунт?{" "}
          <Link href="/login" className="underline hover:text-neutral-900 dark:hover:text-neutral-100">
            Увійти
          </Link>
        </p>
      </form>
    </div>
  );
}
