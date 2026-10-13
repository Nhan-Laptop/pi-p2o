#!/usr/bin/env bash
# Explicit operator setup, never invoked by assessment tools. Produces an immutable local image ID.
set -euo pipefail

usage() {
  printf '%s\n' \
    'Usage: scripts/setup-sandbox-tools.sh --build [--with=<tool1,tool2,...>]' \
    'Builds the pinned base plus Semgrep 1.179.0, using package-download network access during setup only.' \
    'Optional --with adds more userspace tools from this fixed, pinned list (comma-separated, any order):' \
    '  angr      -> angr 10.0.3      (python3 library; CLI shims: angr, angr-python3)' \
    '  z3        -> z3-solver 5.1.0.0 (CLI: z3; python3 library via z3-python3)' \
    '  binwalk   -> binwalk 2.1.0    (CLI: binwalk)' \
    '  mitmproxy -> mitmproxy 12.2.3 (CLI: mitmdump)' \
    '  unicorn   -> unicorn 2.1.4    (python3 CPU-emulation library via unicorn-python3; no CLI)' \
    'Each tool is installed as root, into its own venv, at build time only; the running container' \
    'stays read-only and non-root regardless of --with, so this does not change what the sandbox can do.'
}

if [[ "${1:-}" != "--build" ]]; then
  usage
  exit 2
fi

with_arg="${2:-}"
if [[ -n "$with_arg" && "$with_arg" != --with=* ]]; then
  usage
  exit 2
fi

KNOWN_TOOLS=(angr z3 binwalk mitmproxy unicorn)
IFS=',' read -ra REQUESTED_TOOLS <<< "${with_arg#--with=}"
for tool in "${REQUESTED_TOOLS[@]}"; do
  [[ -z "$tool" ]] && continue
  known=0
  for candidate in "${KNOWN_TOOLS[@]}"; do
    [[ "$tool" == "$candidate" ]] && known=1 && break
  done
  if [[ "$known" -ne 1 ]]; then
    printf 'Unknown --with tool: %s (known: %s)\n' "$tool" "${KNOWN_TOOLS[*]}" >&2
    exit 2
  fi
done

root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT

{
  printf '%s\n' 'FROM ghcr.io/usestrix/strix-sandbox@sha256:f6906c3114e504fd1a218fcf028d7a0e46851118403a438b63956de6ea7c4331'
  printf '%s\n' 'USER root'
  printf '%s\n' "RUN python3 -m venv /opt/p2o-semgrep && /opt/p2o-semgrep/bin/pip install --no-cache-dir 'semgrep==1.179.0' && /opt/p2o-semgrep/bin/pip freeze > /opt/p2o-semgrep/requirements.resolved.txt && ln -s /opt/p2o-semgrep/bin/semgrep /usr/local/bin/semgrep && chmod -R a+rX /opt/p2o-semgrep"
  for tool in "${REQUESTED_TOOLS[@]}"; do
    case "$tool" in
      angr)
        printf '%s\n' "RUN python3 -m venv /opt/p2o-angr && /opt/p2o-angr/bin/pip install --no-cache-dir 'angr==10.0.3' && /opt/p2o-angr/bin/pip freeze > /opt/p2o-angr/requirements.resolved.txt && ln -s /opt/p2o-angr/bin/angr /usr/local/bin/angr && ln -s /opt/p2o-angr/bin/python3 /usr/local/bin/angr-python3 && chmod -R a+rX /opt/p2o-angr"
        ;;
      z3)
        printf '%s\n' "RUN python3 -m venv /opt/p2o-z3 && /opt/p2o-z3/bin/pip install --no-cache-dir 'z3-solver==5.1.0.0' && /opt/p2o-z3/bin/pip freeze > /opt/p2o-z3/requirements.resolved.txt && ln -s /opt/p2o-z3/bin/z3 /usr/local/bin/z3 && ln -s /opt/p2o-z3/bin/python3 /usr/local/bin/z3-python3 && chmod -R a+rX /opt/p2o-z3"
        ;;
      binwalk)
        printf '%s\n' "RUN python3 -m venv /opt/p2o-binwalk && /opt/p2o-binwalk/bin/pip install --no-cache-dir 'binwalk==2.1.0' && /opt/p2o-binwalk/bin/pip freeze > /opt/p2o-binwalk/requirements.resolved.txt && ln -s /opt/p2o-binwalk/bin/binwalk /usr/local/bin/binwalk && chmod -R a+rX /opt/p2o-binwalk"
        ;;
      mitmproxy)
        printf '%s\n' "RUN python3 -m venv /opt/p2o-mitmproxy && /opt/p2o-mitmproxy/bin/pip install --no-cache-dir 'mitmproxy==12.2.3' && /opt/p2o-mitmproxy/bin/pip freeze > /opt/p2o-mitmproxy/requirements.resolved.txt && ln -s /opt/p2o-mitmproxy/bin/mitmdump /usr/local/bin/mitmdump && chmod -R a+rX /opt/p2o-mitmproxy"
        ;;
      unicorn)
        printf '%s\n' "RUN python3 -m venv /opt/p2o-unicorn && /opt/p2o-unicorn/bin/pip install --no-cache-dir 'unicorn==2.1.4' && /opt/p2o-unicorn/bin/pip freeze > /opt/p2o-unicorn/requirements.resolved.txt && ln -s /opt/p2o-unicorn/bin/python3 /usr/local/bin/unicorn-python3 && chmod -R a+rX /opt/p2o-unicorn"
        ;;
    esac
  done
  printf '%s\n' 'USER 65532:65532'
} > "$root/Dockerfile"

docker build --iidfile "$root/image-id" "$root" >&2
printf '%s\n' 'Tool installation is complete. Select the immutable ID below explicitly with pi --p2o-image <ID>.' >&2
cat "$root/image-id"
