import { createLedgerOnboarding, type LedgerOnboarding } from "@/modules/onboarding/ledger-onboarding";
import { ulid } from "ulid";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";

import type {
    LedgerDeletionInput,
    LedgerInput,
    LedgerUpdateInput,
} from "@/features/ledgers/models/ledger-form";
import { HttpError } from "@/lib/api/errors";
import {
    findUserAccountById,
    type UserAccountRecord,
} from "@/lib/auth/user-account";
import { deleteItemsInBatches } from "@/lib/db/batch-delete";
import { documentClient } from "@/lib/db/client";
import { listAllPaginatedItems } from "@/lib/db/paginated-list";
import { queryAllPages } from "@/lib/db/query-all-pages";
import { requireLedgerTableName } from "@/lib/db/resource";
import { getBudgetedSchema } from "@/lib/db/schema";
import { GLOBAL_WORKSPACE_ID } from "@/lib/workspace/scope";
import {
    buildWorkspaceSnapshot,
    createWorkspaceStateFromRecords,
    EXPLICIT_MUTATION_FENCE_ID,
    rebuildWorkspaceStateForGeneration,
    toWorkspaceStateRecord,
} from "@/features/workspace/server/workspace-sync-service";
import { createEmptyWorkspaceSnapshotRecords } from "@/lib/workspace/snapshot-utils";
import { createWorkspaceUpsertChange } from "@/features/workspace/server/workspace-change-builder";
import type { WorkspaceSnapshotRecords } from "@/lib/workspace/sync-types";

export const DEFAULT_LEDGER_ID = "default";

export type LedgerRecord = {
    onboarding?: LedgerOnboarding;
    onboardingRevision?: number;
    createdAt: string;
    isDefault: boolean;
    ledgerId: string;
    name: string;
    status: "active" | "archived";
    updatedAt: string;
    workspaceGeneration: number;
    workspaceRevision: number;
    workspaceSyncProtocolVersion?: number;
    workspaceId: string;
};

export type ActiveLedgerContext = {
    ledger: LedgerRecord;
    ledgerId: string;
    ledgerName: string;
};

function compareLedgers(left: LedgerRecord, right: LedgerRecord) {
    const createdAtComparison = left.createdAt.localeCompare(right.createdAt);

    if (createdAtComparison !== 0) {
        return createdAtComparison;
    }

    return left.name.localeCompare(right.name);
}

export async function getLedgerRecord(ledgerId: string, consistent = false) {
    const { entities } = getBudgetedSchema();
    const result = await entities.ledgers
        .get({ workspaceId: GLOBAL_WORKSPACE_ID, ledgerId })
        .go({ consistent });

    return (result.data as LedgerRecord | undefined) ?? null;
}

async function requireLedgerRecord(ledgerId: string) {
    const ledger = await getLedgerRecord(ledgerId);

    if (!ledger) {
        throw new HttpError(
            404,
            "ledger_missing",
            "The selected ledger could not be found.",
        );
    }

    return ledger;
}

async function listLedgerRecords() {
    const { entities } = getBudgetedSchema();
    const ledgers = await queryAllPages(
        entities.ledgers.query.byLedger({ workspaceId: GLOBAL_WORKSPACE_ID }),
        { consistent: true },
    );

    return (ledgers as LedgerRecord[]).sort(compareLedgers);
}

async function persistActiveLedgerId(userId: string, ledgerId: string) {
    const { entities } = getBudgetedSchema();
    const user = await findUserAccountById(userId);

    if (!user) {
        throw new HttpError(
            404,
            "user_missing",
            "The user account could not be found.",
        );
    }

    await entities.userAccounts
        .upsert({
            ...user,
            activeLedgerId: ledgerId,
            updatedAt: new Date().toISOString(),
        })
        .go();
}

type NewLedgerStarterRecords = Pick<
    WorkspaceSnapshotRecords,
    "accounts" | "budgetCategories" | "budgetGroups"
>;

function createEmptyLedgerStarterRecords(): NewLedgerStarterRecords {
    return {
        accounts: [],
        budgetCategories: [],
        budgetGroups: [],
    };
}

