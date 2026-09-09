export type LedgerOnboarding = {
    status: "active" | "completed" | "closed" | "established";
    accountsReviewed: boolean;
    planReviewed: boolean;
    fundingSourcesCompleted?: boolean;
    monthCompleted: boolean;
    transactionCompleted: boolean;
};

export type OnboardingAction = "refresh" | "reviewAccounts" | "reviewPlan" | "completeFundingSources" | "completeMonth" | "completeTransaction" | "close" | "reopen";

export type OnboardingFacts = {
    accountCount: number;
    categoryCount: number;
    hasPlanValues: boolean;
    hasTransaction: boolean;
    hasSavedAssignments: boolean;
    hasFundingSources: boolean;
};

export function createLedgerOnboarding(): LedgerOnboarding {
    return { status: "active", accountsReviewed: false, planReviewed: false,
        fundingSourcesCompleted: false, monthCompleted: false, transactionCompleted: false };
}

export function resolveLedgerOnboarding(
    existing: LedgerOnboarding | undefined,
    facts: OnboardingFacts,
    action: OnboardingAction,
): LedgerOnboarding {
    const state = { ...(existing ?? createLedgerOnboarding()) };
    if (!existing && facts.hasTransaction && facts.hasPlanValues) state.status = "established";
    if (action === "close") return { ...state, status: "closed" };
    if (action === "reopen") state.status = "active";
    if (state.status !== "active") return state;
    if (action === "reviewAccounts" && facts.accountCount > 0) state.accountsReviewed = true;
    if (action === "reviewPlan" && facts.categoryCount > 0) state.planReviewed = true;
    if (action === "completeFundingSources" && facts.hasFundingSources) state.fundingSourcesCompleted = true;
    if (action === "completeMonth" && facts.hasSavedAssignments) state.monthCompleted = true;
    if (action === "completeTransaction" && facts.hasTransaction) state.transactionCompleted = true;
    if (action !== "reopen" && state.accountsReviewed && state.planReviewed && state.fundingSourcesCompleted && state.monthCompleted && state.transactionCompleted && !(existing?.accountsReviewed && existing.planReviewed && existing.fundingSourcesCompleted && existing.monthCompleted && existing.transactionCompleted)) {
        state.status = "completed";
    }
    return state;
}

export function isSetupTransaction(transaction: { kind: string; status: string }) {
    return transaction.kind === "standard" && transaction.status !== "voided";
}

export function isSetupCategory(category: { status: string; systemCategoryKey?: string }) {
    return category.status === "active" && !category.systemCategoryKey;
}

export function getSetupMonth(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}
