import { describe, expect, it } from "vitest";

import { resolveWorkspaceReadiness } from "@/lib/workspace/readiness";

describe("workspace readiness", () => {
    it("marks accounts as empty until the first account exists", () => {
        const readiness = resolveWorkspaceReadiness({
            accountCount: 0,
            categoryCount: 0,
            hasReportableActivity: false,
            sectionId: "accounts",
            transactionCount: 0,
        });

        expect(readiness).toEqual({
            sectionId: "accounts",
            status: "empty",
            message: "Add your first account to start using the ledger.",
            primaryActionHref: undefined,
            primaryActionLabel: undefined,
        });
    });

    it("marks budget as partial when categories do not exist", () => {
        const readiness = resolveWorkspaceReadiness({
            accountCount: 0,
            categoryCount: 0,
            hasReportableActivity: false,
            sectionId: "budget",
            transactionCount: 0,
        });

        expect(readiness).toEqual({
            sectionId: "budget",
            status: "partial",
            message:
                "Create your first reusable budget category before assigning money for a month.",
            primaryActionHref: "/global-budget",
            primaryActionLabel: "Open Budget Plan",
        });
    });

    it("marks budget plan as partial without a primary action when categories do not exist", () => {
        const readiness = resolveWorkspaceReadiness({
            accountCount: 0,
            categoryCount: 0,
            hasReportableActivity: false,
            sectionId: "globalBudget",
            transactionCount: 0,
        });

        expect(readiness).toEqual({
            sectionId: "globalBudget",
            status: "partial",
            message:
                "Create your first reusable budget category to start building the budget plan.",
            primaryActionHref: undefined,
            primaryActionLabel: undefined,
        });
    });

    it("marks transactions as ready once an account exists", () => {
        const readiness = resolveWorkspaceReadiness({
            accountCount: 1,
            categoryCount: 0,
            hasReportableActivity: false,
            sectionId: "transactions",
            transactionCount: 0,
        });

        expect(readiness).toEqual({
            sectionId: "transactions",
            status: "ready",
            message: "Transactions can be recorded.",
            primaryActionHref: undefined,
            primaryActionLabel: undefined,
        });
    });

    it("points reporting to transactions once accounts exist but no activity is reportable", () => {
        const readiness = resolveWorkspaceReadiness({
            accountCount: 1,
            categoryCount: 2,
            hasReportableActivity: false,
            sectionId: "reporting",
            transactionCount: 0,
        });

        expect(readiness).toEqual({
            sectionId: "reporting",
            status: "empty",
            message: "Reports appear after saved financial activity exists.",
            primaryActionHref: "/transactions",
            primaryActionLabel: "Record transaction",
        });
    });
});
