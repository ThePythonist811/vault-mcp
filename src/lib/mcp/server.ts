import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { appBaseUrl, readOnlyFolders, writableFolders } from "@/lib/config";
import { hasScope, SCOPE_PROPOSE, SCOPE_WRITE } from "@/lib/auth/oauth";
import { createProposal, getProposal, listProposals, recordDirectWrite, vaultOptions } from "@/lib/proposals";
import {
  backlinks,
  listFolders,
  listNotes,
  readNote,
  recentNotes,
  searchNotes,
  VaultError,
  moveNote,
  trashNote,
  writeChange,
  type PreparedChange,
  type ChangeRequest,
} from "@/lib/vault";

export interface McpContext {
  userId: string;
  clientId: string;
  clientName: string | null;
  scope: string;
}

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err: unknown) {
  // Vault errors are safe to show; anything else stays generic so internals don't leak.
  const msg = err instanceof VaultError ? err.message : "internal error";
  if (!(err instanceof VaultError)) console.error(err);
  return { isError: true as const, content: [{ type: "text" as const, text: msg }] };
}

const READ = { readOnlyHint: true, openWorldHint: false } as const;
// Proposals do not modify the vault by themselves, but they are not read-only either.
const PROPOSE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

// Direct writes change the vault, but nothing is lost for good (trash + versions on the Pi).
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

const notePath = z
  .string()
  .min(1)
  .max(500)
  .describe('Vault-relative path including extension, e.g. "Projekte/Idee.md"');
const reason = z
  .string()
  .min(3)
  .max(1000)
  .describe("Short explanation for the human reviewer: what changes and why");

