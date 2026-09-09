"use client";

import { BudgetSetupAllocation } from "@/components/onboarding/budget-setup-allocation";
import { useLedgerSetup } from "@/components/onboarding/ledger-setup";
import { formatUsd } from "@/lib/formatting/money";
import {
    type CSSProperties,
    Fragment,
    type FormEvent,
    type ReactNode,
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
} from "react";
import {
    faCaretDown,
    faCaretRight,
    faCircleCheck,
    faCircleInfo,
    faClock,
    faFilter,
    faTriangleExclamation,
    faXmark,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

import { CategoryActivityReportTable } from "@/components/reporting/category-activity-report-table";
import { DialogCloseButton } from "@/components/shared/dialog-close-button";
import { useFeedbackToasts } from "@/components/shared/feedback-toast-provider";
import { HeaderStatusDisclosure } from "@/components/shared/header-status-disclosure";
import { InlineEditableField } from "@/components/shared/inline-editable-field";
import { MoneyAmount } from "@/components/shared/money-amount";
import { useEscapeToClose } from "@/components/shared/use-escape-to-close";
import { useKeyboardShortcuts } from "@/components/shared/use-keyboard-shortcuts";
import { useWorkspaceStore } from "@/components/workspace/workspace-store-provider";
import { parseUsdToCents } from "@/lib/formatting/money";
import { parseApiErrorMessage } from "@/lib/api/client-errors";
import {
    createAllocationFundingSourceId,
    type AllocationWithFundingInput,
} from "@/features/budget/models/allocation-funding";
import type { BudgetPeriodSummary } from "@/features/budget/models/budget-period-summary";
import {
    calculateAvailableCents,
    isUncategorizedCategoryId,
    isUserVisibleBudgetCategory,
    planAutoAssignDefaults,
} from "@/modules/budgeting";
import {
    controlClassNames,
    surfaceClassNames,
    tableClassNames,
    typographyClassNames,
} from "@/lib/theme/theme-recipes";
import {
    createOptimisticWorkspaceDelete,
    createOptimisticWorkspaceUpsert,
    type OptimisticWorkspaceChange,
} from "@/lib/workspace/optimistic-changes";
import {
    buildCategoryDetailReportView,
    type CategoryDetailReportEvent,
} from "@/lib/workspace/category-detail-report-projector";
import type { WorkspaceAllocationFundingSourceRecord } from "@/lib/workspace/sync-types";
import { keyboardShortcuts } from "@/lib/keyboard-shortcuts";
import { getMonthlyPeriodBounds } from "@/modules/ledger";

type BudgetTableProps = {
    isTransitioning?: boolean;
    renderHeader?: (allocationStatus: ReactNode) => ReactNode;
    summary: BudgetPeriodSummary;
};

type BudgetTableCategory = BudgetPeriodSummary["categories"][number];

type BudgetTableDisplayRow =
    | {
          groupKey: string;
          label: string;
          type: "group";
      }
    | {
          category: BudgetTableCategory;
          groupKey: string;
          type: "category";
      };

type BudgetTableGroupTotals = {
    activityCents: number;
    assignedCents: number;
    availableCents: number;
    carriedForwardCents: number;
};

type AllocationDetailRow = {
    amountCents: number;
    group?: "Allocations" | "Funding";
    id: string;
    label: string;
};

type AllocationDetailGroup = {
    label: "Allocations" | "Funding";
    rows: AllocationDetailRow[];
};

type ActivityDetailProjectionCategory = Pick<
    BudgetTableCategory,
    | "activityCents"
    | "assignedCents"
    | "availableCents"
    | "carriedForwardCents"
    | "categoryId"
>;

const resetAssignmentsActionClassName =
    "cursor-pointer border border-[var(--tone-error-border)] bg-[var(--tone-error-surface)] px-4 py-3 text-sm font-medium text-[var(--tone-error-ink)] transition hover:bg-[var(--tone-error-surface-strong)] disabled:cursor-not-allowed disabled:opacity-60";
const collapsedGroupsStorageKeyPrefix =
    "budgeted:monthly-budget:collapsed-groups:v1";
const groupToggleIconSlotClassName =
    "inline-flex h-5 w-5 items-center justify-center";
const amountCellBaseClassName =
    "min-w-[150px] whitespace-nowrap border-l border-[var(--color-border)]/50 px-4 py-1.5 text-right align-middle";
const budgetTableStickyHeaderClassName = `${tableClassNames.stickyHeader} !top-[var(--budget-table-header-top)] [&>tr>th]:!top-[var(--budget-table-header-top)]`;

function getAmountCellToneClassName(cents: number) {
    if (cents > 0) {
        return "bg-[var(--tone-success-surface)]";
    }

    if (cents < 0) {
        return "bg-[var(--tone-error-surface)]";
    }

    return "bg-[var(--tone-money-zero-surface)]";
}

function addToBudgetGroupTotals(
    totals: BudgetTableGroupTotals,
    category: BudgetTableCategory,
) {
    totals.activityCents += category.activityCents;
    totals.assignedCents += category.assignedCents;
    totals.availableCents += category.availableCents;
    totals.carriedForwardCents += category.carriedForwardCents;
}

export function BudgetTable({
    isTransitioning = false,
    renderHeader,
    summary,
}: BudgetTableProps) {
    return (
        <BudgetTableContent
            key={summary.periodId}
            isTransitioning={isTransitioning}
            renderHeader={renderHeader}
            summary={summary}
        />
    );
}

function getCollapsedGroupsStorageKey(ledgerId: string) {
    return `${collapsedGroupsStorageKeyPrefix}:${ledgerId}`;
}

function parseStoredCollapsedGroupKeys(value: string | null) {
    if (!value) {
        return {};
    }

    try {
        const parsed = JSON.parse(value);

        if (!Array.isArray(parsed)) {
            return {};
        }

        return Object.fromEntries(
            parsed
                .filter((entry): entry is string => typeof entry === "string")
                .map((groupKey) => [groupKey, true]),
        ) satisfies Record<string, boolean>;
    } catch {
        return {};
    }
}

function pruneCollapsedGroupKeys(
    collapsedKeys: Record<string, boolean>,
    groupKeys: string[],
) {
    const knownGroupKeys = new Set(groupKeys);

    return Object.fromEntries(
        Object.entries(collapsedKeys).filter(
            ([groupKey, isCollapsed]) =>
                isCollapsed === true && knownGroupKeys.has(groupKey),
        ),
    ) satisfies Record<string, boolean>;
}

function readCollapsedGroupsStorageValue(storageKey: string) {
    if (typeof window === "undefined") {
        return "";
    }

    try {
        return window.localStorage.getItem(storageKey) ?? "";
    } catch {
        return "";
    }
}

function subscribeToCollapsedGroupsStorage(
    storageKey: string,
    onStoreChange: () => void,
) {
    if (typeof window === "undefined") {
        return () => {};
    }

    function handleStorage(event: StorageEvent) {
        if (event.key === storageKey) {
            onStoreChange();
        }
    }

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
}

function createAllocationDetailRow(input: {
    assignedCents: number;
    categoryName: string;
    id: string;
}): AllocationDetailRow | null {
    if (input.assignedCents === 0) {
        return null;
    }

    return {
        amountCents: input.assignedCents,
        group: "Allocations",
        id: input.id,
        label: input.categoryName,
    };
}

function createSourceFundingDetailRow(input: {
    assignedCents: number;
    categoryName: string;
    id: string;
}): AllocationDetailRow | null {
    if (input.assignedCents === 0) {
        return null;
    }

    return {
        amountCents: -input.assignedCents,
        group: "Funding",
        id: input.id,
        label: input.categoryName,
    };
}

function createOpeningBalanceFundingDetailRow(input: {
    accountId: string;
    accountName: string;
    amountCents: number;
}): AllocationDetailRow {
    const label = `Opening balance: ${input.accountName}`;

    if (input.amountCents >= 0) {
        return {
            amountCents: input.amountCents,
            group: "Funding",
            id: `opening-balance:${input.accountId}`,
            label,
        };
    }

    return {
        amountCents: input.amountCents,
        group: "Funding",
        id: `opening-balance:${input.accountId}`,
        label,
    };
}

function groupAllocationDetailRows(
    rows: AllocationDetailRow[],
): AllocationDetailGroup[] {
    const fundingRows = rows.filter((row) => row.group === "Funding");
    const allocationRows = rows.filter((row) => !fundingRows.includes(row));
    const groups: AllocationDetailGroup[] = [
        { label: "Funding", rows: fundingRows },
        { label: "Allocations", rows: allocationRows },
    ];

    return groups.filter((group) => group.rows.length > 0);
}

function buildActivityDetailsEvents(input: {
    category: ActivityDetailProjectionCategory;
    periodId: string;
    transactionEvents: CategoryDetailReportEvent[];
}): CategoryDetailReportEvent[] {
    const bounds = getMonthlyPeriodBounds(input.periodId);
    const rows: CategoryDetailReportEvent[] = [];
    let runningCents = input.category.carriedForwardCents;

    rows.push({
        amountCents: input.category.carriedForwardCents,
        date: bounds.startsOn,
        eventId: `projection:${input.periodId}:${input.category.categoryId}:month-start`,
        memo: "",
        payee: "Month Start",
        periodId: input.periodId,
        runningCents,
        sortPriority: 0,
        type: "projection",
    });

    runningCents += input.category.assignedCents;
    rows.push({
        amountCents: input.category.assignedCents,
        date: bounds.startsOn,
        eventId: `projection:${input.periodId}:${input.category.categoryId}:assigned`,
        memo: "",
        payee: "Assigned",
        periodId: input.periodId,
        runningCents,
        sortPriority: 1,
        type: "projection",
    });

    for (const event of input.transactionEvents) {
        runningCents += event.amountCents;
        rows.push({
            ...event,
            runningCents,
        });
    }

    rows.push({
        amountCents: input.category.availableCents,
        date: bounds.endsOn,
        eventId: `projection:${input.periodId}:${input.category.categoryId}:total`,
        hideAmount: true,
        memo: "",
        payee: "Total",
        periodId: input.periodId,
        runningCents: input.category.availableCents,
        sortPriority: 90,
        type: "projection",
    });

    return rows;
}

function BudgetTableContent({
    isTransitioning = false,
    renderHeader,
    summary,
}: BudgetTableProps) {
    const { executeWorkspaceCommand, snapshot } = useWorkspaceStore();
    const setup = useLedgerSetup();
    const { notifyError } = useFeedbackToasts();
    const hasRenderedHeader = Boolean(renderHeader);
    const stickyBudgetHeaderRef = useRef<HTMLDivElement | null>(null);
    const categoryFilterInputRef = useRef<HTMLInputElement>(null);
    const [budgetTableHeaderTop, setBudgetTableHeaderTop] = useState(0);
    const [categoryFilterQuery, setCategoryFilterQuery] = useState("");
    const [isFilterOpen, setIsFilterOpen] = useState(false);
    const allocationFundingRows = summary.allocationFundingRows ?? [];
    const allocationFundingCents =
        summary.allocationFundingCents ??
        allocationFundingRows.reduce(
            (total, row) => total + row.amountCents,
            0,
        );
    const allocationDifferenceCents =
        summary.allocationDifferenceCents ??
        allocationFundingCents - summary.assignedAllocationTotalCents;
    const isSubmitting = false;
    const [editingCategoryId, setEditingCategoryId] = useState<string | null>(
        null,
    );
    const [draftAssignedValue, setDraftAssignedValue] = useState("");
    const [collapsedGroupOverride, setCollapsedGroupOverride] = useState<{
        keys: Record<string, boolean>;
        storageKey: string;
    } | null>(null);
    const [isAllocationDetailsOpen, setIsAllocationDetailsOpen] =
        useState(false);
    const [activityDetailsCategoryId, setActivityDetailsCategoryId] = useState<
        string | null
    >(null);
    const [isResetConfirmationOpen, setIsResetConfirmationOpen] =
        useState(false);

    useEscapeToClose({
        enabled: isAllocationDetailsOpen && !isSubmitting,
        onClose: () => {
            setIsAllocationDetailsOpen(false);
            setIsResetConfirmationOpen(false);
        },
    });

    useEscapeToClose({
        enabled: activityDetailsCategoryId !== null,
        onClose: () => setActivityDetailsCategoryId(null),
    });

    useKeyboardShortcuts({
        enabled:
            !isSubmitting &&
            !isAllocationDetailsOpen &&
            activityDetailsCategoryId === null,
        shortcuts: [
            {
                ...keyboardShortcuts.budget.openFilter,
                handler: () => setIsFilterOpen(true),
            },
        ],
    });

    useEffect(() => {
        if (!isFilterOpen) {
            return;
        }

        const focusTimer = window.setTimeout(() => {
            categoryFilterInputRef.current?.focus();
        }, 0);

        return () => window.clearTimeout(focusTimer);
    }, [isFilterOpen]);

    function formatAssignedAmount(assignedCents: number) {
        return (assignedCents / 100).toFixed(2);
    }

    function parseDraftAmount(value: string) {
        return value.trim() === "" ? 0 : parseUsdToCents(value);
    }

    function createOptimisticAllocationChanges(
        allocations: AllocationWithFundingInput[],
    ): OptimisticWorkspaceChange[] {
        const changedAtDate = new Date();
        const changedAt = changedAtDate.toISOString();
        const batchId = `optimistic:allocations:${summary.periodId}`;
        const categoryRecordsById = new Map(
            snapshot.budgetCategories.map((category) => [
                category.categoryId,
                category,
            ]),
        );
        const assignedCentsByCategoryId = new Map(
            allocations.map((allocation) => [
                allocation.categoryId,
                allocation.assignedCents,
            ]),
        );
        const currentFundingSourceById = new Map(
            periodFundingSourceRecords.map((record) => [
                record.fundingSourceId,
                record,
            ]),
        );
        const nextFundingSourceRecords = allocations.flatMap((allocation) =>
            (allocation.fundingSources ?? []).map((source) => {
                const allocationId = `${summary.periodId}:${allocation.categoryId}`;
                const fundingSourceId = createAllocationFundingSourceId({
                    categoryId: allocation.categoryId,
                    periodId: summary.periodId,
                    sourceId: source.sourceId,
                    sourceType: source.sourceType,
                });
                const currentFundingSource =
                    currentFundingSourceById.get(fundingSourceId);
                const destinationCategoryRecord = categoryRecordsById.get(
                    allocation.categoryId,
                );

                return {
                    allocationId,
                    amountCents: source.amountCents,
                    categoryId: allocation.categoryId,
                    createdAt: currentFundingSource?.createdAt ?? changedAt,
                    fundingSourceId,
                    ledgerId:
                        destinationCategoryRecord?.ledgerId ??
                        snapshot.activeLedgerId,
                    periodId: summary.periodId,
                    sourceId: source.sourceId,
                    sourceType: source.sourceType,
                    updatedAt: changedAt,
                } satisfies WorkspaceAllocationFundingSourceRecord;
            }),
        );
        const nextFundingSourceIds = new Set(
            nextFundingSourceRecords.map((record) => record.fundingSourceId),
        );

        return [
            ...assignableCategories.flatMap((category) => {
                const categoryRecord = categoryRecordsById.get(
                    category.categoryId,
                );

                if (!categoryRecord) {
                    return [];
                }

                const assignedCents =
                    assignedCentsByCategoryId.get(category.categoryId) ??
                    category.assignedCents;
                const record = {
                    activityCents: category.activityCents,
                    allocationId: `${summary.periodId}:${category.categoryId}`,
                    assignedCents,
                    availableCents: calculateAvailableCents({
                        activityCents: category.activityCents,
                        assignedCents,
                        carriedForwardCents: category.carriedForwardCents,
                    }),
                    carriedForwardCents: category.carriedForwardCents,
                    categoryId: category.categoryId,
                    ledgerId: categoryRecord.ledgerId,
                    periodId: summary.periodId,
                    updatedAt: changedAt,
                };

                return [
                    createOptimisticWorkspaceUpsert({
                        batchId,
                        changedAt: changedAtDate,
                        entityId: record.allocationId,
                        entityType: "categoryAllocation",
                        record,
                    }),
                ];
            }),
            ...periodFundingSourceRecords
                .filter(
                    (record) =>
                        !nextFundingSourceIds.has(record.fundingSourceId),
                )
                .map((record) =>
                    createOptimisticWorkspaceDelete({
                        batchId,
                        changedAt: changedAtDate,
                        entityId: record.fundingSourceId,
                        entityType: "allocationFundingSource",
                    }),
                ),
            ...nextFundingSourceRecords.map((record) =>
                createOptimisticWorkspaceUpsert({
                    batchId,
                    changedAt: changedAtDate,
                    entityId: record.fundingSourceId,
                    entityType: "allocationFundingSource",
                    record,
                }),
            ),
        ];
    }

    const assignableCategories = summary.categories.filter(
        (category) => !isUncategorizedCategoryId(category.categoryId),
    );
    const periodAllocationRecords = snapshot.budgetAllocations.filter(
        (allocation) => allocation.periodId === summary.periodId,
    );
    const periodFundingSourceRecords = snapshot.allocationFundingSources.filter(
        (record) => record.periodId === summary.periodId,
    );
    const categoryNameById = useMemo(() => {
        const names = new Map<string, string>();

        for (const category of snapshot.budgetCategories) {
            names.set(category.categoryId, category.name);
        }

        for (const category of summary.categories) {
            names.set(category.categoryId, category.name);
        }

        return names;
    }, [snapshot.budgetCategories, summary.categories]);
    const autoAssignSourceCategoryIds = useMemo(
        () =>
            snapshot.budgetCategories
                .filter(
                    (category) =>
                        category.status === "active" &&
                        isUserVisibleBudgetCategory(category) &&
                        category.autoAssignSourceEnabled === true,
                )
                .sort(
                    (a, b) =>
                        (a.autoAssignSourceSortOrder ??
                            Number.MAX_SAFE_INTEGER) -
                            (b.autoAssignSourceSortOrder ??
                                Number.MAX_SAFE_INTEGER) ||
                        a.sortOrder - b.sortOrder ||
                        a.name.localeCompare(b.name),
                )
                .map((category) => category.categoryId),
        [snapshot.budgetCategories],
    );
    const autoAssignSourceCategoryIdSet = new Set(
        autoAssignSourceCategoryIds,
    );
    const allocationDetailRows = (() => {
        const summaryCategoryIds = new Set(
            summary.categories.map((category) => category.categoryId),
        );
        const periodAllocationsByCategoryId = new Map(
            periodAllocationRecords.map((allocation) => [
                allocation.categoryId,
                allocation,
            ]),
        );
        const normalRows: AllocationDetailRow[] = (
            periodAllocationRecords.length > 0
                ? [
                      ...summary.categories.flatMap((category) => {
                          const allocation = periodAllocationsByCategoryId.get(
                              category.categoryId,
                          );

                          return allocation ? [allocation] : [];
                      }),
                      ...periodAllocationRecords.filter(
                          (allocation) =>
                              !summaryCategoryIds.has(allocation.categoryId),
                      ),
                  ]
                : summary.hasSavedAssignments
                  ? summary.categories.map((category) => ({
                        allocationId: `${summary.periodId}:${category.categoryId}`,
                        assignedCents: category.assignedCents,
                        categoryId: category.categoryId,
                    }))
                  : []
        ).flatMap((allocation) => {
            const rowInput = {
                assignedCents: allocation.assignedCents,
                categoryName:
                    categoryNameById.get(allocation.categoryId) ??
                    allocation.categoryId,
                id: `assignment:${allocation.allocationId}`,
            };
            const row = autoAssignSourceCategoryIdSet.has(
                allocation.categoryId,
            )
                ? createSourceFundingDetailRow(rowInput)
                : createAllocationDetailRow(rowInput);

            return row ? [row] : [];
        });
        const openingBalanceRows = allocationFundingRows.map((row) =>
            createOpeningBalanceFundingDetailRow(row),
        );

        return [...openingBalanceRows, ...normalRows];
    })();
    const hasAllocationDetails =
        allocationFundingRows.length > 0 ||
        summary.hasSavedAssignments ||
        periodAllocationRecords.length > 0 ||
        periodFundingSourceRecords.length > 0;
    const allocatedFundingCents = allocationDetailRows
        .filter((row) => row.group === "Funding")
        .reduce((total, row) => total + row.amountCents, 0);
    const allocatedCents = allocationDetailRows
        .filter((row) => row.group !== "Funding")
        .reduce((total, row) => total + row.amountCents, 0);
    const allocatedDifferenceCents = allocatedFundingCents - allocatedCents;
    const activityDetailsCategory = activityDetailsCategoryId
        ? summary.categories.find(
              (category) => category.categoryId === activityDetailsCategoryId,
          )
        : undefined;
    const activityDetailsView = activityDetailsCategory
        ? buildCategoryDetailReportView({
              categoryId: activityDetailsCategory.categoryId,
              eventScope: "transactions",
              filterMode: "month",
              periodId: summary.periodId,
              snapshot,
          })
        : null;
    const allBudgetDisplayRows = useMemo<BudgetTableDisplayRow[]>(() => {
        const categoryRecordById = new Map(
            snapshot.budgetCategories.map((category) => [
                category.categoryId,
                category,
            ]),
        );
        const groupRecordById = new Map(
            snapshot.budgetGroups.map((group) => [group.groupId, group]),
        );

        function getSortInfo(category: BudgetTableCategory) {
            if (isUncategorizedCategoryId(category.categoryId)) {
                return {
                    categoryName: category.name,
                    categorySortOrder: Number.MIN_SAFE_INTEGER,
                    groupKey: "group:synthetic-uncategorized",
                    groupLabel: "Uncategorized",
                    groupSortOrder: Number.MIN_SAFE_INTEGER,
                };
            }

            const categoryRecord = categoryRecordById.get(category.categoryId);
            const groupRecord = categoryRecord
                ? groupRecordById.get(categoryRecord.groupId)
                : undefined;

            return {
                categoryName: categoryRecord?.name ?? category.name,
                categorySortOrder:
                    categoryRecord?.sortOrder ?? Number.MAX_SAFE_INTEGER,
                groupKey: categoryRecord
                    ? `group:${categoryRecord.groupId}`
                    : "group:other",
                groupLabel: groupRecord?.name ?? "Other",
                groupSortOrder:
                    groupRecord?.sortOrder ?? Number.MAX_SAFE_INTEGER,
            };
        }

        const sortedCategories = [...summary.categories].sort((left, right) => {
            const leftSort = getSortInfo(left);
            const rightSort = getSortInfo(right);

            if (leftSort.groupSortOrder !== rightSort.groupSortOrder) {
                return leftSort.groupSortOrder - rightSort.groupSortOrder;
            }

            if (leftSort.groupLabel !== rightSort.groupLabel) {
                return leftSort.groupLabel.localeCompare(rightSort.groupLabel);
            }

            if (leftSort.categorySortOrder !== rightSort.categorySortOrder) {
                return leftSort.categorySortOrder - rightSort.categorySortOrder;
            }

            return leftSort.categoryName.localeCompare(rightSort.categoryName);
        });
        const rows: BudgetTableDisplayRow[] = [];
        let currentGroupKey = "";

        for (const category of sortedCategories) {
            const sortInfo = getSortInfo(category);

            if (sortInfo.groupKey !== currentGroupKey) {
                rows.push({
                    groupKey: sortInfo.groupKey,
                    label: sortInfo.groupLabel,
                    type: "group",
                });
                currentGroupKey = sortInfo.groupKey;
            }

            rows.push({
                category,
                groupKey: sortInfo.groupKey,
                type: "category",
            });
        }

        return rows;
    }, [snapshot.budgetCategories, snapshot.budgetGroups, summary.categories]);
    const normalizedCategoryFilterQuery = categoryFilterQuery
        .trim()
        .toLowerCase();
    const hasCategoryFilter = normalizedCategoryFilterQuery.length > 0;
    const budgetDisplayRows = useMemo(() => {
        if (!normalizedCategoryFilterQuery) {
            return allBudgetDisplayRows;
        }

        const matchingCategoryIds = new Set(
            summary.categories
                .filter((category) =>
                    category.name
                        .toLowerCase()
                        .includes(normalizedCategoryFilterQuery),
                )
                .map((category) => category.categoryId),
        );
        const matchingGroupKeys = new Set(
            allBudgetDisplayRows.flatMap((row) =>
                row.type === "category" &&
                matchingCategoryIds.has(row.category.categoryId)
                    ? [row.groupKey]
                    : [],
            ),
        );

        return allBudgetDisplayRows.filter((row) =>
            row.type === "group"
                ? matchingGroupKeys.has(row.groupKey)
                : matchingCategoryIds.has(row.category.categoryId),
        );
    }, [
        allBudgetDisplayRows,
        normalizedCategoryFilterQuery,
        summary.categories,
    ]);
    const budgetGroupKeys = useMemo(
        () =>
            allBudgetDisplayRows
                .filter((row) => row.type === "group")
                .map((row) => row.groupKey),
        [allBudgetDisplayRows],
    );
    const budgetGroupTotalsByKey = useMemo(() => {
        const totalsByKey = new Map<string, BudgetTableGroupTotals>();

        for (const row of budgetDisplayRows) {
            if (row.type !== "category") {
                continue;
            }

            const totals = totalsByKey.get(row.groupKey) ?? {
                activityCents: 0,
                assignedCents: 0,
                availableCents: 0,
                carriedForwardCents: 0,
            };

            addToBudgetGroupTotals(totals, row.category);
            totalsByKey.set(row.groupKey, totals);
        }

        return totalsByKey;
    }, [budgetDisplayRows]);
    const collapsedGroupsStorageKey = getCollapsedGroupsStorageKey(
        snapshot.activeLedgerId,
    );
    const storedCollapsedGroupsValue = useSyncExternalStore(
        (onStoreChange) =>
            subscribeToCollapsedGroupsStorage(
                collapsedGroupsStorageKey,
                onStoreChange,
            ),
        () => readCollapsedGroupsStorageValue(collapsedGroupsStorageKey),
        () => null,
    );
    const storedCollapsedGroupKeys = useMemo(
        () =>
            storedCollapsedGroupsValue === null
                ? {}
                : pruneCollapsedGroupKeys(
                      parseStoredCollapsedGroupKeys(storedCollapsedGroupsValue),
                      budgetGroupKeys,
                  ),
        [budgetGroupKeys, storedCollapsedGroupsValue],
    );
    const collapsedGroupKeys = useMemo(
        () =>
            pruneCollapsedGroupKeys(
                collapsedGroupOverride?.storageKey === collapsedGroupsStorageKey
                    ? collapsedGroupOverride.keys
                    : storedCollapsedGroupKeys,
                budgetGroupKeys,
            ),
        [
            budgetGroupKeys,
            collapsedGroupOverride,
            collapsedGroupsStorageKey,
            storedCollapsedGroupKeys,
        ],
    );
    const areCollapsedGroupPreferencesResolved =
        storedCollapsedGroupsValue !== null;
    const isAnyCategoryShown = budgetDisplayRows.some(
        (row) =>
            row.type === "category" &&
            (hasCategoryFilter || !collapsedGroupKeys[row.groupKey]),
    );

    useEffect(() => {
        if (
            !areCollapsedGroupPreferencesResolved ||
            typeof window === "undefined"
        ) {
            return;
        }

        const prunedKeys = pruneCollapsedGroupKeys(
            collapsedGroupKeys,
            budgetGroupKeys,
        );

        try {
            window.localStorage.setItem(
                collapsedGroupsStorageKey,
                JSON.stringify(Object.keys(prunedKeys)),
            );
        } catch {
            // Browser storage is a preference cache only; the table still works.
        }
    }, [
        areCollapsedGroupPreferencesResolved,
        budgetGroupKeys,
        collapsedGroupKeys,
        collapsedGroupsStorageKey,
    ]);
    const autoAssignPlan = planAutoAssignDefaults({
        availableToBudgetCents: summary.assignedAllocationTotalCents,
        categories: assignableCategories,
        periodId: summary.periodId,
        sourceCategoryIds: autoAssignSourceCategoryIds,
    });
    const availableAutoAssignSourceCents = assignableCategories.reduce(
        (total, category) =>
            autoAssignSourceCategoryIdSet.has(category.categoryId)
                ? total + Math.max(0, category.availableCents)
                : total,
        0,
    );
    const plannedAllocationCents = autoAssignPlan.requiredSourceCents;
    const plannedAllocationDifferenceCents =
        availableAutoAssignSourceCents - plannedAllocationCents;
    const autoAssignShortfallCents = autoAssignPlan.shortfallCents;
    const canAutoAssignDefaults =
        assignableCategories.length > 0 &&
        autoAssignSourceCategoryIds.length > 0 &&
        autoAssignShortfallCents === 0 &&
        autoAssignPlan.unassignedDeficitCents === 0;
    const autoAssignBlocker =
        autoAssignSourceCategoryIds.length === 0
            ? {
                  label: "Auto assign needs at least one configured source category.",
              }
            : autoAssignPlan.unassignedDeficitCents > 0
              ? {
                    amountCents: autoAssignPlan.unassignedDeficitCents,
                    label: "Auto assign cannot run while Unassigned is negative by",
                }
              : autoAssignShortfallCents > 0
                ? {
                      amountCents: autoAssignShortfallCents,
                      label: "Auto assign needs",
                      suffix: "more configured source funds.",
                  }
                : null;
    const hasAutoAssignWarning =
        !canAutoAssignDefaults &&
        assignableCategories.length > 0 &&
        autoAssignBlocker !== null;
    const hasAllocationDifferenceWarning =
        summary.hasSavedAssignments && allocatedDifferenceCents !== 0;

    useEffect(() => {
        if (!hasRenderedHeader) {
            return;
        }

        const headerElement = stickyBudgetHeaderRef.current;

        if (!headerElement) {
            return;
        }

        const measuredHeaderElement = headerElement;
        let animationFrameId: number | null = null;

        function updateBudgetTableHeaderTop() {
            setBudgetTableHeaderTop(
                Math.ceil(measuredHeaderElement.getBoundingClientRect().height),
            );
        }

        function scheduleBudgetTableHeaderTopUpdate() {
            if (animationFrameId !== null) {
                window.cancelAnimationFrame(animationFrameId);
            }

            animationFrameId = window.requestAnimationFrame(() => {
                animationFrameId = null;
                updateBudgetTableHeaderTop();
            });
        }

        scheduleBudgetTableHeaderTopUpdate();

        if (typeof ResizeObserver === "undefined") {
            window.addEventListener(
                "resize",
                scheduleBudgetTableHeaderTopUpdate,
            );

            return () => {
                if (animationFrameId !== null) {
                    window.cancelAnimationFrame(animationFrameId);
                }
                window.removeEventListener(
                    "resize",
                    scheduleBudgetTableHeaderTopUpdate,
                );
            };
        }

        const resizeObserver = new ResizeObserver(
            scheduleBudgetTableHeaderTopUpdate,
        );
        resizeObserver.observe(measuredHeaderElement);

        return () => {
            if (animationFrameId !== null) {
                window.cancelAnimationFrame(animationFrameId);
            }
            resizeObserver.disconnect();
        };
    }, [hasRenderedHeader]);

    const tableStickyStyle = {
        "--budget-table-header-top": hasRenderedHeader
            ? `calc(${budgetTableHeaderTop}px + 1rem)`
            : "0px",
    } as CSSProperties;

    function saveAllocationInputs(allocations: AllocationWithFundingInput[], onSettled?: (saved: boolean) => void) {
        try {
            const changes = createOptimisticAllocationChanges(allocations);

            void executeWorkspaceCommand({
                activity: {
                    completedLabel: "Allocations saved.",
                    pendingLabel: "Saving allocations…",
                },
                optimisticChanges: changes,
                request: () =>
                    fetch(
                        `/api/budget/periods/${summary.periodId}/allocations`,
                        {
                            method: "PUT",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ allocations }),
                        },
                    ),
                onCommitted: () => onSettled?.(true),
                onError: async (error) => {
                    onSettled?.(false);
                    notifyError({
                        message: `${error instanceof Response ? await parseApiErrorMessage(error, "Unable to save allocations.") : error instanceof Error ? error.message : "Unable to save allocations."} Save failed. The latest saved data has been restored.`,
                        title: "Allocations could not be saved.",
                    });
                },
            });
            return true;
        } catch (error) {
            onSettled?.(false);
            notifyError({
                message: `${error instanceof Error ? error.message : "Unable to save allocations."} The last saved budget allocations are unchanged. Review the values and try again.`,
                title: "Allocations could not be saved.",
            });
            return false;
        }
    }

    function saveAllocations(overrides: Record<string, string> = {}) {
        let allocations: AllocationWithFundingInput[];

        try {
            allocations = assignableCategories.map((category) => ({
                categoryId: category.categoryId,
                assignedCents: parseDraftAmount(
                    overrides[category.categoryId] ??
                        formatAssignedAmount(category.assignedCents),
                ),
            }));
        } catch (error) {
            notifyError({
                message: `${error instanceof Error ? error.message : "Unable to save allocations."} The last saved budget allocations are unchanged. Review the values and try again.`,
                title: "Allocations could not be saved.",
            });
            return false;
        }

        return saveAllocationInputs(allocations);
    }

    function saveEditedAllocation(categoryId: string, assignedValue: string) {
        const didSave = saveAllocations({
            [categoryId]: assignedValue,
        });

        if (!didSave) {
            return;
        }

        setEditingCategoryId(null);
        setDraftAssignedValue("");
    }

    function stopEditingAllocation() {
        setEditingCategoryId(null);
        setDraftAssignedValue("");
    }

    function updateCategoryFilter(query: string) {
        stopEditingAllocation();
        setActivityDetailsCategoryId(null);
        setCategoryFilterQuery(query);
    }

    function clearCategoryFilter() {
        setCategoryFilterQuery("");
    }

    function toggleGroupVisibility(groupKey: string) {
        const shouldCollapse = !collapsedGroupKeys[groupKey];

        if (shouldCollapse) {
            stopEditingAllocation();
        }

        setCollapsedGroupOverride({
            storageKey: collapsedGroupsStorageKey,
            keys: {
                ...Object.fromEntries(
                    Object.entries(collapsedGroupKeys).filter(
                        ([key]) => key !== groupKey,
                    ),
                ),
                ...(shouldCollapse ? { [groupKey]: true } : {}),
            },
        });
    }

    function toggleAllGroupVisibility() {
        const shouldCollapse = isAnyCategoryShown;

        if (shouldCollapse) {
            stopEditingAllocation();
        }

        setCollapsedGroupOverride({
            storageKey: collapsedGroupsStorageKey,
            keys: Object.fromEntries(
                budgetGroupKeys.map((groupKey) => [groupKey, shouldCollapse]),
            ),
        });
    }

    function startEditingAllocation(
        category: BudgetPeriodSummary["categories"][number],
    ) {
        setEditingCategoryId(category.categoryId);
        setDraftAssignedValue(formatAssignedAmount(category.assignedCents));
    }

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();

        if (!editingCategoryId) {
            return;
        }

        saveEditedAllocation(editingCategoryId, draftAssignedValue);
    }

    function autoAssignDefaults() {
        if (!canAutoAssignDefaults) {
            return;
        }

        const didSave = saveAllocationInputs(autoAssignPlan.allocations);

        if (!didSave) {
            return;
        }

        setEditingCategoryId(null);
        setDraftAssignedValue("");
    }

    function closeAllocationDetails() {
        setIsAllocationDetailsOpen(false);
        setIsResetConfirmationOpen(false);
    }

    function createOptimisticResetAllocationChanges(): OptimisticWorkspaceChange[] {
        const changedAtDate = new Date();
        const batchId = `optimistic:allocation-reset:${summary.periodId}`;

        return [
            ...periodAllocationRecords.map((allocation) =>
                createOptimisticWorkspaceDelete({
                    batchId,
                    changedAt: changedAtDate,
                    entityId: allocation.allocationId,
                    entityType: "categoryAllocation",
                }),
            ),
            ...periodFundingSourceRecords.map((record) =>
                createOptimisticWorkspaceDelete({
                    batchId,
                    changedAt: changedAtDate,
                    entityId: record.fundingSourceId,
                    entityType: "allocationFundingSource",
                }),
            ),
        ];
    }

    function resetMonthAssignments() {
        const changes = createOptimisticResetAllocationChanges();

        closeAllocationDetails();
        void executeWorkspaceCommand({
            activity: {
                completedLabel: "Month assignments reset.",
                pendingLabel: "Resetting month assignments…",
            },
            optimisticChanges: changes,
            request: () =>
                fetch(`/api/budget/periods/${summary.periodId}/allocations`, {
                    method: "DELETE",
                }),
            onError: () => {
                notifyError({
                    message:
                        "Reset failed. The latest saved data has been restored.",
                    title: "Month assignments could not be reset.",
                });
            },
        });
    }

    const allocationStatusControl = (
        <HeaderStatusDisclosure
            label={
                <>
                    {!summary.hasSavedAssignments ? (
                        <FontAwesomeIcon
                            aria-hidden="true"
                            icon={faClock}
                            className="text-[var(--color-muted)]"
                        />
                    ) : hasAllocationDifferenceWarning ? (
                        <FontAwesomeIcon
                            aria-hidden="true"
                            icon={faTriangleExclamation}
                            className="text-[var(--tone-warning-ink)]"
                        />
                    ) : (
                        <FontAwesomeIcon
                            aria-hidden="true"
                            icon={faCircleCheck}
                            className="text-[var(--tone-success-ink)]"
                        />
                    )}
                    Monthly Allocation
                </>
            }
            panelClassName="w-80"
        >
            <div className="grid gap-2 text-sm">
                {summary.hasSavedAssignments ? (
                    <>
                        <div className="flex items-center justify-between gap-3">
                            <span>Funding</span>
                            <span className="font-semibold text-[var(--color-ink)]">
                                <MoneyAmount cents={allocatedFundingCents} />
                            </span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <span>Allocated</span>
                            <span className="font-semibold text-[var(--color-ink)]">
                                <MoneyAmount cents={allocatedCents} />
                            </span>
                        </div>
                    </>
                ) : (
                    <>
                        <div className="flex items-center justify-between gap-3">
                            <span>Available</span>
                            <span className="font-semibold text-[var(--color-ink)]">
                                <MoneyAmount
                                    cents={availableAutoAssignSourceCents}
                                />
                            </span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <span>Plan</span>
                            <span className="font-semibold text-[var(--color-ink)]">
                                <MoneyAmount cents={plannedAllocationCents} />
                            </span>
                        </div>
                    </>
                )}
                <div className="flex items-center justify-between gap-3">
                    <span>Difference</span>
                    <span
                        className={
                            hasAllocationDifferenceWarning
                                ? "font-semibold text-[var(--tone-warning-ink)]"
                                : "font-semibold text-[var(--tone-success-ink)]"
                        }
                    >
                        <MoneyAmount
                            cents={
                                summary.hasSavedAssignments
                                    ? allocatedDifferenceCents
                                    : plannedAllocationDifferenceCents
                            }
                        />
                    </span>
                </div>
            </div>
            <div className="grid gap-2">
                {hasAllocationDetails ? (
                    <button
                        type="button"
                        onClick={() => setIsAllocationDetailsOpen(true)}
                        disabled={isSubmitting}
                        className={`${controlClassNames.secondaryActionSmall} cursor-pointer disabled:cursor-not-allowed`}
                    >
                        Allocation details
                    </button>
                ) : null}
                {!summary.hasSavedAssignments ? (
                    <button
                        type="button"
                        onClick={autoAssignDefaults}
                        disabled={isSubmitting || !canAutoAssignDefaults}
                        className={controlClassNames.primaryActionCompact}
                    >
                        {isSubmitting ? "Saving..." : "Auto assign defaults"}
                    </button>
                ) : null}
                <button
                    type="button"
                    onClick={() => {
                        if (!editingCategoryId) {
                            return;
                        }

                        saveEditedAllocation(
                            editingCategoryId,
                            draftAssignedValue,
                        );
                    }}
                    disabled={isSubmitting || editingCategoryId === null}
                    className={`${controlClassNames.primaryActionCompact} cursor-pointer disabled:cursor-not-allowed`}
                >
                    {isSubmitting ? "Saving..." : "Save allocations"}
                </button>
            </div>
            {hasAutoAssignWarning && autoAssignBlocker ? (
                <p className="text-right text-xs text-[var(--tone-warning-ink)]">
                    {autoAssignBlocker.label}
                    {typeof autoAssignBlocker.amountCents === "number" ? (
                        <>
                            {" "}
                            <MoneyAmount
                                cents={autoAssignBlocker.amountCents}
                            />
                        </>
                    ) : null}
                    {autoAssignBlocker.suffix
                        ? ` ${autoAssignBlocker.suffix}`
                        : ""}
                </p>
            ) : null}
        </HeaderStatusDisclosure>
    );

    return (
        <div
            className="grid w-fit max-w-full gap-4"
            data-budget-table-root
            style={tableStickyStyle}
        >
            {renderHeader ? (
                <div
                    ref={stickyBudgetHeaderRef}
                    className="sticky top-0 z-30 w-full bg-[var(--color-surface)] after:pointer-events-none after:absolute after:left-0 after:right-0 after:top-full after:h-4 after:bg-[var(--color-surface)]"
                    data-budget-period-header
                >
                    {renderHeader(allocationStatusControl)}
                </div>
            ) : null}
            <form
                key={summary.periodId}
                onSubmit={handleSubmit}
                aria-busy={isTransitioning}
                className={`grid gap-4 ${
                    isTransitioning ? "pointer-events-none select-none opacity-70" : ""
                }`}
            >
                {renderHeader ? null : (
                    <div className="flex justify-end">
                        {allocationStatusControl}
                    </div>
                )}

                {setup?.state?.status === "active" ? (
                    <BudgetSetupAllocation
                        key={`${snapshot.activeLedgerId}:${summary.periodId}`}
                        availableCents={availableAutoAssignSourceCents}
                        requiredCents={plannedAllocationCents}
                        rows={autoAssignPlan.allocations.map((allocation) => ({
                            ...allocation,
                            name: assignableCategories.find((category) => category.categoryId === allocation.categoryId)?.name ?? allocation.categoryId,
                        }))}
                        hasSavedAssignments={summary.hasSavedAssignments}
                        disabled={
                            isTransitioning ||
                            isSubmitting ||
                            autoAssignSourceCategoryIds.length === 0
                        }
                        blocker={autoAssignBlocker
                            ? `${autoAssignBlocker.label}${autoAssignBlocker.amountCents !== undefined ? ` ${formatUsd(autoAssignBlocker.amountCents)}` : ""}${autoAssignBlocker.suffix ? ` ${autoAssignBlocker.suffix}` : ""}`
                            : !canAutoAssignDefaults ? "Add a budget category before assigning money." : null}
                        onConfirm={(onSettled) => {
                            if (!canAutoAssignDefaults || summary.hasSavedAssignments || isTransitioning) {
                                onSettled(false);
                                return;
                            }
                            saveAllocationInputs(autoAssignPlan.allocations, onSettled);
                        }}
                    />
                ) : null}

                <div className="grid gap-3">
                    <div className="flex justify-end">
                        <button
                            type="button"
                            aria-expanded={isFilterOpen}
                            aria-controls="budget-filter-controls"
                            onClick={() => {
                                setIsFilterOpen((currentValue) => !currentValue);
                            }}
                            className={`inline-flex cursor-pointer items-center gap-2 ${controlClassNames.secondaryActionCompact}`}
                        >
                            <FontAwesomeIcon aria-hidden="true" icon={faFilter} />
                            Filter
                        </button>
                    </div>

                    {hasCategoryFilter ? (
                        <div
                            aria-live="polite"
                            className="flex flex-wrap items-center gap-2 text-sm text-[var(--color-muted)]"
                        >
                            <span>Filter:</span>
                            <span className="inline-flex items-center gap-1 border border-[var(--color-accent-ink)] bg-[var(--color-accent-soft)] px-2 py-1 text-sm text-[var(--color-accent-contrast)]">
                                <span>
                                    Category: {categoryFilterQuery.trim()}
                                </span>
                                <button
                                    type="button"
                                    aria-label="Clear category filter"
                                    onClick={clearCategoryFilter}
                                    className="inline-flex size-5 cursor-pointer items-center justify-center text-[var(--color-accent-contrast)] transition hover:bg-[var(--color-accent-ink)] hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-ring)]"
                                >
                                    <FontAwesomeIcon
                                        aria-hidden="true"
                                        icon={faXmark}
                                    />
                                </button>
                            </span>
                            <button
                                type="button"
                                onClick={clearCategoryFilter}
                                className="inline-flex cursor-pointer items-center gap-1 border border-[#3b4658] bg-[#202632] px-2.5 py-1 text-sm font-medium text-[var(--color-ink)] transition hover:bg-[#2b3443] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-ring)]"
                            >
                                <FontAwesomeIcon
                                    aria-hidden="true"
                                    icon={faXmark}
                                />
                                Clear all
                            </button>
                        </div>
                    ) : null}

                    {isFilterOpen ? (
                        <div
                            id="budget-filter-controls"
                            className="grid gap-3 border border-[var(--color-border)] bg-[var(--color-panel-strong)] p-3 lg:grid-cols-4"
                        >
                            <label className="grid min-w-0 gap-1 text-xs font-medium uppercase tracking-[0.12em] text-[var(--color-muted)]">
                                Category
                                <input
                                    ref={categoryFilterInputRef}
                                    type="text"
                                    placeholder="Search categories"
                                    value={categoryFilterQuery}
                                    onChange={(event) => {
                                        updateCategoryFilter(event.target.value);
                                    }}
                                    className={`${controlClassNames.fieldCompact} h-10 w-full`}
                                />
                            </label>
                        </div>
                    ) : null}
                </div>

                {areCollapsedGroupPreferencesResolved ? (
                    <div className="w-full overflow-x-visible">
                        <table className="w-auto min-w-max border-collapse text-left text-sm">
                            <thead className={budgetTableStickyHeaderClassName}>
                                <tr className="border-b border-[var(--color-border)] text-[var(--color-muted)]">
                                    <th className="whitespace-nowrap px-4 py-3 font-medium">
                                        <span className="inline-flex items-center gap-2">
                                            <button
                                                type="button"
                                                aria-expanded={
                                                    isAnyCategoryShown
                                                }
                                                aria-label={
                                                    isAnyCategoryShown
                                                        ? "Hide all budget category groups"
                                                        : "Show all budget category groups"
                                                }
                                                onClick={
                                                    toggleAllGroupVisibility
                                                }
                                                className={`${groupToggleIconSlotClassName} cursor-pointer text-[var(--color-muted)] transition hover:text-[var(--color-accent-contrast)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-ring)]`}
                                            >
                                                <FontAwesomeIcon
                                                    aria-hidden="true"
                                                    icon={
                                                        isAnyCategoryShown
                                                            ? faCaretDown
                                                            : faCaretRight
                                                    }
                                                    className="text-xs"
                                                />
                                            </button>
                                            Category
                                        </span>
                                    </th>
                                    <th className="min-w-[150px] whitespace-nowrap border-l border-[var(--color-border)]/50 px-4 py-3 text-right font-medium">
                                        Month Start
                                    </th>
                                    <th className="min-w-[150px] whitespace-nowrap border-l border-[var(--color-border)]/50 px-4 py-3 text-right font-medium">
                                        Assigned
                                    </th>
                                    <th className="min-w-[150px] whitespace-nowrap border-l border-[var(--color-border)]/50 px-4 py-3 text-right font-medium">
                                        Activity
                                    </th>
                                    <th className="whitespace-nowrap border-l border-[var(--color-border)]/50 py-3 pl-8 pr-4 text-right font-semibold text-[var(--color-ink)]">
                                        Total
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {budgetDisplayRows.map((row, rowIndex) => {
                                    if (row.type === "group") {
                                        const isCollapsed =
                                            !hasCategoryFilter &&
                                            collapsedGroupKeys[row.groupKey] ===
                                                true;
                                        const totals =
                                            budgetGroupTotalsByKey.get(
                                                row.groupKey,
                                            ) ?? {
                                                activityCents: 0,
                                                assignedCents: 0,
                                                availableCents: 0,
                                                carriedForwardCents: 0,
                                            };
                                        const shouldAddGroupSpacer =
                                            rowIndex > 0;
                                        const groupHeaderClassName =
                                            shouldAddGroupSpacer
                                                ? "border-t-2 border-b-2 border-[var(--color-border)] text-sm font-semibold"
                                                : "border-b-2 border-[var(--color-border)] text-sm font-semibold";

                                        return (
                                            <Fragment key={row.groupKey}>
                                                {shouldAddGroupSpacer ? (
                                                    <tr
                                                        aria-hidden="true"
                                                        data-budget-group-spacer={
                                                            row.groupKey
                                                        }
                                                    >
                                                        <td
                                                            colSpan={5}
                                                            className="h-8 border-0 p-0"
                                                        />
                                                    </tr>
                                                ) : null}
                                                <tr
                                                    className={
                                                        groupHeaderClassName
                                                    }
                                                >
                                                    <th
                                                        scope="rowgroup"
                                                        className="bg-[var(--color-panel-strong)] px-4 py-2 text-left text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-muted)]"
                                                    >
                                                        <button
                                                            type="button"
                                                            aria-expanded={
                                                                !isCollapsed
                                                            }
                                                            aria-label={
                                                                isCollapsed
                                                                    ? `Show categories in ${row.label}`
                                                                    : `Hide categories in ${row.label}`
                                                            }
                                                            onClick={() =>
                                                                toggleGroupVisibility(
                                                                    row.groupKey,
                                                                )
                                                            }
                                                            className="inline-flex cursor-pointer items-center gap-2 text-left font-semibold uppercase tracking-[0.16em] text-[var(--color-muted)] transition hover:text-[var(--color-accent-contrast)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-ring)]"
                                                        >
                                                            <span
                                                                className={
                                                                    groupToggleIconSlotClassName
                                                                }
                                                            >
                                                                <FontAwesomeIcon
                                                                    aria-hidden="true"
                                                                    icon={
                                                                        isCollapsed
                                                                            ? faCaretRight
                                                                            : faCaretDown
                                                                    }
                                                                    className="text-xs"
                                                                />
                                                            </span>
                                                            <span>
                                                                {row.label}
                                                            </span>
                                                        </button>
                                                    </th>
                                                    <td
                                                        className={`${amountCellBaseClassName} bg-[var(--color-panel-strong)] font-semibold tabular-nums`}
                                                    >
                                                        <MoneyAmount
                                                            cents={
                                                                totals.carriedForwardCents
                                                            }
                                                        />
                                                    </td>
                                                    <td
                                                        className={`${amountCellBaseClassName} bg-[var(--color-panel-strong)] font-semibold tabular-nums`}
                                                    >
                                                        <MoneyAmount
                                                            cents={
                                                                totals.assignedCents
                                                            }
                                                        />
                                                    </td>
                                                    <td
                                                        className={`${amountCellBaseClassName} bg-[var(--color-panel-strong)] font-semibold tabular-nums`}
                                                    >
                                                        <MoneyAmount
                                                            cents={
                                                                totals.activityCents
                                                            }
                                                        />
                                                    </td>
                                                    <td className="whitespace-nowrap border-l border-[var(--color-border)]/50 bg-[var(--color-panel-strong)] py-2 pl-8 pr-4 text-right align-middle font-semibold tabular-nums">
                                                        <MoneyAmount
                                                            cents={
                                                                totals.availableCents
                                                            }
                                                        />
                                                    </td>
                                                </tr>
                                            </Fragment>
                                        );
                                    }

                                    if (
                                        !hasCategoryFilter &&
                                        collapsedGroupKeys[row.groupKey]
                                    ) {
                                        return null;
                                    }

                                    const { category } = row;
                                    const isUncategorizedCategory =
                                        isUncategorizedCategoryId(
                                            category.categoryId,
                                        );
                                    const nextRow =
                                        budgetDisplayRows[rowIndex + 1];
                                    const isLastRowInGroup =
                                        !nextRow ||
                                        nextRow.type === "group" ||
                                        nextRow.groupKey !== row.groupKey;
                                    const categoryRowClassName =
                                        isLastRowInGroup
                                            ? "border-b-2 border-[var(--color-border)]"
                                            : "border-b border-[var(--color-border)]/70";

                                    return (
                                        <tr
                                            key={category.categoryId}
                                            className={categoryRowClassName}
                                        >
                                            <td className="whitespace-nowrap px-4 py-1.5 align-middle">
                                                <div className="font-medium text-[var(--color-ink)]">
                                                    {category.name}
                                                </div>
                                            </td>
                                            <td
                                                className={
                                                    amountCellBaseClassName
                                                }
                                            >
                                                <MoneyAmount
                                                    cents={
                                                        category.carriedForwardCents
                                                    }
                                                />
                                            </td>
                                            <td
                                                className={
                                                    amountCellBaseClassName
                                                }
                                            >
                                                {isUncategorizedCategory ? (
                                                    <span className="inline-flex w-32 justify-end">
                                                        <MoneyAmount
                                                            cents={
                                                                category.assignedCents
                                                            }
                                                        />
                                                    </span>
                                                ) : (
                                                    <InlineEditableField
                                                        ariaLabel={`Edit assigned amount for ${category.name}`}
                                                        displayClassName="-mr-2 w-32 justify-end !pl-0 !pr-2 text-right"
                                                        displayValue={
                                                            <MoneyAmount
                                                                cents={
                                                                    category.assignedCents
                                                                }
                                                            />
                                                        }
                                                        inputAriaLabel={`Assigned amount for ${category.name}`}
                                                        inputClassName="-mr-2 w-32 text-right"
                                                        inputMode="decimal"
                                                        commitOnBlur
                                                        isEditing={
                                                            editingCategoryId ===
                                                            category.categoryId
                                                        }
                                                        name={`assigned-${category.categoryId}`}
                                                        valueKind="money"
                                                        value={
                                                            editingCategoryId ===
                                                                category.categoryId &&
                                                            !isSubmitting
                                                                ? draftAssignedValue
                                                                : formatAssignedAmount(
                                                                      category.assignedCents,
                                                                  )
                                                        }
                                                        onCancel={() => {
                                                            setEditingCategoryId(
                                                                null,
                                                            );
                                                            setDraftAssignedValue(
                                                                "",
                                                            );
                                                        }}
                                                        onChange={
                                                            setDraftAssignedValue
                                                        }
                                                        onCommit={(value) => {
                                                            void saveEditedAllocation(
                                                                category.categoryId,
                                                                value,
                                                            );
                                                        }}
                                                        onEditStart={() => {
                                                            startEditingAllocation(
                                                                category,
                                                            );
                                                        }}
                                                        onEditingChange={(
                                                            nextIsEditing,
                                                        ) => {
                                                            if (
                                                                !nextIsEditing
                                                            ) {
                                                                setEditingCategoryId(
                                                                    null,
                                                                );
                                                            }
                                                        }}
                                                        disabled={isSubmitting}
                                                    />
                                                )}
                                            </td>
                                            <td
                                                className={
                                                    amountCellBaseClassName
                                                }
                                            >
                                                <button
                                                    type="button"
                                                    aria-label={`View activity for ${category.name} in ${summary.periodId}`}
                                                    onClick={() =>
                                                        setActivityDetailsCategoryId(
                                                            category.categoryId,
                                                        )
                                                    }
                                                    className="inline-flex cursor-pointer items-center justify-end gap-1.5 text-right text-[var(--color-muted)] transition hover:text-[var(--color-accent-contrast)] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-ring)]"
                                                >
                                                    <FontAwesomeIcon
                                                        aria-hidden="true"
                                                        icon={faCircleInfo}
                                                        className="text-xs"
                                                    />
                                                    <MoneyAmount
                                                        cents={
                                                            category.activityCents
                                                        }
                                                    />
                                                </button>
                                            </td>
                                            <td
                                                className={`whitespace-nowrap border-l border-[var(--color-border)]/50 py-1.5 pl-8 pr-4 text-right align-middle text-base font-semibold ${getAmountCellToneClassName(category.availableCents)}`}
                                            >
                                                <MoneyAmount
                                                    cents={
                                                        category.availableCents
                                                    }
                                                />
                                            </td>
                                        </tr>
                                    );
                                })}
                                {hasCategoryFilter &&
                                budgetDisplayRows.length === 0 ? (
                                    <tr>
                                        <td
                                            colSpan={5}
                                            className="px-4 py-8 text-center text-sm text-[var(--color-muted)]"
                                        >
                                            No budget categories match this filter.
                                        </td>
                                    </tr>
                                ) : null}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <div className="h-32" aria-hidden="true" />
                )}
            </form>

            {isAllocationDetailsOpen ? (
                <AllocationDetailsModal
                    allocationDifferenceCents={allocationDifferenceCents}
                    isResetConfirmationOpen={isResetConfirmationOpen}
                    onClose={closeAllocationDetails}
                    onRequestReset={() => setIsResetConfirmationOpen(true)}
                    onReset={resetMonthAssignments}
                    onResetCancel={() => setIsResetConfirmationOpen(false)}
                    periodId={summary.periodId}
                    rows={allocationDetailRows}
                    savedAllocationCount={periodAllocationRecords.length}
                    savedFundingSourceCount={periodFundingSourceRecords.length}
                />
            ) : null}

            {activityDetailsCategory && activityDetailsView ? (
                <ActivityDetailsModal
                    categoryName={activityDetailsCategory.name}
                    events={buildActivityDetailsEvents({
                        category: activityDetailsCategory,
                        periodId: summary.periodId,
                        transactionEvents: activityDetailsView.events,
                    })}
                    onClose={() => setActivityDetailsCategoryId(null)}
                    periodId={summary.periodId}
                />
            ) : null}

        </div>
    );
}