function createInitialLedgerStarterRecords(
    ledgerId: string,
    now: string,
): NewLedgerStarterRecords {
    const accountId = ulid();
    const groupId = ulid();
    const categoryNames = [
        "Groceries",
        "Dining out",
        "Transportation",
        "Utilities",
    ];

    return {
        accounts: [
            {
                accountId,
                accountType: "cash",
                balanceCents: 0,
                createdAt: now,
                ledgerAccountId: `acct_${accountId}`,
                ledgerId,
                name: "Cash",
                openedOn: now.slice(0, 10),
                openingBalanceCents: 0,
                updatedAt: now,
            },
        ],
        budgetGroups: [
            {
                createdAt: now,
                groupId,
                ledgerId,
                name: "Expenses",
                sortOrder: 0,
                status: "active",
                updatedAt: now,
            },
        ],
        budgetCategories: categoryNames.map((name, sortOrder) => {
            const categoryId = ulid();

            return {
                allocationCadence: "monthly",
                categoryId,
                categoryType: "spending",
                createdAt: now,
                defaultAssignedCents: 0,
                groupId,
                isIncomeCategory: false,
                ledgerAccountId: `cat_${categoryId}`,
                ledgerId,
                name,
                sortOrder,
                status: "active",
                updatedAt: now,
            };
        }),
    };
}

function toPersistedStarterAccount(
    account: WorkspaceSnapshotRecords["accounts"][number],
) {
    return {
        accountId: account.accountId,
        accountType: account.accountType,
        createdAt: account.createdAt,
        ledgerAccountId: account.ledgerAccountId,
        ledgerId: account.ledgerId,
        name: account.name,
        openedOn: account.openedOn,
        openingBalanceCents: account.openingBalanceCents,
        updatedAt: account.updatedAt,
    };
}

async function persistNewLedger(
    record: LedgerRecord,
    starterRecords = createEmptyLedgerStarterRecords(),
) {
    const { service } = getBudgetedSchema();
    const records = createEmptyWorkspaceSnapshotRecords();
    records.ledgers = [record];
    records.accounts = starterRecords.accounts;
    records.budgetCategories = starterRecords.budgetCategories;
    records.budgetGroups = starterRecords.budgetGroups;
    const workspaceState = createWorkspaceStateFromRecords({
        ledgerId: record.ledgerId,
        oldestRetainedWorkspaceRevision: record.workspaceRevision,
        records,
        workspaceGeneration: record.workspaceGeneration,
        workspaceRevision: record.workspaceRevision,
    });

    await service.transaction
        .write((entities) => {
            const accountWrites = starterRecords.accounts.map((account) =>
                entities.accounts
                    .put(toPersistedStarterAccount(account))
                    .commit(),
            );

            return [
                entities.ledgers.put(record).commit(),
                ...accountWrites,
                ...starterRecords.budgetGroups.map((group) =>
                    entities.budgetGroups.put(group).commit(),
                ),
                ...starterRecords.budgetCategories.map((category) =>
                    entities.budgetCategories.put(category).commit(),
                ),
                entities.workspaceStates
                    .put(toWorkspaceStateRecord(workspaceState))
                    .commit(),
            ];
        })
        .go();
}

export async function ensureDefaultLedger() {
    const existing = await getLedgerRecord(DEFAULT_LEDGER_ID);

    if (existing) {
        if (!existing.isDefault) {
            return existing;
        }

        const normalized = {
            ...existing,
            isDefault: false,
            updatedAt: new Date().toISOString(),
        } satisfies LedgerRecord;

        return persistLedgerMetadata(normalized);
    }

    const now = new Date().toISOString();
    const record = {
        ledgerId: DEFAULT_LEDGER_ID,
        workspaceId: GLOBAL_WORKSPACE_ID,
        name: "Initial ledger",
        isDefault: false,
        status: "active" as const,
        createdAt: now,
        updatedAt: now,
        workspaceGeneration: 1,
        workspaceRevision: 0,
        workspaceSyncProtocolVersion: 2,
        onboarding: createLedgerOnboarding(),
        onboardingRevision: 0,
    } satisfies LedgerRecord;

    await persistNewLedger(
        record,
        createInitialLedgerStarterRecords(record.ledgerId, now),
    );

    return record;
}

export async function listLedgers() {
    const ledgers = await listLedgerRecords();

    if (ledgers.length > 0) {
        return ledgers;
    }

    return [await ensureDefaultLedger()];
}

function normalizeLedgerName(name: string) {
    const normalizedName = name.trim();

    if (!normalizedName) {
        throw new HttpError(
            422,
            "validation_error",
            "Ledger name is required.",
        );
    }

    return normalizedName;
}

export async function assertLedgerNameIsAvailable(input: {
    ledgerId?: string;
    name: string;
}) {
    const ledgers = await listLedgerRecords();

    if (
        ledgers.some(
            (ledger) =>
                ledger.ledgerId !== input.ledgerId &&
                ledger.name.trim().toLowerCase() ===
                    input.name.toLowerCase(),
        )
    ) {
        throw new HttpError(
            409,
            "ledger_conflict",
            "A ledger with this name already exists.",
        );
    }
}

