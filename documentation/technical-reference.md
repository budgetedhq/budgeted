# Budgeted technical reference

Budgeted is a self-hosted web budgeting app built on Next.js, Auth.js, SST, DynamoDB, and ElectroDB. It tracks reusable budget-plan setup, monthly budget periods, category allocations, transactions, and reporting views from the same ledger source of truth.

The product UI is dark-only. There is no light-mode switch or alternate theme preference in the application shell.

## Prerequisites

- Node.js 22.22.2+, 24.15.0+, or 26+
- pnpm 11+
- AWS credentials for the target SST stage when using linked infrastructure

## Local setup

Install dependencies and create a local environment file.

```bash
corepack enable
pnpm install
cp .env.example .env.local
```

Runtime authentication accepts only the SST-linked `AuthSecret`. Configure a
random value of at least 32 characters for each stage before running the app:

```bash
pnpm exec sst secret set AuthSecret '<random-32-plus-character-secret>' --stage <stage>
```

`AUTH_SECRET` and `NEXTAUTH_SECRET` environment variables are intentionally not
runtime fallbacks. Authenticated development must run with SST-linked resources.

`AuthSecret` is the only mandatory SST secret. Optional integrations use these
secrets when configured; unset values leave the corresponding feature
unavailable:

- Amazon Orders: `AmazonOrderScraperApiToken`
- Plaid: `PlaidClientId` and `PlaidSecret`
- AI classification: `GoogleGenerativeAiApiKey` and/or `OpenAiApiKey`

Create the first user with:

```bash
pnpm seed:user -- --email <email> --password <password> --role super --stage <stage>
```

## Development commands

- `pnpm dev`: runs the app through `sst dev` with linked infrastructure
- `pnpm dev:turbo`: internal Turbopack runner; requires SST resource linkage
- `pnpm dev:webpack`: diagnostic webpack runner; requires SST resource linkage
- `pnpm seed:user`: creates or updates a user

The local host and port can be set with Next-style flags on the supported
SST-backed development command:

```bash
pnpm dev -- --hostname 127.0.0.1 --port 3005
```

Local HTTPS uses the same Next dev flags:

```bash
pnpm dev -- --experimental-https
```

The same settings can be supplied in `.env.local` or the shell as `BUDGETED_DEV_HOSTNAME`, `BUDGETED_DEV_PORT`, and `BUDGETED_DEV_HTTPS=1`. With only `BUDGETED_DEV_HTTPS=1`, the dev wrapper prepares local mkcert files when needed and starts Next.js with its built-in HTTPS server. `PORT` is still accepted for the port. Command-line flags take precedence over environment values. Custom local certificates are optional; use `BUDGETED_DEV_HTTPS_KEY`, `BUDGETED_DEV_HTTPS_CERT`, and optionally `BUDGETED_DEV_HTTPS_CA` when needed.

When Turbopack state gets corrupted, clear `.next/dev` before retrying. The repo
keeps `pnpm dev:webpack` as a linked-resource fallback, but the supported entry
point is SST-backed `pnpm dev`. Running either Next.js wrapper outside an
SST-linked environment does not provide application authentication.

`pnpm dev` does not create or update SST secrets. Manage stage secrets with `pnpm exec sst secret set ...` or `pnpm exec sst secret load ...` before starting SST-backed development.

## Testing

- `pnpm test`: unit and integration tests
- `pnpm test:contract`: route contract coverage
- `pnpm test:perf`: local performance harnesses for summary, write, and reporting paths
- `pnpm test:e2e`: starts or reuses the E2E SST stage, resets its DynamoDB table, then runs Playwright

Managed-local Playwright runs default to the `e2e` SST stage so browser tests use a separate DynamoDB table from normal development. Before each managed run, Playwright global setup resets that linked table with the shared reset executor, preserving user accounts and clearing budget/workspace data. The command can take a while because it may need to start `sst dev`; use it only when browser-level validation is needed.

For managed local browser validation, keep `E2E_AUTH_SECRET`,
`E2E_USER_EMAIL`, and `E2E_USER_PASSWORD` in `.env.local` and run:

```bash
pnpm test:e2e
pnpm test:e2e -- tests/e2e/persistence.spec.ts
```

`pnpm test:e2e` loads `E2E_AUTH_SECRET` into the E2E stage as its linked
`AuthSecret` before starting `sst dev`. The application never reads
`E2E_AUTH_SECRET` directly. The test user is seeded with `pnpm seed:user` from
`E2E_USER_EMAIL` and `E2E_USER_PASSWORD`, and Playwright global setup resets the
linked table before creating the isolated E2E ledger. To override the isolated
stage intentionally, pass `--stage <stage>` with
`E2E_ALLOW_NON_E2E_RESET=1`.

If you already have a compatible server running, set `PLAYWRIGHT_BASE_URL` and keep the same `E2E_USER_EMAIL` and `E2E_USER_PASSWORD` values available for authenticated browser specs.

When `PLAYWRIGHT_BASE_URL` is set, `pnpm test:e2e` does not start SST dev and only runs Playwright against the explicit target.

For the workspace-usability flow, validate the saved-state continuity path with:

