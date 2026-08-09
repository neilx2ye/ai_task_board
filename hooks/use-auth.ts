"use client";

import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";

import { useSupabase } from "@/hooks/use-supabase";

export type AuthState =
  | { status: "loading"; session: null }
  | { status: "anonymous"; session: null }
  | { status: "authenticated"; session: Session };

/** 浏览器端登录状态。未配置 Supabase 时保持 loading，由外层渲染未配置提示。 */
export function useAuth(): AuthState & { signOut: () => Promise<void> } {
  const supabase = useSupabase();
  const [state, setState] = useState<AuthState>({
    status: "loading",
    session: null,
  });

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (cancelled) return;
        setState(
          data.session
            ? { status: "authenticated", session: data.session }
            : { status: "anonymous", session: null },
        );
      })
      .catch(() => {
        if (!cancelled) setState({ status: "anonymous", session: null });
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setState(
        session
          ? { status: "authenticated", session }
          : { status: "anonymous", session: null },
      );
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [supabase]);

  const signOut = useCallback(async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
  }, [supabase]);

  return { ...state, signOut };
}
