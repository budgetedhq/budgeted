import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    beginWorkspaceExplicitMutation: vi.fn().mockResolvedValue("fence-token"),
    buildCommittedWorkspaceKnowledge: vi.fn(),
    completeWorkspaceExplicitMutation: vi.fn().mockResolvedValue(undefined),
    createLedger: vi.fn(),
    deleteLedger: vi.fn(),
    listLedgers: vi.fn(),
    persistWorkspaceChanges: vi.fn(),
    recoverWorkspaceExplicitMutation: vi.fn().mockResolvedValue(undefined),
    requireCurrentUserAccount: vi.fn(),
    setActiveLedger: vi.fn(),
    setLedgerArchiveStatusWithWorkspaceChanges: vi.fn(),
    trackWorkspaceMutation: vi.fn(),
    updateLedgerWithWorkspaceChanges: vi.fn(),
    updateLedgerOnboarding: vi.fn(),
}));

const fakeKnowledge = {
    activeLedgerId: "default",
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
    generatedAt: "2026-06-05T12:00:00.000Z",
    retainedChangesAfter: "2026-05-06T12:00:00.000Z",
    revision: "revision",
};

vi.mock("@/lib/auth/current-user", () => ({
    requireCurrentUserAccount: mocks.requireCurrentUserAccount,
}));

vi.mock("@/features/ledgers/server/ledger-service", () => ({
    createLedger: mocks.createLedger,
    deleteLedger: mocks.deleteLedger,
    listLedgers: mocks.listLedgers,
    setActiveLedger: mocks.setActiveLedger,
    setLedgerArchiveStatusWithWorkspaceChanges:
        mocks.setLedgerArchiveStatusWithWorkspaceChanges,
    updateLedgerWithWorkspaceChanges:
        mocks.updateLedgerWithWorkspaceChanges,
}));

vi.mock("@/features/workspace/server/workspace-sync-service", () => ({
    beginWorkspaceExplicitMutation: mocks.beginWorkspaceExplicitMutation,
    buildCommittedWorkspaceKnowledge: mocks.buildCommittedWorkspaceKnowledge,
    completeWorkspaceExplicitMutation: mocks.completeWorkspaceExplicitMutation,
    persistWorkspaceChanges: mocks.persistWorkspaceChanges,
    recoverWorkspaceExplicitMutation: mocks.recoverWorkspaceExplicitMutation,
    trackWorkspaceMutation: mocks.trackWorkspaceMutation,
}));

vi.mock("@/features/ledgers/server/ledger-onboarding-service", () => ({ updateLedgerOnboarding: mocks.updateLedgerOnboarding }));
import { POST } from "@/app/api/ledgers/[ledgerId]/onboarding/route";
import { HttpError } from "@/lib/api/errors";

describe("ledger onboarding route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.requireCurrentUserAccount.mockResolvedValue({ userId: "owner", activeLedgerId: "default" });
        mocks.buildCommittedWorkspaceKnowledge.mockResolvedValue(fakeKnowledge);
        mocks.persistWorkspaceChanges.mockImplementation(async ({ changes }) => changes);
        mocks.updateLedgerOnboarding.mockResolvedValue({ ledger: { ledgerId: "default" }, workspaceChanges: [] });
    });
    function post(body: object, ledgerId = "default") {
        return POST(new Request("http://localhost/api/ledgers/default/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ ledgerId }) });
    }
    it.each(["refresh", "reviewAccounts", "reviewPlan", "completeFundingSources", "completeMonth", "completeTransaction", "close", "reopen"])("publishes authenticated %s actions", async (action) => {
        const response = await post({ action });
        expect(response.status).toBe(200);
        expect(mocks.updateLedgerOnboarding).toHaveBeenCalledWith("default", action);
        expect(await response.json()).toHaveProperty("workspaceSync");
    });
    it("rejects actions targeting a different active ledger", async () => {
        expect((await post({ action: "close" }, "other")).status).toBe(409);
        expect(mocks.updateLedgerOnboarding).not.toHaveBeenCalled();
    });
    it("rejects forged milestones and unknown actions", async () => {
        expect((await post({ action: "refresh", monthCompleted: true })).status).toBe(422);
        expect((await post({ action: "completeEverything" })).status).toBe(422);
        expect(mocks.updateLedgerOnboarding).not.toHaveBeenCalled();
    });
    it("requires authentication", async () => {
        mocks.requireCurrentUserAccount.mockRejectedValue(new HttpError(401, "unauthorized", "Sign in first."));
        expect((await post({ action: "refresh" })).status).toBe(401);
        expect(mocks.updateLedgerOnboarding).not.toHaveBeenCalled();
    });
    it("recovers a failed mutation and reports the underlying validation error", async () => {
        mocks.updateLedgerOnboarding.mockRejectedValue(new HttpError(422, "onboarding_account_required", "Add an account first."));
        expect((await post({ action: "reviewAccounts" })).status).toBe(422);
        expect(mocks.recoverWorkspaceExplicitMutation).toHaveBeenCalled();
    });
});
