import {
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIntegrationWorkspaceMutationResponse } from "./helpers/workspace-mutation-response";

const mocks = vi.hoisted(() => ({
    applyOptimisticWorkspaceChanges: vi.fn(),
    buildSummary: vi.fn(),
    applyWorkspaceMutationResponse: vi.fn(),
    createOptimisticPendingClassificationChanges: vi.fn(),
    discardOptimisticWorkspaceChanges: vi.fn(),
    fetch: vi.fn(),
    refreshWorkspaceSnapshot: vi.fn(),
    routerPush: vi.fn(),
    snapshot: {
        budgetCategories: [
            {
                categoryId: "dining",
                categoryType: "spending",
                groupId: "daily",
            },
            {
                categoryId: "groceries",
                categoryType: "spending",
                groupId: "daily",
            },
            {
                categoryId: "household",
                categoryType: "spending",
                groupId: "daily",
            },
            {
                categoryId: "transportation",
                categoryType: "spending",
                groupId: "daily",
            },
            {
                categoryId: "utilities",
                categoryType: "spending",
                groupId: "daily",
            },
            {
                categoryId: "travel",
                categoryType: "spending",
                groupId: "daily",
            },
            {
                categoryId: "emergency-fund",
                categoryType: "savings",
                groupId: "savings",
            },
        ],
        budgetGroups: [
            { groupId: "daily", name: "Daily" },
            { groupId: "savings", name: "Savings" },
        ],
        accounts: [
            {
                accountId: "checking",
                accountType: "checking",
                name: "Checking",
            },
        ],
        knowledge: {
            activeLedgerId: "ledger-1",
            changeCursor: "g1:r1",
            entityCounts: {},
            generatedAt: "2026-05-01T00:00:00.000Z",
            retainedChangesAfter: "2026-04-01T00:00:00.000Z",
            revision: "g1:r1",
            workspaceGeneration: 1,
            workspaceRevision: 1,
        },
        plaidTransactionSyncs: [],
        transactions: [
            {
                displayAmountCents: -1250,
                kind: "standard",
                memo: "First uncategorized memo",
                occurredAt: "2026-05-02T00:00:00.000Z",
                payee: "Earlier merchant",
                referenceAccountId: "checking",
                status: "entered",
                transactionId: "uncategorized-earlier",
                updatedAt: "2026-05-02T00:00:00.000Z",
                lines: [{ toAccountId: "checking" }],
            },
            {
                displayAmountCents: -2400,
                kind: "standard",
                occurredAt: "2026-05-05T00:00:00.000Z",
                payee: "Later merchant",
                referenceAccountId: "checking",
                status: "entered",
                transactionId: "uncategorized-later",
                updatedAt: "2026-05-05T00:00:00.000Z",
                lines: [{ toAccountId: "checking" }],
            },
            {
                displayAmountCents: -500,
                kind: "standard",
                occurredAt: "2026-05-01T00:00:00.000Z",
                payee: "Voided merchant",
                referenceAccountId: "checking",
                status: "voided",
                transactionId: "uncategorized-voided",
                updatedAt: "2026-05-01T00:00:00.000Z",
                lines: [{ toAccountId: "checking" }],
            },
        ],
    },
}));

vi.mock("next/navigation", () => ({
    usePathname: () => "/dashboard",
    useRouter: () => ({ push: mocks.routerPush }),
    useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/workspace/workspace-store-provider", () => ({
    useWorkspaceStore: () => ({
        applyOptimisticWorkspaceChanges:
            mocks.applyOptimisticWorkspaceChanges,
        applyWorkspaceMutationResponse: mocks.applyWorkspaceMutationResponse,
        discardOptimisticWorkspaceChanges:
            mocks.discardOptimisticWorkspaceChanges,
        getWorkspaceCacheIdentity: () => null,
        isReady: true,
        readCachedTransactions: vi.fn(),
        refreshWorkspaceSnapshot: mocks.refreshWorkspaceSnapshot,
        requestTransactionRepositoryRecovery: vi.fn(),
        snapshot: mocks.snapshot,
        transactionRepositoryRevision: 0,
        transactionRepositoryState: "repositoryReady",
    }),
}));

vi.mock("@/lib/workspace/budget-projector", () => ({
    buildBudgetPeriodSummaryFromSnapshot: mocks.buildSummary,
}));

vi.mock(
    "@/features/transactions/models/optimistic-pending-classification",
    () => ({
        createOptimisticPendingClassificationChanges:
            mocks.createOptimisticPendingClassificationChanges,
    }),
);

import { DashboardWorkspace } from "@/components/workspace/workspace-views";

type DashboardTabLabel =
    | "Auto Matches"
    | "Most active"
    | "Over budget"
    | "Totals"
    | "Uncategorized";

function getDashboardSection() {
    const section = screen
        .getByRole("tablist", { name: "Home sections" })
        .closest("section");

    if (!section) {
        throw new Error("The dashboard overview section was not rendered.");
    }

    return section;
}

function selectDashboardTab(label: DashboardTabLabel) {
    const section = getDashboardSection();
    fireEvent.click(within(section).getByRole("tab", { name: label }));
    return within(section).getByRole("tabpanel");
}

function createPendingCategoryClassification() {
    return {
        accountId: "checking",
        createdAt: "2026-05-03T00:00:00.000Z",
        expiresAt: 1_800_000_000,
        modelId: "gpt-5.6-luna",
        promptVersion: "2026-08-07.v1",
        source: "background",
        suggestion: {
            confidence: 0.9,
            lineAssignments: [
                {
                    categoryId: "groceries",
                    lineId: "line-1",
                },
            ],
            reason: "Matched prior grocery transactions.",
            targetLineIds: ["line-1"],
            transactionId: "uncategorized-earlier",
            transactionUpdatedAt: "2026-05-02T00:00:00.000Z",
            type: "category" as const,
        },
        suggestionType: "category" as const,
        transactionId: "uncategorized-earlier",
        transactionUpdatedAt: "2026-05-02T00:00:00.000Z",
        updatedAt: "2026-05-03T00:00:00.000Z",
    };
}

