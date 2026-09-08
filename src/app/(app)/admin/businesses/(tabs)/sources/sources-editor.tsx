"use client";

import { ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useActionState,
  useEffect,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import {
  addSource,
  removeSource,
  reorderSources,
  setSourceShown,
  type SourceActionState,
} from "./actions";

export type SourceRow = { channel: string; is_active: boolean; sort_order: number };

type Patch =
  | { kind: "shown"; channel: string; shown: boolean }
  | { kind: "order"; order: string[] }
  | { kind: "remove"; channel: string };

function applyPatch(rows: SourceRow[], patch: Patch): SourceRow[] {
  switch (patch.kind) {
    case "shown":
      return rows.map((r) =>
        r.channel === patch.channel ? { ...r, is_active: patch.shown } : r,
      );
    case "order": {
      const byChannel = new Map(rows.map((r) => [r.channel, r]));
      return patch.order
        .map((c) => byChannel.get(c))
        .filter((r): r is SourceRow => Boolean(r));
    }
    case "remove":
      return rows.filter((r) => r.channel !== patch.channel);
  }
}

/**
 * The list with its controls. Every change is applied on screen at once
 * (useOptimistic) while the server action runs, then the page re-reads. An
 * error puts the server's rows back and shows one line under the list.
 */
export function SourcesEditor({ rows }: { rows: SourceRow[] }) {
  const router = useRouter();
  const [items, patch] = useOptimistic(rows, applyPatch);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const run = (p: Patch, action: () => Promise<{ error?: string }>) => {
    setError(null);
    startTransition(async () => {
      patch(p);
      const result = await action();
      if (result.error) setError(result.error);
      router.refresh();
    });
  };

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const order = items.map((r) => r.channel);
    [order[index], order[target]] = [order[target], order[index]];
    run({ kind: "order", order }, () => reorderSources(order));
  };

  return (
    <div className="space-y-6">
      <AddSourceForm onSaved={() => router.refresh()} />

      <Card>
        <CardContent className="p-0">
          {items.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No sources yet. Add the first one above.
            </p>
          ) : (
            <ul className="divide-y">
              {items.map((row, index) => {
                const askingToRemove = confirming === row.channel;
                return (
                  <li
                    key={row.channel}
                    className="flex items-center gap-3 px-3 py-2.5 sm:px-4"
                  >
                    <div className="flex flex-col">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        aria-label={`Move ${row.channel} up`}
                        disabled={pending || index === 0}
                        onClick={() => move(index, -1)}
                      >
                        <ChevronUp className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        aria-label={`Move ${row.channel} down`}
                        disabled={pending || index === items.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <ChevronDown className="size-4" />
                      </Button>
                    </div>

                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-sm font-medium",
                        !row.is_active && "text-muted-foreground",
                      )}
                    >
                      {row.channel}
                    </span>

                    {askingToRemove ? (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">Remove?</span>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          disabled={pending}
                          onClick={() => {
                            setConfirming(null);
                            run({ kind: "remove", channel: row.channel }, () =>
                              removeSource(row.channel),
                            );
                          }}
                        >
                          Remove
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setConfirming(null)}
                        >
                          Keep
                        </Button>
                      </div>
                    ) : (
                      <>
                        <span className="hidden text-xs text-muted-foreground sm:inline">
                          {row.is_active ? "Shown" : "Hidden"}
                        </span>
                        <Switch
                          checked={row.is_active}
                          disabled={pending}
                          label={`Show ${row.channel} on the booking form`}
                          onChange={(shown) =>
                            run({ kind: "shown", channel: row.channel, shown }, () =>
                              setSourceShown(row.channel, shown),
                            )
                          }
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground hover:text-destructive"
                          aria-label={`Remove ${row.channel}`}
                          disabled={pending}
                          onClick={() => setConfirming(row.channel)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function AddSourceForm({ onSaved }: { onSaved: () => void }) {
  const [state, formAction] = useActionState<SourceActionState, FormData>(addSource, {});
  const formRef = useRef<HTMLFormElement>(null);
  const savedRef = useRef<SourceActionState | null>(null);

  // A save clears the box and re-reads the list. Compared by identity so a
  // second identical result still counts.
  useEffect(() => {
    if (state.saved && savedRef.current !== state) {
      savedRef.current = state;
      formRef.current?.reset();
      onSaved();
    }
  }, [state, onSaved]);

  return (
    <form ref={formRef} action={formAction} className="flex items-end gap-2">
      <div className="min-w-0 flex-1 sm:max-w-sm">
        <Field label="New source" htmlFor="source-name" error={state.fieldErrors?.name}>
          <Input
            id="source-name"
            name="name"
            placeholder="Miami attractions"
            maxLength={60}
            autoComplete="off"
          />
        </Field>
      </div>
      <SubmitButton className={cn(state.fieldErrors?.name && "mb-6")}>Add</SubmitButton>
      {state.error ? <p className="text-xs text-red-700">{state.error}</p> : null}
    </form>
  );
}
