import { describe, expect, it } from "vitest";
import { toWorkspaceLedgerRecord } from "@/features/ledgers/models/workspace-ledger";
import { calculateWorkspaceRecordDigest } from "@/lib/workspace/revision";
import { createLedgerOnboarding } from "@/modules/onboarding/ledger-onboarding";
const ledger = { ledgerId: "one", workspaceId: "global", name: "One", status: "active" as const, isDefault: false, createdAt: "2026-09-01", updatedAt: "2026-09-01", workspaceRevision: 5, workspaceGeneration: 1, workspaceSyncProtocolVersion: 2 };
describe("onboarding snapshot synchronization", () => {
    it("preserves saved progress and its digest across a snapshot reload", () => {
        const record = { ...ledger, onboardingRevision: 2, onboarding: { ...createLedgerOnboarding(), accountsReviewed: true, status: "closed" as const } };
        const reloaded = JSON.parse(JSON.stringify(toWorkspaceLedgerRecord(record)));
        expect(reloaded.onboarding).toEqual(record.onboarding);
        expect(reloaded.onboardingRevision).toBe(2);
        expect(calculateWorkspaceRecordDigest({ entityType: "ledger", record: reloaded })).toBe(calculateWorkspaceRecordDigest({ entityType: "ledger", record }));
    });
    it("does not change legacy ledger digests or mark them reviewed during reads", () => {
        const reloaded = toWorkspaceLedgerRecord(ledger);
        expect(reloaded).not.toHaveProperty("onboarding");
        expect(calculateWorkspaceRecordDigest({ entityType: "ledger", record: reloaded })).toBe(calculateWorkspaceRecordDigest({ entityType: "ledger", record: ledger }));
    });
});
