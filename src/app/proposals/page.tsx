import { Shell, Guard } from "@/components/Shell";
import { getViewer } from "@/lib/auth/clerk";
import { listProposals } from "@/lib/proposals";
import type { Proposal } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

const KIND: Record<Proposal["kind"], string> = {
  create: "Neue Notiz",
  replace: "Komplett ersetzen",
  edit: "Bearbeiten",
  append: "Anhängen",
  delete: "Gelöscht (Papierkorb)",
  move: "Verschoben",
};

const STATUS: Record<Proposal["status"], string> = {
  pending: "offen",
  applied: "übernommen",
  rejected: "abgelehnt",
  expired: "abgelaufen",
  failed: "fehlgeschlagen",
};

function Diff({ text }: { text: string }) {
  // Skip the ===/---/+++ file header; the interesting part starts at the first hunk.
  const all = text.split("\n");
  const lines = all.slice(Math.max(0, all.findIndex((l) => l.startsWith("@@"))));
  return (
    <pre className="diff">
      {lines.map((l, i) => (
        <span
          key={i}
          className={
            l.startsWith("+")
              ? "diff-add"
              : l.startsWith("-")
                ? "diff-del"
                : l.startsWith("@@")
                  ? "diff-hunk"
                  : undefined
          }
        >
          {l + "\n"}
        </span>
      ))}
    </pre>
  );
}

function ProposalCard({ p }: { p: Proposal }) {
  return (
    <div className="card stack" id={p.id}>
      <div className="row row-between">
        <strong style={{ wordBreak: "break-all" }}>{p.path}</strong>
        <span className={`badge ${p.status === "pending" ? "badge-soft" : p.status === "applied" ? "badge-success" : p.status === "failed" ? "badge-danger" : "badge-muted"}`}>
          {STATUS[p.status]}
        </span>
      </div>
      <div className="muted" style={{ fontSize: 13 }}>
        {KIND[p.kind]} · {p.clientName ?? p.clientId} · {p.createdAt.toLocaleString("de-DE", { timeZone: "Europe/Berlin" })}
      </div>
      <p>{p.reason}</p>
      {p.error && <div className="alert alert-error">{p.error}</div>}
      <Diff text={p.diff} />
      {p.status === "pending" && (
        <form method="post" action={`/api/proposals/${p.id}`} className="row">
          <button className="btn btn-primary" name="decision" value="approve">Übernehmen</button>
          <button className="btn btn-danger" name="decision" value="reject">Ablehnen</button>
        </form>
      )}
    </div>
  );
}

export default async function ProposalsPage() {
  const viewer = await getViewer();
  const all = viewer.state === "ok" ? await listProposals(undefined, 100) : [];
  const pending = all.filter((p) => p.status === "pending");
  const done = all.filter((p) => p.status !== "pending").slice(0, 30);

  return (
    <Shell>
      <Guard viewer={viewer}>
        <div className="stack-lg stack">
          <h2>Offene Vorschläge ({pending.length})</h2>
          <p className="muted" style={{ fontSize: 13 }}>Unten im Verlauf stehen auch alle Änderungen, die Claude mit Schreibrecht direkt vorgenommen hat.</p>
          {pending.length === 0 && <p className="muted">Nichts offen.</p>}
          {pending.map((p) => <ProposalCard key={p.id} p={p} />)}
          {done.length > 0 && <h3>Verlauf</h3>}
          {done.map((p) => <ProposalCard key={p.id} p={p} />)}
        </div>
      </Guard>
    </Shell>
  );
}
