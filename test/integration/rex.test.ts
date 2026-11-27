import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  mkdtempSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as nap } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { executable, object, parseConfig } from "../../src/config.ts";
import { Host, type HostOptions } from "../../src/host.ts";
import type { Run, ChildResult } from "../../src/artifacts.ts";
import { Rex } from "../../src/rex.ts";
import { runtimeBundle, runtimeCommand } from "../../src/runtime.ts";

const exec = promisify(execFile);
const cli =
  process.env.PI_REXLINGS_TEST_CLI ??
  fileURLToPath(
    new URL(
      "../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
      import.meta.url,
    ),
  );
const pi = [
  process.execPath,
  cli,
  "--offline",
  "--no-approve",
  "--no-skills",
  "--no-context-files",
];
const keeper = [process.execPath, "-e", "setInterval(()=>{},10000)"];
const model = { model: "fixture/test", thinking: "off" as const };

async function until<T>(
  read: () => T | Promise<T>,
  description: string,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await nap(30);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

async function fixture(t: TestContext, parentArgv = keeper, remote = false) {
  const dir = mkdtempSync(join(tmpdir(), "rexlings-"));
  t.diagnostic(`Isolated test artifacts: ${dir}`);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: join(dir, "home"),
    XDG_RUNTIME_DIR: join(dir, "runtime"),
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_STATE_HOME: join(dir, "state"),
    XDG_DATA_HOME: join(dir, "data"),
    PI_CODING_AGENT_DIR: join(dir, "agent"),
    PI_SKIP_VERSION_CHECK: "1",
    SHELL: "/bin/sh",
    LANG: "C.UTF-8",
    TERM: "xterm-256color",
  };
  const cwd = join(dir, "it's a project");
  for (const path of [
    env.HOME!,
    env.XDG_RUNTIME_DIR!,
    env.PI_CODING_AGENT_DIR!,
    cwd,
    join(dir, "bin"),
  ])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  const shell = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    join(dir, "bin/pi"),
    `#!/bin/sh\nexport WRAPPER_FIXTURE=from-wrapper\nexec ${pi.map(shell).join(" ")} "$@"\n`,
    { mode: 0o700 },
  );
  env.PATH = `${join(dir, "bin")}${delimiter}${env.PATH ?? ""}`;
  const bun = remote ? process.env.PI_REXLINGS_TEST_BUN : undefined;
  if (remote && process.env.PI_REXLINGS_TEST_NIX) {
    for (const bin of ["rex", "env", "bash", "nix", "nix-shell"])
      symlinkSync(executable(bin), join(dir, "bin", bin));
    env.PATH = join(dir, "bin");
    env.NIX_PATH = process.env.NIX_PATH;
  } else if (bun) {
    symlinkSync(bun, join(dir, "bin", "bun"));
    writeFileSync(join(dir, "bin", "node"), "#!/bin/sh\nexit 1\n", {
      mode: 0o700,
    });
  }

  const requests: Record<string, unknown>[] = [];
  let aborted = 0;
  let release: (() => void) | undefined;
  let delegation: unknown = {
    task: "WAIT_FOR_RELEASE",
    name: "fixture-review",
  };
  const provider = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body) as Record<string, unknown>;
    requests.push(payload);
    const transcript = JSON.stringify(payload.messages);
    const parent =
      transcript.includes("PARENT_TEST") &&
      !transcript.includes("delegated child");
    const handoff = transcript.includes("Child report:");
    const followUp =
      Array.isArray(payload.messages) &&
      payload.messages.some((m: unknown) => object(m) && m.role === "tool");
    if (transcript.includes("FAIL_CHILD")) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "Fixture denied access" } }),
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: unknown, stop: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({
          id: "fixture",
          object: "chat.completion.chunk",
          created: 0,
          model: "test",
          choices: [{ index: 0, delta, finish_reason: stop }],
        })}\n\n`,
      );
    chunk({ role: "assistant", content: "" });
    const help = transcript.includes("HELP_CHILD");
    if ((parent && !handoff && !followUp) || help) {
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "delegate",
            type: "function",
            function: {
              name: help ? "caller_ping" : "rex_subagent",
              arguments: JSON.stringify(
                help ? { message: "Need parent input" } : delegation,
              ),
            },
          },
        ],
      });
      chunk({}, "tool_calls");
    } else {
      if (transcript.includes("SLOW_CHILD")) {
        chunk({ content: "Working..." });
        response.on("close", () => {
          aborted++;
        });
        return;
      }
      chunk({
        content: parent
          ? handoff
            ? "PARENT_RECEIVED_CHILD_RESULT_42"
            : "Waiting for child."
          : "CHILD_RESULT_42",
      });
      if (!parent && transcript.includes("WAIT_FOR_RELEASE")) {
        release = () => {
          chunk({}, "stop");
          response.end("data: [DONE]\n\n");
        };
        return;
      }
      chunk({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  writeFileSync(
    join(env.PI_CODING_AGENT_DIR!, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "test-only",
          api: "openai-completions",
          models: [
            {
              id: "test",
              name: "Fixture",
              reasoning: false,
              input: ["text"],
              contextWindow: 128000,
              maxTokens: 1024,
            },
          ],
        },
      },
    }),
  );

  const extensions = join(env.PI_CODING_AGENT_DIR!, "extensions");
  mkdirSync(extensions);
  if (!remote)
    symlinkSync(
      fileURLToPath(new URL("../../", import.meta.url)),
      join(extensions, "pi-rexlings"),
      "dir",
    );
  writeFileSync(
    join(extensions, "profile-probe.ts"),
    `export default function(pi) {
    pi.on("agent_start",(_e,ctx)=>{
      if (process.env.PI_REXLINGS_RUN_DIR) require("node:fs").writeFileSync(
        process.env.PI_REXLINGS_RUN_DIR + "/profile.json", JSON.stringify({marker:process.env.WRAPPER_FIXTURE,cwd:ctx.cwd}));
    });
  }`,
  );
  writeFileSync(
    join(env.PI_CODING_AGENT_DIR!, "mcp.json"),
    JSON.stringify({
      autoEnableCodemode: false,
      mcpServers: {
        profile: {
          command: process.execPath,
          args: [
            fileURLToPath(
              new URL("../fixtures/profile-mcp.mjs", import.meta.url),
            ),
          ],
          exposure: "direct",
        },
      },
    }),
  );

  const endpoint = `unix://${join(env.XDG_RUNTIME_DIR!, "rex/server.sock")}`;
  const server = spawn(
    "rex",
    [
      "server",
      "run",
      "--listen",
      endpoint,
      "--restore=false",
      "--state-dir",
      join(dir, "rex-state"),
    ],
    { env, stdio: ["ignore", "ignore", "pipe"] },
  );
  let serverError = "";
  server.stderr.on("data", (chunk) => {
    serverError = (serverError + String(chunk)).slice(-4000);
  });
  server.on("error", (e) => {
    serverError = String(e);
  });
  const cleanup: (() => Promise<void>)[] = [];
  t.after(async () => {
    try {
      for (const action of cleanup.reverse()) await action();
    } finally {
      if (
        server.pid &&
        server.exitCode === null &&
        server.signalCode === null
      ) {
        const exited = once(server, "close");
        server.kill();
        await exited;
      }
      provider.closeAllConnections();
      provider.close();
      if (serverError) writeFileSync(join(dir, "rex-server.log"), serverError);
    }
  });
  const rex = async (...args: string[]) =>
    (
      await exec(
        "rex",
        ["--autostart=false", "--timeout=2s", "-S", endpoint, ...args],
        { env, timeout: 5000 },
      )
    ).stdout;
  await until(async () => {
    if (!server.pid || server.exitCode !== null)
      assert.fail(`Cannot start isolated Rex: ${serverError}`);
    const identity = await rex("whoami", "--json").then(
      (out) => JSON.parse(out),
      () => null,
    );
    return identity?.endpoint === endpoint;
  }, "isolated Rex socket");
  const created = JSON.parse(
    await rex(
      "new",
      "host-session",
      "--shell=none",
      "-c",
      cwd,
      "--json",
      "--",
      ...parentArgv,
    ),
  );
  const session: string = created.session_id;
  const parent: string = created.initial_windows[0].block_ids[0];
  const parentWindow: string = created.initial_windows[0].window_id;
  const inspect = async () =>
    JSON.parse(await rex("session", "inspect", session, "--json")) as {
      active_window_id: string;
      windows: { window_id: string; label: string }[];
    };
  const blocks = async () =>
    JSON.parse(
      await rex("api", "call", "-s", session, "session.list_blocks", "{}"),
    ).blocks as { block_id: string; window_id?: string }[];
  const results: { run: Run; result: ChildResult }[] = [];
  const options: HostOptions = {
    session: "fixture",
    rexSession: session,
    parent,
    config: parseConfig({}),
    env,
    onResult: (run) => {
      results.push({ run, result: run.result });
    },
  };
  async function host(preserve = false) {
    const value = new Host(options);
    cleanup.push(() => value.shutdown(preserve));
    await value.start();
    return value;
  }
  return {
    dir,
    endpoint,
    cwd,
    env,
    host,
    options,
    rex,
    inspect,
    blocks,
    session,
    parent,
    parentWindow,
    requests,
    results,
    aborted: () => aborted,
    release: () => release,
    delegate(args: unknown) {
      delegation = args;
    },
  };
}

