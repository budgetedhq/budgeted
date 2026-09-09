import type { WorkspaceLedgerRecord } from "@/lib/workspace/sync-types";

/** Keep snapshot projections aligned with the ledger records published by mutations. */
export function toWorkspaceLedgerRecord(record: WorkspaceLedgerRecord): WorkspaceLedgerRecord {
    return {
        createdAt: record.createdAt,
        isDefault: record.isDefault,
        ledgerId: record.ledgerId,
        name: record.name,
        status: record.status,
        updatedAt: record.updatedAt,
        workspaceId: record.workspaceId,
        ...(record.onboarding ? { onboarding: record.onboarding } : {}),
        ...(record.onboardingRevision !== undefined ? { onboardingRevision: record.onboardingRevision } : {}),
    };
}
