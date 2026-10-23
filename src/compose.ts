/**
 * planning_update.md P14.3: the target's own compose file is the default environment base, and it is target-controlled input.
 *
 * Nothing here is a general YAML implementation. It reads the subset a compose file actually uses (indented mappings and
 * sequences, plain/quoted/flow/block scalars) and then applies a closed allowlist: a key this reader does not translate is
 * named in `refused` instead of being ignored, so a compose file can never widen the environment by using a feature the
 * filter failed to notice ("not silently stripped" — the whole file is refused, with the offending key).
 *
 * What this cannot do is stated rather than implied: the sandbox has no Docker daemon, so `build:` and `image:` values other
 * than the assessment image are refused by name. A service that does run is one command in the sandbox image, exactly like a
 * command the operator would have typed.
 */
import { TEXT_CONTROL } from './validate.js';

type Yaml = string | Yaml[] | { [key: string]: Yaml };
interface Line { indent: number; text: string; number: number }

const MAX_LINES = 4000, MAX_DEPTH = 12, MAX_VALUE = 2048;

const isMap = (value: Yaml | undefined): value is { [key: string]: Yaml } => !!value && typeof value === 'object' && !Array.isArray(value);
const isSequence = (value: Yaml): value is Yaml[] => Array.isArray(value);

/** Indentation is the whole grammar here, so an unexpected indentation is an error, never a best guess. */
function tokenize(source: string): Line[] {
  const lines: Line[] = [];
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    if (index >= MAX_LINES) throw Error(`exceeds ${MAX_LINES} lines`);
    if (TEXT_CONTROL.test(raw)) throw Error(`line ${index + 1} contains control characters`);
    // Only whole-line comments are stripped: a trailing `#` may be part of a command, and truncating one would silently change
    // what runs. An unparsed trailing comment then shows up as a named refusal instead of a shortened command.
    const stripped = raw.trimEnd();
    if (!stripped.trim() || stripped.trimStart().startsWith('#') || stripped.trim() === '---') continue;
    const indent = stripped.length - stripped.trimStart().length;
    if (indent % 2 !== 0) throw Error(`line ${index + 1} is not indented by two spaces`);
    lines.push({ indent, text: stripped.trimStart(), number: index + 1 });
  }
  if (!lines.length) throw Error('is empty');
  return lines;
}

function scalar(text: string, number: number): Yaml {
  if (text.length > MAX_VALUE) throw Error(`line ${number} exceeds ${MAX_VALUE} characters`);
  if (text.startsWith('"')) { try { return JSON.parse(text) as string; } catch { throw Error(`line ${number} has an unterminated quoted string`); } }
  if (text.startsWith("'")) { if (!text.endsWith("'") || text.length < 2) throw Error(`line ${number} has an unterminated quoted string`); return text.slice(1, -1).replace(/''/g, "'"); }
  if (text.startsWith('[')) return flowList(text, number);
  if (text.startsWith('{')) return flowMap(text, number);
  return text;
}

function splitFlow(inner: string, number: number): string[] {
  const parts: string[] = []; let depth = 0, quote = '', current = '';
  for (const character of inner) {
    if (quote) { current += character; if (character === quote) quote = ''; continue; }
    if (character === '"' || character === "'") { quote = character; current += character; continue; }
    if (character === '[' || character === '{') depth += 1;
    if (character === ']' || character === '}') depth -= 1;
    if (character === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue; }
    current += character;
  }
  if (quote || depth !== 0) throw Error(`line ${number} has an unbalanced inline value`);
  if (current.trim()) parts.push(current.trim());
  return parts;
}
const flowList = (text: string, number: number): Yaml[] => {
  if (!text.endsWith(']')) throw Error(`line ${number} has an unterminated inline list`);
  return splitFlow(text.slice(1, -1), number).map(part => scalar(part, number));
};
const flowMap = (text: string, number: number): { [key: string]: Yaml } => {
  if (!text.endsWith('}')) throw Error(`line ${number} has an unterminated inline map`);
  const result: { [key: string]: Yaml } = {};
  for (const part of splitFlow(text.slice(1, -1), number)) {
    const colon = part.indexOf(':');
    if (colon < 1) throw Error(`line ${number} has an inline entry without a key`);
    result[part.slice(0, colon).trim()] = scalar(part.slice(colon + 1).trim(), number);
  }
  return result;
};

/** Lines deeper than `indent` that belong to the entry at `start`, and the index just past them. */
function children(lines: Line[], start: number, indent: number): [Line[], number] {
  let end = start;
  while (end < lines.length && lines[end]!.indent > indent) end += 1;
  return [lines.slice(start, end), end];
}

/** `|`/`>` block scalars are common for `command:`; both are folded into one command string. */
function blockScalar(block: Line[], header: string): string {
  if (!block.length) return '';
  const indent = Math.min(...block.map(line => line.indent));
  const body = block.map(line => ' '.repeat(Math.max(0, line.indent - indent)) + line.text);
  const text = header.startsWith('>') ? body.join(' ').replace(/\s+/g, ' ').trim() : body.join('\n').trim();
  if (text.length > MAX_VALUE) throw Error(`block scalar exceeds ${MAX_VALUE} characters`);
  return text;
}

