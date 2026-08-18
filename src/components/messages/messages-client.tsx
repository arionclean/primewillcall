"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatUsPhoneDisplay, normalizeUsPhone } from "@/lib/sms/format";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

type Channel = "sms" | "whatsapp";

interface ThreadMessage {
  id: string;
  channel: Channel;
  direction: "inbound" | "outbound";
  from_phone: string;
  to_phone: string;
  body: string;
  status: string | null;
  created_at: string;
}

interface Conversation {
  counterpart: string;
  customer_name: string | null;
  last_body: string;
  last_direction: "inbound" | "outbound";
  last_at: string;
  last_channel: Channel;
  message_count: number;
  has_sms: boolean;
  has_whatsapp: boolean;
  whatsapp_window_open: boolean;
}

// Untyped client: the messaging tables and RPCs are newer than the generated types.
function getMessagingClient(): SupabaseClient {
  return getSupabaseBrowserClient() as unknown as SupabaseClient;
}

const CHANNEL_LABEL: Record<Channel, string> = { sms: "SMS", whatsapp: "WhatsApp" };

/** One screenful at a time. The rest arrives as the list is scrolled. */
const PAGE_SIZE = 50;

/**
 * Call one of the messaging edge functions. Sending and history sync live in
 * Supabase (that is where the Twilio credentials are), and `invoke` attaches the
 * signed-in staff member's token, which the function turns back into their staff row.
 *
 * On a non-2xx the SDK gives us an error whose `context` is the raw Response, so
 * read the body from there to recover the function's own reason.
 */
async function invokeMessagingFunction<T>(
  name: "sms-send" | "sms-sync" | "whatsapp-send",
  body?: Record<string, unknown>,
): Promise<{ data: T | null; error: string | null }> {
  const { data, error } = await getMessagingClient().functions.invoke<T>(name, { body });
  if (!error) {
    return { data: data ?? null, error: null };
  }
  const response = (error as { context?: Response }).context;
  const payload = (await response?.json?.().catch(() => null)) as
    | { error?: string; reason?: string }
    | null;
  return { data: (payload as T) ?? null, error: payload?.reason ?? payload?.error ?? error.message };
}

/**
 * Send-as chip styling. WhatsApp carries the same green as its badge while the
 * window is open and goes grey when it closes, so the composer and the header
 * never disagree about whether a typed reply will go through.
 */
function channelChipClass(channel: Channel, selected: boolean, windowOpen: boolean): string {
  if (channel === "whatsapp" && windowOpen) {
    return selected
      ? "border-emerald-500 bg-emerald-500/15 text-emerald-700 dark:border-emerald-500 dark:text-emerald-300"
      : "border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-900 dark:text-emerald-300 dark:hover:bg-emerald-950/40";
  }
  return selected
    ? "border-primary bg-primary/10 text-primary"
    : "border-border text-muted-foreground hover:bg-muted/50";
}

function counterpartOf(message: ThreadMessage): string {
  return message.direction === "inbound" ? message.from_phone : message.to_phone;
}

