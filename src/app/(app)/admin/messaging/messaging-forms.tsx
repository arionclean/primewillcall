"use client";

import { Fragment, useMemo, useOptimistic, useState, useTransition } from "react";
import { useActionState } from "react";
import { ChevronDown, Clock, Plus, Repeat, Zap } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import {
  createMessageAction,
  createWhatsappTemplateAction,
  toggleAutomationActiveAction,
  updateAutomationProductAction,
  updateRuleAction,
  updateRuleDelayAction,
  type MessagingActionState,
} from "./actions";
import { FlowStep, NODE_STYLES, Switch, channelIcon } from "./flow";
import { EMPTY_DRAFT, MessageEditor } from "./message-editor";
import {
  ANY_KEY,
  MAX_DELAY_MINUTES,
  STATUS_TONE,
  TRIGGERS,
  UNIT_FACTOR,
  decomposeDelay,
  humanizeMinutes,
  renderPreview,
  triggerLabel,
  type Channel,
  type ProductOption,
  type RuleRow,
  type WaTemplateOption,
} from "./messaging-lib";

const INITIAL: MessagingActionState = {};

/* -------------------------------------------------------------------------- */
/*  Trigger controls                                                          */
/* -------------------------------------------------------------------------- */

function TriggerSelect({ value, onChange }: { value: string; onChange?: (v: string) => void }) {
  return (
    <Select
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
      className="h-9 w-auto max-w-full"
      aria-label="Trigger event"
    >
      {TRIGGERS.map((trigger) => (
        <option key={trigger.value} value={trigger.value}>
          {trigger.label}
        </option>
      ))}
    </Select>
  );
}

function ProductOptions({ products }: { products: ProductOption[] }) {
  return (
    <>
      <option value="">Any product</option>
      {products.map((product) => (
        <option key={product.id} value={product.id}>
          {product.name} ({product.businessName})
        </option>
      ))}
    </>
  );
}

/** Product picker on an existing automation: saves on change, no submit button. */
function TriggerProductSelect({
  triggerEvent,
  businessTourId,
  products,
}: {
  triggerEvent: string;
  businessTourId: string | null;
  products: ProductOption[];
}) {
  const [pending, startTransition] = useTransition();
  return (
    <Select
      defaultValue={businessTourId ?? ""}
      disabled={pending}
      onChange={(event) => {
        const next = event.target.value;
        startTransition(async () => {
          const fd = new FormData();
          fd.set("trigger_event", triggerEvent);
          fd.set("automation_product_old", businessTourId ?? "");
          fd.set("automation_product_new", next);
          await updateAutomationProductAction(fd);
        });
      }}
      className={cn("h-9 w-auto max-w-full", pending && "opacity-60")}
      aria-label="Trigger product"
    >
      <ProductOptions products={products} />
    </Select>
  );
}

