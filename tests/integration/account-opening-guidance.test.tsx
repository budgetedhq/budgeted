import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AccountDialog } from "@/components/accounts/account-dialog";

describe("account opening guidance", () => {
    it("explains tracking date and opening balance without changing field names", () => {
        render(<AccountDialog open onClose={vi.fn()} />);
        expect(screen.getByLabelText("Tracking start date")).toHaveAttribute("name", "openedOn");
        expect(screen.getByLabelText("Tracking start date")).toHaveAccessibleDescription("Choose the date you want to start tracking this account in Budgeted.");
        expect(screen.getByLabelText("Opening balance")).toHaveAccessibleDescription(/before any transactions you enter in Budgeted/);
        expect(screen.getByLabelText("Opening balance")).toHaveValue("0.00");
    });
    it("explains signed credit card balances and omits unsupported transfer balances", () => {
        render(<AccountDialog open onClose={vi.fn()} />);
        fireEvent.change(screen.getByLabelText("Account type"), { target: { value: "creditCard" } });
        expect(screen.getByLabelText("Opening balance")).toHaveAccessibleDescription(/owe as negative, such as -250.00/);
        fireEvent.change(screen.getByLabelText("Account type"), { target: { value: "transfers" } });
        expect(screen.queryByLabelText("Opening balance")).not.toBeInTheDocument();
    });
});
