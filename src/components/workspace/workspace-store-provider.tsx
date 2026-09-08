"use client";

import { faCircleNotch } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { ulid } from "ulid";

import {
    readWorkspaceMutationResponse,
    type WorkspaceMutationResponse,
} from "@/lib/workspace/mutation-response";
import {
    WORKSPACE_RECONCILIATION_REQUIRED_EVENT,
    WorkspaceMutationResponseError,
} from "@/lib/workspace/reconciliation";
import {
    applyWorkspaceChanges,
    createEmptyWorkspaceSnapshotRecords,
} from "@/lib/workspace/snapshot-utils";
import {
    calculateWorkspaceEntityDigests,
    createWorkspaceEntityRevisionTokens,
} from "@/lib/workspace/revision";
import {
    type WorkspaceChange,
    type WorkspaceEntityCounts,
    type WorkspaceKnowledge,
    type WorkspaceSnapshot,
    type WorkspaceSyncEnvelope,
    type WorkspaceVersionResult,
} from "@/lib/workspace/sync-types";
import type { OptimisticWorkspaceChange } from "@/lib/workspace/optimistic-changes";
import {
    getWorkspaceGeneration,
    isTransactionFamilyFullyHydrated,
    type WorkspaceTransactionQuery as CachedTransactionQuery,
} from "@/lib/workspace/workspace-protocol";
import {
    APPLICATION_VERSION,
    formatApplicationVersionForDisplay,
    isApplicationReleaseTag,
    isApplicationVersionTimestamp,
} from "@/lib/application-version";
import { useFeedbackToasts } from "@/components/shared/feedback-toast-provider";
import { LedgerLoadRecovery } from "@/components/workspace/ledger-load-recovery";
import {
    useBackgroundMutationActivity,
    type BackgroundMutationActivityInput,
} from "@/components/shared/background-mutation-activity-provider";
import type {
    CachedTransactionQueryResult,
    WorkspaceCacheIdentity,
} from "@/lib/workspace/repository";
import {
    isWorkspaceTransactionEntityType,
    WORKSPACE_ENTITY_TYPES,
} from "@/lib/workspace/entity-config";
import { createBrowserWorkspaceSyncPorts } from "@/lib/workspace/workspace-sync-browser-ports";
import {
    WorkspaceSyncController,
    type CommittedWorkspaceControllerOutcome,
    type TransactionRepositoryState,
    type WorkspaceSyncControllerState,
    type WorkspaceSyncStatus,
} from "@/lib/workspace/workspace-sync-controller";

export type WorkspaceBootstrap = {
    cacheOwnerId: string;
    initialLedgerId: string;
    initialLedgerName: string;
};

/**
 * @deprecated Use WorkspaceMutationExecutionInput with executeWorkspaceCommand.
 */
export type OptimisticWorkspaceMutationInput = {
    changes: OptimisticWorkspaceChange[];
    onError: (error: unknown) => Promise<void> | void;
    onResponse?: (response: Response) => Promise<void> | void;
    onSuccess?: () => Promise<void> | void;
    request: () => Promise<Response>;
};

export type WorkspaceMutationExecutionInput<TResponse extends object> = {
    activity?: BackgroundMutationActivityInput;
    onCommitted?: (
        response: WorkspaceMutationResponse<TResponse>,
    ) => Promise<void> | void;
    onError: (error: unknown) => Promise<void> | void;
    optimisticChanges?: OptimisticWorkspaceChange[];
    request: () => Promise<Response>;
};

export type CommittedWorkspaceChangesInput = {
    changes: WorkspaceChange[];
    knowledge?: WorkspaceKnowledge;
    optimisticMutationId?: string | null;
    optimisticChanges?: OptimisticWorkspaceChange[];
};

export type CommittedWorkspaceApplicationOutcome =
    CommittedWorkspaceControllerOutcome;
export type OptimisticWorkspaceMutationOutcome = "committed" | "failed";

type OptimisticWorkspaceOverlay = {
    changes: OptimisticWorkspaceChange[];
    ledgerId: string;
    mutationId: string;
    status: "pending";
    suspended: boolean;
    workspaceGeneration: number;
};

