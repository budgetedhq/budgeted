import { monotonicFactory, ulid } from "ulid";

import { findUserAccountById } from "@/lib/auth/user-account";
import {
    HttpError,
    WORKSPACE_MUTATION_IN_PROGRESS_ERROR_CODE,
    WORKSPACE_MUTATION_RETRY_AFTER_MS,
} from "@/lib/api/errors";
import { queryAllPages } from "@/lib/db/query-all-pages";
import { getBudgetedSchema } from "@/lib/db/schema";
import {
    WORKSPACE_CHANGE_RETENTION_DAYS,
    hasCompleteWorkspaceBatchManifest,
    type WorkspaceChange,
    type WorkspaceAccountRecord,
    type WorkspaceAllocationFundingSourceRecord,
    type WorkspaceAmazonOrderIntegrationRecord,
    type WorkspaceAmazonOrderRecord,
    type WorkspaceAmazonOrderSyncRunRecord,
    type WorkspaceBudgetCategoryRecord,
    type WorkspaceBudgetGroupRecord,
    type WorkspaceBudgetPeriodRecord,
    type WorkspaceCategoryAllocationRecord,
    type WorkspaceEntityType,
    type WorkspaceKnowledge,
    type WorkspaceLedgerRecord,
    type WorkspaceLedgerPostingRecord,
    type WorkspacePlaidAccountLinkRecord,
    type WorkspacePlaidTransactionSyncRecord,
    type WorkspaceSnapshot,
    type WorkspaceSnapshotPayload,
    type WorkspaceSnapshotRecords,
    type WorkspaceSyncResult,
    type WorkspaceCommitSyncResult,
    type WorkspaceVersionResult,
    type WorkspaceTransactionTemplateRecord,
    type WorkspaceTransactionAutoMatchRejectionRecord,
    type WorkspaceVenmoAccountMappingRecord,
    type WorkspaceVenmoIntegrationRecord,
} from "@/lib/workspace/sync-types";
import { WORKSPACE_SYNC_PROTOCOL_VERSION } from "@/lib/workspace/sync-types";
import {
    createWorkspaceCommits,
    parseWorkspaceVersionCursor,
    workspaceKnowledgeToVersion,
} from "@/lib/workspace/sync-v2";
import { APPLICATION_VERSION } from "@/lib/application-version";
import {
    calculateWorkspaceEntityCounts,
    calculateWorkspaceEntityDigestAccumulators,
    calculateWorkspaceEntityDigests,
    calculateWorkspaceRecordDigest,
    createWorkspaceEntityDigest,
    createWorkspaceEntityRevisionTokens,
    createEmptyWorkspaceEntityCounts,
    stableStringify,
    xorWorkspaceEntityDigestAccumulator,
} from "@/lib/workspace/revision";
import {
    rebuildLedgerScopedWorkspaceSnapshotRecords,
    rebuildWorkspaceSnapshotRecords,
} from "@/lib/workspace/snapshot-utils";
import {
    WORKSPACE_ENTITY_TYPES,
    createWorkspaceRecordReferences,
    getWorkspaceEntityArrayKey,
} from "@/lib/workspace/entity-config";
import {
    encodeWorkspaceCursor,
    parseWorkspaceCursor,
    toWorkspaceRevisionKey,
} from "@/lib/workspace/cursor";
import { GLOBAL_WORKSPACE_ID } from "@/lib/workspace/scope";
import { normalizeWorkspaceDigestRecord } from "@/lib/workspace/record-normalization";
import { WORKSPACE_STATE_ID } from "@/lib/db/entities/workspace-state.entity";
import {
    assertWorkspaceTransactionCommitted,
    isWorkspaceRevisionConflict,
} from "@/features/workspace/server/workspace-transaction-conflict";
import {
    compareWorkspaceChangesInCommitOrder,
    hasContiguousWorkspaceRevisions,
} from "@/lib/workspace/workspace-protocol";
import { withCanonicalTransactionAggregateMetadata } from "@/features/transactions/models/transaction-aggregate-revision";

export { hasContiguousWorkspaceRevisions } from "@/lib/workspace/workspace-protocol";

type CurrentWorkspaceUser = {
    activeLedgerId: string;
    activeLedgerName: string;
    userId: string;
};

type TrackedWorkspaceRecord = {
    entityId: string;
    entityType: WorkspaceEntityType;
    record: unknown;
};

type WorkspaceMutationResult<T> = {
    changes: WorkspaceChange[];
    knowledge: WorkspaceKnowledge;
    result: T;
};

export type WorkspaceMutationChangeInput = Pick<
    WorkspaceChange,
    | "entityId"
    | "entityType"
    | "operation"
    | "previousRecordDigest"
    | "record"
>;

type StoredWorkspaceState = {
    createdAt: string;
    entityDigestAccumulators?: Record<WorkspaceEntityType, string>;
    entityDigests?: WorkspaceKnowledge["entityDigests"];
    entityCounts: WorkspaceKnowledge["entityCounts"];
    entityRevisions: NonNullable<WorkspaceKnowledge["entityRevisions"]>;
    ledgerId: string;
    oldestRetainedWorkspaceRevision: number;
    updatedAt: string;
    workspaceGeneration: number;
    workspaceRevision: number;
};

export type WorkspaceStateUpdate = {
    createdAt: string;
    entityDigestAccumulators: Record<WorkspaceEntityType, string>;
    entityDigestAccumulatorsJson: string;
    entityDigests: NonNullable<WorkspaceKnowledge["entityDigests"]>;
    entityDigestsJson: string;
    entityCounts: WorkspaceKnowledge["entityCounts"];
    entityCountsJson: string;
    entityRevisions: NonNullable<WorkspaceKnowledge["entityRevisions"]>;
    entityRevisionsJson: string;
    ledgerId: string;
    oldestRetainedWorkspaceRevision: number;
    stateId: string;
    updatedAt: string;
    workspaceGeneration: number;
    workspaceId: string;
    workspaceRevision: number;
};

const CHANGE_RETENTION_MS =
    WORKSPACE_CHANGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const EXPLICIT_MUTATION_FENCE_ID = "workspace.explicit-mutation";
const EXPLICIT_MUTATION_FENCE_STALE_MS = 2 * 60 * 1000;
// Leave headroom for DynamoDB attribute and index overhead beneath its 400 KB limit.
const MAX_WORKSPACE_MUTATION_JSON_BYTES = 350_000;
const nextWorkspaceChangeId = monotonicFactory();

export type WorkspaceMutationBatch = {
    batchId: string;
    changeCursor: string;
    changeCount: number;
    changes: WorkspaceChange[];
    createdAt: string;
    expiresAt: number;
    ledgerId: string;
    mutationId: string;
    mutationType: string;
    response: unknown;
    expectedWorkspaceGeneration?: number;
    expectedWorkspaceRevision?: number;
    workspaceGeneration: number;
    workspaceRevision: number;
};

export type WorkspaceMutationOperation = {
    completedStepCount: number;
    createdAt: string;
    expiresAt: number;
    ledgerId: string;
    mutationId: string;
    mutationType: string;
    operation: unknown;
    status: "completed" | "failed" | "running";
    updatedAt: string;
};

export function getRetainedChangesAfter(now = new Date()) {
    return new Date(now.getTime() - CHANGE_RETENTION_MS).toISOString();
}

export function getWorkspaceChangeExpiresAt(now = new Date()) {
    return Math.floor((now.getTime() + CHANGE_RETENTION_MS) / 1000);
}

function sortByStringKey<T>(records: T[], getKey: (record: T) => string) {
    return [...records].sort((left, right) =>
        getKey(left).localeCompare(getKey(right)),
    );
}

async function listWorkspaceLedgers() {
    const { entities } = getBudgetedSchema();
    const ledgers = await queryAllPages(
        entities.ledgers.query.byLedger({ workspaceId: GLOBAL_WORKSPACE_ID }),
        { consistent: true },
    );

    return sortByStringKey(
        ledgers.map((record) => {
            return {
                createdAt: record.createdAt,
                isDefault: record.isDefault,
                ledgerId: record.ledgerId,
                name: record.name,
                status: record.status,
                updatedAt: record.updatedAt,
                workspaceId: record.workspaceId,
            } satisfies WorkspaceLedgerRecord;
        }),
        (ledger) => ledger.ledgerId,
    );
}

async function getWorkspaceLedger(ledgerId: string) {
    const { entities } = getBudgetedSchema();
    const result = await entities.ledgers
        .get({ workspaceId: GLOBAL_WORKSPACE_ID, ledgerId })
        .go({ consistent: true });
    const record = result.data;

    if (!record) {
        return null;
    }

    return {
        createdAt: record.createdAt,
        isDefault: record.isDefault,
        ledgerId: record.ledgerId,
        name: record.name,
        status: record.status,
        updatedAt: record.updatedAt,
        workspaceId: record.workspaceId,
    } satisfies WorkspaceLedgerRecord;
}

type LedgerScopedWorkspaceRecords = Omit<WorkspaceSnapshotRecords, "ledgers">;

async function listLedgerScopedRecords(input: {
    ledgerId: string;
}): Promise<LedgerScopedWorkspaceRecords> {
    const { entities } = getBudgetedSchema();
    const [
        accountsResult,
        groupsResult,
        categoriesResult,
        periodsResult,
        allocationsResult,
        fundingSourcesResult,
        amazonOrderIntegrationsResult,
        amazonOrdersResult,
        amazonOrderSyncRunsResult,
        plaidAccountLinksResult,
        plaidTransactionSyncsResult,
        transactionTemplatesResult,
        transactionAutoMatchRejectionsResult,
        transactionsResult,
        transactionImportActivitiesResult,
        linesResult,
        postingsResult,
        venmoAccountMappingsResult,
        venmoIntegrationsResult,
    ] = await Promise.all([
        queryAllPages(
            entities.accounts.query.byAccount({ ledgerId: input.ledgerId }),
            { consistent: true },
        ),
        queryAllPages(
            entities.budgetGroups.query.byGroup({ ledgerId: input.ledgerId }),
            { consistent: true },
        ),
        queryAllPages(
            entities.budgetCategories.query.byCategory({
                ledgerId: input.ledgerId,
            }),
            { consistent: true },
        ),
        queryAllPages(
            entities.budgetPeriods.query.byPeriod({
                ledgerId: input.ledgerId,
            }),
            { consistent: true },
        ),
        queryAllPages(
            entities.categoryAllocations.query.byAllocation({
                ledgerId: input.ledgerId,
            }),
            { consistent: true },
        ),
        queryAllPages(
            entities.allocationFundingSources.query.byFundingSource({
                ledgerId: input.ledgerId,
            }),
            { consistent: true },
        ),
        queryAllPages(
            entities.amazonOrderIntegrations.query.byIntegration({
                ledgerId: input.ledgerId,
            }),
            { consistent: true },
        ),
        queryAllPages(
            entities.amazonOrders.query.byOrder({
                ledgerId: input.ledgerId,
            }),
            { consistent: true },
        ),
        queryAllPages(
            entities.amazonOrderSyncRuns.query.bySyncRun({
                ledgerId: input.ledgerId,
            }),
            { consistent: true },
        ),
        queryAllPages(
            entities.plaidAccountLinks.query.byLink({
                ledgerId: input.ledgerId,
            }),
            { consistent: true },
        ),
        queryAllPages(
            entities.plaidTransactionSyncs.query.bySync({
                ledgerId: input.ledgerId,
            }),
            { consistent: true },
        ),
        queryAllPages(
            entities.transactionTemplates.query.byTemplate({
                ledgerId: input.ledgerId,
            }),
            { consistent: true },
        ),
        queryAllPages(
            entities.transactionAutoMatchRejections.query.byRejection({
                ledgerId: input.ledgerId,
            }),
            { consistent: true },
        ),
        queryAllPages(
            entities.transactions.query.byTransaction({
                ledgerId: input.ledgerId,
            }),
            { consistent: true },
        ),
        queryAllPages(
            entities.transactionImportActivities.query.byActivity({
                ledgerId: input.ledgerId,
            }),
            { consistent: true },
        ),
        queryAllPages(
            entities.transactionLines.query.byLine({
                ledgerId: input.ledgerId,
            }),
            { consistent: true },
        ),
        queryAllPages(
            entities.ledgerPostings.query.byPosting({
                ledgerId: input.ledgerId,
            }),
            { consistent: true },
        ),
        queryAllPages(
            entities.venmoAccountMappings.query.byMapping({ ledgerId: input.ledgerId }),
            { consistent: true },
        ),
        queryAllPages(
            entities.venmoIntegrations.query.byIntegration({ ledgerId: input.ledgerId }),
            { consistent: true },
        ),
    ]);
    return rebuildLedgerScopedWorkspaceSnapshotRecords({
        accounts: accountsResult as WorkspaceAccountRecord[],
        activeLedgerId: input.ledgerId,
        activeLedgerName: "Ledger",
        allocationFundingSources:
            fundingSourcesResult as WorkspaceAllocationFundingSourceRecord[],
        amazonOrderIntegrations:
            amazonOrderIntegrationsResult as WorkspaceAmazonOrderIntegrationRecord[],
        amazonOrderSyncRuns:
            amazonOrderSyncRunsResult as WorkspaceAmazonOrderSyncRunRecord[],
        amazonOrders: amazonOrdersResult as WorkspaceAmazonOrderRecord[],
        budgetAllocations:
            allocationsResult as WorkspaceCategoryAllocationRecord[],
        budgetCategories: categoriesResult as WorkspaceBudgetCategoryRecord[],
        budgetGroups: groupsResult as WorkspaceBudgetGroupRecord[],
        budgetPeriods: periodsResult as WorkspaceBudgetPeriodRecord[],
        knowledge: undefined as never,
        ledgerPostings: postingsResult as WorkspaceLedgerPostingRecord[],
        ledgers: [],
        plaidAccountLinks:
            plaidAccountLinksResult as WorkspacePlaidAccountLinkRecord[],
        plaidTransactionSyncs:
            plaidTransactionSyncsResult as WorkspacePlaidTransactionSyncRecord[],
        transactionTemplates:
            transactionTemplatesResult as WorkspaceTransactionTemplateRecord[],
        transactionAutoMatchRejections:
            transactionAutoMatchRejectionsResult as WorkspaceTransactionAutoMatchRejectionRecord[],
        transactionImportActivities:
            transactionImportActivitiesResult as WorkspaceSnapshotRecords["transactionImportActivities"],
        transactionLines:
            linesResult as WorkspaceSnapshotRecords["transactionLines"],
        transactions: withCanonicalTransactionAggregateMetadata({
            ledgerPostings:
                postingsResult as WorkspaceSnapshotRecords["ledgerPostings"],
            plaidTransactionSyncs:
                plaidTransactionSyncsResult as WorkspaceSnapshotRecords["plaidTransactionSyncs"],
            transactionLines:
                linesResult as WorkspaceSnapshotRecords["transactionLines"],
            transactions:
                transactionsResult as WorkspaceSnapshotRecords["transactions"],
        }),
        venmoAccountMappings: venmoAccountMappingsResult as WorkspaceVenmoAccountMappingRecord[],
        venmoIntegrations: venmoIntegrationsResult as WorkspaceVenmoIntegrationRecord[],
    } as unknown as WorkspaceSnapshot);
}

