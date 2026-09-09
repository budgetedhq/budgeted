import { getLedgerRecord } from "@/features/ledgers/server/ledger-service";
import { createWorkspaceUpsertChange } from "@/features/workspace/server/workspace-change-builder";
import { getBudgetedSchema } from "@/lib/db/schema";
import { queryAllPages } from "@/lib/db/query-all-pages";
import { HttpError } from "@/lib/api/errors";
import { isSetupCategory, isSetupTransaction, resolveLedgerOnboarding, type OnboardingAction } from "@/modules/onboarding/ledger-onboarding";

async function readOnboardingFacts(ledgerId: string) {
    const { entities } = getBudgetedSchema();
    const [accounts, categories, transactions, allocations] = await Promise.all([
        queryAllPages(entities.accounts.query.byAccount({ ledgerId }), { consistent: true }),
        queryAllPages(entities.budgetCategories.query.byCategory({ ledgerId }), { consistent: true }),
        queryAllPages(entities.transactions.query.byTransaction({ ledgerId }), { consistent: true }),
        queryAllPages(entities.categoryAllocations.query.byAllocation({ ledgerId }), { consistent: true }),
    ]);
    const visibleCategories = categories.filter(isSetupCategory);
    const systemCategoryIds = new Set(categories.filter((category) => category.systemCategoryKey).map((category) => category.categoryId));
    return {
        accountCount: accounts.length,
        categoryCount: visibleCategories.length,
        hasFundingSources: visibleCategories.some((category) => category.autoAssignSourceEnabled === true),
        hasPlanValues: visibleCategories.some((category) => Number.isFinite(category.defaultAssignedCents) && category.defaultAssignedCents !== 0),
        hasTransaction: transactions.some(isSetupTransaction),
        hasSavedAssignments: allocations.some((allocation) => !systemCategoryIds.has(allocation.categoryId)),
    };
}

export async function updateLedgerOnboarding(ledgerId: string, action: OnboardingAction) {
    const { entities } = getBudgetedSchema();
    for (let attempt = 0; attempt < 4; attempt++) {
        const existing = await getLedgerRecord(ledgerId, true);
        if (!existing) throw new HttpError(404, "ledger_not_found", "Ledger not found.");
        if (action === "refresh" && existing.onboarding && existing.onboarding.status !== "active") {
            return { ledger: existing, workspaceChanges: [] };
        }
        const facts = await readOnboardingFacts(ledgerId);
        if (action === "reviewAccounts" && facts.accountCount === 0) {
            throw new HttpError(422, "onboarding_account_required", "Add an account before reviewing accounts.");
        }
        if (action === "reviewPlan" && facts.categoryCount === 0) {
            throw new HttpError(422, "onboarding_category_required", "Add a budget category before reviewing your plan.");
        }
        if (action === "completeFundingSources" && !facts.hasFundingSources) {
            throw new HttpError(422, "onboarding_funding_source_required", "Save at least one funding source before completing this step.");
        }
        if (action === "completeMonth" && !facts.hasSavedAssignments) {
            throw new HttpError(422, "onboarding_allocation_required", "Save your monthly allocations before completing this step.");
        }
        if (action === "completeTransaction" && !facts.hasTransaction) {
            throw new HttpError(422, "onboarding_transaction_required", "Save your first transaction before completing this step.");
        }
        const onboarding = resolveLedgerOnboarding(existing.onboarding, facts, action);
        if (JSON.stringify(onboarding) === JSON.stringify(existing.onboarding)) {
            return { ledger: existing, workspaceChanges: [] };
        }
        const update = { onboarding, onboardingRevision: (existing.onboardingRevision ?? 0) + 1, updatedAt: new Date().toISOString() };
        try {
            await entities.ledgers.update({ workspaceId: existing.workspaceId, ledgerId })
                .set(update)
                .where((attributes, operations) => {
                    const expectedRevision = existing.onboardingRevision === undefined
                        ? operations.notExists(attributes.onboardingRevision)
                        : operations.eq(attributes.onboardingRevision, existing.onboardingRevision);
                    return `${operations.exists(attributes.createdAt)} AND ${expectedRevision}`;
                })
                .go();
        } catch (error) {
            // Only a competing onboarding update warrants a retry; never mask storage failures.
            const latest = await getLedgerRecord(ledgerId, true);
            if (latest?.onboardingRevision !== existing.onboardingRevision) continue;
            throw error;
        }
        const ledger = { ...existing, ...update };
        return { ledger, workspaceChanges: [createWorkspaceUpsertChange({
            entityId: ledgerId, entityType: "ledger", previousRecord: existing, record: ledger,
        })] };
    }
    throw new HttpError(409, "onboarding_conflict", "Setup changed in another session. Try again.");
}
