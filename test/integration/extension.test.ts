/**
 * Integration: the shipped registration, the config wiring, and the wrapper
 * that runs behind it.
 *
 * These tests drive the real `src/index.ts` entry. `registerRetryExtension`
 * accepts a stub provider, so the whole config → session_start → stream path
 * runs without a network, and the default export proves the wiring for the
 * host's Google API.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import googleRetryExtension, { RETRY_TARGET, registerRetry, registerRetryExtension } from "../../src/index.ts";
import type { RetryPolicy } from "../../src/retry.ts";
import { CONTEXT, collect, fail, finalText, MODEL, RETRYABLE_429, script, succeed } from "../helpers/streams.ts";

interface Registration {
	name: string;
	config: ProviderConfig;
}

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface Harness {
	api: ExtensionAPI;
	registrations: Registration[];
	handlers: Map<string, Handler[]>;
	notifications: string[];
}

function recordingApi(): Harness {
	const registrations: Registration[] = [];
	const handlers = new Map<string, Handler[]>();
	const notifications: string[] = [];
	const api = {
		registerProvider(name: string, config: ProviderConfig) {
			registrations.push({ name, config });
		},
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
	} as unknown as ExtensionAPI;
	return { api, registrations, handlers, notifications };
}

function sessionContext(harness: Harness, cwd: string, trusted: boolean): ExtensionContext {
	return {
		cwd,
		hasUI: true,
		isProjectTrusted: () => trusted,
		ui: {
			notify(message: string) {
				harness.notifications.push(message);
			},
		},
	} as unknown as ExtensionContext;
}

function startSession(harness: Harness, ctx: ExtensionContext): void {
	for (const handler of harness.handlers.get("session_start") ?? []) {
		handler({ type: "session_start", reason: "startup" }, ctx);
	}
}

function streamSimpleOf(harness: Harness): NonNullable<ProviderConfig["streamSimple"]> {
	const streamSimple = harness.registrations[0]?.config.streamSimple;
	assert.ok(streamSimple, "the extension must register a streamSimple");
	return streamSimple;
}

/** Runs `fn` with `$PI_CODING_AGENT_DIR` pointing at a fresh agent dir and a fresh cwd. */
async function sandbox<T>(fn: (box: { cwd: string; home: string }) => Promise<T>): Promise<T> {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-retry-home-"));
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-retry-cwd-"));
	const saved = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = home;
	try {
		return await fn({ cwd, home });
	} finally {
		if (saved === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = saved;
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

function writeConfig(file: string, content: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(content));
}

test("registers exactly one override for the Google API", () => {
	const harness = recordingApi();
	googleRetryExtension(harness.api);
	assert.equal(harness.registrations.length, 1);
	const registration = harness.registrations[0];
	assert.equal(registration?.name, RETRY_TARGET.provider);
	assert.equal(registration?.config.api, RETRY_TARGET.api);
	assert.equal(typeof registration?.config.streamSimple, "function");
});

test("the override delegates to the built-in Google implementation", async () => {
	const harness = recordingApi();
	googleRetryExtension(harness.api);
	const streamSimple = streamSimpleOf(harness);
	// No API key: the built-in implementation reports it through the stream, and
	// the wrapper must not turn that into a hang or a silent success.
	const events = await collect(streamSimple(MODEL, CONTEXT, undefined));
	const last = events.at(-1);
	assert.ok(last?.type === "error");
	assert.match(last.error.errorMessage ?? "", /No API key/);
});

test("the registered stream retries a pre-content rate limit", async () => {
	const harness = recordingApi();
	const provider = script(fail(RETRYABLE_429), succeed("ok"));
	const policy: RetryPolicy = { maxRetries: 3, marginMs: 5, maxDelayMs: 20 };
	registerRetry(harness.api, { streamSimple: provider.inner }, () => policy);
	const events = await collect(streamSimpleOf(harness)(MODEL, CONTEXT, undefined));
	assert.equal(provider.calls(), 2);
	assert.equal(finalText(events), "ok");
});

test("session_start applies the global maxRetries", async () => {
	await sandbox(async ({ cwd, home }) => {
		writeConfig(path.join(home, "retry.json"), { maxRetries: 0 });
		const harness = recordingApi();
		const provider = script(fail(RETRYABLE_429));
		registerRetryExtension(harness.api, { streamSimple: provider.inner });
		startSession(harness, sessionContext(harness, cwd, true));
		await collect(streamSimpleOf(harness)(MODEL, CONTEXT, undefined));
		assert.equal(provider.calls(), 1, "maxRetries=0 must not retry");
	});
});

test("a trusted project file overrides the global config", async () => {
	await sandbox(async ({ cwd }) => {
		writeConfig(path.join(cwd, ".pi", "retry.json"), { maxRetries: 0 });
		const harness = recordingApi();
		const provider = script(fail(RETRYABLE_429));
		registerRetryExtension(harness.api, { streamSimple: provider.inner });
		startSession(harness, sessionContext(harness, cwd, true));
		await collect(streamSimpleOf(harness)(MODEL, CONTEXT, undefined));
		assert.equal(provider.calls(), 1, "the project value must apply");
	});
});

test("an untrusted project file is ignored", async () => {
	await sandbox(async ({ cwd, home }) => {
		writeConfig(path.join(home, "retry.json"), { maxRetries: 0 });
		writeConfig(path.join(cwd, ".pi", "retry.json"), { maxRetries: 1 });
		const harness = recordingApi();
		const provider = script(fail(RETRYABLE_429));
		registerRetryExtension(harness.api, { streamSimple: provider.inner });
		startSession(harness, sessionContext(harness, cwd, false));
		await collect(streamSimpleOf(harness)(MODEL, CONTEXT, undefined));
		assert.equal(provider.calls(), 1, "the project value must not apply");
	});
});

test("config is re-read on every session start", async () => {
	await sandbox(async ({ cwd, home }) => {
		const file = path.join(home, "retry.json");
		writeConfig(file, { maxRetries: 0 });
		const harness = recordingApi();
		const provider = script(fail(RETRYABLE_429));
		registerRetryExtension(harness.api, { streamSimple: provider.inner });
		const ctx = sessionContext(harness, cwd, true);
		startSession(harness, ctx);
		await collect(streamSimpleOf(harness)(MODEL, CONTEXT, undefined));
		assert.equal(provider.calls(), 1);
		writeConfig(file, { maxRetries: 1 });
		startSession(harness, ctx);
		await collect(streamSimpleOf(harness)(MODEL, CONTEXT, undefined));
		assert.equal(provider.calls(), 3, "the reloaded value adds one retry");
	});
});

test("invalid config values warn in the UI instead of stopping the session", async () => {
	await sandbox(async ({ cwd, home }) => {
		writeConfig(path.join(home, "retry.json"), { maxRetries: "many" });
		const harness = recordingApi();
		registerRetryExtension(harness.api, { streamSimple: script(fail(RETRYABLE_429)).inner });
		startSession(harness, sessionContext(harness, cwd, true));
		assert.equal(harness.notifications.length, 1);
		assert.match(harness.notifications[0] ?? "", /pi-retry: .*maxRetries/);
	});
});
