import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/extension.ts";

test("normal profile discovery does not register a delegation host inside a child", () => {
  const previous = process.env.PI_REXLINGS_RUN_DIR;
  process.env.PI_REXLINGS_RUN_DIR = "/child-run";
  let accesses = 0;
  try {
    extension(
      new Proxy({} as ExtensionAPI, {
        get() {
          accesses++;
          throw new Error("Child must not register a parent host");
        },
      }),
    );
    assert.equal(accesses, 0);
  } finally {
    if (previous === undefined) delete process.env.PI_REXLINGS_RUN_DIR;
    else process.env.PI_REXLINGS_RUN_DIR = previous;
  }
});

test("a Rex block enables the parent without a REX_SESSION variable", () => {
  const { REX_SESSION, REX_BLOCK, PI_REXLINGS_RUN_DIR } = process.env;
  delete process.env.REX_SESSION;
  delete process.env.PI_REXLINGS_RUN_DIR;
  process.env.REX_BLOCK = "block:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const commands: string[] = [];
  try {
    extension({
      registerCommand: (name: string) => commands.push(name),
      registerMessageRenderer() {},
      registerTool() {},
      on() {},
    } as unknown as ExtensionAPI);
    assert.deepEqual(commands, ["rexlings"]);
  } finally {
    for (const [key, value] of Object.entries({
      REX_SESSION,
      REX_BLOCK,
      PI_REXLINGS_RUN_DIR,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
