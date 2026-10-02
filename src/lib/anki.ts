// Gateway logic for the Anki MCP add-on running in the "anki" container.
// Kept free of DB/framework imports so the filtering rules can be unit-tested.

/**
 * Tools that are never exposed:
 * - note type / template changes force Anki into a full sync, which opens a modal
 *   dialog and would freeze the headless instance,
 * - GUI tools drive windows nobody sees.
 * Extend with ANKI_BLOCKED_TOOLS (comma-separated exact names).
 */
const BLOCKED_PATTERNS: RegExp[] = [/model/i, /template/i, /note_?type/i, /^gui/i];

// Read-only note type lookups (AnkiMCP add-on names) are needed to create notes and are harmless.
const ALWAYS_ALLOWED = new Set(["model_names", "model_field_names", "model_styling", "model_templates"]);

export function blockedToolNames(): Set<string> {
  return new Set(
    (process.env.ANKI_BLOCKED_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function isBlockedTool(name: string, extra: Set<string> = blockedToolNames()): boolean {
  if (extra.has(name)) return true;
  if (ALWAYS_ALLOWED.has(name)) return false;
  return BLOCKED_PATTERNS.some((re) => re.test(name));
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
  result?: { tools?: { name: string }[] } & Record<string, unknown>;
}

/** Removes blocked tools from a tools/list result (in place); returns how many were removed. */
export function filterToolList(msg: JsonRpcMessage, extra?: Set<string>): number {
  const tools = msg.result?.tools;
  if (!Array.isArray(tools)) return 0;
  const kept = tools.filter((t) => !isBlockedTool(t.name, extra));
  msg.result!.tools = kept;
  return tools.length - kept.length;
}

/** Short, content-free description of a tool call for the audit log. */
export function describeCall(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const parts: string[] = [];
  for (const key of ["deck", "deckName", "deck_name", "query"]) {
    const v = args[key];
    if (typeof v === "string") parts.push(`${key}=${v.slice(0, 80)}`);
  }
  for (const key of ["notes", "noteIds", "notes_ids", "cards", "cardIds"]) {
    const v = args[key];
    if (Array.isArray(v)) parts.push(`${key}: ${v.length}`);
  }
  if (!parts.length) parts.push(`args: ${Object.keys(args).slice(0, 8).join(",")}`);
  return parts.join(" ");
}

/** Rewrites tools/list results inside an SSE stream, line by line. */
export function sseToolFilter(extra?: Set<string>): TransformStream<Uint8Array, Uint8Array> {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";
  const rewrite = (line: string) => {
    if (!line.startsWith("data:")) return line;
    const payload = line.slice(5).trimStart();
    try {
      const msg = JSON.parse(payload) as JsonRpcMessage;
      if (filterToolList(msg, extra) > 0) return `data: ${JSON.stringify(msg)}`;
    } catch {
      /* not JSON: pass through */
    }
    return line;
  };
  return new TransformStream({
    transform(chunk, controller) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      if (lines.length) controller.enqueue(enc.encode(lines.map(rewrite).join("\n") + "\n"));
    },
    flush(controller) {
      if (buf) controller.enqueue(enc.encode(rewrite(buf)));
    },
  });
}

export type { JsonRpcMessage };
