/**
 * Unit: config discovery, precedence, trust, and validation.
 *
 * Every case builds its own agent dir and project dir, so the tests never read
 * the developer's real config. Invalid input must fall back to the default
 * with a warning instead of throwing.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	DEFAULT_RETRY_CONFIG,
	globalConfigPath,
	loadRetryConfig,
	MAX_MAX_RETRIES,
	projectConfigPath,
} from "../../src/config.ts";

interface Sandbox {
	cwd: string;
	home: string;
}

/** Runs `fn` with `$PI_CODING_AGENT_DIR` pointing at a fresh agent dir and a fresh cwd. */
function sandbox<T>(fn: (box: Sandbox) => T): T {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-retry-home-"));
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-retry-cwd-"));
	const saved = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = home;
	try {
		return fn({ cwd, home });
	} finally {
		if (saved === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = saved;
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

function write(file: string, content: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
}

test("the default config pins the documented retry count", () => {
	assert.deepEqual(DEFAULT_RETRY_CONFIG, { maxRetries: 3 });
});

test("missing files yield the default and report both paths", () => {
	sandbox((box) => {
		const loaded = loadRetryConfig(box.cwd, true);
		assert.deepEqual(loaded.config, DEFAULT_RETRY_CONFIG);
		assert.deepEqual(loaded.warnings, []);
		assert.equal(loaded.globalFile, globalConfigPath());
		assert.equal(loaded.projectFile, projectConfigPath(box.cwd));
		assert.ok(loaded.globalFile.startsWith(box.home), "the agent dir override must be honored");
	});
});

test("the global file sets maxRetries", () => {
	sandbox((box) => {
		write(path.join(box.home, "retry.json"), { maxRetries: MAX_MAX_RETRIES });
		const loaded = loadRetryConfig(box.cwd, true);
		assert.equal(loaded.config.maxRetries, MAX_MAX_RETRIES);
		assert.deepEqual(loaded.warnings, []);
	});
});

test("a trusted project file overrides the global value", () => {
	sandbox((box) => {
		write(path.join(box.home, "retry.json"), { maxRetries: 5 });
		write(path.join(box.cwd, ".pi", "retry.json"), { maxRetries: 1 });
		assert.equal(loadRetryConfig(box.cwd, true).config.maxRetries, 1);
	});
});

test("an untrusted project file is ignored", () => {
	sandbox((box) => {
		write(path.join(box.home, "retry.json"), { maxRetries: 5 });
		write(path.join(box.cwd, ".pi", "retry.json"), { maxRetries: 1 });
		assert.equal(loadRetryConfig(box.cwd, false).config.maxRetries, 5);
	});
});

test("a valid project value replaces an invalid global value", () => {
	sandbox((box) => {
		write(path.join(box.home, "retry.json"), { maxRetries: "many" });
		write(path.join(box.cwd, ".pi", "retry.json"), { maxRetries: 2 });
		const loaded = loadRetryConfig(box.cwd, true);
		assert.equal(loaded.config.maxRetries, 2);
		assert.equal(loaded.warnings.length, 1, "the invalid global value still warns");
	});
});

test("unknown keys are ignored without a warning", () => {
	sandbox((box) => {
		write(path.join(box.home, "retry.json"), { maxRetries: 2, marginMs: 5, enabled: false });
		const loaded = loadRetryConfig(box.cwd, true);
		assert.equal(loaded.config.maxRetries, 2);
		assert.deepEqual(loaded.warnings, []);
	});
});

test("invalid maxRetries values warn and fall back to the default", () => {
	const invalid: unknown[] = [-1, 1.5, MAX_MAX_RETRIES + 1, "3", true, null];
	for (const value of invalid) {
		sandbox((box) => {
			write(path.join(box.home, "retry.json"), { maxRetries: value });
			const loaded = loadRetryConfig(box.cwd, true);
			assert.equal(loaded.config.maxRetries, DEFAULT_RETRY_CONFIG.maxRetries, `value: ${JSON.stringify(value)}`);
			assert.equal(loaded.warnings.length, 1, `value: ${JSON.stringify(value)}`);
			assert.match(loaded.warnings[0] ?? "", /maxRetries must be an integer/, `value: ${JSON.stringify(value)}`);
		});
	}
});

test("unreadable config paths warn and keep the default", () => {
	sandbox((box) => {
		fs.mkdirSync(path.join(box.home, "retry.json"), { recursive: true });
		const loaded = loadRetryConfig(box.cwd, true);
		assert.deepEqual(loaded.config, DEFAULT_RETRY_CONFIG);
		assert.equal(loaded.warnings.length, 1);
		assert.match(loaded.warnings[0] ?? "", /retry\.json: .*ignored/);
	});
});

test("a broken project file is ignored and the global value stays", () => {
	sandbox((box) => {
		write(path.join(box.home, "retry.json"), { maxRetries: 5 });
		write(path.join(box.cwd, ".pi", "retry.json"), "{ nope");
		const loaded = loadRetryConfig(box.cwd, true);
		assert.equal(loaded.config.maxRetries, 5);
		assert.equal(loaded.warnings.length, 1);
	});
});

test("an invalid project value falls back to the default, not the global value", () => {
	sandbox((box) => {
		write(path.join(box.home, "retry.json"), { maxRetries: 5 });
		write(path.join(box.cwd, ".pi", "retry.json"), { maxRetries: "many" });
		const loaded = loadRetryConfig(box.cwd, true);
		assert.equal(loaded.config.maxRetries, DEFAULT_RETRY_CONFIG.maxRetries);
		assert.equal(loaded.warnings.length, 1);
	});
});

test("broken JSON warns and keeps the default", () => {
	sandbox((box) => {
		write(path.join(box.home, "retry.json"), "{ nope");
		const loaded = loadRetryConfig(box.cwd, true);
		assert.deepEqual(loaded.config, DEFAULT_RETRY_CONFIG);
		assert.equal(loaded.warnings.length, 1);
		assert.match(loaded.warnings[0] ?? "", /retry\.json: .*ignored/);
	});
});

test("a non-object JSON document warns and keeps the default", () => {
	sandbox((box) => {
		write(path.join(box.home, "retry.json"), [1, 2, 3]);
		const loaded = loadRetryConfig(box.cwd, true);
		assert.deepEqual(loaded.config, DEFAULT_RETRY_CONFIG);
		assert.match(loaded.warnings[0] ?? "", /expected a JSON object/);
	});
});
