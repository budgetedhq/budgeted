"use client";

import { faCheck, faXmark } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { useWorkspaceStore } from "@/components/workspace/workspace-store-provider";
import { parseApiErrorMessage } from "@/lib/api/client-errors";
import {
    controlClassNames,
    surfaceClassNames,
    typographyClassNames,
} from "@/lib/theme/theme-recipes";
import {
    getSetupMonth,
    isSetupCategory,
    type LedgerOnboarding,
    type OnboardingAction,
} from "@/modules/onboarding/ledger-onboarding";

type SetupContext = {
    state?: LedgerOnboarding;
    pending: boolean;
    error: string | null;
    act: (action: OnboardingAction) => Promise<boolean>;
};
const LedgerSetupContext = createContext<SetupContext | null>(null);
export function useLedgerSetup() {
    return useContext(LedgerSetupContext);
}

export function LedgerSetupProvider({ children }: { children: ReactNode }) {
    const { snapshot, executeWorkspaceCommand } = useWorkspaceStore();
    const ledgerId = snapshot.activeLedgerId;
    const state = snapshot.ledgers.find(
        (ledger) => ledger.ledgerId === ledgerId,
    )?.onboarding;
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const busy = useRef(false);
    const currentLedgerId = useRef(ledgerId);
    useEffect(() => {
        currentLedgerId.current = ledgerId;
    }, [ledgerId]);
    const act = useCallback(
        async (action: OnboardingAction) => {
            if (busy.current) return false;
            busy.current = true;
            setPending(true);
            setError(null);
            try {
                const outcome = await executeWorkspaceCommand({
                    activity: {
                        pendingLabel: "Saving setup progress…",
                        completedLabel: "Setup progress saved.",
                    },
                    request: () =>
                        fetch(`/api/ledgers/${ledgerId}/onboarding`, {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ action }),
                        }),
                    onError: async (failure) => {
                        const message =
                            failure instanceof Response
                                ? await parseApiErrorMessage(
                                      failure,
                                      "Unable to save setup progress.",
                                  )
                                : failure instanceof Error
                                  ? failure.message
                                  : "Unable to save setup progress.";
                        if (currentLedgerId.current === ledgerId)
                            setError(
                                `${message} Your saved setup progress is unchanged. Try again.`,
                            );
                    },
                });
                return outcome === "committed" && currentLedgerId.current === ledgerId;
            } finally {
                busy.current = false;
                setPending(false);
            }
        },
        [executeWorkspaceCommand, ledgerId],
    );
    const revision = snapshot.knowledge.workspaceRevision;
    const lastRefresh = useRef("");
    useEffect(() => {
        const key = `${ledgerId}:${revision}`;
        if (
            pending ||
            (state && state.status !== "active") ||
            key === lastRefresh.current
        )
            return;
        lastRefresh.current = key;
        // Run after committed workspace revisions, never infer milestones from optimistic records.
        void act("refresh");
    }, [act, ledgerId, pending, revision, state]);
    return (
        <LedgerSetupContext.Provider value={{ state, pending, error, act }}>
            {children}
        </LedgerSetupContext.Provider>
    );
}

function setupSteps(state: LedgerOnboarding) {
    return [
        {
            label: "Add accounts",
            action: "reviewAccounts" as const,
            href: "/accounts",
            complete: state.accountsReviewed,
        },
        {
            label: "Create your budget plan",
            action: "reviewPlan" as const,
            href: "/global-budget",
            complete: state.planReviewed,
        },
        {
            label: "Assign Funding Sources",
            action: "completeFundingSources" as const,
            href: "/utilities/auto-assign",
            complete: state.fundingSourcesCompleted === true,
        },
        {
            label: "Set up your first month",
            action: "completeMonth" as const,
            href: `/budget?month=${getSetupMonth()}`,
            complete: state.monthCompleted,
        },
        {
            label: "Add your first transaction",
            action: "completeTransaction" as const,
            href: "/transactions",
            complete: state.transactionCompleted,
        },
    ];
}