const WINDOW_MS = 24 * 60 * 60 * 1000;

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
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sendAs, setSendAs] = useState<Channel>("sms");
  const [activeName, setActiveName] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [sending, setSending] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeRef = useRef<string | null>(null);
  activeRef.current = active;
  const queryRef = useRef("");
  queryRef.current = query;
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  // A search term that is really a phone number doubles as "message this person",
  // so there is no second input to explain.
  const typedPhone = useMemo(() => normalizeUsPhone(search), [search]);

  // A thread that has used both channels labels every bubble; a single-channel
  // thread says it once in the header instead of repeating it on every message.
  const threadIsMixed = useMemo(() => {
    const channels = new Set(messages.map((message) => message.channel));
    return channels.size > 1;
  }, [messages]);

  // WhatsApp free-form is only legal inside the 24-hour window the customer's
  // reply opens. Read both facts off the thread itself rather than off the
  // conversation row: searching or paging can filter that row out of the
  // sidebar, and an open thread must not change what it lets you send just
  // because the list next to it was filtered.
  const canOfferWhatsapp = useMemo(
    () => messages.some((message) => message.channel === "whatsapp"),
    [messages],
  );
  // Green means a typed reply is allowed. `now` is a state value on a one minute
  // tick, not Date.now() read during render, so the badge goes grey by itself
  // when the window expires on a tab that has been open all day.
  const whatsappWindowOpen = useMemo(() => {
    const cutoff = now - WINDOW_MS;
    return messages.some(
      (message) =>
        message.channel === "whatsapp" &&
        message.direction === "inbound" &&
        new Date(message.created_at).getTime() > cutoff,
    );
  }, [messages, now]);
  const threadHasSms = useMemo(
    () => messages.some((message) => message.channel === "sms"),
    [messages],
  );
  const blockedByWindow = sendAs === "whatsapp" && !whatsappWindowOpen;

  /** Fetch one page. `before` is the oldest last_at already held (keyset paging). */
  const fetchPage = useCallback(
    async (before: string | null, term: string): Promise<Conversation[] | null> => {
      const { data, error: rpcError } = await getMessagingClient().rpc("messaging_conversations", {
        p_limit: PAGE_SIZE,
        p_before: before,
        p_search: term.trim() || null,
      });
      if (rpcError) {
        console.error("[messages] conversations load failed:", rpcError);
        setError("Could not load conversations. Try again.");
        return null;
      }
      return (data as Conversation[]) ?? [];
    },
    [],
  );

  /**
   * Reload the newest page and keep whatever else is already on screen. Used on
   * first paint and whenever a message arrives, so a live update never throws
   * away the pages someone scrolled to.
   */
  const loadConversations = useCallback(async () => {
    const page = await fetchPage(null, queryRef.current);
    if (!page) return;
    setConversations((current) => {
      const merged = new Map(current.map((row) => [row.counterpart, row]));
      for (const row of page) merged.set(row.counterpart, row);
      return [...merged.values()].sort((a, b) => (a.last_at < b.last_at ? 1 : -1));
    });
    if (page.length < PAGE_SIZE) setHasMore(false);
  }, [fetchPage]);

  /** Replace the list: a new search term invalidates every loaded page. */
  const resetConversations = useCallback(
    async (term: string) => {
      const page = await fetchPage(null, term);
      if (!page) return;
      setConversations(page);
      setHasMore(page.length === PAGE_SIZE);
    },
    [fetchPage],
  );

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || conversations.length === 0) return;
    setLoadingMore(true);
    try {
      const oldest = conversations[conversations.length - 1].last_at;
      const page = await fetchPage(oldest, queryRef.current);
      if (!page) return;
      setConversations((current) => {
        const merged = new Map(current.map((row) => [row.counterpart, row]));
        for (const row of page) merged.set(row.counterpart, row);
        return [...merged.values()].sort((a, b) => (a.last_at < b.last_at ? 1 : -1));
      });
      if (page.length < PAGE_SIZE) setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  }, [conversations, fetchPage, hasMore, loadingMore]);

  const openThread = useCallback(async (counterpart: string, name?: string | null) => {
    setActive(counterpart);
    if (name !== undefined) setActiveName(name);
    const { data, error: rpcError } = await getMessagingClient().rpc("messaging_thread", {
      p_counterpart: counterpart,
    });
    if (rpcError) {
      console.error("[messages] thread load failed:", rpcError);
      setError("Could not open this conversation. Try again.");
      return;
    }
    const thread = (data as ThreadMessage[]) ?? [];
    setMessages(thread);
    // Reply where the customer wrote from: default to the channel of their last
    // inbound message, falling back to SMS, which is always available.
    const lastInbound = [...thread].reverse().find((message) => message.direction === "inbound");
    setSendAs(lastInbound?.channel ?? "sms");
  }, []);

  const runSync = useCallback(async () => {
    setSyncing(true);
    try {
      const { error: syncError } = await invokeMessagingFunction("sms-sync");
      if (syncError) {
        // The function's reason is for the log, not for a manager reading a phone.
        console.error("[messages] sync failed:", syncError);
        setError("Could not refresh messages. Try again.");
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

  // Let typing settle before querying, so a name is one round trip, not six.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    resetConversations(query);
  }, [query, resetConversations]);

  // Live updates for new messages on either channel (inbound via the Twilio
  // webhook, outbound via our own sends).
  useEffect(() => {
    const supabase = getMessagingClient();
    const absorb = (row: ThreadMessage) => {
      if (counterpartOf(row) === activeRef.current) {
        setMessages((current) =>
          current.some((message) => message.id === row.id) ? current : [...current, row],
        );
      }
      loadConversations();
    };
    const channel = supabase
      .channel("messaging-threads")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "sms_messages" },
        (payload) => absorb({ ...(payload.new as ThreadMessage), channel: "sms" }),
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "whatsapp_messages" },
        (payload) => absorb({ ...(payload.new as ThreadMessage), channel: "whatsapp" }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadConversations]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  // The window closes on its own, so the countdown has to move without a reload.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  async function sendMessage(to: string, body: string): Promise<boolean> {
    if (!body.trim()) {
      return false;
    }
    setSending(true);
    setError(null);
    try {
      const { data, error: sendError } = await invokeMessagingFunction<{
        sent?: boolean;
        reason?: string;
      }>(
        sendAs === "whatsapp" ? "whatsapp-send" : "sms-send",
        sendAs === "whatsapp"
          ? { to, body: body.trim() }
          : { to, body: body.trim(), tag: "chat" },
      );
      if (sendError || !data?.sent) {
        setError(sendError ?? data?.reason ?? "Failed to send");
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

  async function handleStartConversation(phone: string) {
    setSearch("");
    setError(null);
    await openThread(phone, null);
  }

  return (
    <div className="flex h-[calc(100dvh-9rem)] min-h-[480px] overflow-hidden rounded-lg border border-border bg-background">
      <aside className="flex w-80 shrink-0 flex-col border-r border-border">
        <div className="space-y-2 border-b border-border p-4">
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-semibold">Messages</h1>
            {syncing ? <span className="text-xs text-muted-foreground">Syncing...</span> : null}
          </div>
          <Input
            type="search"
            placeholder="Search a name or number"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {typedPhone && !conversations.some((row) => row.counterpart === typedPhone) ? (
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={() => handleStartConversation(typedPhone)}
            >
              Start a conversation with {formatUsPhoneDisplay(typedPhone)}
            </Button>
          ) : null}
        </div>
        <div
          className="flex-1 overflow-y-auto"
          onScroll={(event) => {
            const el = event.currentTarget;
            // Start the next page before the scrollbar actually bottoms out.
            if (el.scrollHeight - el.scrollTop - el.clientHeight < 240) {
              loadMore();
            }
          }}
        >
          {conversations.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              {syncing
                ? "Loading conversations..."
                : query
                  ? "No conversations match that search."
                  : "No conversations yet."}
            </p>
          ) : (
            conversations
              .slice()
              .sort((a, b) => (a.last_at < b.last_at ? 1 : -1))
              .map((conversation) => (
                <button
                  key={conversation.counterpart}
                  onClick={() => openThread(conversation.counterpart, conversation.customer_name)}
                  className={`block w-full border-b border-border px-4 py-3 text-left hover:bg-muted/50 ${
                    active === conversation.counterpart ? "bg-muted" : ""
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium">
                      {conversation.customer_name ?? formatUsPhoneDisplay(conversation.counterpart)}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatTime(conversation.last_at)}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {conversation.last_direction === "outbound" ? "You: " : ""}
                    {conversation.last_body}
                  </p>
                  {conversation.has_whatsapp ? (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {conversation.has_sms ? <Badge>SMS</Badge> : null}
                      <Badge tone={conversation.whatsapp_window_open ? "success" : "neutral"}>
                        WhatsApp
                      </Badge>
                    </div>
                  ) : null}
                </button>
              ))
          )}
          {conversations.length > 0 ? (
            <p className="p-3 text-center text-xs text-muted-foreground">
              {loadingMore ? "Loading more..." : hasMore ? "" : "End of conversations"}
            </p>
          ) : null}
        </div>
      </aside>

      <section className="flex flex-1 flex-col">
        {active ? (
          <>
            <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-6 py-4">
              <h2 className="text-base font-semibold">
                {activeName ?? formatUsPhoneDisplay(active)}
              </h2>
              {activeName ? (
                <span className="text-sm text-muted-foreground">
                  {formatUsPhoneDisplay(active)}
                </span>
              ) : null}
              {threadHasSms ? <Badge>SMS</Badge> : null}
              {canOfferWhatsapp ? (
                <Badge
                  tone={whatsappWindowOpen ? "success" : "neutral"}
                  title={
                    whatsappWindowOpen
                      ? "You can reply freely on WhatsApp"
                      : "They have to message again before you can reply on WhatsApp"
                  }
                >
                  WhatsApp
                </Badge>
              ) : null}
            </header>
            <div className="flex-1 space-y-3 overflow-y-auto px-6 py-4">
              {messages.map((message) => (
                <div
                  key={`${message.channel}-${message.id}`}
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
                      {threadIsMixed ? `${CHANNEL_LABEL[message.channel]} · ` : ""}
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
              {canOfferWhatsapp ? (
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Send as</span>
                  {(["sms", "whatsapp"] as const).map((channel) => (
                    <button
                      key={channel}
                      type="button"
                      onClick={() => setSendAs(channel)}
                      title={
                        channel === "whatsapp" && !whatsappWindowOpen
                          ? "They have to message again before you can reply on WhatsApp"
                          : undefined
                      }
                      className={`rounded-full border px-3 py-1 text-xs font-medium ${channelChipClass(
                        channel,
                        sendAs === channel,
                        whatsappWindowOpen,
                      )}`}
                    >
                      {CHANNEL_LABEL[channel]}
                    </button>
                  ))}
                </div>
              ) : null}
              {blockedByWindow ? (
                <p className="mb-2 text-xs text-muted-foreground">
                  The 24 hour WhatsApp window has closed, so a typed reply cannot be sent.
                  Use SMS, or wait for them to message again.
                </p>
              ) : null}
              <div className="flex gap-2">
                <textarea
                  rows={2}
                  placeholder={`Type a message... (${CHANNEL_LABEL[sendAs]})`}
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
                <Button
                  onClick={handleSendDraft}
                  disabled={sending || !draft.trim() || blockedByWindow}
                >
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
