"use client";

import { useState } from "react";

import { NewStaffForm } from "@/app/(app)/admin/staff/(owner)/new/form";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

/**
 * "+ Add account" opens the team member form in a dialog, the same way People
 * adds an employee, so both tabs create things the same way. Saving redirects
 * back to Accounts, which closes it.
 */
export function AddAccount({
  businesses,
  tours,
}: {
  businesses: { id: string; name: string }[];
  tours: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        + Add account
      </Button>
      {open && (
        <Dialog
          title="Add account"
          description="A login for a manager, or a shared desk or tablet."
          size="lg"
          onClose={() => setOpen(false)}
        >
          <NewStaffForm
            businesses={businesses}
            tours={tours}
            onCancel={() => setOpen(false)}
            submitLabel="Add account"
          />
        </Dialog>
      )}
    </>
  );
}
