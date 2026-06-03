"use client";

import { Eye, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { getAdminOrganizations, type AdminOrganization } from "@/lib/adminApi";
import { ApiError } from "@/lib/api";
import { useImpersonation } from "@/lib/impersonation";

function shortDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  }).format(new Date(value));
}

export default function AdminPage() {
  const router = useRouter();
  const { setImpersonation } = useImpersonation();

  const [organizations, setOrganizations] = useState<AdminOrganization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [plan, setPlan] = useState("all");

  useEffect(() => {
    let alive = true;

    getAdminOrganizations()
      .then((items) => {
        if (!alive) return;
        setOrganizations(items);
        setError(null);
      })
      .catch((err) => {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/login");
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to load organizations");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [router]);

  const plans = useMemo(() => {
    const values = new Set<string>();
    for (const org of organizations) {
      if (org.plan) values.add(org.plan);
    }
    return Array.from(values).sort();
  }, [organizations]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return organizations.filter((org) => {
      const matchesSearch = !needle
        || org.name.toLowerCase().includes(needle)
        || org.slug.toLowerCase().includes(needle);
      const matchesPlan = plan === "all" || org.plan === plan;
      return matchesSearch && matchesPlan;
    });
  }, [organizations, plan, search]);

  function viewAsOrg(org: AdminOrganization) {
    setImpersonation({
      organizationId: org.id,
      organizationName: org.name,
      organizationSlug: org.slug,
    });
    router.push("/dashboard");
  }

  return (
    <main className="min-h-screen px-6 py-6">
      <div className="mx-auto flex max-w-6xl flex-col gap-5">
        <header className="flex flex-col gap-1">
          <p className="font-mono text-xs font-semibold uppercase tracking-widest text-[var(--accent)]">
            Platform admin
          </p>
          <h1 className="text-2xl font-semibold text-[var(--text-hi)]">Organizations</h1>
        </header>

        <section className="flex flex-col gap-3 border-y border-[var(--border)] py-3 sm:flex-row sm:items-center sm:justify-between">
          <label className="relative max-w-md flex-1">
            <Search
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-faint)]"
              aria-hidden="true"
            />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name or slug"
              className="h-9 w-full rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--surface)] pl-9 pr-3 text-sm text-[var(--text-hi)] outline-none focus:border-[var(--border-focus)]"
            />
          </label>

          <select
            value={plan}
            onChange={(event) => setPlan(event.target.value)}
            className="h-9 rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text-hi)] outline-none focus:border-[var(--border-focus)]"
          >
            <option value="all">All plans</option>
            {plans.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </section>

        {error && (
          <div className="rounded-[var(--r-sm)] border border-[var(--state-error)]/30 bg-[var(--state-error)]/10 px-4 py-3 text-sm text-[var(--state-error)]">
            {error}
          </div>
        )}

        <div className="overflow-x-auto border border-[var(--border)] bg-[var(--surface)]">
          <table className="min-w-full border-collapse text-sm">
            <thead className="border-b border-[var(--border)] bg-[var(--surface-2)] text-left">
              <tr className="text-xs font-semibold uppercase tracking-wide text-[var(--text-faint)]">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Plan</th>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3">Last login</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {loading && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-[var(--text-muted)]">
                    Loading organizations...
                  </td>
                </tr>
              )}

              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-[var(--text-muted)]">
                    No organizations found
                  </td>
                </tr>
              )}

              {!loading && filtered.map((org) => (
                <tr key={org.id} className="hover:bg-[var(--surface-hi)]">
                  <td className="px-4 py-3">
                    <div className="font-medium text-[var(--text-hi)]">{org.name}</div>
                    <div className="font-mono text-xs text-[var(--text-faint)]">/{org.slug}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="badge badge-neutral">{org.plan ?? "none"}</span>
                  </td>
                  <td className="px-4 py-3 text-[var(--text-muted)]">{shortDate(org.created_at)}</td>
                  <td className="px-4 py-3 text-[var(--text-muted)]">{shortDate(org.last_login_at)}</td>
                  <td className="px-4 py-3 text-[var(--text-muted)]">{org.status}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => viewAsOrg(org)}
                      className="btn btn-secondary"
                    >
                      <Eye size={15} aria-hidden="true" />
                      View as org
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
