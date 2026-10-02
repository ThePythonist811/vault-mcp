# Headless Anki with AnkiConnect + MCP server, packaged for a bind-mounted
# Unraid appdata share.
#
# Upstream ships an "addons" variant, but only as a local build — it is never
# pushed to GHCR (see https://github.com/ankimcp/headless-anki, "local only").
# So we build it here. On top of the upstream recipe this image adds the three
# things a bind-mounted deployment needs:
#
#   1. Addons live in /opt/anki-addons, not /data/addons21. A bind mount over
#      /data hides anything the image baked into that path, which would silently
#      remove both addons and the pre-seeded profile. The entrypoint seeds /data
#      at runtime instead.
#   2. Addon network config is applied at runtime from the environment, so the
#      MCP server binds beyond loopback and accepts the Unraid host header.
#   3. Optional VNC password — upstream runs -SecurityTypes None.
ARG X11_TAG=ghcr.io/ankimcp/headless-anki:x11-vnc-v1.5.0
FROM ${X11_TAG}

# AnkiConnect + AnkiMCP server. Space-separated AnkiWeb addon IDs.
ARG ADDON_IDS="2055492159 124672614"
# Fallback only: the real version is read from the installed Anki below.
ARG ANKI_VERSION=26.8.1

LABEL org.opencontainers.image.source="https://github.com/tkober/anki-headless-mcp" \
      org.opencontainers.image.description="Headless Anki with AnkiConnect and MCP server for Unraid" \
      org.opencontainers.image.licenses="AGPL-3.0"

# gosu: drop to PUID/PGID in the entrypoint. jq: patch addon config at runtime.
# tigervnc-tools: vncpasswd — tigervnc-common no longer ships it on Debian 13.
RUN apt-get update && apt-get install --no-install-recommends -y \
        gosu jq tigervnc-tools \
    && rm -rf /var/lib/apt/lists/*

# Download addons into /opt — NOT /data, which a bind mount would hide.
# The AnkiWeb download URL wants the Anki version as a zero-padded number
# (26.8.1 -> 260801); ask the installed Anki rather than trusting the ARG.
RUN set -eu; \
    ANKI_VER="$(python3 -c 'from anki.buildinfo import version; print(version)' 2>/dev/null || echo "${ANKI_VERSION}")"; \
    ANKI_P="$(echo "$ANKI_VER" | awk -F. '{printf "%02d%02d%02d", $1, $2, $3}')"; \
    echo "Anki ${ANKI_VER} -> addon compat parameter ${ANKI_P}"; \
    mkdir -p /opt/anki-addons; \
    for id in ${ADDON_IDS}; do \
        echo "Installing addon ${id}"; \
        curl -fsSL -o "/tmp/${id}.zip" "https://ankiweb.net/shared/download/${id}?v=2.1&p=${ANKI_P}"; \
        mkdir -p "/opt/anki-addons/${id}"; \
        unzip -q "/tmp/${id}.zip" -d "/opt/anki-addons/${id}/"; \
        rm "/tmp/${id}.zip"; \
    done

# The upstream image bakes a pre-configured profile into /data to skip Anki's
# first-run wizard. A bind mount hides it, so stash a copy the entrypoint can
# seed from.
RUN mkdir -p /opt/anki-seed && \
    if [ -f /data/prefs21.db ]; then cp /data/prefs21.db /opt/anki-seed/prefs21.db; fi

COPY rootfs/entrypoint.sh rootfs/startup.sh rootfs/healthcheck.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/startup.sh /usr/local/bin/healthcheck.sh

# Unbuffered: Anki/addon output must reach `docker logs` as it happens, not in
# blocks flushed at process exit.
ENV PYTHONUNBUFFERED=1 \
    ANKI_ADDON_SOURCE=/opt/anki-addons \
    ANKI_DATA=/data \
    ANKI_MCP_HOST=0.0.0.0 \
    ANKI_MCP_PORT=3141 \
    ANKICONNECT_BIND=0.0.0.0 \
    ANKICONNECT_PORT=8765 \
    VNC_GEOMETRY=1920x1080

EXPOSE 5900 8765 3141

HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
    CMD ["/usr/local/bin/healthcheck.sh"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["/usr/local/bin/startup.sh"]
