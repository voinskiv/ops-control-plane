"use client";

import { useState, type FormEvent } from "react";

import type { CommitmentFormLabels } from "./form-labels";

type Lifecycle = "activate" | "pause" | "complete" | "archive";

async function invoke(name: string, input: unknown): Promise<{ status: string; code?: string }> {
  const response = await fetch("/api/actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, input, idempotency_key: crypto.randomUUID() }),
  });
  const envelope = (await response.json()) as { status: string; result?: { code?: string } };
  return { status: envelope.status, code: envelope.result?.code };
}

function resultMessage(result: { status: string; code?: string }, labels: CommitmentFormLabels): string {
  return result.status === "ok" ? labels.success : (result.code === undefined ? labels.failed : labels.errors[result.code] ?? labels.failed);
}

export function CommitmentManageForm({ labels }: { labels: CommitmentFormLabels }) {
  const [lifecycle, setLifecycle] = useState<Lifecycle>("activate");
  const [message, setMessage] = useState<string | null>(null);

  async function update(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input: Record<string, unknown> = { commitment_id: String(data.get("commitment_id")) };
    const title = String(data.get("title"));
    const validTo = String(data.get("valid_to"));
    if (title !== "") input.title = title;
    if (validTo !== "") input.valid_to = validTo;
    setMessage(resultMessage(await invoke("commitment.update_spec", input), labels));
  }

  async function applyLifecycle(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input: Record<string, unknown> = { commitment_id: String(data.get("commitment_id")) };
    if (lifecycle !== "activate") input.reason = String(data.get("reason"));
    setMessage(resultMessage(await invoke(`commitment.${lifecycle}`, input), labels));
  }

  return (
    <section>
      <h2>{labels.manageTitle}</h2>
      <form onSubmit={(event) => void update(event)}>
        <label>{labels.commitmentId}<input name="commitment_id" type="text" required /></label>
        <label>{labels.updateTitle}<input name="title" type="text" maxLength={200} /></label>
        <label>{labels.validTo}<input name="valid_to" type="date" /></label>
        <button type="submit">{labels.update}</button>
      </form>
      <form onSubmit={(event) => void applyLifecycle(event)}>
        <label>{labels.commitmentId}<input name="commitment_id" type="text" required /></label>
        <label>{labels.action}
          <select value={lifecycle} onChange={(event) => setLifecycle(event.target.value as Lifecycle)}>
            <option value="activate">{labels.actions.activate}</option>
            <option value="pause">{labels.actions.pause}</option>
            <option value="complete">{labels.actions.complete}</option>
            <option value="archive">{labels.actions.archive}</option>
          </select>
        </label>
        {lifecycle === "activate" ? null : <label>{labels.reason}<input name="reason" type="text" maxLength={2000} required /></label>}
        <button type="submit">{labels.applyAction}</button>
      </form>
      {message === null ? null : <p role="status">{message}</p>}
    </section>
  );
}
