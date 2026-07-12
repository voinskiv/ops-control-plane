"use client";

import { useEffect, useState } from "react";

export function AuthCallback({ endpoint, state, failedLabel }: { endpoint: string; state?: string; failedLabel: string }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    async function complete(): Promise<void> {
      const accessToken = new URLSearchParams(window.location.hash.slice(1)).get("access_token");
      if (accessToken === null) {
        setFailed(true);
        return;
      }
      const body = state === undefined ? { access_token: accessToken } : { access_token: accessToken, state };
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          setFailed(true);
          return;
        }
        window.location.replace("/");
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setFailed(true);
        }
      }
    }

    void complete();
    return () => controller.abort();
  }, [endpoint, state]);

  return failed ? <p>{failedLabel}</p> : null;
}
