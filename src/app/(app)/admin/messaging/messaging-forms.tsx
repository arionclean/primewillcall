"use client";

import { useMemo, useState } from "react";
import { useActionState } from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  createRuleAction,
  createWhatsappTemplateAction,
  deleteRuleAction,
  updateRuleAction,
  type MessagingActionState,
} from "./actions";

export type RuleRow = {
  id: string;
  name: string;
  business_tour_id: string | null;
  channel: "sms" | "whatsapp";
  body: string | null;
  whatsapp_content_sid: string | null;
  whatsapp_variables: Record<string, string> | null;
  only_first_contact: boolean;
  is_active: boolean;
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

const selectClass =
  "h-9 rounded-md border bg-background px-2.5 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50";

function RuleCard({
  rule,
  products,
  waTemplates,
}: {
  rule: RuleRow;
  products: ProductOption[];
  waTemplates: WaTemplateOption[];
}) {
  const [state, formAction, pending] = useActionState(updateRuleAction, INITIAL);
  const [channel, setChannel] = useState<"sms" | "whatsapp">(rule.channel);
  const [body, setBody] = useState(rule.body ?? "");
  const [waSid, setWaSid] = useState(rule.whatsapp_content_sid ?? "");

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
    <div className="rounded-lg border p-4">
      <form action={formAction} className="space-y-4">
        <input type="hidden" name="rule_id" value={rule.id} />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Input
            name="rule_name"
            defaultValue={rule.name}
            className="h-9 w-56 font-medium"
            aria-label="Rule name"
          />
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="rule_active"
                value="1"
                defaultChecked={rule.is_active}
                className="h-4 w-4 rounded border-input"
              />
              Active
            </label>
            <button
              formAction={deleteRuleAction}
              onClick={(event) => {
                if (!confirm(`Delete the rule "${rule.name}"?`)) event.preventDefault();
              }}
              className="rounded-md p-2 text-muted-foreground transition hover:bg-red-50 hover:text-red-600"
              aria-label="Delete rule"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm">
          <span>When a</span>
          <span className="rounded-md bg-muted px-2 py-1 font-medium">new booking</span>
          <span>comes in for</span>
          <select
            name="rule_product"
            defaultValue={rule.business_tour_id ?? ""}
            className={selectClass}
          >
            <option value="">Any product</option>
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name} ({product.businessName})
              </option>
            ))}
          </select>
          <span>send a</span>
          <select
            name="rule_channel"
            value={channel}
            onChange={(event) => setChannel(event.target.value as "sms" | "whatsapp")}
            className={selectClass}
          >
            <option value="sms">Text message (SMS)</option>
            <option value="whatsapp">WhatsApp template</option>
          </select>
        </div>

        {channel === "sms" ? (
          <div>
            <textarea
              name="rule_body"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={3}
              className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50"
            />
            <p className="mt-2 text-xs text-muted-foreground">
              Placeholders:{" "}
              {PLACEHOLDERS.map((placeholder) => (
                <button
                  key={placeholder}
                  type="button"
                  onClick={() => setBody((current) => `${current}{{${placeholder}}}`)}
                  title={PLACEHOLDER_LABELS[placeholder]}
                  className="mr-2 rounded bg-muted px-1.5 py-0.5 font-mono transition hover:bg-muted/70"
                >
                  {`{{${placeholder}}}`}
                </button>
              ))}
            </p>
            {body.trim() ? (
              <p className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">Preview: </span>
                {renderPreview(body)}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3">
            {approved.length === 0 ? (
              <p className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                No approved WhatsApp templates yet. Add one in the section below;
                once WhatsApp approves it, you can pick it here.
              </p>
            ) : (
              <select
                name="rule_wa_template"
                value={waSid}
                onChange={(event) => setWaSid(event.target.value)}
                className={`${selectClass} w-full max-w-md`}
              >
                <option value="">Pick an approved template...</option>
                {approved.map((template) => (
                  <option key={template.sid} value={template.sid}>
                    {template.name}
                  </option>
                ))}
              </select>
            )}

            {selectedTemplate ? (
              <div className="rounded-md bg-muted/40 px-3 py-2">
                <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                  {selectedTemplate.body}
                </p>
                {waSlots.length > 0 ? (
                  <div className="mt-3 space-y-2">
                    {waSlots.map((slot) => (
                      <label key={slot} className="flex items-center gap-2 text-sm">
                        <code className="rounded bg-muted px-1.5 py-0.5">{`{{${slot}}}`}</code>
                        <span className="text-muted-foreground">is</span>
                        <select
                          name={`wa_var_${slot}`}
                          defaultValue={rule.whatsapp_variables?.[slot] ?? ""}
                          className={selectClass}
                        >
                          <option value="">Pick a value...</option>
                          {PLACEHOLDERS.map((placeholder) => (
                            <option key={placeholder} value={placeholder}>
                              {PLACEHOLDER_LABELS[placeholder]}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              name="rule_first_contact"
              value="1"
              defaultChecked={rule.only_first_contact}
              className="h-4 w-4 rounded border-input"
            />
            Only the first time we ever text this customer
          </label>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Saving..." : "Save rule"}
          </Button>
        </div>

        {state.error ? (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {state.error}
          </p>
        ) : null}
        {state.saved ? (
          <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            Saved. New bookings will follow this rule.
          </p>
        ) : null}
      </form>
    </div>
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
  return (
    <div className="space-y-4">
      {rules.length === 0 ? (
        <p className="rounded-md border border-dashed bg-muted/30 px-3 py-3 text-sm text-muted-foreground">
          No rules yet. Add the first one.
        </p>
      ) : (
        rules.map((rule) => (
          <RuleCard key={rule.id} rule={rule} products={products} waTemplates={waTemplates} />
        ))
      )}

      <form action={createRuleAction}>
        <Button type="submit" variant="outline">
          Add rule
        </Button>
      </form>
    </div>
  );
}

export function AddWhatsappTemplateForm() {
  const [state, formAction, pending] = useActionState(createWhatsappTemplateAction, INITIAL);

  return (
    <form action={formAction} className="rounded-lg border p-4">
      <p className="text-sm font-medium">Add a WhatsApp template</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        It is sent to WhatsApp for approval automatically. Use numbered placeholders
        like {"{{1}}"} for dynamic values; you connect them to real values when you
        use the template in a rule.
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
            className={`${selectClass} mt-1 w-full`}
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
