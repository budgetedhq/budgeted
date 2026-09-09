import { LedgerSetupProvider, SetupPageProgress } from "@/components/onboarding/ledger-setup";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { auth } from "@/auth";
import { MobileNav } from "@/components/dashboard/mobile-nav";
import { SidebarNav } from "@/components/dashboard/sidebar-nav";
import { BackgroundMutationActivityProvider } from "@/components/shared/background-mutation-activity-provider";
import {
    WorkspaceDataGate,
    WorkspaceStoreProvider,
} from "@/components/workspace/workspace-store-provider";
import { requireCurrentUserAccount } from "@/lib/auth/current-user";
import { WORKSPACE_SECTIONS } from "@/lib/navigation/workspace-sections";

export default async function DashboardLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    await connection();

    const session = await auth();

    if (!session?.user) {
        redirect("/sign-in");
    }

    const user = await requireCurrentUserAccount();

    return (
        <BackgroundMutationActivityProvider>
            <WorkspaceStoreProvider
                bootstrap={{
                    cacheOwnerId: user.userId,
                    initialLedgerId: user.activeLedgerId,
                    initialLedgerName: user.activeLedgerName,
                }}
            >
                <div className="min-h-screen">
                    <div className="grid min-h-screen w-full lg:grid-cols-[auto_minmax(0,1fr)]">
                        <MobileNav sections={WORKSPACE_SECTIONS} />
                        <SidebarNav
                            sections={WORKSPACE_SECTIONS}
                            ledgerLabel={user.activeLedgerName}
                        />
                        <section className="min-w-0 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
                            <WorkspaceDataGate><LedgerSetupProvider><SetupPageProgress />{children}</LedgerSetupProvider></WorkspaceDataGate>
                        </section>
                    </div>
                </div>
            </WorkspaceStoreProvider>
        </BackgroundMutationActivityProvider>
    );
}
