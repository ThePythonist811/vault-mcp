import { and, desc, eq, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { proposals, type Proposal } from "@/lib/db/schema";
import { appBaseUrl, hiddenFolders, ntfyUrl, proposalTtlSeconds, vaultRoot, writableFolders } from "@/lib/config";
import { applyChange, prepareChange, type ChangeRequest, type VaultOptions } from "@/lib/vault";
import { audit } from "@/lib/audit";

export function vaultOptions(): VaultOptions {
  return { root: vaultRoot(), hidden: hiddenFolders(), writable: writableFolders() };
}

export async function createProposal(
  req: ChangeRequest,
  reason: string,
  client: { id: string; name: string | null },
): Promise<Proposal> {
  const prepared = await prepareChange(req, vaultOptions());
  const [row] = await db
    .insert(proposals)
    .values({
      kind: prepared.kind,
      path: prepared.path,
      baseHash: prepared.baseHash,
      newContent: prepared.newContent,
      diff: prepared.diff,
      reason: reason.slice(0, 1000),
      clientId: client.id,
      clientName: client.name,
      expiresAt: new Date(Date.now() + proposalTtlSeconds() * 1000),
    })
    .returning();
  void notifyNewProposal(row);
  return row;
}

async function notifyNewProposal(p: Proposal) {
  const url = ntfyUrl();
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        Title: "Vault: neuer Änderungsvorschlag",
        Click: `${appBaseUrl()}/proposals#${p.id}`,
        Tags: "memo",
      },
      // Only the path and kind leave the server; never the content.
      body: `${p.kind}: ${p.path}`,
    });
  } catch (e) {
    console.error("ntfy notification failed:", e instanceof Error ? e.message : e);
  }
}

export async function expireOldProposals(): Promise<void> {
  await db
    .update(proposals)
    .set({ status: "expired", decidedAt: new Date() })
    .where(and(eq(proposals.status, "pending"), lt(proposals.expiresAt, new Date())));
}

export async function getProposal(id: string): Promise<Proposal | null> {
  const [row] = await db.select().from(proposals).where(eq(proposals.id, id)).limit(1);
  return row ?? null;
}

export async function listProposals(status?: Proposal["status"], limit = 50): Promise<Proposal[]> {
  await expireOldProposals();
  const q = db.select().from(proposals);
  return (status ? q.where(eq(proposals.status, status)) : q).orderBy(desc(proposals.createdAt)).limit(limit);
}

/**
 * Approve = apply to the vault. The status flip happens first and only from
 * 'pending', so a double click or two tabs can never apply the same proposal twice.
 */
export async function decideProposal(
  id: string,
  decision: "approve" | "reject",
  clerkUserId: string,
): Promise<Proposal> {
  await expireOldProposals();
  const actor = `user:${clerkUserId}`;
  const [claimed] = await db
    .update(proposals)
    .set({ status: decision === "approve" ? "applied" : "rejected", decidedAt: new Date() })
    .where(and(eq(proposals.id, id), eq(proposals.status, "pending")))
    .returning();
  if (!claimed) throw new Error("Vorschlag ist nicht (mehr) offen");

  if (decision === "reject") {
    await audit({ actor, action: "proposal.reject", path: claimed.path, detail: id, ok: true });
    return claimed;
  }

  try {
    await applyChange(claimed, vaultOptions());
    await audit({ actor, action: "proposal.apply", path: claimed.path, detail: `${claimed.kind} ${id}`, ok: true });
    return claimed;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const [failed] = await db
      .update(proposals)
      .set({ status: "failed", error: msg })
      .where(eq(proposals.id, id))
      .returning();
    await audit({ actor, action: "proposal.apply", path: claimed.path, detail: `${id}: ${msg}`, ok: false });
    return failed;
  }
}
