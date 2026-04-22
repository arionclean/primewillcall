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

## Theming

- Theme colors and scales are controlled in [`src/app/globals.css`](/Users/main/Primewillcall(new platform)/src/app/globals.css).
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
