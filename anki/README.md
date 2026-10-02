# Headless Anki for vault-mcp

Vendored from https://github.com/tkober/anki-headless-mcp at commit 8d37894
(AGPL-3.0), reviewed before use: the scripts only seed the profile, install the
AnkiConnect (2055492159) and AnkiMCP (124672614) add-ons from AnkiWeb and write
their network config. Base image: ghcr.io/ankimcp/headless-anki (amd64/arm64).

The container is only reachable from the vault-mcp app on an internal network.
The app is the only way in: it checks OAuth tokens (scope `anki:full`), filters
blocked tools and writes the audit log before proxying to the add-on.
