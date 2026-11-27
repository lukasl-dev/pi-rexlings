import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  artifactLimit,
  atomicJson,
  optionalJson,
  privateDirectory,
  thinkingLevels,
  rexId,
  uuid,
  type ChildResult,
  type Thinking,
} from "./artifacts.ts";
import {
  absolutePath,
  agentDirectory,
  executable,
  object,
  readConfig,
  validateName,
} from "./config.ts";

interface TerminalLocation {
  rexSession: string;
  terminal: string;
}

// Also runs in the remote bootstrap, before the bundle is installed.
export function inspectTerminal(
  exec: typeof execFileSync,
  env: NodeJS.ProcessEnv,
  id: RegExp,
): TerminalLocation {
  const { REX_BLOCK: terminal, REX_SERVER: server, ...local } = env;
  delete local.REX_SESSION;
  delete local.REX_CLIENT;
  if (!terminal?.startsWith("block:") || !id.test(terminal.slice(6)))
    throw new Error("Missing full REX_BLOCK ID");

  const raw = exec(
    "rex",
    [
      "--autostart=false",
      "--timeout=3s",
      ...(server?.startsWith("unix:///") ? ["-S", server] : []),
      "block",
      "inspect",
      terminal,
      "--json",
    ],
    { env: local, encoding: "utf8", timeout: 5_000 },
  );
  const record = JSON.parse(raw) as {
    session_id?: unknown;
    block?: { block_id?: unknown; creator_name?: unknown };
  } | null;
  const rexSession = record?.session_id;
  if (
    typeof rexSession !== "string" ||
    !rexSession.startsWith("session:") ||
    !id.test(rexSession.slice(8)) ||
    record?.block?.block_id !== terminal ||
    record.block.creator_name !== "com.superlogical.terminal"
  )
    throw new Error("Rex did not identify this terminal and its session");
  return { rexSession, terminal };
}

export function terminalLocation(): TerminalLocation {
  return inspectTerminal(execFileSync, process.env, uuid);
}

export interface Task {
  version: 1;
  name: string;
  rexSession: string;
  cwd: string;
  model: string;
  thinking: Thinking;
  text: string;
}

export function parseTask(value: unknown): Task {
  if (
    !object(value) ||
    value.version !== 1 ||
    typeof value.name !== "string" ||
    !rexId(value.rexSession, "session") ||
    !absolutePath(value.cwd) ||
    typeof value.model !== "string" ||
    !/^[^/\x00]+\/[^\x00]+$/.test(value.model) ||
    !thinkingLevels.some((level) => value.thinking === level) ||
    typeof value.text !== "string" ||
    !value.text.trim() ||
    value.text.length > 101_000
  )
    throw new Error("Invalid Rexlings task");
  validateName(value.name);
  return value as unknown as Task;
}

export function piArgs(directory: string, task: Task): string[] {
  const slash = task.model.indexOf("/");
  return [
    "--extension",
    fileURLToPath(new URL("child.ts", import.meta.url)),
    "--provider",
    task.model.slice(0, slash),
    "--model",
    task.model.slice(slash + 1),
    "--thinking",
    task.thinking,
    "--name",
    task.name,
    "--session",
    join(directory, "session.jsonl"),
    "--",
    `@${join(directory, "task.md")}`,
  ];
}

const frameEnd = "\n.\n";
const frameLimit = artifactLimit * 2;

// ASCII survives a PTY; the digest detects missing or changed terminal output.
export function encodeFrame(value: unknown): string {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > artifactLimit)
    throw new Error("Rexlings payload exceeds 1 MiB");
  const digest = createHash("sha256").update(bytes).digest("hex");
  return `rexlings ${digest}\n${bytes
    .toString("base64")
    .match(/.{1,64}/g)!
    .join("\n")}${frameEnd}`;
}

