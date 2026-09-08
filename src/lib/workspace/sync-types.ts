import type { TransactionImportActivityRecord } from "@/features/transaction-importers/models/transaction-importer-contract";
import type { AccountType } from "@/modules/accounts/account-types";
import type { BudgetCategoryAllocationCadence } from "@/modules/budgeting/allocation-schedule";

export const WORKSPACE_CHANGE_RETENTION_DAYS = 30;
export const WORKSPACE_KNOWLEDGE_HEADER = "X-Budgeted-Knowledge";
export const WORKSPACE_SYNC_PROTOCOL_VERSION = 2 as const;

export type WorkspaceCursor = {
    generation: number;
    revision: number;
};

/**
 * The only workspace-wide synchronization state a browser needs to retain.
 * Domain conflict detection remains record-specific on the server.
 */
export type WorkspaceVersion = {
    cursor: string;
    generation: number;
    ledgerId: string;
    protocolVersion: typeof WORKSPACE_SYNC_PROTOCOL_VERSION;
    revision: number;
};

export type WorkspaceEntityType =
    | "account"
    | "allocationFundingSource"
    | "amazonOrder"
    | "amazonOrderIntegration"
    | "amazonOrderSyncRun"
    | "budgetCategory"
    | "budgetGroup"
    | "budgetPeriod"
    | "categoryAllocation"
    | "ledger"
    | "ledgerPosting"
    | "plaidAccountLink"
    | "plaidTransactionSync"
    | "transaction"
    | "transactionImportActivity"
    | "transactionAutoMatchRejection"
    | "transactionLine"
    | "transactionTemplate"
    | "venmoAccountMapping"
    | "venmoIntegration";

export type WorkspaceEntityCounts = Partial<Record<WorkspaceEntityType, number>>;

export type WorkspaceKnowledge = {
    activeLedgerId: string;
    /**
     * Presentation metadata identifying the deployed application build. It is
     * deliberately excluded from workspace synchronization correctness.
     */
    applicationReleaseTag?: string;
    applicationVersion?: string;
    changeCursor: string;
    entityCounts: WorkspaceEntityCounts;
    entityDigests: WorkspaceEntityDigests;
    entityRevisions: WorkspaceEntityRevisions;
    generatedAt: string;
    oldestRetainedWorkspaceRevision: number;
    retainedChangesAfter: string;
    revision: string;
    workspaceGeneration: number;
    workspaceRevision: number;
};

export type WorkspaceTransactionHydration = "configuration" | "full";

export type WorkspaceEntityRevisions = Partial<
    Record<WorkspaceEntityType, string>
>;

export type WorkspaceEntityDigests = Partial<
    Record<WorkspaceEntityType, string>
>;

export type WorkspaceChangeOperation = "delete" | "upsert";

export type WorkspaceRecordChange = {
    entityId: string;
    entityType: WorkspaceEntityType;
    operation: WorkspaceChangeOperation;
    record: unknown | null;
};

export type WorkspaceCommit = {
    changes: WorkspaceRecordChange[];
    commitId: string;
    committedAt: string;
    fromVersion: WorkspaceVersion;
    toVersion: WorkspaceVersion;
};

export type WorkspaceSyncEnvelope = {
    commits: WorkspaceCommit[];
    fromVersion: WorkspaceVersion;
    toVersion: WorkspaceVersion;
};

export type WorkspaceVersionResult = WorkspaceVersion & {
    applicationReleaseTag?: string;
    applicationVersion?: string;
    oldestRetainedRevision: number;
};

export type WorkspaceCommitSyncResult =
    | {
          commits: WorkspaceCommit[];
          fromVersion: WorkspaceVersion;
          requiresSnapshot: false;
          toVersion: WorkspaceVersion;
      }
    | {
          commits: [];
          fromVersion: WorkspaceVersion;
          requiresSnapshot: true;
          toVersion: WorkspaceVersion;
      };

export type WorkspaceChange = WorkspaceRecordChange & {
    batchId: string;
    changedAt: string;
    changeId: string;
    expiresAt: number;
    /**
     * Server proof for the state this transition replaces. `null` explicitly
     * proves that the record did not exist; a digest proves the prior record.
     */
    previousRecordDigest: string | null;
    /** The complete number of changes in this durable batch. */
    changeCount: number;
    changeIndex: number;
    workspaceGeneration: number;
    workspaceRevision: number;
};

