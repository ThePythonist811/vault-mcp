import { desc } from "drizzle-orm";
import { Shell, Guard } from "@/components/Shell";
import { getViewer } from "@/lib/auth/clerk";
import { db } from "@/lib/db";
import { auditLog, oauthClients } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

export default async function ActivityPage() {
  const viewer = await getViewer();
  const ok = viewer.state === "ok";
  const rows = ok ? await db.select().from(auditLog).orderBy(desc(auditLog.at)).limit(200) : [];
  const clients = ok ? await db.select({ id: oauthClients.id, name: oauthClients.name }).from(oauthClients) : [];
  const names = new Map(clients.map((c) => [`client:${c.id}`, c.name ?? c.id]));

  return (
    <Shell>
      <Guard viewer={viewer}>
        <div className="stack-lg stack">
          <div className="row row-between">
            <h2>Aktivität</h2>
            <form method="post" action="/api/connections">
              <button className="btn btn-danger btn-sm" name="action" value="revoke-all">
                Alle Verbindungen trennen
              </button>
            </form>
          </div>
          <p className="muted" style={{ fontSize: 13 }}>
            Jeder Zugriff wird hier protokolliert (ohne Notizinhalte). Die letzten 200 Einträge.
          </p>
          <div className="card" style={{ overflowX: "auto" }}>
            <table className="log">
              <thead>
                <tr><th>Zeit</th><th>Wer</th><th>Aktion</th><th>Pfad</th><th>Details</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={r.ok ? undefined : "log-fail"}>
                    <td>{r.at.toLocaleString("de-DE", { timeZone: "Europe/Berlin" })}</td>
                    <td>{names.get(r.actor) ?? (r.actor.startsWith("user:") ? "Du" : r.actor)}</td>
                    <td><code>{r.action}</code></td>
                    <td>{r.path}</td>
                    <td>{r.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Guard>
    </Shell>
  );
}
