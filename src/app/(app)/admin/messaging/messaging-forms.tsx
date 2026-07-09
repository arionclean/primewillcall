"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  createWhatsappTemplateAction,
  updateSmsTemplatesAction,
  type MessagingActionState,
} from "./actions";

export type SmsTemplateRow = {
  id: string;
  key: string;
  channel: string;
  label: string;
  description: string | null;
  body: string;
  is_active: boolean;
};

const PLACEHOLDERS = ["{{first_name}}", "{{product_name}}", "{{booking_link}}"];

const INITIAL: MessagingActionState = {};

export function SmsTemplatesForm({ rows }: { rows: SmsTemplateRow[] }) {
  const [state, formAction, pending] = useActionState(updateSmsTemplatesAction, INITIAL);

  return (
    <form action={formAction} className="space-y-4">
      {rows.map((row, i) => (
        <div key={row.id} className="rounded-lg border p-4">
          <input type="hidden" name={`tpl_id_${i}`} value={row.id} />
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium">{row.label}</p>
              {row.description ? (
                <p className="mt-0.5 text-xs text-muted-foreground">{row.description}</p>
              ) : null}
            </div>
            <label className="flex shrink-0 items-center gap-2 text-sm">
              <input
                type="checkbox"
                name={`tpl_active_${i}`}
                value="1"
                defaultChecked={row.is_active}
                className="h-4 w-4 rounded border-input"
              />
              On
            </label>
          </div>
          <textarea
            name={`tpl_body_${i}`}
            defaultValue={row.body}
            rows={3}
            className="mt-3 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          <p className="mt-2 text-xs text-muted-foreground">
            Placeholders:{" "}
            {PLACEHOLDERS.map((placeholder) => (
              <code key={placeholder} className="mr-2 rounded bg-muted px-1.5 py-0.5">
                {placeholder}
              </code>
            ))}
          </p>
        </div>
      ))}

      {state.error ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      ) : null}
      {state.saved ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Saved. New bookings will use the updated wording.
        </p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving..." : "Save messages"}
      </Button>
    </form>
  );
}

export function AddWhatsappTemplateForm() {
  const [state, formAction, pending] = useActionState(createWhatsappTemplateAction, INITIAL);

  return (
    <form action={formAction} className="rounded-lg border p-4">
      <p className="text-sm font-medium">Add a WhatsApp template</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        It is sent to WhatsApp for approval automatically. Use numbered placeholders
        like {"{{1}}"} for dynamic values.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="text-sm font-medium" htmlFor="wa_name">
            Name
          </label>
          <Input
            id="wa_name"
            name="wa_name"
            placeholder="booking_confirmation"
            required
            className="mt-1"
          />
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="wa_category">
            Category
          </label>
          <select
            id="wa_category"
            name="wa_category"
            defaultValue="UTILITY"
            className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <option value="UTILITY">Utility (booking updates, confirmations)</option>
            <option value="MARKETING">Marketing (promotions, offers)</option>
          </select>
        </div>
      </div>

      <div className="mt-3">
        <label className="text-sm font-medium" htmlFor="wa_body">
          Message
        </label>
        <textarea
          id="wa_body"
          name="wa_body"
          rows={3}
          required
          placeholder="Hi {{1}}, your tour is confirmed for {{2}}. See your ticket: {{3}}"
          className="mt-1 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50"
        />
      </div>

      {state.error ? (
        <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      ) : null}
      {state.saved ? (
        <p className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Template submitted. Its status will show as pending until WhatsApp approves it.
        </p>
      ) : null}

      <Button type="submit" disabled={pending} className="mt-3">
        {pending ? "Submitting..." : "Create and submit for approval"}
      </Button>
    </form>
  );
}