export async function createLedger(userId: string, input: LedgerInput) {
    const now = new Date().toISOString();
    const ledgerId = ulid();
    const name = normalizeLedgerName(input.name);

    await assertLedgerNameIsAvailable({ name });

    const record = {
        ledgerId,
        workspaceId: GLOBAL_WORKSPACE_ID,
        name,
        isDefault: false,
        status: "active" as const,
        createdAt: now,
        updatedAt: now,
        workspaceGeneration: 1,
        workspaceRevision: 0,
        workspaceSyncProtocolVersion: 2,
        onboarding: createLedgerOnboarding(),
        onboardingRevision: 0,
    } satisfies LedgerRecord;

    await persistNewLedger(record);
    await persistActiveLedgerId(userId, ledgerId);

    return record;
}

export async function setActiveLedger(userId: string, ledgerId: string) {
    const ledger = await requireLedgerRecord(ledgerId);

    // A ledger switch must be recoverable even when the current ledger cannot
    // be synchronized. Validate the destination before changing the user's
    // selection, rather than relying on the source-ledger mutation fence.
    await buildWorkspaceSnapshot({
        activeLedgerId: ledger.ledgerId,
        activeLedgerName: ledger.name,
        userId,
    });

    await persistActiveLedgerId(userId, ledger.ledgerId);

    return ledger;
}

// Metadata edits must not overwrite setup progress saved concurrently by another session.
async function persistLedgerMetadata(record: LedgerRecord) {
    const { entities } = getBudgetedSchema();
    await entities.ledgers
        .patch({ workspaceId: record.workspaceId, ledgerId: record.ledgerId })
        .set({
            name: record.name,
            status: record.status,
            isDefault: record.isDefault,
            updatedAt: record.updatedAt,
        })
        .go();
    const saved = await getLedgerRecord(record.ledgerId, true);
    if (!saved) throw new HttpError(404, "ledger_missing", "The selected ledger could not be found.");
    return saved;
}

export async function updateLedger(
    ledgerId: string,
    input: LedgerUpdateInput,
) {
    const existing = await requireLedgerRecord(ledgerId);
    const name = normalizeLedgerName(input.name);

    await assertLedgerNameIsAvailable({ ledgerId, name });

    const record = {
        ...existing,
        name,
        updatedAt: new Date().toISOString(),
    } satisfies LedgerRecord;

    return persistLedgerMetadata(record);
}

export async function updateLedgerWithWorkspaceChanges(
    ledgerId: string,
    input: LedgerUpdateInput,
) {
    const existing = await requireLedgerRecord(ledgerId);
    const ledger = await updateLedger(ledgerId, input);

    return {
        ledger,
        workspaceChanges: [
            createWorkspaceUpsertChange({
                entityId: ledger.ledgerId,
                entityType: "ledger",
                previousRecord: existing,
                record: ledger,
            }),
        ],
    };
}

export async function archiveLedger(ledgerId: string) {
    const existing = await requireLedgerRecord(ledgerId);

    if (existing.status === "archived") {
        return existing;
    }

    const record = {
        ...existing,
        status: "archived" as const,
        updatedAt: new Date().toISOString(),
    } satisfies LedgerRecord;

    return persistLedgerMetadata(record);
}

export async function restoreLedger(ledgerId: string) {
    const existing = await requireLedgerRecord(ledgerId);

    if (existing.status === "active") {
        return existing;
    }

    const record = {
        ...existing,
        status: "active" as const,
        updatedAt: new Date().toISOString(),
    } satisfies LedgerRecord;

    return persistLedgerMetadata(record);
}

export async function setLedgerArchiveStatusWithWorkspaceChanges(input: {
    action: "archive" | "restore";
    ledgerId: string;
}) {
    const existing = await requireLedgerRecord(input.ledgerId);
    const ledger =
        input.action === "archive"
            ? await archiveLedger(input.ledgerId)
            : await restoreLedger(input.ledgerId);

    return {
        ledger,
        workspaceChanges: [
            createWorkspaceUpsertChange({
                entityId: ledger.ledgerId,
                entityType: "ledger",
                previousRecord: existing,
                record: ledger,
            }),
        ],
    };
}

export async function bumpLedgerWorkspaceGeneration(ledgerId: string) {
    const { service } = getBudgetedSchema();
    const existing = await requireLedgerRecord(ledgerId);
    const record = {
        ...existing,
        updatedAt: new Date().toISOString(),
        workspaceGeneration: existing.workspaceGeneration + 1,
        workspaceRevision: 0,
    } satisfies LedgerRecord;

    const workspaceState = await rebuildWorkspaceStateForGeneration({
        ledger: record,
        ledgerId,
        workspaceGeneration: record.workspaceGeneration,
        workspaceRevision: record.workspaceRevision,
    });

    await service.transaction
        .write((transactionEntities) => [
            transactionEntities.ledgers.put(record).commit(),
            transactionEntities.workspaceStates
                .put(toWorkspaceStateRecord(workspaceState))
                .commit(),
        ])
        .go();

    return record;
}

