import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
    compareReleaseVersions,
    createCommandEnvironment,
    findFileContaining,
    getUnexpectedReleaseChanges,
    parseReleaseVersion,
    updatePackageVersionSource,
    validateReleaseTree,
} from "../../../scripts/release";

const REQUIRED_RELEASE_FILES = [
    "pnpm-lock.yaml",
    "sst.config.ts",
    "infra/config.ts",
    "config/budgeted-config.example.toml",
    "config/budgeted-advanced-config.example.toml",
    "scripts/seed-user.ts",
    "src/lib/auth/password.ts",
    "src/lib/auth/user-account.ts",
];

describe("release script", () => {
    it("normalizes stable semantic versions and rejects ambiguous tags", () => {
        expect(parseReleaseVersion("0.1.2")).toEqual({
            tag: "v0.1.2",
            version: "0.1.2",
        });
        expect(parseReleaseVersion("v1.20.3")).toEqual({
            tag: "v1.20.3",
            version: "1.20.3",
        });
        expect(() => parseReleaseVersion("v0.1.2-beta.1")).toThrow(
            /stable semantic version/,
        );
        expect(() => parseReleaseVersion("v0.01.2")).toThrow(
            /stable semantic version/,
        );
    });

    it("orders release versions numerically", () => {
        expect(compareReleaseVersions("0.10.0", "0.2.0")).toBeGreaterThan(0);
        expect(compareReleaseVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
        expect(compareReleaseVersions("v0.1.2", "0.1.2")).toBe(0);
    });

    it("disables pagers for every release subprocess", () => {
        expect(
            createCommandEnvironment({
                GH_PAGER: "less",
                GIT_PAGER: "more",
                PAGER: "less",
            }),
        ).toMatchObject({
            GH_PAGER: "cat",
            GIT_PAGER: "cat",
            PAGER: "cat",
        });
    });

    it("updates only the root package version", () => {
        const source = [
            "{",
            '  "name": "budgeted",',
            '  "version": "0.1.0",',
            '  "dependencies": { "example": "9.9.9" }',
            "}",
            "",
        ].join("\n");

        const result = updatePackageVersionSource(source, "0.1.2");

        expect(result.currentVersion).toBe("0.1.0");
        expect(result.source).toContain('"version": "0.1.2"');
        expect(result.source).toContain('"example": "9.9.9"');
    });

    it("validates the exact source package contract used by Launcher", async () => {
        const directory = await mkdtemp(join(tmpdir(), "budgeted-release-"));

        try {
            for (const path of REQUIRED_RELEASE_FILES) {
                await mkdir(join(directory, path, ".."), { recursive: true });
                await writeFile(join(directory, path), "fixture");
            }
            await writeFile(
                join(directory, "package.json"),
                JSON.stringify({
                    name: "budgeted",
                    version: "0.1.2",
                    packageManager: "pnpm@11.25.0",
                }),
            );

            expect(() => validateReleaseTree(directory, "0.1.2")).not.toThrow();
            expect(() => validateReleaseTree(directory, "0.1.3")).toThrow(
                /budgeted@0.1.3/,
            );
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });

    it("allows only the two generated release changes", () => {
        expect(
            getUnexpectedReleaseChanges(
                [
                    " M package.json",
                    " M src/lib/application-version.generated.ts",
                ].join("\n"),
            ),
        ).toEqual([]);
        expect(
            getUnexpectedReleaseChanges(
                [" M package.json", " M src/app/page.tsx"].join("\n"),
            ),
        ).toEqual([" M src/app/page.tsx"]);
    });

    it("ignores local build cache but detects a secret in deployable output", async () => {
        const directory = await mkdtemp(join(tmpdir(), "budgeted-build-output-"));
        const secret = "ephemeral-build-secret";

        try {
            const cacheDirectory = join(directory, "cache");
            await mkdir(cacheDirectory);
            const cachedPath = join(cacheDirectory, "input.sst");
            await writeFile(cachedPath, secret);
            expect(findFileContaining(directory, secret)).toBe(cachedPath);
            expect(
                findFileContaining(directory, secret, [cacheDirectory]),
            ).toBeUndefined();

            await mkdir(join(directory, "server"));
            await writeFile(join(directory, "server", "safe.js"), "safe output");

            const leakedPath = join(directory, "server", "leaked.js");
            await writeFile(leakedPath, `const value = ${JSON.stringify(secret)};`);
            expect(
                findFileContaining(directory, secret, [cacheDirectory]),
            ).toBe(leakedPath);
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });
});