type WorkspaceStoreContextValue = {
    /**
     * @deprecated Prefer applyWorkspaceMutationResponse so response validation,
     * knowledge binding, and committed application stay coupled.
     */
    applyCommittedWorkspaceChanges: (
        input: WorkspaceChange[] | CommittedWorkspaceChangesInput,
    ) => Promise<CommittedWorkspaceApplicationOutcome>;
    applyOptimisticWorkspaceChanges: (
        changes: OptimisticWorkspaceChange[],
    ) => string | null;
    applyWorkspaceMutationResponse: <TResponse extends object>(
        response: Response,
        input?: {
            optimisticChanges?: OptimisticWorkspaceChange[];
            optimisticMutationId?: string | null;
        },
    ) => Promise<WorkspaceMutationResponse<TResponse>>;
    discardOptimisticWorkspaceChanges: (mutationId: string | null) => void;
    executeWorkspaceCommand: <TResponse extends object>(
        input: WorkspaceMutationExecutionInput<TResponse>,
    ) => Promise<OptimisticWorkspaceMutationOutcome>;
    /** @deprecated Use executeWorkspaceCommand. */
    executeWorkspaceMutation: <TResponse extends object>(
        input: WorkspaceMutationExecutionInput<TResponse>,
    ) => Promise<OptimisticWorkspaceMutationOutcome>;
    getWorkspaceCacheIdentity: (
        ledgerId: string,
    ) => WorkspaceCacheIdentity | null;
    isReady: boolean;
    optimisticTransactionChanges: OptimisticWorkspaceChange[];
    readCachedTransactions: (input: {
        identity: WorkspaceCacheIdentity;
        query?: CachedTransactionQuery;
    }) => Promise<CachedTransactionQueryResult | null>;
    reconcileFullWorkspaceMutation: (response: Response) => Promise<void>;
    refreshWorkspaceSnapshot: () => Promise<void>;
    requestTransactionRepositoryRecovery: () => Promise<void>;
    snapshot: WorkspaceSnapshot;
    /**
     * @deprecated Use executeWorkspaceCommand.
     */
    startOptimisticWorkspaceMutation: (
        input: OptimisticWorkspaceMutationInput,
    ) => Promise<OptimisticWorkspaceMutationOutcome>;
    /**
     * @deprecated Use reconcileFullWorkspaceMutation for documented mutations
     * that cannot return bounded workspace changes.
     */
    syncAfterMutation: (response: Response) => Promise<void>;
    syncStatus: WorkspaceSyncStatus;
    syncWorkspace: () => Promise<void>;
    transactionRepositoryRevision: number;
    transactionRepositoryState: TransactionRepositoryState;
};

const WorkspaceStoreContext = createContext<WorkspaceStoreContextValue | null>(
    null,
);
const EMPTY_OPTIMISTIC_TRANSACTION_CHANGES: OptimisticWorkspaceChange[] = [];

function createEmptyEntityCounts() {
    return Object.fromEntries(
        WORKSPACE_ENTITY_TYPES.map((entityType) => [entityType, 0]),
    ) as WorkspaceEntityCounts;
}

function createFallbackSnapshot(
    bootstrap?: WorkspaceBootstrap,
): WorkspaceSnapshot {
    const generatedAt = new Date(0).toISOString();
    const emptyRecords = createEmptyWorkspaceSnapshotRecords();

    return {
        accounts: [],
        activeLedgerId: bootstrap?.initialLedgerId ?? "",
        activeLedgerName: bootstrap?.initialLedgerName ?? "",
        allocationFundingSources: [],
        amazonOrderIntegrations: [],
        amazonOrderSyncRuns: [],
        amazonOrders: [],
        baseChangeCursor: "",
        budgetAllocations: [],
        budgetCategories: [],
        budgetGroups: [],
        budgetPeriods: [],
        knowledge: {
            activeLedgerId: bootstrap?.initialLedgerId ?? "",
            changeCursor: "",
            entityCounts: createEmptyEntityCounts(),
            entityDigests: calculateWorkspaceEntityDigests(emptyRecords),
            entityRevisions: createWorkspaceEntityRevisionTokens({
                generation: 1,
                revision: 0,
            }),
            generatedAt,
            oldestRetainedWorkspaceRevision: 0,
            retainedChangesAfter: generatedAt,
            revision: "",
            workspaceGeneration: 1,
            workspaceRevision: 0,
        },
        ledgerPostings: [],
        ledgers: [],
        plaidAccountLinks: [],
        plaidTransactionSyncs: [],
        transactionAutoMatchRejections: [],
        transactionLines: [],
        transactionTemplates: [],
        transactions: [],
        venmoAccountMappings: [],
        venmoIntegrations: [],
    };
}

