"use client";

import { SetupChecklist, useLedgerSetup } from "@/components/onboarding/ledger-setup";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { faGithub } from "@fortawesome/free-brands-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
    faBoxOpen,
    faChartLine,
    faChevronRight,
    faCircleInfo,
    faClock,
    faFileImport,
    faFolderOpen,
    faClipboardCheck,
    faListCheck,
    faMagnifyingGlassChart,
    faReceipt,
    faRightLeft,
    faRobot,
    faTag,
    faTriangleExclamation,
    faUsers,
    faV,
} from "@fortawesome/free-solid-svg-icons";

import { AccountsTable } from "@/components/accounts/accounts-table";
import { AmazonOrdersPanel } from "@/components/extras/amazon-orders-panel";
import {
    hasTransactionManagedMetadata,
    TransactionMemoDisplay,
} from "@/components/transactions/transaction-memo-display";
import { BudgetTable } from "@/components/budget/budget-table";
import { useBackgroundMutationActivity } from "@/components/shared/background-mutation-activity-provider";
import { useFeedbackToasts } from "@/components/shared/feedback-toast-provider";
import { GlobalPlanEditor } from "@/components/budget/global-plan-editor";
import { PeriodSelector } from "@/components/budget/period-selector";
import {
    Breadcrumbs,
    type BreadcrumbItem,
} from "@/components/dashboard/breadcrumbs";
import { EmptyStatePanel } from "@/components/dashboard/empty-state-panel";
import { MoneyAmount } from "@/components/shared/money-amount";
import {
    PaneList,
    PaneListActionMenu,
    PaneListShortcutLabel,
} from "@/components/shared/pane-list";
import { LedgerManager } from "@/components/ledgers/ledger-manager";
import type { LedgerRecord } from "@/features/ledgers/server/ledger-service";
import { CategoryDetailReport } from "@/components/reporting/category-detail-report";
import { CategoryTrackingReport } from "@/components/reporting/category-tracking-report";
import { AccountTransactionStatusBar } from "@/components/transactions/account-transaction-status-bar";
import { TransactionAccountSelector } from "@/components/transactions/transaction-account-selector";
import {
    getTransactionAutoMatchSummary,
    TransactionAutoMatchDetails,
    TransactionSourceIcon,
    VenmoManagedIcon,
} from "@/components/transactions/transaction-auto-match-details";
import { TransactionInlineEditor } from "@/components/transactions/transaction-inline-editor";
import { shouldShowTransactionClassificationConfidence } from "@/components/transactions/transaction-pending-classification-row";
import { TransactionsTable } from "@/components/transactions/transactions-table";
import { AutoAssignSourcesPanel } from "@/components/utilities/auto-assign-sources-panel";
import { AutomationPanel } from "@/components/utilities/automation-panel";
import { LedgerIntegrityPanel } from "@/components/utilities/ledger-integrity-panel";
import { LedgerTransferPanel } from "@/components/utilities/ledger-transfer-panel";
import { TransactionClassificationDebugPanel } from "@/components/utilities/transaction-classification-debug-panel";
import { TransactionClassificationLogsPanel } from "@/components/utilities/transaction-classification-logs-panel";
import { TransactionClassificationSettingsPanel } from "@/components/utilities/transaction-classification-settings-panel";
import { TransactionTemplatesPanel } from "@/components/utilities/transaction-templates-panel";
import { UserManagementPanel } from "@/components/utilities/user-management-panel";
import { VenmoPanel } from "@/components/utilities/venmo-panel";
import {
    findTransactionAutoMatches,
    type TransactionAutoMatchPair,
} from "@/features/transactions/models/transaction-auto-match";
import { createOptimisticTransactionMergeChanges } from "@/features/transactions/models/optimistic-transaction";
import { isUncategorizedAccountMovementLine } from "@/features/transactions/models/transaction-line-normalization";
import { createOptimisticPendingClassificationChanges } from "@/features/transactions/models/optimistic-pending-classification";
import type { TransactionClassificationPendingPublic } from "@/features/transaction-classification/models/transaction-classification";
import { formatTransactionDisplayDate } from "@/features/transactions/models/transaction-date";
import {
    getRememberedActiveBudgetPeriod,
    rememberActiveBudgetPeriod,
} from "@/features/budget/models/active-budget-period-memory";
import {
    ALL_TRANSACTION_ACCOUNTS_SLUG,
    findAccountByTransactionSlug,
} from "@/lib/navigation/transaction-account-routes";
import {
    navigateToTransaction,
} from "@/lib/navigation/transaction-navigation";
import { getCategoryTrackingHref } from "@/lib/navigation/category-tracking-routes";
import { parseApiErrorMessage } from "@/lib/api/client-errors";
import {
    APPLICATION_VERSION,
    formatApplicationVersionForDisplay,
} from "@/lib/application-version";
import { buildBudgetPeriodSummaryFromSnapshot } from "@/lib/workspace/budget-projector";
import { useWorkspaceStore } from "@/components/workspace/workspace-store-provider";
import {
    createBudgetContinuityTransactionQuery,
    useWorkspaceTransactions,
} from "@/components/workspace/use-workspace-transactions";
import { useTransactionReferenceLoader } from "@/components/transactions/use-transaction-reference-loader";
import { resolveWorkspaceReadiness } from "@/lib/workspace/readiness";
import { createWorkspaceMutationId } from "@/lib/workspace/mutation-id";
import {
    controlClassNames,
    getMoneyToneClassName,
    surfaceClassNames,
    typographyClassNames,
} from "@/lib/theme/theme-recipes";
import {
    buildCategoryTransactionCountByCategoryId,
    isUserVisibleBudgetCategory,
    normalizeBudgetCategoryType,
} from "@/modules/budgeting";
import {
    formatMonthlyPeriodLabel,
    getMonthlyPeriodId,
    isMonthlyPeriodId,
    transactionHasAccountActivity,
} from "@/modules/ledger";

function PageHeader({
    actions,
    breadcrumbs,
}: {
    actions?: ReactNode;
    breadcrumbs: BreadcrumbItem[];
}) {
    return (
        <div className="grid gap-3">
            <Breadcrumbs items={breadcrumbs} />
            {actions ? (
                <div className="flex flex-wrap justify-end gap-4">
                    {actions}
                </div>
            ) : null}
        </div>
    );
}

type DashboardCategoryGroupTotal = {
    availableCents: number;
    categoryType: "savings" | "spending";
    groupId: string;
    name: string;
    sortOrder: number;
};

const dashboardSectionTabs = [
    { id: "mostActive", icon: faChartLine, label: "Most active" },
    { id: "overBudget", icon: faTriangleExclamation, label: "Over budget" },
    { id: "autoMatches", icon: faRightLeft, label: "Auto Matches" },
    { id: "uncategorized", icon: faClipboardCheck, label: "Uncategorized" },
    { id: "totals", icon: faListCheck, label: "Totals" },
] as const;

type DashboardSectionTab = (typeof dashboardSectionTabs)[number]["id"];

function getDashboardSectionFromHash(hash: string): DashboardSectionTab | null {
    const sectionId = hash.startsWith("#") ? hash.slice(1) : hash;

    return (
        dashboardSectionTabs.find((tab) => tab.id === sectionId)?.id ?? null
    );
}

type PendingClassificationApplyResponse = {
    appliedCount: number;
};

const uncategorizedTransactionPageSize = 10;

function DashboardTransactionInlineEditor({
    accountLabel,
    accounts,
    categories,
    categoryBalanceById,
    onCancel,
    onSaved,
    onSubmitted,
    transaction,
}: {
    accountLabel?: string;
    accounts: Parameters<typeof TransactionInlineEditor>[0]["accounts"];
    categories: Parameters<typeof TransactionInlineEditor>[0]["categories"];
    categoryBalanceById: ReadonlyMap<string, number>;
    onCancel: () => void;
    onSaved: () => void;
    onSubmitted: () => void;
    transaction: Parameters<typeof TransactionInlineEditor>[0]["transaction"];
}) {
    const transactionLabel = transaction.payee?.trim() || "transaction";

    return (
        <div
            aria-label={`Edit ${transactionLabel}`}
            className="overflow-x-auto border border-[var(--color-border)] bg-[var(--color-panel)]"
            role="listitem"
        >
            <table className="w-full min-w-[64rem] table-fixed border-collapse text-left text-sm">
                <caption className="sr-only">Edit {transactionLabel}</caption>
                <colgroup>
                    <col className="w-10" />
                    <col className="w-28" />
                    <col className="w-36" />
                    <col className="w-48" />
                    <col className="w-48" />
                    <col />
                    <col className="w-32" />
                    <col className="w-10" />
                </colgroup>
                <thead>
                    <tr className="border-b border-[var(--color-border)] text-[var(--color-muted)]">
                        <th className="w-10 px-2 py-3 font-medium" />
                        <th className="px-4 py-3 font-medium">Date</th>
                        <th className="px-4 py-3 font-medium">Account</th>
                        <th className="px-4 py-3 font-medium">Payee</th>
                        <th className="px-4 py-3 font-medium">Category</th>
                        <th className="px-4 py-3 font-medium">Memo</th>
                        <th className="px-4 py-3 text-right font-medium">Amount</th>
                        <th className="w-10 px-2 py-3 font-medium" />
                    </tr>
                </thead>
                <tbody>
                    <TransactionInlineEditor
                        accountLabel={accountLabel}
                        accounts={accounts}
                        categories={categories}
                        categoryBalanceById={categoryBalanceById}
                        columnCount={8}
                        onCancel={onCancel}
                        onSaved={onSaved}
                        onSubmitted={onSubmitted}
                        showAccountColumn
                        sourceCell={
                            <span className="inline-flex items-center gap-1.5">
                                <TransactionSourceIcon source={transaction.source} />
                                <VenmoManagedIcon
                                    hasVenmoActivity={(transaction.importActivities ?? []).some(
                                        (activity) => activity.provider === "venmo",
                                    )}
                                    source={transaction.source}
                                />
                            </span>
                        }
                        transaction={transaction}
                    />
                </tbody>
            </table>
        </div>
    );
}

function getPendingClassificationCategoryLabel({
    categoriesById,
    pending,
}: {
    categoriesById: Map<string, { name?: string }>;
    pending: TransactionClassificationPendingPublic;
}) {
    if (pending.suggestion.type !== "category") {
        return null;
    }

    const categoryNames = Array.from(
        new Set(
            pending.suggestion.lineAssignments.map(
                (assignment) =>
                    categoriesById.get(assignment.categoryId)?.name ??
                    assignment.categoryId,
            ),
        ),
    );

    return categoryNames.length > 0 ? categoryNames.join(", ") : null;
}

function autoMatchPairIncludesTransactionIds(
    pair: TransactionAutoMatchPair,
    transactionIds: ReadonlySet<string>,
) {
    return (
        transactionIds.has(pair.left.transactionId) ||
        transactionIds.has(pair.right.transactionId)
    );
}

function getAdjacentTransactionId(
    transactions: ReadonlyArray<{ transactionId: string }>,
    transactionId: string,
) {
    const currentIndex = transactions.findIndex(
        (transaction) => transaction.transactionId === transactionId,
    );

    if (currentIndex < 0) {
        return null;
    }

    return (
        transactions[currentIndex + 1]?.transactionId ??
        transactions[currentIndex - 1]?.transactionId ??
        null
    );
}

function DashboardSectionLink({
    children,
    href,
}: {
    children: ReactNode;
    href: string;
}) {
    return (
        <div className="flex justify-end">
            <Link
                href={href}
                className="inline-flex items-center gap-1 text-sm font-medium transition hover:underline"
                style={{ color: "#5d78d4" }}
            >
                {children}
                <FontAwesomeIcon
                    aria-hidden="true"
                    icon={faChevronRight}
                    className="text-xs"
                />
            </Link>
        </div>
    );
}

