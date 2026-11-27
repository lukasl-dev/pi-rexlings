import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { rexId } from "./artifacts.ts";
import { object } from "./config.ts";

const exec = promisify(execFile);
const terminal = "com.superlogical.terminal";

export interface Block {
  window: string | null;
  label: string;
  serverTerminal: boolean;
}

interface Session {
  id: string;
  name: string;
}

export type RexEvent =
  | { kind: "exit"; block: string }
  | { kind: "status"; block: string; state: string | null };

interface Identity {
  endpoint: string;
  instance: string;
  host: string;
}

export class Rex {
  readonly env: NodeJS.ProcessEnv;
  readonly command: string;
  readonly #endpoint: string | undefined;
  readonly #remote: string | undefined;
  #identity: Identity | undefined;

  constructor(env: NodeJS.ProcessEnv, command = "rex", remote?: string) {
    this.env = { ...env };
    // Neither an inherited remote selector nor an app's focus identifies the parent.
    for (const key of ["REX_SERVER", "REX_CLIENT", "REX_SESSION", "REX_BLOCK"])
      delete this.env[key];
    const address = env.REX_SERVER;
    if (address?.startsWith("unix:///")) this.#endpoint = address;
    this.command = command;
    this.#remote = remote;
  }

  async identity(): Promise<Identity> {
    const value = await this.#json(["whoami", "--json"]);
    if (
      !object(value) ||
      typeof value.endpoint !== "string" ||
      !value.endpoint ||
      typeof value.instance_id !== "string" ||
      typeof value.host_id !== "string"
    )
      throw new Error("Rex did not report a server identity");
    if (
      !this.#remote &&
      (!value.endpoint.startsWith("unix:///") ||
        !object(value.principal) ||
        value.principal.transport !== "unix" ||
        value.principal.uid !== process.getuid?.())
    ) {
      throw new Error(
        "Rexlings requires a local Unix Rex server under your UID",
      );
    }

    const identity = {
      endpoint: value.endpoint,
      instance: value.instance_id,
      host: value.host_id,
    };
    if (
      this.#identity &&
      (identity.instance !== this.#identity.instance ||
        identity.host !== this.#identity.host ||
        identity.endpoint !== this.#identity.endpoint)
    )
      throw new Error(
        "The Rex server changed; refusing to control runs from the old instance",
      );
    return (this.#identity ??= identity);
  }

  async hosts(): Promise<{ name: string; registration: string }[]> {
    const value = await this.#json(["hosts", "list", "--json"]);
    if (!object(value) || !(value.hosts === null || Array.isArray(value.hosts)))
      throw new Error("Invalid Rex host list");
    return (value.hosts ?? []).map((entry: unknown) => {
      if (
        !object(entry) ||
        !object(entry.host) ||
        typeof entry.host.label !== "string" ||
        typeof entry.host.id !== "string"
      )
        throw new Error("Invalid Rex host registration");
      return { name: entry.host.label, registration: entry.host.id };
    });
  }

  async sessions(): Promise<Session[]> {
    const value = await this.#api("session.list", {});
    if (
      !object(value) ||
      !(value.sessions === null || Array.isArray(value.sessions))
    )
      throw new Error("Invalid Rex session list");
    return (value.sessions ?? []).map((entry: unknown) => {
      if (
        !object(entry) ||
        !rexId(entry.session_id, "session") ||
        typeof entry.label !== "string"
      )
        throw new Error("Invalid Rex session record");
      return { id: entry.session_id, name: entry.label };
    });
  }

  async createSession(name: string): Promise<Session> {
    const value = await this.#api("session.create", { label: name });
    if (!object(value) || !rexId(value.session_id, "session"))
      throw new Error("Rex did not return the new session ID");
    return { id: value.session_id, name };
  }

  async blocks(session: string): Promise<Map<string, Block>> {
    const { host } = this.#connected();
    const value = await this.#api("session.list_blocks", {
      session_id: session,
    });
    if (
      !object(value) ||
      !(value.blocks === null || Array.isArray(value.blocks))
    )
      throw new Error("Invalid Rex block list");
    const blocks = new Map<string, Block>();
    for (const b of value.blocks ?? []) {
      if (
        !object(b) ||
        !rexId(b.block_id, "block") ||
        blocks.has(b.block_id) ||
        !(b.window_id == null || rexId(b.window_id, "window")) ||
        !(b.host_id == null || typeof b.host_id === "string") ||
        !(b.creator_name == null || typeof b.creator_name === "string")
      )
        throw new Error("Invalid Rex block record");
      blocks.set(b.block_id, {
        window: b.window_id ?? null,
        label: typeof b.label === "string" ? b.label : "",
        serverTerminal: b.host_id === host && b.creator_name === terminal,
      });
    }
    return blocks;
  }

