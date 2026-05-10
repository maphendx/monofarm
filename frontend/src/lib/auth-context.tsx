"use client";

import { createContext, useContext } from "react";

import type { User } from "@/lib/types";

const AuthContext = createContext<User | null>(null);

export function AuthProvider({
  user,
  children,
}: {
  user: User;
  children: React.ReactNode;
}) {
  return <AuthContext.Provider value={user}>{children}</AuthContext.Provider>;
}

export function useUser(): User {
  const user = useContext(AuthContext);
  if (!user) throw new Error("useUser must be used inside AuthProvider");
  return user;
}