test(
  "real parent Pi delegates into a background tab of its Rex session and receives one follow-up",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, [
      ...pi,
      "--provider",
      "fixture",
      "--model",
      "test",
      "--thinking",
      "off",
      "--",
      "PARENT_TEST: Delegate to a Rex subagent",
    ]);
    await until(f.release, "real child model request");
    const before = await f.inspect();
    assert.equal(before.active_window_id, f.parentWindow);
    assert.equal(before.windows.length, 2);
    const childWindow = before.windows.find(
      (w) => w.window_id !== f.parentWindow,
    )!;
    assert.match(childWindow.label, /^[a-z]+-[a-z]+$/);
    const child = (await f.blocks()).find(
      (b) => b.window_id === childWindow.window_id,
    )!;
    const screen = await f.rex(
      "capture",
      "-s",
      f.session,
      "-b",
      f.parent,
      "--trim",
    );
    assert.match(screen, /1 active/);
    assert.match(screen, /fixture-review/);
    const childRequest = f.requests.find((request) =>
      JSON.stringify(request.messages).includes("delegated child"),
    );
    assert.ok(childRequest);
    const toolNames = (
      childRequest.tools as { function: { name: string } }[]
    ).map((tool) => tool.function.name);
    assert.ok(
      toolNames.includes("caller_ping") &&
        toolNames.includes("mcp__profile__echo"),
    );
    const parentTools = (
      f.requests[0]!.tools as { function: { name: string } }[]
    ).map((tool) => tool.function.name);
    assert.deepEqual(
      parentTools
        .filter((name) =>
          /^(?:rex_)?(?:subagent|hosts_list|sessions_list|session_create)/.test(
            name,
          ),
        )
        .sort(),
      [
        "rex_hosts_list",
        "rex_session_create",
        "rex_sessions_list",
        "rex_subagent",
        "rex_subagent_cancel",
        "rex_subagent_interrupt",
        "rex_subagents_list",
      ],
    );
    assert.ok(!toolNames.some((name) => name.startsWith("rex_")));
    f.release()!();
    const view = await until(async () => {
      const text = await f.rex(
        "capture",
        "-s",
        f.session,
        "-b",
        f.parent,
        "--trim",
      );
      return text.includes("PARENT_RECEIVED_CHILD_RESULT_42")
        ? text
        : undefined;
    }, "automatic parent follow-up");
    assert.match(view, /Completed/);
    assert.deepEqual(
      (await f.inspect()).windows.map((w) => w.window_id),
      [f.parentWindow],
    );
    const reports = f.requests.filter((r) =>
      JSON.stringify(r.messages).includes("Child report:"),
    );
    assert.equal(reports.length, 1);
    const messages = JSON.stringify(reports[0]!.messages);
    assert.match(messages, /CHILD_RESULT_42/);
    assert.ok(messages.includes(childWindow.window_id));
    assert.ok(!(await f.blocks()).some((b) => b.block_id === child.block_id));
  },
);