function startFallbackOptimisticWorkspaceMutation(
    input: OptimisticWorkspaceMutationInput,
) {
    return (async (): Promise<OptimisticWorkspaceMutationOutcome> => {
        try {
            const response = await input.request();

            if (!response.ok) {
                throw response;
            }

            await input.onResponse?.(response);
            await input.onSuccess?.();
            return "committed";
        } catch (error) {
            await input.onError(error);
            return "failed";
        }
    })();
}

async function executeFallbackWorkspaceMutation<TResponse extends object>(
    input: WorkspaceMutationExecutionInput<TResponse>,
): Promise<OptimisticWorkspaceMutationOutcome> {
    try {
        const response = await input.request();

        if (!response.ok) {
            throw response;
        }

        await input.onCommitted?.(
            await readWorkspaceMutationResponse<TResponse>(response),
        );
        return "committed";
    } catch (error) {
        await input.onError(error);
        return "failed";
    }
}

const fallbackContext: WorkspaceStoreContextValue = {
    applyCommittedWorkspaceChanges: async () => "committed",
    applyOptimisticWorkspaceChanges: () => null,
    applyWorkspaceMutationResponse: readWorkspaceMutationResponse,
    discardOptimisticWorkspaceChanges: () => undefined,
    executeWorkspaceCommand: executeFallbackWorkspaceMutation,
    executeWorkspaceMutation: executeFallbackWorkspaceMutation,
    getWorkspaceCacheIdentity: () => null,
    isReady: false,
    optimisticTransactionChanges: [],
    readCachedTransactions: async () => null,
    reconcileFullWorkspaceMutation: async () => undefined,
    refreshWorkspaceSnapshot: async () => undefined,
    requestTransactionRepositoryRecovery: async () => undefined,
    snapshot: createFallbackSnapshot(),
    startOptimisticWorkspaceMutation: startFallbackOptimisticWorkspaceMutation,
    syncAfterMutation: async () => undefined,
    syncStatus: "idle",
    syncWorkspace: async () => undefined,
    transactionRepositoryRevision: 0,
    transactionRepositoryState: "unavailable",
};

const WORKSPACE_RECONCILIATION_INTERVAL_MS = 60_000;
const WORKSPACE_RECONCILIATION_MAX_BACKOFF_MS = 5 * 60_000;
const WORKSPACE_RECONCILIATION_JITTER_MS = 5_000;

type WorkspaceStoreProviderProps = {
    bootstrap?: WorkspaceBootstrap;
    children: ReactNode;
    initialSnapshot?: WorkspaceSnapshot;
};

function normalizeCommittedWorkspaceChangesInput(
    input: WorkspaceChange[] | CommittedWorkspaceChangesInput,
) {
    return Array.isArray(input) ? { changes: input } : input;
}

function projectOptimisticWorkspaceOverlays(
    canonicalSnapshot: WorkspaceSnapshot,
    overlays: OptimisticWorkspaceOverlay[],
) {
    const generation = getWorkspaceGeneration(canonicalSnapshot.knowledge);

    return overlays
        .filter(
            (overlay) =>
                overlay.status === "pending" &&
                !overlay.suspended &&
                overlay.ledgerId === canonicalSnapshot.activeLedgerId &&
                overlay.workspaceGeneration === generation,
        )
        .reduce(
            (renderedSnapshot, overlay) =>
                applyWorkspaceChanges(renderedSnapshot, overlay.changes, {
                    deriveAccountBalances:
                        isTransactionFamilyFullyHydrated(canonicalSnapshot),
                    validateTransitions: false,
                }),
            canonicalSnapshot,
        );
}

function selectOptimisticTransactionChanges(
    canonicalSnapshot: WorkspaceSnapshot,
    overlays: OptimisticWorkspaceOverlay[],
) {
    const generation = getWorkspaceGeneration(canonicalSnapshot.knowledge);
    const changes = overlays
        .filter(
            (overlay) =>
                overlay.status === "pending" &&
                overlay.ledgerId === canonicalSnapshot.activeLedgerId &&
                overlay.workspaceGeneration === generation,
        )
        .flatMap((overlay) =>
            overlay.changes.filter((change) =>
                isWorkspaceTransactionEntityType(change.entityType),
            ),
        );

    return changes.length > 0 ? changes : EMPTY_OPTIMISTIC_TRANSACTION_CHANGES;
}

