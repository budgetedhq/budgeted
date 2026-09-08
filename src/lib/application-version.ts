import { GENERATED_APPLICATION_VERSION } from "@/lib/application-version.generated";

export const APPLICATION_VERSION = GENERATED_APPLICATION_VERSION;

export type ApplicationVersion = {
    buildTimestamp: string;
    releaseTag?: string;
};

export function isApplicationVersionTimestamp(
    value: unknown,
): value is string {
    if (typeof value !== "string" || value.length === 0) {
        return false;
    }

    const timestamp = new Date(value);

    return (
        Number.isFinite(timestamp.getTime()) &&
        timestamp.toISOString() === value
    );
}

export function isApplicationReleaseTag(value: unknown): value is string {
    return (
        typeof value === "string" &&
        /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value)
    );
}

function formatApplicationBuildTimestampForDisplay(timestamp: string) {
    return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(new Date(timestamp));
}

export function formatApplicationVersionForDisplay(
    version: string | ApplicationVersion,
) {
    if (typeof version === "string") {
        return formatApplicationBuildTimestampForDisplay(version);
    }

    const buildTimestamp = formatApplicationBuildTimestampForDisplay(
        version.buildTimestamp,
    );

    return isApplicationReleaseTag(version.releaseTag)
        ? `${version.releaseTag} · built ${buildTimestamp}`
        : `built ${buildTimestamp}`;
}
