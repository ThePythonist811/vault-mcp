# vault-mcp

Selbst gehosteter **remote MCP-Server**, der einem AI-Client (Claude, Claude Code, …)
Lese- und kontrollierten Schreibzugriff auf einen **Obsidian-Vault** gibt – plus einen
Gateway zu einem **headless Anki**-Container. Läuft als Docker-Stack, zum Beispiel auf
einem Raspberry Pi im Heimnetz, erreichbar über eine dedizierte Tailscale-Node mit
Funnel auf 443.

Authentifiziert über **OAuth 2.1 (PKCE)** mit **Clerk** als Identity Provider.
Keine Notizinhalte verlassen den Server, nichts wird geloggt, was Inhalt betrifft.

---

## Warum nicht einfach `mcp-obsidian`?

Die vorhandenen Obsidian-MCP-Server sind meist lokal, unauthentifiziert und dürfen
**direkt schreiben**. Hier ist das Gegenteil der Fall:

| Eigenschaft | Umsetzung |
|---|---|
| Remote statt localhost | Dedizierte Tailscale-Node `vault`, Funnel auf `443` |
| Auth | OAuth 2.1 + PKCE, dynamische Client-Registrierung, Consent-Seite |
| Wer darf rein | Allowlist mit Clerk-User-IDs – leer = niemand |
| Schreiben | Standard ist **Proposal**: Vorschlag mit Diff → Mensch gibt frei |
| Audit | Jede Aktion in Postgres, immer mit Pfad, nie mit Inhaltskontext |
| Isolation | Container read-only, keine published DB, dedizierte Netzwerke |

---

## Architektur

```
Claude / Claude Code
   │  OAuth 2.1 (PKCE S256)          Streamable HTTP
   ▼                                        │
┌────────────────────────────── Tailscale Funnel (443) ─┐
│  app  (Next.js 15, node:22-alpine)                    │
│                                                        │
│  /api/mcp                 Vault-Tools (Streamable HTTP)│
│  /api/anki/mcp            Anki-Gateway (Proxied JSON-RPC)
│  /api/oauth/*             register · authorize · token · revoke
│  /.well-known/*           OAuth-Protected-Resource, AS-Metadaten
│  /connect /consent /proposals /activity   Web-UI        │
└──────┬──────────────────────────────┬──────────────────┘
       │ network: internal           │ network: anki (internal)
       ▼                              ▼
  postgres:16                    anki (headless Anki +
  (nicht published)               AnkiConnect + AnkiMCP)
                                        │ network: anki-egress
                                        ▼  (festes Subnetz,
                                     nur AnkiWeb-Sync,
                                     Firewall gegen LAN/Tailnet/Pi)
```

**Stack:** Next.js 15 (App Router) · TypeScript · PostgreSQL 16 + Drizzle ORM ·
`@modelcontextprotocol/sdk` · Clerk · Tailscale · Docker Compose.

---

## Container & Netzwerke

`docker-compose.yml` definiert vier Netze, jedes mit klarer Aufgabe:

| Netz | Zweck |
|---|---|
| `internal` | app ↔ postgres. Kein Publish auf den Host. |
| `egress` | Nur der Tailscale-Sidecar braucht Internet. |
| `anki` | app ↔ anki. Nie nach außen exponiert. |
| `anki-egress` | Festes Subnetz `172.30.99.0/24`. `anki/firewall/` blockt den Container am Zugriff auf LAN, Tailnet und den Pi selbst. |

Ports: App gebunden auf `127.0.0.1:17484` (nur lokal auf dem Host erreichbar), DB gar
nicht published. Extern erreichbar ausschließlich über den Tailscale-Sidecar
(`tailscale/serve.json`, dedizierte Node, Funnel auf 443).

---

## Authentifizierung & Autorisierung

Zwei geschützte Ressourcen, Tokens gelten nie für beide (`Target = "vault" | "anki"`):

1. **Anmeldung am Server selbst** – Clerk-Login, danach **Allowlist-Prüfung**
   (`ALLOWED_CLERK_USER_IDS`). Leer = niemand wird eingelassen.
2. **OAuth-Client** (Claude etc.) – dynamische Registrierung unter
   `/api/oauth/register`, max. 100 Clients.
   - **Authorize** mit PKCE `S256`, Auth-Code läuft nach 5 Minuten ab,
     Redirect-URI gegen Allowlist (Claude-Hosted-Callbacks + optional `localhost`-Loopback).
   - **Consent-Seite** zeigt Client, Scope und Ziel; der CSRF-Schutz ist ein HMAC über
     (User, Client, Redirect, Challenge, Ablaufzeit) – ein Cross-Site-POST kann ihn
     weder fälschen noch wiederverwenden.
   - **Token-Endpunkt** akzeptiert PKCE-Code oder Client-`Basic`-Auth; in der DB liegen
     nur SHA-256-Hashes von Access- und Refresh-Token.
   - **Wichtig:** Das vom Client angefragte Scope wird *nicht* vertraut. Verliehen wird
     das, was der Mensch auf der Consent-Seite gewählt hat, `vault:read` immer dazu.

**Scopes**

| Scope | Bedeutung |
|---|---|
| `vault:read` | lesen, suchen, Backlinks |
| `vault:propose` | Vorschläge anlegen (Standardstufe) |
| `vault:write` | direkte Writes ohne Freigabe |
| `anki:full` | Anki-Gateway |