test(
  "session selection uses exact names or IDs, survives a rename and reload, and isolates cancellation",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const host = await f.host(true);
    const target = await host.createSession("Separate work");
    const layout = async () =>
      JSON.parse(await f.rex("session", "inspect", target.id, "--json"));
    assert.equal((await layout()).windows?.length ?? 0, 0);
    assert.deepEqual(await host.sessions(), [
      { id: f.session, name: "host-session", current: true },
      { ...target, current: false },
    ]);
    const input = { ...model, task: "SLOW_CHILD", cwd: f.cwd };
    const parentLayout = async () => {
      const { active_window_id, windows } = await f.inspect();
      return { active_window_id, windows };
    };
    const before = await parentLayout();
    await assert.rejects(
      host.launch({ ...input, session: "separate work" }),
      /Unknown Rex session/,
    );
    assert.equal(host.runs.size, 0);

    const child = await host.launch({ ...input, session: target.name });
    assert.ok(child.terminal);
    assert.equal(child.rexSession, target.id);
    await until(
      () => host.runs.get(child.id)?.status === "working",
      "status in destination session",
    );
    assert.deepEqual(await parentLayout(), before);
    assert.equal((await layout()).windows[0].window_id, child.window);

    await host.createSession(target.name);
    await assert.rejects(
      host.launch({ ...input, session: target.name }),
      /Ambiguous Rex session/,
    );
    await f.rex(
      "api",
      "call",
      "session.set_label",
      JSON.stringify({ session_id: target.id, label: "Renamed" }),
    );
    await host.shutdown(true);
    const recovered = await f.host();
    assert.equal(recovered.runs.get(child.id)?.rexSession, target.id);
    await recovered.interrupt(child.id);
    await until(() => f.aborted() > 0, "interruption in destination session");
    assert.equal((await recovered.cancel(child.id)).confirmed, true);
    const cancellation = await until(
      () => f.results.find(({ run }) => run.id === child.id),
      "cross-session cancellation report",
    );
    assert.equal(cancellation.result.outcome, "cancelled");
    assert.equal((await layout()).windows?.length ?? 0, 0);

    const done = await recovered.launch({
      ...model,
      task: "Return CHILD_RESULT_42",
      cwd: f.cwd,
      session: target.id,
    });
    const completion = await until(
      () => f.results.find(({ run }) => run.id === done.id),
      "cross-session completion report",
    );
    assert.equal(completion.result.outcome, "completed");
    assert.equal(completion.result.text, "CHILD_RESULT_42");
    assert.equal(completion.run.rexSession, target.id);

    const removed = await recovered.launch({ ...input, session: target.id });
    await until(
      () => recovered.runs.get(removed.id)?.status === "working",
      "child in session to be removed",
    );
    await f.rex("kill", target.id);
    const ended = await until(
      () => f.results.find(({ run }) => run.id === removed.id),
      "report after destination session removal",
    );
    assert.notEqual(ended.result.outcome, "completed");
    assert.deepEqual(await parentLayout(), before);
  },
);

