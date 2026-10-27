# Risk rating criteria

Read with [remediation](../SKILL.md) when a reporting worker names a risk level for an accepted case. This is a fixed, documented scale, named here so every report uses the same words for the same judgment; it is not computed from any field the host validates, and it never upgrades a case's review status by itself.

## The scale

Five levels, from likelihood of exploitation and the extent of impact if exploited, each read from the case's own recorded evidence rather than guessed:

- **Critical**: exploitable with no prior access and only an identity an anonymous attacker can obtain (self-registration, a default account), with impact reaching data or control beyond the tested object's own owner (another principal's data, a privileged action, the underlying host or network).
- **High**: exploitable with no prior access and only an identity an anonymous attacker can obtain, with impact confined to the tested object itself or its own owner; or exploitable only with an identity the attacker can register or acquire, but reaching impact beyond that identity's own data.
- **Medium**: exploitable only with an identity a tester obtained through the target's own flow, confined to that identity's own data or actions; or a confirmed structural weakness whose further reach stays an open proof gap.
- **Low**: a confirmed deviation from stated or boundary-invariant policy with no demonstrated protected effect beyond the deviation itself (an exposure, a disclosure of non-sensitive internals, a missing defense-in-depth control).
- **Informational**: a `ruled_out_bounded` result worth recording, a gap whose cause is now known, or an observation with no policy to measure it against yet.

## How to use it

Name the level next to the case's existing verdict and policy basis; do not replace either. State the likelihood and impact factors that produced it, each citing the same evidence the case itself cites. A case whose policy basis is `inferred` cannot be rated above Medium, since its own closure rule already caps it below a confirmed violation. When a factor is unknown (no stated impact ceiling, no clear prerequisite), say so and rate from what is confirmed, not from an assumed worst case.

## Usually not High or Critical

These are rated too high more often than any other class. Each needs a demonstrated, unusual circumstance to exceed Medium, and the case must name it:

- Missing or weak headers, cookie attributes and TLS settings with no demonstrated protected effect.
- Self-inflicted effects (the victim must supply the payload), and clickjacking on actions that change nothing sensitive.
- An open redirect that leaks no credential or token; enumeration that only confirms an account, host or version exists.
- A memory-safety or parsing weakness with no attacker-reachable input shown.
- Anything that already requires admin, shell or physical access, or a secret the attacker must first obtain (a stolen cookie, an intercepted link) unless the same case shows how it is obtained.
- "Matters if chained" where the other links are unproven.

## Lower the level, never drop the case

A constraint (internal-only reachability, a required role, a narrow precondition) lowers the level and is stated in the report; it is not a reason to omit the case. Missing evidence about exposure or deployment lowers confidence and keeps the case open; it is not "internal-only". Do not read "I could not confirm it is reachable" as "it is not reachable".

## Before naming High or Critical

All must hold, each citing the case's own evidence; if one does not, name the next level down and say which one failed:

- The attack path is realistic and in scope, not a lab-only condition or one that depends on an unproven prior compromise.
- The attacker position it needs is one an attacker can actually obtain.
- The impact is demonstrated, not asserted: broad or systemic reach, not one record or the tester's own data.
- The counterevidence pass found no control that limits it, or the report explains why the control does not hold.
- Reachability is observed on the tested configuration, not assumed from how the service is usually deployed.
- The case is `confirmed` and accepted, and the rating would survive a reviewer asking for the receipt behind each factor.

## What this does not do

Rating is separate from and never substitutes for the review gates already in place: `confirmed`, `reviewStatus accepted`, and independent validation keep their own meaning regardless of the level assigned. A Critical rating on a claim that is not `confirmed` and accepted is not a report-worthy finding; it is still an open item. This scale does not compute a numeric score, does not combine with any other metric, and is not CVSS; where the deliverable requires CVSS, that mapping is a separate, explicit decision for the owner, not an automatic conversion from this scale.