---

## Schreibmodell: Proposals

Standard ist die Stufe `propose`. Ein `propose_*`-Tool erzeugt keine Datei, sondern
einen **Proposal**:

1. `prepareChange()` normalisiert den Pfad (versteckte/gelesene/schreibbare Ordner,
   Extension-Whitelist), prüft den Base-Hash der existierenden Datei und erzeugt einen
   Unified Diff.
2. Der Proposal landet in Postgres mit Pfad, Diff, Grund, Client und Ablaufdatum;
   optional kommt ein **ntfy-Push** (nur Pfad und Art, nie Inhalt).
3. Unter `/proposals` entscheidet der Mensch: annehmen → `applyChange()`, ablehnen.
4. Beides landet im selben Audit-Log wie direkte Writes.

Direkte Writes (`write_note`, `edit_note`, `append_to_note`, `delete_note`, `move_note`)
setzen die Scope-Stufe `vault:write` voraus.

**Read-only-Ordner** (`VAULT_READONLY_FOLDERS`, z. B. `Excalidraw/Scripts`) sind lesbar,
aber nie schreibbar – für Ordner, deren Notizen Plugins als Code ausführen.

---

## Vault-Zugriff

Alles, was den Vault anfasst, läuft über `src/lib/vault.ts`
(`resolveForRead` / `resolveForWrite`). Der Rest der App berührt das Dateisystem nicht.

- Pfade immer **vault-relativ**, `realpath` gegen Symlink-Ausbruch
- Extensions `.md` / `.canvas` / `.txt`
- Limits: 1 MB pro Read, 500 KB pro Write
- Schreiben atomar: Temp-Datei (`.vault-mcp-*`, in `.stglobalignore` für Syncthing)
  + `rename`
- Löschen = verschieben nach Obsidians `.trash`, also wiederherstellbar
- Versteckte Ordner (`VAULT_HIDDEN_FOLDERS`) sind unsichtbar, auch in `list_notes` und Suche

---

## Anki-Gateway

`/api/anki/mcp` ist ein eigener MCP-Endpunkt, der JSON-RPC an den
headless-Anki-Container weiterreicht. Drei Mann davor:

1. **Scope-Check** – nur `anki:full`.
2. **Tool-Blocklist** im Gateway (`src/app/api/anki/mcp/route.ts`) plus eine zweite
   in `ANKI_MCP_DISABLED_TOOLS` im Container (GUI-, Modell- und Deck-Befehle).
3. **Audit** – jeder Call mit Name und Argument-Zusammenfassung, blockierte Calls
   ebenfalls.

Der Container selbst hat kein publishtes Port und liegt nur auf Netz `anki`.
VNC (einmaliger AnkiWeb-Login) ist standardmäßig aus und wird nur gezielt über einen
SSH-Tunnel freigegeben. Ein `systemd`-Timer synct alle 5 Minuten mit AnkiWeb.

---

## Sicherheitsmodell (Kurzliste)

- App-Container: `read_only`, `cap_drop: ALL`, `no-new-privileges`, `tmpfs` für
  Cache und `/tmp`
- Postgres nur im internen Netz, kein Host-Port
- App nur auf `127.0.0.1:17484`
- Anki in eigenem Netz mit Egress-Firewall gegen LAN/Tailnet/Pi
- App-Rootfs read-only, nur der Vault-Mount ist rw (Writes brauchen das);
  UID/GID des Containers passen zum Syncthing-Owner auf dem Host
- Audit-Log speichert Pfade und Metadaten, **nie** Notizinhalte
- Secrets nur in `.env` (gitignored), `.env.example` enthält Platzhalter

---

## Setup

```bash
cp .env.example .env      # Werte eintragen
docker compose up -d --build
```

Für `NEXT_PUBLIC_*` beim Build die echten Werte mitgeben (siehe `Dockerfile`-Args).
Danach die App-URL als Tailscale-Node mit Funnel erreichbar machen
(`tailscale/serve.json`).

Lokal entwickeln:

```bash
npm ci
npm run typecheck
npm test                  # node --test, braucht kein echtes Postgres
npm run dev
```

---

## Herkunft & Lizenzen

- **Eigener Code**, MIT-lizenziert (siehe `LICENSE`).
- **Architektur und Gerüst** (Next.js-Struktur, Clerk-Auth, OAuth-Routen,
  Consent-Seite, MCP-Endpunkt, DB-Schema) sind von
  **[cldt-fr/imap-mcp](https://github.com/cldt-fr/imap-mcp)** von
  *Clément de Louvencourt* abgeleitet – MIT. Danke für die Vorlage.
  Alles Vault-/Proposal-/Anki-spezifische ist neu entstanden.
- **`anki/`** ist aus **[tkober/anki-headless-mcp](https://github.com/tkober/anki-headless-mcp)**
  (Commit `8d37894`, **AGPL-3.0**) übernommen und vor Verwendung geprüft: Die Skripte
  legen nur das Profil an, installieren die Add-ons und schreiben deren Netzwerkconfig.
  Basis-Bild: `ghcr.io/ankimcp/headless-anki`.
  **Die MIT-Lizenz des Root-Verzeichnisses gilt nicht für `anki/`** – für dieses
  Verzeichnis gilt AGPL-3.0.
