import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LedgerOnboarding, OnboardingAction } from "@/modules/onboarding/ledger-onboarding";
const mocks = vi.hoisted(() => ({
    pathname: "/dashboard", fail: false, routerPush: vi.fn(),
    snapshot: { activeLedgerId: "one", knowledge: { workspaceRevision: 1 },
        accounts: [{ accountId: "cash" }], budgetCategories: [{ status: "active" }],
        ledgers: [] as { ledgerId: string; onboarding?: LedgerOnboarding }[] },
    executeWorkspaceCommand: vi.fn(),
}));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname, useRouter: () => ({ push: mocks.routerPush }) }));
vi.mock("@/components/workspace/workspace-store-provider", () => ({ useWorkspaceStore: () => ({ snapshot: mocks.snapshot, executeWorkspaceCommand: mocks.executeWorkspaceCommand }) }));
import { createLedgerOnboarding, resolveLedgerOnboarding } from "@/modules/onboarding/ledger-onboarding";
import { LedgerSetupProvider, SetupChecklist, SetupPageProgress } from "@/components/onboarding/ledger-setup";
const facts = { accountCount: 1, categoryCount: 1, hasPlanValues: false, hasTransaction: false, hasSavedAssignments: false, hasFundingSources: false };
function App() { return <LedgerSetupProvider><SetupChecklist /><SetupPageProgress /></LedgerSetupProvider>; }

