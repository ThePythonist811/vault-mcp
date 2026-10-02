import { Shell, Guard } from "@/components/Shell";
import { getViewer } from "@/lib/auth/clerk";
import { validateAuthorizeParams } from "@/lib/auth/authorize";
import { signConsent } from "@/lib/auth/oauth";

export const dynamic = "force-dynamic";

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const get = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : null);
  const viewer = await getViewer();
  const v = await validateAuthorizeParams(get);

  return (
    <Shell>
      <div className="container-narrow">
        <Guard viewer={viewer}>
          {!v.ok ? (
            <div className="alert alert-error">Ungültige Anfrage: {v.error}</div>
          ) : (
            <div className="card stack">
              <h2>{v.params.target === "anki" ? "Zugriff auf deine Anki-Sammlung erlauben?" : "Zugriff auf deinen Vault erlauben?"}</h2>
              <p>
                <strong>{v.params.clientName ?? "Unbenannter Client"}</strong> möchte auf {v.params.target === "anki" ? "deine Anki-Sammlung" : "deinen Obsidian-Vault"}{" "}
                zugreifen.
              </p>
              <p className="muted" style={{ fontSize: 13 }}>
                Rückleitung an: <code>{new URL(v.params.redirectUri).origin}</code>
                <br />
                Client-ID: <code>{v.params.clientId}</code>
              </p>
              <div className="alert alert-warning" style={{ fontSize: 13 }}>
                Nur erlauben, wenn du diese Verbindung gerade selbst gestartet hast.
              </div>
              <form method="post" action="/api/oauth/authorize" className="stack">
                {[
                  ["client_id", v.params.clientId],
                  ["redirect_uri", v.params.redirectUri],
                  ["code_challenge", v.params.codeChallenge],
                  ["code_challenge_method", "S256"],
                  ["response_type", "code"],
                  ["state", v.params.state],
                  ["scope", v.params.scope ?? ""],
                  ["resource", v.params.resource ?? ""],
                ].map(([name, value]) => (
                  <input key={name} type="hidden" name={name} value={value} />
                ))}
                {viewer.state === "ok" && (
                  <input
                    type="hidden"
                    name="consent_token"
                    value={signConsent({
                      userId: viewer.userId,
                      clientId: v.params.clientId,
                      redirectUri: v.params.redirectUri,
                      codeChallenge: v.params.codeChallenge,
                      target: v.params.target,
                    })}
                  />
                )}
                {v.params.target === "anki" ? (
                  <>
                    <strong>Berechtigung: Vollzugriff auf Anki</strong>
                    <p className="muted" style={{ fontSize: 13 }}>
                      Karten und Decks lesen, anlegen, bearbeiten und löschen, Lernsitzungen, Statistiken, Sync mit
                      AnkiWeb. Gesperrt bleiben Kartenmodelle/Vorlagen und GUI-Steuerung. Jeder Aufruf wird
                      protokolliert.
                    </p>
                  </>
                ) : (
                  <>
                  <strong>Berechtigung für diese Verbindung</strong>
                  <label className="checkbox-row">
                    <input type="radio" name="access" value="read" /> Nur lesen und durchsuchen
                  </label>
                  <label className="checkbox-row">
                    <input type="radio" name="access" value="propose" /> Lesen + Änderungen vorschlagen (jede muss
                    einzeln freigegeben werden)
                  </label>
                  <label className="checkbox-row">
                    <input type="radio" name="access" value="write" defaultChecked /> Lesen + direkt schreiben
                    (anlegen, ändern, verschieben, in den Papierkorb löschen; alles wird protokolliert)
                  </label>
                  </>
                )}
                <div className="row">
                  <button className="btn btn-primary" name="decision" value="allow">Erlauben</button>
                  <button className="btn" name="decision" value="deny">Ablehnen</button>
                </div>
              </form>
            </div>
          )}
        </Guard>
      </div>
    </Shell>
  );
}