async function listWorkspaceRevisionRecords<TRecord>(
    query: {
        go: (options?: Record<string, unknown>) => Promise<{ data: TRecord[] }>;
    },
    idKey: string,
) {
    void idKey;
    return queryAllPages(query, { consistent: true });
}

async function listWorkspaceRevisionRecordsForLedger(input: {
    activeLedgerId: string;
}): Promise<WorkspaceSnapshotRecords> {
    const { entities } = getBudgetedSchema();
    const [
        ledgers,
        accounts,
        groups,
        categories,
        periods,
        allocations,
        fundingSources,
        amazonOrderIntegrations,
        amazonOrders,
        amazonOrderSyncRuns,
        plaidAccountLinks,
        plaidTransactionSyncs,
        transactionTemplates,
        transactionAutoMatchRejections,
        transactions,
        transactionImportActivities,
        lines,
        postings,
        venmoAccountMappings,
        venmoIntegrations,
    ] = await Promise.all([
        getWorkspaceLedger(input.activeLedgerId).then((ledger) =>
            ledger ? [ledger] : [],
        ),
        listWorkspaceRevisionRecords(
            entities.accounts.query.byAccount({ ledgerId: input.activeLedgerId }),
            "accountId",
        ),
        listWorkspaceRevisionRecords(
            entities.budgetGroups.query.byGroup({
                ledgerId: input.activeLedgerId,
            }),
            "groupId",
        ),
        listWorkspaceRevisionRecords(
            entities.budgetCategories.query.byCategory({
                ledgerId: input.activeLedgerId,
            }),
            "categoryId",
        ),
        listWorkspaceRevisionRecords(
            entities.budgetPeriods.query.byPeriod({
                ledgerId: input.activeLedgerId,
            }),
            "periodId",
        ),
        listWorkspaceRevisionRecords(
            entities.categoryAllocations.query.byAllocation({
                ledgerId: input.activeLedgerId,
            }),
            "allocationId",
        ),
        listWorkspaceRevisionRecords(
            entities.allocationFundingSources.query.byFundingSource({
                ledgerId: input.activeLedgerId,
            }),
            "fundingSourceId",
        ),
        listWorkspaceRevisionRecords(
            entities.amazonOrderIntegrations.query.byIntegration({
                ledgerId: input.activeLedgerId,
            }),
            "integrationId",
        ),
        listWorkspaceRevisionRecords(
            entities.amazonOrders.query.byOrder({
                ledgerId: input.activeLedgerId,
            }),
            "amazonOrderId",
        ),
        listWorkspaceRevisionRecords(
            entities.amazonOrderSyncRuns.query.bySyncRun({
                ledgerId: input.activeLedgerId,
            }),
            "syncRunId",
        ),
        listWorkspaceRevisionRecords(
            entities.plaidAccountLinks.query.byLink({
                ledgerId: input.activeLedgerId,
            }),
            "plaidAccountLinkId",
        ),
        listWorkspaceRevisionRecords(
            entities.plaidTransactionSyncs.query.bySync({
                ledgerId: input.activeLedgerId,
            }),
            "plaidTransactionSyncId",
        ),
        listWorkspaceRevisionRecords(
            entities.transactionTemplates.query.byTemplate({
                ledgerId: input.activeLedgerId,
            }),
            "templateId",
        ),
        listWorkspaceRevisionRecords(
            entities.transactionAutoMatchRejections.query.byRejection({
                ledgerId: input.activeLedgerId,
            }),
            "matchDecisionId",
        ),
        listWorkspaceRevisionRecords(
            entities.transactions.query.byTransaction({
                ledgerId: input.activeLedgerId,
            }),
            "transactionId",
        ),
        listWorkspaceRevisionRecords(
            entities.transactionImportActivities.query.byActivity({
                ledgerId: input.activeLedgerId,
            }),
            "activityId",
        ),
        listWorkspaceRevisionRecords(
            entities.transactionLines.query.byLine({
                ledgerId: input.activeLedgerId,
            }),
            "lineId",
        ),
        listWorkspaceRevisionRecords(
            entities.ledgerPostings.query.byPosting({
                ledgerId: input.activeLedgerId,
            }),
            "postingId",
        ),
        listWorkspaceRevisionRecords(
            entities.venmoAccountMappings.query.byMapping({ ledgerId: input.activeLedgerId }),
            "mappingId",
        ),
        listWorkspaceRevisionRecords(
            entities.venmoIntegrations.query.byIntegration({ ledgerId: input.activeLedgerId }),
            "integrationId",
        ),
    ]);

    const records = {
        accounts: accounts as WorkspaceSnapshotRecords["accounts"],
        allocationFundingSources:
            fundingSources as WorkspaceSnapshotRecords["allocationFundingSources"],
        amazonOrderIntegrations:
            amazonOrderIntegrations as WorkspaceSnapshotRecords["amazonOrderIntegrations"],
        amazonOrderSyncRuns:
            amazonOrderSyncRuns as WorkspaceSnapshotRecords["amazonOrderSyncRuns"],
        amazonOrders: amazonOrders as WorkspaceSnapshotRecords["amazonOrders"],
        budgetAllocations:
            allocations as WorkspaceSnapshotRecords["budgetAllocations"],
        budgetCategories:
            categories as WorkspaceSnapshotRecords["budgetCategories"],
        budgetGroups: groups as WorkspaceSnapshotRecords["budgetGroups"],
        budgetPeriods: periods as WorkspaceSnapshotRecords["budgetPeriods"],
        ledgerPostings: postings as WorkspaceSnapshotRecords["ledgerPostings"],
        ledgers: ledgers as WorkspaceSnapshotRecords["ledgers"],
        plaidAccountLinks:
            plaidAccountLinks as WorkspaceSnapshotRecords["plaidAccountLinks"],
        plaidTransactionSyncs:
            plaidTransactionSyncs as WorkspaceSnapshotRecords["plaidTransactionSyncs"],
        transactionAutoMatchRejections:
            transactionAutoMatchRejections as WorkspaceSnapshotRecords["transactionAutoMatchRejections"],
        transactionTemplates:
            transactionTemplates as WorkspaceSnapshotRecords["transactionTemplates"],
        transactionImportActivities:
            transactionImportActivities as WorkspaceSnapshotRecords["transactionImportActivities"],
        venmoAccountMappings: venmoAccountMappings as WorkspaceSnapshotRecords["venmoAccountMappings"],
        venmoIntegrations: venmoIntegrations as WorkspaceSnapshotRecords["venmoIntegrations"],
        transactionLines: lines as WorkspaceSnapshotRecords["transactionLines"],
        transactions: transactions as WorkspaceSnapshotRecords["transactions"],
    };

    return rebuildWorkspaceSnapshotRecords({
        ...records,
        activeLedgerId: input.activeLedgerId,
        activeLedgerName: "Ledger",
        knowledge: undefined as never,
    });
}

function parseWorkspaceStateRecord(record: {
    createdAt: string;
    entityDigestAccumulatorsJson?: string;
    entityDigestsJson?: string;
    entityCountsJson: string;
    entityRevisionsJson: string;
    ledgerId: string;
    oldestRetainedWorkspaceRevision: number;
    updatedAt: string;
    workspaceGeneration: number;
    workspaceRevision: number;
}): StoredWorkspaceState {
    return {
        createdAt: record.createdAt,
        entityDigestAccumulators: record.entityDigestAccumulatorsJson
            ? (JSON.parse(record.entityDigestAccumulatorsJson) as Record<
                  WorkspaceEntityType,
                  string
              >)
            : undefined,
        entityDigests: record.entityDigestsJson
            ? (JSON.parse(record.entityDigestsJson) as WorkspaceKnowledge["entityDigests"])
            : undefined,
        entityCounts: JSON.parse(record.entityCountsJson) as WorkspaceKnowledge["entityCounts"],
        entityRevisions: JSON.parse(record.entityRevisionsJson) as NonNullable<
            WorkspaceKnowledge["entityRevisions"]
        >,
        ledgerId: record.ledgerId,
        oldestRetainedWorkspaceRevision:
            record.oldestRetainedWorkspaceRevision,
        updatedAt: record.updatedAt,
        workspaceGeneration: record.workspaceGeneration,
        workspaceRevision: record.workspaceRevision,
    };
}

async function getStoredWorkspaceState(ledgerId: string) {
    const { entities } = getBudgetedSchema();
    const result = await entities.workspaceStates
        .get({
            ledgerId,
            stateId: WORKSPACE_STATE_ID,
            workspaceId: GLOBAL_WORKSPACE_ID,
        })
        .go({ consistent: true });

    return result.data ? parseWorkspaceStateRecord(result.data) : null;
}

function createWorkspaceStateUpdate(input: {
    createdAt?: string;
    entityDigestAccumulators?: Record<WorkspaceEntityType, string>;
    entityDigests?: NonNullable<WorkspaceKnowledge["entityDigests"]>;
    entityCounts: WorkspaceKnowledge["entityCounts"];
    entityRevisions: NonNullable<WorkspaceKnowledge["entityRevisions"]>;
    ledgerId: string;
    oldestRetainedWorkspaceRevision: number;
    workspaceGeneration: number;
    workspaceRevision: number;
}): WorkspaceStateUpdate {
    const now = new Date().toISOString();
    const entityDigestAccumulators =
        input.entityDigestAccumulators ??
        calculateWorkspaceEntityDigestAccumulators({
            accounts: [],
            allocationFundingSources: [],
            amazonOrderIntegrations: [],
            amazonOrderSyncRuns: [],
            amazonOrders: [],
            budgetAllocations: [],
            budgetCategories: [],
            budgetGroups: [],
            budgetPeriods: [],
            ledgerPostings: [],
            ledgers: [],
            plaidAccountLinks: [],
            plaidTransactionSyncs: [],
            transactionAutoMatchRejections: [],
            transactionImportActivities: [],
            transactionLines: [],
            transactionTemplates: [],
            transactions: [],
            venmoAccountMappings: [],
            venmoIntegrations: [],
        });
    const entityDigests = input.entityDigests ??
        Object.fromEntries(
            WORKSPACE_ENTITY_TYPES.map((entityType) => [
                entityType,
                createWorkspaceEntityDigest({
                    accumulator: entityDigestAccumulators[entityType],
                    count: input.entityCounts[entityType] ?? 0,
                }),
            ]),
        ) as NonNullable<WorkspaceKnowledge["entityDigests"]>;

    return {
        createdAt: input.createdAt ?? now,
        entityDigestAccumulators,
        entityDigestAccumulatorsJson: stableStringify(entityDigestAccumulators),
        entityDigests,
        entityDigestsJson: stableStringify(entityDigests),
        entityCounts: input.entityCounts,
        entityCountsJson: stableStringify(input.entityCounts),
        entityRevisions: input.entityRevisions,
        entityRevisionsJson: stableStringify(input.entityRevisions),
        ledgerId: input.ledgerId,
        oldestRetainedWorkspaceRevision:
            input.oldestRetainedWorkspaceRevision,
        stateId: WORKSPACE_STATE_ID,
        updatedAt: now,
        workspaceGeneration: input.workspaceGeneration,
        workspaceId: GLOBAL_WORKSPACE_ID,
        workspaceRevision: input.workspaceRevision,
    };
}

