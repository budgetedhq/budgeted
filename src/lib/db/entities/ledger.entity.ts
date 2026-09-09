import { Entity } from "electrodb";

import type { EntityOptions } from "@/lib/db/entity-options";

export function createLedgerEntity(options: EntityOptions) {
    return new Entity(
        {
            model: {
                entity: "ledger",
                version: "1",
                service: "budgeted",
            },
            attributes: {
                ledgerId: { type: "string", required: true },
                workspaceId: {
                    type: "string",
                    required: true,
                    default: () => "global",
                },
                name: { type: "string", required: true },
                isDefault: {
                    type: "boolean",
                    required: true,
                    default: () => false,
                },
                status: {
                    type: ["active", "archived"] as const,
                    required: true,
                },
                onboardingRevision: { type: "number" },
                onboarding: {
                    type: "map",
                    properties: {
                        status: { type: ["active", "completed", "closed", "established"] as const, required: true },
                        accountsReviewed: { type: "boolean", required: true },
                        planReviewed: { type: "boolean", required: true },
                        fundingSourcesCompleted: { type: "boolean" },
                        monthCompleted: { type: "boolean", required: true },
                        transactionCompleted: { type: "boolean", required: true },
                    },
                },
                createdAt: {
                    type: "string",
                    required: true,
                    default: () => new Date().toISOString(),
                },
                updatedAt: {
                    type: "string",
                    required: true,
                    default: () => new Date().toISOString(),
                },
                workspaceGeneration: {
                    type: "number",
                    required: true,
                    default: () => 1,
                },
                workspaceRevision: {
                    type: "number",
                    required: true,
                    default: () => 0,
                },
                workspaceSyncProtocolVersion: {
                    type: "number",
                    required: true,
                    default: () => 1,
                },
            },
            indexes: {
                byLedger: {
                    pk: { field: "pk", composite: ["workspaceId"] },
                    sk: { field: "sk", composite: ["ledgerId"] },
                },
                byStatus: {
                    index: "gsi1",
                    pk: { field: "gsi1pk", composite: ["workspaceId"] },
                    sk: {
                        field: "gsi1sk",
                        composite: [
                            "status",
                            "isDefault",
                            "createdAt",
                            "ledgerId",
                        ],
                    },
                },
            },
        },
        options,
    );
}
