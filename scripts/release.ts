import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const GITHUB_REPOSITORY = "deweller/budgeted";
const RELEASE_BRANCH = "main";
const RELEASE_FILES = [
    "package.json",
    "pnpm-lock.yaml",
    "sst.config.ts",
    "infra/config.ts",
    "config/budgeted-config.example.toml",
    "config/budgeted-advanced-config.example.toml",
    "scripts/seed-user.ts",
    "src/lib/auth/password.ts",
    "src/lib/auth/user-account.ts",
] as const;
const EXPECTED_VERSION_CHANGES = [
    " M package.json",
    " M src/lib/application-version.generated.ts",
] as const;
const MAX_RELEASE_ARCHIVE_BYTES = 250 * 1024 * 1024;

type ReleaseVersion = {
    tag: string;
    version: string;
};

type PackageIdentity = {
    name?: string;
    packageManager?: string;
    version?: string;
};

export function parseReleaseVersion(value: string): ReleaseVersion {
    const match = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(
        value,
    );

    if (!match) {
        throw new Error(
            `Invalid release version ${JSON.stringify(value)}. Expected a stable semantic version such as 0.1.2.`,
        );
    }

    return { tag: `v${match[1]}`, version: match[1] };
}

export function compareReleaseVersions(left: string, right: string): number {
    const leftParts = parseReleaseVersion(left).version.split(".").map(Number);
    const rightParts = parseReleaseVersion(right).version
        .split(".")
        .map(Number);

    for (let index = 0; index < 3; index += 1) {
        if (leftParts[index] !== rightParts[index]) {
            return leftParts[index] - rightParts[index];
        }
    }

    return 0;
}

export function updatePackageVersionSource(
    source: string,
    nextVersion: string,
): { currentVersion: string; source: string } {
    const packageJson = JSON.parse(source) as PackageIdentity;
    if (packageJson.name !== "budgeted" || !packageJson.version) {
        throw new Error('The root package must be named "budgeted" and have a version.');
    }

    const currentVersion = parseReleaseVersion(packageJson.version).version;
    const versionLine = /^(\s*"version"\s*:\s*")[^"]+("\s*,?\s*)$/m;
    if (!versionLine.test(source)) {
        throw new Error("Could not update the root package version safely.");
    }

    const updatedSource = source.replace(versionLine, `$1${nextVersion}$2`);
    const updatedPackageJson = JSON.parse(updatedSource) as PackageIdentity;
    if (updatedPackageJson.version !== nextVersion) {
        throw new Error("The root package version update did not complete.");
    }

    return { currentVersion, source: updatedSource };
}

export function validateReleaseTree(root: string, expectedVersion: string): void {
    for (const path of RELEASE_FILES) {
        if (!existsSync(resolve(root, path))) {
            throw new Error(`The release package is missing ${path}.`);
        }
    }

    const packageJson = JSON.parse(
        readFileSync(resolve(root, "package.json"), "utf8"),
    ) as PackageIdentity;
    if (packageJson.name !== "budgeted" || packageJson.version !== expectedVersion) {
        throw new Error(
            `Release package identity must be budgeted@${expectedVersion}; found ${packageJson.name ?? "<missing>"}@${packageJson.version ?? "<missing>"}.`,
        );
    }
    if (!packageJson.packageManager?.match(/^pnpm@11(?:\.|$)/)) {
        throw new Error(
            "The release package must use a Launcher-supported pnpm 11 version.",
        );
    }
}

export function getUnexpectedReleaseChanges(status: string): string[] {
    const expected = new Set<string>(EXPECTED_VERSION_CHANGES);
    return status
        .split("\n")
        .filter(Boolean)
        .filter((line) => !expected.has(line));
}

export function findFileContaining(
    directory: string,
    value: string,
    excludedDirectories: readonly string[] = [],
): string | undefined {
    const expected = Buffer.from(value);
    const excluded = new Set(excludedDirectories.map((path) => resolve(path)));

    return findFileContainingValue(resolve(directory), expected, excluded);
}

function findFileContainingValue(
    directory: string,
    value: Buffer,
    excludedDirectories: ReadonlySet<string>,
): string | undefined {
    if (excludedDirectories.has(directory)) {
        return undefined;
    }

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            const nestedMatch = findFileContainingValue(
                path,
                value,
                excludedDirectories,
            );
            if (nestedMatch) {
                return nestedMatch;
            }
        } else if (entry.isFile() && readFileSync(path).includes(value)) {
            return path;
        }
    }

    return undefined;
}