function block(lines: Line[], start: number, indent: number, depth: number): [Yaml, number] {
  if (depth > MAX_DEPTH) throw Error('nests too deeply');
  const first = lines[start];
  if (!first || first.indent !== indent) throw Error(`line ${first?.number ?? start + 1} is indented inconsistently`);
  return first.text === '-' || first.text.startsWith('- ') ? sequence(lines, start, indent, depth) : mapping(lines, start, indent, depth);
}

function sequence(lines: Line[], start: number, indent: number, depth: number): [Yaml[], number] {
  const items: Yaml[] = [];
  let index = start;
  while (index < lines.length && lines[index]!.indent === indent && (lines[index]!.text === '-' || lines[index]!.text.startsWith('- '))) {
    const line = lines[index]!, rest = line.text.slice(1).trimStart();
    if (!rest) {
      const [nested, after] = children(lines, index + 1, indent);
      items.push(nested.length ? block(nested, 0, nested[0]!.indent, depth + 1)[0] : ''); index = after; continue;
    }
    // `- key: value` opens a mapping whose keys sit two columns past the dash; re-indent the item's own block and parse it.
    if (/^[A-Za-z_][A-Za-z0-9_.-]*\s*:(\s|$)/.test(rest)) {
      const [nested, after] = children(lines, index + 1, indent);
      const shift = (entry: Line): Line => ({ ...entry, indent: entry.indent - indent - 2 });
      const local: Line[] = [{ indent: 0, text: rest, number: line.number }, ...nested.filter(entry => entry.indent >= indent + 2).map(shift)];
      items.push(mapping(local, 0, 0, depth + 1)[0]); index = after; continue;
    }
    items.push(scalar(rest, line.number)); index += 1;
  }
  return [items, index];
}

function mapping(lines: Line[], start: number, indent: number, depth: number): [{ [key: string]: Yaml }, number] {
  const result: { [key: string]: Yaml } = {};
  let index = start;
  while (index < lines.length && lines[index]!.indent === indent && lines[index]!.text !== '-' && !lines[index]!.text.startsWith('- ')) {
    const line = lines[index]!, match = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*(.*)$/.exec(line.text);
    if (!match) throw Error(`line ${line.number} is not a 'key: value' entry`);
    const [, key, rest] = match as unknown as [string, string, string];
    if (Object.hasOwn(result, key)) throw Error(`line ${line.number} repeats key '${key}'`);
    if (rest.startsWith('|') || rest.startsWith('>')) {
      const [nested, after] = children(lines, index + 1, indent);
      result[key] = blockScalar(nested, rest); index = after; continue;
    }
    if (rest) { result[key] = scalar(rest, line.number); index += 1; continue; }
    const [nested, after] = children(lines, index + 1, indent);
    result[key] = nested.length ? block(nested, 0, nested[0]!.indent, depth + 1)[0] : '';
    index = after;
  }
  return [result, index];
}

/** One service after normalization: runnable as a single shell command in the assessment image. */
export interface EnvironmentService { name: string; command: string; port?: number; healthcheck?: string; environment: Record<string, string> }
export interface EnvironmentRecipe {
  version: 1; source: 'compose' | 'explicit';
  /** The image every service and setup step runs in. Always the assessment sandbox image: there is no daemon to run another. */
  image: string;
  setup: string[]; services: EnvironmentService[]; seed: string[];
}
export interface ComposeResult { recipe?: EnvironmentRecipe; refused: string[] }

const SERVICE_KEYS = ['image', 'command', 'ports', 'environment', 'healthcheck', 'volumes', 'depends_on', 'restart', 'privileged', 'cap_add', 'devices', 'network_mode', 'pid', 'ipc', 'build', 'working_dir'];
const TOP_KEYS = ['version', 'name', 'services'];
const LOCAL_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,199}$/;
const NAMED_VOLUME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const asList = (value: Yaml | undefined): Yaml[] => value === undefined || value === '' ? [] : Array.isArray(value) ? value : [value];
const asText = (value: Yaml | undefined): string => Array.isArray(value) ? value.map(item => asText(item)).join(' ') : typeof value === 'string' ? value : '';

/**
 * Reads a compose document into a recipe, or names every reason it will not. A refusal is all-or-nothing: the caller records
 * nothing, so a half-understood file cannot become a running environment.
 */