  async launch(
    session: string,
    name: string,
    cwd: string | undefined,
    argv: string[],
    keepOpen = false,
  ): Promise<{ window: string; terminal: string }> {
    const value = await this.#api("session.new_window", {
      session_id: session,
      window_label: name,
      focus: false,
      layout: {
        block: {
          flavor: `${terminal}.shell`,
          label: name,
          options: {
            cwd,
            shell: "none",
            login: false,
            command: argv,
            exit: { on_completion: !keepOpen, quick_exit_threshold_ms: 3_000 },
          },
        },
      },
    });
    if (
      !object(value) ||
      !rexId(value.window_id, "window") ||
      !Array.isArray(value.block_ids) ||
      value.block_ids.length !== 1 ||
      !rexId(value.block_ids[0], "block")
    )
      throw new Error("Rex did not return one window and one block ID");
    return { window: value.window_id, terminal: value.block_ids[0] };
  }

  async exited(session: string, block: string): Promise<number | null> {
    const value = await this.#api("block.method", {
      session_id: session,
      block_id: block,
      method: "process",
      args: {},
    });
    if (!object(value)) throw new Error("Invalid Rex process record");
    if (value.last_exit === null) return null;
    if (
      !object(value.last_exit) ||
      typeof value.last_exit.exit_code !== "number"
    )
      throw new Error("Invalid Rex process exit status");
    return value.last_exit.exit_code;
  }

  async muteTab(session: string, window: string): Promise<void> {
    this.#connected();
    const value: unknown = JSON.parse(
      await this.#text(
        ["--timeout=1s", "client", "ls", "--json"],
        undefined,
        1_500,
      ),
    );
    if (!object(value) || !Array.isArray(value.clients)) return;

    const args = JSON.stringify({
      session_id: session,
      window_id: window,
      muted: true,
    });
    // Mute belongs to each app, not the server. A refusing app must not block the others.
    await Promise.allSettled(
      value.clients.flatMap((client: unknown) =>
        object(client) &&
        rexId(client.client_id, "client") &&
        object(client.info) &&
        client.info.kind === "app" &&
        (client.connection_state === undefined ||
          client.connection_state === "connected")
          ? [
              this.#text(
                [
                  "--timeout=1s",
                  "-C",
                  client.client_id,
                  "do",
                  "client.tab.mute",
                  "--args",
                  args,
                ],
                undefined,
                1_500,
              ),
            ]
          : [],
      ),
    );
  }

  async interrupt(session: string, block: string): Promise<void> {
    await this.write(session, block, "\x1b");
  }

  async write(session: string, block: string, data: string): Promise<void> {
    this.#connected();
    const value = await this.#json(
      ["api", "call", "block.method", "-"],
      JSON.stringify({
        session_id: session,
        block_id: block,
        method: "write",
        args: { data },
      }),
    );
    if (!object(value) || value.bytes_written !== Buffer.byteLength(data))
      throw new Error("Rex did not queue all input for the requested block");
  }

  async close(session: string, block: string): Promise<void> {
    // The tab may now contain someone else's split. Never close the window.
    const value = await this.#api("block.close", {
      session_id: session,
      block_id: block,
    });
    if (!object(value) || value.block_id !== block)
      throw new Error("Rex did not confirm the requested block closed");
  }

  capture(session: string, block: string): Promise<string> {
    this.#connected();
    return this.#text([
      "capture",
      "-s",
      session,
      "-b",
      block,
      "--trim",
      "--unwrap",
    ]);
  }

  async readCommand(
    session: string,
    argv: string[],
    timeoutMs: number,
  ): Promise<string> {
    const { terminal } = await this.launch(
      session,
      "Rexlings read",
      undefined,
      argv,
      true,
    );
    try {
      await this.#text(
        ["wait", "-s", session, "--for", `${timeoutMs}ms`, terminal],
        undefined,
        timeoutMs + 1_000,
      );
      return await this.capture(session, terminal);
    } finally {
      await this.close(session, terminal);
    }
  }

  events(
    session: string,
    onEvent: (event: RexEvent) => void,
    onDisconnect: () => void,
  ): ChildProcess {
    const child = spawn(
      this.command,
      this.#argv(["events", "-s", session, "--json"]),
      {
        env: this.env,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      const event = parseEvent(value, session);
      if (event) onEvent(event);
    });
    child.on("error", () => lines.close());
    child.once("close", () => {
      lines.close();
      onDisconnect();
    });
    return child;
  }

  #connected(): Identity {
    if (!this.#identity)
      throw new Error("Rex identity has not been established");
    return this.#identity;
  }

  #api(method: string, args: Record<string, unknown>): Promise<unknown> {
    this.#connected();
    return this.#json(["api", "call", method, JSON.stringify(args)]);
  }

  #argv(args: string[]): string[] {
    const endpoint = this.#identity?.endpoint ?? this.#remote ?? this.#endpoint;
    return [
      "--autostart=false",
      "--timeout=3s",
      ...(endpoint ? ["-S", endpoint] : []),
      ...args,
    ];
  }

  async #json(args: string[], input?: string): Promise<unknown> {
    return JSON.parse(await this.#text(args, input)) as unknown;
  }

  async #text(
    args: string[],
    input?: string,
    timeout = 5_000,
  ): Promise<string> {
    const call = exec(this.command, this.#argv(args), {
      env: this.env,
      timeout,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (input !== undefined) {
      // Never put task text in the local CLI's argv or in Rex's launch arguments.
      call.child.stdin?.on("error", () => {}).end(input);
    }
    const { stdout } = await call.catch((error: unknown) => {
      const message =
        object(error) && typeof error.stderr === "string" && error.stderr.trim()
          ? error.stderr.trim()
          : error instanceof Error
            ? error.message
            : String(error);
      throw new Error(`Rex ${args[0]}: ${message.slice(0, 1_000)}`);
    });
    return stdout;
  }
}

export function parseEvent(
  value: unknown,
  session: string,
): RexEvent | undefined {
  if (
    !object(value) ||
    value.type !== "session_event" ||
    !object(value.payload) ||
    value.payload.session_id !== session ||
    !object(value.payload.event)
  )
    return;
  const { type, payload } = value.payload.event;
  if (!object(payload) || !rexId(payload.block_id, "block")) return;
  const block = payload.block_id;
  if (type === "block_closed") return { kind: "exit", block };
  if (type !== "block_event" || payload.creator_name !== terminal) return;
  if (payload.name === "child_exited") return { kind: "exit", block };
  if (payload.name === "program_status_removed")
    return { kind: "status", block, state: null };
  if (
    payload.name === "program_status_changed" &&
    object(payload.payload) &&
    object(payload.payload.record) &&
    typeof payload.payload.record.state === "string"
  )
    return { kind: "status", block, state: payload.payload.record.state };
}