function getReconciliationDelay(failureCount: number) {
    const backoff = Math.min(
        WORKSPACE_RECONCILIATION_MAX_BACKOFF_MS,
        WORKSPACE_RECONCILIATION_INTERVAL_MS * 2 ** failureCount,
    );

    return (
        backoff + Math.floor(Math.random() * WORKSPACE_RECONCILIATION_JITTER_MS)
    );
}

class WorkspaceChannelPublisher {
    private channel: BroadcastChannel | null = null;

    attach(channel: BroadcastChannel) {
        this.channel = channel;
    }

    detach(channel: BroadcastChannel) {
        if (this.channel === channel) {
            this.channel = null;
        }
    }

    publish(knowledge: WorkspaceKnowledge) {
        this.channel?.postMessage({
            changeCursor: knowledge.changeCursor,
            ledgerId: knowledge.activeLedgerId,
            type: "workspace-updated",
            workspaceGeneration: knowledge.workspaceGeneration,
            workspaceRevision: knowledge.workspaceRevision,
        });
    }

    publishSync(sync: WorkspaceSyncEnvelope) {
        this.channel?.postMessage({ sync, type: "workspace-sync-v2" });
    }
}

export class ApplicationVersionNotifier {
    private readonly warnedServerVersions = new Set<string>();

    notify(input: {
        server: {
            applicationReleaseTag?: string;
            applicationVersion?: string;
        };
        notifyWarning: ReturnType<typeof useFeedbackToasts>["notifyWarning"];
    }) {
        const serverVersion = input.server.applicationVersion;

        if (
            !isApplicationVersionTimestamp(
                APPLICATION_VERSION.buildTimestamp,
            ) ||
            !isApplicationVersionTimestamp(serverVersion) ||
            serverVersion === APPLICATION_VERSION.buildTimestamp ||
            this.warnedServerVersions.has(serverVersion)
        ) {
            return;
        }

        const serverReleaseTag = isApplicationReleaseTag(
            input.server.applicationReleaseTag,
        )
            ? input.server.applicationReleaseTag
            : undefined;

        this.warnedServerVersions.add(serverVersion);
        input.notifyWarning({
            action: {
                label: "Refresh now",
                onSelect: () => window.location.reload(),
            },
            message:
                "A newer version of Budgeted is ready. Refresh to load the latest improvements.",
            details: [
                `Current: ${formatApplicationVersionForDisplay(APPLICATION_VERSION)}`,
                `Available: ${formatApplicationVersionForDisplay({
                    buildTimestamp: serverVersion,
                    releaseTag: serverReleaseTag,
                })}`,
            ],
            title: "Update ready",
        });
    }
}