export function toWorkspaceStateRecord(state: WorkspaceStateUpdate) {
    return {
        createdAt: state.createdAt,
        entityCountsJson: state.entityCountsJson,
        entityDigestAccumulatorsJson: state.entityDigestAccumulatorsJson,
        entityDigestsJson: state.entityDigestsJson,
        entityRevisionsJson: state.entityRevisionsJson,
        ledgerId: state.ledgerId,
        oldestRetainedWorkspaceRevision:
            state.oldestRetainedWorkspaceRevision,
        stateId: state.stateId,
        updatedAt: state.updatedAt,
        workspaceGeneration: state.workspaceGeneration,
        workspaceId: state.workspaceId,
        workspaceRevision: state.workspaceRevision,
    };
}

export function createWorkspaceStateFromRecords(input: {
    ledgerId: string;
    oldestRetainedWorkspaceRevision: number;
    records: WorkspaceSnapshotRecords;
    workspaceGeneration: number;
    workspaceRevision: number;
}) {
    return createWorkspaceStateUpdate({
        entityCounts: calculateWorkspaceEntityCounts(input.records),
        entityDigestAccumulators:
            calculateWorkspaceEntityDigestAccumulators(input.records),
        entityDigests: calculateWorkspaceEntityDigests(input.records),
        entityRevisions: createWorkspaceEntityRevisionTokens({
            generation: input.workspaceGeneration,
            revision: input.workspaceRevision,
        }),
        ledgerId: input.ledgerId,
        oldestRetainedWorkspaceRevision:
            input.oldestRetainedWorkspaceRevision,
        workspaceGeneration: input.workspaceGeneration,
        workspaceRevision: input.workspaceRevision,
    });
}

function hasValidWorkspaceEntityRevisionTokens(input: {
    entityRevisions: WorkspaceKnowledge["entityRevisions"];
    workspaceGeneration: number;
    workspaceRevision: number;
}) {
    if (!input.entityRevisions) {
        return false;
    }

    return WORKSPACE_ENTITY_TYPES.every((entityType) => {
        const cursor = parseWorkspaceCursor(input.entityRevisions?.[entityType]);

        return (
            cursor !== null &&
            cursor.generation === input.workspaceGeneration &&
            cursor.revision <= input.workspaceRevision
        );
    });
}

function hasValidWorkspaceEntityDigests(input: {
    entityDigestAccumulators?: Record<WorkspaceEntityType, string>;
    entityDigests?: WorkspaceKnowledge["entityDigests"];
}) {
    return WORKSPACE_ENTITY_TYPES.every((entityType) => {
        const accumulator = input.entityDigestAccumulators?.[entityType];
        const digest = input.entityDigests?.[entityType];

        return (
            typeof accumulator === "string" &&
            accumulator.length === 64 &&
            typeof digest === "string" &&
            digest.length === 64
        );
    });
}

function hasLedgerLocalWorkspaceEntityProofs(input: {
    entityCounts?: WorkspaceKnowledge["entityCounts"];
    entityDigestAccumulators?: Record<WorkspaceEntityType, string>;
    entityDigests?: WorkspaceKnowledge["entityDigests"];
}) {
    return (
        input.entityCounts?.ledger === 1 &&
        hasValidWorkspaceEntityDigests(input)
    );
}

type WorkspaceCursorState = {
    changeCursor: string;
    protocolVersion: number;
    workspaceGeneration: number;
    workspaceRevision: number;
};

async function getWorkspaceCursorState(
    ledgerId: string,
): Promise<WorkspaceCursorState> {
    const { entities } = getBudgetedSchema();
    const ledgerResult = await entities.ledgers
        .get({ workspaceId: GLOBAL_WORKSPACE_ID, ledgerId })
        .go({ consistent: true });
    const workspaceGeneration = ledgerResult.data?.workspaceGeneration;
    const workspaceRevision = ledgerResult.data?.workspaceRevision;
    const protocolVersion =
        ledgerResult.data?.workspaceSyncProtocolVersion ?? 1;

    if (
        !Number.isSafeInteger(workspaceGeneration) ||
        workspaceGeneration! < 1 ||
        !Number.isSafeInteger(workspaceRevision) ||
        workspaceRevision! < 0
    ) {
        throw new Error(
            "Ledger workspace revision metadata is missing or invalid.",
        );
    }

    return {
        changeCursor: encodeWorkspaceCursor({
            generation: workspaceGeneration!,
            revision: workspaceRevision!,
        }),
        protocolVersion,
        workspaceGeneration: workspaceGeneration!,
        workspaceRevision: workspaceRevision!,
    };
}

function assertWorkspaceSyncProtocolV2(cursor: WorkspaceCursorState) {
    if (cursor.protocolVersion !== WORKSPACE_SYNC_PROTOCOL_VERSION) {
        throw new HttpError(
            409,
            "workspace_protocol_upgrade_required",
            "This workspace must be upgraded before it can be synchronized by this application version.",
        );
    }
}

async function getWorkspaceStateForKnowledge(ledgerId: string) {
    await ensureWorkspaceExplicitMutationFenceIsClear(ledgerId);

    const stored = await getStoredWorkspaceState(ledgerId);

    if (
        stored &&
        hasValidWorkspaceEntityRevisionTokens({
            entityRevisions: stored.entityRevisions,
            workspaceGeneration: stored.workspaceGeneration,
            workspaceRevision: stored.workspaceRevision,
        }) &&
        hasLedgerLocalWorkspaceEntityProofs(stored)
    ) {
        return stored;
    }

    throw new Error(
        "Workspace revision state is missing or invalid. Run the workspace protocol readiness migration before serving this ledger.",
    );
}

async function getWorkspaceExplicitMutationFence(ledgerId: string) {
    const { entities } = getBudgetedSchema();
    const result = await entities.workspaceMutationOperations
        .get({
            ledgerId,
            mutationId: EXPLICIT_MUTATION_FENCE_ID,
            workspaceId: GLOBAL_WORKSPACE_ID,
        })
        .go({ consistent: true });

    return result.data;
}

async function repairWorkspaceExplicitMutationFence(
    ledgerId: string,
    expectedToken?: string,
) {
    const fence = await getWorkspaceExplicitMutationFence(ledgerId);

    if (!fence) {
        return;
    }

    if (expectedToken !== undefined) {
        const operation = JSON.parse(fence.operationJson) as { token?: unknown };

        if (operation.token !== expectedToken) {
            throw new Error("Workspace mutation fence ownership changed.");
        }
    }

    const { entities, service } = getBudgetedSchema();
    const ledgerResult = await entities.ledgers
        .get({ workspaceId: GLOBAL_WORKSPACE_ID, ledgerId })
        .go({ consistent: true });
    const ledger = ledgerResult.data;

    if (!ledger) {
        throw new Error("Workspace mutation fence ledger is missing.");
    }

    const expectedGeneration = ledger.workspaceGeneration;
    const expectedRevision = ledger.workspaceRevision;
    const workspaceGeneration = (expectedGeneration ?? 1) + 1;
    const workspaceRevision = 0;
    const updatedAt = new Date().toISOString();
    const nextLedger = {
        ...ledger,
        updatedAt,
        workspaceGeneration,
        workspaceRevision,
    };
    const state = await rebuildWorkspaceStateForGeneration({
        ledger: nextLedger,
        ledgerId,
        workspaceGeneration,
        workspaceRevision,
    });

    await service.transaction
        .write((transactionEntities) => [
            transactionEntities.workspaceStates
                .put(toWorkspaceStateRecord(state))
                .commit(),
            transactionEntities.ledgers
                .update({ workspaceId: GLOBAL_WORKSPACE_ID, ledgerId })
                .set({ updatedAt, workspaceGeneration, workspaceRevision })
                .where((attributes, operations) => {
                    const generationCondition =
                        expectedGeneration === undefined
                            ? operations.notExists(
                                  attributes.workspaceGeneration,
                              )
                            : operations.eq(
                                  attributes.workspaceGeneration,
                                  expectedGeneration,
                              );
                    const revisionCondition =
                        expectedRevision === undefined
                            ? operations.notExists(attributes.workspaceRevision)
                            : operations.eq(
                                  attributes.workspaceRevision,
                                  expectedRevision,
                              );

                    return `${generationCondition} AND ${revisionCondition}`;
                })
                .commit(),
            transactionEntities.workspaceMutationOperations
                .delete({
                    ledgerId,
                    mutationId: EXPLICIT_MUTATION_FENCE_ID,
                    workspaceId: GLOBAL_WORKSPACE_ID,
                })
                .commit(),
        ])
        .go();
}

async function ensureWorkspaceExplicitMutationFenceIsClear(ledgerId: string) {
    const fence = await getWorkspaceExplicitMutationFence(ledgerId);

    if (!fence) {
        return;
    }

    if (
        Date.now() - new Date(fence.createdAt).getTime() <
        EXPLICIT_MUTATION_FENCE_STALE_MS
    ) {
        throw new HttpError(
            503,
            WORKSPACE_MUTATION_IN_PROGRESS_ERROR_CODE,
            "A workspace change is being finalized. Retrying shortly.",
            { retryAfterMs: WORKSPACE_MUTATION_RETRY_AFTER_MS },
        );
    }

    await repairWorkspaceExplicitMutationFence(ledgerId);
}

export async function beginWorkspaceExplicitMutation(ledgerId: string) {
    if (await getWorkspaceExplicitMutationFence(ledgerId)) {
        await ensureWorkspaceExplicitMutationFenceIsClear(ledgerId);
    }

    const token = ulid();
    const operation = createWorkspaceMutationOperation({
        completedStepCount: 0,
        ledgerId,
        mutationId: EXPLICIT_MUTATION_FENCE_ID,
        mutationType: EXPLICIT_MUTATION_FENCE_ID,
        operation: { token },
        status: "running",
    });
    const { entities } = getBudgetedSchema();

    await entities.workspaceMutationOperations
        .put(toWorkspaceMutationOperationRecord(operation))
        .where((attributes, operations) =>
            operations.notExists(attributes.mutationId),
        )
        .go();

    return token;
}

export async function completeWorkspaceExplicitMutation(input: {
    ledgerId: string;
    token: string;
}) {
    const fence = await getWorkspaceExplicitMutationFence(input.ledgerId);
    const operation = fence
        ? (JSON.parse(fence.operationJson) as { token?: unknown })
        : null;

    if (operation?.token !== input.token) {
        throw new Error("Workspace mutation fence ownership changed.");
    }

    await getBudgetedSchema().entities.workspaceMutationOperations
        .delete({
            ledgerId: input.ledgerId,
            mutationId: EXPLICIT_MUTATION_FENCE_ID,
            workspaceId: GLOBAL_WORKSPACE_ID,
        })
        .go();
}

export async function recoverWorkspaceExplicitMutation(input: {
    ledgerId: string;
    token: string;
}) {
    await repairWorkspaceExplicitMutationFence(input.ledgerId, input.token);
}

export type NextWorkspaceMutationVersion = {
    expectedWorkspaceGeneration: number;
    expectedWorkspaceRevision?: number;
    workspaceGeneration: number;
    workspaceRevision: number;
};

export async function getNextWorkspaceMutationVersion(ledgerId: string) {
    const { entities } = getBudgetedSchema();
    const result = await entities.ledgers
        .get({ workspaceId: GLOBAL_WORKSPACE_ID, ledgerId })
        .go({ consistent: true });
    const ledger = result.data;

    if (!ledger) {
        throw new Error("Workspace mutation ledger is missing.");
    }

    const expectedWorkspaceGeneration = ledger.workspaceGeneration;
    const expectedWorkspaceRevision = ledger.workspaceRevision;

    if (
        !Number.isSafeInteger(expectedWorkspaceGeneration) ||
        expectedWorkspaceGeneration < 1 ||
        !Number.isSafeInteger(expectedWorkspaceRevision) ||
        expectedWorkspaceRevision < 0
    ) {
        throw new Error("Workspace mutation revision metadata is invalid.");
    }

    return {
        expectedWorkspaceGeneration,
        expectedWorkspaceRevision,
        workspaceGeneration: expectedWorkspaceGeneration,
        workspaceRevision: expectedWorkspaceRevision + 1,
    } satisfies NextWorkspaceMutationVersion;
}