type DeleteKey = {
    pk: string;
    sk: string;
};

type LedgerScopedDeleteScanItem = {
    pk?: string;
    sk?: string;
};

async function listLedgerScopedDeleteKeys(ledgerId: string) {
    const tableName = requireLedgerTableName();
    const items = await listAllPaginatedItems(async ({ exclusiveStartKey }) => {
        const result = await documentClient.send(
            new ScanCommand({
                TableName: tableName,
                ExclusiveStartKey: exclusiveStartKey,
                ProjectionExpression: "#pk, #sk, #ledgerId, #entity",
                FilterExpression:
                    "#ledgerId = :ledgerId AND #entity <> :ledgerEntity AND NOT (#entity = :workspaceMutationOperation AND #mutationId = :explicitMutationFenceId)",
                ExpressionAttributeNames: {
                    "#entity": "__edb_e__",
                    "#pk": "pk",
                    "#sk": "sk",
                    "#ledgerId": "ledgerId",
                    "#mutationId": "mutationId",
                },
                ExpressionAttributeValues: {
                    ":ledgerEntity": "ledger",
                    ":ledgerId": ledgerId,
                    ":workspaceMutationOperation":
                        "workspaceMutationOperation",
                    ":explicitMutationFenceId": EXPLICIT_MUTATION_FENCE_ID,
                },
            }),
        );

        return {
            items:
                (result.Items as LedgerScopedDeleteScanItem[] | undefined) ??
                [],
            lastEvaluatedKey: result.LastEvaluatedKey,
        };
    });

    const keys = items.flatMap((item): DeleteKey[] =>
        typeof item.pk === "string" && typeof item.sk === "string"
            ? [{ pk: item.pk, sk: item.sk }]
            : [],
    );

    return { keys, tableName };
}

async function deletePlaidTransactionSyncsForLedger(ledgerId: string) {
    const { entities } = getBudgetedSchema();
    const syncRecords = await queryAllPages(
        entities.plaidTransactionSyncs.query.bySync({ ledgerId }),
        { consistent: true },
    );

    await Promise.all(
        syncRecords.map((syncRecord) =>
            entities.plaidTransactionSyncs
                .delete({
                    ledgerId,
                    plaidTransactionSyncId:
                        syncRecord.plaidTransactionSyncId,
                })
                .go(),
        ),
    );

    return syncRecords.length;
}

export async function deleteLedgerScopedRecords(input: {
    ledgerId: string;
}) {
    const { keys, tableName } =
        await listLedgerScopedDeleteKeys(input.ledgerId);

    await deleteItemsInBatches({ keys, tableName });

    const syncRecordCount = await deletePlaidTransactionSyncsForLedger(
        input.ledgerId,
    );

    return keys.length + syncRecordCount;
}

export async function deleteLedger(
    userId: string,
    ledgerId: string,
    input: LedgerDeletionInput,
) {
    const { entities } = getBudgetedSchema();
    const ledger = await requireLedgerRecord(ledgerId);

    if (input.confirmationName.trim() !== ledger.name) {
        throw new HttpError(
            422,
            "ledger_confirmation_mismatch",
            "The confirmation name must match the ledger name.",
        );
    }

    const deletedRecordCount = await deleteLedgerScopedRecords({
        ledgerId: ledger.ledgerId,
    });

    await entities.ledgers
        .delete({ workspaceId: GLOBAL_WORKSPACE_ID, ledgerId })
        .go();

    const user = await findUserAccountById(userId);

    if (user?.activeLedgerId === ledger.ledgerId) {
        const remainingLedgers = await listLedgerRecords();
        const fallbackLedger =
            remainingLedgers[0] ?? (await ensureDefaultLedger());

        await persistActiveLedgerId(userId, fallbackLedger.ledgerId);
    }

    return {
        deletedRecordCount,
        ledger,
    };
}

export async function getActiveLedgerContext(
    user: Pick<UserAccountRecord, "activeLedgerId" | "userId">,
): Promise<ActiveLedgerContext> {
    const ledgers = await listLedgers();
    const requestedLedger = user.activeLedgerId
        ? ledgers.find((ledger) => ledger.ledgerId === user.activeLedgerId)
        : undefined;
    const activeLedger = requestedLedger ?? ledgers[0];

    if (user.activeLedgerId !== activeLedger.ledgerId) {
        await persistActiveLedgerId(user.userId, activeLedger.ledgerId);
    }

    return {
        ledger: activeLedger,
        ledgerId: activeLedger.ledgerId,
        ledgerName: activeLedger.name,
    };
}
