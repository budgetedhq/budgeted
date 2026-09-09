# Budgeted Agent Guide

Budgeted is a single-user budgeting app built with Next.js, Auth.js, SST,
DynamoDB, and ElectroDB. It manages reusable global budget setup, monthly budget
periods, category allocations, transactions, account balances, and reporting
from a shared ledger source of truth.

The product is intentionally dark-only. Do not add light-mode preferences,
theme toggles, or alternate light theme paths.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Stack and Commands

- Use Node.js 22+ and pnpm. This repository is pinned to `pnpm@11.25.0`.
- `pnpm dev` runs the app through SST with linked infrastructure.
- `pnpm dev:turbo` is the internal Turbopack runner and requires SST resource
  linkage.
- `pnpm dev:webpack` is a diagnostic fallback and requires SST resource
  linkage.
- `pnpm test` runs unit and integration tests.
- `pnpm test:contract` runs route contract tests.
- `pnpm test:e2e` starts or reuses the development SST stage, then runs Playwright.
- `pnpm test:perf` runs local performance harnesses.
- `pnpm lint` runs ESLint.
- `pnpm build` runs the Next.js production build.

After substantial code changes, run the narrowest useful test command first,
then run `pnpm lint` or `pnpm build` when the change touches shared types,
routing, app shell, or framework boundaries.

## Repository Shape

- `src/app` contains App Router pages, layouts, and route handlers.
- `src/components` contains UI components grouped by workspace area.
- `src/features/<area>/models` contains form/query/request models and
  validation-facing types.
- `src/features/<area>/server` contains use-case services that coordinate
  persistence, domain logic, and cross-feature effects.
- `src/modules` contains pure domain logic for budgeting, ledger, and reporting.
  Prefer putting framework-independent calculations here.
- `src/lib` contains shared infrastructure: API errors, auth, database schema,
  environment helpers, formatting, theme recipes, navigation, and workspace
  readiness.
- `tests/unit`, `tests/integration`, `tests/contract`, `tests/e2e`, and
  `tests/perf` mirror the app's risk layers.

## Product Rules

- Treat the ledger as the source of truth for balances and reporting.
- Keep Global Budget reusable setup separate from month-specific Budget
  allocation state.
- Preserve single-owner assumptions. Auth and bootstrap flows are for one owner
  account, not a multi-tenant workspace product.
- Account balances derive from opening balance plus balanced ledger postings.
- Deletion workflows must preview impact, validate preview freshness, and keep
  affected budget periods/reporting consistent after deletion.
- Budget month navigation must not mutate untouched future months unless the
  user saves month-specific changes.

## Coding Conventions

- Prefer small functions with one clear responsibility.
- Keep domain calculations pure where practical and test them under
  `tests/unit/modules`.
- Keep App Router page components focused on auth, data loading, readiness
  states, and composition. Move write logic into feature server services.
- Use shared API errors and validation helpers from `src/lib/api` rather than
  ad hoc route responses.
- Use ElectroDB entities through `getBudgetedSchema()` from `src/lib/db/schema`.
- Preserve user scoping with `userId` on all persisted records and queries.
- Use `ulid()` for new application ids when following existing entity patterns.
- Prefer explicit cents integers for money. Use shared formatting utilities for
  display.
- Keep imports using the `@/` alias for source modules.
- Do not introduce new global state, client caches, or persistence layers unless
  the feature requires them and the tradeoff is documented.

## UI Conventions

- This is an operational budgeting workspace, not a marketing site. Prioritize
  dense, scannable, predictable interfaces.
- Prefer tables for CRUD lists.
- Prefer add/edit/delete flows in dialogs.
- Prefer square or minimally rounded corners; do not introduce pill-heavy or
  highly rounded visual language unless matching existing components.
- Use existing dark theme CSS variables and `theme-recipes` helpers.
- Keep workspace status, empty, loading, and failure states explicit. When reads
  fail, communicate that the last saved data is unchanged when that is true.
- Do not add decorative gradients, bokeh/orb backgrounds, or landing-page-style
  hero sections to workspace pages.

## Testing Guidance

- For pure domain changes, add or update unit tests in `tests/unit/modules`.
- For feature server services, add or update unit tests in
  `tests/unit/features`.
- For page composition and user-visible flows, add or update integration tests.
- For route handlers, update contract tests.
- For navigation, persistence, deletion, auth, and browser-only behavior, update
  Playwright coverage.
- Keep tests focused on behavior and invariants rather than implementation
  details.

Useful targeted commands:

```bash
pnpm exec vitest run tests/unit/modules
pnpm exec vitest run tests/unit/features
pnpm exec vitest run tests/integration
pnpm test:contract
pnpm test:e2e
```

## Environment Notes

- Runtime authentication requires the SST-linked `AuthSecret`; do not add
  `AUTH_SECRET` or `NEXTAUTH_SECRET` environment fallbacks.
- Managed E2E testing expects `.env.local` with `E2E_AUTH_SECRET`,
  `E2E_USER_EMAIL`, and `E2E_USER_PASSWORD`.
- Direct Next.js runners require SST-linked application resources;
  `APP_TABLE_NAME` alone is not a supported authenticated runtime.
- `pnpm test:e2e` can manage local SST startup, but if `PLAYWRIGHT_BASE_URL` is
  set it runs against that existing server.
- Do not commit secrets, generated local environment files, `.next`, or test
  artifacts.

## Working Practices

- Read the relevant code and tests before editing. This codebase has explicit
  patterns for cross-feature consistency, especially around ledger writes,
  budget period sync, and deletion.
- Keep changes scoped to the requested behavior. Avoid opportunistic refactors
  unless they reduce risk for the current change.
- Preserve existing user work in the git tree. Do not reset or discard unrelated
  changes.
- For TypeScript/library uncertainty, check local docs first. Use Context7 or
  official documentation when current library behavior matters.
- Before touching Next.js APIs, read the relevant local guide under
  `node_modules/next/dist/docs/`.
