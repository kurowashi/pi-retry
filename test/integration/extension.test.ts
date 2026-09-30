/**
 * Integration: the shipped registration and the wrapper that runs behind it.
 *
 * These tests drive the real `src/index.ts` entry: the default export registers
 * the override against the host's Google API, and `registerRetry` lets a stub
 * stand in for that API so the whole registration + retry path runs without a
 * network.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import googleRetryExtension, { RETRY_TARGET, registerRetry } from "../../src/index.ts";
import type { RetryPolicy } from "../../src/retry.ts";
import { CONTEXT, collect, fail, finalText, MODEL, RETRYABLE_429, script, succeed } from "../helpers/streams.ts";

interface Registration {
	name: string;
	config: ProviderConfig;
}

function recordingApi(): { api: ExtensionAPI; registrations: Registration[] } {
	const registrations: Registration[] = [];
	const api = {
		registerProvider(name: string, config: ProviderConfig) {
			registrations.push({ name, config });
		},
	} as unknown as ExtensionAPI;
	return { api, registrations };
}

test("registers exactly one override for the Google API", () => {
	const { api, registrations } = recordingApi();
	googleRetryExtension(api);
	assert.equal(registrations.length, 1);
	const registration = registrations[0];
	assert.equal(registration?.name, RETRY_TARGET.provider);
	assert.equal(registration?.config.api, RETRY_TARGET.api);
	assert.equal(typeof registration?.config.streamSimple, "function");
});

test("the override delegates to the built-in Google implementation", () => {
	const { api, registrations } = recordingApi();
	googleRetryExtension(api);
	const streamSimple = registrations[0]?.config.streamSimple;
	assert.ok(streamSimple);
	// No API key: the built-in implementation reports it through the stream, and
	// the wrapper must not turn that into a hang or a silent success.
	const events = collect(streamSimple(MODEL, CONTEXT, undefined));
	return events.then((all) => {
		const last = all.at(-1);
		assert.ok(last?.type === "error");
		assert.match(last.error.errorMessage ?? "", /No API key/);
	});
});

test("the registered stream retries a pre-content rate limit", async () => {
	const { api, registrations } = recordingApi();
	const provider = script(fail(RETRYABLE_429), succeed("ok"));
	const policy: RetryPolicy = { maxRetries: 3, marginMs: 5, maxDelayMs: 20 };
	registerRetry(api, { streamSimple: provider.inner }, policy);
	const streamSimple = registrations[0]?.config.streamSimple;
	assert.ok(streamSimple);
	const events = await collect(streamSimple(MODEL, CONTEXT, undefined));
	assert.equal(provider.calls(), 2);
	assert.equal(finalText(events), "ok");
});
