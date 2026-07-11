"use client";

import { MessageCircle, MessageSquare } from "lucide-react";

import { cn } from "@/lib/utils";

import type { Channel } from "./messaging-lib";

/**
 * Presentational pieces for the automation flow: the node chip + connector
 * rail, the on/off switch, and the SMS/WhatsApp segmented control.
 *
 * The chip and switch carry their size and color as explicit styles instead of
 * utility classes: these tiny atoms kept rendering wrong under stale dev
 * stylesheets, and pinning their pixels makes them immune to that class of
 * problem. The app has no dark-mode toggle today; revisit these if it gets one.
 */

const NODE_STYLES = {
  trigger: { backgroundColor: "#fffbeb", borderColor: "#fde68a", color: "#d97706" },
  sms: { backgroundColor: "#eff6ff", borderColor: "#bfdbfe", color: "#2563eb" },
  whatsapp: { backgroundColor: "#ecfdf5", borderColor: "#a7f3d0", color: "#059669" },
  wait: { backgroundColor: "#eef2ff", borderColor: "#c7d2fe", color: "#4f46e5" },
} as const;

export type NodeTone = keyof typeof NODE_STYLES;

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
          className="flex shrink-0 items-center justify-center border"
          style={{ width: 32, height: 32, borderRadius: 10, ...NODE_STYLES[tone] }}
        >
          {icon}
        </span>
        {connect ? (
          <span
            className="my-1 flex-1"
            style={{ width: 1, backgroundColor: "var(--border)" }}
          />
        ) : null}
      </div>
      <div className={cn("min-w-0 flex-1", connect ? "pb-4" : "pb-0")}>{children}</div>
    </li>
  );
}

/** Channel icons sized via SVG attributes so no stylesheet can distort them. */
export function channelIcon(channel: Channel) {
  return channel === "whatsapp" ? (
    <MessageCircle size={16} aria-hidden />
  ) : (
    <MessageSquare size={16} aria-hidden />
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
        className="relative inline-flex shrink-0 cursor-pointer items-center outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60"
        style={{
          width: 36,
          height: 20,
          borderRadius: 9999,
          padding: 2,
          backgroundColor: checked ? "#10b981" : "rgba(115, 115, 115, 0.35)",
          transition: "background-color 150ms ease",
          border: "none",
        }}
      >
        <span
          style={{
            display: "inline-block",
            width: 16,
            height: 16,
            borderRadius: 9999,
            backgroundColor: "#ffffff",
            boxShadow: "0 1px 2px rgba(0, 0, 0, 0.2)",
            transform: checked ? "translateX(16px)" : "translateX(0)",
            transition: "transform 150ms ease",
          }}
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
