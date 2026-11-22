import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { atomicJson, rexId, uuid, type ChildResult } from "./artifacts.ts";

export function completion(
  message: AssistantMessage | undefined,
): Pick<ChildResult, "outcome" | "text"> {
  if (!message)
    return {
      outcome: "failed",
      text: "Pi settled without an assistant response",
    };
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return {
      outcome: "failed",
      text: message.errorMessage || `Pi stopped: ${message.stopReason}`,
    };
  }
  return {
    outcome: "completed",
    text: message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
  };
}

export default function child(pi: ExtensionAPI): void {
  const directory = process.env.PI_REXLINGS_RUN_DIR ?? "";
  const id = basename(directory);
  const { REX_SESSION: rexSession, REX_BLOCK: terminal } = process.env;
  if (
    !isAbsolute(directory) ||
    !uuid.test(id) ||
    !rexId(rexSession, "session") ||
    !rexId(terminal, "block")
  )
    throw new Error("Child bridge requires its Rex location and run directory");
  const report = join(directory, "result.json");
  let last: AssistantMessage | undefined;
  let started = false;
  let published = existsSync(report);

  function publish(
    outcome: ChildResult["outcome"],
    text: string,
    session: string | undefined,
  ): void {
    if (published) return;
    atomicJson(report, {
      version: 1,
      id,
      outcome,
      text:
        text.length > 160_000
          ? `${text.slice(0, 160_000)}\n\n[Report truncated; the full response remains in the child session.]`
          : text,
      session: session ?? null,
    } satisfies ChildResult);
    published = true;
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui")
      throw new Error("Delegated Pi must be interactive, not print/RPC mode");
    atomicJson(join(directory, "ready.json"), { id, rexSession, terminal });
  });
  pi.on("agent_start", () => {
    started = true;
    last = undefined;
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") last = event.message;
  });
  pi.on("agent_settled", (event, ctx) => {
    if (!started || event.aborted || last?.stopReason === "aborted") return;
    const result = completion(last);
    publish(result.outcome, result.text, ctx.sessionManager.getSessionFile());
    ctx.shutdown();
  });
  pi.on("session_shutdown", (event, ctx) => {
    if (event.reason === "quit") {
      publish(
        "failed",
        "Child Pi exited before publishing a settled result",
        ctx.sessionManager.getSessionFile(),
      );
    }
  });
  pi.on("session_before_switch", () => ({ cancel: true }));
  pi.on("session_before_fork", () => ({ cancel: true }));
  pi.on("session_before_tree", () => ({ cancel: true }));
  pi.registerTool({
    name: "caller_ping",
    label: "Ask parent",
    description: "Report a blocker to your parent and end this task.",
    parameters: Type.Object({
      message: Type.String({ minLength: 1, maxLength: 16_000 }),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      publish("help", args.message, ctx.sessionManager.getSessionFile());
      ctx.shutdown();
      return {
        content: [
          { type: "text", text: "Help request recorded for the parent." },
        ],
        details: undefined,
        terminate: true,
      };
    },
  });
}
