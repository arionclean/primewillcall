"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatUsPhoneDisplay, maskUsPhoneInput, normalizeUsPhone } from "@/lib/sms/format";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

interface SmsMessage {
  id: string;
  direction: "inbound" | "outbound";
  from_phone: string;
  to_phone: string;
  body: string;
  tag: string | null;
  status: string | null;
  created_at: string;
}

interface Conversation {
  counterpart: string;
  last_body: string;
  last_direction: "inbound" | "outbound";
  last_at: string;
  message_count: number;
}

// Untyped client: the sms tables are newer than the generated Database types.
function getSmsClient(): SupabaseClient {
  return getSupabaseBrowserClient() as unknown as SupabaseClient;
}

function counterpartOf(message: SmsMessage): string {
  return message.direction === "inbound" ? message.from_phone : message.to_phone;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function MessagesClient() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [messages, setMessages] = useState<SmsMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [sending, setSending] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeRef = useRef<string | null>(null);
  activeRef.current = active;
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  const loadConversations = useCallback(async () => {
    const { data, error: rpcError } = await getSmsClient().rpc("sms_conversations");
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setConversations((data as Conversation[]) ?? []);
  }, []);

  const openThread = useCallback(async (counterpart: string) => {
    setActive(counterpart);
    const { data, error: queryError } = await getSmsClient()
      .from("sms_messages")
      .select("id, direction, from_phone, to_phone, body, tag, status, created_at")
      .or(`from_phone.eq."${counterpart}",to_phone.eq."${counterpart}"`)
      .order("created_at", { ascending: true })
      .limit(500);
    if (queryError) {
      setError(queryError.message);
      return;
    }
    setMessages((data as SmsMessage[]) ?? []);
  }, []);

  const runSync = useCallback(async () => {
    setSyncing(true);
    try {
      const response = await fetch("/api/sms/sync", { method: "POST" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Twilio sync failed");
      }
    } finally {
      setSyncing(false);
      await loadConversations();
      if (activeRef.current) {
        await openThread(activeRef.current);
      }
    }
  }, [loadConversations, openThread]);

  // Initial load + background history sync from Twilio.
  useEffect(() => {
    loadConversations();
    runSync();
  }, [loadConversations, runSync]);

  // Live updates for new messages (inbound via webhook, outbound via sends).
  useEffect(() => {
    const supabase = getSmsClient();
    const channel = supabase
      .channel("sms-messages")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "sms_messages" },
        (payload) => {
          const row = payload.new as SmsMessage;
          if (counterpartOf(row) === activeRef.current) {
            setMessages((current) =>
              current.some((message) => message.id === row.id) ? current : [...current, row],
            );
          }
          loadConversations();
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadConversations]);

  // Safety nets for the conversation list: realtime can miss inserts when the
  // tab is backgrounded or the socket drops, so also refresh when the tab
  // regains focus and on a slow poll. Keeps new inbound threads appearing
  // without a manual reload.
  useEffect(() => {
    const refresh = () => {
      loadConversations();
      if (activeRef.current) {
        openThread(activeRef.current);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        refresh();
      }
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    const interval = window.setInterval(loadConversations, 20_000);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(interval);
    };
  }, [loadConversations, openThread]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  async function sendMessage(to: string, body: string) {
    if (!body.trim()) {
      return false;
    }
    setSending(true);
    setError(null);
    try {
      const response = await fetch("/api/sms/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, body: body.trim(), tag: "chat" }),
      });
      const result = (await response.json()) as { sent?: boolean; reason?: string; error?: string };
      if (!response.ok || !result.sent) {
        setError(result.reason ?? result.error ?? "Failed to send");
        return false;
      }
      return true;
    } finally {
      setSending(false);
    }
  }

  async function handleSendDraft() {
    if (!active) {
      return;
    }
    const ok = await sendMessage(active, draft);
    if (ok) {
      setDraft("");
      await openThread(active);
      await loadConversations();
    }
  }

  async function handleStartConversation() {
    const normalized = normalizeUsPhone(newPhone);
    if (!normalized) {
      setError("Enter a valid US phone number");
      return;
    }
    setNewPhone("");
    setError(null);
    await openThread(normalized);
  }

  return (
    <div className="flex h-[calc(100dvh-9rem)] min-h-[480px] overflow-hidden rounded-lg border border-border bg-background">
      <aside className="flex w-80 shrink-0 flex-col border-r border-border">
        <div className="space-y-2 border-b border-border p-4">
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-semibold">Messages</h1>
            {syncing ? <span className="text-xs text-muted-foreground">Syncing...</span> : null}
          </div>
          <div className="flex gap-2">
            <Input
              type="tel"
              placeholder="(305) 555-0123"
              value={newPhone}
              onChange={(event) => setNewPhone(maskUsPhoneInput(event.target.value))}
            />
            <Button size="sm" variant="outline" onClick={handleStartConversation}>
              New
            </Button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {conversations.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              {syncing ? "Loading conversations..." : "No conversations yet."}
            </p>
          ) : (
            conversations
              .slice()
              .sort((a, b) => (a.last_at < b.last_at ? 1 : -1))
              .map((conversation) => (
                <button
                  key={conversation.counterpart}
                  onClick={() => openThread(conversation.counterpart)}
                  className={`block w-full border-b border-border px-4 py-3 text-left hover:bg-muted/50 ${
                    active === conversation.counterpart ? "bg-muted" : ""
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">
                      {formatUsPhoneDisplay(conversation.counterpart)}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatTime(conversation.last_at)}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {conversation.last_direction === "outbound" ? "You: " : ""}
                    {conversation.last_body}
                  </p>
                </button>
              ))
          )}
        </div>
      </aside>

      <section className="flex flex-1 flex-col">
        {active ? (
          <>
            <header className="border-b border-border px-6 py-4">
              <h2 className="text-base font-semibold">{formatUsPhoneDisplay(active)}</h2>
            </header>
            <div className="flex-1 space-y-3 overflow-y-auto px-6 py-4">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`flex ${message.direction === "outbound" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[70%] rounded-2xl px-4 py-2 text-sm ${
                      message.direction === "outbound"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted"
                    }`}
                  >
                    <p className="whitespace-pre-wrap break-words">{message.body}</p>
                    <p
                      className={`mt-1 text-[10px] ${
                        message.direction === "outbound"
                          ? "text-primary-foreground/70"
                          : "text-muted-foreground"
                      }`}
                    >
                      {formatTime(message.created_at)}
                      {message.status === "failed" ? " · failed" : ""}
                    </p>
                  </div>
                </div>
              ))}
              <div ref={threadEndRef} />
            </div>
            <footer className="border-t border-border p-4">
              {error ? <p className="mb-2 text-sm text-destructive">{error}</p> : null}
              <div className="flex gap-2">
                <textarea
                  rows={2}
                  placeholder="Type a message..."
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      handleSendDraft();
                    }
                  }}
                  className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
                <Button onClick={handleSendDraft} disabled={sending || !draft.trim()}>
                  {sending ? "Sending..." : "Send"}
                </Button>
              </div>
            </footer>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-muted-foreground">
              {error ?? "Select a conversation or start a new one."}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
