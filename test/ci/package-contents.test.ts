/**
 * Contract: `npm pack` ships exactly what the manifest promises, no more.
 *
 * The tarball is what a user's machine actually loads, so this reads the
 * `files` whitelist and the `pi.extensions` entries from package.json instead
 * of restating them here. A whitelist edit that is wrong now fails in CI.
 *
 * `--ignore-scripts` keeps the check side-effect free. The package ships no
 * lifecycle scripts: git installs run `npm install --omit=dev`, where hook
 * installation would fail because devDependencies are absent.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PACKAGE_ROOT } from "../helpers/root.ts";

interface Manifest {
	files?: string[];
	pi?: { extensions?: string[] };
	scripts?: Record<string, string>;
}

/** npm adds these on its own; everything else must be covered by the whitelist. */
const ALWAYS_SHIPPED = new Set(["package.json", "README.md", "LICENSE"]);

const MANIFEST = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as Manifest;

test("the packed tarball matches the manifest whitelist", () => {
	const whitelist = MANIFEST.files ?? [];
	assert.ok(whitelist.length > 0, "package.json must declare a files whitelist");

	const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		cwd: PACKAGE_ROOT,
		encoding: "utf8",
	});
	const [report] = JSON.parse(output) as Array<{ files?: Array<{ path?: string }> }>;
	const shipped = (report?.files ?? []).map((file) => file.path).filter((path): path is string => Boolean(path));

	const outsideWhitelist = shipped.filter(
		(path) =>
			!ALWAYS_SHIPPED.has(path) &&
			!whitelist.some((entry) => path === entry || path.startsWith(`${entry.replace(/\/$/, "")}/`)),
	);
	assert.deepEqual(outsideWhitelist, [], "only whitelisted files and package metadata may be published");

	for (const entry of MANIFEST.pi?.extensions ?? []) {
		const normalized = entry.replace(/^\.\//, "");
		assert.ok(shipped.includes(normalized), `pi.extensions entry ${entry} must be present in the tarball`);
	}
});

test("ships TypeScript directly: no build step, the entry is the source file", () => {
	for (const name of ["build", "prepack", "prepare", "prepublishOnly"]) {
		assert.equal(MANIFEST.scripts?.[name], undefined, `a ${name} script would break TS-direct distribution`);
	}
	assert.deepEqual(MANIFEST.pi?.extensions, ["./src/index.ts"]);
});
