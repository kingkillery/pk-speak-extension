import test from "node:test";
import assert from "node:assert/strict";
import { OmpSelectionStore } from "../dist/omp-selection.js";

test("selections are isolated per client (review C1)", () => {
	const store = new OmpSelectionStore();
	store.select("clientA", "/omp/foo.jsonl");
	store.select("clientB", "/omp/bar.jsonl");

	assert.equal(store.get("clientA"), "/omp/foo.jsonl");
	assert.equal(store.get("clientB"), "/omp/bar.jsonl");
	// A client with no selection is unaffected by other clients.
	assert.equal(store.get("clientC"), null);
});

test("one client's selection never leaks into another's lookup", () => {
	const store = new OmpSelectionStore();
	store.select("phone", "/omp/phone-session.jsonl");
	// A different client (different key) must NOT see the phone's selection.
	assert.equal(store.get("laptop"), null);
	assert.equal(store.get(undefined), null);
});

test("empty/null sessionPath deselects, returning the client to normal routing (review C2)", () => {
	const store = new OmpSelectionStore();
	store.select("c", "/omp/x.jsonl");
	assert.equal(store.get("c"), "/omp/x.jsonl");

	store.select("c", null);
	assert.equal(store.get("c"), null, "null clears");

	store.select("c", "/omp/y.jsonl");
	store.select("c", "   ");
	assert.equal(store.get("c"), null, "whitespace-only clears");

	store.select("c", "/omp/z.jsonl");
	store.select("c", "");
	assert.equal(store.get("c"), null, "empty string clears");
});

test("isActive reports whether any client holds a path (review M3 sweep exclusion)", () => {
	const store = new OmpSelectionStore();
	assert.equal(store.isActive("/omp/foo.jsonl"), false);
	assert.equal(store.isActive(undefined), false);

	store.select("a", "/omp/foo.jsonl");
	store.select("b", "/omp/bar.jsonl");
	assert.equal(store.isActive("/omp/foo.jsonl"), true);
	assert.equal(store.isActive("/omp/bar.jsonl"), true);
	assert.equal(store.isActive("/omp/other.jsonl"), false);

	// After deselect it is no longer active and the sweep may archive it.
	store.select("a", null);
	assert.equal(store.isActive("/omp/foo.jsonl"), false);
});

test("undefined clientKey collapses to a single stable default bucket", () => {
	const store = new OmpSelectionStore();
	store.select(undefined, "/omp/local.jsonl");
	assert.equal(store.get(undefined), "/omp/local.jsonl");
	// The default bucket is distinct from a named client.
	assert.equal(store.get("named"), null);
});
