import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyChange,
  backlinks,
  listNotes,
  normalizeRel,
  prepareChange,
  readNote,
  searchNotes,
  VaultError,
  type VaultOptions,
} from "../src/lib/vault.ts";

async function fixture(extra: Partial<VaultOptions> = {}) {
  const base = await mkdtemp(path.join(tmpdir(), "vault-test-"));
  const root = path.join(base, "vault");
  await mkdir(path.join(root, ".obsidian"), { recursive: true });
  await mkdir(path.join(root, "Notizen"), { recursive: true });
  await mkdir(path.join(root, "Privat"), { recursive: true });
  await writeFile(path.join(root, ".obsidian", "app.json"), "{}");
  await writeFile(path.join(root, "Notizen", "A.md"), "# A\nsiehe [[B]] und [[Ordner/C|alias]]\n");
  await writeFile(path.join(root, "Notizen", "B.md"), "# B\nHallo Welt\n");
  await writeFile(path.join(root, "Privat", "Geheim.md"), "geheim Welt");
  await writeFile(path.join(base, "outside.md"), "outside");
  const opts: VaultOptions = { root, hidden: ["Privat"], writable: [], ...extra };
  return { base, root, opts, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test("normalizeRel rejects traversal and dot segments", () => {
  assert.equal(normalizeRel("/Notizen//A.md"), "Notizen/A.md");
  assert.equal(normalizeRel("Notizen\\A.md"), "Notizen/A.md");
  for (const bad of ["../x.md", "Notizen/../../x.md", ".obsidian/app.json", "Notizen/.hidden.md", "a\0b.md"]) {
    assert.throws(() => normalizeRel(bad), VaultError, bad);
  }
});

test("reading respects hidden folders, extensions and symlinks", async () => {
  const f = await fixture();
  try {
    assert.equal((await readNote("Notizen/B.md", f.opts)).content, "# B\nHallo Welt\n");
    await assert.rejects(readNote("Privat/Geheim.md", f.opts), VaultError);
    await assert.rejects(readNote("privat/Geheim.md", f.opts), VaultError); // case variant
    await assert.rejects(readNote(".obsidian/app.json", f.opts), VaultError);
    await assert.rejects(readNote("../outside.md", f.opts), VaultError);
    await symlink(path.join(f.base, "outside.md"), path.join(f.root, "Notizen", "link.md"));
    await assert.rejects(readNote("Notizen/link.md", f.opts), /escapes the vault/);
    await symlink(f.base, path.join(f.root, "Notizen", "dirlink"));
    await assert.rejects(readNote("Notizen/dirlink/outside.md", f.opts), /escapes the vault/);
  } finally {
    await f.cleanup();
  }
});

test("listing and search never expose hidden or dot folders", async () => {
  const f = await fixture();
  try {
    const { notes } = await listNotes(f.opts);
    assert.deepEqual(notes.map((n) => n.path), ["Notizen/A.md", "Notizen/B.md"]);
    const hits = await searchNotes("welt", f.opts);
    assert.deepEqual(hits.map((h) => h.path), ["Notizen/B.md"]);
    await assert.rejects(listNotes(f.opts, "Privat"), VaultError);
    const bl = await backlinks("B.md", f.opts);
    assert.deepEqual(bl.map((b) => b.path), ["Notizen/A.md"]);
  } finally {
    await f.cleanup();
  }
});

test("prepare + apply edit, with optimistic concurrency", async () => {
  const f = await fixture();
  try {
    const p = await prepareChange(
      { kind: "edit", path: "Notizen/B.md", edits: [{ old_text: "Hallo Welt", new_text: "Hallo Vault" }] },
      f.opts,
    );
    assert.match(p.diff, /-Hallo Welt/);
    assert.match(p.diff, /\+Hallo Vault/);
    // Nothing written yet.
    assert.equal(await readFile(path.join(f.root, "Notizen/B.md"), "utf8"), "# B\nHallo Welt\n");
    await applyChange(p, f.opts);
    assert.equal(await readFile(path.join(f.root, "Notizen/B.md"), "utf8"), "# B\nHallo Vault\n");

    // A second proposal based on an outdated version must be refused, not overwrite.
    const stale = await prepareChange({ kind: "append", path: "Notizen/B.md", text: "x" }, f.opts);
    await writeFile(path.join(f.root, "Notizen/B.md"), "changed on another device\n");
    await assert.rejects(applyChange(stale, f.opts), /changed since the proposal/);
    assert.equal(await readFile(path.join(f.root, "Notizen/B.md"), "utf8"), "changed on another device\n");
  } finally {
    await f.cleanup();
  }
});

test("edit requires a unique match", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, "Notizen/D.md"), "x\nx\n");
    await assert.rejects(
      prepareChange({ kind: "edit", path: "Notizen/D.md", edits: [{ old_text: "x", new_text: "y" }] }, f.opts),
      /more than once/,
    );
    await assert.rejects(
      prepareChange({ kind: "edit", path: "Notizen/D.md", edits: [{ old_text: "zzz", new_text: "y" }] }, f.opts),
      /not found/,
    );
  } finally {
    await f.cleanup();
  }
});