test(
  "remote Rex launch uses only Rex and recovers a durable report after parent reload",
  { timeout: 45_000 },
  async (t) => {
    const parent = await fixture(t);
    const destination = await fixture(t, keeper, true);
    const hostId = JSON.parse(
      await destination.rex("whoami", "--json"),
    ).host_id;
    await parent.rex("hosts", "add", "fixture", destination.endpoint);
    await parent.rex("hosts", "add", "loopback", parent.endpoint);
    const options = {
      ...parent.options,
      config: parseConfig({
        piCommand: ["/nonexistent/parent-pi"],
      }),
    };
    const before = (await parent.inspect()).windows;
    const host = new Host(options);
    t.after(() => host.shutdown(true));
    await host.start();
    assert.ok((await host.hosts()).includes("fixture"));
    await assert.rejects(host.sessions("unconfigured"), /not registered/);
    await assert.rejects(
      host.createSession("No local fallback", "loopback"),
      /resolved to the parent host/,
    );
    const target = await host.createSession("Remote work", "fixture");
    assert.ok(
      (await host.sessions("fixture")).some(
        (s) => s.id === target.id && !s.current,
      ),
    );
    const input = {
      ...model,
      session: target.id,
      cwd: destination.cwd,
      task: "WAIT_FOR_RELEASE\n" + "literal '$(text)' 🦊\n".repeat(4500),
    };
    await assert.rejects(
      host.launch({
        ...model,
        cwd: destination.cwd,
        task: input.task,
        host: "fixture",
      }),
      /explicit session/,
    );
    assert.equal(host.runs.size, 0);

    const rex = new Rex(destination.env);
    await rex.identity();
    const { digest, payload } = runtimeBundle();
    const { terminal } = await rex.launch(
      destination.session,
      "wrong destination",
      undefined,
      [
        executable("env", destination.env),
        `REX_SESSION=${parent.session}`,
        ...runtimeCommand(
          digest,
          "launch",
          randomUUID(),
          parent.session,
          payload,
        ),
      ],
      true,
    );
    try {
      assert.equal(
        await until(async () => {
          const status = await rex.exited(destination.session, terminal);
          return status === null ? undefined : { status };
        }, "mismatched runtime exit").then(({ status }) => status),
        1,
      );
      assert.match(
        await rex.capture(destination.session, terminal),
        /Runtime destination does not match this Rex terminal/,
      );
    } finally {
      await rex.close(destination.session, terminal);
    }
    assert.equal(
      existsSync(join(destination.env.PI_CODING_AGENT_DIR!, "rexlings")),
      false,
    );

    const run = await host.launch({ ...input, host: "fixture" });
    assert.equal(run.remoteHost, "fixture");
    assert.equal(run.remoteHostId, hostId);
    assert.equal(run.rexSession, target.id);
    assert.ok(run.terminal);
    assert.equal(run.phase, "running", run.problem ?? "");
    const release = await until(
      destination.release,
      "remote Pi provider request",
    );
    assert.equal(parent.requests.length, 0);
    assert.deepEqual((await parent.inspect()).windows, before);
    const remoteDir = join(
      destination.env.PI_CODING_AGENT_DIR!,
      "rexlings",
      "incoming",
      run.id,
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(remoteDir, "profile.json"), "utf8")),
      {
        marker: "from-wrapper",
        cwd: destination.cwd,
      },
    );
    assert.deepEqual(
      readFileSync(join(remoteDir, "task.md")),
      readFileSync(join(host.root, run.id, "task.md")),
    );
    const installed = join(
      destination.env.PI_CODING_AGENT_DIR!,
      "rexlings",
      "runtime",
      run.runtime!,
      "launch.ts",
    );
    assert.deepEqual(
      readFileSync(installed),
      readFileSync(new URL("../../src/launch.ts", import.meta.url)),
    );
    await host.shutdown(true);
    release();
    await until(
      () => existsSync(join(remoteDir, "result.json")),
      "report stored remotely without a relay",
    );
    await until(async () => {
      const blocks =
        JSON.parse(
          await destination.rex(
            "api",
            "call",
            "session.list_blocks",
            JSON.stringify({ session_id: target.id }),
          ),
        ).blocks ?? [];
      return !blocks.some(
        (block: { block_id: string }) => block.block_id === run.terminal,
      );
    }, "remote Pi exit");

    const recovered = new Host(options);
    t.after(() => recovered.shutdown(false));
    await recovered.start();
    const result = await until(
      () => parent.results.find(({ run: report }) => report.id === run.id),
      "recovered remote report",
    );
    assert.equal(result.result.text, "CHILD_RESULT_42");
    assert.equal(result.result.outcome, "completed");
    assert.deepEqual(
      result.result,
      JSON.parse(readFileSync(join(remoteDir, "result.json"), "utf8")),
    );
    assert.deepEqual(
      result.result,
      JSON.parse(
        readFileSync(join(recovered.root, run.id, "result.json"), "utf8"),
      ),
    );
    await recovered.acknowledge(run.id);

    const next = await recovered.launch({
      ...input,
      host: "fixture",
      task: "SLOW_CHILD",
    });
    await until(
      () => destination.requests.length === 2,
      "second remote Pi provider request",
    );
    await recovered.interrupt(next.id);
    await until(() => destination.aborted() === 1, "remote interrupt");
    assert.equal((await recovered.cancel(next.id)).confirmed, true);
    await until(
      () => parent.results.some(({ run }) => run.id === next.id),
      "remote cancellation report",
    );
    assert.equal(
      parent.results.filter(({ run: report }) => report.id === run.id).length,
      1,
    );
    assert.deepEqual((await parent.inspect()).windows, before);
    await until(async () => {
      const blocks =
        JSON.parse(
          await destination.rex(
            "api",
            "call",
            "session.list_blocks",
            JSON.stringify({ session_id: target.id }),
          ),
        ).blocks ?? [];
      return blocks.length === 0;
    }, "finished child and read helper blocks to close");

    parent.delegate({
      ...input,
      host: "fixture",
      task: "Return the fixture answer",
    });
    const tui = JSON.parse(
      await parent.rex(
        "new",
        "parent-pi",
        "--shell=none",
        "-c",
        parent.cwd,
        "--json",
        "--",
        ...pi,
        "--provider",
        "fixture",
        "--model",
        "test",
        "--thinking",
        "off",
        "--",
        "PARENT_TEST: Delegate to the remote host",
      ),
    );
    const tuiBlock = tui.initial_windows[0].block_ids[0];
    await until(async () => {
      const screen = await parent.rex(
        "capture",
        "-s",
        tui.session_id,
        "-b",
        tuiBlock,
        "--trim",
      );
      return screen.includes("PARENT_RECEIVED_CHILD_RESULT_42");
    }, "real parent Pi receiving its remote child's report");
    assert.equal(
      parent.requests.filter(({ messages }) =>
        JSON.stringify(messages).includes("Rex host: fixture"),
      ).length,
      1,
    );
  },
);