function ActivityDetailsModal({
    categoryName,
    events,
    onClose,
    periodId,
}: {
    categoryName: string;
    events: ReturnType<typeof buildCategoryDetailReportView>["events"];
    onClose: () => void;
    periodId: string;
}) {
    return (
        <div className="fixed inset-0 z-50 grid place-items-center bg-[rgba(7,16,27,0.78)] p-4">
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="activity-details-title"
                className={`max-h-[calc(100vh-2rem)] w-full max-w-5xl overflow-y-auto overscroll-contain p-6 ${surfaceClassNames.panel}`}
            >
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <p className={typographyClassNames.eyebrow}>
                            {categoryName} - {periodId}
                        </p>
                        <h2
                            id="activity-details-title"
                            className="mt-2 text-2xl font-semibold tracking-tight"
                        >
                            Activity details
                        </h2>
                    </div>
                    <DialogCloseButton
                        onClick={onClose}
                        aria-label="Close activity details dialog"
                    />
                </div>

                <div className="mt-6">
                    <CategoryActivityReportTable
                        emptyMessage="No transactions are included in this month's activity."
                        events={events}
                    />
                </div>
            </div>
        </div>
    );
}

function AllocationDetailsModal({
    allocationDifferenceCents,
    isResetConfirmationOpen,
    onClose,
    onRequestReset,
    onReset,
    onResetCancel,
    periodId,
    rows,
    savedAllocationCount,
    savedFundingSourceCount,
}: {
    allocationDifferenceCents: number;
    isResetConfirmationOpen: boolean;
    onClose: () => void;
    onRequestReset: () => void;
    onReset: () => void;
    onResetCancel: () => void;
    periodId: string;
    rows: AllocationDetailRow[];
    savedAllocationCount: number;
    savedFundingSourceCount: number;
}) {
    const rowGroups = groupAllocationDetailRows(rows);

    return (
        <div className="fixed inset-0 z-50 grid place-items-center bg-[rgba(7,16,27,0.78)] p-4">
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="allocation-details-title"
                className={`max-h-[calc(100vh-2rem)] w-full max-w-3xl overflow-y-auto overscroll-contain p-6 ${surfaceClassNames.panel}`}
            >
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <p className={typographyClassNames.eyebrow}>
                            {periodId}
                        </p>
                        <h2
                            id="allocation-details-title"
                            className="mt-2 text-2xl font-semibold tracking-tight"
                        >
                            Allocation details
                        </h2>
                    </div>
                    <DialogCloseButton
                        onClick={onClose}
                        aria-label="Close allocation details dialog"
                    />
                </div>

                <div className="mt-6 overflow-x-auto">
                    {rows.length > 0 ? (
                        <table className="min-w-full border-collapse text-left text-sm">
                            <thead>
                                <tr className="border-b border-[var(--color-border)] text-[var(--color-muted)]">
                                    <th className="px-4 py-2.5 font-medium">
                                        Detail
                                    </th>
                                    <th className="px-4 py-2.5 text-right font-medium">
                                        Amount
                                    </th>
                                </tr>
                            </thead>
                            {rowGroups.map((group) => (
                                <tbody key={group.label}>
                                    <tr>
                                        <th
                                            scope="rowgroup"
                                            colSpan={2}
                                            className="border-b border-[var(--color-border)]/70 bg-[var(--color-panel-strong)] px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-muted)]"
                                        >
                                            {group.label}
                                        </th>
                                    </tr>
                                    {group.rows.map((row) => (
                                        <tr
                                            key={row.id}
                                            className="border-b border-[var(--color-border)]/70 last:border-b-0"
                                        >
                                            <td className="px-4 py-2 align-top font-medium text-[var(--color-ink)]">
                                                {row.label}
                                            </td>
                                            <td className="px-4 py-2 text-right align-top font-semibold">
                                                <MoneyAmount
                                                    cents={row.amountCents}
                                                />
                                            </td>
                                        </tr>
                                    ))}
                                    <tr className="border-y border-[var(--tone-info-border)]/45 bg-[var(--tone-info-surface)]/35">
                                        <td className="px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--tone-info-ink)]">
                                            {group.label} subtotal
                                        </td>
                                        <td className="px-4 py-2 text-right text-sm font-semibold text-[var(--color-ink)]">
                                            <MoneyAmount
                                                cents={group.rows.reduce(
                                                    (total, row) =>
                                                        total +
                                                        row.amountCents,
                                                    0,
                                                )}
                                            />
                                        </td>
                                    </tr>
                                </tbody>
                            ))}
                            <tfoot>
                                <tr className="border-t-2 border-[var(--color-border-strong)] bg-[var(--color-panel-strong)]">
                                    <td className="px-4 py-3 text-sm font-semibold text-[var(--color-ink)]">
                                        Allocation amount leftover
                                    </td>
                                    <td className="px-4 py-3 text-right text-sm font-semibold">
                                        <MoneyAmount
                                            cents={allocationDifferenceCents}
                                        />
                                    </td>
                                </tr>
                            </tfoot>
                        </table>
                    ) : (
                        <p
                            className={`text-sm ${typographyClassNames.mutedBody}`}
                        >
                            No non-zero allocation movements are saved for this
                            month.
                        </p>
                    )}
                </div>

                <div className="mt-4 text-xs text-[var(--color-muted)]">
                    {savedAllocationCount} allocation records,{" "}
                    {savedFundingSourceCount} source records
                </div>

                <div className="mt-6 border-t border-[var(--color-border)] pt-4">
                    {isResetConfirmationOpen ? (
                        <div className="grid gap-4">
                            <p className="text-sm text-[var(--tone-warning-ink)]">
                                Reset saved assignments for {periodId}?
                            </p>
                            <div className="flex flex-wrap justify-end gap-3">
                                <button
                                    type="button"
                                    onClick={onResetCancel}
                                    className={
                                        controlClassNames.secondaryAction
                                    }
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    onClick={onReset}
                                    className={resetAssignmentsActionClassName}
                                >
                                    Reset month assignments
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="flex flex-wrap justify-end gap-3">
                            <button
                                type="button"
                                onClick={onRequestReset}
                                className={resetAssignmentsActionClassName}
                            >
                                Reset month assignments
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
