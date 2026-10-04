/**
 * Config discovery for pi-retry.
 *
 * Files are merged nearest-last: the global `~/.pi/agent/retry.json`
 * (or `$PI_CODING_AGENT_DIR/retry.json`) is read first, then the project
 * `<cwd>/.pi/retry.json` overrides it. The project file is ignored when the
 * project is not trusted.
 *
 * Only `maxRetries` is configurable; the wait times stay fixed in retry.ts.
 * A missing file, broken JSON, or invalid value falls back to the default with
 * a warning, so a broken config never stops a session.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_RETRY_POLICY } from "./retry.ts";

export const CONFIG_FILE_NAME = "retry.json";

/** Upper bound for maxRetries; a larger value falls back to the default. */
export const MAX_MAX_RETRIES = 10;

export interface RetryConfig {
	/** Extra attempts after the first one. */
	maxRetries: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = { maxRetries: DEFAULT_RETRY_POLICY.maxRetries };

export interface LoadedRetryConfig {
	config: RetryConfig;
	warnings: string[];
	globalFile: string;
	projectFile: string;
}

export function agentDir(): string {
	const override = process.env["PI_CODING_AGENT_DIR"]?.trim();
	return override && override.length > 0 ? override : path.join(os.homedir(), ".pi", "agent");
}

export function globalConfigPath(): string {
	return path.join(agentDir(), CONFIG_FILE_NAME);
}

export function projectConfigPath(cwd: string): string {
	return path.join(cwd, ".pi", CONFIG_FILE_NAME);
}

/** Load the effective config. `projectTrusted` gates the project file. */
export function loadRetryConfig(cwd: string, projectTrusted: boolean): LoadedRetryConfig {
	const warnings: string[] = [];
	const globalFile = globalConfigPath();
	const projectFile = projectConfigPath(cwd);
	let config = { ...DEFAULT_RETRY_CONFIG };
	config = mergeFile(config, globalFile, warnings);
	if (projectTrusted) config = mergeFile(config, projectFile, warnings);
	return { config, warnings, globalFile, projectFile };
}

function mergeFile(config: RetryConfig, file: string, warnings: string[]): RetryConfig {
	const source = readObject(file, warnings);
	if (source === undefined) return config;
	return { maxRetries: resolveMaxRetries(source["maxRetries"], file, warnings) ?? config.maxRetries };
}

function readObject(file: string, warnings: string[]): Record<string, unknown> | undefined {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		// A missing file is the normal case.
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			warnings.push(`${file}: expected a JSON object; ignored`);
			return undefined;
		}
		return parsed as Record<string, unknown>;
	} catch (error) {
		warnings.push(`${file}: ${error instanceof Error ? error.message : String(error)}; ignored`);
		return undefined;
	}
}

function resolveMaxRetries(value: unknown, file: string, warnings: string[]): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_MAX_RETRIES) {
		warnings.push(
			`${file}: maxRetries must be an integer between 0 and ${MAX_MAX_RETRIES}; using ${DEFAULT_RETRY_CONFIG.maxRetries}`,
		);
		return DEFAULT_RETRY_CONFIG.maxRetries;
	}
	return value;
}
