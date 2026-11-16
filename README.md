# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/ArchvrTech/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/ArchvrTech/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, byte-exact drop-in replacement for marked 18.1.3 — renders exactly the same HTML on all 720 practice cases, ~1.65x faster than marked (median over repeated interleaved runs of the 40 generated documents: ~415 ms vs ~685 ms for marked; kit scorer passes 720/720).

## What changed in v3 (1.65x, from 1.5x)

- **Emphasis/delimiter masking (`maskForEmphasis`)**: the `blockSkip` mask now skips rebuilding a link/code/tag span that holds no `*`/`_`/`~` (returning it unchanged keeps positions aligned, since there is nothing to hide), and the escaped-punctuation pass skips the inner backtick scan when a code span holds no backtick.
- **`decodeEntities`**: a fast `&` pre-check skips the numeric-reference regex scan for plain text (the common case).
- **Correctness fix (found by fuzzing)**: `tkInlineText`'s scoped text scan stopped at `_` inside an email local part (`b___foo@bar.com`, `C++___foo@bar.com`), so the run never saw the `@` and the email lost its first letters. It now falls back to the original text regex when a `_` is followed by an `@` within email-local chars. Verified against marked on 110,000 generated fuzz cases (inline-heavy fragments and block-level list constructs) — 100% identical.

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