test(
  "real child retains its wrapper, cwd and profile and returns completed/help/failure outcomes",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const other = JSON.parse(
      await f.rex("new", "other-session", "--json", "--", ...keeper),
    );
    const inspectOther = async () =>
      JSON.parse(await f.rex("session", "inspect", other.session_id, "--json"));
    const beforeOther = (await inspectOther()).windows;
    const host = await f.host();
    for (const [task, outcome, text] of [
      [
        "A literal task: 'quoted' $(not-a-shell)\nsecond line",
        "completed",
        /CHILD_RESULT_42/,
      ],
      ["HELP_CHILD", "help", /Need parent input/],
      ["FAIL_CHILD", "failed", /Fixture denied access/],
    ] as const) {
      const run = await host.launch({ ...model, task, cwd: f.cwd });
      const result = (
        await until(
          () => f.results.find((r) => r.run.id === run.id),
          `${outcome} result`,
        )
      ).result;
      if (result.outcome !== outcome && run.terminal) {
        t.diagnostic(
          await f.rex("capture", "-s", f.session, "-b", run.terminal, "--trim"),
        );
      }
      assert.equal(result.outcome, outcome, result.text);
      assert.match(result.text, text);
      const artifact = (file: string) =>
        JSON.parse(readFileSync(join(host.root, run.id, file), "utf8"));
      assert.deepEqual(artifact("profile.json"), {
        marker: "from-wrapper",
        cwd: f.cwd,
      });
      assert.equal(artifact("ready.json").terminal, run.terminal);
      assert.equal(artifact("ready.json").rexSession, f.session);
      await host.acknowledge(run.id);
    }
    assert.equal(host.active, false);
    assert.deepEqual((await inspectOther()).windows, beforeOther);
  },
);

