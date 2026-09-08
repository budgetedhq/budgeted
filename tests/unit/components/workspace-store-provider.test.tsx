import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    ApplicationVersionNotifier,
    WorkspaceDataGate,
    WorkspaceStoreProvider,
    useWorkspaceStore,
} from "@/components/workspace/workspace-store-provider";
import {
    APPLICATION_VERSION,
    formatApplicationVersionForDisplay,
} from "@/lib/application-version";
import { createOptimisticWorkspaceUpsert } from "@/lib/workspace/optimistic-changes";
import { createWorkspaceKnowledgeFromSnapshot } from "@/lib/workspace/snapshot-utils";
import type {
    WorkspaceSnapshot,
    WorkspaceSyncEnvelope,
} from "@/lib/workspace/sync-types";
import { createWorkspaceVersion } from "@/lib/workspace/sync-v2";

const repository = vi.hoisted(() => ({
    applyChanges: vi.fn(),
    invalidate: vi.fn(),
    read: vi.fn(),
    readConfiguration: vi.fn(),
    readMetadata: vi.fn(),
    readTransactions: vi.fn(),
    replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/transactions" }));
vi.mock("@/lib/workspace/repository", () => ({
    indexedDbWorkspaceRepository: repository,
}));

class TestBroadcastChannel {
    static instances: TestBroadcastChannel[] = [];

    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    close = vi.fn();
    postMessage = vi.fn();

    constructor() {
        TestBroadcastChannel.instances.push(this);
    }
}

function createSnapshot(accountName = "Checking"): WorkspaceSnapshot {
    const now = "2026-08-01T12:00:00.000Z";
    const snapshot: WorkspaceSnapshot = {
        accounts: [
            {
                accountId: "account-1",
                accountType: "checking",
                balanceCents: 1_000,
                createdAt: now,
                ledgerAccountId: "financial-checking",
                ledgerId: "ledger-1",
                name: accountName,
                openedOn: "2026-01-01",
                openingBalanceCents: 1_000,
                updatedAt: now,
            },
        ],
        activeLedgerId: "ledger-1",
        activeLedgerName: "Household",
        allocationFundingSources: [],
        amazonOrderIntegrations: [],
        amazonOrderSyncRuns: [],
        amazonOrders: [],
        budgetAllocations: [],
        budgetCategories: [],
        budgetGroups: [],
        budgetPeriods: [],
        knowledge: {} as WorkspaceSnapshot["knowledge"],
        ledgerPostings: [],
        ledgers: [
            {
                createdAt: now,
                isDefault: true,
                ledgerId: "ledger-1",
                name: "Household",
                status: "active",
                updatedAt: now,
                workspaceId: "global",
            },
        ],
        plaidAccountLinks: [],
        plaidTransactionSyncs: [],
        transactionAutoMatchRejections: [],
        transactionLines: [],
        transactionTemplates: [],
        transactions: [],
    };

    snapshot.knowledge = createWorkspaceKnowledgeFromSnapshot({
        changeCursor: "g1:r0",
        entityRevisions: {},
        generatedAt: now,
        retainedChangesAfter: "2026-07-01T00:00:00.000Z",
        snapshot,
        workspaceGeneration: 1,
        workspaceRevision: 0,
    });
    return snapshot;
}

function createRenameSync(name: string): WorkspaceSyncEnvelope {
    const fromVersion = createWorkspaceVersion({
        generation: 1,
        ledgerId: "ledger-1",
        revision: 0,
    });
    const toVersion = createWorkspaceVersion({
        generation: 1,
        ledgerId: "ledger-1",
        revision: 1,
    });

    return {
        commits: [
            {
                changes: [
                    {
                        entityId: "account-1",
                        entityType: "account",
                        operation: "upsert",
                        record: {
                            ...createSnapshot().accounts[0],
                            name,
                            updatedAt: "2026-08-01T12:01:00.000Z",
                        },
                    },
                ],
                commitId: "commit-1",
                committedAt: "2026-08-01T12:01:00.000Z",
                fromVersion,
                toVersion,
            },
        ],
        fromVersion,
        toVersion,
    };
}

function Harness(props: {
    onCommitted?: () => void;
    onError?: () => void;
    request?: () => Promise<Response>;
}) {
    const {
        executeWorkspaceCommand,
        snapshot,
        transactionRepositoryState,
    } = useWorkspaceStore();

    return (
        <div>
            <span data-testid="account-name">{snapshot.accounts[0]?.name}</span>
            <span data-testid="repository-state">
                {transactionRepositoryState}
            </span>
            {props.request ? (
                <button
                    type="button"
                    onClick={() => {
                        void executeWorkspaceCommand({
                            onCommitted: props.onCommitted,
                            onError: props.onError ?? (() => undefined),
                            optimisticChanges: [
                                createOptimisticWorkspaceUpsert({
                                    entityId: "account-1",
                                    entityType: "account",
                                    record: {
                                        ...snapshot.accounts[0],
                                        name: "Optimistic",
                                    },
                                }),
                            ],
                            request: props.request!,
                        });
                    }}
                >
                    Save
                </button>
            ) : null}
        </div>
    );
}

function mutationResponse(sync: WorkspaceSyncEnvelope) {
    return new Response(JSON.stringify({ saved: true, workspaceSync: sync }), {
        headers: { "content-type": "application/json" },
        status: 200,
    });
}

describe("WorkspaceStoreProvider V2", () => {
    beforeEach(() => {
        vi.stubGlobal("BroadcastChannel", TestBroadcastChannel);
        vi.stubGlobal("fetch", vi.fn());
        repository.applyChanges.mockResolvedValue("committed");
        repository.invalidate.mockResolvedValue(undefined);
        repository.read.mockResolvedValue(null);
        repository.readConfiguration.mockResolvedValue(null);
        repository.readMetadata.mockResolvedValue(null);
        repository.readTransactions.mockResolvedValue(null);
        repository.replace.mockResolvedValue("committed");
    });

    afterEach(() => {
        TestBroadcastChannel.instances = [];
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        for (const mock of Object.values(repository)) mock.mockReset();
    });

    it("reports release and build details once for each available build", () => {
        const notifyWarning = vi.fn(() => "toast-1");
        const notifier = new ApplicationVersionNotifier();
        const serverVersion = "2026-08-01T13:00:00.000Z";
        const server = {
            applicationReleaseTag: "v0.1.3",
            applicationVersion: serverVersion,
        };

        notifier.notify({ notifyWarning, server });
        notifier.notify({ notifyWarning, server });

        expect(notifyWarning).toHaveBeenCalledOnce();
        expect(notifyWarning).toHaveBeenCalledWith(
            expect.objectContaining({
                details: [
                    `Current: ${formatApplicationVersionForDisplay(APPLICATION_VERSION)}`,
                    `Available: ${formatApplicationVersionForDisplay({
                        buildTimestamp: serverVersion,
                        releaseTag: "v0.1.3",
                    })}`,
                ],
                title: "Update ready",
            }),
        );
    });

    it("falls back to the build timestamp for an older server", () => {
        const notifyWarning = vi.fn(() => "toast-1");
        const notifier = new ApplicationVersionNotifier();
        const serverVersion = "2026-08-01T13:00:00.000Z";

        notifier.notify({
            notifyWarning,
            server: { applicationVersion: serverVersion },
        });

        expect(notifyWarning).toHaveBeenCalledWith(
            expect.objectContaining({
                details: expect.arrayContaining([
                    `Available: built ${formatApplicationVersionForDisplay(serverVersion)}`,
                ]),
            }),
        );
    });

    it("does not report a matching build", () => {
        const notifyWarning = vi.fn(() => "toast-1");
        const notifier = new ApplicationVersionNotifier();

        notifier.notify({
            notifyWarning,
            server: {
                applicationReleaseTag: APPLICATION_VERSION.releaseTag,
                applicationVersion: APPLICATION_VERSION.buildTimestamp,
            },
        });

        expect(notifyWarning).not.toHaveBeenCalled();
    });

    it("renders a complete cached replica before the version request resolves", async () => {
        const cached = createSnapshot();
        repository.read.mockResolvedValue(cached);
        vi.mocked(fetch).mockReturnValue(new Promise<Response>(() => undefined));

        render(
            <WorkspaceStoreProvider
                bootstrap={{
                    cacheOwnerId: "owner-1",
                    initialLedgerId: "ledger-1",
                    initialLedgerName: "Household",
                }}
            >
                <WorkspaceDataGate>
                    <Harness />
                </WorkspaceDataGate>
            </WorkspaceStoreProvider>,
        );

        await waitFor(() =>
            expect(screen.getByTestId("account-name")).toHaveTextContent(
                "Checking",
            ),
        );
        expect(repository.read).toHaveBeenCalledWith({
            cacheOwnerId: "owner-1",
            ledgerId: "ledger-1",
        });
        expect(fetch).toHaveBeenCalledWith("/api/workspace/version");
    });

    it("shows an optimistic overlay immediately and installs the returned commit", async () => {
        const onCommitted = vi.fn();
        const request = vi
            .fn()
            .mockResolvedValue(mutationResponse(createRenameSync("Everyday")));

        render(
            <WorkspaceStoreProvider
                bootstrap={{
                    cacheOwnerId: "owner-1",
                    initialLedgerId: "ledger-1",
                    initialLedgerName: "Household",
                }}
                initialSnapshot={createSnapshot()}
            >
                <Harness onCommitted={onCommitted} request={request} />
            </WorkspaceStoreProvider>,
        );

        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(screen.getByTestId("account-name")).toHaveTextContent(
            "Optimistic",
        );

        await waitFor(() => expect(onCommitted).toHaveBeenCalledOnce());
        expect(screen.getByTestId("account-name")).toHaveTextContent(
            "Everyday",
        );
        expect(repository.applyChanges).toHaveBeenCalledOnce();
        expect(fetch).not.toHaveBeenCalled();
    });

    it("discards an optimistic overlay after a network failure without downloading a snapshot", async () => {
        const onError = vi.fn();

        render(
            <WorkspaceStoreProvider initialSnapshot={createSnapshot()}>
                <Harness
                    onError={onError}
                    request={() => Promise.reject(new Error("offline"))}
                />
            </WorkspaceStoreProvider>,
        );

        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(screen.getByTestId("account-name")).toHaveTextContent(
            "Optimistic",
        );

        await waitFor(() => expect(onError).toHaveBeenCalledOnce());
        expect(screen.getByTestId("account-name")).toHaveTextContent(
            "Checking",
        );
        expect(fetch).not.toHaveBeenCalled();
    });

    it("keeps a successful commit in memory when IndexedDB persistence fails", async () => {
        const onCommitted = vi.fn();
        repository.applyChanges.mockRejectedValueOnce(new Error("quota"));

        render(
            <WorkspaceStoreProvider
                bootstrap={{
                    cacheOwnerId: "owner-1",
                    initialLedgerId: "ledger-1",
                    initialLedgerName: "Household",
                }}
                initialSnapshot={createSnapshot()}
            >
                <Harness
                    onCommitted={onCommitted}
                    request={() =>
                        Promise.resolve(
                            mutationResponse(createRenameSync("Everyday")),
                        )
                    }
                />
            </WorkspaceStoreProvider>,
        );

        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onCommitted).toHaveBeenCalledOnce());
        expect(screen.getByTestId("account-name")).toHaveTextContent(
            "Everyday",
        );
        expect(screen.getByTestId("repository-state")).toHaveTextContent(
            "memoryFallback",
        );
        expect(repository.invalidate).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });

    it("applies a cross-tab commit envelope idempotently without a network request", async () => {
        render(
            <WorkspaceStoreProvider
                bootstrap={{
                    cacheOwnerId: "owner-1",
                    initialLedgerId: "ledger-1",
                    initialLedgerName: "Household",
                }}
                initialSnapshot={createSnapshot()}
            >
                <Harness />
            </WorkspaceStoreProvider>,
        );
        const channel = TestBroadcastChannel.instances[0]!;
        const sync = createRenameSync("Everyday");

        channel.onmessage?.({
            data: { sync, type: "workspace-sync-v2" },
        } as MessageEvent<unknown>);
        channel.onmessage?.({
            data: { sync, type: "workspace-sync-v2" },
        } as MessageEvent<unknown>);

        await waitFor(() =>
            expect(screen.getByTestId("account-name")).toHaveTextContent(
                "Everyday",
            ),
        );
        expect(repository.applyChanges).toHaveBeenCalledOnce();
        expect(fetch).not.toHaveBeenCalled();
    });
});
