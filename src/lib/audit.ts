import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";

/** Records an action. Never pass note contents here — only paths and short metadata. */
export async function audit(entry: {
  actor: string;
  action: string;
  path?: string | null;
  detail?: string | null;
  ok: boolean;
}): Promise<void> {
  try {
    await db.insert(auditLog).values({
      actor: entry.actor,
      action: entry.action,
      path: entry.path ?? null,
      detail: entry.detail?.slice(0, 500) ?? null,
      ok: entry.ok,
    });
  } catch (e) {
    // Auditing must not break the request, but a failure must be visible in the container log.
    console.error("audit insert failed:", e instanceof Error ? e.message : e);
  }
}
