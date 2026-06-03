import { api } from "@/lib/api";

export interface AdminOrganization {
  id: number;
  name: string;
  slug: string;
  plan: string | null;
  status: string;
  created_at: string;
  last_login_at: string | null;
}

interface AdminOrganizationsResponse {
  items: Array<AdminOrganization & Record<string, unknown>>;
}

export async function getAdminOrganizations(): Promise<AdminOrganization[]> {
  const data = await api<AdminOrganizationsResponse>("/api/admin/orgs?limit=100");
  return data.items.map((org) => ({
    id: org.id,
    name: org.name,
    slug: org.slug,
    plan: org.plan,
    status: org.status,
    created_at: org.created_at,
    last_login_at: org.last_login_at,
  }));
}
