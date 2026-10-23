# What the target can reach

Ordered by how often it turns a fetch into a finding. Only addresses the ticket allows: an internal range is in scope
because the engagement says so, not because the box can route to it.

## Loopback and the target's own host

| Destination | What it usually holds | Observation |
| --- | --- | --- |
| `127.0.0.1:<app port>` | the application without the proxy in front | different response headers, no WAF |
| `127.0.0.1:<admin port>` | admin console, metrics, debug endpoints | page title, HTTP 200 where the public port gives 404 |
| `localhost:<db>` | database protocol on a privileged socket | protocol greeting bytes, error strings |
| `unix:/var/run/<svc>.sock` | services bound to sockets only | greeting, or a `Connection refused` that names the socket |

## Cloud metadata

| Provider | Path on the link-local metadata host | Notes |
| --- | --- | --- |
| AWS IMDSv1 | `169.254.169.254`, `/latest/meta-data/iam/security-credentials/` | v1 needs no header; v2 requires a token request first |
| GCP | `metadata.google.internal`, `/computeMetadata/v1/` | requires a `Metadata-Flavor: Google` header |
| Azure | `169.254.169.254`, `/metadata/instance?api-version=2021-02-01` | requires a `Metadata: true` header |
| DigitalOcean | `169.254.169.254`, `/metadata/v1/` | plain GET |
| Alibaba | `100.100.100.200`, `/latest/meta-data/` | plain GET |

A metadata read that returns a credential document is the strongest data effect this skill reaches. Treat the document
as a secret: quote the path, not the key material, and never use the credential without its own authorization.

## Kubernetes and container services

- `kubernetes.default.svc/api/v1/namespaces/<ns>/secrets` — needs a service-account token, but the token is often on
  disk at `/var/run/secrets/kubernetes.io/serviceaccount/token`.
- kubelet on `127.0.0.1:10255` (read-only) and `10250` (exec, if the token allows).
- Docker socket via `unix:///var/run/docker.sock` when a proxy supports unix or the fetch is a file read.

## Internal-only HTTP services

Name resolution tells you what exists: `http://<service-name>/` for the service names the target's config uses,
`http://<service>.default.svc.cluster.local/` in Kubernetes, and the ECS task-credential address `169.254.170.2` under
`/v2/credentials`.

## Observation surfaces for a blind fetch

- Callback to a listener you control: source address, path, timestamp, User-Agent of the target's HTTP client.
- Time-to-response difference with a distribution, not a single sample.
- Error strings that leak the resolved address or the proxy's refusal reason.
- Response length differences between an open and a closed port, measured over five runs each.

## What counts as the effect

Reachability alone is a network fact. Data read from an internal service is an effect. A credential document read is a
larger effect, and using it is a separate, authorized step.