describe("setup checklist flow", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        facts.hasFundingSources = false; facts.hasSavedAssignments = false; facts.hasTransaction = false;
        mocks.pathname = "/dashboard"; mocks.fail = false;
        mocks.snapshot.activeLedgerId = "one";
        mocks.snapshot.knowledge.workspaceRevision = 1;
        mocks.snapshot.accounts = [{ accountId: "cash" }];
        mocks.snapshot.budgetCategories = [{ status: "active" }];
        mocks.snapshot.ledgers = [{ ledgerId: "one", onboarding: createLedgerOnboarding() }, { ledgerId: "two", onboarding: createLedgerOnboarding() }];
        vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
        mocks.executeWorkspaceCommand.mockImplementation(async (input) => {
            await input.request();
            if (mocks.fail) { await input.onError(new Error("Save unavailable")); return "failed"; }
            const fetchMock = vi.mocked(fetch);
            const [url, options] = fetchMock.mock.calls.at(-1)!;
            const action = (JSON.parse(String(options?.body)) as { action: OnboardingAction }).action;
            const ledger = mocks.snapshot.ledgers.find((entry) => String(url).includes(`/${entry.ledgerId}/`))!;
            const next = resolveLedgerOnboarding(ledger.onboarding, facts, action);
            if (JSON.stringify(next) !== JSON.stringify(ledger.onboarding)) {
                ledger.onboarding = next;
                mocks.snapshot.knowledge.workspaceRevision++;
            }
            return "committed";
        });
    });
    it("keeps dismissal across remounts without affecting another ledger", async () => {
        const first = render(<App />);
        await waitFor(() => expect(screen.getByRole("link", { name: "Close checklist" })).toHaveAttribute("aria-disabled", "false"));
        fireEvent.click(screen.getByRole("link", { name: "Close checklist" }));
        await waitFor(() => expect(screen.queryByRole("region", { name: "Setup checklist" })).not.toBeInTheDocument());
        first.unmount(); render(<App />);
        expect(screen.queryByRole("region", { name: "Setup checklist" })).not.toBeInTheDocument();
        expect(mocks.snapshot.ledgers[1].onboarding).toEqual(createLedgerOnboarding());
    });
    it.each([
        ["/accounts", "1. Add accounts", "accountsReviewed"],
        ["/global-budget", "2. Create your budget plan", "planReviewed"],
        ["/utilities/auto-assign", "3. Assign Funding Sources", "fundingSourcesCompleted"],
        ["/budget", "4. Set up your first month", "monthCompleted"],
        ["/transactions/checking", "5. Add your first transaction", "transactionCompleted"],
    ] as const)("completes the current step on %s, returns home, and hides its pane", async (pathname, label, field) => {
        mocks.pathname = pathname;
        facts.hasFundingSources = true;
        facts.hasSavedAssignments = true;
        facts.hasTransaction = true;
        render(<LedgerSetupProvider><SetupPageProgress /></LedgerSetupProvider>);
        expect(screen.getByText("New Ledger Setup")).toBeInTheDocument();
        expect(screen.getByText(`Step ${label}`)).toBeInTheDocument();
        await waitFor(() => expect(screen.getByRole("button", { name: "Mark this step Completed" })).toBeEnabled());
        fireEvent.click(screen.getByRole("button", { name: "Mark this step Completed" }));
        await waitFor(() => expect(mocks.routerPush).toHaveBeenCalledWith("/dashboard"));
        expect(mocks.snapshot.ledgers[0].onboarding?.[field]).toBe(true);
        expect(screen.queryByRole("region", { name: "Setup progress" })).not.toBeInTheDocument();
    });
    it("stays on the step when its completion save fails", async () => {
        mocks.pathname = "/accounts";
        render(<LedgerSetupProvider><SetupPageProgress /></LedgerSetupProvider>);
        await waitFor(() => expect(screen.getByRole("button", { name: "Mark this step Completed" })).toBeEnabled());
        mocks.fail = true;
        fireEvent.click(screen.getByRole("button", { name: "Mark this step Completed" }));
        await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Your saved setup progress is unchanged"));
        expect(mocks.routerPush).not.toHaveBeenCalled();
        expect(screen.getByRole("region", { name: "Setup progress" })).toBeInTheDocument();
    });
    it("shows a green checkmark beside completed steps on Home", () => {
        mocks.snapshot.ledgers[0].onboarding!.accountsReviewed = true;
        render(<App />);
        const completed = screen.getByText("Complete");
        expect(completed.querySelector("svg")).toHaveClass("text-[var(--tone-success-ink)]");
    });
    it("keeps completed steps visible across reloads until Go to dashboard succeeds", async () => {
        mocks.snapshot.ledgers[0].onboarding = {
            status: "completed", accountsReviewed: true, planReviewed: true,
            fundingSourcesCompleted: true, monthCompleted: true, transactionCompleted: true,
        };
        const first = render(<App />);
        expect(screen.getByText("Congratulations! You have completed all the steps.")).toBeInTheDocument();
        expect(screen.getAllByText("Complete")).toHaveLength(5);
        expect(mocks.routerPush).not.toHaveBeenCalled();
        first.unmount();
        render(<App />);
        expect(screen.getAllByText("Complete")).toHaveLength(5);
        mocks.fail = true;
        fireEvent.click(screen.getByRole("button", { name: "Go to dashboard" }));
        await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
        expect(mocks.routerPush).not.toHaveBeenCalled();
        expect(screen.getAllByText("Complete")).toHaveLength(5);
        mocks.fail = false;
        fireEvent.click(screen.getByRole("button", { name: "Go to dashboard" }));
        await waitFor(() => expect(mocks.routerPush).toHaveBeenCalledWith("/dashboard"));
        expect(mocks.snapshot.ledgers[0].onboarding.status).toBe("closed");
        expect(screen.queryByRole("region", { name: "Setup checklist" })).not.toBeInTheDocument();
    });
    it("does not review or dismiss setup after a failed save", async () => {
        render(<App />);
        await waitFor(() => expect(screen.getByRole("link", { name: "Close checklist" })).toHaveAttribute("aria-disabled", "false"));
        mocks.fail = true;
        fireEvent.click(screen.getByRole("link", { name: "Close checklist" }));
        await waitFor(() => expect(screen.getAllByText(/Your saved setup progress is unchanged/).length).toBeGreaterThan(0));
        expect(screen.getByRole("region", { name: "Setup checklist" })).toBeInTheDocument();
        expect(mocks.snapshot.ledgers[0].onboarding?.status).toBe("active");
    });
    it("does not treat optimistic transactions or allocations as completion", async () => {
        render(<App />);
        await waitFor(() => expect(screen.getByRole("link", { name: "Close checklist" })).toHaveAttribute("aria-disabled", "false"));
        expect(mocks.snapshot.ledgers[0].onboarding?.monthCompleted).toBe(false);
        expect(mocks.snapshot.ledgers[0].onboarding?.transactionCompleted).toBe(false);
        expect(mocks.executeWorkspaceCommand).toHaveBeenCalledTimes(1);
    });
});