export function hasCompleteWorkspaceBatchManifest(
    changes: readonly WorkspaceChange[],
) {
    if (changes.length === 0) {
        return false;
    }

    const first = changes[0]!;
    const expectedCount = first.changeCount;

    if (
        !Number.isSafeInteger(first.workspaceGeneration) ||
        first.workspaceGeneration! < 1 ||
        !Number.isSafeInteger(first.workspaceRevision) ||
        first.workspaceRevision! < 0 ||
        !Number.isSafeInteger(expectedCount) ||
        expectedCount! < 1
    ) {
        return false;
    }

    const indexes = changes
        .map((change) => change.changeIndex)
        .sort((left, right) => (left ?? -1) - (right ?? -1));

    return (
        changes.length === expectedCount &&
        changes.every(
            (change) =>
                change.batchId === first.batchId &&
                change.workspaceGeneration === first.workspaceGeneration &&
                change.workspaceRevision === first.workspaceRevision &&
                change.changeCount === expectedCount &&
                Number.isSafeInteger(change.changeIndex) &&
                change.changeIndex! >= 0 &&
                change.changeIndex! < expectedCount!,
        ) &&
        indexes.every((index, position) => index === position)
    );
}

export type WorkspaceSyncResult =
    | {
        changes: WorkspaceChange[];
        fromCursor: string;
        knowledge: WorkspaceKnowledge;
        requiresSnapshot: false;
        toCursor: string;
      }
    | {
        changes: [];
        fromCursor: string;
        knowledge: WorkspaceKnowledge;
        requiresSnapshot: true;
        toCursor: string;
      };

export type WorkspaceAccountRecord = {
    accountId: string;
    accountType: AccountType;
    balanceCents: number;
    createdAt: string;
    ledgerAccountId: string;
    name: string;
    openedOn: string;
    openingBalanceCents: number;
    plaidAccountLinkId?: string;
    plaidAccountMask?: string;
    plaidAccountName?: string;
    plaidAccountSubtype?: string;
    plaidBalanceAvailableCents?: number;
    plaidBalanceCurrentCents?: number;
    plaidBalanceIsoCurrencyCode?: string;
    plaidBalanceLastSyncedAt?: string;
    plaidBalanceLimitCents?: number;
    plaidBalanceSyncError?: string;
    plaidBalanceSyncStatus?: "failed" | "never" | "succeeded";
    plaidBalanceUnofficialCurrencyCode?: string;
    plaidInstitutionLogo?: string;
    plaidInstitutionName?: string;
    plaidInstitutionPrimaryColor?: string;
    plaidInstitutionUrl?: string;
    plaidLastSyncedAt?: string;
    plaidLastSyncStatus?: "failed" | "never" | "succeeded";
    plaidLinkStatus?: "disabled" | "error" | "linked";
    plaidSyncStartDate?: string;
    updatedAt: string;
    ledgerId: string;
};

export type WorkspaceBudgetCategoryRecord = {
    allocationCadence?: BudgetCategoryAllocationCadence;
    allocationStartMonth?: number;
    autoAssignSourceEnabled?: boolean;
    autoAssignSourceSortOrder?: number;
    categoryId: string;
    categoryType?: "spending" | "savings";
    createdAt: string;
    defaultAssignedCents: number;
    groupId: string;
    isIncomeCategory: boolean;
    ledgerAccountId: string;
    name: string;
    sortOrder: number;
    status: "active" | "archived";
    systemCategoryKey?: "startingBalances";
    updatedAt: string;
    ledgerId: string;
};

export type WorkspaceBudgetGroupRecord = {
    createdAt: string;
    groupId: string;
    name: string;
    sortOrder: number;
    status: "active" | "archived";
    updatedAt: string;
    ledgerId: string;
};

export type WorkspaceBudgetPeriodRecord = {
    availableToBudgetCents?: number;
    carryForwardFromPeriodId?: string;
    createdAt: string;
    currency: "USD";
    endsOn: string;
    periodId: string;
    startsOn: string;
    status: "open" | "closed";
    updatedAt: string;
    ledgerId: string;
};

export type WorkspaceCategoryAllocationRecord = {
    allocationId: string;
    assignedCents: number;
    categoryId: string;
    periodId: string;
    updatedAt: string;
    ledgerId: string;
};

export type WorkspaceAllocationFundingSourceRecord = {
    allocationId: string;
    amountCents: number;
    categoryId: string;
    createdAt: string;
    fundingSourceId: string;
    periodId: string;
    sourceId: string;
    sourceType: "account" | "incomeCategory" | "budgetCategory";
    updatedAt: string;
    ledgerId: string;
};

export type WorkspaceAmazonOrderIntegrationRecord = {
    accountId?: string;
    createdAt: string;
    integrationId: string;
    lastError?: string;
    latestBudgetedImportAt?: string;
    latestBudgetedImportStatus: "never" | "running" | "succeeded" | "failed";
    latestScraperState?: string;
    latestScraperSyncId?: string;
    latestScraperSyncedAt?: string;
    latestSyncRunId?: string;
    updatedAt: string;
    ledgerId: string;
};

