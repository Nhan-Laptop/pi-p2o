import { checkCancelled, invariant } from '../policy/errors.js';
import type { SourceEvidence, SourceFile } from './types.js';

/** Lexical static evidence, deliberately not an AST/taint engine or an execution environment. */
export function analyzeSourceFiles(files: readonly SourceFile[], contains?: string, signal?: AbortSignal): SourceEvidence {
  invariant(files.length > 0 && files.length <= 64, 'INVALID_INPUT', 'Source file count exceeded');
  let total = 0;
  const results = files.map(file => {
    checkCancelled(signal);
    total += Buffer.byteLength(file.text);
    invariant(total <= 4194304 && !file.text.includes('\u0000'), 'OUTPUT_LIMIT', 'Source must be bounded UTF-8 text');
    const lines = file.text.split(/\r?\n/);
    const imports = new Set<string>(), exports = new Set<string>();
    const routes: { method: string; path: string; line: number }[] = [];
    const matches: { line: number; text: string }[] = [];
    const indicators: { kind: string; line: number }[] = [];
    let privateKeyBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)) { privateKeyBlock = true; if (indicators.length < 128) indicators.push({ kind: 'possible-private-key-redacted-not-validated', line: i + 1 }); }
      // No caller-provided regex; key-block lines never become raw search excerpts.
      if (contains && line.includes(contains) && matches.length < 128) matches.push({ line: i + 1, text: privateKeyBlock ? '[REDACTED PRIVATE KEY LINE]' : line.slice(0, 512) });
      if (privateKeyBlock) { if (/-----END [A-Z ]*PRIVATE KEY-----/.test(line)) privateKeyBlock = false; continue; }
      for (const m of line.matchAll(/(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*(?:\(\s*)?)["']([^"']{1,256})["']/g)) if (imports.size < 128) imports.add(m[1]!);
      for (const m of line.matchAll(/\bexport\s+(?:async\s+)?(?:function|class|const|let|interface|type)\s+([a-zA-Z_$][\w$]*)/g)) if (exports.size < 128) exports.add(m[1]!);
      for (const m of line.matchAll(/\b(?:app|router|server)\.(get|head|post|put|patch|delete|options)\s*\(\s*["']([^"']{1,512})["']/gi)) if (routes.length < 128) routes.push({ method: m[1]!.toUpperCase(), path: m[2]!, line: i + 1 });
      if (indicators.length < 128 && /(?:password|secret|token|api[-_]?key)\s*[:=]\s*["'][^"']{4,}/i.test(line)) indicators.push({ kind: 'possible-hardcoded-secret-redacted-not-validated', line: i + 1 });
      if (indicators.length < 128 && /\b(?:eval|exec|execSync)\s*\(/.test(line)) indicators.push({ kind: 'dynamic-execution-review-required', line: i + 1 });
    }
    let dependencies: Record<string, string> = {};
    if (file.path.endsWith('package.json')) {
      try {
        const json = JSON.parse(file.text);
        if (json && typeof json === 'object') {
          const deps: Record<string, string> = {};
          for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
            const v = json[section];
            if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, value] of Object.entries(v).slice(0, 128)) if (typeof value === 'string') deps[`${section}:${k}`] = value.slice(0, 256);
          }
          dependencies = deps;
        }
      } catch { indicators.push({ kind: 'invalid-package-json', line: 1 }); }
    }
    return { path: file.path, sha256: file.sha256, bytes: Buffer.byteLength(file.text), lines: lines.length, imports: [...imports], exports: [...exports], routes, matches, indicators, dependencies };
  });
  return { kind: 'source', files: results, limits: ['Lexical observations may include comments/strings and miss dynamic routes.', 'No code execution, dependency resolution, AST/taint analysis or vulnerability confirmation.'] };
}
