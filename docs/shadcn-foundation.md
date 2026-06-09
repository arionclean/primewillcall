# shadcn/ui Foundation Guide

This document is the source of truth for UI consistency in PrimeWillCall.

## Goals

- Keep one consistent visual language across the app.
- Reuse the same components for the same jobs.
- Avoid one-off styling and duplicate UI patterns.

## Core Rules

1. Build UI from shadcn components first, not custom Tailwind blocks.
2. Use design tokens (`bg-background`, `text-foreground`, `text-muted-foreground`, `border`, `ring`) instead of hardcoded colors.
3. Keep border radius and spacing aligned to existing component defaults.
4. Prefer `variant` and `size` props before creating new custom classes.
5. New components must be added through shadcn CLI and committed as source.

## Approved Base Components

Use these as defaults:

- Actions: `Button`
- Text input: `Input`, `Textarea`
- Choice: `Checkbox`, `RadioGroup`, `Select`, `Switch`
- Grouping: `Card`, `Tabs`, `Accordion`, `Separator`
- Feedback: `Alert`, `Badge`, `Skeleton`, `Toast`
- Overlays: `Dialog`, `Sheet`, `DropdownMenu`, `Popover`
- Data display: `Table`

## PrimeWillCall primitives and conventions

This project uses a small, hand-built set of shadcn-style primitives in
`src/components/ui/` rather than the full CLI catalog. Reach for these first:

- `Button`, `Input`, `Textarea`, `Select`, `Card`, `Badge` — base primitives.
- `Field` — wraps a control with its label, hint, and inline error. Use for every form field.
- `FormSection` — a titled section (title sits outside the card) for grouping fields.
- `PhoneInput` — masked US phone (`(XXX) XXX-XXXX` while typing, digits stored). Use for
  every phone field. Never a raw `Input` for phones.
- `DateField` — date input that opens the native calendar and blocks manual typing. Use
  for every date field. Booking times come from the tour's timeslots, not a free input.

Hard copy conventions (see `../CLAUDE.md`):

- No em dashes anywhere. Use periods, commas, or parentheses.
- Never expose internal data jargon (for example "variant" or "master tour") to
  managers or check-in staff. Use plain, customer-facing language.
- Icon-only buttons (lucide-react) require an `aria-label` or an `sr-only` label.

Before adding a brand-new primitive, confirm one of the above does not already cover it.

## Standard Patterns

### Page Shell

- Page root uses `bg-background text-foreground`.
- Use a single max width container (`max-w-5xl` or `max-w-7xl`).
- Keep main page sections spaced with consistent vertical rhythm (`gap-6`, `gap-8`, or `space-y-6`).

### Forms

- Every field has a visible label.
- Validation appears near the field and uses destructive token styles.
- Primary form action is right-aligned and uses `Button` default variant.
- Secondary actions use `outline` or `ghost`.

### Cards

- Use `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`.
- Do not recreate card paddings/margins manually when shadcn sections already cover it.

### Tables

- Use shadcn `Table` primitives only.
- Row actions should use `DropdownMenu` or an action `Button` with clear labels.

### Popups And Modal Motion

- Use shadcn `Dialog`, `Sheet`, `Popover`, or `DropdownMenu` primitives for popup behavior whenever possible.
- All modal-style popups should open with the same motion pattern used in the bookings product filter.
- Render fixed, modal-style popups through a portal to `document.body` when the trigger is inside a sidebar, sticky element, card, or any other stacking context.
- Backdrop/overlay classes:

```tsx
className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4 py-6 animate-in fade-in duration-200"
```

- Modal panel classes:

```tsx
className="rounded-xl border bg-card shadow-2xl animate-in fade-in zoom-in-95 slide-in-from-bottom-4 duration-300"
```

- Keep popup surfaces on app tokens (`bg-card`, `text-foreground`, `border`, `bg-muted/40`) and use the default `Button` primary action in the footer.
- Do not mount modal popups with no entrance animation unless the interaction is intentionally instant, such as a tiny dropdown menu.

## Theming

- Theme colors and scales are controlled in [`src/app/globals.css`](../src/app/globals.css).
- Do not define ad-hoc color values in components unless product-approved.
- If a new token is required, add it centrally in `globals.css` and document why in the PR.

## Accessibility Baseline

- Keep keyboard navigation intact for all controls.
- Ensure focus is visible (never remove focus styles without replacement).
- Icon-only buttons require `aria-label`.
- Maintain semantic heading order (`h1` > `h2` > `h3`).

## Adding New UI Components

1. Check if an existing shadcn component already solves the need.
2. If missing, add with CLI:

```bash
npx shadcn@latest add <component-name>
```

3. Use component in at least one real feature before adding abstractions.
4. If wrapped in shared app component, keep wrapper thin and prop-compatible.

## Review Checklist (Required)

- Uses shadcn primitives where applicable.
- Uses design tokens, not custom hardcoded palette.
- Reuses existing variants/sizes.
- Matches spacing and typography rhythm in nearby screens.
- Includes accessibility basics (labels, focus, keyboard support).

If a PR breaks these rules, request changes before merge.
