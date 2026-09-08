import { describe, expect, it } from "vitest";

import { WORKSPACE_ENTITY_TYPES } from "@/lib/workspace/entity-config";
import {
    compareWorkspaceChangesInCommitOrder,
    compareWorkspaceKnowledgeRevision,
    getContiguousCommittedWorkspaceChanges,
    getWorkspaceTransactionQueryKey,
    hasCompleteWorkspaceKnowledgeProof,
    hasContiguousIncrementalWorkspaceRevisions,
    hasEquivalentAuthoritativeWorkspaceKnowledge,
    isValidAuthoritativeWorkspaceKnowledge,
    isWorkspaceDeltaContiguous,
    isWorkspaceKnowledgeEquivalent,
    isWorkspaceKnowledgeNewer,
    normalizeWorkspaceTransactionQuery,
    transactionMatchesWorkspaceQuery,
    type WorkspaceTransactionQuery,
} from "@/lib/workspace/workspace-protocol";
import type {
    WorkspaceChange,
    WorkspaceKnowledge,
    WorkspaceSnapshot,
} from "@/lib/workspace/sync-types";

function createKnowledge(
    overrides: Partial<WorkspaceKnowledge> = {},
): WorkspaceKnowledge {
    return {
        activeLedgerId: "ledger-1",
        changeCursor: "g2:r4",
        entityCounts: Object.fromEntries(
            WORKSPACE_ENTITY_TYPES.map((entityType) => [entityType, 0]),
        ),
        entityDigests: Object.fromEntries(
            WORKSPACE_ENTITY_TYPES.map((entityType) => [
                entityType,
                `${entityType}:digest`,
            ]),
        ),
        entityRevisions: Object.fromEntries(
            WORKSPACE_ENTITY_TYPES.map((entityType) => [
                entityType,
                "g2:r4",
            ]),
        ),
        generatedAt: "2026-07-17T00:00:00.000Z",
        oldestRetainedWorkspaceRevision: 1,
        retainedChangesAfter: "2026-06-17T00:00:00.000Z",
        revision: "g2:r4",
        workspaceGeneration: 2,
        workspaceRevision: 4,
        ...overrides,
    };
}

function createChange(input: {
    changeIndex?: number;
    revision: number;
}): WorkspaceChange {
    return {
        batchId: `batch-${input.revision}`,
        changedAt: "2026-07-17T00:00:00.000Z",
        changeCount: 1,
        changeId: `change-${input.revision}-${input.changeIndex ?? 0}`,
        changeIndex: input.changeIndex ?? 0,
        entityId: `account-${input.revision}`,
        entityType: "account",
        expiresAt: 2_000_000_000,
        operation: "upsert",
        previousRecordDigest: null,
        record: { accountId: `account-${input.revision}` },
        workspaceGeneration: 2,
        workspaceRevision: input.revision,
    };
}

function createTransaction(input: {
    accountId: string;
    categoryId?: string;
    periodId: string;
    source: "manual" | "plaid";
    status: "cleared" | "entered";
    transactionId: string;
}) {
    return {
        displayAmountCents: -100,
        kind: "standard",
        lines: [
            {
                amountCents: 100,
                categoryId: input.categoryId,
                fromAccountId: input.accountId,
                lineId: `line-${input.transactionId}`,
            },
        ],
        occurredAt: `${input.periodId}-01T00:00:00.000Z`,
        periodId: input.periodId,
        referenceAccountId: input.accountId,
        source: input.source,
        status: input.status,
        transactionId: input.transactionId,
    } as WorkspaceSnapshot["transactions"][number];
}