/** Header switch: pauses or resumes every message, with instant visual feedback. */
function AutomationToggle({
  triggerEvent,
  businessTourId,
  active,
}: {
  triggerEvent: string;
  businessTourId: string | null;
  active: boolean;
}) {
  const [, startTransition] = useTransition();
  const [optimisticActive, setOptimisticActive] = useOptimistic(active);

  const toggle = () =>
    startTransition(async () => {
      setOptimisticActive(!optimisticActive);
      const fd = new FormData();
      fd.set("trigger_event", triggerEvent);
      fd.set("automation_product", businessTourId ?? "");
      await toggleAutomationActiveAction(fd);
    });

  return (
    <span className="flex shrink-0 items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">
        {optimisticActive ? "Active" : "Paused"}
      </span>
      <Switch
        checked={optimisticActive}
        onChange={toggle}
        label={optimisticActive ? "Pause automation" : "Activate automation"}
      />
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*  Wait steps                                                                */
/* -------------------------------------------------------------------------- */

type WaitDraft = { value: string; unit: "minutes" | "hours" | "days" };

function waitToMinutes(draft: WaitDraft): number {
  return Math.min(
    MAX_DELAY_MINUTES,
    Math.max(1, Math.round(Number(draft.value) || 0)) * UNIT_FACTOR[draft.unit],
  );
}

/** The duration controls shared by the Wait node editor and the new-wait module. */
function WaitFields({
  draft,
  onChange,
}: {
  draft: WaitDraft;
  onChange: (draft: WaitDraft) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="font-medium">Wait</span>
      <Input
        type="number"
        min={1}
        value={draft.value}
        onChange={(event) => onChange({ ...draft, value: event.target.value })}
        className="h-9 w-16"
        aria-label="Wait amount"
      />
      <Select
        value={draft.unit}
        onChange={(event) =>
          onChange({ ...draft, unit: event.target.value as WaitDraft["unit"] })
        }
        className="h-9 w-auto"
        aria-label="Wait unit"
      >
        <option value="minutes">minutes</option>
        <option value="hours">hours</option>
        <option value="days">days</option>
      </Select>
      <span className="text-muted-foreground">after the booking</span>
    </div>
  );
}

/** A saved wait: its own node in the flow, click to edit or remove it. */
function WaitStep({ rule }: { rule: RuleRow }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<WaitDraft>(() => {
    const d = decomposeDelay(rule.delay_minutes);
    return { value: d.value, unit: d.unit };
  });
  const [pending, startTransition] = useTransition();

  const submit = (minutes: number) =>
    startTransition(async () => {
      const fd = new FormData();
      fd.set("rule_id", rule.id);
      fd.set("rule_delay_minutes", String(minutes));
      await updateRuleDelayAction(fd);
      setOpen(false);
    });

  return (
    <FlowStep tone="wait" icon={<Clock size={16} aria-hidden />} connect>
      {!open ? (
        <button
          type="button"
          onClick={() => {
            const d = decomposeDelay(rule.delay_minutes);
            setDraft({ value: d.value, unit: d.unit });
            setOpen(true);
          }}
          aria-expanded={open}
          className="group -my-1 block w-full rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/50"
        >
          <span className="flex items-center gap-2">
            <span className="text-sm font-medium">Wait {humanizeMinutes(rule.delay_minutes)}</span>
            <ChevronDown size={16} className="ml-auto shrink-0 text-muted-foreground" aria-hidden />
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">after the booking</span>
        </button>
      ) : (
        <div className="space-y-3 rounded-lg border bg-background p-3 shadow-sm">
          <WaitFields draft={draft} onChange={setDraft} />
          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => submit(0)}
              className="text-muted-foreground"
            >
              Remove wait
            </Button>
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" size="lg" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                size="lg"
                disabled={pending}
                onClick={() => submit(waitToMinutes(draft))}
              >
                {pending ? "Saving..." : "Save wait"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </FlowStep>
  );
}

/** Offered while editing a message that has no wait yet. */
function AddWaitRow({ ruleId }: { ruleId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <li className="flex gap-3 pb-2">
      <div className="w-8" aria-hidden />
      <div className="flex-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          className="text-muted-foreground"
          onClick={() =>
            startTransition(async () => {
              const fd = new FormData();
              fd.set("rule_id", ruleId);
              fd.set("rule_delay_minutes", "60");
              await updateRuleDelayAction(fd);
            })
          }
        >
          <Plus size={16} aria-hidden />
          {pending ? "Adding wait..." : "Add a wait before this message"}
        </Button>
      </div>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/*  Message steps                                                             */
/* -------------------------------------------------------------------------- */

/** One saved message: a header row that opens and closes, editor underneath. */
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
  const [liveChannel, setLiveChannel] = useState<Channel>(rule.channel);

  const snippet =
    rule.channel === "sms"
      ? renderPreview(rule.body ?? "") || "No message yet"
      : waTemplates.find((t) => t.sid === rule.whatsapp_content_sid)?.name ??
        "No template picked";

  return (
    <FlowStep
      tone={open ? liveChannel : rule.channel}
      icon={channelIcon(open ? liveChannel : rule.channel)}
      connect
    >
      <button
        type="button"
        onClick={() => {
          if (!open) setLiveChannel(rule.channel);
          onToggle();
        }}
        aria-expanded={open}
        className="group -my-1 block w-full rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/50"
      >
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{rule.name}</span>
          {!rule.is_active ? <Badge>Paused</Badge> : null}
          {rule.only_first_contact ? (
            <Badge tone="primary" className="gap-1">
              <Repeat size={12} aria-hidden />
              First text only
            </Badge>
          ) : null}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            <Badge tone={rule.channel === "whatsapp" ? "success" : "info"}>
              {rule.channel === "whatsapp" ? "WhatsApp" : "SMS"}
            </Badge>
            <ChevronDown
              size={16}
              className="text-muted-foreground"
              style={{
                transform: open ? "rotate(180deg)" : "none",
                transition: "transform 150ms ease",
              }}
              aria-hidden
            />
          </span>
        </span>
        {!open ? (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{snippet}</span>
        ) : null}
      </button>

      {open ? (
        <div className="mt-2">
          <MessageEditor
            action={updateRuleAction}
            hiddenFields={{ rule_id: rule.id }}
            draft={{
              name: rule.name,
              channel: rule.channel,
              body: rule.body ?? "",
              whatsappContentSid: rule.whatsapp_content_sid ?? "",
              whatsappVariables: rule.whatsapp_variables ?? {},
              onlyFirstContact: rule.only_first_contact,
              isActive: rule.is_active,
              delayMinutes: rule.delay_minutes,
            }}
            waTemplates={waTemplates}
            submitLabel="Save message"
            deletableName={rule.name}
            onChannelChange={setLiveChannel}
          />
        </div>
      ) : null}
    </FlowStep>
  );
}

/** What kind of step the owner picked from the action menu. */
type ActionChoice = { channel: Channel; withWait: boolean };

const ACTION_CHOICES: { key: string; label: string; icon: React.ReactNode; choice: ActionChoice }[] = [
  {
    key: "sms",
    label: "Send a text",
    icon: <span style={{ color: NODE_STYLES.sms.color }}>{channelIcon("sms")}</span>,
    choice: { channel: "sms", withWait: false },
  },
  {
    key: "whatsapp",
    label: "Send a WhatsApp",
    icon: <span style={{ color: NODE_STYLES.whatsapp.color }}>{channelIcon("whatsapp")}</span>,
    choice: { channel: "whatsapp", withWait: false },
  },
  {
    key: "wait",
    label: "Wait, then send",
    icon: (
      <span style={{ color: NODE_STYLES.wait.color }}>
        <Clock size={16} aria-hidden />
      </span>
    ),
    choice: { channel: "sms", withWait: true },
  },
];

/** The "Add action" menu: pick the kind of step before anything opens. */
function ActionPicker({
  onPick,
  onCancel,
}: {
  onPick: (choice: ActionChoice) => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 pl-11">
      {ACTION_CHOICES.map((option) => (
        <Button
          key={option.key}
          type="button"
          variant="outline"
          size="lg"
          onClick={() => onPick(option.choice)}
        >
          {option.icon}
          {option.label}
        </Button>
      ))}
      <Button type="button" variant="ghost" size="lg" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

/**
 * The instant new-action editor: pure local state, saved only on Create.
 * A wait renders as its own node above the message; both save as one step.
 */
function NewMessageStep({
  triggerEvent,
  businessTourId,
  waTemplates,
  initial,
  submitLabel = "Create message",
  onClose,
}: {
  triggerEvent: string;
  businessTourId: string | null;
  waTemplates: WaTemplateOption[];
  initial: ActionChoice;
  submitLabel?: string;
  onClose: () => void;
}) {
  const [channel, setChannel] = useState<Channel>(initial.channel);
  const [wait, setWait] = useState<WaitDraft>({ value: "1", unit: "hours" });

  return (
    <>
      {initial.withWait ? (
        <FlowStep tone="wait" icon={<Clock size={16} aria-hidden />} connect>
          <div className="rounded-lg border bg-background p-3 shadow-sm">
            <WaitFields draft={wait} onChange={setWait} />
          </div>
        </FlowStep>
      ) : null}
      <FlowStep tone={channel} icon={channelIcon(channel)} connect>
        <MessageEditor
          action={createMessageAction}
          hiddenFields={{ trigger_event: triggerEvent, business_tour_id: businessTourId ?? "" }}
          draft={{ ...EMPTY_DRAFT, channel: initial.channel }}
          delayMinutes={initial.withWait ? waitToMinutes(wait) : 0}
          waTemplates={waTemplates}
          submitLabel={submitLabel}
          onSaved={onClose}
          onCancel={onClose}
          onChannelChange={setChannel}
        />
      </FlowStep>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Automation cards                                                          */
/* -------------------------------------------------------------------------- */

function StepsLabel() {
  return (
    <li className="flex gap-3">
      <div className="w-8" aria-hidden />
      <p className="flex-1 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Then send
      </p>
    </li>
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
  // Add-action flow: closed -> picker open -> editor open for the chosen kind.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [newAction, setNewAction] = useState<ActionChoice | null>(null);

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
          <FlowStep tone="trigger" icon={<Zap size={16} aria-hidden />} connect>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Trigger
            </p>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">When</span>
              <TriggerSelect value={triggerEvent} />
              <span className="font-medium">for</span>
              <TriggerProductSelect
                triggerEvent={triggerEvent}
                businessTourId={businessTourId}
                products={products}
              />
            </div>
          </FlowStep>

          <StepsLabel />

          {steps.map((step) => (
            <Fragment key={step.id}>
              {step.delay_minutes > 0 ? (
                <WaitStep rule={step} />
              ) : openId === step.id ? (
                <AddWaitRow ruleId={step.id} />
              ) : null}
              <MessageStep
                rule={step}
                waTemplates={waTemplates}
                open={openId === step.id}
                onToggle={() => setOpenId((current) => (current === step.id ? null : step.id))}
              />
            </Fragment>
          ))}

          {newAction ? (
            <NewMessageStep
              triggerEvent={triggerEvent}
              businessTourId={businessTourId}
              waTemplates={waTemplates}
              initial={newAction}
              onClose={() => setNewAction(null)}
            />
          ) : null}
        </ol>

        {newAction ? null : pickerOpen ? (
          <ActionPicker
            onPick={(choice) => {
              setNewAction(choice);
              setPickerOpen(false);
            }}
            onCancel={() => setPickerOpen(false)}
          />
        ) : (
          <div className="pl-11">
            <Button type="button" variant="ghost" size="sm" onClick={() => setPickerOpen(true)}>
              <Plus size={16} aria-hidden />
              Add action
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Author a brand-new automation entirely locally; one Save creates it. */
function NewAutomationCard({
  products,
  waTemplates,
  onClose,
}: {
  products: ProductOption[];
  waTemplates: WaTemplateOption[];
  onClose: () => void;
}) {
  const [trigger, setTrigger] = useState<string>(TRIGGERS[0].value);
  const [productId, setProductId] = useState("");
  const [firstAction, setFirstAction] = useState<ActionChoice | null>(null);

  return (
    <div className="rounded-xl border bg-card shadow-sm">
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">New automation</p>
      </div>
      <div className="px-4 py-4">
        <ol>
          <FlowStep tone="trigger" icon={<Zap size={16} aria-hidden />} connect>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Trigger
            </p>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">When</span>
              <TriggerSelect value={trigger} onChange={setTrigger} />
              <span className="font-medium">for</span>
              <Select
                value={productId}
                onChange={(event) => setProductId(event.target.value)}
                className="h-9 w-auto max-w-full"
                aria-label="Trigger product"
              >
                <ProductOptions products={products} />
              </Select>
            </div>
          </FlowStep>

          <StepsLabel />

          {firstAction ? (
            <NewMessageStep
              triggerEvent={trigger}
              businessTourId={productId || null}
              waTemplates={waTemplates}
              initial={firstAction}
              submitLabel="Create automation"
              onClose={onClose}
            />
          ) : null}
        </ol>

        {firstAction ? null : (
          <ActionPicker onPick={setFirstAction} onCancel={onClose} />
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page-level lists                                                          */
/* -------------------------------------------------------------------------- */

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
  const [addingAutomation, setAddingAutomation] = useState(false);

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
      {groups.length === 0 && !addingAutomation ? (
        <div className="rounded-xl border border-dashed bg-muted/20 px-6 py-10 text-center">
          <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg border bg-background">
            <Zap size={20} className="text-muted-foreground" aria-hidden />
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

      {addingAutomation ? (
        <NewAutomationCard
          products={products}
          waTemplates={waTemplates}
          onClose={() => setAddingAutomation(false)}
        />
      ) : (
        <Button type="button" variant="outline" size="lg" onClick={() => setAddingAutomation(true)}>
          <Plus size={16} aria-hidden />
          Add automation
        </Button>
      )}
    </div>
  );
}

/** WhatsApp template rows: click one to read the full message, click to close. */
export function WhatsappTemplateList({ templates }: { templates: WaTemplateOption[] }) {
  const [openSid, setOpenSid] = useState<string | null>(null);

  return (
    <ul className="space-y-2">
      {templates.map((template) => {
        const open = openSid === template.sid;
        return (
          <li key={template.sid} className="rounded-xl border bg-card shadow-sm">
            <button
              type="button"
              onClick={() => setOpenSid((current) => (current === template.sid ? null : template.sid))}
              aria-expanded={open}
              className="block w-full px-4 py-3 text-left"
            >
              <span className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{template.name}</span>
                <Badge tone={STATUS_TONE[template.status] ?? "neutral"}>{template.status}</Badge>
                <ChevronDown
                  size={16}
                  className="ml-auto shrink-0 text-muted-foreground"
                  style={{
                    transform: open ? "rotate(180deg)" : "none",
                    transition: "transform 150ms ease",
                  }}
                  aria-hidden
                />
              </span>
              {open ? (
                <span className="mt-2 block rounded-lg border bg-muted/40 px-3 py-2">
                  <span className="block text-sm whitespace-pre-wrap break-words">
                    {template.body}
                  </span>
                </span>
              ) : (
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {template.body}
                </span>
              )}
              {template.rejectionReason ? (
                <span
                  className={cn(
                    "mt-1 block text-xs text-red-600",
                    !open && "truncate",
                  )}
                >
                  Rejected: {template.rejectionReason}
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function AddWhatsappTemplateForm() {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(createWhatsappTemplateAction, INITIAL);

  if (!open) {
    return (
      <Button type="button" variant="outline" size="lg" onClick={() => setOpen(true)}>
        <Plus size={16} aria-hidden />
        Add template
      </Button>
    );
  }

  return (
    <form action={formAction} className="rounded-xl border bg-card p-4 shadow-sm">
      <p className="text-sm font-medium">Add a WhatsApp template</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Use numbered placeholders like {"{{1}}"} for dynamic values; you connect them to
        real values in an automation.
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
          Template submitted. It shows as pending until WhatsApp approves it.
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
