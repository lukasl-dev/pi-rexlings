import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  absolutePath,
  agentDirectory,
  executable,
  object,
  terminalName,
  type Config,
} from "./config.ts";
import {
  atomicJson,
  optionalJson,
  parseResult,
  parseRun,
  privateDirectory,
  rexId,
  saveRun,
  uuid,
  type ChildResult,
  type FinishedRun,
  type Run,
  type Thinking,
} from "./artifacts.ts";
import {
  decodeFrame,
  encodeFrame,
  parseTask,
  piArgs,
  readyLine,
} from "./launch.ts";
import { Rex, type Block } from "./rex.ts";
import {
  nixRuntimeStarting,
  runtimeBundle,
  runtimeCommand,
  runtimeStartupMs,
} from "./runtime.ts";

export interface Launch {
  task: string;
  name?: string;
  session?: string;
  host?: string;
  cwd: string;
  model: string;
  thinking: Thinking;
}

export interface HostOptions {
  session: string;
  rexSession: string;
  parent: string;
  config: Config;
  directory?: string;
  env?: NodeJS.ProcessEnv;
  rex?: string;
  onResult: (run: FinishedRun, path: string) => void;
  onChange?: () => void;
}

interface Snapshot {
  instance: string;
  hostId: string;
  blocks: ReadonlyMap<string, Block>;
  missing?: true;
}

type Destination = Pick<Run, "rexSession" | "remoteHost">;

function destinationKey({ rexSession, remoteHost }: Destination): string {
  return `${remoteHost ?? ""}/${rexSession}`;
}

const reconcileIntervalMs = 3_000;

export class Host {
  readonly owner: string;
  readonly root: string;
  readonly #runs = new Map<string, Run>();
  readonly #options: HostOptions;
  readonly #rex: Rex;
  readonly #remotes = new Map<string, { registration: string; rex: Rex }>();
  readonly #directory: string;
  #localHost: string | undefined;
  problem: string | undefined;
  #events = new Map<string, ChildProcess>();
  #queue: Promise<void> = Promise.resolve();
  #queued = new Set<string>();
  #timer: NodeJS.Timeout | undefined;
  #shutdown: Promise<void> | undefined;

