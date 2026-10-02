import { test } from "node:test";
import assert from "node:assert/strict";
import { describeCall, filterToolList, isBlockedTool, sseToolFilter } from "../src/lib/anki.ts";

test("note type, template and GUI tools are blocked; normal tools pass", () => {
  // Names as reported by the AnkiMCP add-on's tools/list.
  for (const n of ["create_model", "model_fields", "update_model_styling", "update_model_templates", "change_note_type", "gui_browse", "gui_add_cards", "gui_undo"]) {
    assert.equal(isBlockedTool(n), true, n);
  }
  for (const n of ["add_note", "add_notes", "find_notes", "notes_info", "delete_notes", "list_decks", "sync", "model_names", "model_field_names", "model_styling", "model_templates", "rate_card", "set_fsrs_params", "tag_management"]) {
    assert.equal(isBlockedTool(n), false, n);
  }
  assert.equal(isBlockedTool("delete_notes", new Set(["delete_notes"])), true);
});

test("tools/list results are filtered", () => {
  const msg = { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "add_note" }, { name: "gui_browse" }, { name: "create_model" }] } };
  assert.equal(filterToolList(msg), 2);
  assert.deepEqual(msg.result.tools.map((t) => t.name), ["add_note"]);
});

test("audit description has no card content", () => {
  const d = describeCall({ deckName: "Bio", notes: [{ front: "geheim", back: "x" }, {}] });
  assert.equal(d, "deckName=Bio notes: 2");
  assert.ok(!d.includes("geheim"));
});

test("SSE stream is rewritten even when split across chunks", async () => {
  const event = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "add_note" }, { name: "gui_browse" }] } })}\n\n`;
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
  assert.ok(out.includes('"add_note"'));
  assert.ok(!out.includes("gui_browse"));
  assert.ok(out.startsWith("event: message\ndata: "));
});
