import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LedgerRecord } from "@/features/ledgers/server/ledger-service";
import { createLedgerOnboarding } from "@/modules/onboarding/ledger-onboarding";
const mocks = vi.hoisted(() => ({
    ledger: undefined as LedgerRecord | undefined,
    accounts: [] as object[], categories: [] as object[], transactions: [] as object[], allocations: [] as object[],
    go: vi.fn(), getLedgerRecord: vi.fn(), query: vi.fn(),
}));
vi.mock("@/features/ledgers/server/ledger-service", () => ({ getLedgerRecord: mocks.getLedgerRecord }));
vi.mock("@/lib/db/schema", () => ({ getBudgetedSchema: () => ({ entities: {
    accounts: { query: { byAccount: (key: object) => { mocks.query(key); return { go: async () => ({ data: mocks.accounts }) }; } } },
    budgetCategories: { query: { byCategory: (key: object) => { mocks.query(key); return { go: async () => ({ data: mocks.categories }) }; } } },
    transactions: { query: { byTransaction: (key: object) => { mocks.query(key); return { go: async () => ({ data: mocks.transactions }) }; } } },
    categoryAllocations: { query: { byAllocation: (key: object) => { mocks.query(key); return { go: async () => ({ data: mocks.allocations }) }; } } },
    ledgers: { update: () => ({ set: (update: object) => ({ where: () => ({ go: () => mocks.go(update) }) }) }) },
} }) }));
import { updateLedgerOnboarding } from "@/features/ledgers/server/ledger-onboarding-service";

describe("saved ledger setup progress", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.ledger = { ledgerId: "test-ledger", workspaceId: "global", name: "Test", createdAt: "2026-09-01", updatedAt: "2026-09-01", status: "active", isDefault: false, workspaceGeneration: 1, workspaceRevision: 1 };
        mocks.accounts = [{ accountId: "cash" }];
        mocks.categories = [{ categoryId: "groceries", status: "active", defaultAssignedCents: 0 }];
        mocks.transactions = [];
        mocks.allocations = [];
        mocks.getLedgerRecord.mockImplementation(async () => structuredClone(mocks.ledger));
        mocks.go.mockImplementation(async (update: object) => { Object.assign(mocks.ledger!, update); });
    });
    it("classifies once, publishes progress, and scopes every query to the selected ledger", async () => {
        const result = await updateLedgerOnboarding("test-ledger", "refresh");
        expect(result.ledger.onboarding?.status).toBe("active");
        expect(result.workspaceChanges[0]).toMatchObject({ entityId: "test-ledger", entityType: "ledger", record: { onboarding: createLedgerOnboarding() } });
        expect(mocks.query.mock.calls.every(([key]) => key.ledgerId === "test-ledger")).toBe(true);
        mocks.categories = [{ categoryId: "groceries", status: "active", defaultAssignedCents: 100 }];
        mocks.transactions = [{ kind: "standard", status: "entered", source: "manual" }];
        const refreshed = await updateLedgerOnboarding("test-ledger", "refresh");
        expect(refreshed.ledger.onboarding?.status).toBe("active");
        expect(refreshed.ledger.onboarding?.transactionCompleted).toBe(false);
    });
    it("ignores system plan values and system-only allocations", async () => {
        mocks.categories.push({ categoryId: "starting", status: "active", defaultAssignedCents: 500, systemCategoryKey: "startingBalances" });
        mocks.allocations = [{ categoryId: "starting" }];
        mocks.transactions = [{ kind: "standard", status: "entered" }];
        const { ledger } = await updateLedgerOnboarding("test-ledger", "refresh");
        expect(ledger.onboarding).toMatchObject({ status: "active", monthCompleted: false });
    });
    it("recognizes imported activity and planned amounts in legacy ledgers", async () => {
        mocks.categories = [{ categoryId: "groceries", status: "active", defaultAssignedCents: 100 }];
        mocks.transactions = [{ kind: "standard", status: "cleared", source: "plaid" }];
        expect((await updateLedgerOnboarding("test-ledger", "refresh")).ledger.onboarding?.status).toBe("established");
    });
    it("preserves closed state and reviews across a reload", async () => {
        await updateLedgerOnboarding("test-ledger", "reviewAccounts");
        await updateLedgerOnboarding("test-ledger", "close");
        const closed = await updateLedgerOnboarding("test-ledger", "refresh");
        expect(closed.workspaceChanges).toEqual([]);
        expect(closed.ledger.onboarding).toMatchObject({ status: "closed", accountsReviewed: true });
        expect((await updateLedgerOnboarding("test-ledger", "reopen")).ledger.onboarding).toMatchObject({ status: "active", accountsReviewed: true });
    });
    it("merges a concurrent review after a conditional conflict", async () => {
        mocks.ledger!.onboarding = createLedgerOnboarding();
        mocks.ledger!.onboardingRevision = 1;
        mocks.go.mockImplementationOnce(async () => {
            mocks.ledger!.onboarding = { ...createLedgerOnboarding(), accountsReviewed: true };
            mocks.ledger!.onboardingRevision = 2;
            throw new Error("ConditionalCheckFailedException");
        });
        const { ledger } = await updateLedgerOnboarding("test-ledger", "reviewPlan");
        expect(ledger.onboarding).toMatchObject({ accountsReviewed: true, planReviewed: true });
        expect(ledger.onboardingRevision).toBe(3);
    });
    it("does not publish failed writes or swallow database errors", async () => {
        mocks.go.mockRejectedValueOnce(new Error("Storage unavailable"));
        await expect(updateLedgerOnboarding("test-ledger", "reviewAccounts")).rejects.toThrow("Storage unavailable");
        expect(mocks.ledger?.onboarding).toBeUndefined();
    });
    it("validates review prerequisites on the server", async () => {
        mocks.accounts = [];
        await expect(updateLedgerOnboarding("test-ledger", "reviewAccounts")).rejects.toMatchObject({ status: 422 });
        mocks.categories = [];
        await expect(updateLedgerOnboarding("test-ledger", "reviewPlan")).rejects.toMatchObject({ status: 422 });
        expect(mocks.go).not.toHaveBeenCalled();
    });
    it("rejects completing a month or transaction before the required activity is saved", async () => {
        await expect(updateLedgerOnboarding("test-ledger", "completeMonth")).rejects.toMatchObject({ status: 422 });
        await expect(updateLedgerOnboarding("test-ledger", "completeTransaction")).rejects.toMatchObject({ status: 422 });
        expect(mocks.go).not.toHaveBeenCalled();
    });
    it("requires an active user category saved as a funding source", async () => {
        await expect(updateLedgerOnboarding("test-ledger", "completeFundingSources")).rejects.toMatchObject({ status: 422 });
        mocks.categories = [{ categoryId: "source", status: "archived", autoAssignSourceEnabled: true }];
        await expect(updateLedgerOnboarding("test-ledger", "completeFundingSources")).rejects.toMatchObject({ status: 422 });
        mocks.categories = [{ categoryId: "source", status: "active", autoAssignSourceEnabled: true }];
        const { ledger } = await updateLedgerOnboarding("test-ledger", "completeFundingSources");
        expect(ledger.onboarding?.fundingSourcesCompleted).toBe(true);
    });
    it("only completes the month from saved allocations", async () => {
        expect((await updateLedgerOnboarding("test-ledger", "refresh")).ledger.onboarding?.monthCompleted).toBe(false);
        mocks.allocations = [{ categoryId: "groceries", assignedCents: 0 }];
        expect((await updateLedgerOnboarding("test-ledger", "completeMonth")).ledger.onboarding?.monthCompleted).toBe(true);
    });
});
