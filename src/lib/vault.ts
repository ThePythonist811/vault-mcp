// Filesystem access to the Obsidian vault. Every path coming from a client goes
// through resolveForRead / resolveForWrite; nothing else in the app touches the
// vault directly. Kept free of DB/framework imports so it can be unit-tested.

import { createHash, randomBytes } from "node:crypto";
import { constants as fsc } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";

export interface VaultOptions {
  root: string;
  /** Vault-relative folders that are invisible to clients. */
  hidden: string[];
  /** Vault-relative folders proposals may target; empty = all visible folders. */
  writable: string[];
}

export class VaultError extends Error {}

const READ_EXT = new Set([".md", ".canvas", ".txt"]);
const WRITE_EXT = new Set([".md"]);
const MAX_READ_BYTES = 1_000_000;
const MAX_WRITE_BYTES = 500_000;
/** Temp files for atomic writes; listed in .stglobalignore so Syncthing skips them. */
const TMP_PREFIX = ".vault-mcp-";

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Turns client input into a clean vault-relative path, or throws.
 * Rejects traversal, NUL bytes and any dot-segment (.obsidian, .stversions, .trash, ...).
 */
export function normalizeRel(input: string): string {
  if (typeof input !== "string") throw new VaultError("path must be a string");
  if (input.includes("\0")) throw new VaultError("invalid path");
  const parts = input
    .replace(/\\/g, "/")
    .trim()
    .split("/")
    .filter((s) => s !== "" && s !== ".");
  for (const seg of parts) {
    if (seg === "..") throw new VaultError("path traversal is not allowed");
    if (seg.startsWith(".")) throw new VaultError("hidden files and folders are not accessible");
  }
  return parts.join("/");
}

function within(rel: string, folder: string): boolean {
  const r = rel.toLowerCase();
  const f = folder.toLowerCase();
  return f === "" || r === f || r.startsWith(f + "/");
}

function isHidden(rel: string, opts: VaultOptions): boolean {
  return opts.hidden.some((h) => h !== "" && within(rel, h));
}

function isWritable(rel: string, opts: VaultOptions): boolean {
  if (opts.writable.length === 0) return true;
  return opts.writable.some((w) => within(rel, w === "." ? "" : w));
}

async function realRoot(opts: VaultOptions): Promise<string> {
  return realpath(opts.root);
}

/** Confirms `abs` (after resolving symlinks) is inside the vault root. */
async function assertInside(abs: string, root: string): Promise<void> {
  const real = await realpath(abs);
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new VaultError("path escapes the vault");
  }
}

function checkExt(rel: string, allowed: Set<string>, verb: string) {
  const ext = path.extname(rel).toLowerCase();
  if (!allowed.has(ext)) {
    throw new VaultError(`${verb} is only allowed for ${[...allowed].join(", ")} files`);
  }
}