export function SetupChecklist() {
    const setup = useLedgerSetup();
    const router = useRouter();
    if (!setup) return null;
    if (!setup.state) return <SetupErrorOrLoading setup={setup} />;
    if (setup.state.status !== "active" && setup.state.status !== "completed") return null;
    const steps = setupSteps(setup.state);
    const completed = setup.state.status === "completed" || steps.every((step) => step.complete);
    const goToDashboard = async () => {
        if (await setup.act("close")) router.push("/dashboard");
    };
    return (
        <section
            aria-label="Setup checklist"
            className={`grid gap-4 p-6 ${surfaceClassNames.panelStrong}`}
        >
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h1 className="text-2xl font-semibold">Welcome to Budgeted</h1>
                {!completed ? <CloseChecklistLink setup={setup} /> : null}
            </div>
            {!completed ? (
                <p className={typographyClassNames.mutedBody}>
                    Let&apos;s get started by completing the steps below.
                </p>
            ) : null}
            <ol className="divide-y divide-[var(--color-border)]">
                {steps.map((step, index) => (
                    <li key={step.href} className="py-3">
                        <Link
                            href={step.href}
                            className="flex items-center justify-between gap-3 hover:underline"
                        >
                            <span>
                                {index + 1}. {step.label}
                            </span>
                            <span className="inline-flex items-center gap-1.5">
                                {step.complete ? (
                                    <>
                                        <FontAwesomeIcon aria-hidden="true" icon={faCheck} className="text-[var(--tone-success-ink)]" />
                                        Complete
                                    </>
                                ) : "Continue →"}
                            </span>
                        </Link>
                    </li>
                ))}
            </ol>
            {completed ? (
                <div className="grid justify-items-start gap-3">
                    <p role="status" className="font-medium text-[var(--tone-success-ink)]">
                        Congratulations! You have completed all the steps.
                    </p>
                    <button
                        type="button"
                        disabled={setup.pending}
                        onClick={() => void goToDashboard()}
                        className={controlClassNames.primaryActionCompact}
                    >
                        Go to dashboard
                    </button>
                </div>
            ) : null}
            <SetupErrorOrLoading setup={setup} />
        </section>
    );
}

function SetupErrorOrLoading({ setup }: { setup: SetupContext }) {
    if (setup.error)
        return (
            <div role="alert" className="text-sm">
                <p>{setup.error}</p>
                <button
                    type="button"
                    disabled={setup.pending}
                    onClick={() => void setup.act("refresh")}
                    className={controlClassNames.secondaryActionCompact}
                >
                    Retry setup progress
                </button>
            </div>
        );
    if (!setup.state)
        return (
            <p role="status" className={typographyClassNames.mutedBody}>
                Loading setup progress…
            </p>
        );
    return null;
}

export function SetupPageProgress() {
    const setup = useLedgerSetup();
    const pathname = usePathname();
    const router = useRouter();
    const { snapshot } = useWorkspaceStore();
    if (!setup || !["/accounts", "/global-budget", "/utilities/auto-assign", "/budget", "/transactions"].some(
        (path) => pathname === path || pathname.startsWith(`${path}/`),
    )) return null;
    if (!setup.state) return <SetupErrorOrLoading setup={setup} />;
    if (setup.state.status !== "active") return null;
    const steps = setupSteps(setup.state);
    const stepIndex = steps.findIndex((step) => {
        const path = step.href.split("?")[0];
        return pathname === path || pathname.startsWith(`${path}/`);
    });
    const step = steps[stepIndex];
    if (!step || step.complete) return null;
    const missingPrerequisite =
        (step.action === "reviewAccounts" && snapshot.accounts.length === 0) ||
        (step.action === "reviewPlan" && !snapshot.budgetCategories.some(isSetupCategory));

    const completeStep = async () => {
        if (await setup.act(step.action)) router.push("/dashboard");
    };

    return (
        <section
            aria-label="Setup progress"
            className={`mb-6 grid gap-3 p-4 ${surfaceClassNames.panel}`}
        >
            <div className="grid gap-1">
                <p className={typographyClassNames.eyebrow}>New Ledger Setup</p>
                <p className="text-sm">Step {stepIndex + 1}. {step.label}</p>
            </div>
            <div>
                <button
                    type="button"
                    disabled={setup.pending || missingPrerequisite}
                    onClick={() => void completeStep()}
                    className={controlClassNames.primaryActionCompact}
                >
                    Mark this step Completed
                </button>
            </div>
            <SetupErrorOrLoading setup={setup} />
        </section>
    );
}

function CloseChecklistLink({ setup }: { setup: SetupContext }) {
    return (
        <a
            href="#"
            aria-disabled={setup.pending}
            onClick={(event) => {
                event.preventDefault();
                if (!setup.pending) void setup.act("close");
            }}
            className="inline-flex items-center gap-1.5 text-sm text-[var(--color-muted)] hover:underline aria-disabled:cursor-wait aria-disabled:opacity-50"
        >
            <FontAwesomeIcon aria-hidden="true" icon={faXmark} />
            Close checklist
        </a>
    );
}
