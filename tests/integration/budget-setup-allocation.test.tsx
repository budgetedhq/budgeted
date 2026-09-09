import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BudgetSetupAllocation } from "@/components/onboarding/budget-setup-allocation";
const base = { availableCents: 10000, requiredCents: 5000, rows: [{ categoryId: "food", name: "Groceries", assignedCents: 5000 }], blocker: null, disabled: false, hasSavedAssignments: false };
describe("first-month allocation preview", () => {
    it("does not save when opening or cancelling, and uses the latest plan when confirming", () => {
        const first = vi.fn(); const latest = vi.fn((done: (saved: boolean) => void) => done(true));
        const view = render(<BudgetSetupAllocation {...base} onConfirm={first} />);
        fireEvent.click(screen.getByRole("button", { name: "Assign money using your plan" }));
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(first).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(first).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Assign money using your plan" }));
        view.rerender(<BudgetSetupAllocation {...base} rows={[{ categoryId: "food", name: "Groceries", assignedCents: 6000 }]} requiredCents={6000} onConfirm={latest} />);
        expect(screen.getAllByText("$60.00")).toHaveLength(2);
        fireEvent.click(screen.getByRole("button", { name: "Assign money" }));
        expect(first).not.toHaveBeenCalled(); expect(latest).toHaveBeenCalledOnce();
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    it.each(["Auto assign needs at least one configured source category.", "Auto assign cannot run while Unassigned is negative by $10.00", "Auto assign needs $25.00 more configured source funds."])("explains blocker %s and disables confirmation", (blocker) => {
        const save = vi.fn();
        render(<BudgetSetupAllocation {...base} blocker={blocker} onConfirm={save} />);
        expect(screen.getByText(blocker)).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Configure funding sources now" })).toHaveAttribute("href", "/utilities/auto-assign");
        expect(screen.queryByRole("link", { name: "Review account balances" })).not.toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "Adjust budget plan" })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Assign money using your plan" }));
        expect(screen.getByRole("button", { name: "Assign money" })).toBeDisabled();
        expect(save).not.toHaveBeenCalled();
    });
    it("keeps the preview open on failure and permits retry", async () => {
        const save = vi.fn((done: (saved: boolean) => void) => done(false));
        render(<BudgetSetupAllocation {...base} onConfirm={save} />);
        fireEvent.click(screen.getByRole("button", { name: "Assign money using your plan" }));
        fireEvent.click(screen.getByRole("button", { name: "Assign money" }));
        await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Allocations could not be saved"));
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Assign money" })).toBeEnabled();
    });
    it("cannot overwrite a month saved while the preview is open", () => {
        const save = vi.fn();
        const view = render(<BudgetSetupAllocation {...base} onConfirm={save} />);
        fireEvent.click(screen.getByRole("button", { name: "Assign money using your plan" }));
        view.rerender(<BudgetSetupAllocation {...base} hasSavedAssignments onConfirm={save} />);
        expect(screen.getByRole("button", { name: "Assign money" })).toBeDisabled();
        expect(save).not.toHaveBeenCalled();
    });
});