  constructor(options: HostOptions) {
    if (!rexId(options.rexSession, "session"))
      throw new Error("Missing full Rex session ID");
    if (!rexId(options.parent, "block"))
      throw new Error("Missing full REX_BLOCK ID");
    this.#options = options;
    const env = options.env ?? process.env;
    this.#rex = new Rex(env, options.rex);
    this.owner = createHash("sha256")
      .update(
        JSON.stringify([options.session, options.rexSession, options.parent]),
      )
      .digest("hex")
      .slice(0, 24);
    this.#directory = options.directory ?? agentDirectory(options.env);
    this.root = join(this.#directory, "rexlings", "runs", this.owner);
  }

  get runs(): ReadonlyMap<string, Readonly<Run>> {
    return this.#runs;
  }

  async start(delivered: ReadonlySet<string> = new Set()): Promise<void> {
    const snapshot = await this.#snapshot(this.#options);
    privateDirectory(this.root);
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !uuid.test(entry.name)) continue;
      const value = optionalJson(join(this.root, entry.name, "run.json"));
      if (value === undefined) continue;
      const run = parseRun(
        value,
        this.owner,
        entry.name,
        this.#options.rexSession,
      );
      if (delivered.has(run.id)) run.delivered = true;
      run.status = null;
      this.#runs.set(run.id, run);
    }
    await this.#serial(() => this.#refresh(snapshot));
  }

  get active(): boolean {
    return this.#runs
      .values()
      .some((r) => r.phase !== "finished" || !r.delivered);
  }

  async hosts(): Promise<string[]> {
    return (await this.#rex.hosts()).map(({ name }) => name);
  }

  async sessions(host?: string) {
    const { rex } = await this.#identify(host);
    return (await rex.sessions()).map((session) => ({
      ...session,
      current: host === undefined && session.id === this.#options.rexSession,
    }));
  }

  createSession(name: string, host?: string) {
    return this.#serial(async () => {
      if (this.#shutdown) throw new Error("Rexlings is shutting down");
      if (
        !name.trim() ||
        Buffer.byteLength(name) > 128 ||
        /[\x00-\x1f\x7f]/.test(name)
      )
        throw new Error(
          "Session names must be nonempty, printable and at most 128 bytes",
        );
      const { rex } = await this.#identify(host);
      return rex.createSession(name);
    });
  }

  launch(input: Launch): Promise<Run> {
    return this.#serial(async () => {
      if (this.#shutdown) throw new Error("Rexlings is shutting down");
      const remote = input.host !== undefined;
      if (remote && (!input.session || !absolutePath(input.cwd)))
        throw new Error(
          "Remote launch requires an explicit session and an absolute destination cwd",
        );
      const cwd = remote ? input.cwd : resolve(input.cwd);
      if (!remote && !statSync(cwd).isDirectory())
        throw new Error(`Not a directory: ${cwd}`);
      if (!input.task.trim() || input.task.length > 100_000)
        throw new Error("Task must contain 1–100000 characters");
      if (
        input.name &&
        (input.name.length > 80 || /[\x00-\x1f\x7f]/.test(input.name))
      )
        throw new Error("Task labels must be at most 80 printable characters");
      let rexSession = this.#options.rexSession;
      if (input.session !== undefined) {
        const sessions = await this.sessions(input.host);
        const matches = rexId(input.session, "session")
          ? sessions.filter((candidate) => candidate.id === input.session)
          : sessions.filter((candidate) => candidate.name === input.session);
        if (matches.length !== 1)
          throw new Error(
            `${matches.length ? "Ambiguous" : "Unknown"} Rex session: ${input.session}. Use rex_sessions_list and a full ID.`,
          );
        rexSession = matches[0]!.id;
      }
      const destination = {
        rexSession,
        ...(input.host === undefined ? {} : { remoteHost: input.host }),
      };
      const { instance, hostId, blocks, missing } =
        await this.#snapshot(destination);
      if (missing) throw new Error(`Rex session disappeared: ${rexSession}`);
      const rex = this.#server(input.host);
      const bundle = remote ? runtimeBundle() : undefined;
      const used = new Set([...blocks.values()].map((b) => b.label));
      for (const run of this.runs.values()) used.add(run.name);
      const run: Run = {
        version: 1,
        id: randomUUID(),
        owner: this.owner,
        name: terminalName(this.#options.config.terminal, input.name, used),
        taskName: input.name ?? "",
        cwd,
        model: input.model,
        thinking: input.thinking,
        created: Date.now(),
        instance,
        ...destination,
        ...(bundle && { remoteHostId: hostId, runtime: bundle.digest }),
        window: null,
        terminal: null,
        cancelled: false,
        delivered: false,
        phase: "starting",
        status: null,
        problem: null,
        result: null,
      };
      const task = parseTask({
        version: 1,
        name: run.name,
        rexSession,
        cwd,
        model: input.model,
        thinking: input.thinking,
        text:
          `${input.task}\n\nYou are a delegated child. Do not launch other agents. ` +
          `Do not push, merge, deploy or remove worktrees unless the task explicitly authorizes it. ` +
          `Give your final answer normally; the host delivers it automatically. Use caller_ping if blocked.\n`,
      });
      const directory = join(this.root, run.id);
      const env = this.#options.env ?? process.env;
      const command = this.#options.config.piCommand;
      const argv = bundle
        ? runtimeCommand(
            bundle.digest,
            "launch",
            run.id,
            rexSession,
            bundle.payload,
          )
        : [
            executable("env", env),
            `PI_REXLINGS_RUN_DIR=${directory}`,
            `PI_CODING_AGENT_DIR=${this.#directory}`,
            "PI_PACKAGE_DIR=",
            "PI_PROGRAM_STATUS=1",
            `PATH=${env.PATH ?? ""}`,
            executable(command[0]!, env),
            ...command.slice(1),
            ...piArgs(directory, task),
          ];
      privateDirectory(directory);
      writeFileSync(join(directory, "task.md"), task.text, {
        mode: 0o600,
        flag: "wx",
      });
      const frame = remote ? encodeFrame(task) : undefined;
      saveRun(this.root, run);
      this.#runs.set(run.id, run);
      this.#subscribe(run);
      try {
        const location = await rex.launch(
          rexSession,
          run.name,
          remote ? undefined : cwd,
          argv,
        );
        this.#update(run, location);
        if (this.#options.config.terminal.mute)
          await rex.muteTab(rexSession, location.window).catch(() => {});
        if (frame !== undefined) {
          const started = Date.now();
          let startupMs = 5_000;
          for (;;) {
            const screen = await rex.capture(rexSession, location.terminal);
            const lines = screen.split("\n");
            if (lines.includes(readyLine(run.id))) break;
            if (lines.includes(nixRuntimeStarting))
              startupMs = runtimeStartupMs;
            if (
              Date.now() - started >= startupMs ||
              (await rex.exited(rexSession, location.terminal)) !== null
            )
              throw new Error(
                `Rexlings launcher did not become ready for task input${screen.trim() ? `: ${screen.trim().slice(0, 500)}` : ""}`,
              );
            await delay(60);
          }
          for (let start = 0; start < frame.length; start += 16_384)
            await rex.write(
              rexSession,
              location.terminal,
              frame.slice(start, start + 16_384),
            );
        }
        this.#update(run, { phase: "running" });
      } catch (error) {
        // Neither an unanswered create nor a partial task feed can be replayed.
        this.#update(run, { phase: "uncertain", problem: detail(error) });
      }
      this.#wake();
      return structuredClone(run);
    });
  }

  interrupt(target: string): Promise<{ sent: true; run: Run }> {
    return this.#serial(async () => {
      const run = this.#find(target);
      if (run.cancelled) throw new Error(`${run.name} is being cancelled`);
      try {
        const block = await this.#observe(run, await this.#snapshot(run));
        if (!block)
          throw new Error(`${run.name} has no confirmed live Rex block`);
        await this.#server(run.remoteHost).interrupt(run.rexSession, block);
        this.#update(run, { phase: "interrupted" });
      } finally {
        this.#wake();
      }
      return { sent: true, run: structuredClone(run) };
    });
  }

  cancel(target: string): Promise<{ confirmed: boolean; run: Run }> {
    return this.#serial(async () => {
      const run = this.#find(target);
      if (run.phase !== "finished")
        await this.#cancelRun(run, this.#snapshot(run));
      this.#wake();
      return {
        confirmed: run.result?.outcome === "cancelled",
        run: structuredClone(run),
      };
    });
  }

  acknowledge(id: string): Promise<void> {
    return this.#serial(async () => {
      const run = this.#runs.get(id);
      if (run?.phase === "finished") {
        this.#update(run, { delivered: true });
        this.#queued.delete(id);
      }
    });
  }

  shutdown(preserve: boolean): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    clearTimeout(this.#timer);
    for (const session of this.#events.keys()) this.#unsubscribe(session);
    return (this.#shutdown = this.#serial(async () => {
      if (preserve) return;
      const live = [...this.#runs.values()].filter(
        (r) => r.phase !== "finished",
      );
      for (const runs of Map.groupBy(live, destinationKey).values()) {
        const snapshot = this.#snapshot(runs[0]!);
        for (const run of runs) await this.#cancelRun(run, snapshot);
      }
      const unresolved = live.filter((r) => r.phase !== "finished");
      if (unresolved.length)
        throw new Error(
          `Rexlings could not confirm exit of: ${unresolved.map((r) => r.name).join(", ")}`,
        );
    }));
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work);
    this.#queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  #wake(delay = 0): void {
    if (this.#shutdown || (this.#timer && delay > 0)) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#serial(() => this.#refresh());
    }, delay);
    this.#timer.unref();
  }

  #subscribe(destination: Destination): void {
    const key = destinationKey(destination);
    if (this.#events.has(key) || this.#shutdown) return;
    const stream = this.#server(destination.remoteHost).events(
      destination.rexSession,
      (event) => {
        const run = this.#runs
          .values()
          .find((r) => destinationKey(r) === key && r.terminal === event.block);
        if (!run || run.phase === "finished") return;
        if (event.kind === "exit") this.#wake();
        else {
          run.status = event.state;
          this.#options.onChange?.();
        }
      },
      () => {
        if (this.#events.get(key) === stream) this.#events.delete(key);
      },
    );
    this.#events.set(key, stream);
  }

  #unsubscribe(session: string): void {
    this.#events.get(session)?.kill();
    this.#events.delete(session);
  }

  #server(host: string | undefined): Rex {
    if (host === undefined) return this.#rex;
    const remote = this.#remotes.get(host);
    if (!remote) throw new Error(`Rex host has not been verified: ${host}`);
    return remote.rex;
  }

  async #identify(host: string | undefined) {
    if (host === undefined) {
      const { host: hostId, instance } = await this.#rex.identity();
      this.#localHost = hostId;
      return { rex: this.#rex, instance, hostId };
    }
    const matches = (await this.#rex.hosts()).filter(
      (entry) => entry.name === host,
    );
    if (matches.length !== 1)
      throw new Error(
        `Rex host is not registered under an exact unique name: ${host}`,
      );
    const { registration } = matches[0]!;
    const previous = this.#remotes.get(host);
    const rex =
      previous?.registration === registration
        ? previous.rex
        : new Rex(this.#options.env ?? process.env, this.#options.rex, host);
    const { host: hostId, instance } = await rex.identity();
    this.#localHost ??= (await this.#rex.identity()).host;
    if (hostId === this.#localHost)
      throw new Error(`Remote selector ${host} resolved to the parent host`);
    this.#remotes.set(host, { registration, rex });
    return { rex, instance, hostId };
  }

  async #readRemote(run: Run, artifact: "ready" | "result"): Promise<unknown> {
    if (!run.runtime)
      throw new Error("This run has no destination runtime recorded");
    const screen = await this.#server(run.remoteHost).readCommand(
      run.rexSession,
      runtimeCommand(run.runtime, "read", run.id, artifact),
      runtimeStartupMs,
    );
    // Nix can print progress before the launcher writes the frame.
    const value = decodeFrame(
      screen.slice(screen.lastIndexOf("\nrexlings ") + 1),
    );
    return value === null ? undefined : value;
  }

  async #snapshot({ rexSession, remoteHost }: Destination): Promise<Snapshot> {
    const { rex, instance, hostId } = await this.#identify(remoteHost);
    const ownsParent =
      remoteHost === undefined && rexSession === this.#options.rexSession;
    try {
      const blocks = await rex.blocks(rexSession);
      if (ownsParent && !blocks.get(this.#options.parent)?.serverTerminal)
        throw new Error(
          "REX_BLOCK is not a local terminal in this Rex session",
        );
      return { instance, hostId, blocks };
    } catch (error) {
      if (
        ownsParent ||
        (await rex.sessions()).some((entry) => entry.id === rexSession)
      )
        throw error;
      return { instance, hostId, blocks: new Map(), missing: true };
    }
  }

  async #refresh(initial?: Snapshot): Promise<void> {
    if (this.#shutdown) return;
    this.problem = undefined;
    const pending = this.#runs.values().filter((r) => r.phase !== "finished");
    for (const runs of Map.groupBy(pending, destinationKey).values()) {
      const destination = runs[0]!;
      try {
        const snapshot =
          (!destination.remoteHost &&
          destination.rexSession === this.#options.rexSession
            ? initial
            : undefined) ?? (await this.#snapshot(destination));
        if (!snapshot.missing) this.#subscribe(destination);
        for (const run of runs) {
          if (run.cancelled) await this.#cancelRun(run, snapshot);
          else
            await this.#observe(run, snapshot).catch((error: unknown) => {
              this.#update(run, { problem: detail(error) });
            });
        }
      } catch (error) {
        for (const run of runs) this.#update(run, { problem: detail(error) });
        this.problem = detail(error);
      }
    }
    if (this.#shutdown) return;
    for (const run of this.runs.values()) this.#deliver(run);
    const live = new Set(
      this.#runs
        .values()
        .filter((r) => r.phase !== "finished")
        .map(destinationKey),
    );
    for (const session of this.#events.keys())
      if (!live.has(session)) this.#unsubscribe(session);
    if (
      live.size ||
      this.runs.values().some((r) => !r.delivered && !this.#queued.has(r.id))
    ) {
      // The stream can miss a fast exit during subscription; Rex can also retain a failed terminal.
      this.#wake(reconcileIntervalMs);
    }
    this.#options.onChange?.();
  }

  async #observe(
    run: Run,
    { instance, hostId, blocks, missing }: Snapshot,
  ): Promise<string | undefined> {
    if (run.phase === "finished") return;
    if (
      run.instance !== instance ||
      (run.remoteHostId && run.remoteHostId !== hostId)
    )
      throw new Error("Run belongs to a different Rex server or instance");

    const directory = join(this.root, run.id);
    let { terminal, window, phase } = run;
    if (!terminal && !missing) {
      const ready = run.remoteHost
        ? await this.#readRemote(run, "ready")
        : optionalJson(join(directory, "ready.json"));
      if (ready !== undefined) {
        if (
          !object(ready) ||
          ready.id !== run.id ||
          ready.rexSession !== run.rexSession ||
          !rexId(ready.terminal, "block")
        )
          throw new Error("Child ready file does not match the Rex launch");
        terminal = ready.terminal;
        phase = "running";
      }
    } else if (phase === "starting") {
      phase = "running";
    }
    if (!terminal && !missing) return;
    if (
      terminal === this.#options.parent ||
      (terminal &&
        this.runs
          .values()
          .some((other) => other !== run && other.terminal === terminal))
    )
      throw new Error(
        "Run names a Rex block owned by another agent or its parent",
      );
    const block = terminal ? blocks.get(terminal) : undefined;
    if (block && !block.serverTerminal)
      throw new Error(
        "The run's block is not a terminal on the selected Rex server",
      );
    window ??= block?.window ?? null;
    if (!missing && !block && !run.terminal) {
      // The bridge can publish its ID after list_blocks. The next snapshot must agree the block is absent.
      this.#update(run, { terminal, phase });
      this.#wake();
      return;
    }
    const exit =
      block && terminal
        ? await this.#server(run.remoteHost).exited(run.rexSession, terminal)
        : missing
          ? "session closed"
          : "block closed";
    if (exit === null) {
      this.#update(run, {
        terminal,
        window,
        phase,
        problem: run.cancelled ? run.problem : null,
      });
      return terminal ?? undefined;
    }

    // The bridge publishes before shutdown. Only read and deliver its report after Rex confirms exit.
    let result = run.cancelled
      ? this.#result(run, "cancelled", "Cancelled by parent")
      : this.#result(
          run,
          "failed",
          `Rex child ended without a result (${exit})`,
        );
    if (!run.cancelled) {
      if (run.remoteHost) {
        const saved = optionalJson(join(directory, "result.json"));
        const payload =
          saved ??
          (missing ? undefined : await this.#readRemote(run, "result"));
        if (payload !== undefined) {
          result = parseResult(payload, run.id);
          if (saved === undefined)
            atomicJson(join(directory, "result.json"), result);
        } else if (missing) {
          result.text =
            "The destination Rex session was removed. Any saved report remains on the destination host.";
        }
      } else
        try {
          const payload = optionalJson(join(directory, "result.json"));
          if (payload !== undefined) result = parseResult(payload, run.id);
        } catch (error) {
          result.text = `Could not read the exited child's report: ${detail(error)}`;
        }
    }
    this.#update(run, {
      terminal,
      window,
      phase: "finished",
      result,
      problem: null,
    });
  }

  async #cancelRun(
    run: Run,
    snapshot: Snapshot | Promise<Snapshot>,
  ): Promise<void> {
    try {
      const block = await this.#observe(run, await snapshot);
      if (run.phase === "finished") return;
      this.#update(run, { cancelled: true });
      if (!block)
        throw new Error(
          "No confirmed block ID; Rex may still be starting the child",
        );
      await this.#server(run.remoteHost).close(run.rexSession, block);
      this.#update(run, {
        phase: "finished",
        problem: null,
        result: this.#result(run, "cancelled", "Cancelled by parent"),
      });
    } catch (error) {
      this.#update(run, {
        cancelled: true,
        problem: `Cancellation unconfirmed: ${detail(error)}`,
      });
    }
  }

  #result(
    run: Run,
    outcome: ChildResult["outcome"],
    text: string,
  ): ChildResult {
    return {
      version: 1,
      id: run.id,
      outcome,
      text,
      session: null,
    };
  }

  #update(run: Run, patch: Partial<Run>): void {
    if (
      Object.entries(patch).every(
        ([key, value]) => run[key as keyof Run] === value,
      )
    )
      return;
    const next = { ...run, ...patch };
    saveRun(this.root, next);
    Object.assign(run, patch);
  }

  #deliver(run: Run): void {
    if (
      run.phase !== "finished" ||
      !run.result ||
      run.delivered ||
      this.#queued.has(run.id)
    )
      return;
    this.#queued.add(run.id);
    try {
      this.#options.onResult(
        { ...run, phase: "finished", result: { ...run.result } },
        join(this.root, run.id),
      );
    } catch (error) {
      this.#queued.delete(run.id);
      this.problem = `Result delivery failed: ${detail(error)}`;
    }
  }

  #find(target: string): Run {
    const exact = this.#runs.get(target);
    if (exact) return exact;
    const matches = this.#runs
      .values()
      .filter((r) => r.name === target)
      .take(2)
      .toArray();
    if (matches.length === 1) return matches[0]!;
    throw new Error(`Unknown or ambiguous owned agent: ${target}`);
  }
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