test(
  "an ambiguous Rex create is not retried and the child's own ready file recovers its ID",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const shim = join(f.dir, "forget-create-reply");
    writeFileSync(
      shim,
      `#!/bin/sh
for arg do
  if [ "$arg" = session.new_window ]; then
    rex "$@" >/dev/null || exit "$?"
    printf '{'
    exit
  fi
done
exec rex "$@"
`,
      { mode: 0o700 },
    );
    const host = new Host({ ...f.options, rex: shim });
    t.after(() => host.shutdown(true));
    await host.start();
    const run = await host.launch({ ...model, task: "SLOW_CHILD", cwd: f.cwd });
    assert.equal(run.phase, "uncertain");
    assert.equal(run.terminal, null);
    const terminal = await until(
      () => host.runs.get(run.id)?.terminal,
      "child-owned block ID",
    );
    assert.ok(terminal);
    assert.equal((await f.inspect()).windows.length, 2);
    assert.equal((await host.cancel(run.id)).confirmed, true);
    const report = await until(() => f.results[0], "cancellation result");
    assert.equal(report.result.outcome, "cancelled");
    assert.deepEqual(
      (await f.blocks()).map((b) => b.block_id),
      [f.parent],
    );
  },
);

test(
  "Escape aborts generation without closing Pi; reload recovers it; cancel leaves an unrelated split",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const host = await f.host(true);
    const run = await host.launch({ ...model, task: "SLOW_CHILD", cwd: f.cwd });
    assert.ok(run.terminal && run.window);
    await until(
      () => host.runs.get(run.id)?.status === "working",
      "Rex program status",
    );
    await until(() => f.requests.length > 0, "live provider request");
    await host.interrupt(run.id);
    await until(() => f.aborted() === 1, "Pi aborted the ongoing request");
    assert.equal(f.results.length, 0);
    assert.ok((await f.blocks()).some((b) => b.block_id === run.terminal));
    const split = JSON.parse(
      await f.rex(
        "split",
        "-s",
        f.session,
        "-b",
        run.terminal,
        "--split=right",
        "--focus=false",
        "--shell=none",
        "--json",
        "--",
        ...keeper,
      ),
    ).block_ids[0];
    await host.shutdown(true);
    const recovered = await f.host();
    assert.equal(recovered.runs.get(run.id)?.terminal, run.terminal);
    assert.equal(recovered.runs.get(run.id)?.phase, "interrupted");
    assert.equal((await recovered.cancel(run.id)).confirmed, true);
    const report = await until(() => f.results[0], "cancel result");
    assert.equal(report.result.outcome, "cancelled");
    const ids = (await f.blocks()).map((b) => b.block_id);
    assert.ok(ids.includes(f.parent) && ids.includes(split));
    assert.ok(!ids.includes(run.terminal));
    assert.equal((await f.inspect()).active_window_id, f.parentWindow);
    await recovered.acknowledge(run.id);
    await recovered.shutdown(true);
    const again = await f.host();
    assert.equal(again.active, false);
    assert.equal(f.results.length, 1);
  },
);