describe("workspace protocol", () => {
    it("compares knowledge revisions across generations and revisions", () => {
        const current = createKnowledge();

        expect(
            compareWorkspaceKnowledgeRevision(
                current,
                createKnowledge({
                    changeCursor: "g2:r5",
                    workspaceRevision: 5,
                }),
            ),
        ).toBe(1);
        expect(
            compareWorkspaceKnowledgeRevision(
                current,
                createKnowledge({
                    changeCursor: "g1:r99",
                    workspaceGeneration: 1,
                    workspaceRevision: 99,
                }),
            ),
        ).toBe(-1);
        expect(
            isWorkspaceKnowledgeNewer(
                createKnowledge({
                    changeCursor: "g3:r0",
                    workspaceGeneration: 3,
                    workspaceRevision: 0,
                }),
                current,
            ),
        ).toBe(true);
        expect(
            isWorkspaceKnowledgeNewer(
                {
                    changeCursor: "g2:r5",
                    workspaceGeneration: 2,
                } as unknown as Pick<
                    WorkspaceKnowledge,
                    | "changeCursor"
                    | "workspaceGeneration"
                    | "workspaceRevision"
                >,
                current,
            ),
        ).toBe(true);
    });

    it("requires complete counts, digests, and revisions", () => {
        const complete = createKnowledge();
        const missingDigest = createKnowledge({
            entityDigests: {
                ...complete.entityDigests,
                transaction: undefined,
            },
        });

        expect(hasCompleteWorkspaceKnowledgeProof(complete)).toBe(true);
        expect(hasCompleteWorkspaceKnowledgeProof(missingDigest)).toBe(false);
        expect(isWorkspaceKnowledgeEquivalent(complete, { ...complete })).toBe(
            true,
        );
        expect(isWorkspaceKnowledgeEquivalent(complete, missingDigest)).toBe(
            false,
        );
        expect(isValidAuthoritativeWorkspaceKnowledge(complete, "ledger-1")).toBe(
            true,
        );
        expect(isValidAuthoritativeWorkspaceKnowledge(complete, "ledger-2")).toBe(
            false,
        );
    });

    it("distinguishes authoritative retention metadata at the same cursor", () => {
        const left = createKnowledge();
        const right = createKnowledge({
            oldestRetainedWorkspaceRevision: 2,
        });

        expect(isWorkspaceKnowledgeEquivalent(left, right)).toBe(true);
        expect(
            hasEquivalentAuthoritativeWorkspaceKnowledge(left, right),
        ).toBe(false);
    });

    it("ignores application version metadata for workspace equivalence", () => {
        const left = createKnowledge({
            applicationReleaseTag: "v0.1.1",
            applicationVersion: "2026-07-18T12:00:00.000Z",
        });
        const right = createKnowledge({
            applicationReleaseTag: "v0.1.2",
            applicationVersion: "2026-07-18T12:15:00.000Z",
        });

        expect(isWorkspaceKnowledgeEquivalent(left, right)).toBe(true);
        expect(
            hasEquivalentAuthoritativeWorkspaceKnowledge(left, right),
        ).toBe(true);
    });

    it("validates and orders contiguous complete revision batches", () => {
        const knowledge = createKnowledge();
        const revisionFive = createChange({ revision: 5 });
        const revisionSix = createChange({ revision: 6 });
        const nextKnowledge = createKnowledge({
            changeCursor: "g2:r6",
            workspaceRevision: 6,
        });

        expect(
            hasContiguousIncrementalWorkspaceRevisions({
                changes: [revisionSix, revisionFive],
                current: knowledge,
                next: nextKnowledge,
            }),
        ).toBe(true);
        expect(
            getContiguousCommittedWorkspaceChanges({
                changes: [revisionSix, revisionFive],
                knowledge,
            }).changes.map((change) => change.workspaceRevision),
        ).toEqual([5, 6]);
        expect(
            [revisionSix, revisionFive]
                .sort(compareWorkspaceChangesInCommitOrder)
                .map((change) => change.workspaceRevision),
        ).toEqual([5, 6]);
    });

    it("rejects gaps, incomplete manifests, and mixed generations", () => {
        const current = createKnowledge();
        const next = createKnowledge({
            changeCursor: "g2:r6",
            workspaceRevision: 6,
        });
        const incomplete = {
            ...createChange({ revision: 5 }),
            changeCount: 2,
        };

        expect(
            hasContiguousIncrementalWorkspaceRevisions({
                changes: [createChange({ revision: 6 })],
                current,
                next,
            }),
        ).toBe(false);
        expect(
            hasContiguousIncrementalWorkspaceRevisions({
                changes: [incomplete, createChange({ revision: 6 })],
                current,
                next,
            }),
        ).toBe(false);
        expect(
            hasContiguousIncrementalWorkspaceRevisions({
                changes: [
                    {
                        ...createChange({ revision: 5 }),
                        workspaceGeneration: 3,
                    },
                    createChange({ revision: 6 }),
                ],
                current,
                next,
            }),
        ).toBe(false);
    });

    it("validates complete delta cursor progression", () => {
        const current = createKnowledge();
        const next = createKnowledge({
            changeCursor: "g2:r6",
            workspaceRevision: 6,
        });
        const delta = {
            changes: [
                createChange({ revision: 5 }),
                createChange({ revision: 6 }),
            ],
            fromCursor: current.changeCursor,
            knowledge: next,
            requiresSnapshot: false as const,
            toCursor: next.changeCursor,
        };

        expect(
            isWorkspaceDeltaContiguous({
                after: current.changeCursor,
                delta,
            }),
        ).toBe(true);
        expect(
            isWorkspaceDeltaContiguous({
                after: current.changeCursor,
                delta: { ...delta, fromCursor: "g2:r3" },
            }),
        ).toBe(false);
    });

    it("normalizes queries and applies one matching implementation", () => {
        const transactions = [
            createTransaction({
                accountId: "account-1",
                periodId: "2026-07",
                source: "manual",
                status: "entered",
                transactionId: "transaction-1",
            }),
            createTransaction({
                accountId: "account-2",
                categoryId: "category-1",
                periodId: "2026-08",
                source: "plaid",
                status: "cleared",
                transactionId: "transaction-2",
            }),
        ];
        const rawQuery: WorkspaceTransactionQuery = {
            accountId: "account-1",
            periodIds: ["2026-08", "2026-07", "invalid"],
            periodThrough: "2026-07",
            uncategorizedOnly: true,
        };
        const normalized = normalizeWorkspaceTransactionQuery(rawQuery);

        expect(normalized).toEqual({
            accountId: "account-1",
            periodIds: ["2026-07"],
            periodThrough: "2026-07",
            uncategorizedOnly: true,
        });
        expect(getWorkspaceTransactionQueryKey(rawQuery)).toBe(
            getWorkspaceTransactionQueryKey(normalized),
        );
        expect(
            transactions
                .filter((transaction) =>
                    transactionMatchesWorkspaceQuery(transaction, normalized),
                )
                .map((transaction) => transaction.transactionId),
        ).toEqual(["transaction-1"]);
    });

    it("normalizes multi-account queries and matches any requested account", () => {
        const normalized = normalizeWorkspaceTransactionQuery({
            accountIds: [" account-2 ", "account-1", "account-2", ""],
        });
        const accountOne = createTransaction({
            accountId: "account-1",
            periodId: "2026-07",
            source: "manual",
            status: "entered",
            transactionId: "transaction-1",
        });
        const accountThree = createTransaction({
            accountId: "account-3",
            periodId: "2026-07",
            source: "manual",
            status: "entered",
            transactionId: "transaction-3",
        });

        expect(normalized).toEqual({
            accountIds: ["account-1", "account-2"],
        });
        expect(transactionMatchesWorkspaceQuery(accountOne, normalized)).toBe(
            true,
        );
        expect(transactionMatchesWorkspaceQuery(accountThree, normalized)).toBe(
            false,
        );
        expect(
            getWorkspaceTransactionQueryKey({
                accountIds: ["account-2", "account-1", "account-2"],
            }),
        ).toBe(getWorkspaceTransactionQueryKey(normalized));
    });
});