function createWorkspaceKnowledge(input: {
    activeLedgerId: string;
    changeCursor: string;
    entityCounts?: WorkspaceKnowledge["entityCounts"];
    entityDigests?: WorkspaceKnowledge["entityDigests"];
    entityRevisions?: NonNullable<WorkspaceKnowledge["entityRevisions"]>;
    generatedAt?: string;
    oldestRetainedWorkspaceRevision: number;
    records?: WorkspaceSnapshotRecords;
    workspaceGeneration: number;
    workspaceRevision: number;
}): WorkspaceKnowledge {
    const generatedAt = input.generatedAt ?? new Date().toISOString();

    return {
        activeLedgerId: input.activeLedgerId,
        applicationReleaseTag: APPLICATION_VERSION.releaseTag,
        applicationVersion: APPLICATION_VERSION.buildTimestamp,
        changeCursor: input.changeCursor,
        entityCounts:
            input.entityCounts ?? calculateWorkspaceEntityCounts(input.records!),
        entityDigests:
            input.entityDigests ??
            calculateWorkspaceEntityDigests(input.records!),
        entityRevisions:
            input.entityRevisions ??
            createWorkspaceEntityRevisionTokens({
                generation: input.workspaceGeneration,
                revision: input.workspaceRevision,
            }),
        generatedAt,
        oldestRetainedWorkspaceRevision: input.oldestRetainedWorkspaceRevision,
        retainedChangesAfter: getRetainedChangesAfter(new Date(generatedAt)),
        revision: input.changeCursor,
        workspaceGeneration: input.workspaceGeneration,
        workspaceRevision: input.workspaceRevision,
    };
}

export async function buildWorkspaceSnapshot(
    user: CurrentWorkspaceUser,
): Promise<WorkspaceSnapshotPayload> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const baseWorkspaceCursor = await getWorkspaceCursorState(
            user.activeLedgerId,
        );
        assertWorkspaceSyncProtocolV2(baseWorkspaceCursor);
        const [activeLedger, scopedRecords] = await Promise.all([
            getWorkspaceLedger(user.activeLedgerId),
            listLedgerScopedRecords({
                ledgerId: user.activeLedgerId,
            }),
        ]);
        const workspaceState = await getWorkspaceStateForKnowledge(
            user.activeLedgerId,
        );

        if (
            workspaceState.workspaceGeneration !==
                baseWorkspaceCursor.workspaceGeneration ||
            workspaceState.workspaceRevision !==
                baseWorkspaceCursor.workspaceRevision
        ) {
            continue;
        }

        const snapshotWithoutKnowledge = {
            ...scopedRecords,
            activeLedgerId: user.activeLedgerId,
            activeLedgerName:
                activeLedger?.name ?? user.activeLedgerName ?? "Ledger",
            ledgers: activeLedger ? [activeLedger] : [],
        };
        const snapshotRecords = rebuildWorkspaceSnapshotRecords(
            snapshotWithoutKnowledge as WorkspaceSnapshot,
        );
        const entityDigests = calculateWorkspaceEntityDigests(snapshotRecords);

        if (
            stableStringify(entityDigests) !==
            stableStringify(workspaceState.entityDigests)
        ) {
            continue;
        }

        const knowledge = createWorkspaceKnowledge({
            activeLedgerId: user.activeLedgerId,
            changeCursor: baseWorkspaceCursor.changeCursor,
            entityCounts: workspaceState.entityCounts,
            entityDigests: workspaceState.entityDigests,
            entityRevisions: workspaceState.entityRevisions,
            oldestRetainedWorkspaceRevision:
                workspaceState.oldestRetainedWorkspaceRevision,
            workspaceGeneration: baseWorkspaceCursor.workspaceGeneration,
            workspaceRevision: baseWorkspaceCursor.workspaceRevision,
        });
        const snapshot = {
            ...snapshotWithoutKnowledge,
            baseChangeCursor: baseWorkspaceCursor.changeCursor,
            knowledge,
            transactionHydration: "full" as const,
            version: workspaceKnowledgeToVersion(knowledge),
        };

        return snapshot;
    }

    throw new Error("Workspace changed while building synchronization snapshot.");
}

export async function buildWorkspaceKnowledge(user: CurrentWorkspaceUser) {
    const workspaceState = await getWorkspaceStateForKnowledge(
        user.activeLedgerId,
    );

    return createWorkspaceKnowledge({
        activeLedgerId: user.activeLedgerId,
        changeCursor: encodeWorkspaceCursor({
            generation: workspaceState.workspaceGeneration,
            revision: workspaceState.workspaceRevision,
        }),
        entityCounts: workspaceState.entityCounts,
        entityDigests: workspaceState.entityDigests,
        entityRevisions: workspaceState.entityRevisions,
        oldestRetainedWorkspaceRevision:
            workspaceState.oldestRetainedWorkspaceRevision,
        workspaceGeneration: workspaceState.workspaceGeneration,
        workspaceRevision: workspaceState.workspaceRevision,
    });
}

export async function buildWorkspaceVersion(
    user: CurrentWorkspaceUser,
): Promise<WorkspaceVersionResult> {
    const cursor = await getWorkspaceCursorState(user.activeLedgerId);
    assertWorkspaceSyncProtocolV2(cursor);
    const workspaceState = await getStoredWorkspaceState(user.activeLedgerId);

    return {
        applicationReleaseTag: APPLICATION_VERSION.releaseTag,
        applicationVersion: APPLICATION_VERSION.buildTimestamp,
        cursor: cursor.changeCursor,
        generation: cursor.workspaceGeneration,
        ledgerId: user.activeLedgerId,
        oldestRetainedRevision:
            workspaceState?.workspaceGeneration === cursor.workspaceGeneration
                ? workspaceState.oldestRetainedWorkspaceRevision
                : cursor.workspaceRevision,
        protocolVersion: WORKSPACE_SYNC_PROTOCOL_VERSION,
        revision: cursor.workspaceRevision,
    };
}

export async function buildCommittedWorkspaceKnowledge(
    user: CurrentWorkspaceUser,
) {
    const workspaceState = await getStoredWorkspaceState(user.activeLedgerId);

    if (
        !workspaceState ||
        !hasValidWorkspaceEntityRevisionTokens({
            entityRevisions: workspaceState.entityRevisions,
            workspaceGeneration: workspaceState.workspaceGeneration,
            workspaceRevision: workspaceState.workspaceRevision,
        }) ||
        !hasLedgerLocalWorkspaceEntityProofs(workspaceState)
    ) {
        throw new Error(
            "The committed workspace mutation is missing authoritative knowledge.",
        );
    }

    return createWorkspaceKnowledge({
        activeLedgerId: user.activeLedgerId,
        changeCursor: encodeWorkspaceCursor({
            generation: workspaceState.workspaceGeneration,
            revision: workspaceState.workspaceRevision,
        }),
        entityCounts: workspaceState.entityCounts,
        entityDigests: workspaceState.entityDigests,
        entityRevisions: workspaceState.entityRevisions,
        oldestRetainedWorkspaceRevision:
            workspaceState.oldestRetainedWorkspaceRevision,
        workspaceGeneration: workspaceState.workspaceGeneration,
        workspaceRevision: workspaceState.workspaceRevision,
    });
}

function toTrackedRecords(input: {
    includeLedgerScoped: boolean;
    ledgers: WorkspaceSnapshot["ledgers"];
    scopedRecords?: Awaited<ReturnType<typeof listLedgerScopedRecords>>;
}): TrackedWorkspaceRecord[] {
    const records: Partial<WorkspaceSnapshotRecords> = { ledgers: input.ledgers };
    const entityTypes = input.includeLedgerScoped
        ? WORKSPACE_ENTITY_TYPES
        : (["ledger"] satisfies WorkspaceEntityType[]);

    if (input.includeLedgerScoped && input.scopedRecords) {
        Object.assign(records, input.scopedRecords);
    }

    return entityTypes.flatMap((entityType) =>
        createWorkspaceRecordReferences(
            entityType,
            records[getWorkspaceEntityArrayKey(entityType)] ?? [],
            stripDerivedTrackedRecordFields,
        ),
    );
}

function stripDerivedTrackedRecordFields(
    entityType: WorkspaceEntityType,
    record: unknown,
) {
    if (entityType !== "transaction") {
        return record;
    }

    const transaction = { ...(record as Record<string, unknown>) };
    delete transaction.lines;
    delete transaction.postings;

    return transaction;
}

async function readTrackedWorkspaceRecords(input: {
    activeLedgerId: string;
    includeLedgerScoped: boolean;
}) {
    const [ledger, scopedRecords] = await Promise.all([
        getWorkspaceLedger(input.activeLedgerId),
        input.includeLedgerScoped
            ? listLedgerScopedRecords({
                  ledgerId: input.activeLedgerId,
              })
            : Promise.resolve(undefined),
    ]);

    return toTrackedRecords({
        includeLedgerScoped: input.includeLedgerScoped,
        ledgers: ledger ? [ledger] : [],
        scopedRecords,
    });
}

function getTrackedRecordKey(record: Pick<TrackedWorkspaceRecord, "entityId" | "entityType">) {
    return `${record.entityType}:${record.entityId}`;
}

function diffTrackedRecords(input: {
    after: TrackedWorkspaceRecord[];
    before: TrackedWorkspaceRecord[];
}) {
    const beforeByKey = new Map(
        input.before.map((record) => [getTrackedRecordKey(record), record]),
    );
    const afterByKey = new Map(
        input.after.map((record) => [getTrackedRecordKey(record), record]),
    );
    const changes: Array<
        Pick<
            WorkspaceChange,
            | "entityId"
            | "entityType"
            | "operation"
            | "previousRecordDigest"
            | "record"
        >
    > = [];

    for (const [key, afterRecord] of afterByKey) {
        const beforeRecord = beforeByKey.get(key);

        if (
            !beforeRecord ||
            stableStringify(beforeRecord.record) !==
                stableStringify(afterRecord.record)
        ) {
            changes.push({
                entityId: afterRecord.entityId,
                entityType: afterRecord.entityType,
                operation: "upsert",
                previousRecordDigest: beforeRecord
                    ? calculateWorkspaceRecordDigest({
                          entityType: beforeRecord.entityType,
                          record: normalizeWorkspaceDigestRecord(
                              beforeRecord.entityType,
                              beforeRecord.record,
                          ),
                      })
                    : null,
                record: afterRecord.record,
            });
        }
    }

    for (const [key, beforeRecord] of beforeByKey) {
        if (!afterByKey.has(key)) {
            changes.push({
                entityId: beforeRecord.entityId,
                entityType: beforeRecord.entityType,
                operation: "delete",
                previousRecordDigest: calculateWorkspaceRecordDigest({
                    entityType: beforeRecord.entityType,
                    record: normalizeWorkspaceDigestRecord(
                        beforeRecord.entityType,
                        beforeRecord.record,
                    ),
                }),
                record: null,
            });
        }
    }

    const affectedTransactionIds = new Set<string>();

    for (const change of changes) {
        if (
            ![
                "ledgerPosting",
                "plaidTransactionSync",
                "transactionLine",
            ].includes(change.entityType)
        ) {
            continue;
        }

        const record =
            change.operation === "upsert"
                ? change.record
                : beforeByKey.get(
                      `${change.entityType}:${change.entityId}`,
                  )?.record;
        const transactionId = (record as { transactionId?: unknown } | undefined)
            ?.transactionId;

        if (typeof transactionId === "string") {
            affectedTransactionIds.add(transactionId);
        }
    }

    const changedTransactionIds = new Set(
        changes
            .filter((change) => change.entityType === "transaction")
            .map((change) => change.entityId),
    );
    const parentChanges: WorkspaceMutationChangeInput[] = [];

    for (const transactionId of affectedTransactionIds) {
        if (changedTransactionIds.has(transactionId)) continue;

        const key = `transaction:${transactionId}`;
        const before = beforeByKey.get(key);
        const after = afterByKey.get(key);

        if (after) {
            parentChanges.push({
                entityId: transactionId,
                entityType: "transaction",
                operation: "upsert",
                previousRecordDigest: before
                    ? calculateWorkspaceRecordDigest({
                          entityType: "transaction",
                          record: normalizeWorkspaceDigestRecord(
                              "transaction",
                              before.record,
                          ),
                      })
                    : null,
                record: after.record,
            });
        } else if (before) {
            parentChanges.push({
                entityId: transactionId,
                entityType: "transaction",
                operation: "delete",
                previousRecordDigest: calculateWorkspaceRecordDigest({
                    entityType: "transaction",
                    record: normalizeWorkspaceDigestRecord(
                        "transaction",
                        before.record,
                    ),
                }),
                record: null,
            });
        }
    }

    return [...parentChanges, ...changes];
}