export type WorkspaceAmazonOrderRecord = {
    amazonOrderId: string;
    firstImportedAt: string;
    grandTotalCents?: number;
    itemSummary: string;
    itemTitlesJson: string;
    lastImportedAt: string;
    ledgerId: string;
    orderNumber: string;
    orderPlacedDate?: string;
    sourcePayloadJson: string;
    sourceSyncId?: string;
    updatedAt: string;
};

export type WorkspaceAmazonOrderSyncRunRecord = {
    autoMatchedCount?: number;
    completedAt?: string;
    conflictCount?: number;
    error?: string;
    importedAt?: string;
    ledgerId: string;
    mode: "latest" | "launch";
    orderCount?: number;
    paymentCount?: number;
    scraperState?: string;
    scraperSyncId?: string;
    scraperTaskArn?: string;
    scraperTaskStatus?: string;
    startedAt: string;
    status: "running" | "succeeded" | "failed" | "waitingForScraper";
    syncRunId: string;
    unmatchedCount?: number;
    updatedAt: string;
};

export type WorkspaceVenmoIntegrationRecord = {
    createdAt: string;
    inboundRecipient: string;
    inboxEnabled: boolean;
    integrationId: string;
    lastError?: string;
    latestProcessingAt?: string;
    latestProcessingStatus: "never" | "succeeded" | "failed";
    ledgerId: string;
    updatedAt: string;
    venmoAccountId?: string;
};

export type WorkspaceVenmoAccountMappingRecord = {
    accountId: string;
    createdAt: string;
    externalAccountKey: string;
    institution: string;
    last4: string;
    ledgerId: string;
    mappingId: string;
    updatedAt: string;
};

export type WorkspaceTransactionRecord = {
    aggregateLineCount?: number;
    aggregateLineDigest?: string;
    aggregatePlaidSyncCount?: number;
    aggregatePlaidSyncDigest?: string;
    aggregatePostingCount?: number;
    aggregatePostingDigest?: string;
    aggregateRevision?: string;
    displayAmountCents: number;
    enteredAt: string;
    kind: "adjustment" | "standard";
    memo?: string;
    occurredAt: string;
    payee?: string;
    periodId: string;
    referenceAccountId: string;
    referenceCategoryId?: string;
    plaidTransactionSyncId?: string;
    source?: "manual" | "plaid" | "venmo";
    status: "entered" | "cleared" | "reconciled" | "voided";
    transactionId: string;
    updatedAt: string;
    ledgerId: string;
};

export type WorkspaceTransactionLineRecord = {
    amountCents: number;
    categoryId?: string;
    createdAt: string;
    fromAccountId?: string;
    lineId: string;
    memo?: string;
    payee?: string;
    sortOrder: number;
    toAccountId?: string;
    transactionId: string;
    updatedAt: string;
    ledgerId: string;
};

export type WorkspaceTransactionTemplateRecord = {
    accountId?: string;
    createdAt: string;
    defaultAmountCents?: number;
    ledgerId: string;
    linesJson: string;
    memo?: string;
    name: string;
    payee?: string;
    templateId: string;
    updatedAt: string;
};

export type WorkspaceTransactionAutoMatchRejectionRecord = {
    accountId: string;
    createdAt: string;
    ledgerId: string;
    leftTransactionId: string;
    matchDecisionId: string;
    matchFingerprint: string;
    rejectedAt: string;
    rightTransactionId: string;
    updatedAt: string;
};

export type WorkspaceLedgerPostingRecord = {
    amountCents: number;
    createdAt: string;
    direction: "credit" | "debit";
    ledgerAccountId: string;
    ledgerAccountKind: "category" | "equity" | "financial";
    occurredAt: string;
    periodId: string;
    postingId: string;
    transactionId: string;
    ledgerId: string;
};

export type WorkspacePlaidAccountLinkRecord = {
    accountId: string;
    createdAt: string;
    lastSyncError?: string;
    lastSyncStatus: "failed" | "never" | "succeeded";
    lastSyncedAt?: string;
    plaidAccountId: string;
    plaidAccountLinkId: string;
    plaidAccountMask?: string;
    plaidAccountName?: string;
    plaidAccountOfficialName?: string;
    plaidAccountSubtype?: string;
    plaidAccountType?: string;
    plaidBalanceAvailableCents?: number;
    plaidBalanceCurrentCents?: number;
    plaidBalanceIsoCurrencyCode?: string;
    plaidBalanceLastSyncedAt?: string;
    plaidBalanceLimitCents?: number;
    plaidBalanceSyncError?: string;
    plaidBalanceSyncStatus?: "failed" | "never" | "succeeded";
    plaidBalanceUnofficialCurrencyCode?: string;
    plaidInstitutionId?: string;
    plaidInstitutionLogo?: string;
    plaidInstitutionName?: string;
    plaidInstitutionPrimaryColor?: string;
    plaidInstitutionUrl?: string;
    plaidItemId: string;
    status: "disabled" | "error" | "linked";
    syncStartDate: string;
    updatedAt: string;
    ledgerId: string;
};

