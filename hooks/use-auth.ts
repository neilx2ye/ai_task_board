"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export type AuthState =
  | { status: "loading"; session: null }
  | { status: "anonymous"; session: null }
  | {
      status: "authenticated";
      session: { user: { id: string; email: string | null } };
    };

type SessionUserPayload = { id: string; email: string | null };

/** 浏览器端登录状态，来自本地 Cookie 会话。 */
export function useAuth(): AuthState & { signOut: () => Promise<void> } {
  const router = useRouter();
  const [state, setState] = useState<AuthState>({
    status: "loading",
    session: null,
  });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : { user: null }))
      .then((payload: { user: SessionUserPayload | null }) => {
        if (cancelled) return;
        setState(
          payload.user
            ? { status: "authenticated", session: { user: payload.user } }
            : { status: "anonymous", session: null },
        );
      })
      .catch(() => {
        if (!cancelled) setState({ status: "anonymous", session: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signOut = useCallback(async () => {
    await fetch("/api/auth/sign-out", { method: "POST" });
    router.replace("/login");
  }, [router]);

  return { ...state, signOut };
}