test("create: new folders allowed, no clobbering, write policy enforced", async () => {
  const f = await fixture({ writable: ["Notizen"] });
  try {
    const c = await prepareChange({ kind: "create", path: "Notizen/Neu/E.md", content: "neu" }, f.opts);
    await applyChange(c, f.opts);
    assert.equal(await readFile(path.join(f.root, "Notizen/Neu/E.md"), "utf8"), "neu");
    await assert.rejects(
      prepareChange({ kind: "create", path: "Notizen/A.md", content: "x" }, f.opts),
      /already exists/,
    );
    await assert.rejects(prepareChange({ kind: "create", path: "Root.md", content: "x" }, f.opts), /only allowed in/);
    await assert.rejects(prepareChange({ kind: "create", path: "Privat/X.md", content: "x" }, f.opts), /not accessible/);
    await assert.rejects(prepareChange({ kind: "create", path: "Notizen/x.sh", content: "x" }, f.opts), /only allowed for/);
    await assert.rejects(
      prepareChange({ kind: "create", path: ".obsidian/plugins/evil.md", content: "x" }, f.opts),
      VaultError,
    );

    // A file that appears between proposal and approval is not overwritten.
    const race = await prepareChange({ kind: "create", path: "Notizen/F.md", content: "von Claude" }, f.opts);
    await writeFile(path.join(f.root, "Notizen/F.md"), "vom Handy");
    await assert.rejects(applyChange(race, f.opts), /created in the meantime/);
    assert.equal(await readFile(path.join(f.root, "Notizen/F.md"), "utf8"), "vom Handy");
  } finally {
    await f.cleanup();
  }
});

test("writes through a symlinked folder are refused", async () => {
  const f = await fixture();
  try {
    await symlink(f.base, path.join(f.root, "Notizen", "escape"));
    await assert.rejects(
      prepareChange({ kind: "create", path: "Notizen/escape/pwned.md", content: "x" }, f.opts),
      /escapes the vault/,
    );
  } finally {
    await f.cleanup();
  }
});

test("read-only folders (plugin scripts) can be read but never written", async () => {
  const f = await fixture({ readOnly: ["Excalidraw/Scripts"] });
  try {
    await mkdir(path.join(f.root, "Excalidraw", "Scripts"), { recursive: true });
    await writeFile(path.join(f.root, "Excalidraw", "Scripts", "s.md"), "script");
    assert.equal((await readNote("Excalidraw/Scripts/s.md", f.opts)).content, "script");
    await assert.rejects(
      prepareChange({ kind: "create", path: "Excalidraw/Scripts/evil.md", content: "x" }, f.opts),
      /read-only/,
    );
    await assert.rejects(
      prepareChange({ kind: "append", path: "excalidraw/scripts/s.md", text: "x" }, f.opts),
      /read-only/,
    );
    await prepareChange({ kind: "create", path: "Excalidraw/Zeichnung.md", content: "ok" }, f.opts);
  } finally {
    await f.cleanup();
  }
});