```bash
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 pnpm exec playwright test tests/e2e/navigation.spec.ts tests/e2e/persistence.spec.ts tests/e2e/budget-period.spec.ts tests/e2e/transactions.spec.ts
```

If you already have a server running, set `PLAYWRIGHT_BASE_URL` and run `pnpm exec playwright test` directly.

For the always-on dark-mode feature, validate the shared theme boundary and route continuity with:

```bash
pnpm exec vitest run tests/unit/lib/theme/theme-recipes.test.ts tests/integration/dashboard/navigation.test.tsx tests/integration/dashboard/theme-shell.test.tsx tests/integration/transactions-ledger.test.tsx tests/integration/budget-attention.test.tsx tests/integration/budget-mutation-feedback.test.tsx tests/integration/reporting-carry-forward.test.tsx tests/integration/reporting-summary.test.tsx

PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 pnpm exec playwright test tests/e2e/navigation.spec.ts tests/e2e/theme.spec.ts
```

For the managed item deletion workflows, validate the shared deletion boundary, route contracts, integration flows, and browser coverage with:

```bash
pnpm exec vitest run tests/unit/features/shared/deletion-impact.test.ts tests/unit/features/shared/deletion-policy.test.ts tests/unit/features/shared/post-delete-consistency.test.ts tests/unit/features/accounts/account-deletion.test.ts tests/unit/features/budget/category-deletion.test.ts tests/unit/features/transactions/transaction-deletion.test.ts tests/contract/transactions-routes.test.ts tests/integration/accounts/account-deletion-cascade.test.tsx tests/integration/budget/category-deletion-cascade.test.tsx tests/integration/transactions-ledger.test.tsx

PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 pnpm exec playwright test tests/e2e/account-deletion.spec.ts tests/e2e/category-deletion.spec.ts tests/e2e/category-uncategorized.spec.ts tests/e2e/transaction-deletion.spec.ts
```

For the assignment-logic and budget month-navigation flow, validate month-end account balances, selected-month query resolution, allocation alignment, untouched future-month defaults, and browser navigation continuity with:

```bash
pnpm exec vitest run tests/unit/features/accounts/account-balance-service.test.ts tests/integration/budget-month-navigation.test.tsx tests/integration/budget-allocations.test.ts tests/contract/budget-periods.test.ts

PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 pnpm exec playwright test tests/e2e/budget-period.spec.ts
```

For the budget plan flow, validate the split between `Budget Plan` reusable setup and month-specific `Budget` allocation workspaces, plus untouched-month derivation, saved-month independence, income-category-only allocation saves, synchronized Starting Balances inflows, and route coverage with:

```bash
pnpm exec vitest run tests/integration/dashboard/navigation.test.tsx tests/integration/dashboard/readiness.test.tsx tests/integration/budget/global-budget-page.test.tsx tests/unit/modules/budgeting/global-plan.test.ts tests/unit/features/budget/global-plan-service.test.ts tests/unit/features/budget/starting-balances-service.test.ts tests/unit/features/accounts/account-service.test.ts tests/integration/budget/global-plan-initialization.test.ts tests/integration/budget/global-plan-updates.test.ts tests/integration/budget-allocations.test.ts tests/integration/budget-month-navigation.test.tsx tests/integration/budget-mutation-feedback.test.tsx tests/integration/accounts/account-starting-balances-sync.test.ts tests/integration/budget/category-deletion-cascade.test.tsx tests/contract/budget-plan.test.ts tests/contract/budget-periods.test.ts tests/contract/accounts-routes.test.ts

PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 pnpm exec playwright test tests/e2e/global-budget-plan.spec.ts
```

## Deployment

- `pnpm deploy`: deploys the production stage with SST

### GitHub releases

Create releases only through the repository release command. It validates a
clean and synchronized `main`, runs the install, test, typecheck, lint, and
production-build gates, updates the package and generated application versions,
creates the release commit and tag, pushes both atomically, creates the stable
GitHub release, then downloads and validates the exact source archive used by
Budgeted Launcher.

```bash
pnpm run release 0.1.2
pnpm run release 0.1.2 --notes "Fixes reconciliation totals."
```

Use a version greater than every existing release tag. The command requires an
authenticated GitHub CLI session and does not deploy Budgeted to AWS.
`--notes` accepts Markdown and adds it before GitHub's generated release notes.
The production build receives a random, build-only SST `AuthSecret` binding;
the command verifies that value was not retained in the build output.
All child-command pagers are disabled. If a run is interrupted after its tag or
GitHub release is created, rerun the same version to finish verification.

Copy the example config, review the production-stage settings, and deploy:

```bash
cp config/budgeted-config.example.toml config/budgeted-config.toml
pnpm deploy
```

The standard example contains the user-facing choices most installations need.
To customize deployment safeguards, retention, worker sizing, schedules, or
timeouts, start from the complete advanced example instead:

```bash
cp config/budgeted-advanced-config.example.toml config/budgeted-config.toml
```

`config/budgeted-config.toml` is ignored by git. It contains non-secret,
stage-specific application and infrastructure settings. Credentials remain SST
secrets and must not be added to this file.

