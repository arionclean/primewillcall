"use client";

import { Fragment, useMemo, useState } from "react";
import { useActionState } from "react";
import {
  ChevronDown,
  Clock,
  MessageCircle,
  MessageSquare,
  Plus,
  Repeat,
  Trash2,
  Zap,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import {
  createRuleAction,
  createWhatsappTemplateAction,
  deleteRuleAction,
  toggleAutomationActiveAction,
  updateAutomationProductAction,
  updateRuleAction,
  type MessagingActionState,
} from "./actions";

export type RuleRow = {
  id: string;
  name: string;
  trigger_event: string;
  business_tour_id: string | null;
  channel: "sms" | "whatsapp";
  body: string | null;
  whatsapp_content_sid: string | null;
  whatsapp_variables: Record<string, string> | null;
  only_first_contact: boolean;
  is_active: boolean;
  delay_minutes: number;
};

export type ProductOption = {
  id: string;
  name: string;
  businessName: string;
};

export type WaTemplateOption = {
  sid: string;
  name: string;
  body: string;
  status: string;
};

const PLACEHOLDERS = ["first_name", "product_name", "booking_link", "booking_date"];

const SAMPLE_VALUES: Record<string, string> = {
  first_name: "Alex",
  product_name: "Miami Skyline Cruises",
  booking_link: "https://bked.io/booking/AB12CD",
  booking_date: "07/15/2026",
};

const PLACEHOLDER_LABELS: Record<string, string> = {
  first_name: "Customer first name",
  product_name: "Product name",
  booking_link: "Ticket link",
  booking_date: "Tour date",
};

function renderPreview(body: string): string {
  return body.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (match, name: string) => {
    return SAMPLE_VALUES[name.toLowerCase()] ?? match;
  });
}

const INITIAL: MessagingActionState = {};
const ANY_KEY = "__any__";

/**
 * The events an automation can start from. Only "a new booking comes in" is
 * wired to the sending engine today; the list is the seam for adding more.
 */
const TRIGGERS = [{ value: "new_booking", label: "A new booking comes in" }] as const;

function triggerLabel(value: string): string {
  return TRIGGERS.find((t) => t.value === value)?.label ?? "A new booking comes in";
}

const UNIT_FACTOR: Record<"minutes" | "hours" | "days", number> = {
  minutes: 1,
  hours: 60,
  days: 1440,
};
const MAX_DELAY_MINUTES = 43200; // 30 days

