"use client";

import { Delete } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";

import { unlockWebEmployeeAction } from "@/app/(app)/employee-actions";
import { cn } from "@/lib/utils";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "back"] as const;

/**
 * The PIN screen for a shared login, the web twin of the tablet's keypad. It
 * covers the whole app until a valid PIN is typed; four digits submit on their
 * own, from the on-screen keys or the keyboard. Nothing behind it renders, so
 * there is nothing to reach around it.
 */
export function WebPinLock({ accountName }: { accountName: string }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = useCallback(
    (candidate: string) => {
      const fd = new FormData();
      fd.set("pin", candidate);
      startTransition(async () => {
        const r = await unlockWebEmployeeAction({}, fd);
        if (r.unlocked) {
          // A full reload so the browser client starts sending the employee header.
          window.location.reload();
          return;
        }
        setPin("");
        setError(r.error ?? "Wrong PIN");
      });
    },
    [startTransition],
  );

  const press = useCallback(
    (k: string) => {
      if (pending) return;
      setError(null);
      if (k === "back") {
        setPin((p) => p.slice(0, -1));
        return;
      }
      setPin((p) => (p.length >= 4 ? p : p + k));
    },
    [pending],
  );

  // The fourth digit submits. Done here rather than inside the state updater,
  // which React may run twice in development and would send the PIN twice.
  const submitted = useRef<string | null>(null);
  useEffect(() => {
    if (pin.length === 4 && submitted.current !== pin) {
      submitted.current = pin;
      submit(pin);
    }
    if (pin.length < 4) submitted.current = null;
  }, [pin, submit]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") press("back");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900 text-white">
      <div className="flex w-80 flex-col items-center">
        <p className="text-sm text-slate-400">{accountName}</p>
        <h1 className="mt-1 text-2xl font-semibold">Enter your PIN</h1>
        <div className="mt-6 flex gap-4">
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className={cn(
                "size-4 rounded-full border-2 border-slate-400",
                i < pin.length && "border-white bg-white",
                error && "border-red-400",
              )}
            />
          ))}
        </div>
        <p className="mt-3 h-5 text-sm text-red-400" aria-live="polite">
          {error ?? ""}
        </p>
        <div className="mt-4 grid grid-cols-3 gap-3">
          {KEYS.map((k, i) => (
            <button
              key={i}
              type="button"
              disabled={!k || pending}
              onClick={() => press(k)}
              aria-label={k === "back" ? "Delete" : k}
              className={cn(
                "flex size-20 items-center justify-center rounded-full text-3xl font-light transition",
                k ? "bg-white/10 hover:bg-white/20 active:bg-white/30" : "invisible",
                pending && "opacity-50",
              )}
            >
              {k === "back" ? <Delete className="size-7" aria-hidden /> : k}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