export async function resolveForRead(input: string, opts: VaultOptions) {
  const rel = normalizeRel(input);
  if (!rel) throw new VaultError("path is empty");
  if (isHidden(rel, opts)) throw new VaultError("not found");
  checkExt(rel, READ_EXT, "reading");
  const root = await realRoot(opts);
  const abs = path.join(root, rel);
  try {
    await assertInside(abs, root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new VaultError("not found");
    throw e;
  }
  return { rel, abs, root };
}

export async function resolveForWrite(input: string, opts: VaultOptions) {
  const rel = normalizeRel(input);
  if (!rel) throw new VaultError("path is empty");
  if (isHidden(rel, opts)) throw new VaultError("this folder is not accessible");
  if (!isWritable(rel, opts)) {
    throw new VaultError(`writes are only allowed in: ${opts.writable.join(", ")}`);
  }
  checkExt(rel, WRITE_EXT, "writing");
  const root = await realRoot(opts);
  const abs = path.join(root, rel);
  // The nearest existing ancestor must be inside the vault (blocks symlinked folders).
  let probe = path.dirname(abs);
  for (;;) {
    try {
      await assertInside(probe, root);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      probe = path.dirname(probe);
    }
  }
  // If the file itself exists it must be a regular file, not a symlink.
  const st = await lstat(abs).catch(() => null);
  if (st && !st.isFile()) throw new VaultError("target is not a regular file");
  return { rel, abs, root };
}

export interface NoteMeta {
  path: string;
  size: number;
  modified: string;
}

async function walk(
  dirAbs: string,
  dirRel: string,
  opts: VaultOptions,
  out: NoteMeta[],
  recursive: boolean,
  limit: number,
) {
  if (out.length >= limit) return;
  const entries = await readdir(dirAbs, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (out.length >= limit) return;
    if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
    const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
    if (isHidden(rel, opts)) continue;
    if (e.isDirectory()) {
      if (recursive) await walk(path.join(dirAbs, e.name), rel, opts, out, recursive, limit);
    } else if (e.isFile() && READ_EXT.has(path.extname(e.name).toLowerCase())) {
      const st = await stat(path.join(dirAbs, e.name));
      out.push({ path: rel, size: st.size, modified: st.mtime.toISOString() });
    }
  }
}

export async function listNotes(
  opts: VaultOptions,
  folder = "",
  recursive = true,
  limit = 500,
): Promise<{ notes: NoteMeta[]; truncated: boolean }> {
  const rel = normalizeRel(folder);
  if (rel && isHidden(rel, opts)) throw new VaultError("not found");
  const root = await realRoot(opts);
  const abs = path.join(root, rel);
  await assertInside(abs, root).catch(() => {
    throw new VaultError("folder not found");
  });
  const notes: NoteMeta[] = [];
  await walk(abs, rel, opts, notes, recursive, limit + 1);
  return { notes: notes.slice(0, limit), truncated: notes.length > limit };
}

export async function listFolders(opts: VaultOptions): Promise<{ folder: string; notes: number }[]> {
  const { notes } = await listNotes(opts, "", true, 100_000);
  const counts = new Map<string, number>();
  for (const n of notes) {
    const dir = path.posix.dirname(n.path);
    const key = dir === "." ? "" : dir;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([folder, n]) => ({ folder: folder || "/", notes: n }));
}

export async function readNote(input: string, opts: VaultOptions) {
  const { rel, abs } = await resolveForRead(input, opts);
  const st = await stat(abs).catch(() => null);
  if (!st || !st.isFile()) throw new VaultError("not found");
  if (st.size > MAX_READ_BYTES) throw new VaultError("note is too large to read");
  const buf = await readFile(abs);
  return {
    path: rel,
    content: buf.toString("utf8"),
    sha256: sha256(buf),
    modified: st.mtime.toISOString(),
    size: st.size,
  };
}

async function currentHash(abs: string): Promise<{ hash: string | null; content: string | null }> {
  try {
    const buf = await readFile(abs);
    return { hash: sha256(buf), content: buf.toString("utf8") };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { hash: null, content: null };
    throw e;
  }
}

export async function searchNotes(
  query: string,
  opts: VaultOptions,
  folder = "",
  limit = 20,
): Promise<{ path: string; matches: string[] }[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) throw new VaultError("query must be at least 2 characters");
  const { notes } = await listNotes(opts, folder, true, 100_000);
  const root = await realRoot(opts);
  const results: { path: string; matches: string[] }[] = [];
  for (const n of notes) {
    if (results.length >= limit) break;
    if (n.size > MAX_READ_BYTES) continue;
    const text = await readFile(path.join(root, n.path), "utf8");
    const nameHit = n.path.toLowerCase().includes(q);
    const lines = text.split("\n");
    const matches: string[] = [];
    for (let i = 0; i < lines.length && matches.length < 3; i++) {
      if (lines[i].toLowerCase().includes(q)) matches.push(`L${i + 1}: ${lines[i].trim().slice(0, 200)}`);
    }
    if (nameHit || matches.length) results.push({ path: n.path, matches });
  }
  return results;
}

export async function recentNotes(opts: VaultOptions, limit = 20): Promise<NoteMeta[]> {
  const { notes } = await listNotes(opts, "", true, 100_000);
  return notes.sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, limit);
}