export function WorkspaceStoreProvider({
    bootstrap,
    children,
    initialSnapshot,
}: WorkspaceStoreProviderProps) {
    const { startActivity } = useBackgroundMutationActivity();
    const pathname = usePathname();
    const { notifyWarning } = useFeedbackToasts();
    const [channelPublisher] = useState(() => new WorkspaceChannelPublisher());
    const [applicationVersionNotifier] = useState(
        () => new ApplicationVersionNotifier(),
    );
    const optimisticOverlaysRef = useRef<OptimisticWorkspaceOverlay[]>([]);
    const [optimisticTransactionChanges, setOptimisticTransactionChanges] =
        useState<OptimisticWorkspaceChange[]>(
            EMPTY_OPTIMISTIC_TRANSACTION_CHANGES,
        );
    const lastSyncedPathnameRef = useRef(pathname);
    const handleServerKnowledge = useCallback(
        (knowledge: WorkspaceKnowledge) =>
            applicationVersionNotifier.notify({ server: knowledge, notifyWarning }),
        [applicationVersionNotifier, notifyWarning],
    );
    const handleServerVersion = useCallback(
        (version: WorkspaceVersionResult) =>
            applicationVersionNotifier.notify({ server: version, notifyWarning }),
        [applicationVersionNotifier, notifyWarning],
    );
    const [controller] = useState(
        () =>
            new WorkspaceSyncController({
                cacheOwnerId: bootstrap?.cacheOwnerId,
                initialSnapshot:
                    initialSnapshot ?? createFallbackSnapshot(bootstrap),
                initialSnapshotProvided: Boolean(initialSnapshot),
                ports: createBrowserWorkspaceSyncPorts({
                    onKnowledgeReceived: handleServerKnowledge,
                    onVersionReceived: handleServerVersion,
                    publishKnowledge: (knowledge) =>
                        channelPublisher.publish(knowledge),
                    publishSync: (sync) => channelPublisher.publishSync(sync),
                }),
            }),
    );
    const [controllerState, setControllerState] =
        useState<WorkspaceSyncControllerState>(() => controller.getState());
    const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>(
        controllerState.snapshot,
    );

    useEffect(() => {
        controller.activate();
        const unsubscribe = controller.subscribe((nextState) => {
            const generation = getWorkspaceGeneration(
                nextState.snapshot.knowledge,
            );
            const compatibleOverlays = optimisticOverlaysRef.current.filter(
                (overlay) =>
                    overlay.ledgerId === nextState.snapshot.activeLedgerId &&
                    overlay.workspaceGeneration === generation,
            );

            optimisticOverlaysRef.current = compatibleOverlays;
            setOptimisticTransactionChanges(
                selectOptimisticTransactionChanges(
                    nextState.snapshot,
                    compatibleOverlays,
                ),
            );
            setControllerState(nextState);
            setSnapshot(
                projectOptimisticWorkspaceOverlays(
                    nextState.snapshot,
                    compatibleOverlays,
                ),
            );
        });

        return () => {
            unsubscribe();
            controller.dispose();
        };
    }, [controller]);

    const removeOptimisticWorkspaceOverlay = useCallback(
        (
            mutationId: string | null,
            eventType:
                | "optimisticOverlayCommitted"
                | "optimisticOverlayDiscarded",
        ) => {
            if (!mutationId) {
                return;
            }

            const nextOverlays = optimisticOverlaysRef.current.filter(
                (overlay) => overlay.mutationId !== mutationId,
            );

            if (nextOverlays.length === optimisticOverlaysRef.current.length) {
                return;
            }

            optimisticOverlaysRef.current = nextOverlays;
            setOptimisticTransactionChanges(
                selectOptimisticTransactionChanges(
                    controller.getState().snapshot,
                    nextOverlays,
                ),
            );
            controller.recordOptimisticOverlayEvent(eventType, mutationId);
            setSnapshot(
                projectOptimisticWorkspaceOverlays(
                    controller.getState().snapshot,
                    nextOverlays,
                ),
            );
        },
        [controller],
    );

    const discardOptimisticWorkspaceChanges = useCallback(
        (mutationId: string | null) => {
            removeOptimisticWorkspaceOverlay(
                mutationId,
                "optimisticOverlayDiscarded",
            );
        },
        [removeOptimisticWorkspaceOverlay],
    );

    const applyOptimisticWorkspaceChanges = useCallback(
        (changes: OptimisticWorkspaceChange[]) => {
            if (changes.length === 0) {
                return null;
            }

            const canonicalSnapshot = controller.getState().snapshot;
            const mutationId = `optimistic:${ulid()}`;
            const overlay: OptimisticWorkspaceOverlay = {
                changes,
                ledgerId: canonicalSnapshot.activeLedgerId,
                mutationId,
                status: "pending",
                suspended: false,
                workspaceGeneration: getWorkspaceGeneration(
                    canonicalSnapshot.knowledge,
                ),
            };
            const nextOverlays = [...optimisticOverlaysRef.current, overlay];

            optimisticOverlaysRef.current = nextOverlays;
            setOptimisticTransactionChanges(
                selectOptimisticTransactionChanges(
                    canonicalSnapshot,
                    nextOverlays,
                ),
            );
            controller.recordOptimisticOverlayEvent(
                "optimisticOverlayStarted",
                mutationId,
            );
            setSnapshot(
                projectOptimisticWorkspaceOverlays(
                    canonicalSnapshot,
                    nextOverlays,
                ),
            );
            return mutationId;
        },
        [controller],
    );

    const applyCommittedWorkspaceChanges = useCallback(
        async (
            input: WorkspaceChange[] | CommittedWorkspaceChangesInput,
        ): Promise<CommittedWorkspaceApplicationOutcome> => {
            const normalizedInput =
                normalizeCommittedWorkspaceChangesInput(input);
            const optimisticMutationId =
                normalizedInput.optimisticMutationId ?? null;

            if (optimisticMutationId) {
                optimisticOverlaysRef.current =
                    optimisticOverlaysRef.current.map((overlay) =>
                        overlay.mutationId === optimisticMutationId
                            ? { ...overlay, suspended: true }
                            : overlay,
                    );
                setOptimisticTransactionChanges(
                    selectOptimisticTransactionChanges(
                        controller.getState().snapshot,
                        optimisticOverlaysRef.current,
                    ),
                );
                setSnapshot(
                    projectOptimisticWorkspaceOverlays(
                        controller.getState().snapshot,
                        optimisticOverlaysRef.current,
                    ),
                );
            }

            try {
                return await controller.applyCommittedWorkspaceChanges({
                    changes: normalizedInput.changes,
                    knowledge: normalizedInput.knowledge,
                });
            } finally {
                removeOptimisticWorkspaceOverlay(
                    optimisticMutationId,
                    "optimisticOverlayCommitted",
                );
            }
        },
        [controller, removeOptimisticWorkspaceOverlay],
    );

    const applyWorkspaceMutationResponse = useCallback(
        async <TResponse extends object>(
            response: Response,
            input: {
                optimisticChanges?: OptimisticWorkspaceChange[];
                optimisticMutationId?: string | null;
            } = {},
        ) => {
            const payload =
                await readWorkspaceMutationResponse<TResponse>(response);

            if (input.optimisticMutationId) {
                optimisticOverlaysRef.current =
                    optimisticOverlaysRef.current.map((overlay) =>
                        overlay.mutationId === input.optimisticMutationId
                            ? { ...overlay, suspended: true }
                            : overlay,
                    );
            }

            try {
                await controller.applyWorkspaceSync(payload.workspaceSync);
            } finally {
                removeOptimisticWorkspaceOverlay(
                    input.optimisticMutationId ?? null,
                    "optimisticOverlayCommitted",
                );
            }
            return payload;
        },
        [controller, removeOptimisticWorkspaceOverlay],
    );

    const refreshWorkspaceSnapshot = useCallback(
        () => controller.refreshWorkspaceSnapshot(),
        [controller],
    );

    const executeWorkspaceCommand = useCallback(
        <TResponse extends object>(
            input: WorkspaceMutationExecutionInput<TResponse>,
        ) => {
            const activity = input.activity
                ? startActivity(input.activity)
                : null;
            const optimisticMutationId = applyOptimisticWorkspaceChanges(
                input.optimisticChanges ?? [],
            );

            return (async (): Promise<OptimisticWorkspaceMutationOutcome> => {
                try {
                    const response = await input.request();

                    if (!response.ok) {
                        throw response;
                    }

                    const payload =
                        await applyWorkspaceMutationResponse<TResponse>(
                            response,
                            {
                                optimisticChanges: input.optimisticChanges,
                                optimisticMutationId,
                            },
                        );

                    await input.onCommitted?.(payload);
                    activity?.complete();
                    return "committed";
                } catch (error) {
                    activity?.fail();
                    discardOptimisticWorkspaceChanges(optimisticMutationId);
                    if (
                        error instanceof WorkspaceMutationResponseError ||
                        (error instanceof Response && error.status === 409)
                    ) {
                        await controller.syncWorkspace();
                    }
                    await input.onError(error);
                    return "failed";
                }
            })();
        },
        [
            applyOptimisticWorkspaceChanges,
            applyWorkspaceMutationResponse,
            discardOptimisticWorkspaceChanges,
            controller,
            startActivity,
        ],
    );

    const reconcileFullWorkspaceMutation = useCallback(
        async (response: Response) => {
            if (response.bodyUsed) {
                await controller.syncWorkspace();
                return;
            }

            await applyWorkspaceMutationResponse(response);
        },
        [applyWorkspaceMutationResponse, controller],
    );

    const startOptimisticWorkspaceMutation = useCallback(
        (input: OptimisticWorkspaceMutationInput) => {
            const optimisticMutationId = applyOptimisticWorkspaceChanges(
                input.changes,
            );

            return (async (): Promise<OptimisticWorkspaceMutationOutcome> => {
                try {
                    const response = await input.request();

                    if (!response.ok) {
                        throw response;
                    }

                    if (input.onResponse) {
                        await input.onResponse(response);
                    } else {
                        await reconcileFullWorkspaceMutation(response);
                    }
                    removeOptimisticWorkspaceOverlay(
                        optimisticMutationId,
                        "optimisticOverlayCommitted",
                    );
                    await input.onSuccess?.();
                    return "committed";
                } catch (error) {
                    discardOptimisticWorkspaceChanges(optimisticMutationId);
                    if (
                        error instanceof WorkspaceMutationResponseError ||
                        (error instanceof Response && error.status === 409)
                    ) {
                        await controller.syncWorkspace();
                    }
                    await input.onError(error);
                    return "failed";
                }
            })();
        },
        [
            applyOptimisticWorkspaceChanges,
            discardOptimisticWorkspaceChanges,
            reconcileFullWorkspaceMutation,
            controller,
            removeOptimisticWorkspaceOverlay,
        ],
    );

    const syncWorkspace = useCallback(
        () => controller.syncWorkspace(),
        [controller],
    );
    const requestTransactionRepositoryRecovery = useCallback(
        () => controller.requestTransactionRepositoryRecovery(),
        [controller],
    );
    const readCachedTransactions = useCallback(
        (input: {
            identity: WorkspaceCacheIdentity;
            query?: CachedTransactionQuery;
        }) => controller.readCachedTransactions(input),
        [controller],
    );
    const getWorkspaceCacheIdentity = useCallback(
        (ledgerId: string) => controller.getCacheIdentity(ledgerId),
        [controller],
    );

    useEffect(() => {
        if (!initialSnapshot) {
            void controller.syncWorkspace();
        }
    }, [controller, initialSnapshot]);

    useEffect(() => {
        function handleFocus() {
            if (
                document.visibilityState === "visible" &&
                navigator.onLine !== false
            ) {
                void controller.syncWorkspace();
            }
        }

        window.addEventListener("focus", handleFocus);
        return () => window.removeEventListener("focus", handleFocus);
    }, [controller]);

    useEffect(() => {
        let failureCount = 0;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let disposed = false;
        const isEligible = () =>
            document.visibilityState === "visible" &&
            navigator.onLine !== false;
        const clearTimer = () => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        };
        const schedule = (delay: number) => {
            clearTimer();
            if (!disposed && isEligible()) {
                timer = setTimeout(() => void reconcile(), delay);
            }
        };
        const reconcile = async () => {
            if (disposed || !isEligible()) {
                return;
            }

            const succeeded = await controller.syncWorkspaceWithResult();
            if (!disposed) {
                failureCount = succeeded ? 0 : failureCount + 1;
                schedule(getReconciliationDelay(failureCount));
            }
        };
        const handleVisibilityChange = () => {
            if (document.visibilityState === "visible") {
                void reconcile();
            } else {
                clearTimer();
            }
        };
        const handleOnline = () => void reconcile();
        const handleOffline = () => clearTimer();

        document.addEventListener("visibilitychange", handleVisibilityChange);
        window.addEventListener("online", handleOnline);
        window.addEventListener("offline", handleOffline);
        schedule(getReconciliationDelay(0));

        return () => {
            disposed = true;
            clearTimer();
            document.removeEventListener(
                "visibilitychange",
                handleVisibilityChange,
            );
            window.removeEventListener("online", handleOnline);
            window.removeEventListener("offline", handleOffline);
        };
    }, [controller]);

    useEffect(() => {
        const handleReconciliationRequired = () => {
            void controller.refreshWorkspaceSnapshot();
        };

        window.addEventListener(
            WORKSPACE_RECONCILIATION_REQUIRED_EVENT,
            handleReconciliationRequired,
        );
        return () =>
            window.removeEventListener(
                WORKSPACE_RECONCILIATION_REQUIRED_EVENT,
                handleReconciliationRequired,
            );
    }, [controller]);

    useEffect(() => {
        if (
            !bootstrap?.cacheOwnerId ||
            typeof BroadcastChannel === "undefined"
        ) {
            return;
        }

        const channel = new BroadcastChannel("budgeted-workspace");
        channelPublisher.attach(channel);
        channel.onmessage = (event: MessageEvent<unknown>) => {
            const message = event.data as {
                changeCursor?: string;
                ledgerId?: string;
                type?: string;
                workspaceGeneration?: number;
                workspaceRevision?: number;
                sync?: WorkspaceSyncEnvelope;
            };

            if (
                message.type === "workspace-sync-v2" &&
                message.sync?.toVersion.protocolVersion === 2
            ) {
                void controller.applyWorkspaceSync(message.sync);
                return;
            }

            if (
                message.type === "workspace-updated" &&
                typeof message.changeCursor === "string" &&
                typeof message.ledgerId === "string" &&
                typeof message.workspaceGeneration === "number" &&
                typeof message.workspaceRevision === "number" &&
                document.visibilityState === "visible" &&
                navigator.onLine !== false
            ) {
                void controller.receiveCrossTabKnowledge({
                    changeCursor: message.changeCursor,
                    ledgerId: message.ledgerId,
                    workspaceGeneration: message.workspaceGeneration,
                    workspaceRevision: message.workspaceRevision,
                });
            }
        };

        return () => {
            channel.close();
            channelPublisher.detach(channel);
        };
    }, [bootstrap?.cacheOwnerId, channelPublisher, controller]);

    useEffect(() => {
        if (lastSyncedPathnameRef.current !== pathname) {
            lastSyncedPathnameRef.current = pathname;
            void controller.syncWorkspace();
        }
    }, [controller, pathname]);

    const contextValue = useMemo<WorkspaceStoreContextValue>(
        () => ({
            applyCommittedWorkspaceChanges,
            applyOptimisticWorkspaceChanges,
            applyWorkspaceMutationResponse,
            discardOptimisticWorkspaceChanges,
            executeWorkspaceCommand,
            executeWorkspaceMutation: executeWorkspaceCommand,
            getWorkspaceCacheIdentity,
            isReady: controllerState.isReady,
            optimisticTransactionChanges,
            readCachedTransactions,
            reconcileFullWorkspaceMutation,
            refreshWorkspaceSnapshot,
            requestTransactionRepositoryRecovery,
            snapshot,
            startOptimisticWorkspaceMutation,
            syncAfterMutation: reconcileFullWorkspaceMutation,
            syncStatus: controllerState.syncStatus,
            syncWorkspace,
            transactionRepositoryRevision:
                controllerState.transactionRepositoryRevision,
            transactionRepositoryState:
                controllerState.transactionRepositoryState,
        }),
        [
            applyCommittedWorkspaceChanges,
            applyOptimisticWorkspaceChanges,
            applyWorkspaceMutationResponse,
            controllerState.isReady,
            controllerState.syncStatus,
            controllerState.transactionRepositoryRevision,
            controllerState.transactionRepositoryState,
            discardOptimisticWorkspaceChanges,
            executeWorkspaceCommand,
            getWorkspaceCacheIdentity,
            optimisticTransactionChanges,
            readCachedTransactions,
            reconcileFullWorkspaceMutation,
            refreshWorkspaceSnapshot,
            requestTransactionRepositoryRecovery,
            snapshot,
            startOptimisticWorkspaceMutation,
            syncWorkspace,
        ],
    );

    return (
        <WorkspaceStoreContext.Provider value={contextValue}>
            {children}
        </WorkspaceStoreContext.Provider>
    );
}

