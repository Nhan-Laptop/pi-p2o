# Usage

Install with `pi install https://github.com/Nhan-Laptop/pi-p2o`, then `/reload`.
Start Docker and pull the pinned image listed in the README once. No source build is required in an installed copy.

In interactive Pi (or a confirmation-capable RPC client):

```text
/p2o --target ./source
/p2o --target https://example.com
```

One dialog confirms ownership/permission, scope, sandbox limits and use of your current model provider.
Declining starts no sandbox and no model turn. Local target classification resolves the path before confirmation,
but does not read source contents. The current agent receives the task immediately after sandbox readiness.

For source: a regular-file-only copy at `/target` is read-only, `/work` is writable scratch. The copy is limited to 64 MiB / 20000 entries; symlinks, special files, `.git` and `node_modules` are skipped. Commands use `p2o_shell`, never host shell.
For web: `p2o_http` accepts GET/HEAD only on the same origin as the selected URL. No redirects, cookies,
credentials, private IPs or mutating methods. Retrieved data is shown as bounded text; offline analysis uses
`p2o_shell`. A GitHub URL does not clone source in this release.

The agent calls `p2o_finish` before its report. `/p2o stop` cancels manually and verifies removal. Temporary
files disappear; the transcript holds the report. No resume, approval command, profiles or headless planner remain.

## Sandbox limits

Pinned Strix tools image; user 65532; read-only root filesystem; capabilities dropped; no-new-privileges;
Docker default seccomp; 128 PIDs; 512 MiB memory; one CPU; 64 MiB each for `/tmp` and `/work`.
Shell container has no network. HTTP containers have bridge networking but run **only fixed curl arguments**,
not model-controlled code, with proxy use disabled and the requested hostname pinned to a validated public IPv4.
They have no source mounts. No Docker socket, host home or provider credentials are mounted.
Commands: maximum 60 seconds; HTTP: 20 seconds and 1 MiB body limit; visible combined output: 48 KiB.
Assessment lifetime: 30 minutes. No application-level model token/cost cap; Pi/provider accounting is unchanged.

This is container isolation, not a virtual machine. The source copy is not an atomic/Git snapshot; changes during copying can yield a mixed view.
The trusted Pi process and other installed extension code are outside this containment boundary. Tool gates
restrict model calls, not malicious extension code, Docker administrators or host-kernel compromise.

## Cleanup trouble

If Docker is unavailable during cleanup, tools stay gated. Restore Docker and retry `/p2o stop`.
Reload/session navigation attempts cleanup; failed cleanup cancels navigation. An abrupt process kill can leave
containers behind. List only this extension's containers:

```sh
docker ps -a --filter label=pi-p2o=minimal
```

After checking that no active assessment needs them, remove their specific names with `docker rm -f <name>`.
Never remove unrelated containers. The extension does not silently reclaim old containers on startup.

## Troubleshooting

- Missing image: run the pinned `docker pull` from README. No automatic download happens during assessment.
- Docker permissions: ensure your account can use the local Unix socket. Remote Docker daemons are unsupported.
- Target unavailable: choose an existing directory, or an HTTP(S) URL with public IPv4 DNS.
- Duplicate tools: load either the installed package or `pi --no-extensions -e /path/to/pi-p2o`, never both.
- Legacy flags/configurations: removed in 0.2. Use only `--target`; old saved owner manifests are ignored.
