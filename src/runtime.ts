import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const sources = ["launch.ts", "child.ts", "artifacts.ts", "config.ts"];

export function runtimeBundle(): { digest: string; payload: string } {
  const payload = JSON.stringify(
    sources.map((name) =>
      readFileSync(new URL(name, import.meta.url)).toString("base64"),
    ),
  );
  if (Buffer.byteLength(payload) > 64 * 1024)
    throw new Error("Rexlings runtime exceeds its argv budget");
  return {
    digest: createHash("sha256").update(payload).digest("hex"),
    payload,
  };
}

// This function has no imports or closures: Rex starts it before the bundle exists.
async function bootstrap(names: string[]) {
  const fs = require("node:fs") as typeof import("node:fs");
  const { createHash, randomUUID } =
    require("node:crypto") as typeof import("node:crypto");
  const { join, resolve } = require("node:path") as typeof import("node:path");
  const { homedir } = require("node:os") as typeof import("node:os");
  const { pathToFileURL } = require("node:url") as typeof import("node:url");
  const [digest, mode, id, arg, payload] = process.argv.slice(1);
  if (
    !digest ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    !id ||
    !arg ||
    (mode !== "launch" && mode !== "read")
  )
    throw new Error("Invalid Rexlings runtime request");
  const hash = (text: string) =>
    createHash("sha256").update(text).digest("hex");
  if (
    mode === "launch" &&
    (!payload || hash(payload) !== digest || arg !== process.env.REX_SESSION)
  )
    throw new Error("Runtime bundle or Rex destination does not match");

  const profile = resolve(
    process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
  );
  const state = join(profile, "rexlings");
  const root = join(state, "runtime");
  const directory = join(root, digest);
  if (mode === "launch")
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  for (const path of [state, root, directory]) {
    if (mode === "launch") {
      try {
        fs.mkdirSync(path, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const info = fs.lstatSync(path);
    if (
      !info.isDirectory() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    )
      throw new Error(`Rexlings runtime directory is not private: ${path}`);
  }

  const expected =
    mode === "launch" ? (JSON.parse(payload!) as string[]) : undefined;
  const actual = names.map((name, i) => {
    const path = join(directory, name);
    if (expected && !fs.existsSync(path)) {
      const pending = join(directory, `.install-${randomUUID()}`);
      fs.writeFileSync(pending, Buffer.from(expected[i]!, "base64"), {
        mode: 0o600,
        flag: "wx",
      });
      try {
        fs.linkSync(pending, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      } finally {
        fs.unlinkSync(pending);
      }
    }
    const info = fs.lstatSync(path);
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      info.size > 64 * 1024
    )
      throw new Error(`Invalid Rexlings runtime file: ${path}`);
    return fs.readFileSync(path).toString("base64");
  });
  if (hash(JSON.stringify(actual)) !== digest)
    throw new Error(
      "Installed Rexlings runtime has changed; refusing to run it",
    );
  // Keep Pi's local TypeScript loader out of the code sent to the host.
  const load = new Function("url", "return import(url)") as (
    url: string,
  ) => Promise<{ main: (args: string[]) => Promise<void> }>;
  const { main } = await load(pathToFileURL(join(directory, names[0]!)).href);
  await main([mode, id, arg]);
}

export const nixRuntimeStarting = "Rexlings is starting Nix Node";
export const runtimeStartupMs = 120_000;

const selectRuntime = `
if command -v node >/dev/null 2>&1 && node -e 'if (typeof process.execve !== "function" || !process.features.typescript) process.exit(1)' >/dev/null 2>&1; then
  exec node -e "$@"
elif command -v bun >/dev/null 2>&1; then
  exec bun -e "$@"
elif ! command -v node >/dev/null 2>&1 && command -v nix >/dev/null 2>&1 && command -v nix-shell >/dev/null 2>&1; then
  printf '%s\\n' '${nixRuntimeStarting}'
  export REXLINGS_EVAL="$1" REXLINGS_DIGEST="$3" REXLINGS_MODE="$4" REXLINGS_ID="$5" REXLINGS_ARG="$6" REXLINGS_PAYLOAD="\${7-}"
  exec nix-shell -p nodejs --run '
    set -- "$REXLINGS_EVAL" -- "$REXLINGS_DIGEST" "$REXLINGS_MODE" "$REXLINGS_ID" "$REXLINGS_ARG" "$REXLINGS_PAYLOAD"
    unset REXLINGS_EVAL REXLINGS_DIGEST REXLINGS_MODE REXLINGS_ID REXLINGS_ARG REXLINGS_PAYLOAD
    exec node -e "$@"
  '
fi
printf '%s\\n' 'Rexlings needs Node 22.18+ or Bun; when neither is installed, it can use nix-shell -p nodejs.' >&2
exit 1
`;

export function runtimeCommand(
  digest: string,
  mode: "launch" | "read",
  id: string,
  arg: string,
  payload?: string,
): string[] {
  const code = `(${bootstrap.toString()})(${JSON.stringify(sources)}).catch(error => { console.error(error.message); process.exitCode = 1; });`;
  return [
    "/bin/sh",
    "-c",
    selectRuntime,
    "rexlings",
    code,
    "--",
    digest,
    mode,
    id,
    arg,
    ...(payload ? [payload] : []),
  ];
}
