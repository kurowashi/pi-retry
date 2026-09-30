/**
 * pi-retry — Retry a provider request when the server says to retry.
 *
 * Pi treats quota and billing errors as terminal, so a transient per-minute
 * rate limit (Google free tier) ends the run even though the server reports
 * when the limit resets. Pi's provider-level retry honors `Retry-After`, but
 * Google reports the delay only in the error body (`google.rpc.RetryInfo`),
 * and the provider fallback backoff caps at 8s, far below a minute.
 *
 * This module wraps a provider stream and retries only when both hold:
 *
 *  1. the provider asked for a retry, by embedding a delay in the error
 *     (`"retryDelay": "55s"` or `Please retry in 55.0s`); and
 *  2. the failed attempt produced no content.
 *
 * Condition 2 keeps the transcript honest: an attempt that already streamed
 * text cannot be discarded and replayed without duplicating output. Rate-limit
 * rejections happen before any content, which is exactly what is retried.
 */

import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Model,
	SimpleStreamOptions,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";

/** A provider stream entry point, matching `ProviderConfig.streamSimple`. */
export type StreamSimple = (
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface RetryPolicy {
	/** Extra attempts after the first one. */
	maxRetries: number;
	/** Milliseconds added to the server-requested delay. */
	marginMs: number;
	/** Upper bound for one wait. */
	maxDelayMs: number;
}

/**
 * Three extra attempts with a 1s margin, capped at 2 minutes.
 * A free-tier per-minute limit resets after one window, so the second attempt
 * normally succeeds; the rest only cover a slower reset.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxRetries: 3, marginMs: 1000, maxDelayMs: 120_000 };

/** `Please retry in 55.02s` (prose) or `"retryDelay": "55s"` (google.rpc.RetryInfo). */
const RETRY_INSTRUCTION = /please retry in\s+(\d+(?:\.\d+)?)\s*s|"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i;

/**
 * The wait the provider asked for, in milliseconds, or `undefined` when the
 * provider did not ask for a retry. The margin covers clock skew; the cap
 * keeps a bogus value from parking the session for hours.
 */
export function serverRetryDelayMs(
	errorMessage: unknown,
	policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): number | undefined {
	const match = RETRY_INSTRUCTION.exec(errorText(errorMessage));
	if (!match) return undefined;
	const seconds = Number.parseFloat(match[1] ?? match[2] ?? "");
	if (!Number.isFinite(seconds)) return undefined;
	return Math.min(Math.round(seconds * 1000) + policy.marginMs, policy.maxDelayMs);
}

/**
 * Wrap `inner` so a pre-content failure with a server-requested delay is
 * retried. Events of a failed attempt are discarded until the attempt produces
 * its first content block; from that point on the attempt is committed and its
 * events (including a later failure) pass through unchanged.
 */
export function withRetry(
	inner: StreamSimple,
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
	policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	void forwardAttempts(inner, model, context, options, policy, out).catch((error: unknown) => {
		// The pump never throws by design; a throw is a bug in this module, and
		// ending the stream beats leaving the caller waiting forever.
		endWithError(out, errorMessageFor(model, error));
	});
	return out;
}

/**
 * Run attempts until one is committed or the retry budget is spent. Each
 * `retry` outcome discards that attempt's events and waits for its delay.
 */
async function forwardAttempts(
	inner: StreamSimple,
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	policy: RetryPolicy,
	out: AssistantMessageEventStream,
): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		const outcome = await forwardAttempt(inner, model, context, options, policy, out);
		if (outcome.type === "finished") return;
		if (attempt >= policy.maxRetries) {
			endWithError(out, outcome.message);
			return;
		}
		try {
			await sleep(outcome.delayMs, options?.signal);
		} catch {
			endWithAborted(out, model);
			return;
		}
	}
}

type AttemptOutcome = { type: "finished" } | { type: "retry"; delayMs: number; message: AssistantMessage };

const FINISHED: AttemptOutcome = { type: "finished" };

/**
 * Run one provider request. Returns `retry` when the attempt failed before any
 * content and the server asked for a retry; otherwise the attempt's events
 * have been forwarded and the outer stream is closed.
 */
async function forwardAttempt(
	inner: StreamSimple,
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	policy: RetryPolicy,
	out: AssistantMessageEventStream,
): Promise<AttemptOutcome> {
	let stream: AssistantMessageEventStream;
	try {
		stream = inner(model, context, options);
	} catch (error) {
		endWithError(out, errorMessageFor(model, error));
		return FINISHED;
	}
	let startEvent: AssistantMessageEvent | undefined;
	let committed = false;
	for await (const event of stream) {
		if (committed) {
			out.push(event);
			continue;
		}
		if (event.type === "start") {
			startEvent = event;
			continue;
		}
		if (event.type === "done" || event.type === "error") {
			return finishAttempt(event, startEvent, policy, out);
		}
		if (startEvent) out.push(startEvent);
		startEvent = undefined;
		committed = true;
		out.push(event);
	}
	const message = await stream.result();
	if (startEvent) out.push(startEvent);
	out.end(message);
	return FINISHED;
}

/**
 * Close the outer stream with one attempt's terminal event, or ask for a retry
 * when the attempt produced no content and the server asked for one.
 */
function finishAttempt(
	terminal: Extract<AssistantMessageEvent, { type: "done" | "error" }>,
	startEvent: AssistantMessageEvent | undefined,
	policy: RetryPolicy,
	out: AssistantMessageEventStream,
): AttemptOutcome {
	const message = terminal.type === "done" ? terminal.message : terminal.error;
	if (terminal.type === "error") {
		const delayMs = serverRetryDelayMs(message.errorMessage, policy);
		if (delayMs !== undefined && message.content.length === 0) {
			return { type: "retry", delayMs, message };
		}
	}
	if (startEvent) out.push(startEvent);
	out.push(terminal);
	out.end(message);
	return FINISHED;
}

function endWithError(out: AssistantMessageEventStream, message: AssistantMessage): void {
	out.push({ type: "error", reason: "error", error: message });
	out.end(message);
}

function endWithAborted(out: AssistantMessageEventStream, model: Model<Api>): void {
	const message = partialMessage(model, { stopReason: "aborted", errorMessage: "Request was aborted" });
	out.push({ type: "error", reason: "aborted", error: message });
	out.end(message);
}

function errorMessageFor(model: Model<Api>, error: unknown): AssistantMessage {
	return partialMessage(model, {
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
	});
}

/** An empty assistant message used when no provider message exists to forward. */
function partialMessage(model: Model<Api>, partial: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
		...partial,
	};
}

function errorText(errorMessage: unknown): string {
	if (typeof errorMessage === "string") return errorMessage;
	if (errorMessage === undefined) return "";
	try {
		return JSON.stringify(errorMessage);
	} catch {
		return String(errorMessage);
	}
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Request was aborted"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Request was aborted"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
