import {
  getMarkdownTheme,
  type AgentToolResult,
  type MessageRenderer,
  type Theme,
  type ThemeColor,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Markdown,
  Text,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { previewLimit, type Run } from "./artifacts.ts";
import { object } from "./config.ts";

export function agentWidget(
  runs: readonly Run[],
  problem: string | undefined,
  theme: Theme,
): Component {
  const active = runs.filter((run) => run.phase !== "finished");
  const views = active.map(runView).filter((run) => run !== undefined);
  const warnings = views.filter((run) => run.problem).length;
  // Keep actionable problems visible even when the list is folded.
  views.sort((a, b) => Number(Boolean(b.problem)) - Number(Boolean(a.problem)));
  return {
    render(width) {
      if (width < 1) return [];
      return [
        theme.fg("accent", theme.bold("Agents")) +
          theme.fg("dim", ` · ${active.length} active`) +
          (warnings
            ? theme.fg(
                "warning",
                ` · ${warnings} warning${warnings === 1 ? "" : "s"}`,
              )
            : ""),
        ...(problem ? [theme.fg("warning", `  ${singleLine(problem)}`)] : []),
        ...agentRows(views, theme, width, 4),
      ].map((line) => truncateToWidth(line, width));
    },
    invalidate() {},
  };
}

export function agentListText(runs: readonly Run[]): string {
  return (
    runs
      .map(runView)
      .filter((run) => run !== undefined)
      .map(
        (run) =>
          `${run.name} · ${runState(run).label} · ${run.window || "pending"}${run.taskName ? ` · ${run.taskName}` : ""}` +
          (run.problem ? `\n  ${singleLine(run.problem)}` : ""),
      )
      .join("\n") || "No delegated agents"
  );
}

export function agentTool(
  action: "launch" | "interrupt" | "cancel" | "list",
): ToolRenderers {
  const title = {
    launch: "Delegate",
    interrupt: "Interrupt agent",
    cancel: "Cancel agent",
    list: "Agents",
  }[action];
  return {
    renderCall(args: unknown, theme, context) {
      const input = object(args) ? args : {};
      const label = field(input, action === "launch" ? "name" : "target");
      let text = theme.fg("toolTitle", theme.bold(title));
      if (label) text += theme.fg("muted", ` · ${singleLine(label)}`);
      if (action === "launch") {
        const task = clean(field(input, "task"));
        if (context.expanded) {
          text += `\n${task}`;
          for (const key of ["host", "session", "cwd", "model", "thinking"]) {
            if (field(input, key))
              text += theme.fg(
                "dim",
                `\n${key}: ${singleLine(field(input, key))}`,
              );
          }
        } else if (task) {
          text += theme.fg(
            "muted",
            `\n${truncateToWidth(singleLine(task), 100)}`,
          );
        }
      }
      if (context.expanded) return new Text(text, 0, 0);
      return {
        render(width) {
          return width > 0
            ? text.split("\n").map((line) => truncateToWidth(line, width))
            : [];
        },
        invalidate() {},
      };
    },
    renderResult(result: AgentToolResult<unknown>, options, theme, context) {
      if (context.isError)
        return new Text(theme.fg("error", clean(resultText(result))), 0, 0);
      if (options.isPartial)
        return new Text(theme.fg("dim", "Waiting for Rex…"), 0, 0);
      const details = result.details;
      if (action === "list" && Array.isArray(details)) {
        const runs = details.map(runView).filter((run) => run !== undefined);
        if (!runs.length)
          return new Text(theme.fg("dim", "No delegated agents"), 0, 0);
        return {
          render(width) {
            return width > 0
              ? agentRows(
                  runs,
                  theme,
                  width,
                  options.expanded ? runs.length : 4,
                )
              : [];
          },
          invalidate() {},
        };
      }
      if (action === "interrupt") {
        if (object(details) && details.sent === true)
          return new Text(
            theme.fg("muted", "Interrupt sent · Pi stays open"),
            0,
            0,
          );
      }
      const request =
        action === "cancel" && object(details) ? details : undefined;
      const run = runView(action === "launch" ? details : request?.run);
      if (run) {
        let { label, color } = runState(run);
        if (
          action === "launch" &&
          (run.phase === "starting" || run.phase === "running")
        ) {
          label = "Launched";
          color = "muted";
        } else if (request?.confirmed === false && run.phase !== "finished") {
          label = "Cancellation unconfirmed";
          color = "warning";
        }
        let text = theme.fg("accent", run.name) + "  " + theme.fg(color, label);
        if (run.problem)
          text += theme.fg("warning", `\n${singleLine(run.problem)}`);
        if (action === "launch" && options.expanded) {
          if (run.host) text += theme.fg("dim", `\nRex host: ${run.host}`);
          if (run.rexSession)
            text += theme.fg("dim", `\nRex session: ${run.rexSession}`);
          if (run.window) text += theme.fg("dim", `\nRex tab: ${run.window}`);
          text += theme.fg(
            "dim",
            `\nRun: ${run.id}\nThe answer arrives automatically.`,
          );
        }
        return new Text(text, 0, 0);
      }
      return new Text(theme.fg("muted", clean(resultText(result))), 0, 0);
    },
  };
}

export const agentReport: MessageRenderer = (message, options, theme) => {
  const details = message.details;
  if (
    !object(details) ||
    typeof details.name !== "string" ||
    typeof details.text !== "string" ||
    typeof details.outcome !== "string"
  )
    return undefined;

  const report = details.text;
  const state = outcome(details.outcome);
  const name = singleLine(details.name);
  const task = singleLine(field(details, "taskName"));
  const markdown = new Markdown(
    clean(report.slice(0, previewLimit)),
    0,
    0,
    getMarkdownTheme(),
  );
  const body: Component = {
    render(width) {
      if (width < 1) return [];
      let heading =
        theme.fg(
          "accent",
          theme.bold(
            options.expanded
              ? name
              : truncateToWidth(
                  name,
                  Math.max(1, width - visibleWidth(state.label) - 3),
                  "…",
                ),
          ),
        ) + theme.fg(state.color, ` · ${state.label}`);
      const remaining = width - visibleWidth(heading) - 3;
      if (task && (options.expanded || remaining > 0))
        heading += theme.fg(
          "dim",
          ` · ${options.expanded ? task : truncateToWidth(task, remaining)}`,
        );
      const answer = markdown.render(width);
      const shown = options.expanded ? answer : answer.slice(0, 3);
      const lines = [
        ...(options.expanded
          ? new Text(heading, 0, 0).render(width)
          : [truncateToWidth(heading, width)]),
        ...shown,
      ];
      if (!options.expanded)
        lines.push(theme.fg("dim", "Expand for report details"));
      else {
        if (details.truncated === true || report.length > previewLimit)
          lines.push(
            theme.fg(
              "dim",
              "Preview truncated; full report in the artifacts below.",
            ),
          );
        for (const [title, key] of [
          ["Rex host", "host"],
          ["Artifacts", "path"],
          [details.host ? "Remote Pi transcript" : "Session", "session"],
        ] as const) {
          const value = singleLine(field(details, key));
          if (value)
            lines.push(
              ...new Text(theme.fg("dim", `${title}: ${value}`), 0, 0).render(
                width,
              ),
            );
        }
      }
      return lines.map((line) => truncateToWidth(line, width));
    },
    invalidate() {
      markdown.invalidate();
    },
  };
  const box = new Box(options.outputPad, 0);
  box.addChild(body);
  return box;
};

function runView(value: unknown) {
  if (!object(value) || typeof value.name !== "string") return undefined;
  return {
    name: singleLine(value.name),
    taskName: singleLine(field(value, "taskName")),
    phase: field(value, "phase"),
    status: field(value, "status"),
    cancelled: value.cancelled === true,
    problem: field(value, "problem"),
    outcome:
      field(value, "outcome") ||
      (object(value.result) ? field(value.result, "outcome") : ""),
    window: singleLine(field(value, "window")),
    rexSession: singleLine(field(value, "rexSession")),
    host: singleLine(field(value, "host") || field(value, "remoteHost")),
    id: singleLine(field(value, "id")),
  };
}

type RunView = NonNullable<ReturnType<typeof runView>>;

function agentRows(
  runs: readonly RunView[],
  theme: Theme,
  width: number,
  limit: number,
): string[] {
  const shown = runs
    .slice(0, limit)
    .map((run) => ({ run, state: runState(run) }));
  const nameWidth = Math.min(
    32,
    Math.max(0, ...shown.map(({ run }) => visibleWidth(run.name))),
  );
  const stateWidth = Math.max(
    0,
    ...shown.map(({ state }) => visibleWidth(state.label)),
  );
  const lines: string[] = [];
  for (const { run, state } of shown) {
    if (width >= 60) {
      const name = truncateToWidth(run.name, nameWidth, "…", true);
      lines.push(
        `  ${theme.fg("accent", name)}  ${theme.fg(state.color, state.label.padEnd(stateWidth))}` +
          (run.taskName ? theme.fg("muted", `  ${run.taskName}`) : ""),
      );
    } else {
      const name = truncateToWidth(
        run.name,
        Math.max(1, width - 4 - visibleWidth(state.label)),
        "…",
      );
      lines.push(
        `  ${theme.fg("accent", name)}  ${theme.fg(state.color, state.label)}`,
      );
      if (run.taskName) lines.push(theme.fg("muted", `    ${run.taskName}`));
    }
    if (run.problem)
      lines.push(theme.fg("warning", `    ${singleLine(run.problem)}`));
  }
  if (runs.length > shown.length)
    lines.push(
      theme.fg("dim", `  +${runs.length - shown.length} more · /rexlings list`),
    );
  return lines.map((line) => truncateToWidth(line, width));
}

function runState(run: RunView): { label: string; color: ThemeColor } {
  if (run.phase === "finished")
    return outcome(run.outcome || (run.problem ? "failed" : ""));
  if (run.problem || run.phase === "uncertain")
    return { label: "Check", color: "warning" };
  if (run.cancelled) return { label: "Cancelling", color: "warning" };
  if (run.phase === "interrupted")
    return { label: "Interrupted", color: "warning" };
  if (run.phase === "finalizing") return { label: "Finishing", color: "muted" };
  if (run.phase === "starting") return { label: "Starting", color: "dim" };
  if (run.status === "working") return { label: "Working", color: "accent" };
  if (run.status === "blocked") return { label: "Blocked", color: "warning" };
  if (run.status === "idle") return { label: "Idle", color: "muted" };
  return { label: "Running", color: "muted" };
}

function outcome(value: string): { label: string; color: ThemeColor } {
  switch (value) {
    case "completed":
      return { label: "Completed", color: "success" };
    case "failed":
      return { label: "Failed", color: "error" };
    case "cancelled":
      return { label: "Cancelled", color: "muted" };
    case "help":
      return { label: "Needs help", color: "warning" };
    default:
      return { label: "Finished", color: "muted" };
  }
}

function field(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === "string" ? value[key] : "";
}

function clean(text: string): string {
  return stripTerminalSequences(text)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

function singleLine(text: string): string {
  return clean(text).replace(/\s+/g, " ").trim();
}

function resultText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