export function WorkspaceDataGate({ children }: { children: ReactNode }) {
    const { isReady, snapshot, syncStatus, syncWorkspace } =
        useWorkspaceStore();

    if (isReady) {
        return children;
    }

    return (
        <div
            aria-busy={syncStatus !== "error"}
            className="fixed inset-0 z-[90] grid min-h-dvh place-items-center bg-[var(--color-surface)] p-6"
            role={syncStatus === "error" ? "alert" : "status"}
        >
            {syncStatus === "error" ? (
                <div className="grid justify-items-center gap-3 text-center">
                    <h1 className="text-xl font-semibold text-[var(--color-ink)]">
                        Ledger could not be loaded
                    </h1>
                    <p className="max-w-md text-sm leading-6 text-[var(--color-muted)]">
                        Workspace data could not be validated. Check your
                        connection, try again, or switch to another ledger.
                    </p>
                    <button
                        type="button"
                        onClick={() => void syncWorkspace()}
                        className="border border-[var(--color-border-strong)] px-3 py-1.5 text-sm font-medium text-[var(--color-ink)] transition hover:bg-[var(--color-panel-muted)]"
                    >
                        Try again
                    </button>
                    <LedgerLoadRecovery
                        activeLedgerId={snapshot.activeLedgerId}
                        onSwitched={syncWorkspace}
                    />
                </div>
            ) : (
                <div className="grid justify-items-center gap-4 text-center">
                    <FontAwesomeIcon
                        aria-hidden="true"
                        icon={faCircleNotch}
                        className="h-10 w-10 animate-spin text-[var(--color-accent-ink)]"
                    />
                    <div className="grid gap-1">
                        <h1 className="text-xl font-semibold text-[var(--color-ink)]">
                            Loading{" "}
                            {snapshot.activeLedgerName
                                ? snapshot.activeLedgerName
                                : "ledger"}
                        </h1>
                        <p className="text-sm text-[var(--color-muted)]">
                            Loading ledger...
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
}

export function useWorkspaceStore() {
    const context = useContext(WorkspaceStoreContext);

    return context ?? fallbackContext;
}
