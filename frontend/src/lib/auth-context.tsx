"use client";

import { createContext, useContext } from "react";

import type { User } from "@/lib/types";

export const GUEST_USER: User = {
  id: 0,
  email: "",
  name: "",
  role: "operator",
  organization_id: null,
  org_plan: "free",
  is_platform_admin: false,
  created_at: "",
  email_verified_at: null,
  telegram_chat_id: null,
  allowed_modules: null,
};

interface AuthContextValue {
  user: User | null;
  ready: boolean;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  ready: false,
});

export function AuthProvider({
  user,
  ready = true,
  children,
}: {
  user: User | null;
  ready?: boolean;
  children: React.ReactNode;
}) {
  return (
    <AuthContext.Provider value={{ user, ready }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

export function useUser(): User {
  const { user } = useContext(AuthContext);
  return user ?? GUEST_USER;
}