export function readCompose(source: string, image: string): ComposeResult {
  if (typeof image !== 'string' || !LOCAL_IMAGE.test(image)) throw Error('Assessment image is not a plain image reference');
  let document: { [key: string]: Yaml };
  try {
    const lines = tokenize(source);
    document = block(lines, 0, lines[0]!.indent, 0)[0] as { [key: string]: Yaml };
  } catch (error) { return { refused: [`compose file ${(error as Error).message}`] }; }
  if (!isMap(document)) return { refused: ['compose file is not a mapping at the top level'] };
  const refused: string[] = [];
  for (const key of Object.keys(document)) if (!TOP_KEYS.includes(key)) refused.push(`top-level key '${key}' is not part of the supported compose subset`);
  const services = isMap(document.services) ? document.services : undefined;
  if (!services || !Object.keys(services).length) return { refused: [...refused, "compose file declares no 'services'"] };
  if (Object.keys(services).length > 8) refused.push(`compose file declares ${Object.keys(services).length} services; at most 8 can be verified`);
  const built: EnvironmentService[] = [], order = new Map<string, string[]>();
  for (const [name, raw] of Object.entries(services).sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/.test(name)) { refused.push(`service name '${name}' is not a plain identifier`); continue; }
    if (!isMap(raw)) { refused.push(`service '${name}' is not a mapping`); continue; }
    for (const key of Object.keys(raw)) if (!SERVICE_KEYS.includes(key)) refused.push(`service '${name}' sets '${key}', which this environment cannot translate`);
    // Policy refusals, each naming the exact key that was refused rather than dropping it.
    if (asText(raw.privileged) === 'true') refused.push(`service '${name}' sets privileged: true`);
    if (raw.cap_add !== undefined && asList(raw.cap_add).length) refused.push(`service '${name}' sets cap_add`);
    if (raw.devices !== undefined && asList(raw.devices).length) refused.push(`service '${name}' sets devices`);
    for (const key of ['network_mode', 'pid', 'ipc'] as const) if (asText(raw[key]) === 'host') refused.push(`service '${name}' sets ${key}: host`);
    if (['always', 'unless-stopped', 'on-failure'].includes(asText(raw.restart))) refused.push(`service '${name}' sets restart: ${asText(raw.restart)}`);
    if (raw.build !== undefined) refused.push(`service '${name}' builds an image; the sandbox has no Docker daemon, so pin an image and a command instead`);
    const declared = asText(raw.image);
    if (declared && declared !== image) refused.push(`service '${name}' requests image '${declared}'; this environment runs commands inside '${image}'`);
    for (const volume of asList(raw.volumes)) {
      const mount = asText(volume), source = mount.split(':')[0] ?? '';
      if (!NAMED_VOLUME.test(source)) refused.push(`service '${name}' mounts host path '${mount}'; only a named volume may be mounted`);
    }
    const command = asText(raw.command).trim();
    if (!command) { refused.push(`service '${name}' has no command to run`); continue; }
    const ports = asList(raw.ports).map(value => asText(value).trim()).filter(Boolean);
    const port = ports.length ? Number((ports[0]!.split('/')[0]!.split(':').at(-1) ?? '').trim()) : undefined;
    if (ports.length && (!Number.isInteger(port) || port! < 1 || port! > 65535)) refused.push(`service '${name}' has an unreadable port mapping '${ports[0]}'`);
    const health = isMap(raw.healthcheck) ? raw.healthcheck : undefined;
    const test = asList(health?.test).map(entry => asText(entry)).filter(Boolean);
    const healthcheck = test.length && test[0] !== 'NONE' ? test.filter(entry => !['CMD', 'CMD-SHELL', 'NONE'].includes(entry)).join(' ').trim() || undefined : undefined;
    const environment: Record<string, string> = {};
    if (Array.isArray(raw.environment)) for (const entry of raw.environment) { const [key, ...rest] = asText(entry).split('='); if (key) environment[key.trim()] = rest.join('='); }
    else for (const [key, value] of Object.entries(isMap(raw.environment) ? raw.environment : {})) environment[key] = asText(value);
    if (Object.keys(environment).length > 24) refused.push(`service '${name}' declares more than 24 environment entries`);
    order.set(name, asList(raw.depends_on).map(entry => asText(entry)));
    built.push({ name, command, ...(port !== undefined && Number.isInteger(port) ? { port } : {}), ...(healthcheck ? { healthcheck } : {}), environment });
  }
  if (refused.length) return { refused };
  return { recipe: { version: 1, source: 'compose', image, setup: [], services: orderServices(built, order), seed: [] }, refused: [] };
}

/** `depends_on` order first, then file order; a cycle falls back to the file order rather than spinning. */
function orderServices(services: EnvironmentService[], order: Map<string, string[]>): EnvironmentService[] {
  const byName = new Map(services.map(service => [service.name, service])), placed = new Set<string>(), result: EnvironmentService[] = [];
  const visit = (name: string, seen: Set<string>): void => {
    if (placed.has(name) || seen.has(name)) return;
    seen.add(name);
    for (const parent of order.get(name) ?? []) if (byName.has(parent)) visit(parent, seen);
    const service = byName.get(name);
    if (service && !placed.has(name)) { placed.add(name); result.push(service); }
  };
  for (const service of services) visit(service.name, new Set());
  return result;
}