/** Human label for a delay, e.g. 90 -> "1 hour 30 minutes", 1440 -> "1 day". */
function humanizeMinutes(total: number): string {
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} day${days > 1 ? "s" : ""}`);
  if (hours) parts.push(`${hours} hour${hours > 1 ? "s" : ""}`);
  if (minutes) parts.push(`${minutes} minute${minutes > 1 ? "s" : ""}`);
  return parts.slice(0, 2).join(" ") || "0 minutes";
}

/** Split stored minutes back into the editor's mode/value/unit. */
function decomposeDelay(total: number): {
  mode: "immediately" | "delay";
  value: string;
  unit: "minutes" | "hours" | "days";
} {
  if (!total || total <= 0) return { mode: "immediately", value: "1", unit: "hours" };
  if (total % 1440 === 0) return { mode: "delay", value: String(total / 1440), unit: "days" };
  if (total % 60 === 0) return { mode: "delay", value: String(total / 60), unit: "hours" };
  return { mode: "delay", value: String(total), unit: "minutes" };
}

/* -------------------------------------------------------------------------- */
/*  Small building blocks                                                     */
/* -------------------------------------------------------------------------- */

/** An on/off switch that also submits a form value via a hidden input. */
function Switch({
  checked,
  onChange,
  name,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  name?: string;
  label?: string;
}) {
  return (
    <>
      {name ? <input type="hidden" name={name} value={checked ? "1" : "0"} /> : null}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          checked ? "bg-emerald-500" : "bg-muted-foreground/30",
        )}
      >
        <span
          className={cn(
            "inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
            checked ? "translate-x-4" : "translate-x-0",
          )}
        />
      </button>
    </>
  );
}

const CHANNELS = [
  { value: "sms" as const, label: "Text (SMS)" },
  { value: "whatsapp" as const, label: "WhatsApp" },
];

/** A two-option segmented control for picking the channel. */
function ChannelToggle({
  value,
  onChange,
}: {
  value: "sms" | "whatsapp";
  onChange: (value: "sms" | "whatsapp") => void;
}) {
  return (
    <div className="inline-flex rounded-lg border bg-muted/60 p-0.5">
      {CHANNELS.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-[7px] px-3 py-1 text-sm font-medium transition-colors",
            value === option.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const NODE_TONES = {
  trigger: "border-amber-200 bg-amber-50 text-amber-600 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300",
  sms: "border-blue-200 bg-blue-50 text-blue-600 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300",
  whatsapp:
    "border-emerald-200 bg-emerald-50 text-emerald-600 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300",
  wait: "border-indigo-200 bg-indigo-50 text-indigo-600 dark:border-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-300",
} as const;

/** One row of the vertical flow: an icon chip, a connector line, and content. */
function FlowStep({
  tone,
  icon,
  connect,
  children,
}: {
  tone: keyof typeof NODE_TONES;
  icon: React.ReactNode;
  connect?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <div className="flex flex-col items-center">
        <span
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border [&_svg]:h-4 [&_svg]:w-4",
            NODE_TONES[tone],
          )}
        >
          {icon}
        </span>
        {connect ? <span className="my-1 w-px flex-1 bg-border" /> : null}
      </div>
      <div className={cn("min-w-0 flex-1", connect ? "pb-4" : "pb-0")}>{children}</div>
    </li>
  );
}

function channelIcon(channel: "sms" | "whatsapp") {
  return channel === "whatsapp" ? <MessageCircle /> : <MessageSquare />;
}

/* -------------------------------------------------------------------------- */
/*  One message step (a row in an automation)                                 */
/* -------------------------------------------------------------------------- */

function MessageStep({
  rule,
  waTemplates,
  open,
  onToggle,
}: {
  rule: RuleRow;
  waTemplates: WaTemplateOption[];
  open: boolean;
  onToggle: () => void;
}) {
  const [state, formAction, pending] = useActionState(updateRuleAction, INITIAL);
  const [channel, setChannel] = useState<"sms" | "whatsapp">(rule.channel);
  const [body, setBody] = useState(rule.body ?? "");
  const [waSid, setWaSid] = useState(rule.whatsapp_content_sid ?? "");
  const [active, setActive] = useState(rule.is_active);
  const [firstContact, setFirstContact] = useState(rule.only_first_contact);

  const initialDelay = decomposeDelay(rule.delay_minutes);
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

  const snippet =
    rule.channel === "sms"
      ? renderPreview(rule.body ?? "") || "No message yet"
      : waTemplates.find((t) => t.sid === rule.whatsapp_content_sid)?.name ??
        "No template picked";

  return (
    <FlowStep tone={open ? channel : rule.channel} icon={channelIcon(open ? channel : rule.channel)} connect>
      {!open ? (
        <button
          type="button"
          onClick={onToggle}
          className="group -my-1 block w-full rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/50"
        >
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{rule.name}</span>
            {!rule.is_active ? <Badge>Paused</Badge> : null}
            {rule.only_first_contact ? (
              <Badge tone="primary" className="gap-1">
                <Repeat className="h-3 w-3" />
                First text only
              </Badge>
            ) : null}
            <Badge
              tone={rule.channel === "whatsapp" ? "success" : "info"}
              className="ml-auto gap-1"
            >
              {rule.channel === "whatsapp" ? "WhatsApp" : "SMS"}
            </Badge>
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{snippet}</span>
        </button>
      ) : (
        <form
          action={formAction}
          className="space-y-3 rounded-lg border bg-background p-3 shadow-sm"
        >
          <input type="hidden" name="rule_id" value={rule.id} />
          <input type="hidden" name="rule_channel" value={channel} />
          <input type="hidden" name="rule_delay_minutes" value={computedDelay} />

          <div className="flex flex-wrap items-center gap-3">
            <Input
              name="rule_name"
              defaultValue={rule.name}
              className="h-9 w-full max-w-56 font-medium sm:w-56"
              aria-label="Message name"
            />
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Switch name="rule_active" checked={active} onChange={setActive} label="Message active" />
              <span className="text-muted-foreground">{active ? "Active" : "Paused"}</span>
            </label>
            <button
              formAction={deleteRuleAction}
              onClick={(event) => {
                if (!confirm(`Delete the message "${rule.name}"?`)) event.preventDefault();
              }}
              className="ml-auto rounded-md p-2 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
              aria-label="Delete message"
            >
              <Trash2 className="h-4 w-4" />
            </button>
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
                  onChange={(event) =>
                    setDelayUnit(event.target.value as "minutes" | "hours" | "days")
                  }
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
                  No approved WhatsApp templates yet. Add one in the section below;
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
                            defaultValue={rule.whatsapp_variables?.[slot] ?? ""}
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
              <Button type="button" variant="ghost" size="sm" onClick={onToggle}>
                Close
              </Button>
              <Button type="submit" size="lg" disabled={pending}>
                {pending ? "Saving..." : "Save message"}
              </Button>
            </div>
          </div>

          {state.error ? (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {state.error}
            </p>
          ) : null}
          {state.saved ? (
            <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              Saved. New bookings will follow this message.
            </p>
          ) : null}
        </form>
      )}
    </FlowStep>
  );
}

/* -------------------------------------------------------------------------- */
/*  One automation (a trigger + its message steps)                            */
/* -------------------------------------------------------------------------- */

/** Header on/off switch that pauses or resumes every message in the automation. */
function AutomationToggle({
  triggerEvent,
  businessTourId,
  active,
}: {
  triggerEvent: string;
  businessTourId: string | null;
  active: boolean;
}) {
  return (
    <form action={toggleAutomationActiveAction} className="flex shrink-0 items-center gap-2">
      <input type="hidden" name="trigger_event" value={triggerEvent} />
      <input type="hidden" name="automation_product" value={businessTourId ?? ""} />
      <span className="text-xs font-medium text-muted-foreground">
        {active ? "Active" : "Paused"}
      </span>
      <button
        type="submit"
        role="switch"
        aria-checked={active}
        aria-label={active ? "Pause automation" : "Activate automation"}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          active ? "bg-emerald-500" : "bg-muted-foreground/30",
        )}
      >
        <span
          className={cn(
            "inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
            active ? "translate-x-4" : "translate-x-0",
          )}
        />
      </button>
    </form>
  );
}

function AutomationCard({
  triggerEvent,
  businessTourId,
  steps,
  products,
  waTemplates,
  openId,
  setOpenId,
}: {
  triggerEvent: string;
  businessTourId: string | null;
  steps: RuleRow[];
  products: ProductOption[];
  waTemplates: WaTemplateOption[];
  openId: string | null;
  setOpenId: (updater: (current: string | null) => string | null) => void;
}) {
  const productName = businessTourId
    ? products.find((p) => p.id === businessTourId)?.name ?? "One product"
    : "Any product";
  const activeCount = steps.filter((s) => s.is_active).length;

  return (
    <div className="rounded-xl border bg-card shadow-sm">
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{triggerLabel(triggerEvent)}</p>
          <p className="truncate text-xs text-muted-foreground">
            for {productName} · {steps.length} message{steps.length === 1 ? "" : "s"}
            {activeCount > 0 && activeCount < steps.length ? ` (${activeCount} active)` : ""}
          </p>
        </div>
        <AutomationToggle
          triggerEvent={triggerEvent}
          businessTourId={businessTourId}
          active={activeCount > 0}
        />
      </div>

      <div className="px-4 py-4">
        <ol>
          <FlowStep tone="trigger" icon={<Zap />} connect>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Trigger
            </p>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">When</span>
              <Select
                defaultValue={triggerEvent}
                className="h-9 w-auto max-w-full"
                aria-label="Trigger event"
              >
                {TRIGGERS.map((trigger) => (
                  <option key={trigger.value} value={trigger.value}>
                    {trigger.label}
                  </option>
                ))}
              </Select>
              <span className="font-medium">for</span>
              <form action={updateAutomationProductAction}>
                <input type="hidden" name="trigger_event" value={triggerEvent} />
                <input type="hidden" name="automation_product_old" value={businessTourId ?? ""} />
                <Select
                  name="automation_product_new"
                  defaultValue={businessTourId ?? ""}
                  onChange={(event) => event.currentTarget.form?.requestSubmit()}
                  className="h-9 w-auto max-w-full"
                  aria-label="Trigger product"
                >
                  <option value="">Any product</option>
                  {products.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.name} ({product.businessName})
                    </option>
                  ))}
                </Select>
              </form>
            </div>
          </FlowStep>

          <li className="flex gap-3">
            <div className="w-8" aria-hidden />
            <p className="flex-1 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Then send
            </p>
          </li>

          {steps.map((step) => (
            <Fragment key={step.id}>
              {step.delay_minutes > 0 ? (
                <FlowStep tone="wait" icon={<Clock />} connect>
                  <p className="text-sm font-medium">
                    Wait {humanizeMinutes(step.delay_minutes)}
                  </p>
                  <p className="text-xs text-muted-foreground">after the booking</p>
                </FlowStep>
              ) : null}
              <MessageStep
                rule={step}
                waTemplates={waTemplates}
                open={openId === step.id}
                onToggle={() => setOpenId((current) => (current === step.id ? null : step.id))}
              />
            </Fragment>
          ))}
        </ol>

        <form action={createRuleAction} className="pl-11">
          <input type="hidden" name="trigger_event" value={triggerEvent} />
          <input type="hidden" name="business_tour_id" value={businessTourId ?? ""} />
          <Button type="submit" variant="ghost" size="sm">
            <Plus className="h-4 w-4" />
            Add action
          </Button>
        </form>
      </div>
    </div>
  );
}

/** Inline "add a new automation" control: pick a trigger, then the product it fires for. */
function AddAutomation({ products }: { products: ProductOption[] }) {
  const [open, setOpen] = useState(false);

  const options = [
    { id: "", label: "Any product" },
    ...products.map((p) => ({ id: p.id, label: `${p.name} (${p.businessName})` })),
  ];

  if (!open) {
    return (
      <Button type="button" variant="outline" size="lg" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" />
        Add automation
      </Button>
    );
  }

  return (
    <form
      action={createRuleAction}
      className="flex flex-wrap items-center gap-2 rounded-xl border bg-muted/20 p-3"
    >
      <span className="text-sm font-medium">When</span>
      <Select
        name="trigger_event"
        defaultValue={TRIGGERS[0].value}
        className="h-9 w-auto max-w-full"
        aria-label="Trigger event"
      >
        {TRIGGERS.map((trigger) => (
          <option key={trigger.value} value={trigger.value}>
            {trigger.label}
          </option>
        ))}
      </Select>
      <span className="text-sm font-medium">for</span>
      <Select
        name="business_tour_id"
        defaultValue={options[0].id}
        className="h-9 w-auto max-w-full"
        aria-label="Automation product"
      >
        {options.map((option) => (
          <option key={option.id || ANY_KEY} value={option.id}>
            {option.label}
          </option>
        ))}
      </Select>
      <Button type="submit" size="lg">
        Create
      </Button>
      <Button type="button" variant="ghost" size="lg" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
  );
}

export function MessagingRules({
  rules,
  products,
  waTemplates,
}: {
  rules: RuleRow[];
  products: ProductOption[];
  waTemplates: WaTemplateOption[];
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  // Group messages into automations by their trigger (event + product, null = any).
  const groups = useMemo(() => {
    const map = new Map<
      string,
      { triggerEvent: string; businessTourId: string | null; steps: RuleRow[] }
    >();
    for (const rule of rules) {
      const key = `${rule.trigger_event}::${rule.business_tour_id ?? ANY_KEY}`;
      let group = map.get(key);
      if (!group) {
        group = { triggerEvent: rule.trigger_event, businessTourId: rule.business_tour_id, steps: [] };
        map.set(key, group);
      }
      group.steps.push(rule);
    }
    return [...map.values()];
  }, [rules]);

  return (
    <div className="space-y-3">
      {groups.length === 0 ? (
        <div className="rounded-xl border border-dashed bg-muted/20 px-6 py-10 text-center">
          <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg border bg-background">
            <Zap className="h-5 w-5 text-muted-foreground" />
          </span>
          <p className="mt-3 text-sm font-medium">No automations yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Add your first automation to text customers automatically when they book.
          </p>
        </div>
      ) : (
        groups.map((group) => (
          <AutomationCard
            key={`${group.triggerEvent}::${group.businessTourId ?? ANY_KEY}`}
            triggerEvent={group.triggerEvent}
            businessTourId={group.businessTourId}
            steps={group.steps}
            products={products}
            waTemplates={waTemplates}
            openId={openId}
            setOpenId={setOpenId}
          />
        ))
      )}

      <AddAutomation products={products} />
    </div>
  );
}

export function AddWhatsappTemplateForm() {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(createWhatsappTemplateAction, INITIAL);

  if (!open) {
    return (
      <Button type="button" variant="outline" size="lg" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" />
        Add template
      </Button>
    );
  }

  return (
    <form action={formAction} className="rounded-xl border bg-card p-4 shadow-sm">
      <p className="text-sm font-medium">Add a WhatsApp template</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Sent to WhatsApp for approval automatically. Use numbered placeholders like{" "}
        {"{{1}}"} for dynamic values; you connect them to real values in a message.
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
          <Select id="wa_category" name="wa_category" defaultValue="UTILITY" className="mt-1">
            <option value="UTILITY">Utility (booking updates, confirmations)</option>
            <option value="MARKETING">Marketing (promotions, offers)</option>
          </Select>
        </div>
      </div>

      <div className="mt-3">
        <label className="text-sm font-medium" htmlFor="wa_body">
          Message
        </label>
        <Textarea
          id="wa_body"
          name="wa_body"
          rows={3}
          required
          placeholder="Hi {{1}}, your tour is confirmed for {{2}}. See your ticket: {{3}}"
          className="mt-1"
        />
      </div>

      {state.error ? (
        <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      ) : null}
      {state.saved ? (
        <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Template submitted. Its status will show as pending until WhatsApp approves it.
        </p>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? "Submitting..." : "Create and submit for approval"}
        </Button>
        <Button type="button" variant="ghost" size="lg" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