export function createWorkspaceMutationBatch(input: {
    changes: WorkspaceMutationChangeInput[];
    ledgerId: string;
    mutationId: string;
    mutationType: string;
    response: unknown;
    expectedWorkspaceGeneration?: number;
    expectedWorkspaceRevision?: number;
    workspaceGeneration: number;
    workspaceRevision?: number;
}): WorkspaceMutationBatch {
    const batchId = nextWorkspaceChangeId();
    const changedAt = new Date();
    const expiresAt = getWorkspaceChangeExpiresAt(changedAt);
    const workspaceRevision = input.workspaceRevision ?? 0;
    const changes = input.changes.map((change, changeIndex) => ({
        ...change,
        batchId,
        changedAt: changedAt.toISOString(),
        changeId: nextWorkspaceChangeId(),
        changeCount: input.changes.length,
        changeIndex,
        expiresAt,
        workspaceGeneration: input.workspaceGeneration,
        workspaceRevision,
    }));

    if (changes.length === 0) {
        throw new Error("Workspace mutation batches require at least one change.");
    }

    assertWorkspaceMutationJsonFits({
        payload: { changes, response: input.response },
        type: "change batch",
    });

    return {
        batchId,
        changeCursor: changes.at(-1)!.changeId,
        changeCount: changes.length,
        changes,
        createdAt: changedAt.toISOString(),
        expiresAt,
        ledgerId: input.ledgerId,
        mutationId: input.mutationId,
        mutationType: input.mutationType,
        response: input.response,
        expectedWorkspaceGeneration: input.expectedWorkspaceGeneration,
        expectedWorkspaceRevision: input.expectedWorkspaceRevision,
        workspaceGeneration: input.workspaceGeneration,
        workspaceRevision,
    };
}

export function toWorkspaceMutationBatchRecord(batch: WorkspaceMutationBatch) {
    assertWorkspaceChangesHaveTransitionProofs(batch.changes);

    return {
        batchId: batch.batchId,
        changeCursor: batch.changeCursor,
        changeCount: batch.changeCount,
        changesJson: stableStringify(batch.changes),
        createdAt: batch.createdAt,
        expiresAt: batch.expiresAt,
        ledgerId: batch.ledgerId,
        mutationId: batch.mutationId,
        mutationType: batch.mutationType,
        responseJson: stableStringify(batch.response),
        workspaceGeneration: batch.workspaceGeneration,
        workspaceRevision: batch.workspaceRevision,
        workspaceRevisionKey: toWorkspaceRevisionKey(batch.workspaceRevision),
        workspaceId: GLOBAL_WORKSPACE_ID,
    };
}

export function assertWorkspaceChangesHaveTransitionProofs(
    changes: readonly WorkspaceMutationChangeInput[],
) {
    const missingProof = changes.find(
        (change) => change.previousRecordDigest === undefined,
    );

    if (missingProof) {
        throw new Error(
            `Workspace ${missingProof.operation} for ${missingProof.entityType}:${missingProof.entityId} is missing its previous record digest.`,
        );
    }
}

function toWorkspaceRecordObject(record: unknown) {
    if (!record || typeof record !== "object") {
        throw new Error("Workspace upsert changes require a record.");
    }

    return record as Record<string, unknown>;
}

