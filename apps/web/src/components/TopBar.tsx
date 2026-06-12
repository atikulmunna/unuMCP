"use client";

import { useRouter } from "next/navigation";
import { Brand } from "./Brand";
import { Button } from "./ui";
import { signOut } from "@/lib/session";
import type { SessionUser } from "@/lib/types";

export function TopBar({ user }: { user: SessionUser | null }) {
  const router = useRouter();
  const initial = (user?.name ?? user?.email ?? "?").charAt(0).toUpperCase();

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-paper/85 backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5 sm:px-8">
        <div className="flex items-center gap-3">
          <Brand />
          <span className="hidden font-mono text-2xs uppercase tracking-eyebrow text-ink-faint sm:inline">
            OpenAPI → MCP
          </span>
        </div>

        {user && (
          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-medium leading-tight text-ink">{user.name ?? "Signed in"}</p>
              <p className="font-mono text-2xs text-ink-faint">{user.email}</p>
            </div>
            <span className="grid h-8 w-8 place-items-center rounded-full border border-line-strong bg-clay-wash font-serif text-sm font-semibold text-clay">
              {initial}
            </span>
            <Button size="sm" variant="ghost" onClick={() => signOut(router)}>
              Sign out
            </Button>
          </div>
        )}
      </div>
    </header>
  );
}
