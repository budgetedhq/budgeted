import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    accountPut: vi.fn(),
    budgetCategoryPut: vi.fn(),
    budgetGroupPut: vi.fn(),
    findUserAccountById: vi.fn(),
    documentClientSend: vi.fn(),
    ledgerDelete: vi.fn(),
    ledgerGet: vi.fn(),
    ledgerPut: vi.fn(),
    ledgerPatch: vi.fn(),
    ledgerUpsert: vi.fn(),
    ledgersByStatus: vi.fn(),
    plaidTransactionSyncsBySync: vi.fn(),
    plaidTransactionSyncsDelete: vi.fn(),
    serviceTransactionWrite: vi.fn(),
    serviceTransactionWriteGo: vi.fn(),
    userAccountUpsert: vi.fn(),
    workspaceStatePut: vi.fn(),
}));

vi.mock("@/lib/auth/user-account", () => ({
    findUserAccountById: mocks.findUserAccountById,
}));

vi.mock("@/lib/db/client", () => ({
    documentClient: {
        send: mocks.documentClientSend,
    },
}));

vi.mock("@/lib/db/resource", () => ({
    requireLedgerTableName: () => "ledger-table",
}));

vi.mock("@/lib/db/schema", () => ({
    getBudgetedSchema: () => ({
        entities: {
            accounts: {
                put: mocks.accountPut,
            },
            budgetCategories: {
                put: mocks.budgetCategoryPut,
            },
            budgetGroups: {
                put: mocks.budgetGroupPut,
            },
            ledgers: {
                delete: mocks.ledgerDelete,
                get: mocks.ledgerGet,
                patch: mocks.ledgerPatch,
                put: mocks.ledgerPut,
                upsert: mocks.ledgerUpsert,
                query: {
                    byLedger: mocks.ledgersByStatus,
                    byStatus: mocks.ledgersByStatus,
                },
            },
            plaidTransactionSyncs: {
                delete: mocks.plaidTransactionSyncsDelete,
                query: {
                    bySync: mocks.plaidTransactionSyncsBySync,
                },
            },
            userAccounts: {
                upsert: mocks.userAccountUpsert,
            },
        },
        service: {
            transaction: {
                write: mocks.serviceTransactionWrite,
            },
        },
    }),
}));

import {
    archiveLedger,
    createLedger,
    ensureDefaultLedger,
    DEFAULT_LEDGER_ID,
    deleteLedger,
    getActiveLedgerContext,
    listLedgers,
    restoreLedger,
    updateLedger,
} from "@/features/ledgers/server/ledger-service";

type LedgerRecord = Awaited<ReturnType<typeof listLedgers>>[number];

