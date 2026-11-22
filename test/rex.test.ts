import assert from "node:assert/strict";
import test from "node:test";
import { parseEvent } from "../src/rex.ts";

test("Rex event routing uses the enclosing session and full block ID", () => {
  const session = "session:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const block = "block:aaaaaaaa-bbbb-cccc-dddd-ffffffffffff";
  const event = (type: string, payload: object) => ({
    type: "session_event",
    payload: { session_id: session, event: { type, payload } },
  });
  const status = event("block_event", {
    creator_name: "com.superlogical.terminal",
    name: "program_status_changed",
    block_id: block,
    payload: { record: { state: "working" } },
  });
  assert.deepEqual(parseEvent(status, session), {
    kind: "status",
    block,
    state: "working",
  });
  assert.deepEqual(
    parseEvent(event("block_closed", { block_id: block }), session),
    {
      kind: "exit",
      block,
    },
  );
  for (const value of [
    status.payload.event,
    event("block_closed", { block_id: "ffee" }),
    event("block_event", {
      creator_name: "a.third.party.block",
      name: "child_exited",
      block_id: block,
    }),
  ])
    assert.equal(parseEvent(value, session), undefined);
  assert.equal(parseEvent(status, "unrelated-session"), undefined);
});
