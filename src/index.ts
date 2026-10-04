/**
 * pi-retry — Retry the Google provider after the delay the server asked for.
 *
 * Pi classifies any error containing "quota exceeded" or "billing" as terminal,
 * so a free-tier per-minute limit ends the run even though the response tells
 * us when the limit resets. This extension replaces the `google` provider's
 * stream with a wrapper that waits for the server-requested delay and retries.
 * Every model call of the session goes through the composed provider, so agent
 * turns and compaction share the same behavior, and a discarded attempt never
 * reaches the session transcript.
 *
 * The retry count comes from `~/.pi/agent/retry.json`, overridden by a trusted
 * project's `.pi/retry.json`; the wait times stay fixed. See README.md for the
 * behavior and docs/adr/ for the decisions.
 */

import { googleGenerativeAIApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadRetryConfig } from "./config.ts";
import { DEFAULT_RETRY_POLICY, type RetryPolicy, type StreamSimple, withRetry } from "./retry.ts";

/** The provider this extension wraps, and the built-in API implementation behind it. */
export const RETRY_TARGET = { provider: "google", api: "google-generative-ai" } as const;

/** The policy for the next request; config reloads on every session start. */
export type RetryPolicySource = () => RetryPolicy;

/**
 * Register the retrying stream for {@link RETRY_TARGET}. `streams` is the
 * built-in implementation for the target API; tests inject a stub here.
 */
export function registerRetry(
	pi: ExtensionAPI,
	streams: { streamSimple: StreamSimple },
	policySource: RetryPolicySource,
): void {
	pi.registerProvider(RETRY_TARGET.provider, {
		api: RETRY_TARGET.api,
		streamSimple: (model, context, options) => withRetry(streams.streamSimple, model, context, options, policySource()),
	});
}

/**
 * Register the provider override and the `session_start` handler that loads the
 * config (global, then a trusted project) into the policy used per request.
 */
export function registerRetryExtension(pi: ExtensionAPI, streams: { streamSimple: StreamSimple }): void {
	let policy: RetryPolicy = DEFAULT_RETRY_POLICY;
	pi.on("session_start", (_event, ctx) => {
		const loaded = loadRetryConfig(ctx.cwd, ctx.isProjectTrusted());
		policy = { ...DEFAULT_RETRY_POLICY, maxRetries: loaded.config.maxRetries };
		if (ctx.hasUI) {
			for (const warning of loaded.warnings) ctx.ui.notify(`pi-retry: ${warning}`, "warning");
		}
	});
	registerRetry(pi, streams, () => policy);
}

export default function googleRetryExtension(pi: ExtensionAPI): void {
	if (typeof googleGenerativeAIApi !== "function") {
		throw new Error("pi-retry requires @earendil-works/pi-ai with googleGenerativeAIApi()");
	}
	registerRetryExtension(pi, googleGenerativeAIApi());
}