export type WorkspacePlaidTransactionSyncRecord = {
    accountId: string;
    authorizedDate?: string;
    categoryText?: string;
    firstSyncedAt: string;
    isoCurrencyCode?: string;
    lastSyncedAt: string;
    ledgerId: string;
    merchantName?: string;
    name: string;
    originalDescription?: string;
    pending: boolean;
    pendingTransactionId?: string;
    personalFinanceCategoryConfidence?: string;
    personalFinanceCategoryDetailed?: string;
    personalFinanceCategoryPrimary?: string;
    plaidAccountId: string;
    plaidAccountLinkId: string;
    plaidAmountCents: number;
    plaidDate: string;
    plaidItemId: string;
    plaidPayloadJson: string;
    plaidTransactionId: string;
    plaidTransactionSyncId: string;
    removedAt?: string;
    status: "active" | "removed";
    transactionId: string;
    updatedAt: string;
};

export type WorkspaceLedgerRecord = {
    createdAt: string;
    isDefault: boolean;
    ledgerId: string;
    name: string;
    status: "active" | "archived";
    updatedAt: string;
    workspaceId: string;
};

export type WorkspaceTransactionWithChildren = WorkspaceTransactionRecord & {
    importActivities?: WorkspaceTransactionImportActivityRecord[];
    lines: WorkspaceTransactionLineRecord[];
    postings: WorkspaceLedgerPostingRecord[];
};

export type WorkspaceTransactionImportActivityRecord =
    TransactionImportActivityRecord;

export type WorkspaceSnapshotPayload = WorkspaceSnapshotRecords & {
    activeLedgerId: string;
    activeLedgerName: string;
    baseChangeCursor?: string;
    knowledge: WorkspaceKnowledge;
    transactionHydration?: WorkspaceTransactionHydration;
    version?: WorkspaceVersion;
};

export type WorkspaceReplicaSnapshotPayload = Omit<
    WorkspaceSnapshotPayload,
    "baseChangeCursor" | "knowledge" | "version"
> & {
    version: WorkspaceVersion;
};

export type WorkspaceSnapshot = Omit<
    WorkspaceSnapshotPayload,
    | "amazonOrderIntegrations"
    | "amazonOrderSyncRuns"
    | "amazonOrders"
    | "transactionAutoMatchRejections"
    | "transactionTemplates"
    | "transactionImportActivities"
    | "transactions"
    | "venmoAccountMappings"
    | "venmoIntegrations"
> & {
    amazonOrderIntegrations?: WorkspaceAmazonOrderIntegrationRecord[];
    amazonOrderSyncRuns?: WorkspaceAmazonOrderSyncRunRecord[];
    amazonOrders?: WorkspaceAmazonOrderRecord[];
    transactionAutoMatchRejections?: WorkspaceTransactionAutoMatchRejectionRecord[];
    transactionTemplates?: WorkspaceTransactionTemplateRecord[];
    transactionImportActivities?: WorkspaceTransactionImportActivityRecord[];
    transactions: WorkspaceTransactionWithChildren[];
    venmoAccountMappings?: WorkspaceVenmoAccountMappingRecord[];
    venmoIntegrations?: WorkspaceVenmoIntegrationRecord[];
};

export type WorkspaceSnapshotRecords = {
    accounts: WorkspaceAccountRecord[];
    allocationFundingSources: WorkspaceAllocationFundingSourceRecord[];
    amazonOrderIntegrations: WorkspaceAmazonOrderIntegrationRecord[];
    amazonOrderSyncRuns: WorkspaceAmazonOrderSyncRunRecord[];
    amazonOrders: WorkspaceAmazonOrderRecord[];
    budgetAllocations: WorkspaceCategoryAllocationRecord[];
    budgetCategories: WorkspaceBudgetCategoryRecord[];
    budgetGroups: WorkspaceBudgetGroupRecord[];
    budgetPeriods: WorkspaceBudgetPeriodRecord[];
    ledgerPostings: WorkspaceLedgerPostingRecord[];
    ledgers: WorkspaceLedgerRecord[];
    plaidAccountLinks: WorkspacePlaidAccountLinkRecord[];
    plaidTransactionSyncs: WorkspacePlaidTransactionSyncRecord[];
    transactionAutoMatchRejections: WorkspaceTransactionAutoMatchRejectionRecord[];
    transactionTemplates: WorkspaceTransactionTemplateRecord[];
    transactionImportActivities: WorkspaceTransactionImportActivityRecord[];
    transactionLines: WorkspaceTransactionLineRecord[];
    transactions: WorkspaceTransactionRecord[];
    venmoAccountMappings: WorkspaceVenmoAccountMappingRecord[];
    venmoIntegrations: WorkspaceVenmoIntegrationRecord[];
};
