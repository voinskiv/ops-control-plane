"use client";

import { useState } from "react";

export function InviteEmailAcceptance({
  workspaceId,
  personId,
  label,
  failedLabel,
}: {
  workspaceId: string;
  personId: string;
  label: string;
  failedLabel: string;
}) {
  const [failed, setFailed] = useState(false);

  async function accept(): Promise<void> {
    const accessToken = new URLSearchParams(window.location.hash.slice(1)).get("access_token");
    if (accessToken === null) {
      setFailed(true);
      return;
    }
    const response = await fetch("/api/auth/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ access_token: accessToken, workspace_id: workspaceId, person_id: personId }),
    });
    if (!response.ok) {
      setFailed(true);
      return;
    }
    window.location.replace("/");
  }

  return (
    <>
      <button type="button" onClick={() => void accept()}>{label}</button>
      {failed ? <p>{failedLabel}</p> : null}
    </>
  );
}
