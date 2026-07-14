"use client";

import { useState } from "react";

import { completeExplicitSignOut } from "./sign-out-client";

export function SignOutControl({ label }: { label: string }) {
  const [pending, setPending] = useState(false);

  async function signOut(): Promise<void> {
    setPending(true);
    const completed = await completeExplicitSignOut({
      request: () => fetch("/api/auth/sign-out", { method: "POST", credentials: "same-origin" }),
      deleteCache: (name) => ("caches" in window ? window.caches.delete(name) : Promise.resolve(false)),
      redirect: () => window.location.assign("/login"),
    }).catch(() => false);
    if (!completed) setPending(false);
  }

  return (
    <button
      className="min-h-tap rounded-md border-2 border-foreground px-4 py-2 font-semibold disabled:opacity-60"
      type="button"
      disabled={pending}
      onClick={() => void signOut()}
    >
      {label}
    </button>
  );
}
