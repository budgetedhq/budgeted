import { calculateAccountBalanceCents } from "@/modules/ledger/account-balance";
import { toVisibleReferenceCategoryId } from "@/features/transactions/models/reference-category";
import {
    calculateWorkspaceEntityCounts,
    calculateWorkspaceEntityDigests,
} from "@/lib/workspace/revision";
import {
    WORKSPACE_ENTITY_CONFIGS,
    getWorkspaceEntityArrayKey,
    getWorkspaceEntityId,
} from "@/lib/workspace/entity-config";
import { assertValidWorkspaceRecordTransition } from "@/lib/workspace/change-transition";
import { groupBy } from "@/lib/collections";
import type {
    WorkspaceChange,
    WorkspaceEntityType,
    WorkspaceKnowledge,
    WorkspaceRecordChange,
    WorkspaceSnapshot,
    WorkspaceSnapshotPayload,
    WorkspaceSnapshotRecords,
} from "@/lib/workspace/sync-types";

type WorkspaceTransactionRecord =
    WorkspaceSnapshotPayload["transactions"][number];
type WorkspaceTransactionLineRecord =
    WorkspaceSnapshot["transactionLines"][number];
type WorkspaceBudgetPeriodRecord = WorkspaceSnapshot["budgetPeriods"][number];
type WorkspaceCategoryAllocationRecord =
    WorkspaceSnapshot["budgetAllocations"][number];
type LedgerScopedWorkspaceSnapshotRecords = Omit<
    WorkspaceSnapshotRecords,
    "ledgers"
>;

export function createEmptyWorkspaceSnapshotRecords(): WorkspaceSnapshotRecords {
    return Object.fromEntries(
        WORKSPACE_ENTITY_CONFIGS.map((config) => [config.arrayKey, []]),
    ) as unknown as WorkspaceSnapshotRecords;
}

const HIDDEN_TRANSACTION_LINE_CATEGORY_IDS = new Set(["__no_category__"]);
const HIDDEN_TRANSACTION_LINE_ACCOUNT_IDS = new Set([
    "__no_from_account__",
    "__no_to_account__",
]);

function compareWorkspaceRecords(
    entityType: WorkspaceEntityType,
    left: unknown,
    right: unknown,
) {
    return getWorkspaceEntityId(entityType, left).localeCompare(
        getWorkspaceEntityId(entityType, right),
    );
}

export function toWorkspaceSnapshotRecords(
    snapshot:
        | WorkspaceSnapshot
        | WorkspaceSnapshotPayload
        | WorkspaceSnapshotRecords,
): WorkspaceSnapshotRecords {
    return Object.fromEntries(
        WORKSPACE_ENTITY_CONFIGS.map((config) => [
            config.arrayKey,
            (snapshot[config.arrayKey] ?? []).map((record) =>
                config.entityType === "transaction"
                    ? stripTransactionChildren(record)
                    : record,
            ),
        ]),
    ) as WorkspaceSnapshotRecords;
}

function stripTransactionChildren(record: unknown) {
    if (!record || typeof record !== "object") {
        return record;
    }

    const transaction = { ...(record as Record<string, unknown>) };
    delete transaction.lines;
    delete transaction.postings;
    delete transaction.importActivities;

    return transaction;
}

function normalizeTransactionRecord(
    transaction: WorkspaceTransactionRecord,
): WorkspaceTransactionRecord {
    const nextTransaction = { ...transaction };
    const referenceCategoryId = toVisibleReferenceCategoryId(
        transaction.referenceCategoryId,
    );

    if (referenceCategoryId) {
        nextTransaction.referenceCategoryId = referenceCategoryId;
    } else {
        delete nextTransaction.referenceCategoryId;
    }

    return nextTransaction;
}

function normalizeBudgetPeriodRecord(
    period: WorkspaceBudgetPeriodRecord,
): WorkspaceBudgetPeriodRecord {
    const nextPeriod = { ...period };

    delete nextPeriod.availableToBudgetCents;

    return nextPeriod;
}

