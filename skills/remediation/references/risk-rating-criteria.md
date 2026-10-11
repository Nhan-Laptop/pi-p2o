# Risk rating criteria

Read with [remediation](../SKILL.md) when a reporting worker names a risk level for an accepted case. This is a fixed, documented scale, named here so every report uses the same words for the same judgment; it is not computed from any field the host validates, and it never upgrades a case's review status by itself.

## The scale

Five levels, from likelihood of exploitation and the extent of impact if exploited, each read from the case's own recorded evidence rather than guessed:

- **Critical**: exploitable with no prior access and no operator-supplied identity, with impact reaching data or control beyond the tested object's own owner (another principal's data, a privileged action, the underlying host or network).
- **High**: exploitable with no prior access and no operator-supplied identity, with impact confined to the tested object itself or its own owner; or exploitable only with an operator-supplied identity but reaching impact beyond that identity's own data.
- **Medium**: exploitable only with an operator-supplied identity, confined to that identity's own data or actions; or a confirmed structural weakness whose further reach stays an open proof gap.
- **Low**: a confirmed deviation from stated or boundary-invariant policy with no demonstrated protected effect beyond the deviation itself (an exposure, a disclosure of non-sensitive internals, a missing defense-in-depth control).
- **Informational**: a `ruled_out_bounded` result worth recording, a gap whose cause is now known, or an observation with no policy to measure it against yet.

## How to use it

Name the level next to the case's existing verdict and policy basis; do not replace either. State the likelihood and impact factors that produced it, each citing the same evidence the case itself cites. A case whose policy basis is `inferred` cannot be rated above Medium, since its own closure rule already caps it below a confirmed violation. When a factor is unknown (no stated impact ceiling, no clear prerequisite), say so and rate from what is confirmed, not from an assumed worst case.

## What this does not do

Rating is separate from and never substitutes for the review gates already in place: `confirmed`, `reviewStatus accepted`, and independent validation keep their own meaning regardless of the level assigned. A Critical rating on a claim that is not `confirmed` and accepted is not a report-worthy finding; it is still an open item. This scale does not compute a numeric score, does not combine with any other metric, and is not CVSS; where an engagement requires CVSS, that mapping is a separate, explicit decision for the owner, not an automatic conversion from this scale.