export function decodeFrame(frame: string): unknown {
  const match = /^rexlings ([a-f0-9]{64})\n([A-Za-z0-9+/=\n]+)\n\.$/.exec(
    frame.trim(),
  );
  if (frame.length > frameLimit || !match)
    throw new Error("Invalid Rexlings terminal frame");
  const base64 = match[2]!.replaceAll("\n", "");
  const bytes = Buffer.from(base64, "base64");
  if (
    bytes.length > artifactLimit ||
    bytes.toString("base64") !== base64 ||
    createHash("sha256").update(bytes).digest("hex") !== match[1]
  )
    throw new Error("Damaged Rexlings terminal frame");
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

export function readyLine(id: string): string {
  return `rexlings-ready ${id}`;
}

async function receiveTask(
  id: string,
  directory: string,
  rexSession: string,
  terminal: string,
): Promise<Task> {
  const input = process.stdin;
  if (!input.isTTY) throw new Error("Rexlings launcher needs a terminal");
  input.setRawMode(true);
  try {
    return await new Promise((resolve, reject) => {
      let frame = "";
      const timer = setTimeout(
        () => finish(new Error("Timed out waiting for the Rexlings task")),
        30_000,
      );
      function finish(error: unknown, task?: Task) {
        clearTimeout(timer);
        input
          .off("data", onData)
          .off("end", onEnd)
          .off("error", onError)
          .pause();
        if (error) reject(error);
        else resolve(task!);
      }
      function onEnd() {
        finish(new Error("Rex terminal closed before delivering the task"));
      }
      function onError(error: Error) {
        finish(error);
      }
      function onData(chunk: Buffer) {
        frame += chunk.toString("ascii");
        if (frame.length > frameLimit)
          finish(new Error("Rexlings input exceeds its frame limit"));
        else if (frame.includes(frameEnd)) {
          try {
            finish(null, parseTask(decodeFrame(frame)));
          } catch (error) {
            finish(error);
          }
        }
      }
      try {
        atomicJson(join(directory, "ready.json"), { id, rexSession, terminal });
        input.on("data", onData).once("end", onEnd).once("error", onError);
        console.log(readyLine(id));
      } catch (error) {
        finish(error);
      }
    });
  } finally {
    input.setRawMode(false);
  }
}

async function launch(
  id: string,
  root: string,
  session: string,
  { rexSession, terminal }: TerminalLocation,
): Promise<void> {
  if (session !== rexSession)
    throw new Error("Launch does not match this Rex terminal");
  privateDirectory(root);
  const directory = join(root, id);
  mkdirSync(directory, { mode: 0o700 });
  try {
    const task = await receiveTask(id, directory, rexSession, terminal);
    if (task.rexSession !== rexSession)
      throw new Error("Task does not match this Rex session");
    const profile = agentDirectory();
    const command = readConfig(profile).piCommand;
    const program = executable(command[0]!);
    process.chdir(task.cwd);
    writeFileSync(join(directory, "task.md"), task.text, {
      mode: 0o600,
      flag: "wx",
    });
    const args = [...command.slice(1), ...piArgs(directory, task)];
    const env = {
      ...process.env,
      PI_REXLINGS_RUN_DIR: directory,
      PI_CODING_AGENT_DIR: profile,
      PI_PACKAGE_DIR: "",
      PI_PROGRAM_STATUS: "1",
    };
    if (process.execve) process.execve(program, [program, ...args], env);
    // Bun lacks execve. Keep Pi in the Rex terminal's process group and share its PTY.
    const child = spawn(program, args, { env, stdio: "inherit" });
    const hangup = () => child.kill("SIGHUP");
    const terminate = () => child.kill("SIGTERM");
    process.on("SIGHUP", hangup).on("SIGTERM", terminate);
    try {
      process.exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolve(code ?? 1));
      });
    } finally {
      process.off("SIGHUP", hangup).off("SIGTERM", terminate);
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    atomicJson(join(directory, "result.json"), {
      version: 1,
      id,
      outcome: "failed",
      text,
      session: null,
    } satisfies ChildResult);
    throw error;
  }
}

export async function main(
  args: string[],
  location?: TerminalLocation,
): Promise<void> {
  const [verb, id, arg, ...extra] = args;
  const root = join(agentDirectory(), "rexlings", "incoming");
  try {
    if (id && uuid.test(id) && !extra.length) {
      if (verb === "launch" && rexId(arg, "session") && location)
        await launch(id, root, arg, location);
      else if (verb === "read" && (arg === "ready" || arg === "result"))
        process.stdout.write(
          encodeFrame(optionalJson(join(root, id, `${arg}.json`)) ?? null),
        );
      else
        throw new Error(
          "Expected launch RUN_ID SESSION_ID or read RUN_ID ready|result",
        );
    } else throw new Error("Invalid Rexlings launcher arguments");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
