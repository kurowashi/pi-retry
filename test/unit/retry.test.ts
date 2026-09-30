/**
 * Unit: the retry decision, the delay math, and the event-stream contract.
 *
 * The provider is a scripted stub, so these tests pin exactly when a request
 * is retried, how long the wait is, and what the caller sees in every case.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { DEFAULT_RETRY_POLICY, type RetryPolicy, serverRetryDelayMs, withRetry } from "../../src/retry.ts";
import {
	CONTEXT,
	collect,
	endSilently,
	fail,
	failAfterContent,
	failAfterStart,
	finalText,
	firstText,
	MODEL,
	RETRYABLE_429,
	script,
	succeed,
	TERMINAL_429,
	throwOnCall,
} from "../helpers/streams.ts";

/** Delay accounting without the default margin, for exact numbers. */
const NO_MARGIN: RetryPolicy = { maxRetries: 0, marginMs: 0, maxDelayMs: Number.MAX_SAFE_INTEGER };

/** Small waits keep the wrapper tests fast. */
const FAST: RetryPolicy = { maxRetries: 3, marginMs: 5, maxDelayMs: 100 };

test("the default policy pins the documented budget", () => {
	assert.deepEqual(DEFAULT_RETRY_POLICY, { maxRetries: 3, marginMs: 1000, maxDelayMs: 120_000 });
});

test("reads the server delay from RetryInfo JSON", () => {
	assert.equal(serverRetryDelayMs('429: {"details":[{"retryDelay":"55s"}]}', NO_MARGIN), 55_000);
});

test("reads the server delay from prose", () => {
	assert.equal(serverRetryDelayMs("429 RESOURCE_EXHAUSTED: Please retry in 3.5s.", NO_MARGIN), 3_500);
});

test("reads a structured error object", () => {
	assert.equal(serverRetryDelayMs({ error: { details: [{ retryDelay: "2s" }] } }, NO_MARGIN), 2_000);
});

test("returns undefined when no retry was requested", () => {
	assert.equal(serverRetryDelayMs(TERMINAL_429), undefined);
	assert.equal(serverRetryDelayMs(undefined), undefined);
});

test("applies the margin and caps the wait", () => {
	assert.equal(serverRetryDelayMs('"retryDelay":"3s"', { maxRetries: 0, marginMs: 1000, maxDelayMs: 60_000 }), 4_000);
	assert.equal(serverRetryDelayMs('"retryDelay":"600s"', { maxRetries: 0, marginMs: 0, maxDelayMs: 120_000 }), 120_000);
});

test("ignores an error object it cannot serialize", () => {
	const cyclic: Record<string, unknown> = {};
	cyclic["self"] = cyclic;
	assert.equal(serverRetryDelayMs(cyclic), undefined);
});

test("retries a pre-content failure after the server delay", async () => {
	const provider = script(fail(RETRYABLE_429), succeed("ok"));
	const startedAt = Date.now();
	const events = await collect(withRetry(provider.inner, MODEL, CONTEXT, undefined, FAST));
	assert.equal(provider.calls(), 2);
	assert.ok(Date.now() - startedAt < 500, "the policy delay, not the default 1s, must be used");
	assert.deepEqual(
		events.map((event) => event.type),
		["start", "text_delta", "done"],
	);
	assert.equal(finalText(events), "ok");
});

test("does not forward a discarded attempt's start event", async () => {
	const provider = script(failAfterStart(RETRYABLE_429), succeed("ok"));
	const events = await collect(withRetry(provider.inner, MODEL, CONTEXT, undefined, FAST));
	assert.equal(provider.calls(), 2);
	assert.deepEqual(
		events.map((event) => event.type),
		["start", "text_delta", "done"],
	);
	assert.equal(finalText(events), "ok");
});

test("returns the failure when no retry was requested", async () => {
	const provider = script(fail(TERMINAL_429));
	const events = await collect(withRetry(provider.inner, MODEL, CONTEXT, undefined, FAST));
	assert.equal(provider.calls(), 1);
	assert.deepEqual(
		events.map((event) => event.type),
		["error"],
	);
	const last = events.at(-1);
	assert.ok(last?.type === "error");
	assert.equal(last.error.errorMessage, TERMINAL_429);
});

test("does not retry a failure after content was streamed", async () => {
	const provider = script(failAfterContent(RETRYABLE_429));
	const events = await collect(withRetry(provider.inner, MODEL, CONTEXT, undefined, FAST));
	assert.equal(provider.calls(), 1);
	assert.deepEqual(
		events.map((event) => event.type),
		["start", "text_delta", "error"],
	);
});

test("surfaces the last provider error after the retry budget is exhausted", async () => {
	const provider = script(fail(RETRYABLE_429));
	const budget: RetryPolicy = { maxRetries: 2, marginMs: 1, maxDelayMs: 10 };
	const startedAt = Date.now();
	const events: AssistantMessageEvent[] = await collect(withRetry(provider.inner, MODEL, CONTEXT, undefined, budget));
	assert.equal(provider.calls(), 3);
	assert.ok(Date.now() - startedAt < 500, "the policy delay, not the default 1s, must be used");
	assert.deepEqual(
		events.map((event) => event.type),
		["error"],
	);
	const last = events.at(-1);
	assert.ok(last?.type === "error");
	assert.equal(last.error.errorMessage, RETRYABLE_429);
});

test("aborting during the wait ends the stream as aborted", async () => {
	const controller = new AbortController();
	const provider = script(fail(RETRYABLE_429));
	const policy: RetryPolicy = { maxRetries: 3, marginMs: 5_000, maxDelayMs: 6_000 };
	const stream = withRetry(provider.inner, MODEL, CONTEXT, { signal: controller.signal }, policy);
	setTimeout(() => controller.abort(), 20);
	const events = await collect(stream);
	assert.equal(provider.calls(), 1);
	const last = events.at(-1);
	assert.ok(last?.type === "error");
	assert.equal(last.reason, "aborted");
	assert.equal(last.error.stopReason, "aborted");
});

test("does not wait when the request is already aborted", async () => {
	const controller = new AbortController();
	controller.abort();
	const provider = script(fail(RETRYABLE_429));
	const events = await collect(withRetry(provider.inner, MODEL, CONTEXT, { signal: controller.signal }, FAST));
	assert.equal(provider.calls(), 1);
	const last = events.at(-1);
	assert.ok(last?.type === "error");
	assert.equal(last.reason, "aborted");
});

test("ends with the accumulated message when the provider ends without a terminal event", async () => {
	const provider = script(endSilently());
	const stream = withRetry(provider.inner, MODEL, CONTEXT, undefined, FAST);
	const events = await collect(stream);
	assert.equal(provider.calls(), 1);
	assert.deepEqual(
		events.map((event) => event.type),
		["start"],
	);
	assert.equal(firstText(await stream.result()), "silent");
});

test("turns a synchronous provider throw into an error event", async () => {
	const provider = script(throwOnCall(new Error("No API key for provider: google")));
	const events = await collect(withRetry(provider.inner, MODEL, CONTEXT, undefined, FAST));
	assert.equal(provider.calls(), 1);
	assert.deepEqual(
		events.map((event) => event.type),
		["error"],
	);
	const last = events.at(-1);
	assert.ok(last?.type === "error");
	assert.equal(last.error.errorMessage, "No API key for provider: google");
});