function normalizeCategoryAllocationRecord(
    allocation: WorkspaceCategoryAllocationRecord,
): WorkspaceCategoryAllocationRecord {
    return { ...allocation };
}

function normalizeTransactionLineCategoryId(value: string | undefined) {
    return value && !HIDDEN_TRANSACTION_LINE_CATEGORY_IDS.has(value)
        ? value
        : undefined;
}

function normalizeTransactionLineAccountId(value: string | undefined) {
    return value && !HIDDEN_TRANSACTION_LINE_ACCOUNT_IDS.has(value)
        ? value
        : undefined;
}

function normalizeTransactionLineRecord(
    line: WorkspaceTransactionLineRecord,
): WorkspaceTransactionLineRecord {
    const nextLine = { ...line };
    const categoryId = normalizeTransactionLineCategoryId(line.categoryId);
    const fromAccountId = normalizeTransactionLineAccountId(line.fromAccountId);
    const toAccountId = normalizeTransactionLineAccountId(line.toAccountId);

    if (categoryId) {
        nextLine.categoryId = categoryId;
    } else {
        delete nextLine.categoryId;
    }

    if (fromAccountId) {
        nextLine.fromAccountId = fromAccountId;
    } else {
        delete nextLine.fromAccountId;
    }

    if (toAccountId) {
        nextLine.toAccountId = toAccountId;
    } else {
        delete nextLine.toAccountId;
    }

    return nextLine;
}

export function createWorkspaceKnowledgeFromSnapshot(input: {
    changeCursor: string;
    entityRevisions?: WorkspaceKnowledge["entityRevisions"];
    generatedAt: string;
    retainedChangesAfter: string;
    snapshot: WorkspaceSnapshot;
    workspaceGeneration?: number;
    workspaceRevision?: number;
}): WorkspaceKnowledge {
    const records = toWorkspaceSnapshotRecords(input.snapshot);

    return {
        activeLedgerId: input.snapshot.activeLedgerId,
        applicationReleaseTag:
            input.snapshot.knowledge.applicationReleaseTag,
        applicationVersion: input.snapshot.knowledge.applicationVersion,
        changeCursor: input.changeCursor,
        entityCounts: calculateWorkspaceEntityCounts(records),
        entityDigests: calculateWorkspaceEntityDigests(records),
        entityRevisions:
            input.entityRevisions ?? input.snapshot.knowledge.entityRevisions,
        generatedAt: input.generatedAt,
        oldestRetainedWorkspaceRevision:
            input.snapshot.knowledge.oldestRetainedWorkspaceRevision,
        retainedChangesAfter: input.retainedChangesAfter,
        revision: input.changeCursor,
        workspaceGeneration:
            input.workspaceGeneration ??
            input.snapshot.knowledge.workspaceGeneration ??
            1,
        workspaceRevision:
            input.workspaceRevision ?? input.snapshot.knowledge.workspaceRevision,
    };
}

