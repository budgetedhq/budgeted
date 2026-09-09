# Budgeted

Budgeted is a web-based personal budgeting app. You host it in your own AWS account.

## Budgeting philosophy

Budgeted is an opinionated app. It is inspired by the **envelope
system**. You budget money via categories and assign your spending transactions to these categories. Your accounts track **where your money is** and the categories track
**what it is for**.

## Primary Features

- A clean, well designed user interface
- Monthly budget planning on a calendar year cycle
- Programmable transaction entry templates for split transactions
- Account balance tracking and reconciliation
- Spending and category tracking reports
- YNAB ledger import

## Optional Features

- Plaid integration for automatic transaction importing from your bank or credit card
- AI-assisted transaction classification suggestions
- Amazon Orders integration for adding purchase details and transaction matching suggestions
- Venmo integration for importing payment activity

## Installation

Coming soon: setup instructions using the Budgeted Launcher.

## Releases

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

## Documentation

See the [documentation](documentation/README.md) for technical and feature guides.
