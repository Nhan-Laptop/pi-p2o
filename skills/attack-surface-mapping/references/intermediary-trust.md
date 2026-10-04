# Intermediary trust and represented identities

Use with [attack-surface mapping](../SKILL.md) for composed services, gateways, brokers and client-facing adapters. [O012](../../../research/orange/evidence.md#o012) supports architecture-first separation of intermediary admission, metadata forwarding and reconstructed client identity; [O008](../../../research/orange/evidence.md#o008) adds effective peer authority and consumer-specific legitimate operations. These are generic contracts, not relay or request-bypass procedures.

## Draw roles before reviewing business logic

For each reachable operation record `external caller | intermediary execution identity | admission mechanism | trusted-metadata writer | represented client | selected downstream context | final policy consumer`. One process or credential can participate in multiple roles; do not collapse them into a single authenticated/unauthenticated label.

Trace where metadata gains authority, which participant writes it, and how the next participant binds it to a client. Ask whether client-originated values are replaced, validated, rejected or forwarded unchanged. Those alternatives are derived review questions, not assumed behavior. Network location, listener access, and valid peer credentials do not establish a represented client's identity or authority for a particular action.

Record effective peer privileges, activation paths and legitimate operations independently for each consumer; the [interface checklist](../SKILL.md) owns the membership fields. A restriction that fits one entrance can break required traffic elsewhere, and a repaired entrance does not prove that another consumer rejects the same bad trust assumption. Historical names and architecture diagrams are leads, not proof of the current deployment. [O008](../../../research/orange/evidence.md#o008), [O012](../../../research/orange/evidence.md#o012).

## Choose the next question

- Unknown handler/admission path → continue reachability mapping or [source auditing](../../source-code-auditing/SKILL.md); include a benign accepted operation and denied control.
- Unknown metadata transformation or selected context → [data-flow analysis](../../data-flow-analysis/SKILL.md) or [parser comparison](../../parser-differential-auditing/SKILL.md), with origins, representations and the two consumer interpretations.
- Unknown represented identity or action permission → [authorization auditing](../../authorization-auditing/SKILL.md), separating peer authentication, client binding and object/action policy.
- A later capability still needs another prerequisite → [impact assessment](../../exploitability-assessment/SKILL.md); describe the missing edge, not a trigger order or executable chain.

## Tool → purpose → when

| Option | Evidence and limit |
|---|---|
| Architecture/configuration and service registration review → locate peers and policy consumers → before selecting a code slice | Configuration is not runtime exposure; verify actual activation and handlers |
| Source/decompiler references → trace admission and identity-reconstruction sites → when internal contracts are undocumented | Match the assessed revision and artifact; same names can have different roles |
| Controlled application/network traces → correlate a normal request with intermediary and consumer → when routing/identity remains inferred | Preserve actual role/context and observer changes; do not collect credentials or copy attack requests |
| Effective-rights and membership inspection → distinguish nominal group labels from authority → when installation or peer trust matters | An intended administrative capability is not automatically a policy bypass |

These are library-derived observation options, not a claim that each source used them. Nothing here requires a relay/coercion utility, impersonation procedure, production policy change or new tool installation.

## Handoff gate

Deliver versioned topology/role rows, handler/gate references, metadata provenance, effective authority, legitimate-operation expectations, failed assumptions, evidence classification and one bounded next question. A consumer returns missing identity origin or trust-binding evidence rather than treating an internal listener as compromise. Require harmless contrasting observations before promoting an inferred edge to a demonstrated policy violation.

A remediation packet separates the trusted enforcement point, accepted peer operations, shipped code, active enforcement and rollout scope. Missing activation or compatibility evidence stays unresolved even when a vendor announces a repair. Use [H1/H2/H5/H6](../../../HANDOFFS.md) rather than inventing a fixed multi-stage pipeline.
