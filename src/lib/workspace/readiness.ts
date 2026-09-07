import type { WorkspaceSection } from "@/lib/navigation/workspace-sections";

export type WorkspaceReadinessStatus = "empty" | "partial" | "ready";

export type WorkspaceReadinessInput = {
    accountCount: number;
    categoryCount: number;
    hasReportableActivity: boolean;
    sectionId: WorkspaceSection["sectionId"];
    transactionCount: number;
};

export type WorkspaceReadiness = {
    message: string;
    primaryActionHref?:
        | "/accounts"
        | "/budget"
        | "/global-budget"
        | "/ledgers"
        | "/transactions";
    primaryActionLabel?: string;
    sectionId: WorkspaceSection["sectionId"];
    status: WorkspaceReadinessStatus;
};

function createReadiness(
    sectionId: WorkspaceSection["sectionId"],
    status: WorkspaceReadinessStatus,
    message: string,
    primaryAction?: {
        href: "/accounts" | "/budget" | "/global-budget" | "/transactions";
        label: string;
    },
): WorkspaceReadiness {
    return {
        sectionId,
        status,
        message,
        primaryActionHref: primaryAction?.href,
        primaryActionLabel: primaryAction?.label,
    };
}

export function resolveWorkspaceReadiness(
    input: WorkspaceReadinessInput,
): WorkspaceReadiness {
    switch (input.sectionId) {
        case "dashboard": {
            return createReadiness(
                "dashboard",
                "ready",
                "Dashboard is ready.",
            );
        }

        case "accounts": {
            if (input.accountCount === 0) {
                return createReadiness(
                    "accounts",
                    "empty",
                    "Add your first account to start using the ledger.",
                );
            }

            return createReadiness("accounts", "ready", "Accounts are ready.");
        }

        case "budget": {
            if (input.categoryCount === 0) {
                return createReadiness(
                    "budget",
                    "partial",
                    "Create your first reusable budget category before assigning money for a month.",
                    {
                        href: "/global-budget",
                        label: "Open Budget Plan",
                    },
                );
            }

            return createReadiness(
                "budget",
                "ready",
                "Monthly budget is ready.",
            );
        }

        case "globalBudget": {
            if (input.categoryCount === 0) {
                return createReadiness(
                    "globalBudget",
                    "partial",
                    "Create your first reusable budget category to start building the budget plan.",
                );
            }

            return createReadiness(
                "globalBudget",
                "ready",
                "Budget plan is ready.",
            );
        }

        case "ledgers": {
            return createReadiness("ledgers", "ready", "Ledgers are ready.");
        }

        case "utilities": {
            return createReadiness(
                "utilities",
                "ready",
                "Utilities are ready.",
            );
        }

        case "transactions": {
            if (input.accountCount === 0) {
                return createReadiness(
                    "transactions",
                    "empty",
                    "Transactions depend on at least one saved account.",
                    {
                        href: "/accounts",
                        label: "Add account",
                    },
                );
            }

            return createReadiness(
                "transactions",
                "ready",
                "Transactions can be recorded.",
            );
        }

        case "reporting": {
            if (!input.hasReportableActivity) {
                return createReadiness(
                    "reporting",
                    "empty",
                    "Reports appear after saved financial activity exists.",
                    {
                        href:
                            input.accountCount === 0
                                ? "/accounts"
                                : "/transactions",
                        label:
                            input.accountCount === 0
                                ? "Add account"
                                : "Record transaction",
                    },
                );
            }

            return createReadiness("reporting", "ready", "Reporting is ready.");
        }
    }
}
