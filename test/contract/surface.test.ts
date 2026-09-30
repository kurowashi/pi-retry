/**
 * Contract: the extension loads through Pi's own loader and registers exactly
 * one thing — a stream override for the built-in Google provider.
 *
 * The extension is loaded through Pi's jiti loader, the same path Pi uses at
 * runtime, so these assertions cover the shipped artifact rather than a
 * re-import of the modules under test. The loader also scans project and global
 * extension directories, so both are redirected to an empty sandbox.
 *
 * Registering no tools, commands, or event handlers is the point: the override
 * costs no context and no model-facing surface.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverAndLoadExtensions, type Extension, type LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { PACKAGE_ROOT } from "../helpers/root.ts";

async function loadRetryExtension(): Promise<LoadExtensionsResult> {
	const sandbox = mkdtempSync(join(tmpdir(), "pi-retry-surface-"));
	const result = await discoverAndLoadExtensions([join(PACKAGE_ROOT, "src", "index.ts")], sandbox, sandbox);
	assert.deepEqual(result.errors, [], "the extension must load without errors");
	assert.equal(result.extensions.length, 1, "the sandbox must load only this extension");
	return result;
}

function onlyExtension(result: LoadExtensionsResult): Extension {
	const extension = result.extensions[0];
	assert.ok(extension, "the loader must return the extension");
	return extension;
}

test("no tools, commands, or event handlers are registered", async () => {
	const extension = onlyExtension(await loadRetryExtension());
	assert.deepEqual([...extension.tools.keys()], []);
	assert.deepEqual([...extension.commands.keys()], []);
	assert.deepEqual([...extension.handlers.keys()], []);
});

test("registers exactly one provider override: google / google-generative-ai", async () => {
	const result = await loadRetryExtension();
	const pending = result.runtime.pendingProviderRegistrations;
	assert.equal(pending.length, 1);
	const registration = pending[0];
	assert.equal(registration?.name, "google");
	assert.equal(registration?.config.api, "google-generative-ai");
	assert.equal(typeof registration?.config.streamSimple, "function");
});
