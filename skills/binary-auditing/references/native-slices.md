# Bounded native slices

Use after [binary auditing](../SKILL.md) has established a native format, architecture, load map, and a relevant anchor. This is analysis of authorized copies, not a checker-bypass or exploit recipe. [Supplemental provenance](../../../research/TOOLING.md) records the source and tool-verification limits.

## Choose the next observation

Known input consumer or dispatch target → recover that function and its immediate dependencies. Unknown scope → inspect entry/symbol/runtime metadata once. Several related handlers → request a small explicit batch. An existing valid export → search it before loading the image again. Do not start with whole-program output or assume constructors contain hidden validation.

Check tool availability once. Prefer an installed decompiler or binutils fallback; installation is a separate decision, not a prerequisite for this workflow. All analysis guidance needed for this route is in this library; no external skill or workspace helper is required.

## Optional Kuna CLI

Templates below substitute artifact-derived names/addresses, never invented stripped-function names. The 15–20 second deadlines are initial probe budgets, not benchmark claims; adjust for a measured need. `timeout -k` is GNU syntax: use a supported equivalent on other hosts. Check the installed subcommand's help before relying on these options.

| Tool pattern | Purpose | When |
|---|---|---|
| `command -v kuna` | Check availability without installation | Once before the optional route |
| `timeout -k 1 15 kuna decompile <artifact> <recovered-target>` | Recover one relevant native function | The name or supported image virtual address is already known |
| `timeout -k 1 15 kuna functions <artifact> --summary --json` | Orient unknown scope and runtime | No useful application target is known; skip for a known target |
| `timeout -k 1 15 kuna strings <artifact> --filter '<relevant-regex>' --json` | Find an input/diagnostic anchor | A meaningful string family is justified; follow its references rather than treating text as reachability |
| `timeout -k 1 20 kuna decompile-all <artifact> --functions <name1,name2> --jobs 1 --max-fn-seconds 5 --no-vars --json` | Reuse the loaded image for a small related batch | Multiple recovered names belong to the same question |

For address-selected batches, use repeatable `--addr` instead of inventing names. These are image virtual addresses, not string/file offsets or ASLR-adjusted live addresses. Single-target `decompile` does not take the batch-only `--max-fn-seconds`; its outer deadline bounds discovery too. A returned-record `--limit` is not a wall-clock bound. More jobs can duplicate memory/image loading; increase only after measuring useful work.

## Installed fallback

- `file <artifact>` and `readelf -h -l -S -d <elf>` → establish native identity, entry, sections, segments, and dependencies → before selecting a disassembly range; ELF output cannot define an arbitrary raw-image load map.
- `nm <artifact>` and `strings -a -n 6 -t x <artifact>` → find names and diagnostic anchors → when symbols or string references can narrow the slice; string offsets are file offsets and missing strings are not a negative proof.
- `timeout -k 1 10 objdump -d --start-address=<image-va> --stop-address=<image-va> <artifact>` → inspect a recovered range → with format/architecture support and ordered valid addresses. Add `-M intel` only for an applicable x86 target.

## Coverage gate and checkpoint

Save stdout and stderr with artifact hash, tool version/options, configuration, requested targets, recovered targets/ranges, errors, elapsed limit, and remaining question. Exit zero can still mean partial or empty decompilation; valid JSON does not guarantee every function succeeded. Timeout or unsupported input may produce no JSON. Keep such targets unresolved, not safe/deleted/empty. Do not truncate JSON through `head`; bound collection and report truncation explicitly.

Generated types, signatures, aliasing, signed comparisons, and indirect calls require instruction or runtime corroboration. Reuse a checkpoint only while its recorded dependencies remain valid; after two uninformative probes switch evidence source per the [start-here rule](../../../README.md#start-here), not a larger scan. Stop this analysis step once its contract is corroborated or its specific uncertainty is handed to [dynamic analysis](../../dynamic-analysis/SKILL.md); do not equate this with whole-target safety.
