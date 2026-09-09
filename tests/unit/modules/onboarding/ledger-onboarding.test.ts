import { describe, expect, it } from "vitest";
import { createLedgerOnboarding, getSetupMonth, isSetupCategory, isSetupTransaction, resolveLedgerOnboarding, type OnboardingFacts } from "@/modules/onboarding/ledger-onboarding";
const empty: OnboardingFacts = { accountCount: 1, categoryCount: 4, hasPlanValues: false, hasTransaction: false, hasSavedAssignments: false, hasFundingSources: false };
describe("ledger setup lifecycle", () => {
    it.each([[false, false, "active"], [true, false, "active"], [false, true, "active"], [true, true, "established"]] as const)("classifies legacy ledger with plan=%s transaction=%s as %s", (hasPlanValues, hasTransaction, status) => {
        expect(resolveLedgerOnboarding(undefined, { ...empty, hasPlanValues, hasTransaction }, "refresh").status).toBe(status);
    });
    it("requires explicit review even when starter records exist", () => {
        const state = resolveLedgerOnboarding(undefined, empty, "refresh");
        expect(state.accountsReviewed).toBe(false);
        expect(state.planReviewed).toBe(false);
        expect(resolveLedgerOnboarding(state, empty, "reviewAccounts").accountsReviewed).toBe(true);
        expect(resolveLedgerOnboarding(state, empty, "reviewPlan").planReviewed).toBe(true);
    });
    it("does not review absent accounts or categories", () => {
        expect(resolveLedgerOnboarding(createLedgerOnboarding(), { ...empty, accountCount: 0 }, "reviewAccounts").accountsReviewed).toBe(false);
        expect(resolveLedgerOnboarding(createLedgerOnboarding(), { ...empty, categoryCount: 0 }, "reviewPlan").planReviewed).toBe(false);
    });
    it("does not reclassify active setup once real activity exists", () => {
        expect(resolveLedgerOnboarding(createLedgerOnboarding(), { ...empty, hasPlanValues: true, hasTransaction: true }, "refresh").status).toBe("active");
    });
    it("completes only after all five milestones and preserves them after deletion", () => {
        const reviewed = { ...createLedgerOnboarding(), accountsReviewed: true, planReviewed: true, fundingSourcesCompleted: true };
        const partial = resolveLedgerOnboarding(reviewed, { ...empty, hasTransaction: true }, "completeTransaction");
        expect(partial.status).toBe("active");
        const completed = resolveLedgerOnboarding(partial, { ...empty, hasSavedAssignments: true }, "completeMonth");
        expect(completed.status).toBe("completed");
        expect(resolveLedgerOnboarding(completed, empty, "refresh")).toEqual(completed);
    });
    it("requires explicit completion even when monthly allocations and transactions are saved", () => {
        const state = resolveLedgerOnboarding(createLedgerOnboarding(), { ...empty, hasSavedAssignments: true, hasTransaction: true }, "refresh");
        expect(state.monthCompleted).toBe(false);
        expect(state.transactionCompleted).toBe(false);
    });
    it("requires saved funding sources and explicit completion", () => {
        const state = createLedgerOnboarding();
        expect(resolveLedgerOnboarding(state, empty, "completeFundingSources").fundingSourcesCompleted).toBe(false);
        expect(resolveLedgerOnboarding(state, { ...empty, hasFundingSources: true }, "refresh").fundingSourcesCompleted).toBe(false);
        expect(resolveLedgerOnboarding(state, { ...empty, hasFundingSources: true }, "completeFundingSources").fundingSourcesCompleted).toBe(true);
    });
    it("keeps old completed ledgers closed and treats the new step as incomplete in active legacy setup", () => {
        const legacy = { ...createLedgerOnboarding(), accountsReviewed: true, planReviewed: true, monthCompleted: true, transactionCompleted: true };
        delete legacy.fundingSourcesCompleted;
        expect(resolveLedgerOnboarding(legacy, empty, "refresh").status).toBe("active");
        expect(resolveLedgerOnboarding({ ...legacy, status: "completed" }, empty, "refresh").status).toBe("completed");
    });
    it("closes and reopens without losing progress", () => {
        const reviewed = { ...createLedgerOnboarding(), accountsReviewed: true };
        const closed = resolveLedgerOnboarding(reviewed, empty, "close");
        expect(resolveLedgerOnboarding(closed, empty, "refresh")).toEqual(closed);
        expect(resolveLedgerOnboarding(closed, empty, "reopen")).toEqual(reviewed);
    });
    it("keeps established ledgers hidden after deletion", () => {
        const established = resolveLedgerOnboarding(undefined, { ...empty, hasTransaction: true, hasPlanValues: true }, "refresh");
        expect(resolveLedgerOnboarding(established, empty, "refresh").status).toBe("established");
    });
    it.each(["manual", "plaid", "venmo"])("counts %s standard transactions, excluding voided entries and adjustments", (source) => {
        const transaction = { source, kind: "standard", status: "entered" };
        expect(isSetupTransaction(transaction)).toBe(true);
        expect(isSetupTransaction({ ...transaction, status: "voided" })).toBe(false);
        expect(isSetupTransaction({ ...transaction, kind: "adjustment" })).toBe(false);
    });
    it("excludes system and archived categories", () => {
        expect(isSetupCategory({ status: "active" })).toBe(true);
        expect(isSetupCategory({ status: "archived" })).toBe(false);
        expect(isSetupCategory({ status: "active", systemCategoryKey: "startingBalances" })).toBe(false);
    });
    it("uses the local calendar month", () => {
        expect(getSetupMonth(new Date(2026, 8, 1))).toBe("2026-09");
    });
});