export function rebuildWorkspaceSnapshot(
    snapshot: WorkspaceSnapshot | WorkspaceSnapshotPayload,
    options: { deriveAccountBalances?: boolean } = {},
): WorkspaceSnapshot {
    const ledgerPostings = [...snapshot.ledgerPostings].sort((left, right) =>
        left.postingId.localeCompare(right.postingId),
    );
    const lines = snapshot.transactionLines
        .map(normalizeTransactionLineRecord)
        .sort((left, right) => {
            if (left.sortOrder !== right.sortOrder) {
                return left.sortOrder - right.sortOrder;
            }

            return left.lineId.localeCompare(right.lineId);
        });
    const postingsByTransactionId = groupBy(
        ledgerPostings,
        (posting) => posting.transactionId,
    );
    const linesByTransactionId = groupBy(
        lines,
        (line) => line.transactionId,
    );
    const importActivitiesByTransactionId = groupBy(
        snapshot.transactionImportActivities ?? [],
        (activity) => activity.linkedTransactionId ?? "",
    );

    const accounts = snapshot.accounts
        .map((account) => ({
            ...account,
            balanceCents:
                options.deriveAccountBalances === false
                    ? account.balanceCents
                    : calculateAccountBalanceCents(account, ledgerPostings),
        }))
        .sort((left, right) => left.accountId.localeCompare(right.accountId));
    const transactions = snapshot.transactions
        .map((transaction) => {
            const normalizedTransaction =
                normalizeTransactionRecord(transaction);

            const transactionLines =
                linesByTransactionId.get(normalizedTransaction.transactionId) ?? [];
            const transactionPostings =
                postingsByTransactionId.get(normalizedTransaction.transactionId) ?? [];
            return {
                ...normalizedTransaction,
                importActivities:
                    importActivitiesByTransactionId.get(
                        normalizedTransaction.transactionId,
                    ) ?? [],
                lines: transactionLines,
                postings: transactionPostings,
            };
        })
        .sort((left, right) =>
            left.transactionId.localeCompare(right.transactionId),
        );
    const activeLedger = snapshot.ledgers.find(
        (ledger) => ledger.ledgerId === snapshot.activeLedgerId,
    );

    return {
        ...snapshot,
        accounts,
        activeLedgerName:
            activeLedger?.name ?? snapshot.activeLedgerName ?? "Ledger",
        allocationFundingSources: [
            ...snapshot.allocationFundingSources,
        ].sort((left, right) =>
            left.fundingSourceId.localeCompare(right.fundingSourceId),
        ),
        amazonOrderIntegrations: [
            ...(snapshot.amazonOrderIntegrations ?? []),
        ].sort(
            (left, right) =>
                left.integrationId.localeCompare(right.integrationId),
        ),
        amazonOrderSyncRuns: [...(snapshot.amazonOrderSyncRuns ?? [])].sort(
            (left, right) => left.syncRunId.localeCompare(right.syncRunId),
        ),
        amazonOrders: [...(snapshot.amazonOrders ?? [])].sort((left, right) =>
            left.amazonOrderId.localeCompare(right.amazonOrderId),
        ),
        budgetAllocations: [...snapshot.budgetAllocations]
            .map(normalizeCategoryAllocationRecord)
            .sort((left, right) =>
                left.allocationId.localeCompare(right.allocationId),
            ),
        budgetCategories: [...snapshot.budgetCategories].sort((left, right) =>
            left.categoryId.localeCompare(right.categoryId),
        ),
        budgetGroups: [...snapshot.budgetGroups].sort((left, right) =>
            left.groupId.localeCompare(right.groupId),
        ),
        budgetPeriods: [...snapshot.budgetPeriods]
            .map(normalizeBudgetPeriodRecord)
            .sort((left, right) => left.periodId.localeCompare(right.periodId)),
        ledgerPostings,
        ledgers: [...snapshot.ledgers].sort((left, right) =>
            left.ledgerId.localeCompare(right.ledgerId),
        ),
        plaidAccountLinks: [...snapshot.plaidAccountLinks].sort((left, right) =>
            left.plaidAccountLinkId.localeCompare(right.plaidAccountLinkId),
        ),
        plaidTransactionSyncs: [...snapshot.plaidTransactionSyncs].sort(
            (left, right) =>
                left.plaidTransactionSyncId.localeCompare(
                    right.plaidTransactionSyncId,
                ),
        ),
        transactionAutoMatchRejections: [
            ...(snapshot.transactionAutoMatchRejections ?? []),
        ].sort((left, right) =>
            left.matchDecisionId.localeCompare(right.matchDecisionId),
        ),
        transactionTemplates: [...(snapshot.transactionTemplates ?? [])].sort(
            (left, right) => left.templateId.localeCompare(right.templateId),
        ),
        transactionImportActivities: [
            ...(snapshot.transactionImportActivities ?? []),
        ].sort((left, right) => left.activityId.localeCompare(right.activityId)),
        transactionLines: lines,
        transactions,
        venmoAccountMappings: [...(snapshot.venmoAccountMappings ?? [])].sort(
            (left, right) => left.mappingId.localeCompare(right.mappingId),
        ),
        venmoIntegrations: [...(snapshot.venmoIntegrations ?? [])].sort(
            (left, right) => left.integrationId.localeCompare(right.integrationId),
        ),
    } as WorkspaceSnapshot;
}

