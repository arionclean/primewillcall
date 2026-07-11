"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useActionState } from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import { deleteRuleAction, type MessagingActionState } from "./actions";
import { ChannelToggle, Switch } from "./flow";
import {
  MAX_DELAY_MINUTES,
  PLACEHOLDER_LABELS,
  PLACEHOLDERS,
  UNIT_FACTOR,
  decomposeDelay,
  renderPreview,
  type Channel,
  type WaTemplateOption,
} from "./messaging-lib";

const INITIAL: MessagingActionState = {};

export type MessageDraft = {
  name: string;
  channel: Channel;
  body: string;
  whatsappContentSid: string;
  whatsappVariables: Record<string, string>;
  onlyFirstContact: boolean;
  isActive: boolean;
  delayMinutes: number;
};

export const EMPTY_DRAFT: MessageDraft = {
  name: "",
  channel: "sms",
  body: "",
  whatsappContentSid: "",
  whatsappVariables: {},
  onlyFirstContact: false,
  isActive: true,
  delayMinutes: 0,
};

/**
 * The message form, shared by "edit this message" and "add a new one". Local
 * state opens instantly; only Save talks to the server. `hiddenFields` carries
 * the identity (rule_id when editing, trigger + product when creating).
 */
export function MessageEditor({
  action,
  hiddenFields,
  draft,
  waTemplates,
  submitLabel,
  deletableName,
  onSaved,
  onCancel,
  onChannelChange,
}: {
  action: (prev: MessagingActionState, formData: FormData) => Promise<MessagingActionState>;
  hiddenFields: Record<string, string>;
  draft: MessageDraft;
  waTemplates: WaTemplateOption[];
  submitLabel: string;
  deletableName?: string;
  onSaved?: () => void;
  onCancel?: () => void;
  onChannelChange?: (channel: Channel) => void;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL);
  const [channel, setChannelState] = useState<Channel>(draft.channel);
  const [body, setBody] = useState(draft.body);
  const [waSid, setWaSid] = useState(draft.whatsappContentSid);
  const [active, setActive] = useState(draft.isActive);
  const [firstContact, setFirstContact] = useState(draft.onlyFirstContact);

  const initialDelay = decomposeDelay(draft.delayMinutes);
  const [delayMode, setDelayMode] = useState<"immediately" | "delay">(initialDelay.mode);
  const [delayValue, setDelayValue] = useState(initialDelay.value);
  const [delayUnit, setDelayUnit] = useState<"minutes" | "hours" | "days">(initialDelay.unit);
  const computedDelay =
    delayMode === "immediately"
      ? 0
      : Math.min(
          MAX_DELAY_MINUTES,
          Math.max(1, Math.round(Number(delayValue) || 0)) * UNIT_FACTOR[delayUnit],
        );

  const setChannel = (next: Channel) => {
    setChannelState(next);
    onChannelChange?.(next);
  };

  // Close the editor once a save lands (used by the create flows).
  const savedHandled = useRef(false);
  useEffect(() => {
    if (state.saved && !savedHandled.current) {
      savedHandled.current = true;
      onSaved?.();
    }
  }, [state.saved, onSaved]);

  const approved = waTemplates.filter((t) => t.status === "approved");
  const selectedTemplate = waTemplates.find((t) => t.sid === waSid) ?? null;
  const waSlots = useMemo(() => {
    if (!selectedTemplate) return [];
    const slots = new Set<string>();
    for (const match of selectedTemplate.body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
      slots.add(match[1]);
    }
    return [...slots].sort((a, b) => Number(a) - Number(b));
  }, [selectedTemplate]);

  return (
    <form action={formAction} className="space-y-3 rounded-lg border bg-background p-3 shadow-sm">
      {Object.entries(hiddenFields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <input type="hidden" name="rule_channel" value={channel} />
      <input type="hidden" name="rule_delay_minutes" value={computedDelay} />

      <div className="flex flex-wrap items-center gap-3">
        <Input
          name="rule_name"
          defaultValue={draft.name}
          placeholder="Name this message"
          className="h-9 w-full max-w-56 font-medium sm:w-56"
          aria-label="Message name"
        />
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Switch name="rule_active" checked={active} onChange={setActive} label="Message active" />
          <span className="text-muted-foreground">{active ? "Active" : "Paused"}</span>
        </label>
        {deletableName ? (
          <button
            formAction={deleteRuleAction}
            onClick={(event) => {
              if (!confirm(`Delete the message "${deletableName}"?`)) event.preventDefault();
            }}
            className="ml-auto rounded-md p-2 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
            aria-label="Delete message"
          >
            <Trash2 size={16} />
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">When to send</span>
        <Select
          value={delayMode}
          onChange={(event) => setDelayMode(event.target.value as "immediately" | "delay")}
          className="h-9 w-auto"
          aria-label="When to send"
        >
          <option value="immediately">Immediately</option>
          <option value="delay">After a wait</option>
        </Select>
        {delayMode === "delay" ? (
          <>
            <Input
              type="number"
              min={1}
              value={delayValue}
              onChange={(event) => setDelayValue(event.target.value)}
              className="h-9 w-16"
              aria-label="Wait amount"
            />
            <Select
              value={delayUnit}
              onChange={(event) => setDelayUnit(event.target.value as "minutes" | "hours" | "days")}
              className="h-9 w-auto"
              aria-label="Wait unit"
            >
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
            </Select>
            <span className="text-muted-foreground">after the booking</span>
          </>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Send</span>
        <ChannelToggle value={channel} onChange={setChannel} />
      </div>

      {channel === "sms" ? (
        <div className="space-y-2">
          <Textarea
            name="rule_body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={3}
            placeholder="Hi {{first_name}}, thanks for booking!"
          />
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>Insert:</span>
            {PLACEHOLDERS.map((placeholder) => (
              <button
                key={placeholder}
                type="button"
                onClick={() => setBody((current) => `${current}{{${placeholder}}}`)}
                title={PLACEHOLDER_LABELS[placeholder]}
                className="rounded bg-muted px-1.5 py-0.5 font-mono transition hover:bg-muted/70"
              >
                {`{{${placeholder}}}`}
              </button>
            ))}
          </div>
          {body.trim() ? (
            <p className="rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Preview: </span>
              {renderPreview(body)}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="space-y-2">
          {approved.length === 0 ? (
            <p className="rounded-lg border border-dashed bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              No approved WhatsApp templates yet. Add one in the WhatsApp templates tab;
              once WhatsApp approves it, you can pick it here.
            </p>
          ) : (
            <Select
              name="rule_wa_template"
              value={waSid}
              onChange={(event) => setWaSid(event.target.value)}
              className="h-9 max-w-md"
            >
              <option value="">Pick an approved template...</option>
              {approved.map((template) => (
                <option key={template.sid} value={template.sid}>
                  {template.name}
                </option>
              ))}
            </Select>
          )}

          {selectedTemplate ? (
            <div className="rounded-lg border bg-muted/40 px-3 py-2">
              <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                {selectedTemplate.body}
              </p>
              {waSlots.length > 0 ? (
                <div className="mt-2 space-y-2">
                  {waSlots.map((slot) => (
                    <label key={slot} className="flex items-center gap-2 text-sm">
                      <code className="rounded bg-muted px-1.5 py-0.5">{`{{${slot}}}`}</code>
                      <span className="text-muted-foreground">is</span>
                      <Select
                        name={`wa_var_${slot}`}
                        defaultValue={draft.whatsappVariables[slot] ?? ""}
                        className="h-9 w-auto"
                      >
                        <option value="">Pick a value...</option>
                        {PLACEHOLDERS.map((placeholder) => (
                          <option key={placeholder} value={placeholder}>
                            {PLACEHOLDER_LABELS[placeholder]}
                          </option>
                        ))}
                      </Select>
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <Switch
            name="rule_first_contact"
            checked={firstContact}
            onChange={setFirstContact}
            label="Only the first time we ever text this customer"
          />
          Only the first time we ever text this customer
        </label>
        <div className="flex items-center gap-2">
          {onCancel ? (
            <Button type="button" variant="ghost" size="lg" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          <Button type="submit" size="lg" disabled={pending}>
            {pending ? "Saving..." : submitLabel}
          </Button>
        </div>
      </div>

      {state.error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      ) : null}
      {state.saved && !onSaved ? (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Saved.
        </p>
      ) : null}
    </form>
  );
}