The advanced example shows every supported setting. Values omitted from a stage
use these defaults:

- Application name `budgeted` and production stage `production`
- Production resources protected and retained; other stages removable
- Plaid environment `sandbox`; Amazon order scraper disabled without `apiUrl`
- SST asset cleanup enabled only in production, with a three-day retention
- Automation enabled only in production, every two minutes, with no retries
- Ledger exports retained one day and YNAB imports retained two days
- Automation and YNAB worker timeout 15 minutes; web timeout 60 seconds
- YNAB worker memory 2 GB and upload CORS origins `*`

`integrations.amazonOrders.apiUrl` and `integrations.plaid.environment` are
ordinary configuration. `AmazonOrderScraperApiToken`, `PlaidClientId`, and
`PlaidSecret` remain SST secrets.

Production can optionally use an SST-managed custom domain for the web app.

For DNS hosted outside Route 53, provide the existing ACM certificate and use
external mode:

```toml
[stages.production]
webDomain.name = "budgeted.example.com"
webDomain.dns = "external"
webDomain.cert = "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"
```

The deployment output `webDomainExternalDnsRecords` contains the CNAME to add
at the external DNS provider. The certificate must cover the configured domain
and be issued in `us-east-1` for CloudFront.

When the domain has an existing public hosted zone in Route 53, use managed
mode instead:

```toml
[stages.production]
webDomain.name = "budgeted.example.com"
webDomain.dns = "aws"
```

SST creates the Route 53 records and ACM certificate validation automatically.
If more than one hosted zone could match, set `webDomain.route53ZoneId`.

If the stage does not define `webDomain`, the app keeps the default SST URL.

The lower-level `appCnameTarget` output remains available for either mode.

### Transaction importer data migration

Amazon payments and Venmo activities are stored only as canonical transaction
import activities. Before deploying this cutover, preview the production
migration for the intended ledger:

```bash
AWS_PROFILE=your-profile pnpm migrate:transaction-importers -- --stage production --ledger-id <ledgerId> --dry-run
```

The dry run must report no conflicting activities or missing source activities.
Deploy the canonical importer code manually, then apply the migration immediately
after that deployment succeeds and only after confirming the ledger id:

```bash
AWS_PROFILE=your-profile pnpm migrate:transaction-importers -- --stage production --ledger-id <ledgerId> --apply --confirm <ledgerId>
```

Apply mode is idempotent. It writes missing canonical activities, removes the
retired Amazon payment and Venmo activity items, strips embedded importer
metadata from transactions, preserves an existing transaction memo, fills an
empty transaction memo from a Venmo memo, and rebuilds workspace state. Rerun
the dry run after the apply; all legacy and stripped-transaction counts should
be zero. Deployment remains a manual operation.

### Venmo email ingestion

Venmo ingestion is provisioned only for stages with a `venmoEmail` entry in
`config/budgeted-config.toml`. The recipient's domain is a dedicated inbox
domain for this processor. For DNS hosted outside Route 53, use external mode:

```toml
[stages.production]
venmoEmail.allowedForwarders = ["trusted-forwarder@example.com"]
venmoEmail.dns = "external"
venmoEmail.recipient = "venmo@aws.example.com"
```

After deployment, add every TXT and MX entry from the
`venmoEmailExternalDnsRecords` output at the domain's DNS provider. The TXT
record verifies domain ownership with SES; the regional MX record directs the
inbox domain to SES.

When the domain has an existing public hosted zone in Route 53, use managed
mode instead:

```toml
[stages.production]
venmoEmail.allowedForwarders = ["trusted-forwarder@example.com"]
venmoEmail.dns = "aws"
venmoEmail.recipient = "venmo@aws.example.com"
```

SST creates the TXT and MX records and waits for SES domain verification. If
more than one Route 53 hosted zone could match, set
`venmoEmail.route53ZoneId`. Managed mode does not register a domain or create a
hosted zone.

The stack creates and activates its own SES receipt rule set. SES supports only
one active receipt rule set per AWS account and Region, so this configuration
must own email receiving in that Region. Its recipient-specific rule saves MIME
under `venmo-emails/` in a private bucket, invokes the handler asynchronously,
and stops further receipt-rule processing. Raw objects expire after seven days;
failed Lambda events are retried twice and retained in a seven-day failure
queue.

`allowedForwarders` is optional. Each entry must be the exact authenticated
sender of a trusted manual forward. Forwarded messages are accepted only when
their embedded forwarded-message header identifies `venmo@venmo.com`; normal
direct delivery continues to require Venmo as the top-level sender.

Deployment remains manual:

```bash
AWS_PROFILE=your-profile pnpm deploy
```

After deployment, open Utilities > Venmo, choose the existing non-Plaid account
that represents the Venmo balance, and enable the inbox. Then configure Gmail
to forward Venmo mail to the configured `recipient`. If Gmail sends a forwarding
verification message, retrieve its code from the temporary S3 object before the
seven-day expiration. Verify that SES reports the inbox domain as verified and
that the new receipt rule set is active. Bulk historical backfill and manual
`.eml` upload are not part of this integration.
