"use client";

import { Lock } from "lucide-react";
import { useTransition } from "react";

import { lockWebEmployeeAction } from "@/app/(app)/employee-actions";

/**
 * Who is at the keyboard on a shared login, and the way to hand it over: the
 * whole chip is the Lock button, like the tablet's. A full reload follows so the
 * browser client stops sending the employee header.
 */
export function EmployeeChip({ name }: { name: string }) {
  const [pending, startTransition] = useTransition();
  const first = name.trim().split(/\s+/)[0] || name;
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await lockWebEmployeeAction();
          window.location.reload();
        })
      }
      className="inline-flex items-center gap-2 rounded-full bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-700 disabled:opacity-60"
      aria-label={`${first}, lock the screen`}
    >
      {first}
      <span className="inline-flex items-center gap-1 text-sky-300">
        <Lock className="size-3" aria-hidden />
        Lock
      </span>
    </button>
  );
}