test(
  "retained quick startup failure is reported; wrong parent IDs fail closed",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const invalid = new Host({
      ...f.options,
      parent: "block:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    });
    await assert.rejects(invalid.start(), /not a local terminal/);
    const host = new Host({
      ...f.options,
      config: parseConfig({
        piCommand: [process.execPath, "-e", "process.exit(7)"],
      }),
    });
    t.after(() => host.shutdown(true));
    await host.start();
    await host.launch({ ...model, task: "Do not start Pi", cwd: f.cwd });
    const result = (await until(() => f.results[0], "startup failure")).result;
    assert.equal(result.outcome, "failed");
    assert.match(result.text, /without a result/);
  },
);

test(
  "a published report waits for Rex exit, including after supervision reload",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const config = parseConfig({
      piCommand: [
        process.execPath,
        "-e",
        `
    const { writeFileSync } = require("node:fs");
    const dir = process.env.PI_REXLINGS_RUN_DIR;
    writeFileSync(dir + "/result.json", JSON.stringify({
      version: 1, id: dir.split("/").pop(), outcome: "completed", text: "Saved before exit", session: null,
    }));
    setInterval(() => {}, 10000);
  `,
        "--",
      ],
    });
    const first = new Host({ ...f.options, config });
    t.after(() => first.shutdown(true));
    await first.start();
    const run = await first.launch({
      ...model,
      task: "Held child",
      cwd: f.cwd,
    });
    assert.ok(run.terminal);
    await until(() => {
      try {
        return readFileSync(join(first.root, run.id, "result.json"), "utf8");
      } catch {
        return undefined;
      }
    }, "report published before exit");
    await first.shutdown(true);

    const recovered = await f.host();
    assert.equal(f.results.length, 0);
    assert.equal(recovered.active, true);
    await f.rex("block", "close", "-s", f.session, run.terminal);
    const { result } = await until(
      () => f.results[0],
      "report after block exit",
    );
    assert.equal(result.outcome, "completed");
    assert.equal(result.text, "Saved before exit");
    await recovered.acknowledge(run.id);
    await recovered.shutdown(true);
    await f.host();
    assert.equal(f.results.length, 1);
  },
);
