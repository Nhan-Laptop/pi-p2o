#!/usr/bin/env bash
# Explicit operator setup, never invoked by assessment tools. Produces an immutable local image ID.
set -euo pipefail
if [[ "${1:-}" != "--build" ]]; then
  printf '%s\n' 'Usage: scripts/setup-sandbox-tools.sh --build' 'Builds the pinned base plus Semgrep 1.179.0 using package-download network access during setup only.'
  exit 2
fi
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
cat > "$root/Dockerfile" <<'DOCKER'
FROM ghcr.io/usestrix/strix-sandbox@sha256:f6906c3114e504fd1a218fcf028d7a0e46851118403a438b63956de6ea7c4331
USER root
RUN python3 -m venv /opt/p2o-semgrep && /opt/p2o-semgrep/bin/pip install --no-cache-dir 'semgrep==1.179.0' && /opt/p2o-semgrep/bin/pip freeze > /opt/p2o-semgrep/requirements.resolved.txt && ln -s /opt/p2o-semgrep/bin/semgrep /usr/local/bin/semgrep && chmod -R a+rX /opt/p2o-semgrep
USER 65532:65532
DOCKER
docker build --iidfile "$root/image-id" "$root" >&2
printf '%s\n' 'Tool installation is complete. Select the immutable ID below explicitly with pi --p2o-image <ID>.' >&2
cat "$root/image-id"
