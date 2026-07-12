"use client";

import { useState, type FormEvent } from "react";

import {
  commitmentRrule,
  commitmentWeekdays,
  type CommitmentRrulePreset,
  type CommitmentWeekday,
} from "@core/domain/commitment-rrule-presets";

import type { CommitmentFormLabels } from "./form-labels";

type CommitmentType = "coverage" | "output" | "service_scope";

async function invoke(name: string, input: unknown): Promise<{ status: string; code?: string }> {
  const response = await fetch("/api/actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, input, idempotency_key: crypto.randomUUID() }),
  });
  const envelope = (await response.json()) as { status: string; result?: { code?: string } };
  return { status: envelope.status, code: envelope.result?.code };
}

export function CommitmentDraftForm({ labels }: { labels: CommitmentFormLabels }) {
  const [type, setType] = useState<CommitmentType>("coverage");
  const [preset, setPreset] = useState<CommitmentRrulePreset>("daily");
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const days = data
      .getAll("weekdays")
      .filter((value): value is CommitmentWeekday =>
        typeof value === "string" && commitmentWeekdays.includes(value as CommitmentWeekday),
      );
    const schedule = commitmentRrule(preset, days);
    if (schedule === null) {
      setMessage(labels.failed);
      return;
    }
    const spec: Record<string, unknown> = {
      window_start_time: String(data.get("window_start_time")),
      window_end_time: String(data.get("window_end_time")),
    };
    if (type === "service_scope") {
      spec.checklist = [{ key: String(data.get("checklist_key")), label: String(data.get("checklist_label")) }];
    }
    const input: Record<string, unknown> = {
      site_id: String(data.get("site_id")),
      type,
      title: String(data.get("title")),
      spec,
      schedule_rrule: schedule,
      valid_from: String(data.get("valid_from")),
      valid_to: String(data.get("valid_to")),
    };
    if (type === "coverage" || type === "output") input.target_qty = Number(data.get("target_qty"));
    if (type === "output") input.unit = String(data.get("unit"));
    const result = await invoke("commitment.draft", input);
    setMessage(result.status === "ok" ? labels.success : (result.code === undefined ? labels.failed : labels.errors[result.code] ?? labels.failed));
  }

  return (
    <form onSubmit={(event) => void submit(event)}>
      <fieldset>
        <legend>{labels.draftTitle}</legend>
        <label>{labels.siteId}<input name="site_id" type="text" required /></label>
        <label>{labels.type}
          <select value={type} onChange={(event) => setType(event.target.value as CommitmentType)}>
            <option value="coverage">{labels.types.coverage}</option>
            <option value="output">{labels.types.output}</option>
            <option value="service_scope">{labels.types.service_scope}</option>
          </select>
        </label>
        <label>{labels.title}<input name="title" type="text" maxLength={200} required /></label>
        <label>{labels.windowStart}<input name="window_start_time" type="time" required /></label>
        <label>{labels.windowEnd}<input name="window_end_time" type="time" required /></label>
        <label>{labels.schedule}
          <select value={preset} onChange={(event) => setPreset(event.target.value as CommitmentRrulePreset)}>
            <option value="daily">{labels.schedules.daily}</option>
            <option value="weekdays">{labels.schedules.weekdays}</option>
            <option value="weekly">{labels.schedules.weekly}</option>
            <option value="biweekly">{labels.schedules.biweekly}</option>
          </select>
        </label>
        {preset === "weekly" || preset === "biweekly" ? (
          <fieldset>
            <legend>{labels.selectedDays}</legend>
            {commitmentWeekdays.map((day) => (
              <label key={day}><input name="weekdays" type="checkbox" value={day} />{labels.weekdays[day]}</label>
            ))}
          </fieldset>
        ) : null}
        {type === "coverage" || type === "output" ? (
          <label>{labels.targetQty}<input name="target_qty" type="number" min="1" step={type === "coverage" ? "1" : "0.001"} required /></label>
        ) : null}
        {type === "output" ? <label>{labels.unit}<input name="unit" type="text" required /></label> : null}
        {type === "service_scope" ? (
          <>
            <label>{labels.checklistKey}<input name="checklist_key" type="text" required /></label>
            <label>{labels.checklistLabel}<input name="checklist_label" type="text" required /></label>
          </>
        ) : null}
        <label>{labels.validFrom}<input name="valid_from" type="date" required /></label>
        <label>{labels.validTo}<input name="valid_to" type="date" required /></label>
        <button type="submit">{labels.create}</button>
        {message === null ? null : <p role="status">{message}</p>}
      </fieldset>
    </form>
  );
}
