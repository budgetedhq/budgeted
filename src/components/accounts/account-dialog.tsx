"use client";

import { useRef, useState, type FormEvent } from "react";

import { useFeedbackToasts } from "@/components/shared/feedback-toast-provider";
import { DialogCloseButton } from "@/components/shared/dialog-close-button";
import { MoneyExpressionInput } from "@/components/shared/money-expression-input";
import { useEscapeToClose } from "@/components/shared/use-escape-to-close";
import { useInitialFocus } from "@/components/shared/use-initial-focus";
import { useWorkspaceStore } from "@/components/workspace/workspace-store-provider";
import type { AccountWithBalance } from "@/features/accounts/server/account-balance-service";
import { parseApiErrorMessage } from "@/lib/api/client-errors";
import { parseUsdToCents } from "@/lib/formatting/money";
import {
    accountTypeSupportsPlaid,
    accountTypeSupportsOpeningBalance,
    accountTypeValues,
    formatAccountTypeLabel,
    type AccountType,
} from "@/modules/accounts/account-types";
import {
    controlClassNames,
    surfaceClassNames,
    typographyClassNames,
} from "@/lib/theme/theme-recipes";
import { createOptimisticWorkspaceUpsert } from "@/lib/workspace/optimistic-changes";

import { PlaidBalanceSection } from "./plaid-balance-section";
import { PlaidLinkSection } from "./plaid-link-section";

type AccountDialogProps = {
    account?: AccountWithBalance;
    onClose: () => void;
    onSaved?: (mode: "created" | "updated") => void;
    open: boolean;
};

function getDefaultOpeningBalance(account?: AccountWithBalance) {
    return ((account?.openingBalanceCents ?? 0) / 100).toFixed(2);
}

