import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    createIntegrationCommittedWorkspaceMutationResponse,
    createIntegrationWorkspaceMutationResponse,
} from "./helpers/workspace-mutation-response";

const navigationMocks = vi.hoisted(() => ({
    push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    usePathname: () => "/utilities/ledger-integrity",
    useRouter: () => ({ push: navigationMocks.push }),
    useSearchParams: () => new URLSearchParams(),
}));

import { TransactionDialog } from "@/components/transactions/transaction-dialog";
import {
    AboutWorkspace,
    AutoAssignSourcesWorkspace,
    LedgerIntegrityWorkspace,
    LedgerTransferWorkspace,
    TransactionClassificationDebugWorkspace,
    TransactionClassificationLogsWorkspace,
    TransactionClassificationSettingsWorkspace,
    TransactionImportersWorkspace,
    TransactionTemplatesWorkspace,
    UtilitiesDebugWorkspace,
    UtilitiesWorkspace,
    UtilityUsersWorkspace,
} from "@/components/workspace/workspace-views";
import { FeedbackToastProvider } from "@/components/shared/feedback-toast-provider";
import { WorkspaceStoreProvider } from "@/components/workspace/workspace-store-provider";
import { APPLICATION_VERSION } from "@/lib/application-version";
import type { WorkspaceSnapshot } from "@/lib/workspace/sync-types";

function makeWorkspaceSnapshot(
    overrides: Partial<WorkspaceSnapshot> = {},
): WorkspaceSnapshot {
    return {
        accounts: [],
        activeLedgerId: "ledger-1",
        activeLedgerName: "Ledger",
        allocationFundingSources: [],
        budgetAllocations: [],
        budgetCategories: [],
        budgetGroups: [],
        budgetPeriods: [],
        knowledge: {
            entityDigests: {},
            entityRevisions: {},
            oldestRetainedWorkspaceRevision: 0,
            workspaceGeneration: 1,
            workspaceRevision: 0,
            activeLedgerId: "ledger-1",
            changeCursor: "",
            entityCounts: {
                account: 0,
                allocationFundingSource: 0,
                budgetCategory: 0,
                budgetGroup: 0,
                budgetPeriod: 0,
                categoryAllocation: 0,
                ledger: 1,
                ledgerPosting: 0,
                plaidAccountLink: 0,
                plaidTransactionSync: 0,
                transaction: 0,
                transactionLine: 0,
                transactionTemplate: 0,
            },
            generatedAt: "2026-05-01T00:00:00.000Z",
            retainedChangesAfter: "2026-04-01T00:00:00.000Z",
            revision: "test-revision",
        },
        ledgerPostings: [],
        ledgers: [
            {
                createdAt: "2026-05-01T00:00:00.000Z",
                isDefault: true,
                ledgerId: "ledger-1",
                name: "Ledger",
                status: "active",
                updatedAt: "2026-05-01T00:00:00.000Z",
                workspaceId: "global",
            },
        ],
        plaidAccountLinks: [],
        plaidTransactionSyncs: [],
        transactionTemplates: [],
        transactionLines: [],
        transactions: [],
        ...overrides,
    };
}

function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function clickComboboxOption(
    user: ReturnType<typeof userEvent.setup>,
    combobox: HTMLElement,
    optionLabel: string,
) {
    await user.click(combobox);
    await user.clear(combobox);
    await user.type(combobox, optionLabel);
    await screen.findByRole("option", {
        name: new RegExp(escapeRegExp(optionLabel), "i"),
    });
    await user.keyboard("{Enter}");
}

function TemplateManagerAndTransactionDialog({
    snapshot,
}: {
    snapshot: WorkspaceSnapshot;
}) {
    const [isTransactionDialogOpen, setIsTransactionDialogOpen] =
        useState(false);

    return (
        <>
            <TransactionTemplatesWorkspace />
            <button
                type="button"
                onClick={() => setIsTransactionDialogOpen(true)}
            >
                Open transaction modal
            </button>
            <TransactionDialog
                accounts={snapshot.accounts}
                categories={snapshot.budgetCategories}
                onClose={() => setIsTransactionDialogOpen(false)}
                open={isTransactionDialogOpen}
            />
        </>
    );
}

