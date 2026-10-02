import { test } from "node:test";
import assert from "node:assert/strict";
import { describeCall, filterToolList, isBlockedTool, sseToolFilter } from "../src/lib/anki.ts";

test("note type, template and GUI tools are blocked; normal tools pass", () => {
  for (const n of ["createModel", "updateModelTemplates", "modelTemplateAdd", "modelFieldRemove", "guiBrowse", "guiAddCards", "updateModelStyling"]) {
    assert.equal(isBlockedTool(n), true, n);
  }
  for (const n of ["addNote", "addNotes", "findNotes", "notesInfo", "deleteNotes", "deckNames", "sync", "modelNames", "modelFieldNames", "getDueCards", "answerCards"]) {
    assert.equal(isBlockedTool(n), false, n);
  }
  assert.equal(isBlockedTool("deleteNotes", new Set(["deleteNotes"])), true);
});

test("tools/list results are filtered", () => {
  const msg = { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "addNote" }, { name: "guiBrowse" }, { name: "createModel" }] } };
  assert.equal(filterToolList(msg), 2);
  assert.deepEqual(msg.result.tools.map((t) => t.name), ["addNote"]);
});

test("audit description has no card content", () => {
  const d = describeCall({ deckName: "Bio", notes: [{ front: "geheim", back: "x" }, {}] });
  assert.equal(d, "deckName=Bio notes: 2");
  assert.ok(!d.includes("geheim"));
});

test("SSE stream is rewritten even when split across chunks", async () => {
  const event = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "addNote" }, { name: "guiBrowse" }] } })}\n\n`;
  const enc = new TextEncoder();
  const half = Math.floor(event.length / 2);
  const src = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(event.slice(0, half)));
      c.enqueue(enc.encode(event.slice(half)));
      c.close();
    },
  });
  const out = await new Response(src.pipeThrough(sseToolFilter())).text();
  assert.ok(out.includes('"addNote"'));
  assert.ok(!out.includes("guiBrowse"));
  assert.ok(out.startsWith("event: message\ndata: "));
});
