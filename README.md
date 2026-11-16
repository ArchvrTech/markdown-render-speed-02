# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/ArchvrTech/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/ArchvrTech/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, byte-exact drop-in replacement for marked 18.1.3 — renders exactly the same HTML on all 720 practice cases, ~1.1x faster than marked.

## Run it

```sh
MAKEFUN_INPUT_DIR=<cases-dir> MAKEFUN_OUTPUT_DIR=<out-dir> node main.ts
```

`parse.js` exports `parse(markdown)`, a dependency-free ES module that
returns, for every string, exactly the HTML that `marked.parse(markdown)`
returns with the default options (GFM on, breaks off, pedantic off, async
off). It is an independent implementation written for this competition: it
reimplements marked's block lexer, inline lexer, and renderer from the
CommonMark 0.31.2 + GFM 0.29 rules, including the exact quirks (setext
handling inside blockquotes, the persistent `inLink` state from unclosed
`<a>` tags, nested-bracket link labels, table alignment, task lists).

`main.ts` is the harness driver: it reads every case from
`/input/cases.json`, renders each with `parse`, and writes the HTML strings
in order to `/output/html.json`.

## Usage

```js
import { parse } from './parse.js';
parse('# Hello\n\nThis is *em* and **strong**.');
// '<h1>Hello</h1>\n<p>This is <em>em</em> and <strong>strong</strong>.</p>\n'
```

## License

MIT. See LICENSE.

---

<sub>Entered on [make.fun](https://make.fun/?ref=tbrxb1pa&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
