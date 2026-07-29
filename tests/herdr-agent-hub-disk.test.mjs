import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDiskFallbackBinding } from "../dist/herdr-agent-hub-disk.js";

// Binding-level tests for readTranscriptRange byte-boundary behavior. These drive the
// disk binding directly with a fabricated dashboard so explicit fromByte offsets can be
// exercised — the gateway only ever asks for tail windows.

function makeBindingFor(filePath) {
	const dashboardFn = () => ({
		sessions: [{
			name: "probe-lane",
			cwd: "C:\\dev\\repo",
			isCurrent: false,
			sessionPath: filePath,
			subagents: [],
			kind: "background",
			source: "oh-my-pk",
		}],
		scannedRoots: [],
		source: "oh-my-pk",
		generatedAt: Date.now(),
	});
	return createDiskFallbackBinding(dashboardFn);
}

async function withTempFile(content, fn) {
	const dir = mkdtempSync(path.join(tmpdir(), "hub-disk-"));
	const filePath = path.join(dir, "session.jsonl");
	writeFileSync(filePath, content);
	try {
		await fn(makeBindingFor(filePath), filePath);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("range read starting exactly at a line boundary keeps the complete first line", async () => {
	await withTempFile("line0\nline1\nline2\n", async (binding) => {
		// Byte 6 is the start of "line1"; the byte before it is "\n".
		const chunk = await binding.readTranscriptRange("probe-lane", { fromByte: 6 });
		assert.equal(chunk.fromByte, 6, "no partial line exists to skip at an exact boundary");
		assert.equal(chunk.text, "line1\nline2\n", "the first line is complete and must be kept");
	});
});

test("range read starting mid-line drops only the partial leading record", async () => {
	await withTempFile("line0\nline1\nline2\n", async (binding) => {
		const chunk = await binding.readTranscriptRange("probe-lane", { fromByte: 3 });
		assert.equal(chunk.fromByte, 6);
		assert.equal(chunk.text, "line1\nline2\n");
	});
});

test("range read starting inside a CRLF line ending still detects the boundary", async () => {
	await withTempFile("line0\r\nline1\r\n", async (binding) => {
		// "line0\r\n" is 7 bytes; byte 7 starts "line1" and the byte before is "\n".
		const chunk = await binding.readTranscriptRange("probe-lane", { fromByte: 7 });
		assert.equal(chunk.text, "line1\r\n");
		assert.equal(chunk.fromByte, 7);
	});
});

test("fromByte stays byte-accurate when the skipped prefix holds multibyte and split chars", async () => {
	// "ab" + 😀 (4 bytes) + "cd\n" + "rest\n": starting at byte 3 splits the emoji.
	const content = "ab😀cd\nrest\n";
	const byteLen = Buffer.byteLength("ab😀cd\n", "utf8"); // 2 + 4 + 3 = 9
	await withTempFile(content, async (binding) => {
		const chunk = await binding.readTranscriptRange("probe-lane", { fromByte: 3 });
		assert.equal(chunk.fromByte, byteLen, "offset must be the true file byte position of the first retained line");
		assert.equal(chunk.text, "rest\n");
	});
});

test("a trailing partial record is excluded from the returned text", async () => {
	await withTempFile("{\"type\":\"session\",\"id\":\"s\"}\n{\"type\":\"message\"", async (binding) => {
		const chunk = await binding.readTranscriptRange("probe-lane", {});
		assert.equal(chunk.text, "{\"type\":\"session\",\"id\":\"s\"}\n");
		// newSize reports the real file size so callers can see bytes were left behind.
		assert.equal(chunk.newSize, Buffer.byteLength("{\"type\":\"session\",\"id\":\"s\"}\n{\"type\":\"message\"", "utf8"));
	});
});

test("a window fully inside one oversized record returns empty text truthfully", async () => {
	const huge = `{"type":"message","pad":"${"h".repeat(64 * 1024)}"}\n`;
	await withTempFile(huge, async (binding) => {
		const chunk = await binding.readTranscriptRange("probe-lane", { maxBytes: 4096 });
		assert.equal(chunk.text, "", "no complete line exists inside the window");
		assert.equal(chunk.newSize, Buffer.byteLength(huge, "utf8"));
	});
});

test("missing agent and deleted file return null, not an empty chunk", async () => {
	await withTempFile("x\n", async (binding, filePath) => {
		assert.equal(await binding.readTranscriptRange("no-such-lane", {}), null);
		rmSync(filePath);
		assert.equal(await binding.readTranscriptRange("probe-lane", {}), null);
	});
});
