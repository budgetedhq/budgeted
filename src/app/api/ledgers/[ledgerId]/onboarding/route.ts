import { z } from "zod";
import { updateLedgerOnboarding } from "@/features/ledgers/server/ledger-onboarding-service";
import { handleWorkspaceRoute, workspacePublishedMutationJson } from "@/lib/api/workspace-route";
import { parseJsonBody } from "@/lib/api/validation";
import { HttpError } from "@/lib/api/errors";

const actionSchema = z.object({ action: z.enum(["refresh", "reviewAccounts", "reviewPlan", "completeFundingSources", "completeMonth", "completeTransaction", "close", "reopen"]) }).strict();

export async function POST(request: Request, context: { params: Promise<{ ledgerId: string }> }) {
    return handleWorkspaceRoute(async (workspaceContext) => {
        const { ledgerId } = await context.params;
        if (ledgerId !== workspaceContext.ledgerId) {
            throw new HttpError(409, "onboarding_ledger_changed", "Switch to this ledger before updating its setup checklist.");
        }
        const { action } = await parseJsonBody(request, actionSchema);
        return workspacePublishedMutationJson(workspaceContext, () => updateLedgerOnboarding(ledgerId, action));
    });
}
