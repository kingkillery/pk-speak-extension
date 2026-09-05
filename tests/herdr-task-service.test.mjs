import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
	HubTaskConflictError,
	HubTaskRevisionError,
	HubTaskService,
	HubTaskValidationError,
	JsonHubTaskRepository,
} = await import("../dist/herdr-task-service.js");

function createFixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-speak-herdr-tasks-"));
	const storePath = join(root, "herdr", "hub-tasks.json");
	const repository = new JsonHubTaskRepository(storePath);
	const service = new HubTaskService(repository, [{ id: "repo", executorRoot: root }]);
	return {
		root,
		storePath,
		service,
		close() {
			service.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function validTask(expectedRevision = 0) {
	return {
		title: "Implement durable task state",
		prompt: "Add the Hub task service and focused tests.",
		workspaceId: "repo",
		workingDirectory: ".",
		expectedRevision,
	};
}

test("persists stable service and executor identities across restart", () => {
	const fixture = createFixture();
	try {
		const before = fixture.service.getServiceInfo();
		const created = fixture.service.createTask(validTask(), "create-1");
		assert.equal(created.created, true);
		assert.equal(created.task.state, "ready");
		fixture.service.close();

		const reopened = new HubTaskService(
			new JsonHubTaskRepository(fixture.storePath),
			[{ id: "ignored-on-reopen", executorRoot: fixture.root }],
		);
		try {
			const after = reopened.getServiceInfo();
			assert.equal(after.serviceId, before.serviceId);
			assert.equal(after.executorId, before.executorId);
			assert.equal(after.revision, 1);
			assert.equal(reopened.getTask(created.task.id).prompt, created.task.prompt);
		} finally {
			reopened.close();
		}
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("replays an idempotent create without creating a duplicate task", () => {
	const fixture = createFixture();
	try {
		const first = fixture.service.createTask(validTask(), "same-command");
		const replay = fixture.service.createTask(validTask(), "same-command");
		assert.equal(replay.created, false);
		assert.equal(replay.task.id, first.task.id);
		assert.equal(replay.commandId, first.commandId);
		assert.equal(fixture.service.getSnapshot().tasks.length, 1);
		assert.equal(fixture.service.getServiceInfo().revision, 1);
	} finally {
		fixture.close();
	}
});

test("rejects idempotency-key reuse with different arguments", () => {
	const fixture = createFixture();
	try {
		fixture.service.createTask(validTask(), "same-command");
		assert.throws(
			() => fixture.service.createTask({ ...validTask(), title: "Different title" }, "same-command"),
			HubTaskConflictError,
		);
		assert.equal(fixture.service.getSnapshot().tasks.length, 1);
	} finally {
		fixture.close();
	}
});

test("enforces optimistic store revisions", () => {
	const fixture = createFixture();
	try {
		fixture.service.createTask(validTask(), "create-1");
		assert.throws(
			() => fixture.service.createTask(validTask(0), "create-2"),
			HubTaskRevisionError,
		);
		assert.equal(fixture.service.getSnapshot().tasks.length, 1);
	} finally {
		fixture.close();
	}
});

test("creates dependency-blocked tasks and rejects non-portable working directories", () => {
	const fixture = createFixture();
	try {
		const dependency = fixture.service.createTask(validTask(), "create-dependency").task;
		const blocked = fixture.service.createTask({
			...validTask(1),
			title: "Review implementation",
			dependsOn: [dependency.id],
			reviewMode: "required",
			reviewQuestion: "Does the implementation preserve the Hub contracts?",
		}, "create-review").task;
		assert.equal(blocked.state, "blocked");
		assert.deepEqual(blocked.dependsOn, [dependency.id]);
		assert.throws(
			() => fixture.service.createTask({ ...validTask(2), workingDirectory: "../outside" }, "bad-path"),
			HubTaskValidationError,
		);
		assert.throws(
		() => fixture.service.createTask({ ...validTask(2), workingDirectory: "C:\\outside" }, "bad-absolute-path"),
			HubTaskValidationError,
		);
		assert.throws(
			() => fixture.service.createTask({ ...validTask(2), workingDirectory: "D:outside" }, "bad-drive-relative-path"),
			HubTaskValidationError,
		);
	} finally {
		fixture.close();
	}
});

test("rejects malformed untrusted task bodies before persistence", () => {
	const fixture = createFixture();
	try {
		assert.throws(
			() => fixture.service.createTask({ ...validTask(), expectedRevision: undefined }, "missing-revision"),
			HubTaskValidationError,
		);
		assert.throws(
			() => fixture.service.createTask({ ...validTask(), dependsOn: "not-an-array" }, "bad-dependencies"),
			HubTaskValidationError,
		);
		assert.throws(
			() => fixture.service.createTask({ ...validTask(), reviewMode: "sometimes" }, "bad-review-mode"),
			HubTaskValidationError,
		);
		assert.equal(fixture.service.getSnapshot().tasks.length, 0);
	} finally {
		fixture.close();
	}
});

test("prevents two repositories from owning the same task store", () => {
	const fixture = createFixture();
	try {
		assert.throws(() => new JsonHubTaskRepository(fixture.storePath), HubTaskConflictError);
	} finally {
		fixture.close();
	}
});

test("reclaims a repository lock whose owner process exited", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-speak-herdr-stale-lock-"));
	const storePath = join(root, "herdr", "hub-tasks.json");
	mkdirSync(join(root, "herdr"), { recursive: true });
	const exited = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
	assert.equal(exited.status, 0);
	assert.ok(exited.pid);
	writeFileSync(`${storePath}.lock`, `${exited.pid}\n`, "utf8");

	const repository = new JsonHubTaskRepository(storePath);
	try {
		const service = new HubTaskService(repository, [{ id: "repo", executorRoot: root }]);
		assert.equal(service.getSnapshot().tasks.length, 0);
	} finally {
		repository.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("serializes concurrent stale-lock takeover to one repository owner", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-speak-herdr-lock-race-"));
	const storePath = join(root, "hub-tasks.json");
	const resultsPath = join(root, "results");
	const gatePath = join(root, "start");
	const releasePath = join(root, "release");
	mkdirSync(resultsPath);
	const exited = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
	assert.equal(exited.status, 0);
	writeFileSync(`${storePath}.lock`, `${exited.pid}\n`, "utf8");

	const moduleUrl = new URL("../dist/herdr-task-service.js", import.meta.url).href;
	const workerScript = `
		const fs = require("node:fs");
		const path = require("node:path");
		const [moduleUrl, storePath, resultsPath, gatePath, releasePath] = process.argv.slice(1);
		while (!fs.existsSync(gatePath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
		import(moduleUrl).then(({ JsonHubTaskRepository }) => {
			try {
				const repository = new JsonHubTaskRepository(storePath);
				fs.writeFileSync(path.join(resultsPath, process.pid + ".ok"), "");
				const timer = setInterval(() => {
					if (!fs.existsSync(releasePath)) return;
					clearInterval(timer);
					repository.close();
				}, 5);
			} catch {
				fs.writeFileSync(path.join(resultsPath, process.pid + ".fail"), "");
			}
		});
	`;
	const children = Array.from({ length: 16 }, () => spawn(
		process.execPath,
		["-e", workerScript, moduleUrl, storePath, resultsPath, gatePath, releasePath],
		{ stdio: "ignore" },
	));
	try {
		writeFileSync(gatePath, "", "utf8");
		const deadline = Date.now() + 10_000;
		while (readdirSync(resultsPath).length < children.length && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		const results = readdirSync(resultsPath);
		assert.equal(results.length, children.length);
		assert.equal(results.filter((entry) => entry.endsWith(".ok")).length, 1);
	} finally {
		writeFileSync(releasePath, "", "utf8");
		await Promise.all(children.map((child) => new Promise((resolve) => {
			if (child.exitCode !== null) resolve();
			else child.once("exit", resolve);
		})));
		rmSync(root, { recursive: true, force: true });
	}
});
