"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { DialogCloseButton } from "@/components/shared/dialog-close-button";
import { MoneyAmount } from "@/components/shared/money-amount";
import { useEscapeToClose } from "@/components/shared/use-escape-to-close";
import { useInitialFocus } from "@/components/shared/use-initial-focus";
import { controlClassNames, surfaceClassNames } from "@/lib/theme/theme-recipes";

type Props = {
    availableCents: number;
    requiredCents: number;
    rows: { categoryId: string; name: string; assignedCents: number }[];
    blocker: string | null;
    disabled: boolean;
    hasSavedAssignments: boolean;
    onConfirm: (onSettled: (saved: boolean) => void) => void;
};

export function BudgetSetupAllocation(props: Props) {
    const [open, setOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [failed, setFailed] = useState(false);
    const closeRef = useRef<HTMLButtonElement>(null);
    useEscapeToClose({ enabled: open && !saving, onClose: () => setOpen(false) });
    useInitialFocus(closeRef, { enabled: open });
    function confirm() {
        if (saving || props.disabled || props.blocker || props.hasSavedAssignments) return;
        setSaving(true);
        setFailed(false);
        // The parent supplies the current render's plan, recalculated from the latest summary.
        props.onConfirm((saved) => {
            setSaving(false);
            if (saved) setOpen(false);
            else setFailed(true);
        });
    }
    const blocker = props.blocker ? (
        <section
            role="status"
            className="flex gap-3 border border-[var(--tone-warning-border)] bg-[var(--tone-warning-surface)] p-4 text-sm text-[var(--tone-warning-ink)]"
        >
            <FontAwesomeIcon
                aria-hidden="true"
                icon={faTriangleExclamation}
                className="mt-0.5 h-4 w-4 shrink-0"
            />
            <div className="grid gap-2">
                <p>{props.blocker}</p>
                <Link
                    href="/utilities/auto-assign"
                    className="w-fit !underline underline-offset-2 hover:text-[var(--tone-warning-ink)]"
                >
                    Configure funding sources now
                </Link>
            </div>
        </section>
    ) : null;
    return <>
        {!props.hasSavedAssignments ? <section aria-label="Set up this month" className={`grid gap-3 p-4 ${surfaceClassNames.panel}`}>
            <p>Allocate money for this month.</p>
            <div><button type="button" disabled={props.disabled || saving} onClick={() => { setOpen(true); setFailed(false); }} className={controlClassNames.primaryActionCompact}>Assign money using your plan</button></div>
            {blocker}
        </section> : null}
        {open ? <div className="fixed inset-0 z-50 grid place-items-center bg-[rgba(7,16,27,0.78)] p-4">
            <div role="dialog" aria-modal="true" aria-labelledby="setup-allocation-title" className={`grid max-h-[calc(100vh-2rem)] w-full max-w-2xl gap-4 overflow-y-auto p-6 ${surfaceClassNames.panel}`}>
                <div className="flex items-center justify-between gap-4"><h2 id="setup-allocation-title" className="text-xl font-semibold">Assign money using your plan</h2><DialogCloseButton ref={closeRef} disabled={saving} onClick={() => setOpen(false)} aria-label="Close assignment preview" /></div>
                <p className="text-sm text-[var(--color-muted)]">These amounts apply only to this month. The preview updates when your budget changes.</p>
                <table className="w-full text-sm"><thead><tr><th className="py-2 text-left">Category</th><th className="py-2 text-right">Assigned</th></tr></thead><tbody>{props.rows.map((row) => <tr key={row.categoryId} className="border-t border-[var(--color-border)]"><td className="py-2">{row.name}</td><td className="py-2 text-right"><MoneyAmount cents={row.assignedCents} /></td></tr>)}</tbody></table>
                <dl className="grid grid-cols-2 gap-2 text-sm"><dt>Available funding</dt><dd className="text-right"><MoneyAmount cents={props.availableCents} /></dd><dt>Total required</dt><dd className="text-right"><MoneyAmount cents={props.requiredCents} /></dd><dt>Difference</dt><dd className="text-right"><MoneyAmount cents={props.availableCents - props.requiredCents} /></dd></dl>
                {blocker}
                {props.hasSavedAssignments && !saving ? <p role="status">This month already has saved assignments. Close the preview to review them.</p> : null}
                {failed ? <p role="alert">Allocations could not be saved. Review the current preview and try again. Setup progress has not been completed by this save.</p> : null}
                <div className="flex justify-end gap-3"><button type="button" disabled={saving} onClick={() => setOpen(false)} className={controlClassNames.secondaryAction}>Cancel</button><button type="button" disabled={saving || props.disabled || Boolean(props.blocker) || props.hasSavedAssignments} onClick={confirm} className={controlClassNames.primaryAction}>{saving ? "Saving…" : "Assign money"}</button></div>
            </div>
        </div> : null}
    </>;
}
