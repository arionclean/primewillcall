# PrimeWillCall Platform Migration

PrimeWillCall is currently operated on a live production platform built with:

- Bubble.io for the application frontend and workflows.
- Xano.com for the backend and API layer.

This repository is the new platform implementation. The target stack is:

- Vercel for hosting and deployment.
- Next.js for the web application.
- Supabase for the database, auth, storage, and backend services where appropriate.

## Migration Principle

The existing Bubble.io + Xano.com platform is live and must be treated as production-critical. Do not modify, delete, overwrite, or destructively transform Xano production data or live Bubble behavior as part of this migration.

Migration work should happen step by step:

1. Understand and document the existing Bubble/Xano behavior before rebuilding it.
2. Model the equivalent Supabase schema and application workflows in this repository.
3. Import or sync legacy data in non-destructive ways.
4. Validate parity between the old and new platform before routing users to new functionality.
5. Cut over only after the replacement workflow has been tested and approved.

## Operational Guardrails

- Treat Xano as the source of truth until a specific domain has been migrated and validated.
- Prefer read-only inspection of Xano production data.
- Use additive migrations in Supabase whenever possible.
- Keep legacy import scripts repeatable and auditable.
- Avoid destructive operations unless there is an explicit backup, rollback path, and approval.
- Migrate one functional area at a time instead of attempting a full platform rewrite in one step.

## Current Repository Role

This repo is the staged replacement platform. It should accumulate the new Supabase schema, Next.js routes, UI components, import tooling, and documentation needed to move PrimeWillCall from the current Bubble/Xano implementation to a Vercel/Supabase implementation safely.