function output(command: string, args: string[]): string {
    return execFileSync(command, args, {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
}

function binaryOutput(command: string, args: string[]): Buffer {
    return execFileSync(command, args, {
        cwd: process.cwd(),
        encoding: "buffer",
        maxBuffer: MAX_RELEASE_ARCHIVE_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
    });
}

function run(
    command: string,
    args: string[],
    options?: { env?: NodeJS.ProcessEnv },
): void {
    console.log(`\n> ${command} ${args.join(" ")}`);
    execFileSync(command, args, {
        cwd: process.cwd(),
        env: options?.env,
        stdio: "inherit",
    });
}

function commandSucceeds(command: string, args: string[]): boolean {
    return (
        spawnSync(command, args, {
            cwd: process.cwd(),
            stdio: "ignore",
        }).status === 0
    );
}

function assertCleanMain(): void {
    const branch = output("git", ["branch", "--show-current"]);
    if (branch !== RELEASE_BRANCH) {
        throw new Error(
            `Releases must be created from ${RELEASE_BRANCH}; currently on ${branch || "detached HEAD"}.`,
        );
    }

    const status = output("git", ["status", "--porcelain", "--untracked-files=all"]);
    if (status) {
        throw new Error("Commit or remove working-tree changes before releasing.");
    }
}

function assertSynchronizedMain(): void {
    const localCommit = output("git", ["rev-parse", "HEAD"]);
    const remoteCommit = output("git", ["rev-parse", `origin/${RELEASE_BRANCH}`]);
    if (localCommit !== remoteCommit) {
        throw new Error(
            `Local ${RELEASE_BRANCH} must exactly match origin/${RELEASE_BRANCH} before releasing.`,
        );
    }
}

function getLatestReleaseVersion(): string | undefined {
    const versions = output("git", ["tag", "--list"])
        .split("\n")
        .filter(Boolean)
        .flatMap((tag) => {
            try {
                return [parseReleaseVersion(tag).version];
            } catch {
                return [];
            }
        })
        .sort((left, right) => compareReleaseVersions(right, left));

    return versions[0];
}

function assertVersionCanBeReleased(
    release: ReleaseVersion,
    currentPackageVersion: string,
): void {
    if (compareReleaseVersions(release.version, currentPackageVersion) <= 0) {
        throw new Error(
            `${release.version} must be greater than the current package version ${currentPackageVersion}.`,
        );
    }

    const latestReleaseVersion = getLatestReleaseVersion();
    if (
        latestReleaseVersion &&
        compareReleaseVersions(release.version, latestReleaseVersion) <= 0
    ) {
        throw new Error(
            `${release.version} must be greater than the latest tag ${latestReleaseVersion}.`,
        );
    }

    if (
        commandSucceeds("git", [
            "show-ref",
            "--verify",
            "--quiet",
            `refs/tags/${release.tag}`,
        ])
    ) {
        throw new Error(`Tag ${release.tag} already exists.`);
    }
}

function runReleaseChecks(): void {
    const checks: Array<[string, string[]]> = [
        ["pnpm", ["install", "--frozen-lockfile"]],
        ["pnpm", ["test"]],
        ["pnpm", ["typecheck"]],
        ["pnpm", ["lint"]],
    ];

    for (const [command, args] of checks) {
        run(command, args);
    }

    runReleaseBuild();
}

function runReleaseBuild(): void {
    const buildAuthSecret = randomBytes(48).toString("base64url");
    run("pnpm", ["build"], {
        env: {
            ...process.env,
            SST_RESOURCE_AuthSecret: JSON.stringify({
                type: "sst.sst.Secret",
                value: buildAuthSecret,
            }),
        },
    });

    const buildDirectory = resolve(process.cwd(), ".next");
    if (!existsSync(buildDirectory)) {
        throw new Error("The production build did not create .next.");
    }
    // Turbopack records build inputs in its local cache. The cache is ignored by
    // Git and is not deployed; all other Next.js output remains in scope.
    const leakedSecretPath = findFileContaining(buildDirectory, buildAuthSecret, [
        join(buildDirectory, "cache"),
    ]);
    if (leakedSecretPath) {
        throw new Error(
            `The ephemeral build AuthSecret was written to ${leakedSecretPath}.`,
        );
    }
}

function updateVersionFiles(release: ReleaseVersion): void {
    const packagePath = resolve(process.cwd(), "package.json");
    const packageSource = readFileSync(packagePath, "utf8");
    const updated = updatePackageVersionSource(packageSource, release.version);
    writeFileSync(packagePath, updated.source, "utf8");
    run(process.execPath, ["scripts/write-application-version.mjs"]);
}

function assertOnlyVersionFilesChanged(): void {
    const status = output("git", ["status", "--porcelain", "--untracked-files=all"]);
    const unexpectedChanges = getUnexpectedReleaseChanges(status);
    if (unexpectedChanges.length > 0) {
        throw new Error(
            `Release preparation changed unexpected files:\n${unexpectedChanges.join("\n")}`,
        );
    }

    for (const expected of EXPECTED_VERSION_CHANGES) {
        if (!status.split("\n").includes(expected)) {
            throw new Error(`Release preparation did not update ${expected.slice(3)}.`);
        }
    }
}

function createReleaseCommit(release: ReleaseVersion): string {
    run("git", [
        "add",
        "--",
        "package.json",
        "src/lib/application-version.generated.ts",
    ]);
    run("git", ["diff", "--cached", "--check"]);
    run("git", ["commit", "-m", `chore: release ${release.tag}`]);

    const committedPackage = JSON.parse(
        output("git", ["show", "HEAD:package.json"]),
    ) as PackageIdentity;
    if (
        committedPackage.name !== "budgeted" ||
        committedPackage.version !== release.version
    ) {
        throw new Error("The release commit has the wrong package identity.");
    }

    run("git", ["tag", "--annotate", release.tag, "--message", release.tag]);
    return output("git", ["rev-parse", "HEAD"]);
}

function publishRelease(release: ReleaseVersion): void {
    run("git", [
        "push",
        "--atomic",
        "origin",
        RELEASE_BRANCH,
        `refs/tags/${release.tag}`,
    ]);
    run("gh", [
        "release",
        "create",
        release.tag,
        "--repo",
        GITHUB_REPOSITORY,
        "--verify-tag",
        "--title",
        release.tag,
        "--generate-notes",
    ]);
}

function verifyPublishedRelease(release: ReleaseVersion, commitSha: string): void {
    const releaseJson = JSON.parse(
        output("gh", [
            "api",
            `repos/${GITHUB_REPOSITORY}/releases/tags/${release.tag}`,
        ]),
    ) as {
        draft?: boolean;
        html_url?: string;
        prerelease?: boolean;
        tag_name?: string;
    };
    if (
        releaseJson.tag_name !== release.tag ||
        releaseJson.draft ||
        releaseJson.prerelease
    ) {
        throw new Error("GitHub did not publish the expected stable release.");
    }

    const publishedCommit = output("gh", [
        "api",
        `repos/${GITHUB_REPOSITORY}/commits/${release.tag}`,
        "--jq",
        ".sha",
    ]);
    if (publishedCommit !== commitSha) {
        throw new Error("The published release tag points to the wrong commit.");
    }

    const verificationDirectory = mkdtempSync(
        join(tmpdir(), "budgeted-published-release-"),
    );
    const archivePath = join(verificationDirectory, `${release.tag}.tgz`);
    const extractedPath = join(verificationDirectory, "extracted");
    try {
        const archive = binaryOutput("gh", [
            "api",
            `repos/${GITHUB_REPOSITORY}/tarball/${release.tag}`,
        ]);
        if (archive.byteLength >= MAX_RELEASE_ARCHIVE_BYTES) {
            throw new Error("The published release archive is too large for Launcher.");
        }
        writeFileSync(archivePath, archive, { mode: 0o600 });
        mkdirSync(extractedPath, { mode: 0o700 });
        run("tar", [
            "-xzf",
            archivePath,
            "-C",
            extractedPath,
            "--strip-components=1",
        ]);
        validateReleaseTree(extractedPath, release.version);
    } finally {
        rmSync(verificationDirectory, { force: true, recursive: true });
    }

    console.log(`\nPublished and verified ${releaseJson.html_url ?? release.tag}.`);
}

function printUsage(): void {
    console.log(`Usage: pnpm run release <version>

Creates a stable GitHub release from a clean, synchronized main branch.
Example: pnpm run release 0.1.2`);
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.includes("--help") || args.includes("-h")) {
        printUsage();
        return;
    }
    if (args.length !== 1) {
        printUsage();
        throw new Error("Provide exactly one release version.");
    }

    const release = parseReleaseVersion(args[0]);
    const packagePath = resolve(process.cwd(), "package.json");
    const packageSource = readFileSync(packagePath, "utf8");
    const { currentVersion } = updatePackageVersionSource(
        packageSource,
        release.version,
    );

    output("git", ["--version"]);
    output("gh", ["--version"]);
    output("pnpm", ["--version"]);
    assertCleanMain();
    run("gh", ["auth", "status", "--hostname", "github.com"]);
    run("git", ["fetch", "--tags", "origin", RELEASE_BRANCH]);
    assertSynchronizedMain();
    assertVersionCanBeReleased(release, currentVersion);

    console.log(
        `\nPreparing ${release.tag} from ${GITHUB_REPOSITORY}/${RELEASE_BRANCH}.`,
    );
    runReleaseChecks();
    updateVersionFiles(release);
    validateReleaseTree(process.cwd(), release.version);
    assertOnlyVersionFilesChanged();

    const commitSha = createReleaseCommit(release);
    publishRelease(release);
    verifyPublishedRelease(release, commitSha);
}

const entrypoint = process.argv[1]
    ? pathToFileURL(resolve(process.argv[1])).href
    : undefined;
if (entrypoint === import.meta.url) {
    main().catch((error) => {
        console.error(
            `\nRelease failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
    });
}
