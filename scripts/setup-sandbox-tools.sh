#!/usr/bin/env bash
# Explicit operator setup, never invoked by assessment tools. Produces an immutable local image ID.
set -euo pipefail

usage() {
  printf '%s\n' \
    'Usage: scripts/setup-sandbox-tools.sh --build [--with=<tool1,tool2,...>]' \
    'Builds the pinned base plus Semgrep 1.179.0, using package-download network access during setup only.' \
    'Optional --with adds more userspace tools from this fixed list (comma-separated, any order):' \
    '  angr      -> angr 10.0.3        (python3 library; CLI shims: angr, angr-python3)' \
    '  z3        -> z3-solver 5.1.0.0  (CLI: z3; python3 library via z3-python3)' \
    '  binwalk   -> binwalk 2.1.0      (CLI: binwalk)' \
    '  mitmproxy -> mitmproxy 12.2.3   (CLI: mitmdump)' \
    '  unicorn   -> unicorn 2.1.4      (python3 CPU-emulation library via unicorn-python3; no CLI)' \
    '  pwntools  -> pwntools 4.15.0    (python3 library; CLI shims: pwn, pwntools-python3)' \
    '  strace    -> strace             (apt package; syscall tracing)' \
    '  socat     -> socat              (apt package; relay and listener plumbing)' \
    '  ssh       -> openssh-client     (apt package; ssh/scp/sftp client)' \
    '  afl++     -> afl++              (apt package; afl-fuzz and companions)' \
    '  radare2   -> radare2            (apt package; r2/rabin2 analysis CLIs)' \
    '  tcpdump   -> tcpdump            (apt package; packet capture)' \
    '  java      -> default-jre-headless (apt package; Java runtime)' \
    'Pinning: the python tools are exact-pinned inside their venv. The apt tools are installed by' \
    'package name because the Kali rolling base ships no package lists and publishes no stable' \
    'version to pin; the build records the resolved dpkg versions in /opt/p2o-apt/versions.txt and' \
    'the printed immutable image ID is the pin.' \
    'Each tool is installed as root, at build time only. At run time the sandbox is root' \
    'on a writable root filesystem with the Docker default capability set; the container is the only blast' \
    'radius: no host path is mounted and the Docker socket is never exposed.' \
    'The running container stays as-is: --with is operator convenience, not a capability gate, and an' \
    'agent can still install into scratch at run time.'
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

KNOWN_TOOLS=(angr z3 binwalk mitmproxy unicorn pwntools strace socat ssh 'afl++' radare2 tcpdump java)
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

# Apt package names for the tools that do not install into their own venv. The base image is
# Kali rolling: no stable apt version pin exists, so the resolved versions are recorded in the
# image and the emitted image ID is the immutable pin.
apt_package() {
  case "$1" in
    strace|socat|tcpdump) printf '%s' "$1" ;;
    ssh) printf '%s' 'openssh-client' ;;
    'afl++'|radare2) printf '%s' "$1" ;;
    java) printf '%s' 'default-jre-headless' ;;
    *) return 1 ;;
  esac
}

root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT

{
  printf '%s\n' 'FROM ghcr.io/usestrix/strix-sandbox@sha256:f6906c3114e504fd1a218fcf028d7a0e46851118403a438b63956de6ea7c4331'
  printf '%s\n' 'USER root'
  printf '%s\n' "RUN python3 -m venv /opt/p2o-semgrep && /opt/p2o-semgrep/bin/pip install --no-cache-dir 'semgrep==1.179.0' && /opt/p2o-semgrep/bin/pip freeze > /opt/p2o-semgrep/requirements.resolved.txt && ln -s /opt/p2o-semgrep/bin/semgrep /usr/local/bin/semgrep && chmod -R a+rX /opt/p2o-semgrep"
  for tool in "${REQUESTED_TOOLS[@]}"; do
    [[ -z "$tool" ]] && continue
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
      pwntools)
        printf '%s\n' "RUN python3 -m venv /opt/p2o-pwntools && /opt/p2o-pwntools/bin/pip install --no-cache-dir 'pwntools==4.15.0' && /opt/p2o-pwntools/bin/pip freeze > /opt/p2o-pwntools/requirements.resolved.txt && ln -s /opt/p2o-pwntools/bin/pwn /usr/local/bin/pwn && ln -s /opt/p2o-pwntools/bin/python3 /usr/local/bin/pwntools-python3 && chmod -R a+rX /opt/p2o-pwntools"
        ;;
      strace|socat|ssh|'afl++'|radare2|tcpdump|java)
        package=$(apt_package "$tool")
        printf '%s\n' "RUN mkdir -p /opt/p2o-apt && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends '${package}' && dpkg-query -W -f='\${Package}=\${Version}\\n' '${package}' >> /opt/p2o-apt/versions.txt && rm -rf /var/lib/apt/lists/*"
        ;;
      *)
        printf 'Unknown --with tool: %s\n' "$tool" >&2
        exit 2
        ;;
    esac
  done
  printf '%s\n' 'USER root'
} > "$root/Dockerfile"

docker build --iidfile "$root/image-id" "$root" >&2
printf '%s\n' 'Tool installation is complete. Select the immutable ID below explicitly with pi --p2o-image <ID>.' >&2
cat "$root/image-id"
