"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, clearToken, getToken } from "./api";
import type { SessionUser } from "./types";

interface SessionState {
  user: SessionUser | null;
  loading: boolean;
}

/**
 * Client-side session guard. Reads the stored token, confirms it against
 * `/auth/me`, and bounces to /login when there's no valid session. Returns the
 * resolved user once known.
 */
export function useSession(): SessionState {
  const router = useRouter();
  const [state, setState] = useState<SessionState>({ user: null, loading: true });

  useEffect(() => {
    let active = true;
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    api
      .me()
      .then((user) => {
        if (active) setState({ user, loading: false });
      })
      .catch(() => {
        clearToken();
        router.replace("/login");
      });
    return () => {
      active = false;
    };
  }, [router]);

  return state;
}

export function signOut(router: { replace: (path: string) => void }): void {
  clearToken();
  router.replace("/login");
}