describe("ledger service", () => {
    let ledgers: Map<string, LedgerRecord>;
    let ownerAccount: {
        activeLedgerId?: string;
        createdAt: string;
        displayName: string;
        email: string;
        passwordHash: string;
        role: "super";
        updatedAt: string;
        userId: string;
        workspaceId: string;
    };

    beforeEach(() => {
        vi.clearAllMocks();
        ledgers = new Map();
        ownerAccount = {
            userId: "owner-1",
            workspaceId: "global",
            email: "owner@example.com",
            passwordHash: "hash",
            displayName: "Budget Owner",
            role: "super",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        };

        mocks.findUserAccountById.mockImplementation(async () => ownerAccount);
        mocks.ledgerGet.mockImplementation(
            ({ ledgerId }: { ledgerId: string }) => ({
                go: async () => ({ data: ledgers.get(ledgerId) ?? null }),
            }),
        );
        mocks.ledgerPut.mockImplementation((record: LedgerRecord) => ({
            commit: () => ({ record }),
            go: async () => {
                ledgers.set(record.ledgerId, record);
            },
        }));
        mocks.workspaceStatePut.mockImplementation((record) => ({
            commit: () => ({ record }),
        }));
        mocks.accountPut.mockImplementation((record) => ({
            commit: () => ({ record }),
        }));
        mocks.budgetCategoryPut.mockImplementation((record) => ({
            commit: () => ({ record }),
        }));
        mocks.budgetGroupPut.mockImplementation((record) => ({
            commit: () => ({ record }),
        }));
        mocks.serviceTransactionWrite.mockImplementation((write) => {
            const items = write({
                accounts: {
                    put: mocks.accountPut,
                },
                budgetCategories: {
                    put: mocks.budgetCategoryPut,
                },
                budgetGroups: {
                    put: mocks.budgetGroupPut,
                },
                ledgers: {
                    put: (record: LedgerRecord) => {
                        ledgers.set(record.ledgerId, record);
                        return mocks.ledgerPut(record);
                    },
                },
                workspaceStates: {
                    put: mocks.workspaceStatePut,
                },
            });

            return {
                go: async () => {
                    mocks.serviceTransactionWriteGo(items);
                },
            };
        });
        mocks.ledgerPatch.mockImplementation(({ ledgerId }: { ledgerId: string }) => ({
            set: (update: Partial<LedgerRecord>) => ({
                go: async () => { ledgers.set(ledgerId, { ...ledgers.get(ledgerId)!, ...update }); },
            }),
        }));
        mocks.ledgerUpsert.mockImplementation((record: LedgerRecord) => ({
            go: async () => {
                ledgers.set(record.ledgerId, { ...ledgers.get(record.ledgerId), ...record });
            },
        }));
        mocks.ledgerDelete.mockImplementation(
            ({ ledgerId }: { ledgerId: string }) => ({
                go: async () => {
                    ledgers.delete(ledgerId);
                },
            }),
        );
        mocks.ledgersByStatus.mockImplementation(
            ({ workspaceId }: { workspaceId: string }) => ({
                go: async () => ({
                    data: Array.from(ledgers.values()).filter(
                        (ledger) => ledger.workspaceId === workspaceId,
                    ),
                }),
            }),
        );
        mocks.plaidTransactionSyncsBySync.mockImplementation(() => ({
            go: async () => ({ data: [] }),
        }));
        mocks.plaidTransactionSyncsDelete.mockImplementation(() => ({
            go: async () => undefined,
        }));
        mocks.userAccountUpsert.mockImplementation(
            (record: typeof ownerAccount) => ({
                go: async () => {
                    ownerAccount = record;
                },
            }),
        );
        mocks.documentClientSend.mockImplementation(async (command) => {
            if (command.constructor.name === "ScanCommand") {
                return {
                    Items: [
                        {
                            pk: "ledger#ledger-2027",
                            sk: "account-1",
                            ledgerId: "ledger-2027",
                        },
                        {
                            pk: "ledger#ledger-2027",
                            sk: "transaction-1",
                            ledgerId: "ledger-2027",
                        },
                    ],
                };
            }

            return { UnprocessedItems: {} };
        });
    });

    it("preserves concurrently saved setup progress during metadata edits", async () => {
        const ledger = await ensureDefaultLedger();
        mocks.ledgerPatch.mockImplementationOnce(({ ledgerId }: { ledgerId: string }) => ({
            set: (update: Partial<LedgerRecord>) => ({
                go: async () => {
                    ledgers.set(ledgerId, {
                        ...ledgers.get(ledgerId)!, ...update,
                        onboarding: { ...ledger.onboarding!, accountsReviewed: true },
                        onboardingRevision: 1,
                    });
                },
            }),
        }));
        const updated = await updateLedger(ledger.ledgerId, { name: "Reviewed ledger" });
        expect(updated.onboarding?.accountsReviewed).toBe(true);
        expect(updated.onboardingRevision).toBe(1);
    });

    it("creates an initial global ledger and makes it active for the user", async () => {
        const context = await getActiveLedgerContext({
            userId: ownerAccount.userId,
            activeLedgerId: ownerAccount.activeLedgerId,
        });

        expect(context.ledgerId).toBe(DEFAULT_LEDGER_ID);
        expect(ownerAccount.activeLedgerId).toBe(DEFAULT_LEDGER_ID);
        expect(ledgers.get(DEFAULT_LEDGER_ID)).toMatchObject({
            ledgerId: DEFAULT_LEDGER_ID,
            isDefault: false,
            workspaceId: "global",
        });
        expect(mocks.accountPut).toHaveBeenCalledWith(
            expect.objectContaining({
                accountType: "cash",
                ledgerId: DEFAULT_LEDGER_ID,
                name: "Cash",
                openingBalanceCents: 0,
            }),
        );
        expect(mocks.budgetGroupPut).toHaveBeenCalledWith(
            expect.objectContaining({
                ledgerId: DEFAULT_LEDGER_ID,
                name: "Expenses",
                sortOrder: 0,
                status: "active",
            }),
        );
        expect(mocks.budgetCategoryPut).toHaveBeenCalledTimes(4);
        expect(
            mocks.budgetCategoryPut.mock.calls.map(([category]) => category.name),
        ).toEqual([
            "Groceries",
            "Dining out",
            "Transportation",
            "Utilities",
        ]);
        const initialWorkspaceState = mocks.workspaceStatePut.mock.calls[0]?.[0];
        expect(JSON.parse(initialWorkspaceState.entityCountsJson)).toMatchObject({
            account: 1,
            budgetCategory: 4,
            budgetGroup: 1,
            ledger: 1,
            transaction: 0,
        });
    });

    it("creates a new global ledger without recreating a missing Initial ledger", async () => {
        const ledger = await createLedger("owner-1", {
            name: "2027 ledger",
        });

        expect(ledger.ledgerId).not.toBe(DEFAULT_LEDGER_ID);
        expect(ledger.workspaceId).toBe("global");
        expect(ownerAccount.activeLedgerId).toBe(ledger.ledgerId);
        expect(ledgers.get(DEFAULT_LEDGER_ID)).toBeUndefined();
        expect(ledgers.get(ledger.ledgerId)).toMatchObject({
            ledgerId: ledger.ledgerId,
            workspaceId: "global",
        });
        expect(mocks.accountPut).not.toHaveBeenCalled();
        expect(mocks.budgetGroupPut).not.toHaveBeenCalled();
        expect(mocks.budgetCategoryPut).not.toHaveBeenCalled();
    });

    it("resolves the saved active ledger scope when a non-default ledger is active", async () => {
        const ledger = await createLedger("owner-1", {
            name: "2027 ledger",
        });
        const context = await getActiveLedgerContext({
            userId: ownerAccount.userId,
            activeLedgerId: ledger.ledgerId,
        });

        expect(context.ledgerId).toBe(ledger.ledgerId);
        expect(context.ledger.workspaceId).toBe("global");
    });

    it("renames an existing ledger", async () => {
        const ledger = await createLedger("owner-1", {
            name: "2027 ledger",
        });

        await expect(
            updateLedger(ledger.ledgerId, {
                name: "Renamed ledger",
            }),
        ).resolves.toMatchObject({
            ledgerId: ledger.ledgerId,
            name: "Renamed ledger",
        });
        expect(ledgers.get(ledger.ledgerId)?.name).toBe("Renamed ledger");
    });

    it("keeps an archived ledger selectable as the user's current ledger", async () => {
        const ledger = await createLedger("owner-1", {
            name: "Historical ledger",
        });

        await expect(archiveLedger(ledger.ledgerId)).resolves.toMatchObject({
            ledgerId: ledger.ledgerId,
            status: "archived",
        });
        await expect(
            getActiveLedgerContext({
                userId: ownerAccount.userId,
                activeLedgerId: ledger.ledgerId,
            }),
        ).resolves.toMatchObject({ ledgerId: ledger.ledgerId });
        await expect(restoreLedger(ledger.ledgerId)).resolves.toMatchObject({
            ledgerId: ledger.ledgerId,
            status: "active",
        });
    });

    it("deletes a non-default ledger and its scoped records", async () => {
        const ledger = await createLedger("owner-1", {
            name: "2027 ledger",
        });
        ownerAccount.activeLedgerId = ledger.ledgerId;

        const result = await deleteLedger("owner-1", ledger.ledgerId, {
            confirmationName: "2027 ledger",
        });

        expect(result.deletedRecordCount).toBe(2);
        expect(ledgers.has(ledger.ledgerId)).toBe(false);
        expect(ownerAccount.activeLedgerId).toBe(DEFAULT_LEDGER_ID);
        expect(mocks.documentClientSend).toHaveBeenCalledTimes(2);
    });

    it("deletes the initial ledger like any other ledger", async () => {
        await getActiveLedgerContext({
            userId: ownerAccount.userId,
            activeLedgerId: ownerAccount.activeLedgerId,
        });

        const result = await deleteLedger("owner-1", DEFAULT_LEDGER_ID, {
            confirmationName: "Initial ledger",
        });

        expect(result.ledger.ledgerId).toBe(DEFAULT_LEDGER_ID);
        expect(ledgers.has(DEFAULT_LEDGER_ID)).toBe(true);
        expect(ownerAccount.activeLedgerId).toBe(DEFAULT_LEDGER_ID);
    });
});
