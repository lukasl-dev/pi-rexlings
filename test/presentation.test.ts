import assert from "node:assert/strict";
import test from "node:test";
import {
  initTheme,
  type AgentToolResult,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import {
  agentListText,
  agentReport,
  agentTool,
  agentWidget,
} from "../src/presentation.ts";
import type { Run } from "../src/artifacts.ts";

initTheme("dark", false);

function run(overrides: Partial<Run> = {}): Run {
  return {
    version: 1,
    id: "run-id",
    owner: "owner",
    name: "moss-fox",
    taskName: "Review login",
    cwd: "/project",
    model: "fixture/test",
    thinking: "off",
    created: 0,
    instance: "fixture",
    rexSession: "session:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    window: "w1",
    terminal: "t1",
    cancelled: false,
    delivered: false,
    phase: "running",
    status: "working",
    problem: null,
    result: null,
    ...overrides,
  };
}

function plain(component: Component, width = 100): string {
  return component
    .render(width)
    .map((line) => stripTerminalSequences(line).trimEnd())
    .join("\n");
}

function context(
  overrides: Partial<
    Parameters<NonNullable<ToolRenderers["renderCall"]>>[2]
  > = {},
): Parameters<NonNullable<ToolRenderers["renderCall"]>>[2] {
  return {
    args: {},
    toolCallId: "call",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: "/project",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    durationMs: undefined,
    outputPad: 1,
    ...overrides,
  };
}

function report(details: unknown, expanded = false): Component {
  const component = agentReport(
    {
      role: "custom",
      customType: "subagent_result",
      content: "Original model-facing content",
      display: true,
      timestamp: 0,
      details,
    },
    { expanded, outputPad: 1 },
    theme,
  );
  assert.ok(component);
  return component;
}

test("agent widget aligns identity, state and task without claiming idle or interrupted agents finished", () => {
  const widget = agentWidget(
    [
      run(),
      run({ name: "calm-wren", taskName: "Run checks", status: "idle" }),
      run({ name: "fog-tern", phase: "interrupted", status: "working" }),
      run({ name: "done-owl", phase: "finished" }),
    ],
    undefined,
    theme,
  );
  const lines = plain(widget).split("\n");
  assert.equal(lines[0], "Agents · 3 active");
  assert.match(lines[1]!, /moss-fox\s+Working\s+Review login/);
  assert.match(lines[2]!, /calm-wren\s+Idle\s+Run checks/);
  assert.match(lines[3]!, /fog-tern\s+Interrupted/);
  assert.equal(
    lines[1]!.indexOf("Review login"),
    lines[2]!.indexOf("Run checks"),
  );
  assert.doesNotMatch(lines.join("\n"), /done-owl|Completed/);
});

test("folded agent widget surfaces late problems and stays bounded", () => {
  const runs = Array.from({ length: 12 }, (_, i) =>
    run({ name: `agent-${i}` }),
  );
  runs[11] = run({
    name: "needs-check",
    phase: "uncertain",
    problem: "Cannot reconcile terminal",
  });
  const text = plain(agentWidget(runs, "Rex disconnected", theme));
  assert.match(text, /12 active · 1 warning\n  Rex disconnected/);
  assert.match(text.split("\n")[2]!, /needs-check\s+Check/);
  assert.match(text, /Cannot reconcile terminal/);
  assert.match(text, /\+8 more/);
  assert.ok(text.split("\n").length <= 9);
  const placementRuns = Array.from({ length: 5 }, (_, i) =>
    run({
      name: `agent-${i}`,
      problem: i === 4 ? "Rex tab creation failed" : null,
    }),
  );
  const placement = plain(agentWidget(placementRuns, undefined, theme));
  assert.match(placement.split("\n")[1]!, /agent-4/);
  assert.match(placement, /Rex tab creation failed/);
  assert.match(
    agentListText(placementRuns),
    /agent-4[\s\S]*Rex tab creation failed/,
  );
});

test("widgets fit narrow columns, preserve status and do not emit supplied terminal controls", () => {
  const widget = agentWidget(
    [
      run({
        name: "a-very-long-agent-identity-here",
        taskName:
          "日本語 e\u0301 👩‍💻\nsecond line\x1b[31mred\x1b[0m\x1b]2;injected\x07",
        status: "blocked",
      }),
    ],
    "\x1b[2Jproblem",
    theme,
  );
  for (const width of [1, 2, 8, 20, 32, 40, 60, 80, 120]) {
    for (const line of widget.render(width))
      assert.ok(
        visibleWidth(line) <= width,
        `width=${width}, ${JSON.stringify(line)}`,
      );
  }
  assert.deepEqual(widget.render(0), []);
  assert.match(plain(widget, 40), /Blocked/);
  assert.doesNotMatch(
    widget.render(120).join("\n"),
    /\x1b\[2J|\x1b\]2;|\nsecond/,
  );
  assert.match(plain(widget, 120), /second line/);
});

test("tool rendering keeps task details expandable and model-facing results untouched", () => {
  const renderer = agentTool("launch");
  const args = {
    name: "review",
    task: "Review login\nDo not edit files",
    cwd: "/project",
    model: "fixture/test",
  };
  const call = plain(renderer.renderCall!(args, theme, context()));
  assert.match(call, /Delegate · review\nReview login Do not edit files/);
  assert.doesNotMatch(call, /fixture\/test|"task"/);
  const expanded = plain(
    renderer.renderCall!(args, theme, context({ expanded: true })),
  );
  assert.match(expanded, /Review login\nDo not edit files/);
  assert.match(expanded, /model: fixture\/test/);
  const result: AgentToolResult<unknown> = {
    content: [{ type: "text", text: '{"internal":true}' }],
    details: run({ phase: "starting" }),
  };
  const before = JSON.stringify(result);
  const compact = plain(
    renderer.renderResult!(
      result,
      { expanded: false, isPartial: false },
      theme,
      context(),
    ),
  );
  assert.match(compact, /moss-fox\s+Launched/);
  assert.doesNotMatch(compact, /internal|run-id|Rex tab/);
  const full = plain(
    renderer.renderResult!(
      result,
      { expanded: true, isPartial: false },
      theme,
      context(),
    ),
  );
  assert.match(full, /Rex tab: w1/);
  assert.match(full, /Run: run-id/);
  assert.equal(JSON.stringify(result), before);
  const failedLaunch = plain(
    renderer.renderResult!(
      {
        content: [],
        details: {
          name: "lost-fox",
          phase: "finished",
          problem: "spawn_failed: program missing",
        },
      },
      { expanded: false, isPartial: false },
      theme,
      context(),
    ),
  );
  assert.match(failedLaunch, /Failed/);
  assert.match(failedLaunch, /spawn_failed/);
  assert.doesNotMatch(failedLaunch, /Finished|Launched/);
  const error = plain(
    renderer.renderResult!(
      {
        content: [{ type: "text", text: "Provider unavailable" }],
        details: undefined,
      },
      { expanded: false, isPartial: false },
      theme,
      context({ isError: true }),
    ),
  );
  assert.match(error, /Provider unavailable/);
  assert.match(
    plain(
      renderer.renderResult!(
        result,
        { expanded: false, isPartial: true },
        theme,
        context(),
      ),
    ),
    /Waiting for Rex/,
  );
  const narrowCall = renderer.renderCall!(
    { ...args, task: "x".repeat(1000) },
    theme,
    context(),
  );
  assert.equal(narrowCall.render(32).length, 2);
  for (const line of narrowCall.render(32)) assert.ok(visibleWidth(line) <= 32);
});

test("agent lists expand beyond the compact limit and preserve fallback output", () => {
  const renderer = agentTool("list").renderResult!;
  const result: AgentToolResult<unknown> = {
    content: [],
    details: Array.from({ length: 6 }, (_, i) => run({ name: `agent-${i}` })),
  };
  const compact = plain(
    renderer(result, { expanded: false, isPartial: false }, theme, context()),
  );
  assert.match(compact, /\+2 more/);
  assert.doesNotMatch(compact, /agent-5/);
  const full = plain(
    renderer(result, { expanded: true, isPartial: false }, theme, context()),
  );
  assert.match(full, /agent-5/);
  assert.doesNotMatch(full, /more/);
  assert.match(
    plain(
      renderer(
        { content: [], details: [] },
        { expanded: false, isPartial: false },
        theme,
        context(),
      ),
    ),
    /No delegated agents/,
  );
  assert.match(
    plain(
      renderer(
        {
          content: [{ type: "text", text: "Legacy result" }],
          details: undefined,
        },
        { expanded: false, isPartial: false },
        theme,
        context(),
      ),
    ),
    /Legacy result/,
  );
});

test("cancellation presentation distinguishes unconfirmed, cancelled and already-completed runs", () => {
  const renderer = agentTool("cancel").renderResult!;
  const show = (confirmed: boolean, value: Run) =>
    plain(
      renderer(
        { content: [], details: { confirmed, run: value } },
        { expanded: false, isPartial: false },
        theme,
        context(),
      ),
    );
  assert.match(
    show(false, run({ cancelled: true })),
    /Cancellation unconfirmed/,
  );
  assert.doesNotMatch(show(false, run({ cancelled: true })), /Cancelled/);
  assert.match(
    show(
      true,
      run({
        phase: "finished",
        cancelled: true,
        result: {
          version: 1,
          id: "run-id",
          outcome: "cancelled",
          text: "Cancelled",
          session: null,
        },
      }),
    ),
    /Cancelled/,
  );
  assert.match(
    show(
      true,
      run({
        phase: "finished",
        result: {
          version: 1,
          id: "run-id",
          outcome: "completed",
          text: "Done",
          session: null,
        },
      }),
    ),
    /Completed/,
  );
});

test("reports show a short Markdown preview, expand to evidence paths, and retain all outcomes", () => {
  const details = {
    name: "moss-fox",
    taskName: "Review login",
    outcome: "completed",
    text: "**Checked login.**\n\n- First finding\n- Second finding\n- Third finding\n- Fourth finding",
    path: "/private/result",
    session: "/private/session.jsonl",
  };
  const before = JSON.stringify(details);
  const compact = report(details);
  assert.match(plain(compact), /moss-fox · Completed · Review login/);
  assert.match(plain(compact), /Checked login\./);
  assert.doesNotMatch(plain(compact), /\*\*|Fourth finding|\/private/);
  assert.ok(compact.render(100).length <= 5);
  const full = report(details, true);
  assert.match(plain(full), /Fourth finding/);
  assert.match(plain(full), /Artifacts: \/private\/result/);
  assert.match(plain(full), /Session: \/private\/session.jsonl/);
  assert.match(
    plain(
      report({ ...details, name: "a-very-long-agent-identity-here" }),
      40,
    ).split("\n")[0]!,
    /Completed/,
  );
  const longPath = "/private/" + "long-directory/".repeat(8) + "result.json";
  const wrapped = report({ ...details, path: longPath }, true);
  assert.ok(
    wrapped
      .render(40)
      .map((line) => stripTerminalSequences(line).trim())
      .join("")
      .includes(longPath),
  );
  for (const width of [4, 20, 40, 80]) {
    compact.invalidate();
    for (const line of compact.render(width))
      assert.ok(visibleWidth(line) <= width);
  }
  for (const [outcome, label] of [
    ["failed", "Failed"],
    ["help", "Needs help"],
    ["cancelled", "Cancelled"],
  ]) {
    assert.match(plain(report({ ...details, outcome })), new RegExp(label!));
  }
  assert.match(
    plain(report({ ...details, text: "x".repeat(12_001) }, true), 100),
    /Preview truncated/,
  );
  assert.match(
    plain(report({ ...details, truncated: true }, true)),
    /Preview truncated/,
  );
  assert.equal(JSON.stringify(details), before);
  assert.equal(
    agentReport(
      {
        role: "custom",
        customType: "subagent_result",
        content: "Legacy fallback",
        display: true,
        timestamp: 0,
      },
      { expanded: false, outputPad: 1 },
      theme,
    ),
    undefined,
  );
});

test("renderer invalidation follows the active theme instead of retaining coloured widget strings", () => {
  const widget = agentWidget([run()], undefined, theme);
  const dark = widget.render(100).join("\n");
  initTheme("light", false);
  widget.invalidate();
  const light = widget.render(100).join("\n");
  assert.notEqual(light, dark);
  assert.equal(stripTerminalSequences(light), stripTerminalSequences(dark));
  initTheme("dark", false);
});