export function rebuildWorkspaceSnapshotRecords(
    snapshot: WorkspaceSnapshot | WorkspaceSnapshotPayload,
) {
    return toWorkspaceSnapshotRecords(rebuildWorkspaceSnapshot(snapshot));
}

export function toLedgerScopedWorkspaceSnapshotRecords(
    records: WorkspaceSnapshotRecords,
): LedgerScopedWorkspaceSnapshotRecords {
    return Object.fromEntries(
        WORKSPACE_ENTITY_CONFIGS.filter(
            (config) => config.arrayKey !== "ledgers",
        ).map((config) => [config.arrayKey, records[config.arrayKey]]),
    ) as LedgerScopedWorkspaceSnapshotRecords;
}

export function rebuildLedgerScopedWorkspaceSnapshotRecords(
    snapshot: WorkspaceSnapshot | WorkspaceSnapshotPayload,
) {
    return toLedgerScopedWorkspaceSnapshotRecords(
        rebuildWorkspaceSnapshotRecords(snapshot),
    );
}

function applyChangeToArray(
    records: unknown[],
    change: WorkspaceRecordChange,
): unknown[] {
    if (change.operation === "delete") {
        return records.filter(
            (record) =>
                getWorkspaceEntityId(change.entityType, record) !==
                change.entityId,
        );
    }

    if (!change.record) {
        return records;
    }

    const nextRecords = records.filter(
        (record) =>
            getWorkspaceEntityId(change.entityType, record) !== change.entityId,
    );

    return [...nextRecords, change.record].sort((left, right) =>
        compareWorkspaceRecords(change.entityType, left, right),
    );
}

export function applyWorkspaceChanges(
    snapshot: WorkspaceSnapshot,
    changes: WorkspaceRecordChange[],
    options: {
        deriveAccountBalances?: boolean;
        validateTransitions?: boolean;
    } = {},
) {
    let nextSnapshot = { ...snapshot };

    for (const change of changes) {
        const arrayKey = getWorkspaceEntityArrayKey(change.entityType);
        const currentRecord = (nextSnapshot[arrayKey] ?? []).find(
            (record) =>
                getWorkspaceEntityId(change.entityType, record) ===
                change.entityId,
        );

        if (options.validateTransitions !== false) {
            assertValidWorkspaceRecordTransition({
                change: change as WorkspaceChange,
                currentRecord,
            });
        }

        nextSnapshot = {
            ...nextSnapshot,
            [arrayKey]: applyChangeToArray(
                nextSnapshot[arrayKey] ?? [],
                change,
            ) as never,
        };
    }

    return rebuildWorkspaceSnapshot(nextSnapshot, options);
}

export function isKnowledgeTooOldForDelta(
    localKnowledge: WorkspaceKnowledge,
    serverKnowledge: WorkspaceKnowledge,
) {
    if (
        localKnowledge.workspaceRevision !== undefined &&
        serverKnowledge.oldestRetainedWorkspaceRevision !== undefined
    ) {
        return (
            localKnowledge.workspaceRevision <
            serverKnowledge.oldestRetainedWorkspaceRevision
        );
    }

    return (
        new Date(localKnowledge.generatedAt).getTime() <
        new Date(serverKnowledge.retainedChangesAfter).getTime()
    );
}