describe("utilities workspace", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                headers: new Headers(),
                json: async () =>
                    createIntegrationWorkspaceMutationResponse(),
            }),
        );
    });

    it("renders a card landing page with utility links for super users", () => {
        render(<UtilitiesWorkspace canManageUsers />);

        const autoAssignLink = screen.getByRole("link", {
            name: /monthly budget funding sources/i,
        });
        const aboutLink = screen.getByRole("link", { name: /^about/i });
        const importLink = screen.getByRole("link", {
            name: /import and export/i,
        });
        const usersLink = screen.getByRole("link", { name: /manage users/i });
        const templatesLink = screen.getByRole("link", {
            name: /transaction templates/i,
        });
        const classificationSettingsLink =
            screen.getByText("AI Classification").closest("a");
        const transactionImportersLink = screen.getByRole("link", {
            name: /transaction importers/i,
        });
        const debugLink = screen.getByRole("link", { name: /^debug/i });

        expect(
            screen.getByRole("list", { name: "Utilities" }),
        ).toBeInTheDocument();
        expect(autoAssignLink).toHaveAttribute("data-pane-list-item", "true");
        expect(aboutLink).toHaveAttribute("href", "/utilities/about");
        expect(autoAssignLink).toHaveClass("min-h-24", "gap-4", "p-5");
        expect(autoAssignLink).toHaveAttribute(
            "href",
            "/utilities/auto-assign",
        );
        expect(importLink).toHaveAttribute(
            "href",
            "/utilities/import-export-ledger",
        );
        expect(templatesLink).toHaveAttribute(
            "href",
            "/utilities/transaction-templates",
        );
        expect(classificationSettingsLink).toHaveAttribute(
            "href",
            "/utilities/transaction-classification-settings",
        );
        expect(transactionImportersLink).toHaveAttribute(
            "href",
            "/utilities/transaction-importers",
        );
        expect(debugLink).toHaveAttribute("href", "/utilities/debug");
        expect(usersLink).toHaveAttribute("href", "/utilities/users");
        expect(
            screen.queryByText("Import or export an entire ledger or its reusable budget plan."),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("heading", { name: "Manage user accounts" }),
        ).not.toBeInTheDocument();
    });

    it("shows release details and project links on the About page", () => {
        render(<AboutWorkspace />);

        expect(
            screen.getByRole("heading", { name: "Budgeted" }),
        ).toBeInTheDocument();
        expect(
            screen.getByText(APPLICATION_VERSION.releaseTag),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("link", { name: /github repository/i }),
        ).toHaveAttribute("href", "https://github.com/deweller/budgeted");
        expect(
            screen.getByRole("link", { name: /releases/i }),
        ).toHaveAttribute(
            "href",
            "https://github.com/deweller/budgeted/releases",
        );
    });

    it("hides the user management card for normal users", () => {
        render(<UtilitiesWorkspace canManageUsers={false} />);

        expect(
            screen.getByRole("link", { name: /import and export/i }),
        ).toHaveAttribute("href", "/utilities/import-export-ledger");
        expect(
            screen.getByRole("link", { name: /monthly budget funding sources/i }),
        ).toHaveAttribute("href", "/utilities/auto-assign");
        expect(
            screen.getByRole("link", { name: /transaction templates/i }),
        ).toHaveAttribute("href", "/utilities/transaction-templates");
        expect(screen.getByText("AI Classification").closest("a")).toHaveAttribute(
            "href",
            "/utilities/transaction-classification-settings",
        );
        expect(
            screen.getByRole("link", { name: /transaction importers/i }),
        ).toHaveAttribute("href", "/utilities/transaction-importers");
        expect(screen.getByRole("link", { name: /^debug/i })).toHaveAttribute(
            "href",
            "/utilities/debug",
        );
        expect(
            screen.queryByRole("link", { name: /manage users/i }),
        ).not.toBeInTheDocument();
    });

    it("lists diagnostic tools on the Debug page", () => {
        render(<UtilitiesDebugWorkspace />);

        expect(
            screen.getByRole("list", { name: "Debug utilities" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("link", { name: /ai classification debug/i }),
        ).toHaveAttribute(
            "href",
            "/utilities/debug/transaction-classification",
        );
        expect(screen.getByRole("link", { name: "Logs" })).toHaveAttribute(
            "href",
            "/utilities/debug/logs",
        );
        expect(
            screen.getByRole("link", { name: /ledger integrity/i }),
        ).toHaveAttribute("href", "/utilities/debug/ledger-integrity");
    });

    it("lists Amazon orders and Venmo in the Transaction Importers folder", () => {
        render(<TransactionImportersWorkspace />);

        expect(
            screen.getByRole("list", { name: "Transaction importers" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("link", { name: /amazon orders/i }),
        ).toHaveAttribute("href", "/utilities/transaction-importers/amazon-orders");
        expect(screen.getByRole("link", { name: /^venmo/i })).toHaveAttribute(
            "href",
            "/utilities/transaction-importers/venmo",
        );
    });

    it("keeps breadcrumbs on the separated utility pages", () => {
        const { rerender } = render(<LedgerTransferWorkspace />);

        let breadcrumb = screen.getByRole("navigation", {
            name: "Breadcrumb",
        });
        expect(
            within(breadcrumb).getByRole("link", { name: "Home" }),
        ).toHaveAttribute("href", "/dashboard");
        expect(
            within(breadcrumb).getByRole("link", { name: "Utilities" }),
        ).toHaveAttribute("href", "/utilities");
        expect(
            within(breadcrumb).getByText("Import and Export"),
        ).toHaveAttribute("aria-current", "page");
        expect(screen.queryByText("Ledger Transfer")).not.toBeInTheDocument();

        rerender(<UtilityUsersWorkspace canManageUsers={false} />);

        breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
        expect(
            within(breadcrumb).getByRole("link", { name: "Home" }),
        ).toHaveAttribute("href", "/dashboard");
        expect(
            within(breadcrumb).getByRole("link", { name: "Utilities" }),
        ).toHaveAttribute("href", "/utilities");
        expect(within(breadcrumb).getByText("Manage users")).toHaveAttribute(
            "aria-current",
            "page",
        );
        expect(screen.queryByText("Users")).not.toBeInTheDocument();

        rerender(<AutoAssignSourcesWorkspace />);

        breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
        expect(
            within(breadcrumb).getByRole("link", { name: "Home" }),
        ).toHaveAttribute("href", "/dashboard");
        expect(
            within(breadcrumb).getByRole("link", { name: "Utilities" }),
        ).toHaveAttribute("href", "/utilities");
        expect(
            within(breadcrumb).getByText("Monthly budget funding sources"),
        ).toHaveAttribute("aria-current", "page");

        rerender(<TransactionTemplatesWorkspace />);

        breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
        expect(
            within(breadcrumb).getByRole("link", { name: "Home" }),
        ).toHaveAttribute("href", "/dashboard");
        expect(
            within(breadcrumb).getByRole("link", { name: "Utilities" }),
        ).toHaveAttribute("href", "/utilities");
        expect(
            within(breadcrumb).getByText("Transaction templates"),
        ).toHaveAttribute("aria-current", "page");

        rerender(<TransactionClassificationSettingsWorkspace />);

        breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
        expect(
            within(breadcrumb).getByRole("link", { name: "Home" }),
        ).toHaveAttribute("href", "/dashboard");
        expect(
            within(breadcrumb).getByRole("link", { name: "Utilities" }),
        ).toHaveAttribute("href", "/utilities");
        expect(
            within(breadcrumb).getByText("AI Classification"),
        ).toHaveAttribute("aria-current", "page");

        rerender(<TransactionClassificationDebugWorkspace />);

        breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
        expect(
            within(breadcrumb).getByRole("link", { name: "Home" }),
        ).toHaveAttribute("href", "/dashboard");
        expect(
            within(breadcrumb).getByRole("link", { name: "Utilities" }),
        ).toHaveAttribute("href", "/utilities");
        expect(
            within(breadcrumb).getByRole("link", { name: "Debug" }),
        ).toHaveAttribute("href", "/utilities/debug");
        expect(
            within(breadcrumb).getByText("AI classification debug"),
        ).toHaveAttribute("aria-current", "page");

        rerender(<LedgerIntegrityWorkspace />);

        breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
        expect(
            within(breadcrumb).getByRole("link", { name: "Home" }),
        ).toHaveAttribute("href", "/dashboard");
        expect(
            within(breadcrumb).getByRole("link", { name: "Utilities" }),
        ).toHaveAttribute("href", "/utilities");
        expect(
            within(breadcrumb).getByRole("link", { name: "Debug" }),
        ).toHaveAttribute("href", "/utilities/debug");
        expect(
            within(breadcrumb).getByText("Ledger integrity"),
        ).toHaveAttribute("aria-current", "page");
    });

    it("saves AI classification system prompt instructions and model", async () => {
        const user = userEvent.setup();

        vi.mocked(fetch).mockImplementation(async (input, init) => {
            if (
                input ===
                    "/api/utilities/transaction-classification-settings" &&
                init?.method === "PATCH"
            ) {
                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () => JSON.parse(String(init.body)),
                } as Response;
            }

            if (
                input === "/api/utilities/transaction-classification-settings"
            ) {
                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({
                        availableModels: [
                            {
                                label: "Gemini 3.5 Flash",
                                modelId: "gemini-3.5-flash",
                                provider: "google",
                            },
                            {
                                label: "GPT-5.6 Luna",
                                modelId: "gpt-5.6-luna",
                                provider: "openai",
                            },
                        ],
                        modelId: "gemini-3.5-flash",
                        systemInstructions: "Prefer merchant history.",
                    }),
                } as Response;
            }

            return {
                ok: true,
                headers: new Headers(),
                json: async () => ({}),
            } as Response;
        });

        render(
            <FeedbackToastProvider>
                <TransactionClassificationSettingsWorkspace />
            </FeedbackToastProvider>,
        );

        const instructions = await screen.findByDisplayValue(
            "Prefer merchant history.",
        );
        expect(
            screen.getByText(/durable classification rules and preferences/i),
        ).toBeInTheDocument();
        expect(
            screen.queryByText("Reusable feedback guidance"),
        ).not.toBeInTheDocument();
        await user.click(
            screen.getByRole("radio", { name: /gpt-5\.6 luna/i }),
        );

        await user.clear(instructions);
        await user.type(instructions, "Prefer restaurant history.");
        await user.click(screen.getByRole("button", { name: "Save settings" }));

        const patchCall = vi
            .mocked(fetch)
            .mock.calls.find(
                ([input, init]) =>
                    input ===
                        "/api/utilities/transaction-classification-settings" &&
                    init?.method === "PATCH",
            );

        expect(patchCall).toBeTruthy();
        expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({
            modelId: "gpt-5.6-luna",
            systemInstructions: "Prefer restaurant history.",
        });
    });

    it("runs AI classification from the utilities page for a selected account", async () => {
        const user = userEvent.setup();
        const snapshot = makeWorkspaceSnapshot({
            accounts: [
                {
                    accountId: "checking",
                    accountType: "checking",
                    balanceCents: 0,
                    createdAt: "2026-05-01T00:00:00.000Z",
                    ledgerAccountId: "acct_checking",
                    ledgerId: "ledger-1",
                    name: "Checking",
                    openedOn: "2026-05-01",
                    openingBalanceCents: 0,
                    updatedAt: "2026-05-01T00:00:00.000Z",
                },
            ],
        });

        vi.mocked(fetch).mockImplementation(async (input) => {
            if (
                input ===
                "/api/utilities/transaction-classification/classify-now"
            ) {
                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({
                        accountId: "checking",
                        categoryCount: 1,
                        eligibleCount: 3,
                        errorCount: 0,
                        errors: [],
                        noSuggestionCount: 1,
                        savedCount: 2,
                        skippedCount: 1,
                    }),
                } as Response;
            }

            if (
                input === "/api/utilities/transaction-classification-settings"
            ) {
                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({
                        availableModels: [
                            {
                                label: "Gemini 3.5 Flash",
                                modelId: "gemini-3.5-flash",
                                provider: "google",
                            },
                        ],
                        modelId: "gemini-3.5-flash",
                        systemInstructions: "",
                    }),
                } as Response;
            }

            return {
                ok: true,
                headers: new Headers(),
                json: async () => ({}),
            } as Response;
        });

        render(
            <WorkspaceStoreProvider initialSnapshot={snapshot}>
                <FeedbackToastProvider>
                    <TransactionClassificationSettingsWorkspace />
                </FeedbackToastProvider>
            </WorkspaceStoreProvider>,
        );

        await screen.findByRole("button", { name: "Save settings" });
        const classifyButton = screen.getByRole("button", {
            name: "Classify",
        });
        expect(classifyButton).toBeDisabled();
        expect(
            vi
                .mocked(fetch)
                .mock.calls.find(
                    ([input]) =>
                        input ===
                        "/api/utilities/transaction-classification/classify-now",
                ),
        ).toBeUndefined();

        await clickComboboxOption(
            user,
            screen.getByRole("combobox", { name: "Account" }),
            "Checking",
        );
        await user.click(screen.getByRole("button", { name: "Classify" }));

        const classifyCall = vi
            .mocked(fetch)
            .mock.calls.find(
                ([input]) =>
                    input ===
                    "/api/utilities/transaction-classification/classify-now",
            );

        expect(classifyCall).toBeTruthy();
        expect(JSON.parse(String(classifyCall?.[1]?.body))).toEqual({
            accountId: "checking",
        });
        expect(screen.getByText("Category")).toBeInTheDocument();
    });

    it("lazy loads recent AI interactions from the Logs debug utility", async () => {
        const user = userEvent.setup();
        const writeText = vi.fn().mockResolvedValue(undefined);
        const requestText =
            "SYSTEM: classify transactions\nPROMPT: this is a long request body that should be previewed and then shown in full.";
        const responseText =
            "RESPONSE: this is a long model response body that should be previewed and then shown in full.";

        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText },
        });

        vi.mocked(fetch).mockImplementation(async (input) => {
            if (
                input ===
                "/api/utilities/transaction-classification-interactions"
            ) {
                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({
                        interactions: [
                            {
                                createdAt: "2026-07-07T12:00:00.000Z",
                                interactionId: "interaction-1",
                                modelId: "gemini-3.5-flash",
                                promptVersion: "2026-07-07.v1",
                                requestText,
                                responseText,
                            },
                        ],
                    }),
                } as Response;
            }

            return {
                ok: true,
                headers: new Headers(),
                json: async () => ({}),
            } as Response;
        });

        render(
            <FeedbackToastProvider>
                <TransactionClassificationLogsWorkspace />
            </FeedbackToastProvider>,
        );

        const disclosure = screen.getByRole("button", {
            name: "Recent AI interactions",
        });
        expect(disclosure).toHaveAttribute("aria-expanded", "false");
        expect(disclosure.querySelector("svg")).toHaveClass("text-base");
        expect(fetch).not.toHaveBeenCalled();

        await user.click(disclosure);
        expect(disclosure).toHaveAttribute("aria-expanded", "true");
        expect(
            screen.queryByRole("button", { name: "Refresh" }),
        ).not.toBeInTheDocument();

        const requestPreview = requestText;
        const responsePreview = responseText;

        expect(
            (
                await screen.findAllByText(
                    (_content, element) =>
                        element?.textContent === requestPreview,
                )
            ).length,
        ).toBeGreaterThan(0);
        expect(
            screen.getAllByText(
                (_content, element) =>
                    element?.textContent === responsePreview,
            ).length,
        ).toBeGreaterThan(0);
        expect(
            screen.getByText(`${requestText.length} characters`),
        ).toBeInTheDocument();
        expect(
            screen.getByText(`${responseText.length} characters`),
        ).toBeInTheDocument();

        await user.click(disclosure);
        expect(disclosure).toHaveAttribute("aria-expanded", "false");
        await user.click(disclosure);
        await waitFor(() =>
            expect(fetch).toHaveBeenCalledTimes(2),
        );

        await user.click(screen.getByRole("button", { name: "View" }));

        const dialog = await screen.findByRole("dialog", {
            name: "gemini-3.5-flash",
        });

        expect(
            within(dialog).getAllByText(
                (_content, element) =>
                    element?.textContent === requestText,
            ).length,
        ).toBeGreaterThan(0);
        expect(
            within(dialog).getAllByText(
                (_content, element) =>
                    element?.textContent === responseText,
            ).length,
        ).toBeGreaterThan(0);

        await user.click(within(dialog).getAllByRole("button", { name: "Copy" })[0]);

        expect(writeText).toHaveBeenCalledWith(requestText);
        expect(screen.getByText("Query copied.")).toBeInTheDocument();
    });

    it("shows AI embedding status and rebuild controls on the debug page", async () => {
        const user = userEvent.setup();

        vi.mocked(fetch).mockImplementation(async (input, init) => {
            if (input === "/api/utilities/transaction-classification-debug") {
                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({
                        accounts: [],
                        selectedAccountId: null,
                        transactions: [],
                    }),
                } as Response;
            }

            if (
                input ===
                "/api/utilities/transaction-classification-embeddings/status"
            ) {
                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({
                        dimensions: 256,
                        indexedSourceCount: 9,
                        indexedTransactionCount: 8,
                        modelId: "text-embedding-3-small",
                        orphanCount: 2,
                        sourceCount: 10,
                        sourceOrphanCount: 0,
                        sourceStaleCount: 1,
                        sourceTransactionCount: 10,
                        staleCount: 3,
                    }),
                } as Response;
            }

            if (
                input ===
                    "/api/utilities/transaction-classification-embeddings/rebuild" &&
                init?.method === "POST"
            ) {
                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({
                        createdCount: 2,
                        deletedOrphanCount: 2,
                        dimensions: 256,
                        modelId: "text-embedding-3-small",
                        refreshedCount: 3,
                        skippedCount: 5,
                        sourceCount: 10,
                    }),
                } as Response;
            }

            return {
                ok: true,
                headers: new Headers(),
                json: async () => ({}),
            } as Response;
        });

        render(
            <FeedbackToastProvider>
                <TransactionClassificationDebugWorkspace />
            </FeedbackToastProvider>,
        );

        await screen.findByRole("heading", { name: "Embedding index" });
        await user.click(screen.getByRole("button", { name: "Status" }));

        expect(await screen.findByText(/8\s*\/\s*10/)).toBeInTheDocument();
        expect(screen.getByText(/9\s*\/\s*10/)).toBeInTheDocument();
        expect(screen.getByText(/text-embedding-3-small/i)).toBeInTheDocument();

        await user.click(
            screen.getByRole("button", { name: "Rebuild embeddings" }),
        );

        await waitFor(() =>
            expect(fetch).toHaveBeenCalledWith(
                "/api/utilities/transaction-classification-embeddings/rebuild",
                expect.objectContaining({ method: "POST" }),
            ),
        );
    });

    it("runs the ledger integrity check from the diagnostics page", async () => {
        const user = userEvent.setup();
        const snapshot = makeWorkspaceSnapshot({
            accounts: [
                {
                    accountId: "checking",
                    accountType: "checking",
                    balanceCents: 9_700,
                    createdAt: "2026-01-01T00:00:00.000Z",
                    ledgerAccountId: "acct_checking",
                    name: "Checking",
                    openedOn: "2026-01-01",
                    openingBalanceCents: 10_000,
                    updatedAt: "2026-01-15T00:00:00.000Z",
                    ledgerId: "ledger-1",
                },
            ],
            transactions: [
                {
                    displayAmountCents: 700,
                    enteredAt: "2026-01-15T00:00:00.000Z",
                    kind: "standard",
                    ledgerId: "ledger-1",
                    lines: [],
                    occurredAt: "2026-01-15T00:00:00.000Z",
                    payee: "Corner Market",
                    periodId: "2026-01",
                    postings: [],
                    referenceAccountId: "checking",
                    status: "entered",
                    transactionId: "transaction-1",
                    updatedAt: "2026-01-15T00:00:00.000Z",
                },
            ],
        });

        vi.mocked(fetch).mockImplementation(async (input) => {
            if (input === "/api/utilities/ledger-integrity/check") {
                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () => ({
                        checkedAt: "2026-07-04T12:00:00.000Z",
                        errorCount: 1,
                        findings: [
                            {
                                actualCents: 700,
                                code: "transaction_display_amount_mismatch",
                                entityId: "transaction-1",
                                entityType: "transaction",
                                expectedCents: 1_000,
                                message:
                                    "Transaction transaction-1 display amount does not match reference account posting movement.",
                                severity: "error",
                            },
                        ],
                        ledger: {
                            ledgerId: "ledger-1",
                            name: "Ledger",
                            status: "active",
                            workspaceId: "global",
                        },
                        reconciliation: {
                            accounts: [
                                {
                                    accountId: "checking",
                                    accountName: "Checking",
                                    accountType: "checking",
                                    currentBalanceCents: 9_700,
                                    ledgerAccountId: "acct_checking",
                                    openedOn: "2026-01-01",
                                    openingBalanceCents: 10_000,
                                    postingDeltaCents: -300,
                                },
                            ],
                            periods: [
                                {
                                    accountBalances: [
                                        {
                                            accountId: "checking",
                                            accountName: "Checking",
                                            balanceCents: 9_700,
                                        },
                                    ],
                                    assetBalanceCents: 9_700,
                                    endsOn: "2026-01-31",
                                    liabilityBalanceCents: 0,
                                    netBalanceCents: 9_700,
                                    periodId: "2026-01",
                                    startsOn: "2026-01-01",
                                },
                            ],
                            totals: {
                                assetBalanceCents: 9_700,
                                currentBalanceCents: 9_700,
                                liabilityBalanceCents: 0,
                                openingBalanceCents: 10_000,
                                postingDeltaCents: -300,
                            },
                        },
                        recordCounts: {
                            account: 1,
                            budgetAllocation: 1,
                            budgetCategory: 1,
                            budgetPeriod: 1,
                            ledgerPosting: 2,
                            transaction: 1,
                            transactionLine: 1,
                        },
                        status: "failed",
                        warningCount: 0,
                    }),
                } as Response;
            }

            return {
                ok: true,
                headers: new Headers(),
                json: async () => ({}),
            } as Response;
        });

        render(
            <FeedbackToastProvider>
                <WorkspaceStoreProvider initialSnapshot={snapshot}>
                    <LedgerIntegrityWorkspace />
                </WorkspaceStoreProvider>
            </FeedbackToastProvider>,
        );

        await user.click(
            screen.getByRole("button", { name: /run integrity check/i }),
        );

        expect(fetch).toHaveBeenCalledWith(
            "/api/utilities/ledger-integrity/check",
            expect.objectContaining({ method: "POST" }),
        );
        expect(await screen.findByText("Failed")).toBeInTheDocument();
        expect(screen.getAllByText("transaction").length).toBeGreaterThan(0);
        expect(
            screen.getByText("transaction_display_amount_mismatch"),
        ).toBeInTheDocument();
        const transactionLink = screen.getByRole("link", {
            name: "01/15/2026 - Corner Market - $7.00",
        });

        expect(transactionLink).toHaveAttribute(
            "href",
            "/transactions/all-accounts?selected=transaction-1",
        );
        await user.click(transactionLink);
        expect(navigationMocks.push).toHaveBeenCalledWith(
            "/transactions/checking?selected=transaction-1",
        );
        expect(
            screen.getByText(
                "Transaction 01/15/2026 - Corner Market - $7.00 display amount does not match reference account posting movement.",
            ),
        ).toBeInTheDocument();
        expect(
            screen.queryByText(
                "Transaction transaction-1 display amount does not match reference account posting movement.",
            ),
        ).not.toBeInTheDocument();
        expect(screen.getByText("$10.00")).toBeInTheDocument();
        expect(screen.getByText("$7.00")).toBeInTheDocument();
        expect(
            screen.getByRole("heading", { name: "Reconciliation" }),
        ).toBeInTheDocument();
        expect(screen.getAllByText("Checking").length).toBeGreaterThan(0);
        expect(screen.getAllByText("$97.00").length).toBeGreaterThan(0);
        expect(
            screen.getByText("Ledger integrity check failed."),
        ).toBeInTheDocument();
    });

    it("saves ordered auto assign source categories", async () => {
        const user = userEvent.setup();
        const snapshot = makeWorkspaceSnapshot({
            budgetCategories: [
                {
                    categoryId: "buffer",
                    createdAt: "2026-05-01T00:00:00.000Z",
                    defaultAssignedCents: 0,
                    groupId: "planning",
                    isIncomeCategory: false,
                    ledgerAccountId: "cat_buffer",
                    name: "Buffer",
                    sortOrder: 0,
                    status: "active",
                    updatedAt: "2026-05-01T00:00:00.000Z",
                    ledgerId: "ledger-1",
                },
                {
                    categoryId: "reserve",
                    createdAt: "2026-05-01T00:00:00.000Z",
                    defaultAssignedCents: 0,
                    groupId: "planning",
                    isIncomeCategory: false,
                    ledgerAccountId: "cat_reserve",
                    name: "Reserve",
                    sortOrder: 1,
                    status: "active",
                    updatedAt: "2026-05-01T00:00:00.000Z",
                    ledgerId: "ledger-1",
                },
            ],
        });
        const updatedAt = "2026-07-16T00:00:00.000Z";
        const updatedCategories = snapshot.budgetCategories.map((category) => ({
            ...category,
            autoAssignSourceEnabled: true,
            autoAssignSourceSortOrder: category.categoryId === "buffer" ? 0 : 1,
            updatedAt,
        }));

        vi.mocked(fetch).mockResolvedValue({
            ok: true,
            headers: new Headers(),
            json: async () =>
                createIntegrationCommittedWorkspaceMutationResponse({
                    currentSnapshot: snapshot,
                    changes: updatedCategories.map((category, index) => ({
                        batchId: "batch-auto-assign",
                        changedAt: updatedAt,
                        changeId: `change-auto-assign-${index}`,
                        entityId: category.categoryId,
                        entityType: "budgetCategory" as const,
                        expiresAt: 1_780_000_000,
                        operation: "upsert" as const,
                        record: category,
                    })),
                }),
        } as Response);

        render(
            <FeedbackToastProvider>
                <WorkspaceStoreProvider initialSnapshot={snapshot}>
                    <AutoAssignSourcesWorkspace />
                </WorkspaceStoreProvider>
            </FeedbackToastProvider>,
        );

        expect(
            screen.getByRole("heading", {
                name: "Monthly budget funding sources",
            }),
        ).toBeInTheDocument();
        expect(
            screen.getByText(
                "Choose the categories to use, in order, when you select Auto assign for a monthly budget. Available money moves from these categories to the categories being funded.",
            ),
        ).toBeInTheDocument();
        expect(screen.queryByText("Auto assign defaults")).not.toBeInTheDocument();

        async function chooseSourceCategory(name: string) {
            const input = screen.getByRole("combobox", {
                name: "Add source category",
            });

            await user.click(input);
            await user.clear(input);
            await user.type(input, name);
            await user.keyboard("{Enter}");
        }

        await chooseSourceCategory("Reserve");
        await user.click(screen.getByRole("button", { name: "Add source" }));
        await chooseSourceCategory("Buffer");
        await user.click(screen.getByRole("button", { name: "Add source" }));
        await user.click(
            screen.getByRole("button", { name: "Move Buffer up" }),
        );
        await user.click(screen.getByRole("button", { name: "Save sources" }));

        expect(fetch).toHaveBeenCalledWith(
            "/api/utilities/auto-assign-sources",
            expect.objectContaining({
                method: "PUT",
                body: JSON.stringify({
                    sources: [
                        { categoryId: "buffer", sortOrder: 0 },
                        { categoryId: "reserve", sortOrder: 1 },
                    ],
                }),
            }),
        );
    });

    it("creates transaction templates from the utilities subpage", async () => {
        const user = userEvent.setup();
        const snapshot = makeWorkspaceSnapshot({
            accounts: [
                {
                    accountId: "checking",
                    accountType: "checking",
                    balanceCents: 0,
                    createdAt: "2026-05-01T00:00:00.000Z",
                    ledgerAccountId: "acct_checking",
                    name: "Checking",
                    openedOn: "2026-05-01",
                    openingBalanceCents: 0,
                    updatedAt: "2026-05-01T00:00:00.000Z",
                    ledgerId: "ledger-1",
                },
            ],
            budgetCategories: [
                {
                    categoryId: "groceries",
                    createdAt: "2026-05-01T00:00:00.000Z",
                    defaultAssignedCents: 0,
                    groupId: "spending",
                    isIncomeCategory: false,
                    ledgerAccountId: "cat_groceries",
                    name: "Groceries",
                    sortOrder: 0,
                    status: "active",
                    updatedAt: "2026-05-01T00:00:00.000Z",
                    ledgerId: "ledger-1",
                },
            ],
            budgetGroups: [
                {
                    createdAt: "2026-05-01T00:00:00.000Z",
                    groupId: "spending",
                    name: "Spending",
                    sortOrder: 0,
                    status: "active",
                    updatedAt: "2026-05-01T00:00:00.000Z",
                    ledgerId: "ledger-1",
                },
            ],
        });

        vi.mocked(fetch).mockImplementation(async (input) => {
            if (input === "/api/utilities/transaction-templates") {
                const template = {
                    createdAt: "2026-06-01T00:00:00.000Z",
                    ledgerId: "ledger-1",
                    linesJson: JSON.stringify([
                        {
                            categoryId: "groceries",
                            formula: "remainder",
                            lineId: "line-1",
                            sortOrder: 0,
                        },
                    ]),
                    name: "Amazon order",
                    templateId: "template-1",
                    updatedAt: "2026-06-01T00:00:00.000Z",
                };

                return {
                    ok: true,
                    headers: new Headers(),
                    json: async () =>
                        createIntegrationCommittedWorkspaceMutationResponse({
                            body: template,
                            currentSnapshot: snapshot,
                            changes: [
                                {
                                    entityId: "template-1",
                                    entityType: "transactionTemplate",
                                    operation: "upsert",
                                    record: template,
                                },
                            ],
                        }),
                } as Response;
            }

            return {
                ok: true,
                headers: new Headers(),
                json: async () => ({}),
            } as Response;
        });

        render(
            <FeedbackToastProvider>
                <WorkspaceStoreProvider initialSnapshot={snapshot}>
                    <TemplateManagerAndTransactionDialog snapshot={snapshot} />
                </WorkspaceStoreProvider>
            </FeedbackToastProvider>,
        );

        await user.click(screen.getByRole("button", { name: "Add template" }));
        const templateNameInput = screen.getByLabelText("Template name");
        await waitFor(() => expect(templateNameInput).toHaveFocus());
        await user.clear(templateNameInput);
        await user.type(templateNameInput, "Amazon order");
        await user.type(screen.getByLabelText("Default payee"), "Amazon");
        await clickComboboxOption(
            user,
            screen.getByRole("combobox", { name: "Default account" }),
            "Checking",
        );
        const defaultAmountInput = screen.getByRole("textbox", {
            name: "Default amount",
        });
        await user.clear(defaultAmountInput);
        await user.type(defaultAmountInput, "-42.50");
        await clickComboboxOption(
            user,
            screen.getByRole("combobox", { name: "Split 1 category" }),
            "Groceries",
        );
        await user.click(screen.getByRole("button", { name: "Save template" }));

        expect(fetch).toHaveBeenCalledWith(
            "/api/utilities/transaction-templates",
            expect.objectContaining({
                method: "POST",
            }),
        );
        const [, request] = vi
            .mocked(fetch)
            .mock.calls.find(
                ([input]) =>
                    typeof input === "string" &&
                    input === "/api/utilities/transaction-templates",
            )!;

        expect(JSON.parse(String(request?.body))).toMatchObject({
            accountId: "checking",
            defaultAmountCents: -4_250,
            lines: [
                {
                    categoryId: "groceries",
                    formula: "remainder",
                    sortOrder: 0,
                },
            ],
            name: "Amazon order",
            payee: "Amazon",
        });
        await user.click(
            screen.getByRole("button", { name: "Open transaction modal" }),
        );
        await user.click(screen.getByRole("combobox", { name: "Category" }));

        expect(
            await screen.findByRole("option", { name: /Amazon order/i }),
        ).toBeInTheDocument();
    });
});
