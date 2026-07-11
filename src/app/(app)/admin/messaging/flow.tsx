"use client";

import { MessageCircle, MessageSquare } from "lucide-react";

import { cn } from "@/lib/utils";

import type { Channel } from "./messaging-lib";

/**
 * Presentational pieces for the automation flow: the node chip + connector
 * rail, the on/off switch, and the SMS/WhatsApp segmented control.
 */

const NODE_TONES = {
  trigger:
    "border-amber-200 bg-amber-50 text-amber-600 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300",
  sms: "border-blue-200 bg-blue-50 text-blue-600 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300",
  whatsapp:
    "border-emerald-200 bg-emerald-50 text-emerald-600 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300",
  wait: "border-indigo-200 bg-indigo-50 text-indigo-600 dark:border-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-300",
} as const;

export type NodeTone = keyof typeof NODE_TONES;

/** One row of the vertical flow: an icon chip, a connector line, and content. */
export function FlowStep({
  tone,
  icon,
  connect,
  children,
}: {
  tone: NodeTone;
  icon: React.ReactNode;
  connect?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <div className="flex flex-col items-center">
        <span
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border",
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

export function channelIcon(channel: Channel) {
  return channel === "whatsapp" ? (
    <MessageCircle className="h-4 w-4" aria-hidden />
  ) : (
    <MessageSquare className="h-4 w-4" aria-hidden />
  );
}

/** An on/off switch. With `name`, it also submits its value via a hidden input. */
export function Switch({
  checked,
  onChange,
  name,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  name?: string;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <>
      {name ? <input type="hidden" name={name} value={checked ? "1" : "0"} /> : null}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60",
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

const CHANNELS: { value: Channel; label: string }[] = [
  { value: "sms", label: "Text (SMS)" },
  { value: "whatsapp", label: "WhatsApp" },
];

/** A two-option segmented control for picking the channel. */
export function ChannelToggle({
  value,
  onChange,
}: {
  value: Channel;
  onChange: (value: Channel) => void;
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
