// Driver for the markdown-render-speed-02 entry.
// The harness runs `node /bot/main.ts` (Node 22). It reads every case from
// /input/cases.json (a JSON array of {id, markdown}), renders each one alone
// with parse() from ./parse.js, and writes /output/html.json: a JSON array of
// the HTML strings, one per case and in the cases' order. Outside a container
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output;
// positional arguments `node main.ts [inputDir] [outputDir]` override them,
// which makes local runs (`node main.ts practice/input out`) shorter to type.
//
// The input is accepted as either a bare array or an object with a `cases`
// key (the kit's reference files use the latter shape), so the driver works
// unchanged against the practice set, the scored set, and a hand-made file.

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.argv[2] || process.env.MAKEFUN_INPUT_DIR || '/input';
const outputDir = process.argv[3] || process.env.MAKEFUN_OUTPUT_DIR || '/output';

// Read and normalise the case list. Every case must carry its markdown as
// a string; anything else is a malformed input file, not a render decision.
function readCases() {
  const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
  const data = JSON.parse(raw);
  const cases = Array.isArray(data) ? data : data.cases;
  if (!Array.isArray(cases)) {
    throw new Error('cases.json must be a JSON array or an object with a cases array');
  }
  for (let i = 0; i < cases.length; i++) {
    if (typeof cases[i].markdown !== 'string') {
      throw new Error(`case ${i} has no markdown string`);
    }
  }
  return cases;
}

// Render every case in order. The output array is preallocated so the
// result has exactly one entry per case, in the cases' order, even for an
// empty input. Each render must be a string; a non-string is a bug in the
// parser, not a render decision, so fail loudly instead of writing a
// malformed html.json that would score zero.
function renderCases(cases) {
  const out = new Array(cases.length);
  for (let i = 0; i < cases.length; i++) {
    const html = parse(cases[i].markdown);
    if (typeof html !== 'string') {
      throw new Error(`case ${i} (${cases[i].id ?? '?'}) did not render to a string`);
    }
    out[i] = html;
  }
  return out;
}

function main() {
  const cases = readCases();
  const t0 = Date.now();
  const inBytes = cases.reduce((n, c) => n + c.markdown.length, 0);
  const out = renderCases(cases);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'html.json'), JSON.stringify(out));
  const outBytes = statSync(join(outputDir, 'html.json')).size;
  // A one-line summary on stderr: the harness only reads html.json, so
  // this never touches the scored output.
  console.error(`rendered ${out.length} cases in ${Date.now() - t0} ms (${inBytes} input bytes -> ${outBytes} output bytes) -> ${join(outputDir, 'html.json')}`);
}

main();