describe("dashboard workspace", () => {
    beforeEach(() => {
        window.history.replaceState(null, "", "/dashboard");
        vi.stubGlobal("fetch", mocks.fetch);
        mocks.applyOptimisticWorkspaceChanges.mockReset();
        mocks.applyWorkspaceMutationResponse.mockReset();
        mocks.createOptimisticPendingClassificationChanges.mockReset();
        mocks.createOptimisticPendingClassificationChanges.mockReturnValue([
            {
                entityId: "uncategorized-earlier",
                entityType: "transaction",
                operation: "upsert",
                record: {},
            },
        ]);
        mocks.applyOptimisticWorkspaceChanges.mockReturnValue(
            "optimistic-classification",
        );
        mocks.discardOptimisticWorkspaceChanges.mockReset();
        mocks.fetch.mockReset();
        mocks.fetch.mockResolvedValue({
            json: async () => ({ pending: [] }),
            ok: true,
        });
        mocks.routerPush.mockReset();
        mocks.refreshWorkspaceSnapshot.mockReset();
        mocks.refreshWorkspaceSnapshot.mockResolvedValue(undefined);
        mocks.snapshot.transactions.splice(3);
        mocks.buildSummary.mockReturnValue({
            categories: [
                {
                    activityCents: -1_200,
                    assignedCents: 0,
                    availableCents: -600,
                    carriedForwardCents: 0,
                    categoryId: "dining",
                    name: "Dining",
                },
                {
                    activityCents: -800,
                    assignedCents: 0,
                    availableCents: -500,
                    carriedForwardCents: 0,
                    categoryId: "groceries",
                    name: "Groceries",
                },
                {
                    activityCents: -600,
                    assignedCents: 0,
                    availableCents: -400,
                    carriedForwardCents: 0,
                    categoryId: "household",
                    name: "Household",
                },
                {
                    activityCents: -400,
                    assignedCents: 0,
                    availableCents: -300,
                    carriedForwardCents: 0,
                    categoryId: "transportation",
                    name: "Transportation",
                },
                {
                    activityCents: -200,
                    assignedCents: 0,
                    availableCents: -200,
                    carriedForwardCents: 0,
                    categoryId: "utilities",
                    name: "Utilities",
                },
                {
                    activityCents: -100,
                    assignedCents: 0,
                    availableCents: -100,
                    carriedForwardCents: 0,
                    categoryId: "travel",
                    name: "Travel",
                },
                {
                    activityCents: -1_600,
                    assignedCents: 0,
                    availableCents: 900,
                    carriedForwardCents: 0,
                    categoryId: "emergency-fund",
                    name: "Emergency fund",
                },
            ],
            periodId: "2026-05",
        });
    });

    it("welcomes a new user instead of showing reporting sections", () => {
        const existingTransactions = mocks.snapshot.transactions.splice(0);

        render(<DashboardWorkspace initialPeriodId="2026-05" />);

        expect(
            screen.getByRole("heading", { name: "Welcome to Budgeted" }),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("tablist", { name: "Home sections" }),
        ).not.toBeInTheDocument();
        expect(
            screen.getByRole("link", { name: /Create accounts/ }),
        ).toHaveAttribute("href", "/accounts");
        expect(
            screen.getByRole("link", { name: /Create your budget plan/ }),
        ).toHaveAttribute("href", "/global-budget");
        expect(
            screen.getByRole("link", { name: /Add your first transaction/ }),
        ).toHaveAttribute("href", "/transactions");

        mocks.snapshot.transactions.push(...existingTransactions);
    });

    it("shows over-budget categories and ranks activity across the ledger", () => {
        mocks.snapshot.transactions.push(
            {
                displayAmountCents: -1_000,
                kind: "standard",
                occurredAt: "2027-01-10T00:00:00.000Z",
                periodId: "2027-01",
                referenceAccountId: "checking",
                status: "entered",
                transactionId: "emergency-one",
                updatedAt: "2027-01-10T00:00:00.000Z",
                lines: [
                    {
                        amountCents: 600,
                        categoryId: "emergency-fund",
                        toAccountId: "checking",
                        transactionId: "emergency-one",
                    },
                    {
                        amountCents: 400,
                        categoryId: "emergency-fund",
                        toAccountId: "checking",
                        transactionId: "emergency-one",
                    },
                ],
            } as never,
            {
                displayAmountCents: -500,
                kind: "standard",
                occurredAt: "2026-05-11T00:00:00.000Z",
                periodId: "2026-05",
                referenceAccountId: "checking",
                status: "entered",
                transactionId: "emergency-two",
                updatedAt: "2026-05-11T00:00:00.000Z",
                lines: [
                    {
                        amountCents: 500,
                        categoryId: "emergency-fund",
                        toAccountId: "checking",
                        transactionId: "emergency-two",
                    },
                ],
            } as never,
            {
                displayAmountCents: -5_000,
                kind: "standard",
                occurredAt: "2026-05-12T00:00:00.000Z",
                periodId: "2026-05",
                referenceAccountId: "checking",
                status: "entered",
                transactionId: "dining-one",
                updatedAt: "2026-05-12T00:00:00.000Z",
                lines: [
                    {
                        amountCents: 5_000,
                        categoryId: "dining",
                        toAccountId: "checking",
                        transactionId: "dining-one",
                    },
                ],
            } as never,
        );

        render(<DashboardWorkspace initialPeriodId="2026-05" />);

        const dashboardPane = getDashboardSection();
        const tabList = within(dashboardPane).getByRole("tablist", {
            name: "Home sections",
        });

        expect(screen.queryByRole("heading", { name: "Overview" })).not.toBeInTheDocument();
        expect(tabList.parentElement).toHaveClass("justify-center");
        expect(within(dashboardPane).getAllByRole("tab")).toHaveLength(5);
        expect(
            within(tabList).getAllByRole("tab")[0],
        ).toHaveAccessibleName("Most active");
        expect(
            within(tabList)
                .getAllByRole("tab")
                .map((tab) =>
                    tab.querySelector("svg")?.getAttribute("data-icon"),
                ),
        ).toEqual([
            "chart-line",
            "triangle-exclamation",
            "right-left",
            "clipboard-check",
            "list-check",
        ]);
        const uncategorizedAttentionMarker = within(tabList)
            .getByRole("tab", { name: "Uncategorized" })
            .querySelector("[data-dashboard-tab-attention-marker]");
        expect(uncategorizedAttentionMarker).toHaveTextContent("2");
        expect(uncategorizedAttentionMarker).toHaveClass(
            "rounded-full",
            "bg-[#a52b3a]",
            "text-white",
        );
        expect(
            within(tabList)
                .getByRole("tab", { name: "Auto Matches" })
                .querySelector("[data-dashboard-tab-attention-marker]"),
        ).not.toBeInTheDocument();
        expect(
            within(dashboardPane).getByText("Emergency fund"),
        ).toBeInTheDocument();
        expect(
            within(dashboardPane).queryByText("Utilities"),
        ).not.toBeInTheDocument();
        expect(
            within(dashboardPane).getByRole("link", {
                name: "View monthly budget",
            }),
        ).toHaveAttribute("href", "/budget?month=2026-05");
        expect(
            within(dashboardPane)
                .getAllByRole("link", { name: "View trend" })
                .map((link) => link.getAttribute("href")),
        ).toEqual([
            "/reporting/category-tracking?category=emergency-fund",
            "/reporting/category-tracking?category=dining",
        ]);

        const mostActiveTab = within(dashboardPane).getByRole("tab", {
            name: "Most active",
        });
        const overBudgetTab = within(dashboardPane).getByRole("tab", {
            name: "Over budget",
        });

        expect(mostActiveTab).toHaveAttribute("aria-selected", "true");
        expect(overBudgetTab).toHaveAttribute("aria-selected", "false");

        const categoryTrendList = within(dashboardPane).getByRole("list", {
            name: "Category trends",
        });
        const emergencyFundItem = within(categoryTrendList).getByRole(
            "listitem",
            { name: "Emergency fund" },
        );
        const emergencyFundTrendLink = within(emergencyFundItem).getByRole(
            "link",
            { name: "View trend" },
        );
        const trendClick = vi.fn((event: Event) => event.preventDefault());
        emergencyFundTrendLink.addEventListener("click", trendClick);

        expect(emergencyFundTrendLink.parentElement).toHaveClass(
            "grid-cols-[7rem_auto]",
        );
        expect(emergencyFundTrendLink.previousElementSibling).toHaveClass(
            "w-28",
        );

        fireEvent.keyDown(window, { key: "ArrowDown" });
        expect(emergencyFundItem).toHaveAttribute(
            "data-pane-list-highlighted",
            "true",
        );
        fireEvent.keyDown(window, { key: "Enter" });
        expect(trendClick).toHaveBeenCalledOnce();
        fireEvent.keyDown(window, { key: "v" });
        expect(trendClick).toHaveBeenCalledOnce();

        fireEvent.keyDown(mostActiveTab, { key: "ArrowRight" });

        expect(overBudgetTab).toHaveAttribute("aria-selected", "true");
        expect(overBudgetTab).toHaveFocus();
        expect(window.location.hash).toBe("#overBudget");
        expect(
            within(dashboardPane).getByText("Dining"),
        ).toBeInTheDocument();
        expect(
            within(dashboardPane).getByText("Utilities"),
        ).toBeInTheDocument();
        expect(
            within(dashboardPane).queryByText("Emergency fund"),
        ).not.toBeInTheDocument();
        expect(
            within(dashboardPane)
                .getAllByRole("link", { name: "View trend" })
                .map((link) => link.getAttribute("href")),
        ).toEqual([
            "/reporting/category-tracking?category=dining",
            "/reporting/category-tracking?category=groceries",
            "/reporting/category-tracking?category=household",
            "/reporting/category-tracking?category=transportation",
            "/reporting/category-tracking?category=utilities",
            "/reporting/category-tracking?category=travel",
        ]);

        const totalsPane = selectDashboardTab("Totals");

        expect(
            within(totalsPane).getByText("Spending categories"),
        ).toBeInTheDocument();
        expect(within(totalsPane).getByText("Daily")).toBeInTheDocument();
        expect(
            within(totalsPane).getByText("Savings categories"),
        ).toBeInTheDocument();
        expect(within(totalsPane).getByText("Savings")).toBeInTheDocument();
        expect(
            within(totalsPane).getByText("All categories"),
        ).toBeInTheDocument();
    });

    it("selects dashboard tabs from the URL hash and browser history", async () => {
        window.history.replaceState(null, "", "/dashboard#uncategorized");

        render(<DashboardWorkspace initialPeriodId="2026-05" />);

        const dashboardPane = getDashboardSection();
        const uncategorizedTab = within(dashboardPane).getByRole("tab", {
            name: "Uncategorized",
        });
        const totalsTab = within(dashboardPane).getByRole("tab", {
            name: "Totals",
        });

        await waitFor(() =>
            expect(uncategorizedTab).toHaveAttribute("aria-selected", "true"),
        );

        fireEvent.click(totalsTab);
        expect(window.location.hash).toBe("#totals");

        window.history.replaceState(null, "", "/dashboard#autoMatches");
        fireEvent.popState(window);

        await waitFor(() =>
            expect(
                within(dashboardPane).getByRole("tab", {
                    name: "Auto Matches",
                }),
            ).toHaveAttribute("aria-selected", "true"),
        );
    });

    it("shows an explicit empty state when no categories are over budget", () => {
        mocks.buildSummary.mockReturnValue({
            categories: [],
            periodId: "2026-05",
        });

        render(<DashboardWorkspace initialPeriodId="2026-05" />);

        const dashboardSection = getDashboardSection();
        const overBudgetPane = selectDashboardTab("Over budget");

        expect(
            within(overBudgetPane).getByText(
                "No spending categories are over budget.",
            ),
        ).toBeInTheDocument();

        fireEvent.click(
            within(dashboardSection).getByRole("tab", {
                name: "Most active",
            }),
        );
        expect(
            within(overBudgetPane).getByText(
                "No category activity in this ledger.",
            ),
        ).toBeInTheDocument();
    });

    it("lists ready auto matches across accounts with explicit merge decisions", async () => {
        mocks.snapshot.transactions.push({
            displayAmountCents: -1_250,
            kind: "standard",
            occurredAt: "2026-05-03T00:00:00.000Z",
            payee: "Plaid counterpart",
            referenceAccountId: "checking",
            source: "plaid",
            status: "entered",
            transactionId: "plaid-counterpart",
            updatedAt: "2026-05-03T00:00:00.000Z",
            lines: [{ toAccountId: "checking" }],
        } as never);

        render(<DashboardWorkspace initialPeriodId="2026-05" />);

        const autoMatchesPane = selectDashboardTab("Auto Matches");
        expect(
            within(getDashboardSection())
                .getByRole("tab", { name: "Auto Matches" })
                .querySelector("[data-dashboard-tab-attention-marker]"),
        ).toHaveTextContent("1");
        const list = within(autoMatchesPane).getByRole("list", {
            name: "Ready auto matches",
        });
        const item = within(list).getByRole("listitem", {
            name: "Earlier merchant and Plaid counterpart",
        });

        expect(within(item).getByRole("button", { name: "Do not Merge" })).toHaveClass(
            "bg-[var(--color-secondary-action)]",
        );
        expect(within(item).getByRole("button", { name: "Merge" })).toBeInTheDocument();
        expect(within(item).getByLabelText("Manual source")).toBeInTheDocument();
        expect(within(item).getByLabelText("Plaid source")).toBeInTheDocument();
        expect(within(item).getByText("05/02/2026")).toBeInTheDocument();
        expect(within(item).getAllByText("Uncategorized")).toHaveLength(2);
        expect(
            within(item).getByRole("button", {
                name: "Expand memo for Earlier merchant",
            }),
        ).toHaveTextContent("First uncategorized memo");
        const payee = within(item).getByText("Earlier merchant");
        expect(payee).toHaveClass("truncate");

        fireEvent.click(item);
        expect(payee).toHaveClass("break-words");
        expect(
            within(item).getByRole("button", {
                name: "Collapse memo for Earlier merchant",
            }),
        ).toBeInTheDocument();

        fireEvent.click(item);
        expect(payee).toHaveClass("truncate");

        fireEvent.keyDown(window, { key: "ArrowDown" });
        expect(item).toHaveAttribute("data-pane-list-highlighted", "true");

        fireEvent.keyDown(window, { key: "Enter" });
        expect(
            mocks.fetch.mock.calls.some(
                ([url]) => url === "/api/transactions/merge",
            ),
        ).toBe(false);
        expect(
            within(item).getByRole("button", {
                name: "Collapse memo for Earlier merchant",
            }),
        ).toBeInTheDocument();

        fireEvent.keyDown(window, { key: "d" });

        await waitFor(() =>
            expect(
                mocks.fetch.mock.calls.some(
                    ([url]) =>
                        url === "/api/transactions/auto-match-rejections",
                ),
            ).toBe(true),
        );
        const [, request] = mocks.fetch.mock.calls.find(
            ([url]) => url === "/api/transactions/auto-match-rejections",
        )!;
        expect(JSON.parse(String(request?.body))).toMatchObject({
            transactionIds: ["uncategorized-earlier", "plaid-counterpart"],
        });

        await waitFor(() =>
            expect(
                within(item).getByRole("button", { name: "Do not Merge" }),
            ).toBeEnabled(),
        );
        fireEvent.keyDown(window, { key: "m" });

        expect(mocks.applyOptimisticWorkspaceChanges).toHaveBeenCalledWith(
            expect.any(Array),
        );

        await waitFor(() =>
            expect(
                mocks.fetch.mock.calls.some(
                    ([url]) => url === "/api/transactions/merge",
                ),
            ).toBe(true),
        );
        const [, mergeRequest] = mocks.fetch.mock.calls.find(
            ([url]) => url === "/api/transactions/merge",
        )!;
        expect(JSON.parse(String(mergeRequest?.body))).toMatchObject({
            expectedMatchType: "duplicate",
            transactionIds: ["uncategorized-earlier", "plaid-counterpart"],
        });
        await waitFor(() =>
            expect(mocks.applyWorkspaceMutationResponse).toHaveBeenLastCalledWith(
                expect.anything(),
                { optimisticMutationId: "optimistic-classification" },
            ),
        );
    });

    it("optimistically removes each Home auto match and allows another merge immediately", async () => {
        mocks.snapshot.transactions.push(
            {
                displayAmountCents: -1_250,
                kind: "standard",
                occurredAt: "2026-05-02T00:00:00.000Z",
                payee: "Earlier Plaid counterpart",
                referenceAccountId: "checking",
                source: "plaid",
                status: "entered",
                transactionId: "plaid-earlier-counterpart",
                updatedAt: "2026-05-02T00:00:00.000Z",
                lines: [{ toAccountId: "checking" }],
            } as never,
            {
                displayAmountCents: -2_400,
                kind: "standard",
                occurredAt: "2026-05-05T00:00:00.000Z",
                payee: "Later Plaid counterpart",
                referenceAccountId: "checking",
                source: "plaid",
                status: "entered",
                transactionId: "plaid-later-counterpart",
                updatedAt: "2026-05-05T00:00:00.000Z",
                lines: [{ toAccountId: "checking" }],
            } as never,
        );
        const resolveMergeResponses: Array<
            (response: { json: () => Promise<object>; ok: boolean }) => void
        > = [];

        mocks.fetch.mockImplementation((input) => {
            if (String(input) === "/api/transactions/merge") {
                return new Promise((resolve) => {
                    resolveMergeResponses.push(resolve);
                });
            }

            return Promise.resolve({
                json: async () => ({ pending: [] }),
                ok: true,
            });
        });

        render(<DashboardWorkspace initialPeriodId="2026-05" />);
        const autoMatchesPane = selectDashboardTab("Auto Matches");

        expect(
            within(autoMatchesPane).getAllByRole("button", { name: "Merge" }),
        ).toHaveLength(2);

        fireEvent.click(
            within(autoMatchesPane).getAllByRole("button", { name: "Merge" })[0]!,
        );

        expect(
            within(autoMatchesPane).getAllByRole("button", { name: "Merge" }),
        ).toHaveLength(1);

        fireEvent.click(
            within(autoMatchesPane).getByRole("button", { name: "Merge" }),
        );

        expect(
            within(autoMatchesPane).queryByRole("button", { name: "Merge" }),
        ).not.toBeInTheDocument();
        expect(resolveMergeResponses).toHaveLength(2);
        expect(mocks.applyOptimisticWorkspaceChanges).toHaveBeenCalledTimes(2);

        for (const resolve of resolveMergeResponses) {
            resolve({
                json: async () =>
                    createIntegrationWorkspaceMutationResponse({ body: {} }),
                ok: true,
            });
        }

        await waitFor(() => {
            expect(mocks.applyWorkspaceMutationResponse).toHaveBeenCalledTimes(2);
        });
    });

    it("restores the saved workspace when an optimistic home auto match merge fails", async () => {
        mocks.snapshot.transactions.push({
            displayAmountCents: -1_250,
            kind: "standard",
            occurredAt: "2026-05-03T00:00:00.000Z",
            payee: "Plaid counterpart",
            referenceAccountId: "checking",
            source: "plaid",
            status: "entered",
            transactionId: "plaid-counterpart",
            updatedAt: "2026-05-03T00:00:00.000Z",
            lines: [{ toAccountId: "checking" }],
        } as never);
        mocks.fetch.mockImplementation(async (url) =>
            url === "/api/transactions/merge"
                ? {
                      json: async () => ({
                          error: { message: "Merge was rejected." },
                      }),
                      ok: false,
                  }
                : { json: async () => ({ pending: [] }), ok: true },
        );

        render(<DashboardWorkspace initialPeriodId="2026-05" />);

        const autoMatchesPane = selectDashboardTab("Auto Matches");
        fireEvent.click(
            within(autoMatchesPane).getByRole("button", { name: "Merge" }),
        );

        expect(
            within(autoMatchesPane).queryByRole("button", { name: "Merge" }),
        ).not.toBeInTheDocument();

        await waitFor(() =>
            expect(mocks.discardOptimisticWorkspaceChanges).toHaveBeenCalledWith(
                "optimistic-classification",
            ),
        );
        expect(mocks.refreshWorkspaceSnapshot).toHaveBeenCalledTimes(1);
        expect(
            within(autoMatchesPane).getByRole("button", { name: "Merge" }),
        ).toBeInTheDocument();
    });

    it("shows an empty auto-match message when no matches are ready", () => {
        render(<DashboardWorkspace initialPeriodId="2026-05" />);

        const autoMatchesPane = selectDashboardTab("Auto Matches");

        const emptyMessage = within(autoMatchesPane).getByText(
            "No auto matches are ready to merge.",
        );

        expect(emptyMessage).toBeInTheDocument();
        expect(emptyMessage.parentElement?.querySelector("svg")).not.toHaveClass(
            "text-[var(--tone-success-ink)]",
        );
    });

    it("lists the oldest uncategorized transactions with account-specific jump actions", () => {
        render(<DashboardWorkspace initialPeriodId="2026-05" />);

        const uncategorizedPane = selectDashboardTab("Uncategorized");

        expect(
            within(uncategorizedPane).getByText("Earlier merchant"),
        ).toBeInTheDocument();
        expect(
            within(uncategorizedPane).getByText("First uncategorized memo"),
        ).toBeInTheDocument();
        expect(
            within(uncategorizedPane).getAllByText("Checking"),
        ).toHaveLength(2);
        expect(
            within(uncategorizedPane).queryByText("Voided merchant"),
        ).not.toBeInTheDocument();
        expect(
            within(uncategorizedPane).getByRole("link", {
                name: "View all transactions",
            }),
        ).toHaveAttribute("href", "/transactions");
        const transactionActions = within(uncategorizedPane).getAllByRole(
            "button",
            { name: "Transaction actions" },
        );
        expect(transactionActions).toHaveLength(2);

        fireEvent.click(transactionActions[0]!);
        fireEvent.click(screen.getByRole("menuitem", { name: "View" }));

        expect(mocks.routerPush).toHaveBeenCalledWith(
            "/transactions/checking?selected=uncategorized-earlier",
        );
    });

    it("expands and collapses uncategorized transaction details without intercepting actions", () => {
        render(<DashboardWorkspace initialPeriodId="2026-05" />);
        selectDashboardTab("Uncategorized");

        const card = screen.getByTestId(
            "uncategorized-transaction-uncategorized-earlier",
        );
        const payee = within(card).getByText("Earlier merchant");
        const memo = within(card).getByText("First uncategorized memo");

        expect(payee).toHaveClass("truncate");
        expect(memo).toHaveClass("truncate");

        fireEvent.keyDown(window, { key: "v" });
        expect(mocks.routerPush).not.toHaveBeenCalled();

        fireEvent.keyDown(window, { key: "ArrowDown" });
        expect(card).toHaveAttribute("data-pane-list-highlighted", "true");
        fireEvent.keyDown(window, { key: "Enter" });

        expect(payee).not.toHaveClass("truncate");
        expect(memo).toHaveClass("whitespace-pre-wrap");

        fireEvent.keyDown(window, { key: "v" });

        expect(mocks.routerPush).toHaveBeenCalledWith(
            "/transactions/checking?selected=uncategorized-earlier",
        );
        expect(payee).not.toHaveClass("truncate");

        fireEvent.keyDown(window, { key: "Enter" });

        expect(payee).toHaveClass("truncate");
        expect(memo).toHaveClass("truncate");

        fireEvent.click(card);
        fireEvent.click(
            within(card).getByRole("button", { name: "Transaction actions" }),
        );
        fireEvent.click(within(card).getByRole("menuitem", { name: "View" }));
        expect(payee).not.toHaveClass("truncate");
    });

    it("edits a Home transaction with the standard inline transaction editor", () => {
        render(<DashboardWorkspace initialPeriodId="2026-05" />);
        const uncategorizedPane = selectDashboardTab("Uncategorized");

        const card = within(uncategorizedPane).getByTestId(
            "uncategorized-transaction-uncategorized-earlier",
        );
        fireEvent.click(
            within(card).getByRole("button", { name: "Transaction actions" }),
        );
        fireEvent.click(within(card).getByRole("menuitem", { name: "Edit" }));

        expect(
            within(uncategorizedPane).getByRole("table", {
                name: "Edit Earlier merchant",
            }),
        ).toBeInTheDocument();
        expect(
            within(uncategorizedPane).getByRole("button", {
                name: "Save changes",
            }),
        ).toBeInTheDocument();

        fireEvent.click(
            within(uncategorizedPane).getByRole("button", { name: "Cancel" }),
        );

        expect(
            within(uncategorizedPane).getByTestId(
                "uncategorized-transaction-uncategorized-earlier",
            ),
        ).toBeInTheDocument();
    });

    it("shows the displayed and total count when uncategorized transactions exceed ten", () => {
        mocks.snapshot.transactions.push(
            ...Array.from({ length: 9 }, (_, index) => ({
                displayAmountCents: -100 * (index + 1),
                kind: "standard" as const,
                occurredAt: `2026-05-${String(index + 6).padStart(2, "0")}T00:00:00.000Z`,
                payee: `Additional merchant ${index + 1}`,
                referenceAccountId: "checking",
                status: "entered" as const,
                transactionId: `uncategorized-additional-${index + 1}`,
                updatedAt: `2026-05-${String(index + 6).padStart(2, "0")}T00:00:00.000Z`,
                lines: [{ toAccountId: "checking" }],
            })),
        );

        const { rerender } = render(
            <DashboardWorkspace initialPeriodId="2026-05" />,
        );

        const uncategorizedPane = selectDashboardTab("Uncategorized");
        const transactionActions = within(uncategorizedPane).getAllByRole(
            "button",
            { name: "Transaction actions" },
        );

        expect(
            within(getDashboardSection()).getByText("10 of 11 transactions"),
        ).toBeInTheDocument();
        expect(transactionActions).toHaveLength(10);
        expect(
            within(uncategorizedPane).queryByText("Additional merchant 9"),
        ).not.toBeInTheDocument();

        fireEvent.click(
            within(uncategorizedPane).getByRole("button", {
                name: "[+] Show more",
            }),
        );

        expect(
            within(getDashboardSection()).getByText("11 transactions"),
        ).toBeInTheDocument();
        expect(
            within(uncategorizedPane).getAllByRole("button", {
                name: "Transaction actions",
            }),
        ).toHaveLength(11);
        expect(
            within(uncategorizedPane).getByText("Additional merchant 9"),
        ).toBeInTheDocument();

        rerender(<DashboardWorkspace initialPeriodId="2026-05" />);

        expect(
            within(uncategorizedPane).getAllByRole("button", {
                name: "Transaction actions",
            }),
        ).toHaveLength(11);
    });

    it("shows and applies a current AI category classification", async () => {
        const pending = createPendingCategoryClassification();
        let resolveApplyResponse: (
            response: { json: () => Promise<object>; ok: boolean },
        ) => void;

        mocks.fetch.mockImplementation((input) => {
            if (
                String(input).includes(
                    "/api/transactions/classification/pending/apply",
                )
            ) {
                return new Promise((resolve) => {
                    resolveApplyResponse = resolve;
                });
            }

            return Promise.resolve({
                json: async () => ({ pending: [pending] }),
                ok: true,
            });
        });

        render(<DashboardWorkspace initialPeriodId="2026-05" />);
        selectDashboardTab("Uncategorized");

        expect(
            await screen.findByText("Suggested: groceries"),
        ).toBeInTheDocument();
        expect(screen.getByText("90% confidence")).toBeInTheDocument();
        expect(
            screen.getByText("Matched prior grocery transactions."),
        ).toBeInTheDocument();

        const card = screen.getByTestId(
            "uncategorized-transaction-uncategorized-earlier",
        );
        fireEvent.click(
            within(card).getByRole("button", { name: "Transaction actions" }),
        );
        expect(
            within(card)
                .getAllByRole("menuitem")
                .map((item) => item.textContent),
        ).toEqual([
            "Apply Suggestion",
            "Ignore Suggestion",
            "Edit",
            "View",
        ]);
        fireEvent.keyDown(window, { key: "Escape" });

        fireEvent.keyDown(window, { key: "a" });
        expect(mocks.applyOptimisticWorkspaceChanges).not.toHaveBeenCalled();

        fireEvent.keyDown(window, { key: "ArrowDown" });
        fireEvent.keyDown(window, { key: "a" });

        expect(screen.queryByText("Earlier merchant")).not.toBeInTheDocument();
        expect(mocks.applyOptimisticWorkspaceChanges).toHaveBeenCalledTimes(1);
        const nextCard = screen.getByTestId(
            "uncategorized-transaction-uncategorized-later",
        );
        expect(nextCard).toHaveAttribute("data-pane-list-highlighted", "true");
        expect(nextCard).toHaveFocus();

        fireEvent.keyDown(window, { key: "v" });
        expect(mocks.routerPush).toHaveBeenCalledWith(
            "/transactions/checking?selected=uncategorized-later",
        );

        await waitFor(() => {
            expect(mocks.fetch).toHaveBeenCalledWith(
                "/api/transactions/classification/pending/apply",
                expect.objectContaining({
                    body: expect.stringContaining(
                        '"transactionId":"uncategorized-earlier"',
                    ),
                    method: "POST",
                }),
            );
        });
        resolveApplyResponse!({
            json: async () =>
                createIntegrationWorkspaceMutationResponse({
                    body: { appliedCount: 1 },
                }),
            ok: true,
        });
        await waitFor(() => {
            expect(mocks.applyWorkspaceMutationResponse).toHaveBeenCalledWith(
                expect.objectContaining({ ok: true }),
                { optimisticMutationId: "optimistic-classification" },
            );
        });
    });

    it("highlights the previous Home transaction when the categorized item was last", async () => {
        const basePending = createPendingCategoryClassification();
        const pending = {
            ...basePending,
            suggestion: {
                ...basePending.suggestion,
                lineAssignments: [
                    {
                        categoryId: "groceries",
                        lineId: "line-2",
                    },
                ],
                targetLineIds: ["line-2"],
                transactionId: "uncategorized-later",
                transactionUpdatedAt: "2026-05-05T00:00:00.000Z",
            },
            transactionId: "uncategorized-later",
            transactionUpdatedAt: "2026-05-05T00:00:00.000Z",
        };
        let resolveApplyResponse: (
            response: { json: () => Promise<object>; ok: boolean },
        ) => void;

        mocks.fetch.mockImplementation((input) => {
            if (
                String(input).includes(
                    "/api/transactions/classification/pending/apply",
                )
            ) {
                return new Promise((resolve) => {
                    resolveApplyResponse = resolve;
                });
            }

            return Promise.resolve({
                json: async () => ({ pending: [pending] }),
                ok: true,
            });
        });

        render(<DashboardWorkspace initialPeriodId="2026-05" />);
        selectDashboardTab("Uncategorized");

        await screen.findByText("Suggested: groceries");
        fireEvent.keyDown(window, { key: "ArrowUp" });
        fireEvent.keyDown(window, { key: "a" });

        expect(screen.queryByText("Later merchant")).not.toBeInTheDocument();
        const previousCard = screen.getByTestId(
            "uncategorized-transaction-uncategorized-earlier",
        );
        expect(previousCard).toHaveAttribute(
            "data-pane-list-highlighted",
            "true",
        );
        expect(previousCard).toHaveFocus();

        resolveApplyResponse!({
            json: async () =>
                createIntegrationWorkspaceMutationResponse({
                    body: { appliedCount: 1 },
                }),
            ok: true,
        });
        await waitFor(() => {
            expect(mocks.applyWorkspaceMutationResponse).toHaveBeenCalled();
        });
    });

    it("optimistically rejects the highlighted Home classification and returns control immediately", async () => {
        const pending = createPendingCategoryClassification();
        const rejectedPending = { ...pending, status: "rejected" as const };
        let resolveRejectResponse: (
            response: { json: () => Promise<object>; ok: boolean },
        ) => void;

        mocks.fetch.mockImplementation((input) => {
            if (
                String(input).includes(
                    "/api/transactions/classification/pending/reject",
                )
            ) {
                return new Promise((resolve) => {
                    resolveRejectResponse = resolve;
                });
            }

            return Promise.resolve({
                json: async () => ({ pending: [pending] }),
                ok: true,
            });
        });

        render(<DashboardWorkspace initialPeriodId="2026-05" />);
        selectDashboardTab("Uncategorized");

        const earlierCard = await screen.findByTestId(
            "uncategorized-transaction-uncategorized-earlier",
        );
        expect(
            within(earlierCard).getByRole("button", {
                name: "Transaction actions",
            }),
        ).toBeInTheDocument();
        fireEvent.keyDown(window, { key: "ArrowDown" });
        fireEvent.keyDown(window, { key: "i" });

        expect(screen.getByText("Earlier merchant")).toBeInTheDocument();

        fireEvent.keyDown(window, { key: "e" });
        expect(
            screen.getByRole("table", { name: "Edit Earlier merchant" }),
        ).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

        await waitFor(() =>
            expect(mocks.fetch).toHaveBeenCalledWith(
                "/api/transactions/classification/pending/reject",
                expect.objectContaining({
                    body: expect.stringContaining(
                        '"transactionId":"uncategorized-earlier"',
                    ),
                    method: "POST",
                }),
            ),
        );

        resolveRejectResponse!({
            json: async () => ({ pending: rejectedPending }),
            ok: true,
        });

        expect(screen.getByText("Earlier merchant")).toBeInTheDocument();
    });

    it("restores a Home classification when its optimistic rejection fails", async () => {
        const pending = createPendingCategoryClassification();

        mocks.fetch.mockImplementation((input) =>
            Promise.resolve(
                String(input).includes(
                    "/api/transactions/classification/pending/reject",
                )
                    ? {
                          json: async () => ({
                              error: { message: "Rejection failed." },
                          }),
                          ok: false,
                      }
                    : {
                          json: async () => ({ pending: [pending] }),
                          ok: true,
                      },
            ),
        );

        render(<DashboardWorkspace initialPeriodId="2026-05" />);
        selectDashboardTab("Uncategorized");

        const earlierCard = await screen.findByTestId(
            "uncategorized-transaction-uncategorized-earlier",
        );
        const suggestionActionsButton = within(earlierCard).getByRole(
            "button",
            { name: "Transaction actions" },
        );
        fireEvent.click(suggestionActionsButton);
        fireEvent.click(
            screen.getByRole("menuitem", { name: "Ignore Suggestion" }),
        );

        expect(
            screen.queryByText("Suggested: groceries"),
        ).not.toBeInTheDocument();
        expect(
            await screen.findByText("Suggested: groceries"),
        ).toBeInTheDocument();
    });

    it("submits multiple dashboard classifications while earlier applies are pending", async () => {
        const pending = [
            {
                accountId: "checking",
                createdAt: "2026-05-03T00:00:00.000Z",
                expiresAt: 1_800_000_000,
                modelId: "gpt-5.6-luna",
                promptVersion: "2026-08-07.v1",
                source: "background",
                suggestion: {
                    confidence: 0.9,
                    lineAssignments: [
                        { categoryId: "groceries", lineId: "line-1" },
                    ],
                    reason: "Matched prior grocery transactions.",
                    targetLineIds: ["line-1"],
                    transactionId: "uncategorized-earlier",
                    transactionUpdatedAt: "2026-05-02T00:00:00.000Z",
                    type: "category" as const,
                },
                suggestionType: "category" as const,
                transactionId: "uncategorized-earlier",
                transactionUpdatedAt: "2026-05-02T00:00:00.000Z",
                updatedAt: "2026-05-03T00:00:00.000Z",
            },
            {
                accountId: "checking",
                createdAt: "2026-05-06T00:00:00.000Z",
                expiresAt: 1_800_000_000,
                modelId: "gpt-5.6-luna",
                promptVersion: "2026-08-07.v1",
                source: "background",
                suggestion: {
                    confidence: 0.9,
                    lineAssignments: [
                        { categoryId: "groceries", lineId: "line-2" },
                    ],
                    reason: "Matched prior grocery transactions.",
                    targetLineIds: ["line-2"],
                    transactionId: "uncategorized-later",
                    transactionUpdatedAt: "2026-05-05T00:00:00.000Z",
                    type: "category" as const,
                },
                suggestionType: "category" as const,
                transactionId: "uncategorized-later",
                transactionUpdatedAt: "2026-05-05T00:00:00.000Z",
                updatedAt: "2026-05-06T00:00:00.000Z",
            },
        ];
        const resolveApplyResponses: Array<
            (response: { json: () => Promise<object>; ok: boolean }) => void
        > = [];

        mocks.fetch.mockImplementation((input) => {
            if (
                String(input).includes(
                    "/api/transactions/classification/pending/apply",
                )
            ) {
                return new Promise((resolve) => {
                    resolveApplyResponses.push(resolve);
                });
            }

            return Promise.resolve({
                json: async () => ({ pending }),
                ok: true,
            });
        });

        render(<DashboardWorkspace initialPeriodId="2026-05" />);
        selectDashboardTab("Uncategorized");

        await screen.findAllByRole("button", { name: "Transaction actions" });
        fireEvent.click(
            screen.getAllByRole("button", { name: "Transaction actions" })[0]!,
        );
        fireEvent.click(
            screen.getByRole("menuitem", { name: "Apply Suggestion" }),
        );
        await waitFor(() => {
            expect(
                screen.getAllByRole("button", { name: "Transaction actions" }),
            ).toHaveLength(1);
        });
        fireEvent.click(
            screen.getByRole("button", { name: "Transaction actions" }),
        );
        fireEvent.click(
            screen.getByRole("menuitem", { name: "Apply Suggestion" }),
        );

        expect(mocks.applyOptimisticWorkspaceChanges).toHaveBeenCalledTimes(2);
        expect(resolveApplyResponses).toHaveLength(2);
        expect(screen.queryByText("Earlier merchant")).not.toBeInTheDocument();
        expect(screen.queryByText("Later merchant")).not.toBeInTheDocument();

        for (const resolve of resolveApplyResponses) {
            resolve({
                json: async () =>
                    createIntegrationWorkspaceMutationResponse({
                        body: { appliedCount: 1 },
                    }),
                ok: true,
            });
        }

        await waitFor(() => {
            expect(mocks.applyWorkspaceMutationResponse).toHaveBeenCalledTimes(
                2,
            );
        });
    });

    it("shows an all-caught-up message when no uncategorized transactions remain", () => {
        mocks.snapshot.transactions.splice(
            0,
            mocks.snapshot.transactions.length,
            {
                displayAmountCents: -1_250,
                kind: "standard",
                occurredAt: "2026-05-02T00:00:00.000Z",
                payee: "Categorized merchant",
                referenceAccountId: "checking",
                status: "entered",
                transactionId: "categorized",
                updatedAt: "2026-05-02T00:00:00.000Z",
                lines: [
                    {
                        amountCents: 1_250,
                        categoryId: "groceries",
                        toAccountId: "checking",
                        transactionId: "categorized",
                    },
                ],
            } as never,
        );

        render(<DashboardWorkspace initialPeriodId="2026-05" />);
        selectDashboardTab("Uncategorized");

        expect(
            screen.getByText("All transactions are categorized."),
        ).toBeInTheDocument();
    });
});
