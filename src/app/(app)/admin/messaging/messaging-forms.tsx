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
  type MessagingActionState,
} from "./actions";
import { FlowStep, Switch, channelIcon } from "./flow";
import { EMPTY_DRAFT, MessageEditor } from "./message-editor";
import {
  ANY_KEY,
  STATUS_TONE,
  TRIGGERS,
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

/** The instant "Add action" editor: pure local state, saved only on Create. */
function NewMessageStep({
  triggerEvent,
  businessTourId,
  waTemplates,
  onClose,
}: {
  triggerEvent: string;
  businessTourId: string | null;
  waTemplates: WaTemplateOption[];
  onClose: () => void;
}) {
  const [channel, setChannel] = useState<Channel>("sms");
  return (
    <FlowStep tone={channel} icon={channelIcon(channel)} connect>
      <MessageEditor
        action={createMessageAction}
        hiddenFields={{ trigger_event: triggerEvent, business_tour_id: businessTourId ?? "" }}
        draft={EMPTY_DRAFT}
        waTemplates={waTemplates}
        submitLabel="Create message"
        onSaved={onClose}
        onCancel={onClose}
        onChannelChange={setChannel}
      />
    </FlowStep>
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
  const [adding, setAdding] = useState(false);

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
                <FlowStep tone="wait" icon={<Clock size={16} aria-hidden />} connect>
                  <p className="text-sm font-medium">Wait {humanizeMinutes(step.delay_minutes)}</p>
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

          {adding ? (
            <NewMessageStep
              triggerEvent={triggerEvent}
              businessTourId={businessTourId}
              waTemplates={waTemplates}
              onClose={() => setAdding(false)}
            />
          ) : null}
        </ol>

        {!adding ? (
          <div className="pl-11">
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(true)}>
              <Plus size={16} aria-hidden />
              Add action
            </Button>
          </div>
        ) : null}
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
  const [channel, setChannel] = useState<Channel>("sms");

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

          <FlowStep tone={channel} icon={channelIcon(channel)} connect>
            <MessageEditor
              action={createMessageAction}
              hiddenFields={{ trigger_event: trigger, business_tour_id: productId }}
              draft={EMPTY_DRAFT}
              waTemplates={waTemplates}
              submitLabel="Create automation"
              onSaved={onClose}
              onCancel={onClose}
              onChannelChange={setChannel}
            />
          </FlowStep>
        </ol>
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
