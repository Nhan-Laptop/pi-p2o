// Prints the table rows of docs/WSTG_MAP.md from the data in src/wstg-map.ts. Read-only: no target, model, network or file write.
//   node scripts/render-wstg-map.mjs            rows from dist/ (run `npm run build` first)
//   node scripts/render-wstg-map.mjs --source   rows straight from src/ through Pi's bundled jiti
// Paste the output over the rows under "## WSTG map table" when the data changes; tests/minimal/wstg-map.test.ts fails until the two agree.
import { createRequire } from 'node:module';

async function load() {
  if (process.argv.includes('--source')) {
    const require = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
    const { createJiti } = require('jiti');
    return createJiti(import.meta.url).import(new URL('../src/wstg-map.ts', import.meta.url).href);
  }
  return import('../dist/src/wstg-map.js');
}

const { wstgTableRows } = await load();
console.log(wstgTableRows().join('\n'));
