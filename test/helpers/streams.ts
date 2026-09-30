/**
 * Scripted provider streams and fixtures shared by the unit and integration tests.
 *
 * Every stream is a plain `StreamSimple` stub, so a test states the exact
 * provider behavior it wants and nothing reaches the network.
 */

import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Model,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, normalizeContext } from "@earendil-works/pi-ai/compat";
import type { StreamSimple } from "../../src/retry.ts";

export const MODEL: Model<Api> = {
	id: "gemma-4-31b-it",
	name: "Gemma 4 31B",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 262_144,
	maxTokens: 32_768,
};

export const CONTEXT: TranscriptContext = normalizeContext({ messages: [] });

/** The user's error shape: 429 with the retry delay embedded in the body. */
export const RETRYABLE_429 = `429: {"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 16000, model: gemma-4-31b Please retry in 0s.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"0s"}]}}`;

/** A quota error without a retry instruction: terminal, as before. */
export const TERMINAL_429 =
	'429: {"error":{"code":429,"message":"You exceeded your current quota, * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count","status":"RESOURCE_EXHAUSTED"}}';

const USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function assistant(partial: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: USAGE,
		stopReason: "pending",
		timestamp: 0,
		...partial,
	};
}

/** A request rejected before any content was produced. */
export function fail(errorMessage: string): StreamSimple {
	return () => {
		const stream = createAssistantMessageEventStream();
		const failed = assistant({ stopReason: "error", errorMessage });
		stream.push({ type: "error", reason: "error", error: failed });
		stream.end(failed);
		return stream;
	};
}

/** A request that streamed text and then failed mid-stream. */
export function failAfterContent(errorMessage: string): StreamSimple {
	return () => {
		const stream = createAssistantMessageEventStream();
		const content = [{ type: "text" as const, text: "partial" }];
		stream.push({ type: "start", partial: assistant({}) });
		stream.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial: assistant({ content }) });
		const failed = assistant({ content, stopReason: "error", errorMessage });
		stream.push({ type: "error", reason: "error", error: failed });
		stream.end(failed);
		return stream;
	};
}

export function succeed(text: string): StreamSimple {
	return () => {
		const stream = createAssistantMessageEventStream();
		const content = [{ type: "text" as const, text }];
		stream.push({ type: "start", partial: assistant({}) });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: assistant({ content }) });
		const final = assistant({ content, stopReason: "stop" });
		stream.push({ type: "done", reason: "stop", message: final });
		stream.end(final);
		return stream;
	};
}

/** A broken provider that ends without a terminal event. */
export function endSilently(): StreamSimple {
	return () => {
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "start", partial: assistant({}) });
		stream.end(assistant({}));
		return stream;
	};
}

/** A provider implementation that throws before returning a stream. */
export function throwOnCall(error: Error): StreamSimple {
	return () => {
		throw error;
	};
}

/** Steps through the given streams, repeating the last one forever. */
export function script(...steps: StreamSimple[]): { inner: StreamSimple; calls: () => number } {
	let calls = 0;
	const inner: StreamSimple = (model, context, options) => {
		const step = steps[Math.min(calls, steps.length - 1)];
		calls += 1;
		if (step === undefined) throw new Error("the script has no steps");
		return step(model, context, options);
	};
	return { inner, calls: () => calls };
}

export async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

export function finalText(events: AssistantMessageEvent[]): string {
	const last = events.at(-1);
	if (last?.type !== "done") return "";
	const block = last.message.content[0];
	return block?.type === "text" ? block.text : "";
}
