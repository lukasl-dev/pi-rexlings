import assert from "node:assert/strict";
import test from "node:test";
import {
  parseResult,
  parseRun,
  type ChildResult,
  type Run,
} from "../src/artifacts.ts";

test("result tags are literal values, not values that stringify to a tag", () => {
  const result: ChildResult = {
    version: 1,
    id: "run-id",
    outcome: "completed",
    text: "The actual answer",
    session: null,
  };
  for (const outcome of ["completed", "failed", "cancelled", "help"]) {
    const value = { ...result, outcome, extra: "retained" };
    assert.deepEqual(parseResult(value, result.id), value);
  }
  for (const outcome of [["completed"], null, 0, {}, "unknown"]) {
    assert.throws(
      () => parseResult({ ...result, outcome }, result.id),
      /Invalid result artifact/,
    );
  }
  assert.throws(
    () => parseResult(result, "another-run"),
    /Invalid result artifact/,
  );
});

test("run manifests validate their tags, Rex IDs and nested results", () => {
  const parent = "session:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const run: Run = {
    version: 1,
    id: "run-id",
    owner: "owner-id",
    name: "moss-fox",
    taskName: "inspect API",
    cwd: "/project",
    model: "fixture/test",
    thinking: "off",
    created: 0,
    instance: "fixture",
    rexSession: "session:11111111-2222-3333-4444-555555555555",
    window: "window:11111111-2222-3333-4444-555555555555",
    terminal: null,
    cancelled: false,
    delivered: false,
    phase: "starting",
    status: null,
    problem: null,
    result: null,
  };
  const parse = (value: unknown) => parseRun(value, run.owner, run.id, parent);
  assert.deepEqual(parse({ ...run, extra: "retained" }), {
    ...run,
    extra: "retained",
  });
  for (const phase of ["starting", "running", "interrupted", "uncertain"]) {
    assert.equal(parse({ ...run, phase }).phase, phase);
  }
  const { rexSession, ...legacy } = run;
  assert.equal(parse(legacy).rexSession, parent);
  assert.equal(parse(run).rexSession, rexSession);
  const result = {
    version: 1,
    id: run.id,
    outcome: "completed",
    text: "Done",
    session: null,
  };
  assert.deepEqual(parse({ ...run, phase: "finished", result }).result, result);
  const previous = parse({ ...run, phase: "finalizing", result });
  assert.equal(previous.phase, "running");
  assert.equal(previous.result, null);
  for (const thinking of [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]) {
    assert.equal(parse({ ...run, thinking }).thinking, thinking);
  }
  for (const change of [
    { phase: ["finished"] },
    { phase: "finished" },
    { phase: "unknown" },
    { thinking: ["off"] },
    { owner: "another-owner" },
    { id: "another-run" },
    { terminal: "block:abbreviated" },
    { window: 1 },
    { rexSession: "other-name" },
    {
      result: {
        version: 1,
        id: run.id,
        outcome: ["completed"],
        text: "bad tag",
        session: null,
      },
    },
  ]) {
    assert.throws(() => parse({ ...run, ...change }));
  }
});
