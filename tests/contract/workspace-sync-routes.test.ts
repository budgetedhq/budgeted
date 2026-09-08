import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    buildWorkspaceKnowledge: vi.fn(),
    buildWorkspaceSnapshot: vi.fn(),
    buildWorkspaceVersion: vi.fn(),
    listWorkspaceCommitsAfter: vi.fn(),
    requireCurrentUserAccount: vi.fn(),
}));

vi.mock("@/lib/auth/current-user", () => ({
    requireCurrentUserAccount: mocks.requireCurrentUserAccount,
}));

vi.mock("@/features/workspace/server/workspace-sync-service", () => ({
    buildWorkspaceKnowledge: mocks.buildWorkspaceKnowledge,
    buildWorkspaceSnapshot: mocks.buildWorkspaceSnapshot,
    buildWorkspaceVersion: mocks.buildWorkspaceVersion,
    listWorkspaceCommitsAfter: mocks.listWorkspaceCommitsAfter,
}));

import { GET as GET_CHANGES } from "@/app/api/workspace/changes/route";
import { GET as GET_KNOWLEDGE } from "@/app/api/workspace/knowledge/route";
import { GET as GET_SNAPSHOT } from "@/app/api/workspace/snapshot/route";
import { GET as GET_VERSION } from "@/app/api/workspace/version/route";
import {
    HttpError,
    WORKSPACE_MUTATION_IN_PROGRESS_ERROR_CODE,
    WORKSPACE_MUTATION_RETRY_AFTER_MS,
} from "@/lib/api/errors";

const knowledge = {
    activeLedgerId: "ledger-1",
    applicationReleaseTag: "v0.1.2",
    applicationVersion: "2026-07-18T12:34:56.789Z",
    changeCursor: "01HZ0000000000000000000000",
    entityCounts: {
        account: 0,
        allocationFundingSource: 0,
        budgetCategory: 0,
        budgetPeriod: 0,
        categoryAllocation: 0,
        ledger: 1,
        ledgerPosting: 0,
        plaidAccountLink: 0,
        plaidTransactionSync: 0,
        transaction: 0,
        transactionLine: 0,
        userAccount: 1,
    },
    entityRevisions: {
        account: "account-revision",
        transaction: "transaction-revision",
    },
    generatedAt: "2026-06-05T12:00:00.000Z",
    retainedChangesAfter: "2026-05-06T12:00:00.000Z",
    revision: "revision",
    workspaceGeneration: 2,
};

describe("workspace sync routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.requireCurrentUserAccount.mockResolvedValue({
            activeLedgerId: "ledger-1",
            userId: "owner-1",
        });
    });

    it("returns global workspace knowledge", async () => {
        mocks.buildWorkspaceKnowledge.mockResolvedValue(knowledge);

        const response = await GET_KNOWLEDGE();

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual(knowledge);
        expect(mocks.buildWorkspaceKnowledge).toHaveBeenCalledWith({
            activeLedgerId: "ledger-1",
            userId: "owner-1",
        });
    });

    it("returns the minimal V2 workspace version", async () => {
        const version = {
            applicationReleaseTag: "v0.1.2",
            applicationVersion: "2026-08-01T12:00:00.000Z",
            cursor: "g2:r4",
            generation: 2,
            ledgerId: "ledger-1",
            oldestRetainedRevision: 1,
            protocolVersion: 2,
            revision: 4,
        };
        mocks.buildWorkspaceVersion.mockResolvedValue(version);

        const response = await GET_VERSION();

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual(version);
    });

    it("tells clients to retry knowledge reads while a workspace mutation is finalizing", async () => {
        mocks.buildWorkspaceKnowledge.mockRejectedValue(
            new HttpError(
                503,
                WORKSPACE_MUTATION_IN_PROGRESS_ERROR_CODE,
                "A workspace change is being finalized. Retrying shortly.",
                { retryAfterMs: WORKSPACE_MUTATION_RETRY_AFTER_MS },
            ),
        );

        const response = await GET_KNOWLEDGE();

        expect(response.status).toBe(503);
        expect(response.headers.get("Retry-After")).toBe("1");
        await expect(response.json()).resolves.toEqual({
            error: {
                code: WORKSPACE_MUTATION_IN_PROGRESS_ERROR_CODE,
                details: { retryAfterMs: WORKSPACE_MUTATION_RETRY_AFTER_MS },
                message: "A workspace change is being finalized. Retrying shortly.",
            },
        });
    });

    it("returns the current workspace snapshot", async () => {
        mocks.buildWorkspaceSnapshot.mockResolvedValue({
            activeLedgerId: "ledger-1",
            accounts: [],
            knowledge,
            version: {
                cursor: "g2:r0",
                generation: 2,
                ledgerId: "ledger-1",
                protocolVersion: 2,
                revision: 0,
            },
        });

        const response = await GET_SNAPSHOT();

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toMatchObject({
            activeLedgerId: "ledger-1",
            version: { ledgerId: "ledger-1", protocolVersion: 2 },
        });
        expect(body).not.toHaveProperty("knowledge");
    });

    it("returns change records after the supplied cursor", async () => {
        const fromVersion = {
            cursor: "g2:r3",
            generation: 2,
            ledgerId: "ledger-1",
            protocolVersion: 2,
            revision: 3,
        };
        const toVersion = { ...fromVersion, cursor: "g2:r4", revision: 4 };
        mocks.listWorkspaceCommitsAfter.mockResolvedValue({
            commits: [
                {
                    changes: [
                        {
                            entityId: "acct-1",
                            entityType: "account",
                            operation: "delete",
                            record: null,
                        },
                    ],
                    commitId: "batch-1",
                    committedAt: "2026-06-05T12:01:00.000Z",
                    fromVersion,
                    toVersion,
                },
            ],
            fromVersion,
            requiresSnapshot: false,
            toVersion,
        });

        const response = await GET_CHANGES(
            new Request(
                "http://localhost/api/workspace/changes?after=01HZ0000000000000000000000",
            ),
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            commits: [
                {
                    changes: [
                        {
                            entityId: "acct-1",
                            entityType: "account",
                            operation: "delete",
                        },
                    ],
                },
            ],
            fromVersion: { cursor: "g2:r3" },
            requiresSnapshot: false,
            toVersion: { cursor: "g2:r4" },
        });
        expect(mocks.listWorkspaceCommitsAfter).toHaveBeenCalledWith({
            after: "01HZ0000000000000000000000",
            user: {
                activeLedgerId: "ledger-1",
                userId: "owner-1",
            },
        });
    });
});