function getWorkspaceRecordString(record: Record<string, unknown>, key: string) {
    const value = record[key];

    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Workspace record is missing ${key}.`);
    }

    return value;
}

async function getWorkspaceRecordBeforeWrite(input: {
    change: WorkspaceMutationChangeInput;
    ledgerId: string;
}) {
    const record = toWorkspaceRecordObject(input.change.record);
    const { entities } = getBudgetedSchema();
    const ledgerId = input.ledgerId;

    switch (input.change.entityType) {
        case "account":
            return (
                await entities.accounts
                    .get({
                        accountId: getWorkspaceRecordString(record, "accountId"),
                        ledgerId,
                    })
                    .go({ consistent: true })
            ).data;
        case "allocationFundingSource":
            return (
                await entities.allocationFundingSources
                    .get({
                        fundingSourceId: getWorkspaceRecordString(
                            record,
                            "fundingSourceId",
                        ),
                        ledgerId,
                    })
                    .go({ consistent: true })
            ).data;
        case "amazonOrderIntegration":
            return (
                await entities.amazonOrderIntegrations
                    .get({
                        integrationId: getWorkspaceRecordString(
                            record,
                            "integrationId",
                        ),
                        ledgerId,
                    })
                    .go({ consistent: true })
            ).data;
        case "amazonOrder":
            return (
                await entities.amazonOrders
                    .get({
                        amazonOrderId: getWorkspaceRecordString(
                            record,
                            "amazonOrderId",
                        ),
                        ledgerId,
                    })
                    .go({ consistent: true })
            ).data;
        case "amazonOrderSyncRun":
            return (
                await entities.amazonOrderSyncRuns
                    .get({
                        ledgerId,
                        syncRunId: getWorkspaceRecordString(record, "syncRunId"),
                    })
                    .go({ consistent: true })
            ).data;
        case "venmoAccountMapping":
            return (
                await entities.venmoAccountMappings.get({
                    ledgerId,
                    mappingId: getWorkspaceRecordString(record, "mappingId"),
                }).go({ consistent: true })
            ).data;
        case "venmoIntegration":
            return (
                await entities.venmoIntegrations.get({
                    integrationId: getWorkspaceRecordString(record, "integrationId"),
                    ledgerId,
                }).go({ consistent: true })
            ).data;
        case "budgetCategory":
            return (
                await entities.budgetCategories
                    .get({
                        categoryId: getWorkspaceRecordString(record, "categoryId"),
                        ledgerId,
                    })
                    .go({ consistent: true })
            ).data;
        case "budgetGroup":
            return (
                await entities.budgetGroups
                    .get({
                        groupId: getWorkspaceRecordString(record, "groupId"),
                        ledgerId,
                    })
                    .go({ consistent: true })
            ).data;
        case "budgetPeriod":
            return (
                await entities.budgetPeriods
                    .get({
                        ledgerId,
                        periodId: getWorkspaceRecordString(record, "periodId"),
                    })
                    .go({ consistent: true })
            ).data;
        case "categoryAllocation":
            return (
                await entities.categoryAllocations
                    .get({
                        categoryId: getWorkspaceRecordString(record, "categoryId"),
                        ledgerId,
                        periodId: getWorkspaceRecordString(record, "periodId"),
                    })
                    .go({ consistent: true })
            ).data;
        case "ledger":
            return (
                await entities.ledgers
                    .get({
                        ledgerId: getWorkspaceRecordString(record, "ledgerId"),
                        workspaceId: GLOBAL_WORKSPACE_ID,
                    })
                    .go({ consistent: true })
            ).data;
        case "ledgerPosting":
            return (
                await entities.ledgerPostings
                    .get({
                        ledgerId,
                        postingId: getWorkspaceRecordString(record, "postingId"),
                        transactionId: getWorkspaceRecordString(
                            record,
                            "transactionId",
                        ),
                    })
                    .go({ consistent: true })
            ).data;
        case "plaidAccountLink":
            return (
                await entities.plaidAccountLinks
                    .get({
                        ledgerId,
                        plaidAccountLinkId: getWorkspaceRecordString(
                            record,
                            "plaidAccountLinkId",
                        ),
                    })
                    .go({ consistent: true })
            ).data;
        case "plaidTransactionSync":
            return (
                await entities.plaidTransactionSyncs
                    .get({
                        ledgerId,
                        plaidTransactionSyncId: getWorkspaceRecordString(
                            record,
                            "plaidTransactionSyncId",
                        ),
                    })
                    .go({ consistent: true })
            ).data;
        case "transaction":
            return getTransactionWorkspaceRecordBeforeWrite({
                ledgerId,
                transactionId: getWorkspaceRecordString(record, "transactionId"),
            });
        case "transactionAutoMatchRejection":
            return (
                await entities.transactionAutoMatchRejections
                    .get({
                        ledgerId,
                        matchDecisionId: getWorkspaceRecordString(
                            record,
                            "matchDecisionId",
                        ),
                    })
                    .go({ consistent: true })
            ).data;
        case "transactionImportActivity":
            return (
                await entities.transactionImportActivities
                    .get({
                        activityId: getWorkspaceRecordString(
                            record,
                            "activityId",
                        ),
                        ledgerId,
                    })
                    .go({ consistent: true })
            ).data;
        case "transactionLine":
            return (
                await entities.transactionLines
                    .get({
                        ledgerId,
                        lineId: getWorkspaceRecordString(record, "lineId"),
                        transactionId: getWorkspaceRecordString(
                            record,
                            "transactionId",
                        ),
                    })
                    .go({ consistent: true })
            ).data;
        case "transactionTemplate":
            return (
                await entities.transactionTemplates
                    .get({
                        ledgerId,
                        templateId: getWorkspaceRecordString(record, "templateId"),
                    })
                    .go({ consistent: true })
            ).data;
    }
}

async function getTransactionWorkspaceRecordBeforeWrite(input: {
    ledgerId: string;
    transactionId: string;
}) {
    const { entities } = getBudgetedSchema();
    const byId = entities.transactions.query.byId;

    if (typeof byId === "function") {
        try {
            const [candidate] = await queryAllPages(
                byId({
                    ledgerId: input.ledgerId,
                    transactionId: input.transactionId,
                }),
            );

            if (candidate) {
                const primaryResult = await entities.transactions
                    .query
                    .byTransaction({ ledgerId: input.ledgerId })
                    .begins({
                        occurredAt: (candidate as { occurredAt: string }).occurredAt,
                        transactionId: input.transactionId,
                    })
                    .go({ consistent: true, limit: 1 });

                if (primaryResult.data.some(
                    (transaction) => transaction.transactionId === input.transactionId,
                )) {
                    return primaryResult.data.find(
                        (transaction) =>
                            transaction.transactionId === input.transactionId,
                    );
                }
            }
        } catch {
            // Local tables and a newly deployed index can temporarily lack gsi3.
        }
    }

    const transactions = await queryAllPages(
        entities.transactions.query.byTransaction({ ledgerId: input.ledgerId }),
        { consistent: true },
    );

    return transactions.find(
        (transaction) => transaction.transactionId === input.transactionId,
    );
}

async function getWorkspaceRecordDigestBeforeWrite(input: {
    change: WorkspaceMutationChangeInput;
    ledgerId: string;
}) {
    if (input.change.operation === "delete") {
        return input.change.previousRecordDigest ?? undefined;
    }

    const record = toWorkspaceRecordObject(input.change.record);
    const { entities } = getBudgetedSchema();
    const ledgerId = input.ledgerId;
    let currentRecord: unknown | undefined;

    switch (input.change.entityType) {
        case "categoryAllocation":
            currentRecord = (
                await entities.categoryAllocations
                    .get({
                        categoryId: getWorkspaceRecordString(record, "categoryId"),
                        ledgerId,
                        periodId: getWorkspaceRecordString(record, "periodId"),
                    })
                    .go({ consistent: true })
            ).data;
            break;
        case "ledgerPosting":
            currentRecord = (
                await entities.ledgerPostings
                    .get({
                        ledgerId,
                        postingId: getWorkspaceRecordString(record, "postingId"),
                        transactionId: getWorkspaceRecordString(record, "transactionId"),
                    })
                    .go({ consistent: true })
            ).data;
            break;
        case "plaidTransactionSync":
            currentRecord = (
                await entities.plaidTransactionSyncs
                    .get({
                        ledgerId,
                        plaidTransactionSyncId: getWorkspaceRecordString(
                            record,
                            "plaidTransactionSyncId",
                        ),
                    })
                    .go({ consistent: true })
            ).data;
            break;
        case "transaction": {
            const transactionId = getWorkspaceRecordString(
                record,
                "transactionId",
            );
            const byId = entities.transactions.query.byId;
            let candidate: { occurredAt: string } | undefined;

            if (typeof byId === "function") {
                try {
                    [candidate] = await queryAllPages(
                        byId({ ledgerId, transactionId }),
                    ) as Array<{ occurredAt: string }>;
                } catch {
                    // A local table or newly deployed index can lag the schema.
                }
            }

            if (candidate) {
                currentRecord = await findWorkspaceTransactionByPrimaryKey({
                    ledgerId,
                    occurredAt: (candidate as { occurredAt: string }).occurredAt,
                    transactionId,
                });
            } else {
                currentRecord = (await queryAllPages(
                    entities.transactions.query.byTransaction({ ledgerId }),
                    { consistent: true },
                )).find(
                    (transaction) => transaction.transactionId === transactionId,
                );
            }
            break;
        }
        case "transactionAutoMatchRejection":
            currentRecord = (
                await entities.transactionAutoMatchRejections
                    .get({
                        ledgerId,
                        matchDecisionId: getWorkspaceRecordString(
                            record,
                            "matchDecisionId",
                        ),
                    })
                    .go({ consistent: true })
            ).data;
            break;
        case "transactionLine":
            currentRecord = (
                await entities.transactionLines
                    .get({
                        ledgerId,
                        lineId: getWorkspaceRecordString(record, "lineId"),
                        transactionId: getWorkspaceRecordString(
                            record,
                            "transactionId",
                        ),
                    })
                    .go({ consistent: true })
            ).data;
            break;
        default:
            currentRecord = await getWorkspaceRecordBeforeWrite({
                change: input.change,
                ledgerId,
            });
    }

    return currentRecord
        ? calculateWorkspaceRecordDigest({
              entityType: input.change.entityType,
              record: normalizeWorkspaceDigestRecord(
                  input.change.entityType,
                  currentRecord,
              ),
          })
        : undefined;
}

async function findWorkspaceTransactionByPrimaryKey(input: {
    ledgerId: string;
    occurredAt: string;
    transactionId: string;
}) {
    const { entities } = getBudgetedSchema();
    const result = await entities.transactions
        .query
        .byTransaction({ ledgerId: input.ledgerId })
        .begins({
            occurredAt: input.occurredAt,
            transactionId: input.transactionId,
        })
        .go({ consistent: true, limit: 1 });

    return result.data.find(
        (transaction) => transaction.transactionId === input.transactionId,
    );
}

async function applyBatchCountsBeforeWrite(input: {
    batch: WorkspaceMutationBatch;
    state: StoredWorkspaceState | WorkspaceStateUpdate;
}) {
    const counts = {
        ...createEmptyWorkspaceEntityCounts(),
        ...input.state.entityCounts,
    } as Record<WorkspaceEntityType, number>;
    const revisions = { ...input.state.entityRevisions } as Record<
        WorkspaceEntityType,
        string
    >;
    const accumulators = {
        ...input.state.entityDigestAccumulators,
    } as Record<WorkspaceEntityType, string>;
    const currentDigestByEntity = new Map<string, string | undefined>();
    const firstChangeByEntity = new Map<string, WorkspaceMutationChangeInput>();

    for (const change of input.batch.changes) {
        const entityKey = `${change.entityType}:${change.entityId}`;

        if (!firstChangeByEntity.has(entityKey)) {
            firstChangeByEntity.set(entityKey, change);
        }
    }

    await Promise.all(
        [...firstChangeByEntity].map(async ([entityKey, change]) => {
            currentDigestByEntity.set(
                entityKey,
                await getWorkspaceRecordDigestBeforeWrite({
                    change,
                    ledgerId: input.batch.ledgerId,
                }),
            );
        }),
    );

    for (const change of input.batch.changes) {
        const entityKey = `${change.entityType}:${change.entityId}`;
        const previousDigest = currentDigestByEntity.get(entityKey);
        const existed = previousDigest !== undefined;
        const nextDigest =
            change.operation === "upsert"
                ? calculateWorkspaceRecordDigest({
                      entityType: change.entityType,
                      record: normalizeWorkspaceDigestRecord(
                          change.entityType,
                          change.record,
                      ),
                  })
                : undefined;

        if (!existed && nextDigest) {
            counts[change.entityType] += 1;
        } else if (existed && !nextDigest) {
            counts[change.entityType] -= 1;
        }

        if (counts[change.entityType] < 0) {
            throw new Error(
                `Workspace state count for ${change.entityType} would become negative.`,
            );
        }

        if (previousDigest) {
            accumulators[change.entityType] = xorWorkspaceEntityDigestAccumulator(
                accumulators[change.entityType],
                previousDigest,
            );
        }
        if (nextDigest) {
            accumulators[change.entityType] = xorWorkspaceEntityDigestAccumulator(
                accumulators[change.entityType],
                nextDigest,
            );
        }
        currentDigestByEntity.set(entityKey, nextDigest);
        revisions[change.entityType] = encodeWorkspaceCursor({
            generation: input.batch.workspaceGeneration,
            revision: input.batch.workspaceRevision,
        });
    }

    const entityDigests = Object.fromEntries(
        WORKSPACE_ENTITY_TYPES.map((entityType) => [
            entityType,
            createWorkspaceEntityDigest({
                accumulator: accumulators[entityType],
                count: counts[entityType],
            }),
        ]),
    ) as NonNullable<WorkspaceKnowledge["entityDigests"]>;

    return { accumulators, counts, entityDigests, revisions };
}

async function addWorkspaceTransitionProofsBeforeWrite(
    batch: WorkspaceMutationBatch,
) {
    const currentDigestByEntity = new Map<string, string | undefined>();
    const changes: WorkspaceChange[] = [];

    for (const change of batch.changes) {
        const entityKey = `${change.entityType}:${change.entityId}`;
        let currentDigest = currentDigestByEntity.get(entityKey);

        if (!currentDigestByEntity.has(entityKey)) {
            currentDigest = await getWorkspaceRecordDigestBeforeWrite({
                change,
                ledgerId: batch.ledgerId,
            });
        }

        if (
            (change.previousRecordDigest ?? undefined) !== currentDigest
        ) {
            throw new Error(
                `Workspace ${change.operation} for ${change.entityType}:${change.entityId} does not match its current record.`,
            );
        }

        const completedChange: WorkspaceChange = {
            ...change,
            previousRecordDigest: currentDigest ?? null,
        };
        changes.push(completedChange);

        currentDigestByEntity.set(
            entityKey,
            completedChange.operation === "upsert"
                ? calculateWorkspaceRecordDigest({
                      entityType: completedChange.entityType,
                      record: normalizeWorkspaceDigestRecord(
                          completedChange.entityType,
                          completedChange.record,
                      ),
                  })
                : undefined,
        );
    }

    batch.changes = changes;
}

export async function prepareWorkspaceStateUpdateBeforeWrite(
    batch: WorkspaceMutationBatch,
): Promise<WorkspaceStateUpdate | null> {
    // Unit-level transaction service mocks from before workspaceState was
    // introduced intentionally omit this server-only entity. Real schemas
    // always include it; retaining this guard keeps those domain tests focused
    // on their own write behavior.
    if (!getBudgetedSchema().entities.workspaceStates) {
        return null;
    }

    await addWorkspaceTransitionProofsBeforeWrite(batch);

    const currentState = await getStoredWorkspaceState(batch.ledgerId);
    const isCurrentGeneration =
        currentState?.workspaceGeneration === batch.workspaceGeneration &&
        hasValidWorkspaceEntityRevisionTokens({
            entityRevisions: currentState.entityRevisions,
            workspaceGeneration: batch.workspaceGeneration,
            workspaceRevision: Math.max(0, batch.workspaceRevision - 1),
        }) &&
        hasLedgerLocalWorkspaceEntityProofs(currentState ?? {});
    const baseState =
        currentState && isCurrentGeneration
            ? currentState
            : createWorkspaceStateFromRecords({
                  ledgerId: batch.ledgerId,
                  oldestRetainedWorkspaceRevision:
                      Math.max(0, batch.workspaceRevision - 1),
                  records: await listWorkspaceRevisionRecordsForLedger({
                      activeLedgerId: batch.ledgerId,
                  }),
                  workspaceGeneration: batch.workspaceGeneration,
                  workspaceRevision: Math.max(0, batch.workspaceRevision - 1),
              });
    const { accumulators, counts, entityDigests, revisions } =
        await applyBatchCountsBeforeWrite({
        batch,
        state: baseState,
        });

    return createWorkspaceStateUpdate({
        createdAt: baseState.createdAt,
        entityDigestAccumulators: accumulators,
        entityDigests,
        entityCounts: counts,
        entityRevisions: revisions,
        ledgerId: batch.ledgerId,
        oldestRetainedWorkspaceRevision: isCurrentGeneration
            ? currentState!.oldestRetainedWorkspaceRevision
            : Math.max(0, batch.workspaceRevision - 1),
        workspaceGeneration: batch.workspaceGeneration,
        workspaceRevision: batch.workspaceRevision,
    });
}

async function rebuildWorkspaceStateUpdateAfterWrite(
    batch: WorkspaceMutationBatch,
) {
    const currentState = await getStoredWorkspaceState(batch.ledgerId);
    const records = await listWorkspaceRevisionRecordsForLedger({
        activeLedgerId: batch.ledgerId,
    });

    return createWorkspaceStateFromRecords({
        ledgerId: batch.ledgerId,
        oldestRetainedWorkspaceRevision:
            currentState?.workspaceGeneration === batch.workspaceGeneration
                ? currentState.oldestRetainedWorkspaceRevision
                : Math.max(0, batch.workspaceRevision - 1),
        records,
        workspaceGeneration: batch.workspaceGeneration,
        workspaceRevision: batch.workspaceRevision,
    });
}

export async function rebuildWorkspaceStateForGeneration(input: {
    ledger?: WorkspaceSnapshotRecords["ledgers"][number];
    ledgerId: string;
    workspaceGeneration: number;
    workspaceRevision: number;
}) {
    const records = await listWorkspaceRevisionRecordsForLedger({
        activeLedgerId: input.ledgerId,
    });

    if (input.ledger) {
        records.ledgers = [input.ledger];
    }

    return createWorkspaceStateFromRecords({
        ledgerId: input.ledgerId,
        oldestRetainedWorkspaceRevision: Math.max(
            0,
            input.workspaceRevision,
        ),
        records,
        workspaceGeneration: input.workspaceGeneration,
        workspaceRevision: input.workspaceRevision,
    });
}

export async function diagnoseWorkspaceState(ledgerId: string) {
    const [storedState, cursor] = await Promise.all([
        getStoredWorkspaceState(ledgerId),
        getWorkspaceCursorState(ledgerId),
    ]);
    const records = await listWorkspaceRevisionRecordsForLedger({
        activeLedgerId: ledgerId,
    });
    const recomputed = createWorkspaceStateFromRecords({
        ledgerId,
        oldestRetainedWorkspaceRevision:
            storedState?.oldestRetainedWorkspaceRevision ??
            cursor.workspaceRevision ??
            0,
        records,
        workspaceGeneration: cursor.workspaceGeneration,
        workspaceRevision: cursor.workspaceRevision ?? 0,
    });
    const expected = storedState
        ? createWorkspaceStateUpdate({
              createdAt: storedState.createdAt,
              entityDigestAccumulators: storedState.entityDigestAccumulators,
              entityDigests: storedState.entityDigests as NonNullable<
                  WorkspaceKnowledge["entityDigests"]
              >,
              entityCounts: storedState.entityCounts,
              entityRevisions: storedState.entityRevisions,
              ledgerId: storedState.ledgerId,
              oldestRetainedWorkspaceRevision:
                  storedState.oldestRetainedWorkspaceRevision,
              workspaceGeneration: storedState.workspaceGeneration,
              workspaceRevision: storedState.workspaceRevision,
          })
        : null;

    return {
        cursor,
        contentDigests: calculateWorkspaceEntityDigests(records),
        drift: {
            entityDigests:
                expected?.entityDigestsJson !== recomputed.entityDigestsJson,
            entityCounts: expected?.entityCountsJson !== recomputed.entityCountsJson,
            entityRevisionTokens:
                !expected ||
                !hasValidWorkspaceEntityRevisionTokens({
                    entityRevisions: expected.entityRevisions,
                    workspaceGeneration: cursor.workspaceGeneration,
                    workspaceRevision: cursor.workspaceRevision ?? 0,
                }),
            generation:
                expected?.workspaceGeneration !== recomputed.workspaceGeneration,
            revision: expected?.workspaceRevision !== recomputed.workspaceRevision,
        },
        isCurrent:
            expected !== null &&
            expected.entityCountsJson === recomputed.entityCountsJson &&
            expected.entityDigestsJson === recomputed.entityDigestsJson &&
            hasValidWorkspaceEntityRevisionTokens({
                entityRevisions: expected.entityRevisions,
                workspaceGeneration: cursor.workspaceGeneration,
                workspaceRevision: cursor.workspaceRevision ?? 0,
            }) &&
            expected.workspaceGeneration === recomputed.workspaceGeneration &&
            expected.workspaceRevision === recomputed.workspaceRevision,
        recomputed,
        stored: expected,
    };
}

/**
 * Rebuilds the materialized workspace proofs from canonical ledger records.
 *
 * A new generation makes every cached client snapshot obsolete, so clients
 * recover with a full snapshot instead of attempting to apply changes from an
 * invalid state generation.
 */
export async function repairWorkspaceState(
    ledgerId: string,
    options: { workspaceSyncProtocolVersion?: number } = {},
) {
    await ensureWorkspaceExplicitMutationFenceIsClear(ledgerId);

    const { entities, service } = getBudgetedSchema();
    const ledgerResult = await entities.ledgers
        .get({ workspaceId: GLOBAL_WORKSPACE_ID, ledgerId })
        .go({ consistent: true });
    const ledger = ledgerResult.data;

    if (!ledger) {
        throw new Error("Workspace repair ledger is missing.");
    }

    const expectedWorkspaceGeneration = ledger.workspaceGeneration;
    const expectedWorkspaceRevision = ledger.workspaceRevision;

    if (
        !Number.isSafeInteger(expectedWorkspaceGeneration) ||
        expectedWorkspaceGeneration < 1 ||
        !Number.isSafeInteger(expectedWorkspaceRevision) ||
        expectedWorkspaceRevision < 0
    ) {
        throw new Error("Workspace repair revision metadata is invalid.");
    }

    const workspaceGeneration = expectedWorkspaceGeneration + 1;
    const workspaceRevision = 0;
    const updatedAt = new Date().toISOString();
    const nextLedger = {
        ...ledger,
        updatedAt,
        workspaceGeneration,
        workspaceRevision,
        workspaceSyncProtocolVersion:
            options.workspaceSyncProtocolVersion ??
            ledger.workspaceSyncProtocolVersion ??
            1,
    };
    const workspaceState = await rebuildWorkspaceStateForGeneration({
        ledger: nextLedger,
        ledgerId,
        workspaceGeneration,
        workspaceRevision,
    });

    await service.transaction
        .write((transactionEntities) => [
            transactionEntities.workspaceStates
                .put(toWorkspaceStateRecord(workspaceState))
                .commit(),
            transactionEntities.ledgers
                .update({ workspaceId: GLOBAL_WORKSPACE_ID, ledgerId })
                .set({
                    updatedAt,
                    workspaceGeneration,
                    workspaceRevision,
                    workspaceSyncProtocolVersion:
                        nextLedger.workspaceSyncProtocolVersion,
                })
                .where((attributes, operations) =>
                    `${operations.eq(
                        attributes.workspaceGeneration,
                        expectedWorkspaceGeneration,
                    )} AND ${operations.eq(
                        attributes.workspaceRevision,
                        expectedWorkspaceRevision,
                    )}`,
                )
                .commit(),
        ])
        .go();

    return {
        previousWorkspaceGeneration: expectedWorkspaceGeneration,
        previousWorkspaceRevision: expectedWorkspaceRevision,
        workspaceGeneration,
        workspaceRevision,
        workspaceSyncProtocolVersion:
            nextLedger.workspaceSyncProtocolVersion,
    };
}

export async function cutoverWorkspaceSyncV2(ledgerId: string) {
    await ensureWorkspaceExplicitMutationFenceIsClear(ledgerId);
    const { entities } = getBudgetedSchema();
    const operations = await queryAllPages(
        entities.workspaceMutationOperations.query.byOperation({
            ledgerId,
            workspaceId: GLOBAL_WORKSPACE_ID,
        }),
        { consistent: true },
    );
    const incompleteOperation = operations.find(
        (operation) => operation.status === "running",
    );

    if (incompleteOperation) {
        throw new HttpError(
            409,
            "workspace_mutation_in_progress",
            `Workspace synchronization cannot be upgraded while mutation ${incompleteOperation.mutationId} is incomplete.`,
        );
    }

    return repairWorkspaceState(ledgerId, {
        workspaceSyncProtocolVersion: WORKSPACE_SYNC_PROTOCOL_VERSION,
    });
}

export function toWorkspaceMutationReceiptRecord(batch: WorkspaceMutationBatch) {
    return {
        batchId: batch.batchId,
        changeCursor: batch.changeCursor,
        expiresAt: batch.expiresAt,
        ledgerId: batch.ledgerId,
        mutationId: batch.mutationId,
        mutationType: batch.mutationType,
        workspaceId: GLOBAL_WORKSPACE_ID,
    };
}

export function createWorkspaceMutationOperation(input: {
    completedStepCount: number;
    createdAt?: string;
    ledgerId: string;
    mutationId: string;
    mutationType: string;
    operation: unknown;
    status: WorkspaceMutationOperation["status"];
}): WorkspaceMutationOperation {
    assertWorkspaceMutationJsonFits({
        payload: input.operation,
        type: "operation checkpoint",
    });
    const updatedAt = new Date().toISOString();

    return {
        completedStepCount: input.completedStepCount,
        createdAt: input.createdAt ?? updatedAt,
        expiresAt: getWorkspaceChangeExpiresAt(new Date(updatedAt)),
        ledgerId: input.ledgerId,
        mutationId: input.mutationId,
        mutationType: input.mutationType,
        operation: input.operation,
        status: input.status,
        updatedAt,
    };
}

function assertWorkspaceMutationJsonFits(input: {
    payload: unknown;
    type: string;
}) {
    const payloadSize = new TextEncoder().encode(
        stableStringify(input.payload),
    ).byteLength;

    if (payloadSize > MAX_WORKSPACE_MUTATION_JSON_BYTES) {
        throw new HttpError(
            422,
            "workspace_mutation_too_large",
            `This workspace mutation ${input.type} is too large to store safely. Split the request into smaller operations.`,
        );
    }
}

export function toWorkspaceMutationOperationRecord(
    operation: WorkspaceMutationOperation,
) {
    return {
        completedStepCount: operation.completedStepCount,
        createdAt: operation.createdAt,
        expiresAt: operation.expiresAt,
        ledgerId: operation.ledgerId,
        mutationId: operation.mutationId,
        mutationType: operation.mutationType,
        operationJson: stableStringify(operation.operation),
        status: operation.status,
        updatedAt: operation.updatedAt,
        workspaceId: GLOBAL_WORKSPACE_ID,
    };
}

export async function persistWorkspaceMutationOperation(
    operation: WorkspaceMutationOperation,
) {
    const { entities } = getBudgetedSchema();

    await entities.workspaceMutationOperations
        .put(toWorkspaceMutationOperationRecord(operation))
        .go();
}

export async function findWorkspaceMutationOperation(input: {
    ledgerId: string;
    mutationId: string;
    mutationType: string;
}): Promise<WorkspaceMutationOperation | null> {
    const { entities } = getBudgetedSchema();
    const result = await entities.workspaceMutationOperations
        .get({
            ledgerId: input.ledgerId,
            mutationId: input.mutationId,
            workspaceId: GLOBAL_WORKSPACE_ID,
        })
        .go({ consistent: true });
    const operation = result.data;

    if (!operation) {
        return null;
    }

    if (operation.mutationType !== input.mutationType) {
        throw new HttpError(
            409,
            "workspace_mutation_mismatch",
            "Mutation IDs cannot be reused for a different operation.",
        );
    }

    return {
        completedStepCount: operation.completedStepCount,
        createdAt: operation.createdAt,
        expiresAt: operation.expiresAt,
        ledgerId: operation.ledgerId,
        mutationId: operation.mutationId,
        mutationType: operation.mutationType,
        operation: JSON.parse(operation.operationJson),
        status: operation.status,
        updatedAt: operation.updatedAt,
    };
}

export async function findWorkspaceMutationBatch(input: {
    ledgerId: string;
    mutationId: string;
    mutationType: string;
}): Promise<WorkspaceMutationBatch | null> {
    const { entities } = getBudgetedSchema();
    const receiptResult = await entities.workspaceMutationReceipts
        .get({
            ledgerId: input.ledgerId,
            mutationId: input.mutationId,
            workspaceId: GLOBAL_WORKSPACE_ID,
        })
        .go({ consistent: true });
    const receipt = receiptResult.data;

    if (!receipt) {
        return null;
    }

    if (receipt.mutationType !== input.mutationType) {
        throw new HttpError(
            409,
            "workspace_mutation_mismatch",
            "Mutation IDs cannot be reused for a different operation.",
        );
    }

    const batchResult = await entities.workspaceMutationBatches
        .get({
            batchId: receipt.batchId,
            changeCursor: receipt.changeCursor,
            ledgerId: input.ledgerId,
            workspaceId: GLOBAL_WORKSPACE_ID,
        })
        .go({ consistent: true });
    const record = batchResult.data;

    if (!record) {
        throw new Error("Workspace mutation receipt is missing its change batch.");
    }

    const changes = JSON.parse(record.changesJson) as WorkspaceChange[];

    return {
        batchId: record.batchId,
        changeCursor: record.changeCursor,
        changeCount: record.changeCount ?? changes.length,
        changes,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        ledgerId: record.ledgerId,
        mutationId: record.mutationId,
        mutationType: record.mutationType,
        response: JSON.parse(record.responseJson),
        workspaceGeneration: record.workspaceGeneration,
        workspaceRevision: record.workspaceRevision ?? 0,
    };
}

export async function executeWorkspaceMutationWithReplay<T>(input: {
    execute: () => Promise<T>;
    ledgerId: string;
    mutationId: string;
    mutationType: string;
    validateExistingMutation?: () => Promise<void>;
}): Promise<
    | { batch: WorkspaceMutationBatch; result: null }
    | { batch: null; result: T }
> {
    await input.validateExistingMutation?.();

    const existingBatch = await findWorkspaceMutationBatch({
        ledgerId: input.ledgerId,
        mutationId: input.mutationId,
        mutationType: input.mutationType,
    });

    if (existingBatch) {
        return { batch: existingBatch, result: null };
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            return { batch: null, result: await input.execute() };
        } catch (error) {
            // A concurrent request using the same id may have won the atomic
            // receipt write. In that case, return its authoritative result.
            const replayBatch = await findWorkspaceMutationBatch({
                ledgerId: input.ledgerId,
                mutationId: input.mutationId,
                mutationType: input.mutationType,
            });

            if (replayBatch) {
                return { batch: replayBatch, result: null };
            }

            if (attempt < 2 && isWorkspaceRevisionConflict(error)) {
                continue;
            }

            throw error;
        }
    }

    throw new Error("Workspace mutation retry attempts were exhausted.");
}

async function publishWorkspaceChangesAsRevisionedBatch(input: {
    changes: WorkspaceMutationChangeInput[];
    ledgerId: string;
}) {
    assertWorkspaceChangesHaveTransitionProofs(input.changes);

    const { service } = getBudgetedSchema();
    let lastError: unknown;

    for (let attempt = 0; attempt < 3; attempt += 1) {
        const workspaceVersion = await getNextWorkspaceMutationVersion(
            input.ledgerId,
        );
        const batch = createWorkspaceMutationBatch({
            changes: input.changes,
            ledgerId: input.ledgerId,
            mutationId: `workspace.publish:${ulid()}`,
            mutationType: "workspace.publish",
            response: {},
            ...workspaceVersion,
        });
        // Generic publishers run after their domain write. Rebuild once here
        // for older, low-frequency routes that have not yet supplied a
        // pre-write state delta; transaction writes use the bounded path below.
        const workspaceState = await rebuildWorkspaceStateUpdateAfterWrite(
            batch,
        );

        try {
            const transactionResult = await service.transaction
                .write((entities) => [
                    entities.workspaceMutationBatches
                        .put(toWorkspaceMutationBatchRecord(batch))
                        .commit(),
                    entities.workspaceStates
                        .put(toWorkspaceStateRecord(workspaceState))
                        .commit(),
                    entities.ledgers
                        .update({
                            ledgerId: input.ledgerId,
                            workspaceId: GLOBAL_WORKSPACE_ID,
                        })
                        .set({
                            workspaceGeneration: batch.workspaceGeneration,
                            workspaceRevision: batch.workspaceRevision,
                        })
                        .where((attributes, operations) => {
                            const generationCondition = operations.eq(
                                attributes.workspaceGeneration,
                                batch.expectedWorkspaceGeneration!,
                            );
                            const revisionCondition =
                                batch.expectedWorkspaceRevision === undefined
                                    ? operations.notExists(
                                          attributes.workspaceRevision,
                                      )
                                    : operations.eq(
                                          attributes.workspaceRevision,
                                          batch.expectedWorkspaceRevision,
                                      );

                            return `${generationCondition} AND ${revisionCondition}`;
                        })
                        .commit(),
                ])
                .go();
            assertWorkspaceTransactionCommitted(transactionResult);

            return batch;
        } catch (error) {
            lastError = error;

            if (!isWorkspaceRevisionConflict(error)) {
                throw error;
            }
        }
    }

    throw lastError ?? new Error("Unable to allocate a workspace revision.");
}

export async function persistWorkspaceChanges(input: {
    activeLedgerId: string;
    changes: WorkspaceMutationChangeInput[];
}) {
    const { persistedChanges, unpublishedChanges } =
        partitionWorkspaceChangesForPersistence(input.changes);
    if (unpublishedChanges.length === 0) {
        return persistedChanges;
    }
    const batch = await publishWorkspaceChangesAsRevisionedBatch({
        changes: unpublishedChanges,
        ledgerId: input.activeLedgerId,
    });

    return [...persistedChanges, ...batch.changes].sort(
        compareWorkspaceChangesInCommitOrder,
    );
}

export function partitionWorkspaceChangesForPersistence(
    changes: WorkspaceMutationChangeInput[],
) {
    return {
        persistedChanges: changes.filter(isPersistedWorkspaceChange),
        unpublishedChanges: changes.filter(
            (change) => !isPersistedWorkspaceChange(change),
        ),
    };
}

function isPersistedWorkspaceChange(
    change: WorkspaceMutationChangeInput,
): change is WorkspaceChange {
    return (
        "batchId" in change &&
        "changedAt" in change &&
        "changeId" in change &&
        "expiresAt" in change
    );
}

export async function trackWorkspaceMutation<T>(
    user: CurrentWorkspaceUser,
    mutate: () => Promise<T>,
): Promise<WorkspaceMutationResult<T>> {
    const fenceToken = await beginWorkspaceExplicitMutation(user.activeLedgerId);
    let fenceActive = true;

    try {
        const [before, beforeLedgers] = await Promise.all([
            readTrackedWorkspaceRecords({
                activeLedgerId: user.activeLedgerId,
                includeLedgerScoped: true,
            }),
            listWorkspaceLedgers(),
        ]);
        const result = await mutate();
        const userAccount = await findUserAccountById(user.userId);
        const nextActiveLedgerId =
            userAccount?.activeLedgerId ?? user.activeLedgerId;
        const activeLedgerChanged = nextActiveLedgerId !== user.activeLedgerId;
        const afterLedgers = await listWorkspaceLedgers();
        const nextActiveLedger = afterLedgers.find(
            (ledger) => ledger.ledgerId === nextActiveLedgerId,
        );
        const after = activeLedgerChanged
            ? []
            : await readTrackedWorkspaceRecords({
                  activeLedgerId: nextActiveLedgerId,
                  includeLedgerScoped: true,
              });
        const changes = activeLedgerChanged
            ? []
            : diffTrackedRecords({ before, after });

        const workspaceChanges = await persistWorkspaceChanges({
            activeLedgerId: nextActiveLedgerId,
            changes,
        });
        await persistNonActiveLedgerCatalogChanges({
            activeLedgerChanged,
            activeLedgerId: user.activeLedgerId,
            afterLedgers,
            beforeLedgers,
            nextActiveLedgerId,
        });
        await completeWorkspaceExplicitMutation({
            ledgerId: user.activeLedgerId,
            token: fenceToken,
        });
        fenceActive = false;

        const knowledgeUser: CurrentWorkspaceUser = {
            activeLedgerId: nextActiveLedgerId,
            activeLedgerName: nextActiveLedger?.name ?? user.activeLedgerName,
            userId: user.userId,
        };

        return {
            changes: workspaceChanges,
            knowledge: await buildWorkspaceKnowledge(knowledgeUser),
            result,
        };
    } catch (error) {
        if (fenceActive) {
            await recoverWorkspaceExplicitMutation({
                ledgerId: user.activeLedgerId,
                token: fenceToken,
            }).catch(() => undefined);
        }
        throw error;
    }
}

export function findChangedLedgerCatalogRecords(input: {
    afterLedgers: WorkspaceLedgerRecord[];
    beforeLedgers: WorkspaceLedgerRecord[];
}) {
    return diffTrackedRecords({
        after: toTrackedRecords({
            includeLedgerScoped: false,
            ledgers: input.afterLedgers,
        }),
        before: toTrackedRecords({
            includeLedgerScoped: false,
            ledgers: input.beforeLedgers,
        }),
    });
}

async function persistNonActiveLedgerCatalogChanges(input: {
    activeLedgerChanged: boolean;
    activeLedgerId: string;
    afterLedgers: WorkspaceLedgerRecord[];
    beforeLedgers: WorkspaceLedgerRecord[];
    nextActiveLedgerId: string;
}) {
    const changes = findChangedLedgerCatalogRecords(input).filter((change) => {
        if (change.operation === "delete") {
            return false;
        }

        if (
            !input.activeLedgerChanged &&
            change.entityId === input.activeLedgerId
        ) {
            return false;
        }

        return !(
            input.activeLedgerChanged &&
            change.entityId === input.nextActiveLedgerId
        );
    });

    for (const change of changes) {
        const fenceToken = await beginWorkspaceExplicitMutation(change.entityId);
        let fenceActive = true;

        try {
            await persistWorkspaceChanges({
                activeLedgerId: change.entityId,
                changes: [change],
            });
            await completeWorkspaceExplicitMutation({
                ledgerId: change.entityId,
                token: fenceToken,
            });
            fenceActive = false;
        } catch (error) {
            if (fenceActive) {
                await recoverWorkspaceExplicitMutation({
                    ledgerId: change.entityId,
                    token: fenceToken,
                }).catch(() => undefined);
            }
            throw error;
        }
    }
}

function toPublicWorkspaceMutationBatch(change: {
    changesJson: string;
}): WorkspaceChange[] {
    return JSON.parse(change.changesJson) as WorkspaceChange[];
}

export function getWorkspaceRevisionBatchRange(
    afterRevision: number,
    toRevision: number,
) {
    if (afterRevision > toRevision) {
        throw new Error("Workspace revision ranges cannot move backwards.");
    }

    // Batch IDs are ULIDs. A maximal trailing value excludes the completed
    // `afterRevision` batch and includes every batch at `toRevision`.
    return {
        end: {
            batchId: "\uffff",
            workspaceRevisionKey: toWorkspaceRevisionKey(toRevision),
        },
        start: {
            batchId: "\uffff",
            workspaceRevisionKey: toWorkspaceRevisionKey(afterRevision),
        },
    };
}

export function getOldestUsableWorkspaceRevision(input: {
    batches: Array<{
        expiresAt: number;
        workspaceGeneration: number;
        workspaceRevision: number;
    }>;
    now?: Date;
    workspaceGeneration: number;
    workspaceRevision: number;
}) {
    const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
    const earliest = input.batches
        .filter(
            (batch) =>
                batch.workspaceGeneration === input.workspaceGeneration &&
                batch.workspaceRevision <= input.workspaceRevision &&
                batch.expiresAt > nowSeconds,
        )
        .map((batch) => batch.workspaceRevision)
        .sort((left, right) => left - right)[0];

    return earliest === undefined
        ? input.workspaceRevision
        : Math.max(0, earliest - 1);
}

async function advanceWorkspaceRetentionBoundary(input: {
    ledgerId: string;
    workspaceGeneration: number;
    workspaceRevision: number;
}) {
    const { entities } = getBudgetedSchema();
    const batches = await queryAllPages(
        entities.workspaceMutationBatches.query.byRevision({
            workspaceId: GLOBAL_WORKSPACE_ID,
            ledgerId: input.ledgerId,
        }),
    );
    const boundary = getOldestUsableWorkspaceRevision({
        batches,
        workspaceGeneration: input.workspaceGeneration,
        workspaceRevision: input.workspaceRevision,
    });
    const state = await getStoredWorkspaceState(input.ledgerId);

    if (!state || state.oldestRetainedWorkspaceRevision >= boundary) {
        return state;
    }

    await entities.workspaceStates
        .update({
            ledgerId: input.ledgerId,
            stateId: WORKSPACE_STATE_ID,
            workspaceId: GLOBAL_WORKSPACE_ID,
        })
        .set({ oldestRetainedWorkspaceRevision: boundary })
        .where((attributes, operations) =>
            operations.lt(
                attributes.oldestRetainedWorkspaceRevision,
                boundary,
            ),
        )
        .go()
        .catch(() => undefined);

    return getStoredWorkspaceState(input.ledgerId);
}

export async function listWorkspaceChangesAfter(input: {
    after: string | null;
    user: CurrentWorkspaceUser;
}): Promise<WorkspaceSyncResult> {
    const knowledge = await buildWorkspaceKnowledge(input.user);

    if (input.after === null) {
        return {
            changes: [],
            fromCursor: "",
            knowledge,
            requiresSnapshot: true,
            toCursor: knowledge.changeCursor,
        };
    }

    const afterCursor = parseWorkspaceCursor(input.after);

    if (
        !afterCursor ||
        afterCursor.generation !== knowledge.workspaceGeneration ||
        afterCursor.revision > knowledge.workspaceRevision! ||
        afterCursor.revision <
            knowledge.oldestRetainedWorkspaceRevision!
    ) {
        return {
            changes: [],
            fromCursor: input.after,
            knowledge,
            requiresSnapshot: true,
            toCursor: knowledge.changeCursor,
        };
    }

    const { entities } = getBudgetedSchema();
    const batchRange = getWorkspaceRevisionBatchRange(
        afterCursor.revision,
        knowledge.workspaceRevision!,
    );
    const batchResult = await queryAllPages(
        entities.workspaceMutationBatches.query
            .byRevision({
                workspaceId: GLOBAL_WORKSPACE_ID,
                ledgerId: input.user.activeLedgerId,
            })
            .between(batchRange.start, batchRange.end),
    );
    if (
        !hasContiguousWorkspaceRevisions({
            afterRevision: afterCursor.revision,
            batches: batchResult,
            workspaceGeneration: knowledge.workspaceGeneration!,
            workspaceRevision: knowledge.workspaceRevision!,
        })
    ) {
            const correctedState = await advanceWorkspaceRetentionBoundary({
                ledgerId: input.user.activeLedgerId,
                workspaceGeneration: knowledge.workspaceGeneration!,
                workspaceRevision: knowledge.workspaceRevision!,
            });
            const correctedKnowledge = correctedState
                ? createWorkspaceKnowledge({
                      activeLedgerId: knowledge.activeLedgerId,
                      changeCursor: knowledge.changeCursor,
                      entityCounts: correctedState.entityCounts,
                      entityDigests: correctedState.entityDigests,
                      entityRevisions: correctedState.entityRevisions,
                      oldestRetainedWorkspaceRevision:
                          correctedState.oldestRetainedWorkspaceRevision,
                      workspaceGeneration: correctedState.workspaceGeneration,
                      workspaceRevision: correctedState.workspaceRevision,
                  })
                : knowledge;
            return {
                changes: [],
                fromCursor: input.after,
                knowledge: correctedKnowledge,
                requiresSnapshot: true,
                toCursor: correctedKnowledge.changeCursor,
            };
    }

    if (
        batchResult.some((batch) =>
            !hasCompleteWorkspaceBatchManifest(
                toPublicWorkspaceMutationBatch(batch),
            ),
        )
    ) {
        return {
            changes: [],
            fromCursor: input.after,
            knowledge,
            requiresSnapshot: true,
            toCursor: knowledge.changeCursor,
        };
    }

    const changes = batchResult
            .filter(
                (batch) =>
                    batch.workspaceGeneration === knowledge.workspaceGeneration &&
                    batch.workspaceRevision <= knowledge.workspaceRevision!,
            )
            .sort(
                (left, right) =>
                    left.workspaceRevision - right.workspaceRevision,
            )
            .flatMap(toPublicWorkspaceMutationBatch)
            .sort(compareWorkspaceChangesInCommitOrder);

    return {
        changes,
        fromCursor: input.after,
        knowledge,
        requiresSnapshot: false,
        toCursor: knowledge.changeCursor,
    };
}

export async function listWorkspaceCommitsAfter(input: {
    after: string | null;
    user: CurrentWorkspaceUser;
}): Promise<WorkspaceCommitSyncResult> {
    const currentVersion = await buildWorkspaceVersion(input.user);
    const requestedVersion = parseWorkspaceVersionCursor({
        cursor: input.after,
        ledgerId: input.user.activeLedgerId,
    });

    if (
        !requestedVersion ||
        requestedVersion.generation !== currentVersion.generation ||
        requestedVersion.revision > currentVersion.revision ||
        requestedVersion.revision < currentVersion.oldestRetainedRevision
    ) {
        return {
            commits: [],
            fromVersion: requestedVersion ?? currentVersion,
            requiresSnapshot: true,
            toVersion: currentVersion,
        };
    }

    const result = await listWorkspaceChangesAfter(input);
    const toVersion = workspaceKnowledgeToVersion(result.knowledge);
    const fromVersion =
        parseWorkspaceVersionCursor({
            cursor: input.after,
            ledgerId: input.user.activeLedgerId,
        }) ?? toVersion;

    if (result.requiresSnapshot) {
        return {
            commits: [],
            fromVersion,
            requiresSnapshot: true,
            toVersion,
        };
    }

    return {
        commits: createWorkspaceCommits({
            changes: result.changes,
            ledgerId: input.user.activeLedgerId,
        }),
        fromVersion,
        requiresSnapshot: false,
        toVersion,
    };
}