export function AccountDialog({
    account,
    onClose,
    onSaved,
    open,
}: AccountDialogProps) {
    const { executeWorkspaceCommand } = useWorkspaceStore();
    const { notifyError } = useFeedbackToasts();
    const [createdAccount, setCreatedAccount] =
        useState<AccountWithBalance | null>(null);
    const [autoStartPlaidKey, setAutoStartPlaidKey] = useState<string | null>(
        null,
    );
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isPlaidLinking, setIsPlaidLinking] = useState(false);
    const [pendingSubmitIntent, setPendingSubmitIntent] = useState<
        "save" | "saveAndLink" | null
    >(null);
    const effectiveAccount = account ?? createdAccount ?? undefined;
    const [selectedAccountType, setSelectedAccountType] =
        useState<AccountType>(effectiveAccount?.accountType ?? "checking");
    const showOpeningBalanceInput =
        accountTypeSupportsOpeningBalance(selectedAccountType);
    const selectedAccountTypeSupportsPlaid =
        accountTypeSupportsPlaid(selectedAccountType);
    const nameInputRef = useRef<HTMLInputElement>(null);

    useEscapeToClose({ enabled: open && !isSubmitting, onClose });
    useInitialFocus(nameInputRef, { enabled: open, select: Boolean(account) });

    if (!open) {
        return null;
    }

    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();

        const submitter = (event.nativeEvent as SubmitEvent)
            .submitter as HTMLButtonElement | null;
        const submitIntent =
            submitter?.value === "saveAndLink" &&
            accountTypeSupportsPlaid(selectedAccountType)
                ? "saveAndLink"
                : "save";
        const formData = new FormData(event.currentTarget);

        setIsSubmitting(true);
        setPendingSubmitIntent(submitIntent);

        try {
            const accountType = String(
                formData.get("accountType") ?? selectedAccountType,
            ) as AccountType;
            const payload = {
                name: String(formData.get("name") ?? ""),
                accountType,
                openingBalanceCents: accountTypeSupportsOpeningBalance(
                    accountType,
                )
                    ? parseUsdToCents(
                          String(formData.get("openingBalance") ?? "0"),
                      )
                    : 0,
                openedOn: String(formData.get("openedOn") ?? ""),
            };
            const wasExistingAccount = Boolean(effectiveAccount);

            if (effectiveAccount) {
                const updatedAt = new Date().toISOString();
                const optimisticAccount = {
                    ...effectiveAccount,
                    ...payload,
                    updatedAt,
                };

                onClose();
                setIsSubmitting(false);
                setPendingSubmitIntent(null);
                void executeWorkspaceCommand({
                    activity: {
                        completedLabel: "Account saved.",
                        pendingLabel: "Saving account…",
                    },
                    optimisticChanges: [
                        createOptimisticWorkspaceUpsert({
                            entityId: optimisticAccount.accountId,
                            entityType: "account",
                            record: optimisticAccount,
                        }),
                    ],
                    request: () =>
                        fetch(`/api/accounts/${effectiveAccount.accountId}`, {
                            method: "PATCH",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify(payload),
                        }),
                    onError: async (error) => {
                        notifyError({
                            message: `${error instanceof Response ? await parseApiErrorMessage(error, "Unable to save account.") : error instanceof Error ? error.message : "Unable to save account."} Save failed. The latest saved data has been restored.`,
                            title: "Account could not be saved.",
                        });
                    },
                    onCommitted: () => {
                        onSaved?.("updated");
                    },
                });
                return;
            }

            await executeWorkspaceCommand<{ account: AccountWithBalance }>({
                activity: {
                    completedLabel: "Account saved.",
                    pendingLabel: "Saving account…",
                },
                request: () =>
                    fetch("/api/accounts", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify(payload),
                    }),
                onError: async (error) => {
                    notifyError({
                        message: `${error instanceof Response ? await parseApiErrorMessage(error, "Unable to save account.") : error instanceof Error ? error.message : "Unable to save account."} The last saved account data is unchanged. Review the form and try again.`,
                        title: "Account could not be saved.",
                    });
                },
                onCommitted: ({ account: savedAccount }) => {
                    onSaved?.(wasExistingAccount ? "updated" : "created");

                    if (
                        submitIntent === "saveAndLink" &&
                        !wasExistingAccount &&
                        accountTypeSupportsPlaid(savedAccount.accountType)
                    ) {
                        setCreatedAccount(savedAccount);
                        setAutoStartPlaidKey(
                            `${savedAccount.accountId}:${Date.now()}`,
                        );
                        return;
                    }

                    onClose();
                },
            });
        } catch (submitError) {
            notifyError({
                message: `${submitError instanceof Error ? submitError.message : "Unable to save account."} The last saved account data is unchanged. Review the form and try again.`,
                title: "Account could not be saved.",
            });
        } finally {
            setIsSubmitting(false);
            setPendingSubmitIntent(null);
        }
    }

    return (
        <div className="fixed inset-0 z-50 grid place-items-center bg-[rgba(7,16,27,0.78)] p-4">
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="account-dialog-title"
                className={`max-h-[calc(100vh-2rem)] w-full max-w-2xl overflow-y-auto overscroll-contain p-6 ${surfaceClassNames.panel}`}
            >
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <p className={typographyClassNames.eyebrow}>
                            {effectiveAccount ? "Edit account" : "Add account"}
                        </p>
                        <h2
                            id="account-dialog-title"
                            className="mt-2 text-2xl font-semibold tracking-tight"
                        >
                            {effectiveAccount
                                ? effectiveAccount.name
                                : "Create a new account."}
                        </h2>
                    </div>
                    <DialogCloseButton
                        onClick={onClose}
                        disabled={isSubmitting}
                        aria-label="Close account dialog"
                    />
                </div>

                <form
                    key={effectiveAccount?.accountId ?? "new-account"}
                    onSubmit={handleSubmit}
                    className="mt-6 grid gap-4"
                >
                    <label className="grid gap-2 text-sm font-medium text-[var(--color-ink)]">
                        Account name
                        <input
                            ref={nameInputRef}
                            required
                            name="name"
                            defaultValue={effectiveAccount?.name ?? ""}
                            className={controlClassNames.field}
                        />
                    </label>

                    <div className="grid gap-4 md:grid-cols-2">
                        <label className="grid gap-2 text-sm font-medium text-[var(--color-ink)]">
                            Account type
                            <select
                                name="accountType"
                                value={selectedAccountType}
                                onChange={(event) =>
                                    setSelectedAccountType(
                                        event.currentTarget.value as AccountType,
                                    )
                                }
                                className={`${controlClassNames.field} w-full`}
                            >
                                {accountTypeValues.map((accountType) => (
                                    <option
                                        key={accountType}
                                        value={accountType}
                                    >
                                        {formatAccountTypeLabel(accountType)}
                                    </option>
                                ))}
                            </select>
                        </label>
                        {showOpeningBalanceInput ? (
                            <div className="grid gap-2 text-sm font-medium text-[var(--color-ink)]">
                                Opening balance
                                <MoneyExpressionInput
                                    aria-describedby="opening-balance-help"
                                    aria-label="Opening balance"
                                    required
                                    name="openingBalance"
                                    defaultValue={getDefaultOpeningBalance(
                                        effectiveAccount,
                                    )}
                                    className={controlClassNames.fieldCompact}
                                />
                                <p id="opening-balance-help" className={`text-xs font-normal ${typographyClassNames.mutedBody}`}>
                                    Enter the balance at your tracking start date, before any transactions you enter in Budgeted.
                                    {selectedAccountType === "creditCard" ? " Enter an amount you owe as negative, such as -250.00. Enter a credit balance as positive." : null}
                                </p>
                            </div>
                        ) : null}
                    </div>

                    <label className="grid gap-2 text-sm font-medium text-[var(--color-ink)]">
                        Tracking start date
                        <input
                            required
                            type="date"
                            name="openedOn"
                            aria-describedby="tracking-start-help"
                            defaultValue={
                                effectiveAccount?.openedOn ??
                                new Date().toISOString().slice(0, 10)
                            }
                            className={controlClassNames.field}
                        />
                    </label>

                    <p id="tracking-start-help" className={`-mt-2 text-xs ${typographyClassNames.mutedBody}`}>
                        Choose the date you want to start tracking this account in Budgeted.
                    </p>

                    {effectiveAccount && selectedAccountTypeSupportsPlaid ? (
                        <>
                            <PlaidLinkSection
                                account={effectiveAccount}
                                autoStartKey={autoStartPlaidKey}
                                onLinkingChange={setIsPlaidLinking}
                            />
                            <PlaidBalanceSection account={effectiveAccount} />
                        </>
                    ) : null}

                    <div className="flex flex-wrap justify-end gap-3">
                        <button
                            type="button"
                            onClick={onClose}
                            disabled={isSubmitting}
                            className={controlClassNames.secondaryAction}
                        >
                            Cancel
                        </button>
                        {!effectiveAccount && selectedAccountTypeSupportsPlaid ? (
                            <button
                                type="submit"
                                value="saveAndLink"
                                disabled={isSubmitting}
                                className={controlClassNames.secondaryAction}
                            >
                                {pendingSubmitIntent === "saveAndLink"
                                    ? "Saving..."
                                    : "Save and link to Plaid"}
                            </button>
                        ) : null}
                        <button
                            type="submit"
                            value="save"
                            disabled={isSubmitting || isPlaidLinking}
                            className={controlClassNames.primaryAction}
                        >
                            {pendingSubmitIntent === "save"
                                ? "Saving..."
                                : "Save account"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