export function DashboardWorkspace({
    initialPeriodId,
}: {
    initialPeriodId: string;
}) {
    const setup = useLedgerSetup();
    const {
        applyOptimisticWorkspaceChanges,
        applyWorkspaceMutationResponse,
        discardOptimisticWorkspaceChanges,
        refreshWorkspaceSnapshot,
        snapshot,
    } = useWorkspaceStore();
    const router = useRouter();
    const { loadTransactionReference } = useTransactionReferenceLoader();
    const { notifyError } = useFeedbackToasts();
    const { startActivity } = useBackgroundMutationActivity();
    const [
        pendingClassificationsByTransactionId,
        setPendingClassificationsByTransactionId,
    ] = useState<Record<string, TransactionClassificationPendingPublic>>({});
    const [
        applyingClassificationTransactionIds,
        setApplyingClassificationTransactionIds,
    ] = useState<ReadonlySet<string>>(() => new Set());
    const applyingClassificationTransactionIdsRef = useRef(new Set<string>());
    const rejectingClassificationTransactionIdsRef = useRef(new Set<string>());
    const [
        optimisticallyAppliedClassificationTransactionIds,
        setOptimisticallyAppliedClassificationTransactionIds,
    ] = useState<ReadonlySet<string>>(() => new Set());
    const [
        uncategorizedTransactionVisibleCount,
        setUncategorizedTransactionVisibleCount,
    ] = useState(uncategorizedTransactionPageSize);
    const [activeDashboardSection, setActiveDashboardSection] =
        useState<DashboardSectionTab>("mostActive");
    const dashboardSectionTabRefs = useRef<
        Record<DashboardSectionTab, HTMLButtonElement | null>
    >({
        autoMatches: null,
        mostActive: null,
        overBudget: null,
        totals: null,
        uncategorized: null,
    });
    const [expandedUncategorizedTransactionIds, setExpandedUncategorizedTransactionIds] =
        useState<ReadonlySet<string>>(() => new Set());
    const [highlightedUncategorizedTransactionId, setHighlightedUncategorizedTransactionId] =
        useState<string | null>(null);
    const [editingUncategorizedTransactionId, setEditingUncategorizedTransactionId] =
        useState<string | null>(null);

    useEffect(() => {
        function syncDashboardSectionFromLocation() {
            setActiveDashboardSection(
                getDashboardSectionFromHash(window.location.hash) ??
                    "mostActive",
            );
        }

        syncDashboardSectionFromLocation();
        window.addEventListener("hashchange", syncDashboardSectionFromLocation);
        window.addEventListener("popstate", syncDashboardSectionFromLocation);

        return () => {
            window.removeEventListener(
                "hashchange",
                syncDashboardSectionFromLocation,
            );
            window.removeEventListener(
                "popstate",
                syncDashboardSectionFromLocation,
            );
        };
    }, []);

    function selectDashboardSection(section: DashboardSectionTab) {
        setActiveDashboardSection(section);

        const nextHash = `#${section}`;

        if (window.location.hash !== nextHash) {
            window.history.pushState(null, "", nextHash);
        }
    }

    const budgetTransactionQuery = useMemo(
        () => createBudgetContinuityTransactionQuery(initialPeriodId),
        [initialPeriodId],
    );
    const {
        isLoading: isLoadingBudgetTransactions,
        transactions: budgetTransactions,
    } = useWorkspaceTransactions(budgetTransactionQuery);
    const {
        isLoading: isLoadingLedgerTransactions,
        transactions: ledgerTransactions,
    } = useWorkspaceTransactions();
    const {
        isLoading: isLoadingUncategorizedTransactions,
        transactions: uncategorizedTransactionRecords,
    } = useWorkspaceTransactions({ uncategorizedOnly: true });
    const autoMatches = useMemo(
        () =>
            findTransactionAutoMatches({
                accounts: snapshot.accounts.map((account) => ({
                    accountId: account.accountId,
                    accountType: account.accountType,
                    ledgerAccountId: account.ledgerAccountId,
                    name: account.name,
                })),
                rejections: snapshot.transactionAutoMatchRejections,
                transactions: ledgerTransactions,
            }),
        [ledgerTransactions, snapshot.accounts, snapshot.transactionAutoMatchRejections],
    );
    const mergingAutoMatchTransactionIdsRef = useRef(new Set<string>());
    const [optimisticallyMergedAutoMatchTransactionIds, setOptimisticallyMergedAutoMatchTransactionIds] =
        useState<ReadonlySet<string>>(() => new Set());
    const [isRejectingAutoMatch, setIsRejectingAutoMatch] = useState(false);
    const [expandedAutoMatchMemoTransactionIds, setExpandedAutoMatchMemoTransactionIds] =
        useState<Set<string>>(() => new Set());
    const budgetSnapshot = useMemo(
        () => ({
            ...snapshot,
            ledgerPostings: budgetTransactions.flatMap(
                (transaction) => transaction.postings,
            ),
            transactionLines: budgetTransactions.flatMap(
                (transaction) => transaction.lines,
            ),
            transactions: budgetTransactions,
        }),
        [budgetTransactions, snapshot],
    );
    const summary = useMemo(
        () => buildBudgetPeriodSummaryFromSnapshot(budgetSnapshot, initialPeriodId),
        [budgetSnapshot, initialPeriodId],
    );
    const categoriesById = useMemo(
        () =>
            new Map(
                snapshot.budgetCategories
                    .filter(isUserVisibleBudgetCategory)
                    .map((category) => [category.categoryId, category]),
            ),
        [snapshot.budgetCategories],
    );
    const autoMatchCategoryNameById = useMemo(
        () =>
            new Map(
                snapshot.budgetCategories
                    .filter(isUserVisibleBudgetCategory)
                    .map((category) => [category.categoryId, category.name]),
            ),
        [snapshot.budgetCategories],
    );
    const categoryRows = useMemo(
        () =>
            summary.categories.flatMap((categorySummary) => {
                const category = categoriesById.get(categorySummary.categoryId);

                if (!category) {
                    return [];
                }

                return [
                    {
                        ...categorySummary,
                        categoryType: normalizeBudgetCategoryType(
                            category.categoryType,
                        ),
                        groupId: category.groupId,
                    },
                ];
            }),
        [categoriesById, summary.categories],
    );
    const budgetGroupsById = useMemo(
        () =>
            new Map(
                snapshot.budgetGroups.map((group) => [group.groupId, group]),
            ),
        [snapshot.budgetGroups],
    );
    const overspentCategories = useMemo(
        () =>
            categoryRows
                .filter(
                    (category) =>
                        category.categoryType === "spending" &&
                        category.availableCents < 0,
                )
                .sort(
                    (left, right) => left.availableCents - right.availableCents,
                )
                .slice(0, 10),
        [categoryRows],
    );
    const categoryTransactionCounts = useMemo(
        () =>
            buildCategoryTransactionCountByCategoryId({
                accounts: snapshot.accounts,
                categories: categoryRows,
                lines: ledgerTransactions.flatMap(
                    (transaction) => transaction.lines,
                ),
                transactions: ledgerTransactions,
            }),
        [categoryRows, ledgerTransactions, snapshot.accounts],
    );
    const mostActiveCategories = useMemo(
        () =>
            categoryRows
                .filter(
                    (category) =>
                        (categoryTransactionCounts.get(category.categoryId) ??
                            0) > 0,
                )
                .sort(
                    (left, right) =>
                        (categoryTransactionCounts.get(right.categoryId) ?? 0) -
                            (categoryTransactionCounts.get(left.categoryId) ??
                                0) ||
                        left.name.localeCompare(right.name),
                )
                .slice(0, 10),
        [categoryRows, categoryTransactionCounts],
    );
    const rankedCategories =
        activeDashboardSection === "overBudget"
            ? overspentCategories
            : mostActiveCategories;
    const isLoadingRankedCategories =
        activeDashboardSection === "overBudget"
            ? isLoadingBudgetTransactions
            : isLoadingLedgerTransactions;
    const categoryTotalsByGroup = useMemo(() => {
        const totalsByTypeAndGroup = new Map<
            string,
            DashboardCategoryGroupTotal
        >();

        for (const category of categoryRows) {
            const group = budgetGroupsById.get(category.groupId);
            const key = `${category.categoryType}:${category.groupId}`;
            const current = totalsByTypeAndGroup.get(key);

            if (current) {
                current.availableCents += category.availableCents;
                continue;
            }

            totalsByTypeAndGroup.set(key, {
                availableCents: category.availableCents,
                categoryType: category.categoryType,
                groupId: category.groupId,
                name: group?.name ?? "Other categories",
                sortOrder: group?.sortOrder ?? Number.MAX_SAFE_INTEGER,
            });
        }

        const sortGroups = (
            left: DashboardCategoryGroupTotal,
            right: DashboardCategoryGroupTotal,
        ) =>
            left.sortOrder - right.sortOrder ||
            left.name.localeCompare(right.name);
        const groupTotals = Array.from(totalsByTypeAndGroup.values()).sort(
            sortGroups,
        );

        return {
            savings: groupTotals.filter(
                (group) => group.categoryType === "savings",
            ),
            spending: groupTotals.filter(
                (group) => group.categoryType === "spending",
            ),
        };
    }, [budgetGroupsById, categoryRows]);
    const totals = useMemo(
        () =>
            categoryRows.reduce(
                (current, category) => {
                    current.allCategoriesCents += category.availableCents;

                    if (category.categoryType === "savings") {
                        current.savingsCents += category.availableCents;
                    } else {
                        current.spendingCents += category.availableCents;
                    }

                    return current;
                },
                {
                    allCategoriesCents: 0,
                    savingsCents: 0,
                    spendingCents: 0,
                },
            ),
        [categoryRows],
    );
    const accountNameById = useMemo(
        () =>
            new Map(
                snapshot.accounts.map((account) => [
                    account.accountId,
                    account.name,
                ]),
            ),
        [snapshot.accounts],
    );
    const allUncategorizedTransactions = useMemo(
        () =>
            uncategorizedTransactionRecords
                .filter(
                    (transaction) =>
                        transaction.status !== "voided" &&
                        transactionHasUncategorizedActivity(transaction) &&
                        !optimisticallyAppliedClassificationTransactionIds.has(
                            transaction.transactionId,
                        ),
                )
                .sort(
                    (left, right) =>
                        left.occurredAt.localeCompare(right.occurredAt) ||
                        left.transactionId.localeCompare(right.transactionId),
                ),
        [
            optimisticallyAppliedClassificationTransactionIds,
            uncategorizedTransactionRecords,
        ],
    );
    const uncategorizedTransactions = allUncategorizedTransactions.slice(
        0,
        uncategorizedTransactionVisibleCount,
    );
    const dashboardCategoryBalanceById = useMemo(
        () =>
            new Map(
                summary.categories.map((category) => [
                    category.categoryId,
                    category.availableCents,
                ]),
            ),
        [summary.categories],
    );
    const dashboardTransactionCategories = useMemo(
        () => snapshot.budgetCategories.filter(isUserVisibleBudgetCategory),
        [snapshot.budgetCategories],
    );
    const visibleAutoMatchPairs = useMemo(
        () =>
            autoMatches.readyPairs.filter(
                (pair) =>
                    !autoMatchPairIncludesTransactionIds(
                        pair,
                        optimisticallyMergedAutoMatchTransactionIds,
                    ),
            ),
        [autoMatches.readyPairs, optimisticallyMergedAutoMatchTransactionIds],
    );
    const uncategorizedTransactionIdsKey = uncategorizedTransactions
        .map((transaction) => transaction.transactionId)
        .join("\n");

    async function mergeAutoMatch(pair: TransactionAutoMatchPair) {
        const transactionIds = [
            pair.left.transactionId,
            pair.right.transactionId,
        ];

        if (
            transactionIds.some((transactionId) =>
                mergingAutoMatchTransactionIdsRef.current.has(transactionId),
            )
        ) {
            return;
        }

        const transactionsById = new Map(
            ledgerTransactions.map((transaction) => [
                transaction.transactionId,
                transaction,
            ]),
        );
        const left = transactionsById.get(pair.left.transactionId);
        const right = transactionsById.get(pair.right.transactionId);

        if (!left || !right) {
            return;
        }

        const optimisticMutationId = applyOptimisticWorkspaceChanges(
            createOptimisticTransactionMergeChanges({
                accounts: snapshot.accounts,
                categories: snapshot.budgetCategories,
                expectedMatchType: pair.matchType,
                plaidTransactionSyncRecords: snapshot.plaidTransactionSyncs,
                transactions: [left, right],
            }),
        );

        for (const transactionId of transactionIds) {
            mergingAutoMatchTransactionIdsRef.current.add(transactionId);
        }
        setOptimisticallyMergedAutoMatchTransactionIds((current) =>
            new Set([...current, ...transactionIds]),
        );
        const activity = startActivity({
            completedLabel: "Transactions merged.",
            pendingLabel: "Merging transactions…",
        });

        try {
            const response = await fetch("/api/transactions/merge", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    expectedMatchType: pair.matchType,
                    mutationId: createWorkspaceMutationId(),
                    transactionIds,
                }),
            });

            if (!response.ok) {
                throw new Error(
                    await parseApiErrorMessage(
                        response,
                        "Unable to merge transactions.",
                    ),
                );
            }

            await applyWorkspaceMutationResponse(response, {
                optimisticMutationId,
            });
            activity.complete();
        } catch (error) {
            activity.fail();
            discardOptimisticWorkspaceChanges(optimisticMutationId);
            await refreshWorkspaceSnapshot();
            notifyError({
                message:
                    error instanceof Error
                        ? error.message
                        : "Unable to merge transactions.",
                title: "Transactions could not be merged.",
            });
        } finally {
            for (const transactionId of transactionIds) {
                mergingAutoMatchTransactionIdsRef.current.delete(transactionId);
            }
            setOptimisticallyMergedAutoMatchTransactionIds((current) => {
                const next = new Set(current);

                for (const transactionId of transactionIds) {
                    next.delete(transactionId);
                }

                return next;
            });
        }
    }

    function toggleAutoMatchMemo(transactionId: string) {
        setExpandedAutoMatchMemoTransactionIds((current) => {
            const next = new Set(current);

            if (next.has(transactionId)) {
                next.delete(transactionId);
            } else {
                next.add(transactionId);
            }

            return next;
        });
    }

    function toggleAutoMatchPairMemos(pair: TransactionAutoMatchPair) {
        const transactionIds = [
            pair.left.transactionId,
            pair.right.transactionId,
        ];

        setExpandedAutoMatchMemoTransactionIds((current) => {
            const next = new Set(current);
            const isExpanded = transactionIds.every((transactionId) =>
                next.has(transactionId),
            );

            for (const transactionId of transactionIds) {
                if (isExpanded) {
                    next.delete(transactionId);
                } else {
                    next.add(transactionId);
                }
            }

            return next;
        });
    }

    async function rejectAutoMatch(pair: TransactionAutoMatchPair) {
        if (isRejectingAutoMatch) {
            return;
        }

        setIsRejectingAutoMatch(true);
        const activity = startActivity({
            completedLabel: "Auto match rejected.",
            pendingLabel: "Rejecting auto match…",
        });

        try {
            const response = await fetch(
                "/api/transactions/auto-match-rejections",
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        mutationId: createWorkspaceMutationId(),
                        transactionIds: [
                            pair.left.transactionId,
                            pair.right.transactionId,
                        ],
                    }),
                },
            );

            if (!response.ok) {
                throw new Error(
                    await parseApiErrorMessage(
                        response,
                        "Unable to update the auto-match decision.",
                    ),
                );
            }

            await applyWorkspaceMutationResponse(response);
            activity.complete();
        } catch (error) {
            activity.fail();
            notifyError({
                message:
                    error instanceof Error
                        ? error.message
                        : "Unable to update the auto-match decision.",
                title: "Auto match could not be updated.",
            });
        } finally {
            setIsRejectingAutoMatch(false);
        }
    }

    useEffect(() => {
        const transactionIds = uncategorizedTransactionIdsKey
            .split("\n")
            .filter(Boolean);

        if (transactionIds.length === 0) {
            return;
        }

        let isCurrent = true;

        async function loadPendingClassifications() {
            try {
                const response = await fetch(
                    "/api/transactions/classification/pending",
                    {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ transactionIds }),
                    },
                );

                if (!response.ok) {
                    throw response;
                }

                const payload = (await response.json()) as {
                    pending?: TransactionClassificationPendingPublic[];
                };

                if (!isCurrent) {
                    return;
                }

                setPendingClassificationsByTransactionId((current) => {
                    const next = { ...current };

                    for (const transactionId of transactionIds) {
                        delete next[transactionId];
                    }

                    for (const pending of payload.pending ?? []) {
                        next[pending.transactionId] = pending;
                    }

                    return next;
                });
            } catch (error) {
                if (!isCurrent) {
                    return;
                }

                notifyError({
                    message:
                        error instanceof Response
                            ? await parseApiErrorMessage(
                                  error,
                                  "Unable to load AI classifications.",
                              )
                            : error instanceof Error
                              ? error.message
                              : "Unable to load AI classifications.",
                    title: "AI classifications could not be loaded.",
                });
            }
        }

        void loadPendingClassifications();

        return () => {
            isCurrent = false;
        };
    }, [notifyError, uncategorizedTransactionIdsKey]);

    async function applyPendingClassification(
        pending: TransactionClassificationPendingPublic,
    ) {
        if (
            applyingClassificationTransactionIdsRef.current.has(
                pending.transactionId,
            )
        ) {
            return;
        }

        const transaction = allUncategorizedTransactions.find(
            (candidate) => candidate.transactionId === pending.transactionId,
        );

        if (!transaction || pending.suggestion.type === "noSuggestion") {
            return;
        }

        let optimisticChanges: ReturnType<
            typeof createOptimisticPendingClassificationChanges
        >;

        try {
            optimisticChanges = createOptimisticPendingClassificationChanges({
                accounts: snapshot.accounts,
                categories: snapshot.budgetCategories,
                fieldSelection: {
                    applySuggestedMemo: false,
                    applySuggestedPayee: false,
                },
                pending,
                transaction,
            });
        } catch (error) {
            notifyError({
                message:
                    error instanceof Error
                        ? error.message
                        : "Unable to prepare the AI classification.",
                title: "Classification could not be applied.",
            });
            return;
        }

        const optimisticMutationId = applyOptimisticWorkspaceChanges(
            optimisticChanges,
        );

        if (
            highlightedUncategorizedTransactionId === pending.transactionId
        ) {
            setHighlightedUncategorizedTransactionId(
                getAdjacentTransactionId(
                    allUncategorizedTransactions,
                    pending.transactionId,
                ),
            );
        }

        applyingClassificationTransactionIdsRef.current.add(
            pending.transactionId,
        );
        setApplyingClassificationTransactionIds((current) =>
            new Set(current).add(pending.transactionId),
        );
        const activity = startActivity({
            completedLabel: "AI classification applied.",
            pendingLabel: "Applying AI classification…",
        });

        setOptimisticallyAppliedClassificationTransactionIds((current) =>
            new Set(current).add(pending.transactionId),
        );
        setPendingClassificationsByTransactionId((current) => {
            const next = { ...current };
            delete next[pending.transactionId];
            return next;
        });

        try {
            const response = await fetch(
                "/api/transactions/classification/pending/apply",
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        fieldSelection: {
                            applySuggestedMemo: false,
                            applySuggestedPayee: false,
                        },
                        mutationId: createWorkspaceMutationId(),
                        transactionId: pending.transactionId,
                    }),
                },
            );

            if (!response.ok) {
                throw response;
            }

            await applyWorkspaceMutationResponse<PendingClassificationApplyResponse>(
                response,
                { optimisticMutationId },
            );

            activity.complete();
        } catch (error) {
            activity.fail();
            discardOptimisticWorkspaceChanges(optimisticMutationId);
            await refreshWorkspaceSnapshot();

            setPendingClassificationsByTransactionId((current) => ({
                ...current,
                [pending.transactionId]: pending,
            }));

            notifyError({
                message:
                    `${
                        error instanceof Response
                            ? await parseApiErrorMessage(
                                  error,
                                  "Unable to apply AI classification.",
                              )
                            : error instanceof Error
                              ? error.message
                              : "Unable to apply AI classification."
                    } The latest saved data has been restored.`,
                title: "Classification could not be applied.",
            });
        } finally {
            applyingClassificationTransactionIdsRef.current.delete(
                pending.transactionId,
            );
            setOptimisticallyAppliedClassificationTransactionIds((current) => {
                const next = new Set(current);
                next.delete(pending.transactionId);
                return next;
            });
            setApplyingClassificationTransactionIds((current) => {
                const next = new Set(current);
                next.delete(pending.transactionId);
                return next;
            });
        }
    }

    async function rejectPendingClassification(
        pending: TransactionClassificationPendingPublic,
    ) {
        if (
            pending.status === "rejected" ||
            rejectingClassificationTransactionIdsRef.current.has(
                pending.transactionId,
            )
        ) {
            return;
        }

        rejectingClassificationTransactionIdsRef.current.add(
            pending.transactionId,
        );
        setPendingClassificationsByTransactionId((current) => ({
            ...current,
            [pending.transactionId]: {
                ...pending,
                status: "rejected",
            },
        }));
        const activity = startActivity({
            completedLabel: "AI classification rejected.",
            pendingLabel: "Rejecting AI classification…",
        });

        try {
            const response = await fetch(
                "/api/transactions/classification/pending/reject",
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ transactionId: pending.transactionId }),
                },
            );

            if (!response.ok) {
                throw response;
            }

            const payload = (await response.json()) as {
                pending?: TransactionClassificationPendingPublic | null;
            };

            if (!payload.pending) {
                throw new Error("The rejected AI classification was not returned.");
            }

            setPendingClassificationsByTransactionId((current) => ({
                ...current,
                [pending.transactionId]: payload.pending!,
            }));
            activity.complete();
        } catch (error) {
            activity.fail();
            setPendingClassificationsByTransactionId((current) => ({
                ...current,
                [pending.transactionId]: pending,
            }));
            notifyError({
                message:
                    error instanceof Response
                        ? await parseApiErrorMessage(
                              error,
                              "Unable to reject AI classification.",
                          )
                        : error instanceof Error
                          ? error.message
                          : "Unable to reject AI classification.",
                title: "Classification could not be rejected.",
            });
        } finally {
            rejectingClassificationTransactionIdsRef.current.delete(
                pending.transactionId,
            );
        }
    }

    if (
        setup?.state?.status === "completed" ||
        (setup && (!setup.state || setup.state.status === "active") && !isLoadingLedgerTransactions && ledgerTransactions.length === 0)
    ) {
        return (
            <div className="grid gap-8">
                <PageHeader breadcrumbs={[{ label: "Home" }]} />
                <SetupChecklist />
            </div>
        );
    }

    return (
        <div className="grid gap-8">
            <PageHeader breadcrumbs={[{ label: "Home" }]} />
            <SetupChecklist />

            <section className="grid gap-4">
                <div className="flex justify-center">
                    <div
                        aria-label="Home sections"
                        className="flex w-fit max-w-full overflow-x-auto border border-[var(--color-border)]"
                        role="tablist"
                    >
                        {dashboardSectionTabs.map((tab, index) => {
                            const isActive = activeDashboardSection === tab.id;
                            const pendingItemCount =
                                tab.id === "autoMatches"
                                    ? visibleAutoMatchPairs.length
                                    : tab.id === "uncategorized"
                                      ? allUncategorizedTransactions.length
                                      : 0;

                            return (
                                <button
                                    aria-controls="dashboard-overview-panel"
                                    aria-selected={isActive}
                                    className={`inline-flex shrink-0 cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[var(--color-accent-ring)] ${
                                        index > 0
                                            ? "border-l border-[var(--color-border)]"
                                            : ""
                                    } ${
                                        isActive
                                            ? "bg-[var(--color-accent-soft)] text-[var(--color-ink)]"
                                            : "bg-[var(--color-panel)] text-[var(--color-muted)] hover:bg-[var(--color-panel-elevated)] hover:text-[var(--color-ink)]"
                                    }`}
                                    id={`dashboard-${tab.id}-tab`}
                                    key={tab.id}
                                    onClick={() => selectDashboardSection(tab.id)}
                                    onKeyDown={(event) => {
                                        let nextTabIndex: number;

                                        if (event.key === "ArrowLeft") {
                                            nextTabIndex =
                                                (index - 1 +
                                                    dashboardSectionTabs.length) %
                                                dashboardSectionTabs.length;
                                        } else if (event.key === "ArrowRight") {
                                            nextTabIndex =
                                                (index + 1) %
                                                dashboardSectionTabs.length;
                                        } else if (event.key === "Home") {
                                            nextTabIndex = 0;
                                        } else if (event.key === "End") {
                                            nextTabIndex =
                                                dashboardSectionTabs.length - 1;
                                        } else {
                                            return;
                                        }

                                        const nextTab =
                                            dashboardSectionTabs[nextTabIndex];

                                        if (!nextTab) {
                                            return;
                                        }

                                        event.preventDefault();
                                        selectDashboardSection(nextTab.id);
                                        dashboardSectionTabRefs.current[
                                            nextTab.id
                                        ]?.focus();
                                    }}
                                    ref={(element) => {
                                        dashboardSectionTabRefs.current[tab.id] =
                                            element;
                                    }}
                                    role="tab"
                                    tabIndex={isActive ? 0 : -1}
                                    type="button"
                                >
                                    <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
                                        <FontAwesomeIcon
                                            aria-hidden="true"
                                            icon={tab.icon}
                                        />
                                        {pendingItemCount > 0 ? (
                                            <span
                                                aria-hidden="true"
                                                className="pointer-events-none absolute -right-1.5 -top-2 flex size-3.5 items-center justify-center rounded-full bg-[#a52b3a] text-[0.5625rem] font-bold leading-none text-white"
                                                data-dashboard-tab-attention-marker
                                            >
                                                {pendingItemCount}
                                            </span>
                                        ) : null}
                                    </span>
                                    <span>{tab.label}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>

                <span className={typographyClassNames.eyebrow}>
                    {activeDashboardSection === "autoMatches"
                        ? visibleAutoMatchPairs.length === 1
                            ? "1 ready match"
                            : `${visibleAutoMatchPairs.length} ready matches`
                        : activeDashboardSection === "uncategorized"
                        ? allUncategorizedTransactions.length >
                          uncategorizedTransactions.length
                            ? `${uncategorizedTransactions.length} of ${allUncategorizedTransactions.length} transactions`
                            : uncategorizedTransactions.length === 1
                              ? "1 transaction"
                              : `${uncategorizedTransactions.length} transactions`
                        : formatMonthlyPeriodLabel(summary.periodId)}
                </span>

                <div
                    aria-labelledby={`dashboard-${activeDashboardSection}-tab`}
                    id="dashboard-overview-panel"
                    role="tabpanel"
                >
                    {activeDashboardSection === "overBudget" ||
                    activeDashboardSection === "mostActive" ? (
                        <div className="grid gap-4">
                            {isLoadingRankedCategories ? (
                                <p
                                    className={`text-sm ${typographyClassNames.mutedBody}`}
                                >
                                    Loading budget activity...
                                </p>
                            ) : rankedCategories.length > 0 ? (
                                <PaneList aria-label="Category trends">
                                    {rankedCategories.map((category) => {
                                        const viewTrendId =
                                            `dashboard-category-${category.categoryId}-trend`;

                                        return (
                                            <PaneList.Item
                                                key={category.categoryId}
                                                itemId={category.categoryId}
                                                aria-label={category.name}
                                                className="px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                                                onDefaultAction={() => {
                                                    document
                                                        .getElementById(
                                                            viewTrendId,
                                                        )
                                                        ?.click();
                                                }}
                                            >
                                                <div className="min-w-0">
                                                    <p className="truncate font-medium text-[var(--color-ink)]">
                                                        {category.name}
                                                    </p>
                                                    <p
                                                        className={`mt-1 text-xs ${typographyClassNames.mutedBody}`}
                                                    >
                                                        Month start{" "}
                                                        <MoneyAmount
                                                            cents={
                                                                category.carriedForwardCents
                                                            }
                                                        />
                                                        {" · "}Assigned{" "}
                                                        <MoneyAmount
                                                            cents={
                                                                category.assignedCents
                                                            }
                                                        />
                                                        {" · "}
                                                        {activeDashboardSection ===
                                                        "overBudget"
                                                            ? "Activity"
                                                            : "Available"}{" "}
                                                        <MoneyAmount
                                                            cents={
                                                                activeDashboardSection ===
                                                                "overBudget"
                                                                    ? category.activityCents
                                                                    : category.availableCents
                                                            }
                                                        />
                                                    </p>
                                                </div>
                                                <div className="grid grid-cols-[7rem_auto] items-center justify-end gap-3 text-right">
                                                    <div className="w-28">
                                                        <p className="text-xs text-[var(--color-muted)]">
                                                            {category.availableCents <
                                                            0
                                                                ? "Over by"
                                                                : category.availableCents >
                                                                    0
                                                                  ? "Under by"
                                                                  : "On budget"}
                                                        </p>
                                                        <p
                                                            className={`text-base font-semibold ${getMoneyToneClassName(
                                                                category.availableCents,
                                                            )}`}
                                                        >
                                                            <MoneyAmount
                                                                cents={
                                                                    category.availableCents
                                                                }
                                                            />
                                                        </p>
                                                    </div>
                                                    <Link
                                                        id={viewTrendId}
                                                        className={`inline-flex cursor-pointer items-center gap-2 ${controlClassNames.secondaryActionSmall}`}
                                                        href={getCategoryTrackingHref(
                                                            category.categoryId,
                                                        )}
                                                    >
                                                        <FontAwesomeIcon
                                                            aria-hidden="true"
                                                            icon={faChartLine}
                                                        />
                                                        View trend
                                                    </Link>
                                                </div>
                                            </PaneList.Item>
                                        );
                                    })}
                                </PaneList>
                            ) : (
                                <p
                                    className={`text-sm ${typographyClassNames.mutedBody}`}
                                >
                                    {activeDashboardSection === "overBudget"
                                        ? "No spending categories are over budget."
                                        : "No category activity in this ledger."}
                                </p>
                            )}
                            <DashboardSectionLink
                                href={`/budget?month=${summary.periodId}`}
                            >
                                View monthly budget
                            </DashboardSectionLink>
                        </div>
                    ) : activeDashboardSection === "autoMatches" ? (
                        <div className="grid gap-4">
                            {isLoadingLedgerTransactions ? (
                                <p
                                    className={`text-sm ${typographyClassNames.mutedBody}`}
                                >
                                    Loading auto matches...
                                </p>
                            ) : visibleAutoMatchPairs.length > 0 ? (
                                <PaneList aria-label="Ready auto matches">
                                    {visibleAutoMatchPairs.map((pair) => {
                                        const isBusy = isRejectingAutoMatch;
                                        const transfer =
                                            pair.matchType === "duplicate"
                                                ? undefined
                                                : pair.transfer;
                                        const isCreditCardPayment =
                                            pair.matchType ===
                                            "creditCardPayment";
                                        const pairId = [
                                            pair.left.transactionId,
                                            pair.right.transactionId,
                                        ]
                                            .sort()
                                            .join(":");
                                        const isPairExpanded = [
                                            pair.left.transactionId,
                                            pair.right.transactionId,
                                        ].every((transactionId) =>
                                            expandedAutoMatchMemoTransactionIds.has(
                                                transactionId,
                                            ),
                                        );

                                        return (
                                            <PaneList.Item
                                                key={pairId}
                                                itemId={pairId}
                                                aria-label={`${getTransactionAutoMatchSummary(pair.left)} and ${getTransactionAutoMatchSummary(pair.right)}`}
                                                onClick={() => {
                                                    toggleAutoMatchPairMemos(pair);
                                                }}
                                                onDefaultAction={() => {
                                                    toggleAutoMatchPairMemos(pair);
                                                }}
                                                shortcuts={[
                                                    {
                                                        disabled: isBusy,
                                                        key: "d",
                                                        onAction: () => {
                                                            void rejectAutoMatch(pair);
                                                        },
                                                    },
                                                    {
                                                        disabled: isBusy,
                                                        key: "m",
                                                        onAction: () => {
                                                            void mergeAutoMatch(pair);
                                                        },
                                                    },
                                                ]}
                                            >
                                                <div className="grid min-w-0 items-center gap-3 sm:grid-cols-[minmax(0,1fr)_2rem_minmax(0,1fr)_minmax(11rem,15rem)_auto_auto]">
                                                    <TransactionAutoMatchDetails
                                                        categoryNameById={
                                                            autoMatchCategoryNameById
                                                        }
                                                        isMemoExpanded={
                                                            expandedAutoMatchMemoTransactionIds.has(
                                                                pair.left
                                                                    .transactionId,
                                                            )
                                                        }
                                                        onToggleMemo={() => {
                                                            toggleAutoMatchMemo(
                                                                pair.left
                                                                    .transactionId,
                                                            );
                                                        }}
                                                        transaction={pair.left}
                                                    />
                                                    <FontAwesomeIcon
                                                        aria-hidden="true"
                                                        icon={faRightLeft}
                                                        className="hidden justify-self-center text-[var(--color-muted)] sm:block"
                                                    />
                                                    <TransactionAutoMatchDetails
                                                        categoryNameById={
                                                            autoMatchCategoryNameById
                                                        }
                                                        isMemoExpanded={
                                                            expandedAutoMatchMemoTransactionIds.has(
                                                                pair.right
                                                                    .transactionId,
                                                            )
                                                        }
                                                        onToggleMemo={() => {
                                                            toggleAutoMatchMemo(
                                                                pair.right
                                                                    .transactionId,
                                                            );
                                                        }}
                                                        transaction={pair.right}
                                                    />
                                                    <div className="flex flex-wrap items-center justify-between gap-2 sm:contents">
                                                        <div
                                                            className={`min-w-0 text-right text-sm font-medium ${
                                                                isPairExpanded
                                                                    ? "whitespace-normal break-words"
                                                                    : "whitespace-nowrap"
                                                            }`}
                                                        >
                                                            {transfer ? (
                                                                <p className="text-xs font-medium text-[var(--color-ink)]">
                                                                    {isCreditCardPayment
                                                                        ? "Credit card payment"
                                                                        : "Bank transfer"}
                                                                </p>
                                                            ) : null}
                                                            <span
                                                                className={getMoneyToneClassName(
                                                                    transfer
                                                                        ? -transfer.amountCents
                                                                        : pair.left
                                                                              .displayAmountCents,
                                                                )}
                                                            >
                                                                <MoneyAmount
                                                                    cents={
                                                                        transfer
                                                                            ? -transfer.amountCents
                                                                            : pair.left
                                                                                  .displayAmountCents
                                                                    }
                                                                />
                                                            </span>
                                                            {transfer ? (
                                                                <p
                                                                    className={`text-xs font-normal text-[var(--color-muted)] ${
                                                                        isPairExpanded
                                                                            ? "whitespace-normal break-words"
                                                                            : "truncate"
                                                                    }`}
                                                                >
                                                                    {
                                                                        transfer.sourceAccount
                                                                            .name
                                                                    }{" "}
                                                                    {"->"}{" "}
                                                                    {
                                                                        transfer.destinationAccount
                                                                            .name
                                                                    }
                                                                </p>
                                                            ) : (
                                                                <p
                                                                    className={`text-xs font-normal text-[var(--color-muted)] ${
                                                                        isPairExpanded
                                                                            ? "whitespace-normal break-words"
                                                                            : "truncate"
                                                                    }`}
                                                                >
                                                                    {pair.account.name}
                                                                </p>
                                                            )}
                                                        </div>
                                                        <button
                                                            type="button"
                                                            disabled={isBusy}
                                                            onClick={(event) => {
                                                                event.stopPropagation();
                                                                void rejectAutoMatch(
                                                                    pair,
                                                                );
                                                            }}
                                                            className={
                                                                controlClassNames.secondarySolidActionCompact
                                                            }
                                                        >
                                                            <PaneListShortcutLabel label="Do not Merge" />
                                                        </button>
                                                        <button
                                                            type="button"
                                                            disabled={isBusy}
                                                            onClick={(event) => {
                                                                event.stopPropagation();
                                                                void mergeAutoMatch(
                                                                    pair,
                                                                );
                                                            }}
                                                            className={
                                                                controlClassNames.primaryActionCompact
                                                            }
                                                        >
                                                            <PaneListShortcutLabel label="Merge" />
                                                        </button>
                                                    </div>
                                                </div>
                                            </PaneList.Item>
                                        );
                                    })}
                                </PaneList>
                            ) : (
                                <div className="flex items-center gap-2 text-sm text-[var(--color-ink)]">
                                    <FontAwesomeIcon
                                        aria-hidden="true"
                                        icon={faClipboardCheck}
                                        className="text-3xl"
                                    />
                                    <p>No auto matches are ready to merge.</p>
                                </div>
                            )}
                        </div>
                    ) : activeDashboardSection === "uncategorized" ? (
                        <div className="grid gap-4">
                            {isLoadingUncategorizedTransactions ? (
                    <p className={`text-sm ${typographyClassNames.mutedBody}`}>
                        Loading uncategorized transactions...
                    </p>
                ) : uncategorizedTransactions.length > 0 ? (
                    <PaneList
                        aria-label="Uncategorized transactions"
                        highlightedItemId={highlightedUncategorizedTransactionId}
                        onHighlightedItemIdChange={
                            setHighlightedUncategorizedTransactionId
                        }
                        suppressHoverWhenHighlighted
                    >
                        {uncategorizedTransactions.map((transaction) => {
                            const accountName = accountNameById.get(
                                transaction.referenceAccountId,
                            );
                            const pending =
                                pendingClassificationsByTransactionId[
                                    transaction.transactionId
                                ];
                            const pendingCategoryClassification =
                                pending &&
                                pending.status !== "rejected" &&
                                pending.transactionUpdatedAt ===
                                    transaction.updatedAt &&
                                pending.suggestion.type === "category"
                                    ? pending
                                    : null;
                            const suggestedCategoryLabel =
                                pendingCategoryClassification
                                    ? getPendingClassificationCategoryLabel({
                                          categoriesById,
                                          pending:
                                              pendingCategoryClassification,
                                      })
                                    : null;
                            const showClassificationConfidence =
                                pendingCategoryClassification
                                    ? shouldShowTransactionClassificationConfidence(
                                          pendingCategoryClassification.suggestion,
                                      )
                                    : false;
                            const isExpanded =
                                expandedUncategorizedTransactionIds.has(
                                    transaction.transactionId,
                                );
                            const isClassificationBusy =
                                applyingClassificationTransactionIds.has(
                                    transaction.transactionId,
                                );
                            const toggleExpanded = () => {
                                setExpandedUncategorizedTransactionIds(
                                    (current) => {
                                        const next = new Set(current);

                                        if (
                                            next.has(transaction.transactionId)
                                        ) {
                                            next.delete(
                                                transaction.transactionId,
                                            );
                                        } else {
                                            next.add(transaction.transactionId);
                                        }

                                        return next;
                                    },
                                );
                            };

                            if (
                                editingUncategorizedTransactionId ===
                                transaction.transactionId
                            ) {
                                return (
                                    <DashboardTransactionInlineEditor
                                        key={transaction.transactionId}
                                        accountLabel={accountName}
                                        accounts={snapshot.accounts}
                                        categories={dashboardTransactionCategories}
                                        categoryBalanceById={
                                            dashboardCategoryBalanceById
                                        }
                                        onCancel={() =>
                                            setEditingUncategorizedTransactionId(
                                                null,
                                            )
                                        }
                                        onSaved={() => {
                                            setPendingClassificationsByTransactionId(
                                                (current) => {
                                                    const next = { ...current };
                                                    delete next[
                                                        transaction.transactionId
                                                    ];
                                                    return next;
                                                },
                                            );
                                        }}
                                        onSubmitted={() =>
                                            setEditingUncategorizedTransactionId(
                                                null,
                                            )
                                        }
                                        transaction={transaction}
                                    />
                                );
                            }

                            return (
                                <PaneList.Item
                                    key={transaction.transactionId}
                                    itemId={transaction.transactionId}
                                    aria-label={
                                        transaction.payee?.trim() ||
                                        "Uncategorized transaction"
                                    }
                                    data-testid={`uncategorized-transaction-${transaction.transactionId}`}
                                    onClick={toggleExpanded}
                                    onDefaultAction={toggleExpanded}
                                    shortcuts={[
                                        ...(pendingCategoryClassification
                                            ? [
                                                  {
                                                      disabled:
                                                          isClassificationBusy,
                                                      key: "a",
                                                      onAction: () => {
                                                          void applyPendingClassification(
                                                              pendingCategoryClassification,
                                                          );
                                                      },
                                                  },
                                                  {
                                                      disabled:
                                                          isClassificationBusy,
                                                      key: "i",
                                                      onAction: () => {
                                                          void rejectPendingClassification(
                                                              pendingCategoryClassification,
                                                          );
                                                      },
                                                  },
                                              ]
                                            : []),
                                        {
                                            key: "e",
                                            onAction: () => {
                                                setEditingUncategorizedTransactionId(
                                                    transaction.transactionId,
                                                );
                                            },
                                        },
                                        {
                                            key: "v",
                                            onAction: () => {
                                                void navigateToTransaction({
                                                    loadTransactionReference,
                                                    router,
                                                    snapshot,
                                                    transactionId:
                                                        transaction.transactionId,
                                                });
                                            },
                                        },
                                    ]}
                                    className="w-full px-4 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-center sm:gap-4"
                                >
                                    <div className="min-w-0">
                                        <div
                                            className={`flex flex-wrap gap-x-2 text-xs ${typographyClassNames.mutedBody}`}
                                        >
                                            <span>
                                                {formatTransactionDisplayDate(
                                                    transaction.occurredAt,
                                                )}
                                            </span>
                                            {accountName ? (
                                                <span>{accountName}</span>
                                            ) : null}
                                        </div>
                                        <div
                                            className={`mt-1 flex min-w-0 gap-2 ${
                                                isExpanded
                                                    ? "items-start"
                                                    : "items-baseline"
                                            }`}
                                        >
                                            <span
                                                className={
                                                    isExpanded
                                                        ? "min-w-0 break-words font-medium text-[var(--color-ink)]"
                                                        : "max-w-[50%] shrink-0 truncate font-medium text-[var(--color-ink)]"
                                                }
                                            >
                                                {transaction.payee?.trim() ||
                                                    "No payee"}
                                            </span>
                                            {transaction.memo?.trim() ||
                                            hasTransactionManagedMetadata(
                                                transaction,
                                            ) ? (
                                                <span
                                                    className={`min-w-0 flex-1 text-xs ${typographyClassNames.mutedBody}`}
                                                >
                                                    <TransactionMemoDisplay
                                                        managedMetadata={transaction}
                                                        memo={transaction.memo}
                                                        showFullMemo={isExpanded}
                                                    />
                                                </span>
                                            ) : null}
                                        </div>
                                    </div>
                                    <div
                                        className={`${
                                            suggestedCategoryLabel &&
                                            pendingCategoryClassification
                                                ? "flex"
                                                : "hidden sm:flex"
                                        } min-w-0 flex-col text-xs`}
                                    >
                                        {suggestedCategoryLabel &&
                                        pendingCategoryClassification ? (
                                            <div className="min-w-0">
                                                <div
                                                    className={`flex min-w-0 gap-2 ${
                                                        isExpanded
                                                            ? "items-start"
                                                            : "items-center"
                                                    }`}
                                                >
                                                    <span
                                                        className={`inline-flex min-w-0 gap-1 text-[var(--color-accent-contrast)] ${
                                                            isExpanded
                                                                ? "items-start"
                                                                : "items-center truncate"
                                                        }`}
                                                    >
                                                        <FontAwesomeIcon
                                                            aria-hidden="true"
                                                            icon={faRobot}
                                                        />
                                                        <span
                                                            className={
                                                                isExpanded
                                                                    ? "min-w-0 break-words"
                                                                    : "truncate"
                                                            }
                                                        >
                                                            Suggested: {suggestedCategoryLabel}
                                                        </span>
                                                    </span>
                                                    {showClassificationConfidence ? (
                                                        <span className="shrink-0 text-[var(--color-muted)]">
                                                            {Math.round(
                                                                pendingCategoryClassification
                                                                    .suggestion
                                                                    .confidence *
                                                                    100,
                                                            )}
                                                            % confidence
                                                        </span>
                                                    ) : null}
                                                </div>
                                                <p
                                                    className={`mt-1 text-xs leading-tight text-[var(--color-muted)] ${
                                                        isExpanded
                                                            ? "whitespace-pre-wrap break-words"
                                                            : "truncate"
                                                    }`}
                                                    title={
                                                        pendingCategoryClassification
                                                            .suggestion
                                                            .reason ||
                                                        "No reason was provided."
                                                    }
                                                >
                                                    {pendingCategoryClassification
                                                        .suggestion.reason ||
                                                        "No reason was provided."}
                                                </p>
                                            </div>
                                        ) : null}
                                    </div>
                                    <div className="flex flex-wrap items-center justify-end gap-2 sm:ml-2 sm:flex-nowrap">
                                        <span
                                            className={`mr-1 flex h-8 items-center whitespace-nowrap font-semibold ${getMoneyToneClassName(transaction.displayAmountCents)}`}
                                        >
                                            <MoneyAmount
                                                cents={
                                                    transaction.displayAmountCents
                                                }
                                            />
                                        </span>
                                        <PaneListActionMenu
                                            ariaLabel="Transaction actions"
                                            actions={[
                                                ...(pendingCategoryClassification
                                                    ? [
                                                          {
                                                              disabled:
                                                                  isClassificationBusy,
                                                              key: "a",
                                                              label: applyingClassificationTransactionIds.has(
                                                                  transaction.transactionId,
                                                              )
                                                                  ? "Applying Suggestion..."
                                                                  : "Apply Suggestion",
                                                              onAction: () => {
                                                                  void applyPendingClassification(
                                                                      pendingCategoryClassification,
                                                                  );
                                                              },
                                                          },
                                                          {
                                                              disabled:
                                                                  isClassificationBusy,
                                                              key: "i",
                                                              label: "Ignore Suggestion",
                                                              onAction: () => {
                                                                  void rejectPendingClassification(
                                                                      pendingCategoryClassification,
                                                                  );
                                                              },
                                                          },
                                                      ]
                                                    : []),
                                                {
                                                    key: "e",
                                                    label: "Edit",
                                                    onAction: () => {
                                                        setEditingUncategorizedTransactionId(
                                                            transaction.transactionId,
                                                        );
                                                    },
                                                },
                                                {
                                                    key: "v",
                                                    label: "View",
                                                    onAction: () => {
                                                        void navigateToTransaction({
                                                            loadTransactionReference,
                                                            router,
                                                            snapshot,
                                                            transactionId:
                                                                transaction.transactionId,
                                                        });
                                                    },
                                                },
                                            ]}
                                        />
                                    </div>
                                </PaneList.Item>
                            );
                        })}
                    </PaneList>
                ) : (
                    <div className="flex items-center gap-2 text-sm text-[var(--color-ink)]">
                        <FontAwesomeIcon
                            aria-hidden="true"
                            icon={faClipboardCheck}
                            className="text-3xl"
                        />
                        <p>All transactions are categorized.</p>
                    </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                        {allUncategorizedTransactions.length >
                        uncategorizedTransactions.length ? (
                            <button
                                type="button"
                                onClick={() => {
                                    setUncategorizedTransactionVisibleCount(
                                        (current) =>
                                            current +
                                            uncategorizedTransactionPageSize,
                                    );
                                }}
                                className="text-sm font-medium transition hover:underline"
                                style={{ color: "#5d78d4" }}
                            >
                                [+] Show more
                            </button>
                        ) : null}
                    </div>
                    <DashboardSectionLink href="/transactions">
                        View all transactions
                    </DashboardSectionLink>
                </div>
                        </div>
                    ) : (
                        <dl className="grid border-y border-[var(--color-border)]">
                    <div className="grid grid-cols-[1fr_auto] gap-4 border-b border-[var(--color-border)] px-3 py-2.5">
                        <dt className="text-sm text-[var(--color-muted)]">
                            Spending categories
                        </dt>
                        <dd
                            className={`text-right text-sm font-semibold ${getMoneyToneClassName(totals.spendingCents)}`}
                        >
                            <MoneyAmount cents={totals.spendingCents} />
                        </dd>
                    </div>
                    {categoryTotalsByGroup.spending.map((group) => (
                        <div
                            key={`spending:${group.groupId}`}
                            className="grid grid-cols-[1fr_auto] gap-4 border-b border-[var(--color-border)] px-3 py-2 pl-7"
                        >
                            <dt className="text-sm text-[var(--color-muted)]">
                                {group.name}
                            </dt>
                            <dd
                                className={`text-right text-sm font-medium ${getMoneyToneClassName(group.availableCents)}`}
                            >
                                <MoneyAmount cents={group.availableCents} />
                            </dd>
                        </div>
                    ))}
                    <div className="grid grid-cols-[1fr_auto] gap-4 border-b border-[var(--color-border)] px-3 py-2.5">
                        <dt className="text-sm text-[var(--color-muted)]">
                            Savings categories
                        </dt>
                        <dd
                            className={`text-right text-sm font-semibold ${getMoneyToneClassName(totals.savingsCents)}`}
                        >
                            <MoneyAmount cents={totals.savingsCents} />
                        </dd>
                    </div>
                    {categoryTotalsByGroup.savings.map((group) => (
                        <div
                            key={`savings:${group.groupId}`}
                            className="grid grid-cols-[1fr_auto] gap-4 border-b border-[var(--color-border)] px-3 py-2 pl-7"
                        >
                            <dt className="text-sm text-[var(--color-muted)]">
                                {group.name}
                            </dt>
                            <dd
                                className={`text-right text-sm font-medium ${getMoneyToneClassName(group.availableCents)}`}
                            >
                                <MoneyAmount cents={group.availableCents} />
                            </dd>
                        </div>
                    ))}
                    <div className="grid grid-cols-[1fr_auto] gap-4 px-3 py-2.5">
                        <dt className="text-sm font-semibold text-[var(--color-ink)]">
                            All categories
                        </dt>
                        <dd
                            className={`text-right text-base font-semibold ${getMoneyToneClassName(totals.allCategoriesCents)}`}
                        >
                            <MoneyAmount cents={totals.allCategoriesCents} />
                        </dd>
                    </div>
                        </dl>
                    )}
                </div>
            </section>
        </div>
    );
}

function transactionHasUncategorizedActivity(transaction: {
    kind: "adjustment" | "standard";
    lines: Array<{
        categoryId?: string | null;
        fromAccountId?: string | null;
        toAccountId?: string | null;
    }>;
}) {
    return (
        transaction.kind === "standard" &&
        transaction.lines.some(isUncategorizedAccountMovementLine)
    );
}

function summarizeTransactionActivity(
    transactions: Array<{
        kind: "adjustment" | "standard";
        lines: Array<{
            categoryId?: string | null;
            fromAccountId?: string | null;
            toAccountId?: string | null;
        }>;
        occurredAt: string;
    }>,
) {
    const latestTransactionDate = transactions.reduce<string | undefined>(
        (latestDate, transaction) =>
            !latestDate || transaction.occurredAt > latestDate
                ? transaction.occurredAt
                : latestDate,
        undefined,
    );

    return {
        latestTransactionDate,
        transactionCount: transactions.length,
        uncategorizedCount: transactions.filter(
            transactionHasUncategorizedActivity,
        ).length,
    };
}

function buildTransactionAccountSelectorSummaries(
    accounts: Array<{
        accountId: string;
        accountType: string;
        ledgerAccountId: string;
    }>,
    transactions: Array<{
        kind: "adjustment" | "standard";
        lines: Array<{
            categoryId?: string | null;
            fromAccountId?: string | null;
            toAccountId?: string | null;
        }>;
        occurredAt: string;
        status: "cleared" | "entered" | "reconciled" | "voided";
        postings: Array<{
            ledgerAccountKind: "category" | "equity" | "financial";
            ledgerAccountId: string;
        }>;
        referenceAccountId: string;
    }>,
) {
    const accountById = new Map(
        accounts.map((account) => [account.accountId, account]),
    );
    const allAccountsTransactions = transactions.filter(
        (transaction) =>
            accountById.get(transaction.referenceAccountId)?.accountType !==
            "tracking",
    );
    const countUnlockedTransactions = (
        accountTransactions: typeof transactions,
    ) =>
        accountTransactions.filter(
            (transaction) =>
                transaction.status !== "reconciled" &&
                transaction.status !== "voided",
        ).length;

    return {
        allAccounts: {
            ...summarizeTransactionActivity(allAccountsTransactions),
            unlockedTransactionCount: countUnlockedTransactions(
                allAccountsTransactions,
            ),
        },
        byAccountId: Object.fromEntries(
            accounts.map((account) => {
                const accountTransactions = transactions.filter((transaction) =>
                    transactionHasAccountActivity(transaction, account),
                );

                return [
                    account.accountId,
                    {
                        ...summarizeTransactionActivity(accountTransactions),
                        unlockedTransactionCount: countUnlockedTransactions(
                            accountTransactions,
                        ),
                    },
                ];
            }),
        ),
    };
}

export function AccountsWorkspace() {
    const { snapshot } = useWorkspaceStore();
    const readiness = resolveWorkspaceReadiness({
        accountCount: snapshot.accounts.length,
        categoryCount: 0,
        hasReportableActivity: false,
        sectionId: "accounts",
        transactionCount: 0,
    });

    return (
        <div className="grid gap-6">
            <PageHeader
                breadcrumbs={[
                    { href: "/dashboard", label: "Home" },
                    { label: "Accounts" },
                ]}
            />

            {readiness.status !== "ready" ? (
                <EmptyStatePanel
                    readiness={readiness}
                    title="Add some accounts"
                />
            ) : null}

            <AccountsTable accounts={snapshot.accounts} />
        </div>
    );
}

export function TransactionsWorkspace({
    accountSlug,
}: {
    accountSlug?: string;
}) {
    const { snapshot } = useWorkspaceStore();
    const searchParams = useSearchParams();
    const visibleCategories = snapshot.budgetCategories.filter(
        isUserVisibleBudgetCategory,
    );
    const savedAccountCount = snapshot.accounts.length;
    const selectedAccount =
        accountSlug && accountSlug !== ALL_TRANSACTION_ACCOUNTS_SLUG
            ? findAccountByTransactionSlug(snapshot.accounts, accountSlug)
            : null;
    const isAllAccountsView = accountSlug === ALL_TRANSACTION_ACCOUNTS_SLUG;
    const isAccountTransactionView = Boolean(accountSlug);
    const selectedTransactionId = isAccountTransactionView
        ? (searchParams.get("selected") ?? undefined)
        : undefined;
    const transactionQueryAccountIds = useMemo(() => {
        if (!selectedAccount || !isAccountTransactionView) {
            return undefined;
        }

        const counterpartTypes =
            selectedAccount.accountType === "creditCard"
                ? new Set(["checking", "savings"])
                : selectedAccount.accountType === "checking" ||
                    selectedAccount.accountType === "savings"
                  ? new Set(["checking", "savings", "creditCard"])
                  : new Set<string>();

        return [
            selectedAccount.accountId,
            ...snapshot.accounts
                .filter((account) => counterpartTypes.has(account.accountType))
                .filter((account) => account.accountId !== selectedAccount.accountId)
                .map((account) => account.accountId),
        ];
    }, [isAccountTransactionView, selectedAccount, snapshot.accounts]);
    const {
        isLoading: isLoadingTransactions,
        plaidTransactionSyncs: scopedPlaidTransactionSyncs,
        transactions: scopedTransactions,
    } = useWorkspaceTransactions(
        transactionQueryAccountIds
            ? { accountIds: transactionQueryAccountIds }
            : {},
    );
    const currentPeriodId = getMonthlyPeriodId(new Date());
    const categoryBalanceTransactionQuery = useMemo(
        () => createBudgetContinuityTransactionQuery(currentPeriodId),
        [currentPeriodId],
    );
    const {
        isLoading: isLoadingCategoryBalanceTransactions,
        transactions: categoryBalanceTransactions,
    } = useWorkspaceTransactions(categoryBalanceTransactionQuery);
    const categoryBalanceSnapshot = useMemo(
        () => ({
            ...snapshot,
            ledgerPostings: categoryBalanceTransactions.flatMap(
                (transaction) => transaction.postings,
            ),
            transactionLines: categoryBalanceTransactions.flatMap(
                (transaction) => transaction.lines,
            ),
            transactions: categoryBalanceTransactions,
        }),
        [categoryBalanceTransactions, snapshot],
    );
    const categoryBalanceById = useMemo(() => {
        if (isLoadingCategoryBalanceTransactions) {
            return new Map<string, number>();
        }

        const summary = buildBudgetPeriodSummaryFromSnapshot(
            categoryBalanceSnapshot,
            currentPeriodId,
        );

        return new Map(
            summary.categories.map((category) => [
                category.categoryId,
                category.availableCents,
            ]),
        );
    }, [
        categoryBalanceSnapshot,
        currentPeriodId,
        isLoadingCategoryBalanceTransactions,
    ]);
    const readiness = resolveWorkspaceReadiness({
        accountCount: savedAccountCount,
        categoryCount: visibleCategories.length,
        hasReportableActivity: scopedTransactions.length > 0,
        sectionId: "transactions",
        transactionCount: scopedTransactions.length,
    });
    const visibleTransactions = selectedAccount && isAccountTransactionView
        ? scopedTransactions.filter((transaction) =>
              transactionHasAccountActivity(transaction, selectedAccount),
          )
        : scopedTransactions;
    const accountSelectorSummaries = useMemo(
        () =>
            buildTransactionAccountSelectorSummaries(
                snapshot.accounts,
                scopedTransactions,
            ),
        [snapshot.accounts, scopedTransactions],
    );
    const transactionBreadcrumbs: BreadcrumbItem[] = [
        { href: "/dashboard", label: "Home" },
        ...(isAccountTransactionView
            ? [{ href: "/transactions", label: "Transactions" }]
            : [{ label: "Transactions" }]),
    ];

    if (isAccountTransactionView) {
        transactionBreadcrumbs.push({
            label: selectedAccount
                ? selectedAccount.name
                : isAllAccountsView
                  ? "All accounts"
                  : "Unknown account",
        });
    }

    return (
        <div className="grid gap-6">
            <PageHeader
                actions={
                    selectedAccount ? (
                        <AccountTransactionStatusBar
                            account={selectedAccount}
                        />
                    ) : undefined
                }
                breadcrumbs={transactionBreadcrumbs}
            />

            {readiness.status !== "ready" ? (
                <EmptyStatePanel
                    readiness={readiness}
                    title="Transactions need an account first."
                />
            ) : null}

            {savedAccountCount > 0 && !isAccountTransactionView ? (
                <div className="grid gap-4">
                    <h1 className="text-3xl font-semibold tracking-tight">
                        Choose an account
                    </h1>
                    <TransactionAccountSelector
                        accounts={snapshot.accounts}
                        ledgerId={snapshot.activeLedgerId}
                        summaries={accountSelectorSummaries}
                    />
                </div>
            ) : null}

            {isLoadingTransactions ? (
                <p className="text-sm text-[var(--color-muted)]" role="status">
                    Loading transactions...
                </p>
            ) : null}

            {savedAccountCount > 0 &&
            isAccountTransactionView &&
            !isLoadingTransactions &&
            (selectedAccount || isAllAccountsView) ? (
                <TransactionsTable
                    key={`${
                        selectedAccount?.accountId ??
                        ALL_TRANSACTION_ACCOUNTS_SLUG
                    }:${selectedTransactionId ?? ""}`}
                    accountContextId={selectedAccount?.accountId}
                    accounts={snapshot.accounts}
                    categories={visibleCategories}
                    categoryBalanceById={categoryBalanceById}
                    initialSelectedTransactionId={selectedTransactionId}
                    autoMatchPlaidTransactionSyncRecords={
                        scopedPlaidTransactionSyncs
                    }
                    autoMatchTransactions={scopedTransactions}
                    transactions={visibleTransactions}
                />
            ) : null}

            {savedAccountCount > 0 &&
            isAccountTransactionView &&
            !selectedAccount &&
            !isAllAccountsView ? (
                <EmptyStatePanel
                    readiness={{
                        message:
                            "Choose an account from the transactions account list.",
                        primaryActionHref: "/transactions",
                        primaryActionLabel: "Choose account",
                        sectionId: "transactions",
                        status: "empty",
                    }}
                    title="Transaction account not found."
                />
            ) : null}
        </div>
    );
}

export function GlobalBudgetWorkspace() {
    const { snapshot } = useWorkspaceStore();
    const groups = snapshot.budgetGroups
        .filter((group) => group.status === "active")
        .map((group) => ({
            groupId: group.groupId,
            name: group.name,
            sortOrder: group.sortOrder,
            status: group.status,
        }));
    const categories = snapshot.budgetCategories
        .filter(
            (category) =>
                category.status === "active" &&
                isUserVisibleBudgetCategory(category),
        )
        .map((category) => ({
            allocationCadence: category.allocationCadence,
            allocationStartMonth: category.allocationStartMonth,
            categoryId: category.categoryId,
            categoryType: category.categoryType,
            defaultAssignedCents: category.defaultAssignedCents,
            groupId: category.groupId,
            isIncomeCategory: category.isIncomeCategory,
            name: category.name,
            sortOrder: category.sortOrder,
            status: category.status,
            systemCategoryKey: category.systemCategoryKey,
        }));
    const readiness = resolveWorkspaceReadiness({
        accountCount: 0,
        categoryCount: categories.length,
        hasReportableActivity: false,
        sectionId: "globalBudget",
        transactionCount: 0,
    });

    return (
        <div className="grid gap-6">
            <PageHeader
                breadcrumbs={[
                    { href: "/dashboard", label: "Home" },
                    { label: "Budget Plan" },
                ]}
            />

            {readiness.status !== "ready" ? (
                <EmptyStatePanel
                    readiness={readiness}
                    title={
                        readiness.status === "empty"
                            ? "Budget Plan needs setup."
                            : "Budget Plan needs at least one category."
                    }
                />
            ) : null}

            <p className={typographyClassNames.mutedBody}>Set the amounts you normally want to budget.</p>
            <GlobalPlanEditor categories={categories} groups={groups} />
        </div>
    );
}

export function LedgersWorkspace({ ledgers }: { ledgers: LedgerRecord[] }) {
    const { snapshot } = useWorkspaceStore();

    return (
        <div className="grid gap-6">
            <PageHeader
                breadcrumbs={[
                    { href: "/dashboard", label: "Home" },
                    { label: "Ledgers" },
                ]}
            />

            <LedgerManager
                activeLedgerId={snapshot.activeLedgerId}
                ledgers={ledgers}
            />
        </div>
    );
}

export function UtilitiesWorkspace({
    canManageUsers = false,
}: {
    canManageUsers?: boolean;
}) {
    const utilities = [
        {
            description:
                "View release and build details, and visit the Budgeted project.",
            href: "/utilities/about",
            icon: faCircleInfo,
            title: "About",
        },
        {
            description:
                "Choose the AI model, set system prompt rules, and run classification.",
            href: "/utilities/transaction-classification-settings",
            icon: faRobot,
            title: "AI Classification",
        },
        {
            description: "Browse services that import transaction activity into the workspace.",
            href: "/utilities/transaction-importers",
            icon: faFolderOpen,
            title: "Transaction Importers",
        },
        {
            description: "Choose the category pools used to fund monthly budgets.",
            href: "/utilities/auto-assign",
            icon: faListCheck,
            title: "Monthly budget funding sources",
        },
        {
            description:
                "Schedule Plaid, Amazon, and AI classification tasks and review recent runs.",
            href: "/utilities/automation",
            icon: faClock,
            title: "Automation",
        },
        {
            description:
                "Inspect diagnostic tools for classification and ledger consistency.",
            href: "/utilities/debug",
            icon: faMagnifyingGlassChart,
            title: "Debug",
        },
        {
            description:
                "Import or export an entire ledger or its reusable budget plan.",
            href: "/utilities/import-export-ledger",
            icon: faFileImport,
            title: "Import and Export",
        },
        ...(canManageUsers
            ? [
                  {
                      description:
                          "Add users, update access, reset passwords, or remove accounts.",
                      href: "/utilities/users",
                      icon: faUsers,
                      title: "Manage users",
                  },
              ]
            : []),
        {
            description:
                "Create reusable split formulas for repeated transaction entry.",
            href: "/utilities/transaction-templates",
            icon: faReceipt,
            title: "Transaction templates",
        },
    ].sort((left, right) => left.title.localeCompare(right.title));

    return (
        <div className="grid gap-6">
            <PageHeader
                breadcrumbs={[
                    { href: "/dashboard", label: "Home" },
                    { label: "Utilities" },
                ]}
            />

            <PaneList aria-label="Utilities" size="large">
                {utilities.map((utility) => (
                    <LargeNavigationPane key={utility.href} {...utility} />
                ))}
            </PaneList>
        </div>
    );
}

const aboutLinks = [
    {
        href: "https://github.com/budgetedhq/budgeted",
        icon: faGithub,
        title: "GitHub repository",
    },
    {
        href: "https://github.com/budgetedhq/budgeted/releases",
        icon: faTag,
        title: "Releases",
    },
] as const;

export function AboutWorkspace() {
    return (
        <div className="grid gap-6">
            <PageHeader
                breadcrumbs={[
                    { href: "/dashboard", label: "Home" },
                    { href: "/utilities", label: "Utilities" },
                    { label: "About" },
                ]}
            />

            <section className={`grid gap-5 p-5 ${surfaceClassNames.panelStrong}`}>
                <div>
                    <p className={typographyClassNames.eyebrow}>About</p>
                    <h1 className="mt-2 text-2xl font-semibold">Budgeted</h1>
                </div>

                <dl className="grid gap-4">
                    <div className="grid gap-1">
                        <dt className={typographyClassNames.eyebrow}>Release</dt>
                        <dd className="font-[family:var(--font-mono)] text-sm font-medium">
                            {APPLICATION_VERSION.releaseTag}
                        </dd>
                    </div>
                    <div className="grid gap-1">
                        <dt className={typographyClassNames.eyebrow}>Build</dt>
                        <dd className="font-[family:var(--font-mono)] text-sm font-medium">
                            <time
                                dateTime={APPLICATION_VERSION.buildTimestamp}
                                suppressHydrationWarning
                            >
                                {formatApplicationVersionForDisplay(
                                    APPLICATION_VERSION.buildTimestamp,
                                )}
                            </time>
                        </dd>
                    </div>
                </dl>
            </section>

            <section className={`grid gap-4 p-5 ${surfaceClassNames.panel}`}>
                <h2 className="text-lg font-semibold">Budgeted Links</h2>

                <ul className="grid gap-3">
                    {aboutLinks.map((link) => (
                        <li key={link.href}>
                            <a
                                className="inline-flex items-center gap-2 font-medium text-[var(--color-accent-contrast)] transition hover:text-[var(--color-ink)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-ring)]"
                                href={link.href}
                                rel="noreferrer noopener"
                                target="_blank"
                            >
                                <FontAwesomeIcon
                                    aria-hidden="true"
                                    className="size-4"
                                    icon={link.icon}
                                />
                                {link.title}
                            </a>
                        </li>
                    ))}
                </ul>
            </section>
        </div>
    );
}

export function UtilitiesDebugWorkspace() {
    const utilities = [
        {
            description:
                "Inspect transaction embeddings, matching context, and classifier prompts.",
            href: "/utilities/debug/transaction-classification",
            icon: faMagnifyingGlassChart,
            title: "AI classification debug",
        },
        {
            description: "View recent AI classifier requests and responses.",
            href: "/utilities/debug/logs",
            icon: faRobot,
            title: "Logs",
        },
        {
            description:
                "Check ledger accounting records and budget allocation consistency.",
            href: "/utilities/debug/ledger-integrity",
            icon: faClipboardCheck,
            title: "Ledger integrity",
        },
    ];

    return (
        <div className="grid gap-6">
            <PageHeader
                breadcrumbs={[
                    { href: "/dashboard", label: "Home" },
                    { href: "/utilities", label: "Utilities" },
                    { label: "Debug" },
                ]}
            />

            <PaneList aria-label="Debug utilities" size="large">
                {utilities.map((utility) => (
                    <LargeNavigationPane key={utility.href} {...utility} />
                ))}
            </PaneList>
        </div>
    );
}

export function TransactionImportersWorkspace() {
    const utilities = [
        {
            description:
                "Sync Amazon orders, match charges, and attach managed order details to transactions.",
            href: "/utilities/transaction-importers/amazon-orders",
            icon: faBoxOpen,
            title: "Amazon orders",
        },
        {
            description:
                "Receive Venmo email activity, map funding accounts, and match Plaid duplicates.",
            href: "/utilities/transaction-importers/venmo",
            icon: faV,
            title: "Venmo",
        },
    ];

    return (
        <div className="grid gap-6">
            <PageHeader
                breadcrumbs={[
                    { href: "/dashboard", label: "Home" },
                    { href: "/utilities", label: "Utilities" },
                    { label: "Transaction Importers" },
                ]}
            />

            <PaneList aria-label="Transaction importers" size="large">
                {utilities.map((utility) => (
                    <LargeNavigationPane key={utility.href} {...utility} />
                ))}
            </PaneList>
        </div>
    );
}

export function AmazonOrdersWorkspace() {
    return (
        <div className="grid gap-6">
            <PageHeader
                breadcrumbs={[
                    { href: "/dashboard", label: "Home" },
                    { href: "/utilities", label: "Utilities" },
                    {
                        href: "/utilities/transaction-importers",
                        label: "Transaction Importers",
                    },
                    { label: "Amazon orders" },
                ]}
            />

            <AmazonOrdersPanel />
        </div>
    );
}

export function VenmoWorkspace() {
    return (
        <div className="grid gap-6">
            <PageHeader
                breadcrumbs={[
                    { href: "/dashboard", label: "Home" },
                    { href: "/utilities", label: "Utilities" },
                    {
                        href: "/utilities/transaction-importers",
                        label: "Transaction Importers",
                    },
                    { label: "Venmo" },
                ]}
            />
            <VenmoPanel />
        </div>
    );
}

function LargeNavigationPane({
    description,
    href,
    icon,
    title,
}: {
    description: string;
    href: string;
    icon: IconDefinition;
    title: string;
}) {
    return (
        <PaneList.Item
            aria-label={title}
            href={href}
            itemId={href}
            className="text-[var(--color-ink)] sm:grid-cols-[auto_1fr] sm:items-center"
        >
            <FontAwesomeIcon
                aria-hidden="true"
                icon={icon}
                className="text-3xl text-[var(--color-accent-contrast)]"
            />
            <span className="grid gap-1">
                <span className="text-base font-semibold text-[var(--color-ink)]">
                    {title}
                </span>
                <span className={`text-sm ${typographyClassNames.mutedBody}`}>
                    {description}
                </span>
            </span>
        </PaneList.Item>
    );
}

export function LedgerTransferWorkspace() {
    return (
        <div className="grid gap-6">
            <PageHeader
                breadcrumbs={[
                    { href: "/dashboard", label: "Home" },
                    { href: "/utilities", label: "Utilities" },
                    { label: "Import and Export" },
                ]}
            />

            <LedgerTransferPanel />
        </div>
    );
}

export function TransactionClassificationSettingsWorkspace() {
    return (
        <div className="grid gap-6">
            <PageHeader
                breadcrumbs={[
                    { href: "/dashboard", label: "Home" },
                    { href: "/utilities", label: "Utilities" },
                    { label: "AI Classification" },
                ]}
            />

            <TransactionClassificationSettingsPanel />
        </div>
    );
}

export function AutomationWorkspace() {
    return (
        <div className="grid gap-6">
            <PageHeader
                breadcrumbs={[
                    { href: "/dashboard", label: "Home" },
                    { href: "/utilities", label: "Utilities" },
                    { label: "Automation" },
                ]}
            />

            <AutomationPanel />
        </div>
    );
}

export function TransactionClassificationDebugWorkspace() {
    return (
        <div className="grid gap-6">
            <PageHeader
                breadcrumbs={[
                    { href: "/dashboard", label: "Home" },
                    { href: "/utilities", label: "Utilities" },
                    { href: "/utilities/debug", label: "Debug" },
                    { label: "AI classification debug" },
                ]}
            />

            <TransactionClassificationDebugPanel />
        </div>
    );
}

export function TransactionClassificationLogsWorkspace() {
    return (
        <div className="grid gap-6">
            <PageHeader
                breadcrumbs={[
                    { href: "/dashboard", label: "Home" },
                    { href: "/utilities", label: "Utilities" },
                    { href: "/utilities/debug", label: "Debug" },
                    { label: "Logs" },
                ]}
            />

            <TransactionClassificationLogsPanel />
        </div>
    );
}

export function AutoAssignSourcesWorkspace() {
    return (
        <div className="grid gap-6">
            <PageHeader
                breadcrumbs={[
                    { href: "/dashboard", label: "Home" },
                    { href: "/utilities", label: "Utilities" },
                    { label: "Monthly budget funding sources" },
                ]}
            />

            <AutoAssignSourcesPanel />
        </div>
    );
}

export function TransactionTemplatesWorkspace() {
    return (
        <div className="grid gap-6">
            <PageHeader
                breadcrumbs={[
                    { href: "/dashboard", label: "Home" },
                    { href: "/utilities", label: "Utilities" },
                    { label: "Transaction templates" },
                ]}
            />

            <TransactionTemplatesPanel />
        </div>
    );
}

export function LedgerIntegrityWorkspace() {
    return (
        <div className="grid gap-6">
            <PageHeader
                breadcrumbs={[
                    { href: "/dashboard", label: "Home" },
                    { href: "/utilities", label: "Utilities" },
                    { href: "/utilities/debug", label: "Debug" },
                    { label: "Ledger integrity" },
                ]}
            />

            <LedgerIntegrityPanel />
        </div>
    );
}

export function UtilityUsersWorkspace({
    canManageUsers = false,
}: {
    canManageUsers?: boolean;
}) {
    return (
        <div className="grid gap-6">
            <PageHeader
                breadcrumbs={[
                    { href: "/dashboard", label: "Home" },
                    { href: "/utilities", label: "Utilities" },
                    { label: "Manage users" },
                ]}
            />

            <UserManagementPanel canManageUsers={canManageUsers} />
        </div>
    );
}

export function BudgetWorkspace({
    initialPeriodId,
}: {
    initialPeriodId: string;
}) {
    const { snapshot } = useWorkspaceStore();
    const searchParams = useSearchParams();
    const monthParam = searchParams.get("month");
    const queryPeriodId =
        monthParam && isMonthlyPeriodId(monthParam) ? monthParam : undefined;
    const periodId =
        queryPeriodId ??
        getRememberedActiveBudgetPeriod(snapshot.activeLedgerId) ??
        initialPeriodId;
    const budgetTransactionQuery = useMemo(
        () => createBudgetContinuityTransactionQuery(periodId),
        [periodId],
    );
    const {
        isLoading: isLoadingBudgetTransactions,
        transactions: budgetTransactions,
    } = useWorkspaceTransactions(budgetTransactionQuery);
    const [lastLoadedBudgetActivity, setLastLoadedBudgetActivity] = useState<{
        ledgerId: string;
        periodId: string;
        transactions: typeof budgetTransactions;
    } | null>(null);

    useEffect(() => {
        if (isLoadingBudgetTransactions) {
            return;
        }

        const nextBudgetActivity = {
            ledgerId: snapshot.activeLedgerId,
            periodId,
            transactions: budgetTransactions,
        };
        const timeoutId = window.setTimeout(() => {
            setLastLoadedBudgetActivity((current) =>
                current?.ledgerId === nextBudgetActivity.ledgerId &&
                current.periodId === nextBudgetActivity.periodId &&
                current.transactions === nextBudgetActivity.transactions
                    ? current
                    : nextBudgetActivity,
            );
        }, 0);

        return () => window.clearTimeout(timeoutId);
    }, [budgetTransactions, isLoadingBudgetTransactions, periodId, snapshot.activeLedgerId]);

    const isRetainingBudgetActivity = Boolean(
        isLoadingBudgetTransactions &&
            lastLoadedBudgetActivity?.ledgerId === snapshot.activeLedgerId,
    );
    const displayedBudgetActivity = isRetainingBudgetActivity
        ? lastLoadedBudgetActivity!
        : {
              ledgerId: snapshot.activeLedgerId,
              periodId,
              transactions: budgetTransactions,
          };
    const budgetSnapshot = useMemo(
        () => ({
            ...snapshot,
            ledgerPostings: displayedBudgetActivity.transactions.flatMap(
                (transaction) => transaction.postings,
            ),
            transactionLines: displayedBudgetActivity.transactions.flatMap(
                (transaction) => transaction.lines,
            ),
            transactions: displayedBudgetActivity.transactions,
        }),
        [displayedBudgetActivity.transactions, snapshot],
    );

    const summary = useMemo(
        () =>
            buildBudgetPeriodSummaryFromSnapshot(
                budgetSnapshot,
                displayedBudgetActivity.periodId,
            ),
        [budgetSnapshot, displayedBudgetActivity.periodId],
    );

    useEffect(() => {
        rememberActiveBudgetPeriod(snapshot.activeLedgerId, periodId);
    }, [periodId, snapshot.activeLedgerId]);

    const assignableCategoryCount = summary.categories.length;
    const readiness = resolveWorkspaceReadiness({
        accountCount: summary.activeAccountCount ?? 0,
        categoryCount: assignableCategoryCount,
        hasReportableActivity: false,
        sectionId: "budget",
        transactionCount: 0,
    });

    return (
        <div className="grid gap-6">
            <PageHeader
                breadcrumbs={[
                    { href: "/dashboard", label: "Home" },
                    { label: "Monthly Budget" },
                ]}
            />

            <p className={typographyClassNames.mutedBody}>Assign money to categories for this month.</p>

            {readiness.status !== "ready" ? (
                <EmptyStatePanel
                    readiness={readiness}
                    title={
                        readiness.status === "empty"
                            ? "Budget needs setup."
                            : "Budget needs at least one category."
                    }
                />
            ) : null}

            {isLoadingBudgetTransactions && !isRetainingBudgetActivity ? (
                <p className={`text-sm ${typographyClassNames.mutedBody}`} role="status">
                    Loading budget activity...
                </p>
            ) : summary.categories.length > 0 ? (
                <BudgetTable
                    renderHeader={(allocationStatus) => (
                        <PeriodSelector
                            actions={
                                isRetainingBudgetActivity
                                    ? undefined
                                    : allocationStatus
                            }
                            periodId={periodId}
                            onPeriodChange={(nextPeriodId) =>
                                rememberActiveBudgetPeriod(
                                    snapshot.activeLedgerId,
                                    nextPeriodId,
                                )
                            }
                        />
                    )}
                    isTransitioning={isRetainingBudgetActivity}
                    summary={summary}
                />
            ) : (
                <PeriodSelector
                    periodId={periodId}
                    onPeriodChange={(nextPeriodId) =>
                        rememberActiveBudgetPeriod(
                            snapshot.activeLedgerId,
                            nextPeriodId,
                        )
                    }
                />
            )}
        </div>
    );
}

export function ReportingWorkspace() {
    const reports = [
        {
            description:
                "Track one category's available amount across a year as allocations and transactions change it.",
            href: "/reporting/category-tracking",
            icon: faChartLine,
            title: "Category tracking",
        },
        {
            description:
                "Review allocations, transactions, and the running balance for one category or Unassigned.",
            href: "/reporting/category-detail",
            icon: faChartLine,
            title: "Category detail",
        },
    ];

    return (
        <div className="grid gap-6">
            <PageHeader
                breadcrumbs={[
                    { href: "/dashboard", label: "Home" },
                    { label: "Reporting" },
                ]}
            />

            <PaneList aria-label="Reports" size="large">
                {reports.map((report) => (
                    <LargeNavigationPane key={report.href} {...report} />
                ))}
            </PaneList>
        </div>
    );
}

export function CategoryDetailReportWorkspace() {
    const { snapshot } = useWorkspaceStore();
    const { isLoading, transactions } = useWorkspaceTransactions();
    const reportSnapshot = useMemo(
        () => ({
            ...snapshot,
            ledgerPostings: transactions.flatMap((transaction) => transaction.postings),
            transactionLines: transactions.flatMap((transaction) => transaction.lines),
            transactions,
        }),
        [snapshot, transactions],
    );

    return (
        <div className="grid gap-6">
            <PageHeader
                breadcrumbs={[
                    { href: "/dashboard", label: "Home" },
                    { href: "/reporting", label: "Reporting" },
                    { label: "Category detail" },
                ]}
            />

            {isLoading ? (
                <p className={`text-sm ${typographyClassNames.mutedBody}`} role="status">
                    Loading report activity...
                </p>
            ) : (
                <CategoryDetailReport snapshot={reportSnapshot} />
            )}
        </div>
    );
}

export function CategoryTrackingReportWorkspace() {
    const { snapshot } = useWorkspaceStore();
    const { isLoading, transactions } = useWorkspaceTransactions();
    const reportSnapshot = useMemo(
        () => ({
            ...snapshot,
            ledgerPostings: transactions.flatMap(
                (transaction) => transaction.postings,
            ),
            transactionLines: transactions.flatMap(
                (transaction) => transaction.lines,
            ),
            transactions,
        }),
        [snapshot, transactions],
    );

    return (
        <div className="grid gap-6">
            <PageHeader
                breadcrumbs={[
                    { href: "/dashboard", label: "Home" },
                    { href: "/reporting", label: "Reporting" },
                    { label: "Category tracking" },
                ]}
            />

            {isLoading ? (
                <p
                    className={`text-sm ${typographyClassNames.mutedBody}`}
                    role="status"
                >
                    Loading category tracking...
                </p>
            ) : (
                <CategoryTrackingReport snapshot={reportSnapshot} />
            )}
        </div>
    );
}