/** Notes that link to `target` via [[wikilink]] (matches by note name, ignoring folder and .md). */
export async function backlinks(target: string, opts: VaultOptions): Promise<{ path: string; lines: string[] }[]> {
  const name = path.posix.basename(normalizeRel(target)).replace(/\.md$/i, "").toLowerCase();
  if (!name) throw new VaultError("target is empty");
  const re = /\[\[([^\]|#^]+)/g;
  const { notes } = await listNotes(opts, "", true, 100_000);
  const root = await realRoot(opts);
  const out: { path: string; lines: string[] }[] = [];
  for (const n of notes) {
    if (!n.path.endsWith(".md") || n.size > MAX_READ_BYTES) continue;
    const text = await readFile(path.join(root, n.path), "utf8");
    const lines = text.split("\n").filter((line) =>
      [...line.matchAll(re)].some(
        (m) => path.posix.basename(m[1].trim()).replace(/\.md$/i, "").toLowerCase() === name,
      ),
    );
    if (lines.length) out.push({ path: n.path, lines: lines.slice(0, 5).map((l) => l.trim().slice(0, 200)) });
  }
  return out;
}

// --- Proposals ---------------------------------------------------------------------

export type ChangeRequest =
  | { kind: "create"; path: string; content: string }
  | { kind: "replace"; path: string; content: string }
  | { kind: "edit"; path: string; edits: { old_text: string; new_text: string }[] }
  | { kind: "append"; path: string; text: string };

export interface PreparedChange {
  kind: ChangeRequest["kind"];
  path: string;
  baseHash: string | null;
  newContent: string;
  diff: string;
}

/** Validates a change against the current file and computes the result + diff. Writes nothing. */
export async function prepareChange(req: ChangeRequest, opts: VaultOptions): Promise<PreparedChange> {
  const { rel, abs } = await resolveForWrite(req.path, opts);
  const cur = await currentHash(abs);
  let newContent: string;

  switch (req.kind) {
    case "create":
      if (cur.hash !== null) throw new VaultError("note already exists; use propose_replace_note or propose_edit_note");
      newContent = req.content;
      break;
    case "replace":
      if (cur.content === null) throw new VaultError("note does not exist; use propose_create_note");
      newContent = req.content;
      break;
    case "append":
      if (cur.content === null) throw new VaultError("note does not exist; use propose_create_note");
      newContent = cur.content + (cur.content === "" || cur.content.endsWith("\n") ? "" : "\n") + req.text;
      break;
    case "edit": {
      if (cur.content === null) throw new VaultError("note does not exist; use propose_create_note");
      if (!req.edits.length) throw new VaultError("no edits given");
      let text = cur.content;
      for (const [i, e] of req.edits.entries()) {
        if (!e.old_text) throw new VaultError(`edit ${i + 1}: old_text is empty`);
        const first = text.indexOf(e.old_text);
        if (first < 0) throw new VaultError(`edit ${i + 1}: old_text not found`);
        if (text.indexOf(e.old_text, first + 1) >= 0) {
          throw new VaultError(`edit ${i + 1}: old_text occurs more than once; include more context`);
        }
        text = text.slice(0, first) + e.new_text + text.slice(first + e.old_text.length);
      }
      newContent = text;
      break;
    }
  }

  if (Buffer.byteLength(newContent, "utf8") > MAX_WRITE_BYTES) throw new VaultError("resulting note is too large");
  if (cur.content !== null && newContent === cur.content) throw new VaultError("the change would not modify the note");

  const diff = createTwoFilesPatch(
    cur.content === null ? "/dev/null" : `a/${rel}`,
    `b/${rel}`,
    cur.content ?? "",
    newContent,
    "",
    "",
    { context: 3 },
  );
  return { kind: req.kind, path: rel, baseHash: cur.hash, newContent, diff };
}

/**
 * Applies an approved change. Refuses if the file changed since the proposal
 * (e.g. edited on another device and synced in meanwhile) instead of overwriting.
 */
export async function applyChange(
  p: { path: string; baseHash: string | null; newContent: string },
  opts: VaultOptions,
): Promise<string> {
  const { abs } = await resolveForWrite(p.path, opts);
  const cur = await currentHash(abs);
  if (cur.hash !== p.baseHash) {
    throw new VaultError(
      p.baseHash === null
        ? "a note with this name was created in the meantime"
        : "the note was changed since the proposal was made",
    );
  }
  const dir = path.dirname(abs);
  await mkdir(dir, { recursive: true });
  // Re-check after mkdir: the created folder chain must still be inside the vault.
  await assertInside(dir, await realRoot(opts));

  const tmp = path.join(dir, `${TMP_PREFIX}${randomBytes(6).toString("hex")}.tmp`);
  const fh = await open(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, 0o644);
  try {
    await fh.writeFile(p.newContent, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    if (p.baseHash === null) {
      // Create must never clobber a file that appeared in the last instant.
      const exists = await lstat(abs).catch(() => null);
      if (exists) throw new VaultError("a note with this name was created in the meantime");
    }
    await rename(tmp, abs);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  return sha256(p.newContent);
}
