import { encodeWorkspaceCursor, parseWorkspaceCursor } from "@/lib/workspace/cursor";
import {
    WORKSPACE_SYNC_PROTOCOL_VERSION,
    type WorkspaceChange,
    type WorkspaceCommit,
    type WorkspaceKnowledge,
    type WorkspaceRecordChange,
    type WorkspaceSyncEnvelope,
    type WorkspaceVersion,
    type WorkspaceVersionResult,
} from "@/lib/workspace/sync-types";

export function createWorkspaceVersion(input: {
    cursor?: string;
    generation: number;
    ledgerId: string;
    revision: number;
}): WorkspaceVersion {
    return {
        cursor:
            input.cursor ??
            encodeWorkspaceCursor({
                generation: input.generation,
                revision: input.revision,
            }),
        generation: input.generation,
        ledgerId: input.ledgerId,
        protocolVersion: WORKSPACE_SYNC_PROTOCOL_VERSION,
        revision: input.revision,
    };
}

export function workspaceKnowledgeToVersion(
    knowledge: WorkspaceKnowledge,
): WorkspaceVersion {
    const parsedCursor = parseWorkspaceCursor(knowledge.changeCursor);
    const generation = Number.isSafeInteger(knowledge.workspaceGeneration)
        ? knowledge.workspaceGeneration
        : (parsedCursor?.generation ?? 1);
    const revision = Number.isSafeInteger(knowledge.workspaceRevision)
        ? knowledge.workspaceRevision
        : (parsedCursor?.revision ?? 0);

    return createWorkspaceVersion({
        cursor: parsedCursor ? knowledge.changeCursor : undefined,
        generation,
        ledgerId: knowledge.activeLedgerId,
        revision,
    });
}

export function workspaceKnowledgeToVersionResult(
    knowledge: WorkspaceKnowledge,
): WorkspaceVersionResult {
    return {
        ...workspaceKnowledgeToVersion(knowledge),
        applicationReleaseTag: knowledge.applicationReleaseTag,
        applicationVersion: knowledge.applicationVersion,
        oldestRetainedRevision: knowledge.oldestRetainedWorkspaceRevision,
    };
}

function stripWorkspaceChange(change: WorkspaceChange): WorkspaceRecordChange {
    return {
        entityId: change.entityId,
        entityType: change.entityType,
        operation: change.operation,
        record: change.record,
    };
}

function compareChanges(left: WorkspaceChange, right: WorkspaceChange) {
    if (left.workspaceGeneration !== right.workspaceGeneration) {
        return left.workspaceGeneration - right.workspaceGeneration;
    }
    if (left.workspaceRevision !== right.workspaceRevision) {
        return left.workspaceRevision - right.workspaceRevision;
    }
    return left.changeIndex - right.changeIndex;
}

function assertCanonicalTransactionParents(changes: WorkspaceChange[]) {
    const transactionIds = new Set(
        changes
            .filter((change) => change.entityType === "transaction")
            .map((change) => change.entityId),
    );

    for (const change of changes) {
        if (
            change.operation !== "upsert" ||
            ![
                "ledgerPosting",
                "plaidTransactionSync",
                "transactionLine",
            ].includes(change.entityType)
        ) {
            continue;
        }

        const transactionId = (change.record as { transactionId?: unknown })
            ?.transactionId;

        if (
            typeof transactionId !== "string" ||
            !transactionIds.has(transactionId)
        ) {
            throw new Error(
                `Workspace commit ${change.batchId} changes ${change.entityType}:${change.entityId} without its canonical parent transaction.`,
            );
        }
    }
}

export function createWorkspaceCommits(input: {
    changes: readonly WorkspaceChange[];
    fallbackVersion?: WorkspaceVersion;
    ledgerId: string;
}): WorkspaceCommit[] {
    const orderedChanges = [...input.changes].sort(compareChanges);
    const grouped = new Map<string, WorkspaceChange[]>();

    for (const change of orderedChanges) {
        const key = `${change.workspaceGeneration ?? input.fallbackVersion?.generation}:${change.workspaceRevision ?? input.fallbackVersion?.revision}:${change.batchId}`;
        const batch = grouped.get(key) ?? [];
        batch.push(change);
        grouped.set(key, batch);
    }

    return Array.from(grouped.values()).map((changes) => {
        assertCanonicalTransactionParents(changes);
        const first = changes[0]!;
        const generation = Number.isSafeInteger(first.workspaceGeneration)
            ? first.workspaceGeneration
            : (input.fallbackVersion?.generation ?? 1);
        const revision = Number.isSafeInteger(first.workspaceRevision)
            ? first.workspaceRevision
            : (input.fallbackVersion?.revision ?? 0);
        const fromRevision = Math.max(0, revision - 1);

        return {
            changes: changes.map(stripWorkspaceChange),
            commitId: first.batchId,
            committedAt: first.changedAt,
            fromVersion: createWorkspaceVersion({
                generation,
                ledgerId: input.ledgerId,
                revision: fromRevision,
            }),
            toVersion: createWorkspaceVersion({
                generation,
                ledgerId: input.ledgerId,
                revision,
            }),
        };
    });
}

export function createWorkspaceSyncEnvelope(input: {
    changes: readonly WorkspaceChange[];
    knowledge: WorkspaceKnowledge;
}): WorkspaceSyncEnvelope {
    const currentVersion = workspaceKnowledgeToVersion(input.knowledge);
    const commits = createWorkspaceCommits({
        changes: input.changes,
        fallbackVersion: currentVersion,
        ledgerId: input.knowledge.activeLedgerId,
    });

    return {
        commits,
        fromVersion: commits[0]?.fromVersion ?? currentVersion,
        toVersion: commits.at(-1)?.toVersion ?? currentVersion,
    };
}

export function parseWorkspaceVersionCursor(input: {
    cursor: string | null;
    ledgerId: string;
}): WorkspaceVersion | null {
    const parsed = input.cursor ? parseWorkspaceCursor(input.cursor) : null;

    return parsed
        ? createWorkspaceVersion({
              cursor: input.cursor!,
              generation: parsed.generation,
              ledgerId: input.ledgerId,
              revision: parsed.revision,
          })
        : null;
}

export function compareWorkspaceVersions(
    left: WorkspaceVersion,
    right: WorkspaceVersion,
) {
    if (left.ledgerId !== right.ledgerId) {
        return left.ledgerId.localeCompare(right.ledgerId);
    }
    if (left.generation !== right.generation) {
        return left.generation - right.generation;
    }
    return left.revision - right.revision;
}

export function isWorkspaceCommitContiguous(
    current: WorkspaceVersion,
    commit: WorkspaceCommit,
) {
    return compareWorkspaceVersions(current, commit.fromVersion) === 0;
}
