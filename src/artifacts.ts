import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { object } from "./config.ts";

const outcomes = ["completed", "failed", "cancelled", "help"] as const;
type Outcome = (typeof outcomes)[number];

export const reportType = "rexlings_result";
export const previewLimit = 12_000;
export const artifactLimit = 1024 * 1024;

export const thinkingLevels = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type Thinking = (typeof thinkingLevels)[number];

export interface ChildResult {
  version: 1;
  id: string;
  outcome: Outcome;
  text: string;
  session: string | null;
}

const phases = [
  "starting",
  "running",
  "interrupted",
  "uncertain",
  "finished",
] as const;

export const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function rexId(
  value: unknown,
  kind: "session" | "window" | "block",
): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(`${kind}:`) &&
    uuid.test(value.slice(kind.length + 1))
  );
}

export interface Run {
  version: 1;
  id: string;
  owner: string;
  name: string;
  taskName: string;
  cwd: string;
  model: string;
  thinking: Thinking;
  created: number;
  instance: string;
  rexSession: string;
  remoteHost?: string;
  remoteHostId?: string;
  runtime?: string;
  window: string | null;
  terminal: string | null;
  cancelled: boolean;
  delivered: boolean;
  phase: (typeof phases)[number];
  status: string | null;
  problem: string | null;
  result: ChildResult | null;
}

export type FinishedRun = Run & { phase: "finished"; result: ChildResult };

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = statSync(path);
  if (
    (process.getuid && info.uid !== process.getuid()) ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error(
      `Agent state directory must be owned by you and private (0700): ${path}`,
    );
  }
}

export function atomicJson(path: string, value: unknown): void {
  const temporary = join(dirname(path), `.write-${randomUUID()}`);
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, path);
}

export function optionalJson(path: string): unknown {
  try {
    if (statSync(path).size > artifactLimit)
      throw new Error(`Agent artifact exceeds 1 MiB: ${path}`);
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    if (object(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function parseResult(value: unknown, id: string): ChildResult {
  if (
    !object(value) ||
    value.version !== 1 ||
    value.id !== id ||
    !outcomes.some((outcome) => outcome === value.outcome) ||
    typeof value.text !== "string" ||
    !(value.session === null || typeof value.session === "string")
  ) {
    throw new Error(`Invalid result artifact for run ${id}`);
  }
  return value as unknown as ChildResult;
}

export function parseRun(
  value: unknown,
  owner: string,
  id: string,
  parentSession: string,
): Run {
  if (
    !object(value) ||
    value.version !== 1 ||
    value.owner !== owner ||
    value.id !== id ||
    !["name", "taskName", "cwd", "model"].every(
      (k) => typeof value[k] === "string",
    ) ||
    !thinkingLevels.some((level) => level === value.thinking) ||
    typeof value.created !== "number" ||
    typeof value.instance !== "string" ||
    !(value.rexSession === undefined || rexId(value.rexSession, "session")) ||
    !(
      value.remoteHost === undefined ||
      (typeof value.remoteHost === "string" &&
        value.remoteHost.length > 0 &&
        !/[\x00-\x1f\x7f]/.test(value.remoteHost) &&
        rexId(value.rexSession, "session"))
    ) ||
    !(
      value.remoteHostId === undefined ||
      (typeof value.remoteHostId === "string" && value.remoteHostId.length > 0)
    ) ||
    !(
      value.runtime === undefined ||
      (typeof value.runtime === "string" &&
        /^[a-f0-9]{64}$/.test(value.runtime))
    ) ||
    !(value.window === null || rexId(value.window, "window")) ||
    !(value.terminal === null || rexId(value.terminal, "block")) ||
    typeof value.cancelled !== "boolean" ||
    typeof value.delivered !== "boolean" ||
    !(
      phases.some((phase) => phase === value.phase) ||
      value.phase === "finalizing"
    ) ||
    !(value.status === null || typeof value.status === "string") ||
    !(value.problem === null || typeof value.problem === "string")
  ) {
    throw new Error(`Invalid run manifest: ${id}`);
  }
  if (value.result !== null) parseResult(value.result, id);
  const rexSession = value.rexSession ?? parentSession;
  if (value.phase === "finished") {
    if (value.result === null)
      throw new Error(`Finished run has no result: ${id}`);
    return { ...value, rexSession } as unknown as FinishedRun;
  }
  // Earlier manifests copied the report before the child exited. Read it from result.json on exit instead.
  return {
    ...value,
    rexSession,
    phase: value.phase === "finalizing" ? "running" : value.phase,
    result: null,
  } as unknown as Run;
}

export function saveRun(root: string, run: Run): void {
  atomicJson(join(root, run.id, "run.json"), run);
}