export function buildMcpServer(ctx: McpContext): McpServer {
  const canWrite = hasScope(ctx.scope, SCOPE_WRITE);
  const canPropose = !canWrite && hasScope(ctx.scope, SCOPE_PROPOSE);
  const writable = writableFolders();
  const readOnly = readOnlyFolders();
  const server = new McpServer(
    { name: "vault-mcp", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Access to the user's Obsidian vault (Markdown notes, [[wikilinks]], YAML frontmatter). " +
        "Paths are vault-relative and include the extension. Start with vault_overview or search_notes.\n\n" +
        (canWrite
          ? "WRITING — You have direct write access. Changes take effect immediately and sync to all of the " +
            "user's devices within seconds; every change is logged with a diff. Always read a note before changing " +
            "it and pass its sha256 as expected_sha256 so you never overwrite edits made on another device. Prefer " +
            "edit_note / append_to_note over write_note for existing notes, keep the user's formatting and language, " +
            "and tell the user what you changed. delete_note moves the note to Obsidian's trash. move_note does not " +
            "update [[wikilinks]] in other notes. Hidden folders (starting with '.') cannot be written." +
            (readOnly.length ? ` These folders are read-only: ${readOnly.join(", ")}.` : "")
          : canPropose
          ? "WRITING — You cannot change the vault directly. propose_* tools create a change proposal that " +
            "the user reviews and approves at " + `${appBaseUrl()}/proposals` + ". Nothing is written until approved. " +
            "Prefer propose_edit_note / propose_append_to_note over replacing whole notes. Always read a note before " +
            "proposing changes to it, keep the user's formatting and language, and tell the user that a proposal " +
            "awaits approval. Deleting and moving notes is not possible." +
            (writable.length ? ` Proposals are only accepted for these folders: ${writable.join(", ")}.` : "")
          : "This connection is read-only."),
    },
  );

  const actor = `client:${ctx.clientId}`;

  async function run<T>(tool: string, auditPath: string | null, fn: () => Promise<T>) {
    try {
      const data = await fn();
      await audit({ actor, action: `tool.${tool}`, path: auditPath, ok: true });
      return jsonResult(data);
    } catch (e) {
      await audit({
        actor,
        action: `tool.${tool}`,
        path: auditPath,
        detail: e instanceof Error ? e.message : String(e),
        ok: false,
      });
      return errorResult(e);
    }
  }

  // --- Read -------------------------------------------------------------------------

  server.registerTool(
    "vault_overview",
    {
      title: "Vault overview",
      description: "List all folders of the vault with the number of notes in each.",
      inputSchema: {},
      annotations: READ,
    },
    async () => run("vault_overview", null, async () => ({ folders: await listFolders(vaultOptions()) })),
  );

  server.registerTool(
    "list_notes",
    {
      title: "List notes",
      description: "List notes in a folder (recursively by default) with size and last-modified time.",
      inputSchema: {
        folder: z.string().max(500).optional().describe("Vault-relative folder; omit for the whole vault"),
        recursive: z.boolean().optional().describe("Include subfolders (default true)"),
        limit: z.number().int().min(1).max(1000).optional().describe("Max entries (default 200)"),
      },
      annotations: READ,
    },
    async ({ folder, recursive, limit }) =>
      run("list_notes", folder ?? "/", () => listNotes(vaultOptions(), folder ?? "", recursive ?? true, limit ?? 200)),
  );

  server.registerTool(
    "read_note",
    {
      title: "Read note",
      description: "Read a note's full content. Also returns its sha256 and last-modified time.",
      inputSchema: { path: notePath },
      annotations: READ,
    },
    async ({ path }) => run("read_note", path, () => readNote(path, vaultOptions())),
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description:
        "Case-insensitive full-text search over note names and contents. Returns matching paths with up to 3 matching lines each.",
      inputSchema: {
        query: z.string().min(2).max(200),
        folder: z.string().max(500).optional().describe("Restrict to this folder"),
        limit: z.number().int().min(1).max(100).optional().describe("Max notes (default 20)"),
      },
      annotations: READ,
    },
    async ({ query, folder, limit }) =>
      run("search_notes", folder ?? "/", async () => ({
        results: await searchNotes(query, vaultOptions(), folder ?? "", limit ?? 20),
      })),
  );

  server.registerTool(
    "recent_notes",
    {
      title: "Recently modified notes",
      description: "Notes sorted by last modification, newest first.",
      inputSchema: { limit: z.number().int().min(1).max(100).optional().describe("Default 20") },
      annotations: READ,
    },
    async ({ limit }) => run("recent_notes", null, async () => ({ notes: await recentNotes(vaultOptions(), limit ?? 20) })),
  );

  server.registerTool(
    "get_backlinks",
    {
      title: "Backlinks",
      description: "Find notes that link to the given note via [[wikilinks]].",
      inputSchema: { path: notePath },
      annotations: READ,
    },
    async ({ path }) => run("get_backlinks", path, async () => ({ backlinks: await backlinks(path, vaultOptions()) })),
  );

  if (canWrite) {
    registerWriteTools();
    return server;
  }
  if (!canPropose) return server;

  // --- Direct writes (scope vault:write) -----------------------------------------------

  function registerWriteTools() {
    const expected = z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
      .describe("sha256 from read_note; the write fails if the note changed since then");
    const note = z.string().max(300).optional().describe("Optional short note for the change log");

    async function write(tool: string, auditPath: string, why: string | undefined, fn: () => Promise<PreparedChange>) {
      return run(tool, auditPath, async () => {
        const change = await fn();
        const rec = await recordDirectWrite(change, why ?? tool, { id: ctx.clientId, name: ctx.clientName });
        return { ok: true, kind: change.kind, path: change.path, change_id: rec.id, diff: change.diff };
      });
    }

    server.registerTool(
      "write_note",
      {
        title: "Create or overwrite note",
        description:
          "Create a note, or replace the whole content of an existing one. For existing notes prefer edit_note and pass expected_sha256.",
        inputSchema: { path: notePath, content: z.string().max(400_000), expected_sha256: expected, change_note: note },
        annotations: WRITE,
      },
      async ({ path, content, expected_sha256, change_note }) =>
        write("write_note", path, change_note, async () => {
          const exists = await readNote(path, vaultOptions()).then(() => true, () => false);
          return writeChange({ kind: exists ? "replace" : "create", path, content }, vaultOptions(), expected_sha256);
        }),
    );

    server.registerTool(
      "edit_note",
      {
        title: "Edit note",
        description:
          "Exact search-and-replace edits in an existing note. Each old_text must occur exactly once; edits are applied in order.",
        inputSchema: {
          path: notePath,
          edits: z
            .array(z.object({ old_text: z.string().min(1).max(50_000), new_text: z.string().max(50_000) }))
            .min(1)
            .max(50),
          expected_sha256: expected,
          change_note: note,
        },
        annotations: WRITE,
      },
      async ({ path, edits, expected_sha256, change_note }) =>
        write("edit_note", path, change_note, () =>
          writeChange({ kind: "edit", path, edits }, vaultOptions(), expected_sha256),
        ),
    );

    server.registerTool(
      "append_to_note",
      {
        title: "Append to note",
        description: "Append text to the end of an existing note (a newline is inserted if needed).",
        inputSchema: { path: notePath, text: z.string().min(1).max(100_000), change_note: note },
        annotations: WRITE,
      },
      async ({ path, text, change_note }) =>
        write("append_to_note", path, change_note, () => writeChange({ kind: "append", path, text }, vaultOptions())),
    );

    server.registerTool(
      "delete_note",
      {
        title: "Delete note (to trash)",
        description: "Move a note to Obsidian's .trash folder. It can be restored from there.",
        inputSchema: { path: notePath, expected_sha256: expected, change_note: note },
        annotations: { ...WRITE, destructiveHint: true },
      },
      async ({ path, expected_sha256, change_note }) =>
        write("delete_note", path, change_note, () => trashNote(path, vaultOptions(), expected_sha256)),
    );

    server.registerTool(
      "move_note",
      {
        title: "Move or rename note",
        description: "Move or rename a note. The target must not exist. Does not rewrite [[wikilinks]] in other notes.",
        inputSchema: { from: notePath, to: notePath, change_note: note },
        annotations: WRITE,
      },
      async ({ from, to, change_note }) =>
        write("move_note", `${from} → ${to}`, change_note, () => moveNote(from, to, vaultOptions())),
    );
  }

  // --- Proposals (nothing is written until the user approves) -------------------------

  async function propose(tool: string, req: ChangeRequest, why: string) {
    return run(tool, req.path, async () => {
      const p = await createProposal(req, why, { id: ctx.clientId, name: ctx.clientName });
      return {
        proposal_id: p.id,
        status: p.status,
        path: p.path,
        review_url: `${appBaseUrl()}/proposals#${p.id}`,
        expires_at: p.expiresAt.toISOString(),
        diff: p.diff,
        note: "Not applied yet. Tell the user to review and approve it at review_url.",
      };
    });
  }

  server.registerTool(
    "propose_create_note",
    {
      title: "Propose new note",
      description: "Propose creating a new Markdown note. Fails if the note already exists.",
      inputSchema: { path: notePath, content: z.string().max(400_000), reason },
      annotations: PROPOSE,
    },
    async ({ path, content, reason: why }) => propose("propose_create_note", { kind: "create", path, content }, why),
  );

  server.registerTool(
    "propose_edit_note",
    {
      title: "Propose targeted edit",
      description:
        "Propose exact search-and-replace edits to an existing note. Each old_text must occur exactly once in the current note; edits are applied in order.",
      inputSchema: {
        path: notePath,
        edits: z
          .array(z.object({ old_text: z.string().min(1).max(50_000), new_text: z.string().max(50_000) }))
          .min(1)
          .max(50),
        reason,
      },
      annotations: PROPOSE,
    },
    async ({ path, edits, reason: why }) => propose("propose_edit_note", { kind: "edit", path, edits }, why),
  );

  server.registerTool(
    "propose_append_to_note",
    {
      title: "Propose append",
      description: "Propose appending text to the end of an existing note (a newline is inserted if needed).",
      inputSchema: { path: notePath, text: z.string().min(1).max(100_000), reason },
      annotations: PROPOSE,
    },
    async ({ path, text, reason: why }) => propose("propose_append_to_note", { kind: "append", path, text }, why),
  );

  server.registerTool(
    "propose_replace_note",
    {
      title: "Propose full rewrite",
      description: "Propose replacing the entire content of an existing note. Prefer propose_edit_note for small changes.",
      inputSchema: { path: notePath, content: z.string().max(400_000), reason },
      annotations: PROPOSE,
    },
    async ({ path, content, reason: why }) => propose("propose_replace_note", { kind: "replace", path, content }, why),
  );

  server.registerTool(
    "get_proposal",
    {
      title: "Proposal status",
      description: "Check whether a proposal is pending, applied, rejected, expired or failed.",
      inputSchema: { proposal_id: z.string().uuid() },
      annotations: READ,
    },
    async ({ proposal_id }) =>
      run("get_proposal", null, async () => {
        const p = await getProposal(proposal_id);
        if (!p) throw new VaultError("proposal not found");
        return { id: p.id, status: p.status, kind: p.kind, path: p.path, error: p.error, created_at: p.createdAt };
      }),
  );

  server.registerTool(
    "list_pending_proposals",
    {
      title: "Pending proposals",
      description: "List proposals that still await the user's decision.",
      inputSchema: {},
      annotations: READ,
    },
    async () =>
      run("list_pending_proposals", null, async () => ({
        proposals: (await listProposals("pending")).map((p) => ({
          id: p.id,
          kind: p.kind,
          path: p.path,
          reason: p.reason,
          created_at: p.createdAt,
        })),
      })),
  );

  return server;
}
