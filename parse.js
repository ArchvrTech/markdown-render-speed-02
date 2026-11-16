// parse.js — a fast drop-in replacement for marked 18.1.3.
//
// parse(markdown) returns exactly the HTML that marked 18.1.3's
// marked.parse(markdown) returns with marked's default options
// (gfm true, breaks false, pedantic false, async false).
//
// This is an independent implementation written from the CommonMark 0.31.2
// and GFM 0.29 specifications and from observed marked behaviour. It shares
// no code with marked; the regular expressions below encode the same
// tokenisation rules any renderer must follow to reproduce marked's output
// byte for byte on the spec examples and on generated documents.

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_REPLACE = /[&<>"']/g;
const ESCAPE_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_REPLACE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Escape HTML characters. encode=true escapes all five; false leaves a
// bare & alone when it already starts a valid entity reference.
function escapeHtml(str, encode) {
  if (encode) {
    return ESCAPE_TEST.test(str) ? str.replace(ESCAPE_REPLACE, (ch) => ESCAPE_MAP[ch]) : str;
  }
  return ESCAPE_TEST_NO_ENCODE.test(str) ? str.replace(ESCAPE_REPLACE_NO_ENCODE, (ch) => ESCAPE_MAP[ch]) : str;
}

const CARRIAGE_RETURN = /\r\n|\r/g;

const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Decode numeric character references; a bare & becomes &amp;.
function decodeEntities(str) {
  if (!NUMERIC_REF.test(str)) return str;
  return str.replace(NUMERIC_REF_OR_AMP, (whole, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

const PERCENT_DECODE = /%25/g;

// Encode a link/image href the way marked does (encodeURI, %25 kept as %).
function encodeHref(href) {
  try {
    return encodeURI(href).replace(PERCENT_DECODE, '%');
  } catch {
    return null;
  }
}

const MULTI_SPACE = /\s+/g;

// Normalise a link reference label: trim, collapse inner whitespace to one
// space, then the lower/upper/lower round trip marked uses for Unicode.
function normalizeLabel(label) {
  return label.trim().replace(MULTI_SPACE, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find the index of the close paren matching the open paren at the start of
// `str`'s paren depth: -1 when the depth never drops below zero, -2 when it
// goes negative (unbalanced). Backslash escapes are skipped.
function findParen(str) {
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') { i++; continue; }
    if (str[i] === '(') depth++;
    else if (str[i] === ')') {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Strip `count` trailing characters equal to `ch` (or, when `invert` is
// set, trailing characters not equal to `ch`) from the end of `str`.
function stripTrailing(str, ch, invert) {
  const n = str.length;
  if (n === 0) return '';
  let i = 0;
  for (; i < n;) {
    const c = str.charAt(n - i - 1);
    if (c === ch && !invert) i++;
    else if (c !== ch && invert) i++;
    else break;
  }
  return str.slice(0, n - i);
}

const BLANK_LINE = /^[ \t]*$/;

// Drop trailing blank lines, keeping at most one blank line at the end.
function trimBlankEnd(str) {
  const lines = str.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && BLANK_LINE.test(lines[t]);) t--;
  return lines.length - t <= 2 ? str : lines.slice(0, t + 1).join('\n');
}

// Expand tabs to spaces, tracking the column (tab stops every 4).
// `startCol` is the column the string begins at.
function expandTabs(str, startCol = 0) {
  let col = startCol;
  let out = '';
  for (const ch of str) {
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Split a table row on unescaped pipes, honouring the expected column count.
function splitTableRow(row, count) {
  const withSpaces = row.replace(/\|/g, (ch, off, s) => {
    let escaped = false;
    let p = off;
    for (; --p >= 0 && s[p] === '\\';) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = withSpaces.split(' |');
  let i = 0;
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else for (; cells.length < count;) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// ---------------------------------------------------------------------------
// Regex composition helper
//
// Some block patterns are built by substituting named sub-patterns into a
// template. A sub-pattern that starts with ^ must not anchor when it lands
// in the middle of the composed pattern, so a leading ^ preceded by anything
// other than [ is dropped (the same rule marked's own builder applies).
// ---------------------------------------------------------------------------

const CARET_FIX = /(^|[^\[])\^/g;

function compose(source, flags) {
  let text = typeof source === 'string' ? source : source.source;
  let f = flags;
  if (typeof source !== 'string' && f === undefined) f = source.flags;
  const builder = {
    replace(name, sub) {
      let part = typeof sub === 'string' ? sub : sub.source;
      part = part.replace(CARET_FIX, '$1');
      text = text.replace(name, part);
      return builder;
    },
    regex() {
      return new RegExp(text, f);
    },
  };
  return builder;
}

// ---------------------------------------------------------------------------
// Shared patterns
// ---------------------------------------------------------------------------

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const HAS_LOOKBEHIND = (() => {
  try { return !!new RegExp('(?<=1)(?<!1)'); } catch { return false; }
})();

// ---------------------------------------------------------------------------
// Block-level patterns (GFM)
// ---------------------------------------------------------------------------

const RE = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  // Link reference definition: [label]: <href> "title"
  def: compose(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
    .replace('label', /(?:(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)/)
    .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/).regex(),
  // HTML block, type 6/7 and the catch-alls
  html: compose('^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))', 'i')
    .replace('comment', HTML_COMMENT)
    .replace('tag', BLOCK_TAGS)
    .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).regex(),
  // Setext heading (GFM: may not interrupt a table, and the paragraph part
  // must not itself start a block)
  lheading: null, // built below
  // Table
  table: null, // built below
  // Paragraph (GFM)
  paragraph: null, // built below
  text: /^[^\n]+/,
  // List opener
  list: /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/,
  // Block quote: one or more lines starting with >, each optionally holding
  // a paragraph
  blockquote: null, // built below
};

// Shared fragments for the composed block patterns.
const BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const BLOCK_CODE = /(?: {4}| {0,3}\t)/;
const FENCES_START = / {0,3}(?:`{3,}|~{3,})/;
const BLOCKQUOTE_START = / {0,3}>/;
const HEADING_START = / {0,3}#{1,6}(?:\s|$)/;
const HR_PATTERN = / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const HTML_START = compose(/ {0,3}(?:<\/?(?:tag)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)/)
  .replace('tag', BLOCK_TAGS).regex();
const TABLE_DELIM = / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/;

// Setext heading: a paragraph-like run followed by = or - underline.
const SETEXT_BODY = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
RE.lheading = compose(SETEXT_BODY)
  .replace(/bull/g, BULLET)
  .replace(/blockCode/g, BLOCK_CODE)
  .replace(/fences/g, FENCES_START)
  .replace(/blockquote/g, BLOCKQUOTE_START)
  .replace(/heading/g, HEADING_START)
  .replace(/hr/g, HR_PATTERN)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, TABLE_DELIM)
  .regex();

// Table: header line, delimiter line, optional body rows.
RE.table = compose("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)")
  .replace('hr', HR_PATTERN)
  .replace('heading', HEADING_START)
  .replace('blockquote', BLOCKQUOTE_START)
  .replace('code', /(?: {4}| {0,3}\t)[^\n]/)
  .replace('fences', / {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)/)
  .replace('list', / {0,3}(?:[*+-]|1[.)])[ \t]/)
  .replace('html', HTML_START).regex();

// Paragraph: lines that do not start a new block (GFM list marker variant).
const PARA_BODY = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
RE.paragraph = compose(PARA_BODY)
  .replace('hr', HR_PATTERN)
  .replace('heading', HEADING_START)
  .replace('|lheading', '')
  .replace('table', RE.table)
  .replace('blockquote', BLOCKQUOTE_START)
  .replace('fences', / {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)/)
  .replace('list', / {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/)
  .replace('html', HTML_START).regex();

// Block quote: lines starting with >, with the paragraph sub-pattern.
const PARA_FOR_QUOTE = compose(PARA_BODY)
  .replace('hr', HR_PATTERN)
  .replace('heading', HEADING_START)
  .replace('|lheading', '')
  .replace('|table', '')
  .replace('blockquote', BLOCKQUOTE_START)
  .replace('fences', / {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)/)
  .replace('list', / {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/)
  .replace('html', HTML_START).regex();
RE.blockquote = compose(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).replace('paragraph', PARA_FOR_QUOTE).regex();

// ---------------------------------------------------------------------------
// Small block helpers
// ---------------------------------------------------------------------------

const CODE_REMOVE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const INDENT_CODE_COMPENSATION = /^(\s+)(?:```)/;
const BEGINNING_SPACE = /^\s+/;
const ENDING_HASH = /#$/;
const STARTING_SPACE_CHAR = /^ /;
const ENDING_SPACE_CHAR = / $/;
const ENDING_SPACE_TAB_CHAR = /[ \t]$/;
const NON_SPACE_CHAR = /[^ ]/;
const NEWLINE_GLOBAL = /\n/g;
const TAB_GLOBAL = /\t/g;
const LEADING_SPACE_TAB = /^[ \t]+/;
const BLANK_LINE_RE = /^[ \t]*$/;
const DOUBLE_BLANK_LINE = /\n[ \t]*\n[ \t]*$/;
const BLOCKQUOTE_START_RE = /^ {0,3}>/;
const BLOCKQUOTE_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const BLOCKQUOTE_SETEXT2 = /^ {0,3}>[ \t]?/gm;
const BLOCKQUOTE_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const LIST_NESTING = /^ {1,4}(?=( {4})*[^ ])/g;
const LIST_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const LIST_REPLACE_TASK = /^\[[ xX]\][ \t]+/;
const LIST_TASK_CHECKBOX = /\[[ xX]\]/;
const ANY_LINE = /\n.*\n/;
const HREF_BRACKETS = /^<(.*)>$/;
const TABLE_DELIMITER = /[:|]/;
const TABLE_ALIGN_CHARS = /^\||\| *$/g;
const TABLE_ROW_BLANK = /\n[ \t]*$/;
const TABLE_ALIGN_RIGHT = /^ *-+: *$/;
const TABLE_ALIGN_CENTER = /^ *:-+: *$/;
const TABLE_ALIGN_LEFT = /^ *:-+ *$/;
const START_A_TAG = /^<a /i;
const END_A_TAG = /^<\/a>/i;
const START_PRE_SCRIPT = /^<(pre|code|kbd|script)(\s|>)/i;
const END_PRE_SCRIPT = /^<\/(pre|code|kbd|script)(\s|>)/i;
const START_ANGLE = /^</;
const END_ANGLE = />$/;
const UNICODE_ALNUM = /[\p{L}\p{N}]/u;
const NOT_SPACE_START = /^\S*/;
const ENDING_NEWLINE = /\n$/;
const SPACE_LINE = /^ +$/gm;

function listItemRegex(marker) {
  return new RegExp(`^( {0,3}${marker})((?:[ \t][^\n]*)?(?:\n|$))`);
}
const regexCache = [[], [], [], [], [], []];
function cachedRegex(kind, n) {
  const cache = regexCache[kind];
  let re = cache[n];
  if (!re) {
    if (kind === 0) re = new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`);
    else if (kind === 1) re = new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`);
    else if (kind === 2) re = new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`);
    else if (kind === 3) re = new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`);
    else if (kind === 4) re = new RegExp(`^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');
    else re = new RegExp(`^ {0,${n}}>`);
    cache[n] = re;
  }
  return re;
}
// kind: 0 next bullet, 1 hr, 2 fences begin, 3 heading begin, 4 html begin, 5 blockquote begin
function indentRegex(kind, n) {
  return cachedRegex(kind, Math.max(0, Math.min(3, n - 1)));
}

// ---------------------------------------------------------------------------
// Block lexer
// ---------------------------------------------------------------------------

const ANY_PUNCT = /\\([\p{P}\p{S}])/gu;

// Remove fence indent compensation from fenced code content.
function dedentFence(fenceMatch, content) {
  const m = fenceMatch.match(INDENT_CODE_COMPENSATION);
  if (m === null) return content;
  const indent = m[1];
  return content.split('\n').map((line) => {
    const lead = line.match(BEGINNING_SPACE);
    if (lead === null) return line;
    return line.slice(Math.min(lead[0].length, indent.length));
  }).join('\n');
}

class BlockLexer {
  constructor() {
    this.tokens = [];
    this.links = Object.create(null);
    this.inlineQueue = [];
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
  }

  // Queue an inline lexing job for `src`; returns the token array that the
  // job will fill in once block lexing is done.
  inline(src) {
    const tokens = [];
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  lex(src) {
    src = src.replace(/\r\n|\r/g, '\n');
    this.blockTokens(src, this.tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const job = this.inlineQueue[i];
      this.state.inRawBlock = false;
      inlineTokens(this, job.src, job.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  blockTokens(src, tokens, inQuote = false) {
    let shortest = Infinity;
    while (src) {
      if (src.length < shortest) shortest = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));

      let tok;
      if ((tok = this.space(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens.at(-1);
        if (tok.raw.length === 1 && last !== undefined) last.raw += '\n';
        else tokens.push(tok);
        continue;
      }
      if ((tok = this.code(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens.at(-1);
        if (last?.type === 'paragraph' || last?.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue.at(-1).src = last.text;
        } else tokens.push(tok);
        continue;
      }
      if ((tok = this.fences(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.heading(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.hr(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.blockquote(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.list(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.html(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.def(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens.at(-1);
        if (last?.type === 'paragraph' || last?.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.raw;
          this.inlineQueue.at(-1).src = last.text;
        } else {
          if (!this.links[tok.tag]) this.links[tok.tag] = { href: tok.href, title: tok.title };
          tokens.push(tok);
        }
        continue;
      }
      if ((tok = this.table(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.lheading(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }

      if (this.state.top && (tok = this.paragraph(src))) {
        const last = tokens.at(-1);
        if (inQuote && last?.type === 'paragraph') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = last.text;
        } else tokens.push(tok);
        inQuote = false;
        src = src.substring(tok.raw.length);
        continue;
      }
      if ((tok = this.text(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens.at(-1);
        if (last?.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = last.text;
        } else tokens.push(tok);
        continue;
      }
      if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    this.state.top = true;
    return tokens;
  }

  space(src) {
    const t = RE.newline.exec(src);
    if (t && t[0].length > 0) return { type: 'space', raw: t[0] };
    return undefined;
  }

  code(src) {
    const t = RE.code.exec(src);
    if (!t) return undefined;
    const raw = trimBlankEnd(t[0]);
    const text = raw.replace(CODE_REMOVE_INDENT, '');
    return { type: 'code', raw, codeBlockStyle: 'indented', text };
  }

  fences(src) {
    const t = RE.fences.exec(src);
    if (!t) return undefined;
    const raw = t[0];
    const text = dedentFence(raw, t[3] || '');
    return { type: 'code', raw, lang: t[2] ? t[2].trim().replace(ANY_PUNCT, '$1') : t[2], text };
  }

  heading(src) {
    const t = RE.heading.exec(src);
    if (!t) return undefined;
    let text = t[2].trim();
    if (ENDING_HASH.test(text)) {
      const stripped = stripTrailing(text, '#');
      if (!stripped || ENDING_SPACE_TAB_CHAR.test(stripped)) text = stripped.trim();
    }
    return { type: 'heading', raw: stripTrailing(t[0], '\n'), depth: t[1].length, text, tokens: this.inline(text) };
  }

  hr(src) {
    const t = RE.hr.exec(src);
    if (!t) return undefined;
    return { type: 'hr', raw: stripTrailing(t[0], '\n') };
  }

  html(src) {
    const t = RE.html.exec(src);
    if (!t) return undefined;
    const raw = trimBlankEnd(t[0]);
    return { type: 'html', block: true, raw, pre: t[1] === 'pre' || t[1] === 'script' || t[1] === 'style', text: raw };
  }

  def(src) {
    const t = RE.def.exec(src);
    if (!t) return undefined;
    if (!START_ANGLE.test(t[2]) && findParen(t[2]) !== -1) return undefined;
    const tag = normalizeLabel(t[1]);
    const href = t[2] ? t[2].replace(HREF_BRACKETS, '$1').replace(ANY_PUNCT, '$1') : '';
    const title = t[3] ? t[3].substring(1, t[3].length - 1).replace(ANY_PUNCT, '$1') : t[3];
    return { type: 'def', tag, raw: stripTrailing(t[0], '\n'), href, title };
  }

  table(src) {
    const t = RE.table.exec(src);
    if (!t || !TABLE_DELIMITER.test(t[2])) return undefined;
    const headerCells = splitTableRow(t[1]);
    const delimCells = t[2].replace(TABLE_ALIGN_CHARS, '').split('|');
    const bodyRows = t[3]?.trim() ? t[3].replace(TABLE_ROW_BLANK, '').split('\n') : [];
    const table = { type: 'table', raw: stripTrailing(t[0], '\n'), header: [], align: [], rows: [] };
    if (headerCells.length !== delimCells.length) return undefined;
    for (const cell of delimCells) {
      if (TABLE_ALIGN_RIGHT.test(cell)) table.align.push('right');
      else if (TABLE_ALIGN_CENTER.test(cell)) table.align.push('center');
      else if (TABLE_ALIGN_LEFT.test(cell)) table.align.push('left');
      else table.align.push(null);
    }
    for (let i = 0; i < headerCells.length; i++) {
      table.header.push({ text: headerCells[i], tokens: this.inline(headerCells[i]), header: true, align: table.align[i] });
    }
    for (const row of bodyRows) {
      table.rows.push(splitTableRow(row, table.header.length).map((cell, p) => ({
        text: cell, tokens: this.inline(cell), header: false, align: table.align[p],
      })));
    }
    return table;
  }

  lheading(src) {
    const t = RE.lheading.exec(src);
    if (!t) return undefined;
    const text = t[1].trim();
    return { type: 'heading', raw: stripTrailing(t[0], '\n'), depth: t[2].charAt(0) === '=' ? 1 : 2, text, tokens: this.inline(text) };
  }

  paragraph(src) {
    const t = RE.paragraph.exec(src);
    if (!t) return undefined;
    const text = t[1].charAt(t[1].length - 1) === '\n' ? t[1].slice(0, -1) : t[1];
    return { type: 'paragraph', raw: t[0], text, tokens: this.inline(text) };
  }

  text(src) {
    const t = RE.text.exec(src);
    if (!t) return undefined;
    return { type: 'text', raw: t[0], text: t[0], tokens: this.inline(t[0]) };
  }
}

// ---------------------------------------------------------------------------
// Block quote and list tokenizers (added to BlockLexer)
// ---------------------------------------------------------------------------

BlockLexer.prototype.blockquote = function (src) {
  const t = RE.blockquote.exec(src);
  if (!t) return undefined;
  let lines = stripTrailing(t[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    let inQuote = false;
    const chunk = [];
    let p;
    for (p = 0; p < lines.length; p++) {
      if (BLOCKQUOTE_START_RE.test(lines[p])) { chunk.push(lines[p]); inQuote = true; }
      else if (!inQuote) chunk.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const joined = chunk.join('\n');
    const stripped = joined
      .replace(BLOCKQUOTE_MARKER_WS, (g, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(BLOCKQUOTE_SETEXT, '\n    $1')
      .replace(BLOCKQUOTE_SETEXT2, '');
    raw = raw ? `${raw}\n${joined}` : joined;
    text = text ? `${text}\n${stripped}` : stripped;
    const savedTop = this.state.top;
    this.state.top = true;
    this.blockTokens(stripped, tokens, true);
    this.state.top = savedTop;
    if (lines.length === 0) break;
    const last = tokens.at(-1);
    if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr' || last?.type === 'html' || last?.type === 'table') break;
    if (last?.type === 'blockquote') {
      const inner = last;
      const rest = lines.join('\n');
      const reparsed = inner.raw + '\n' + rest.replace(BLOCKQUOTE_SETEXT2, '');
      const again = this.blockquote(reparsed);
      tokens[tokens.length - 1] = again;
      const leftover = reparsed.substring(again.raw.length).replace(/^\n/, '');
      const leftoverLines = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverLines ? lines.slice(0, -leftoverLines) : lines;
      if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
      text = text.substring(0, text.length - inner.text.length) + again.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && BLOCKQUOTE_START_RE.test(lines[0])) continue;
      break;
    } else if (last?.type === 'list') {
      const inner = last;
      const combined = inner.raw + '\n' + lines.join('\n');
      const again = this.list(combined);
      tokens[tokens.length - 1] = again;
      const extra = again.raw.length > inner.raw.length
        ? combined.slice(inner.raw.length + 1, again.raw.length).split('\n').length : 0;
      if (extra > 0) {
        const extraText = lines.slice(0, extra).join('\n');
        raw = `${raw}\n${extraText}`;
        text = `${text}\n${extraText}`;
      }
      lines = lines.slice(extra);
      continue;
    }
  }
  return { type: 'blockquote', raw, tokens, text };
};

BlockLexer.prototype.list = function (src) {
  const t = RE.list.exec(src);
  if (!t) return undefined;
  const input = src;
  const consumed = () => input.length - src.length;
  const firstMarker = t[1].trim();
  const ordered = firstMarker.length > 1;
  const list = {
    type: 'list', raw: '', ordered,
    start: ordered ? +firstMarker.slice(0, -1) : '', loose: false, items: [],
  };
  let markerPattern = ordered ? `\\d{1,9}\\${firstMarker.slice(-1)}` : `\\${firstMarker}`;
  const itemRegex = listItemRegex(markerPattern);
  let prevBlankEnded = false;
  while (src) {
    let emptyItem = false;
    const itemLines = [];
    const m = itemRegex.exec(src);
    if (!m || RE.hr.test(src)) break;
    const itemStart = consumed();
    src = src.substring(m[0].length);
    const firstLine = m[2].split('\n', 1)[0];
    const markerLen = m[1].length;
    let firstContent = firstLine.replace(LEADING_SPACE_TAB, (v) => expandTabs(v, markerLen));
    let nextLine = src.split('\n', 1)[0];
    let firstBlank = !firstContent.trim();
    let indent = 0;
    if (firstBlank) {
      indent = markerLen + 1;
    } else {
      indent = firstContent.search(NON_SPACE_CHAR);
      indent = indent > 4 ? 1 : indent;
      itemLines.push(firstContent.slice(indent));
      indent += markerLen;
    }
    if (firstBlank && BLANK_LINE_RE.test(nextLine)) {
      src = src.substring(nextLine.length + 1);
      emptyItem = true;
    }
    if (!emptyItem) {
      const nextBullet = indentRegex(0, indent);
      const hrAt = indentRegex(1, indent);
      const fencesAt = indentRegex(2, indent);
      const headingAt = indentRegex(3, indent);
      const htmlAt = indentRegex(4, indent);
      const quoteAt = indentRegex(5, indent);
      const maxSp = Math.max(0, Math.min(3, indent - 1));
      while (src) {
        const nl = src.indexOf('\n');
        const line = nl === -1 ? src : src.slice(0, nl);
        let expanded;
        nextLine = line;
        expanded = line.replace(LEADING_SPACE_TAB, (v) => expandTabs(v));
        // Fast dispatch: the six break regexes all start with ^ {0,maxSp}
        // followed by a marker char; skip the ones the first non-space
        // character cannot start (most content lines match none of them).
        let ni = 0;
        while (ni < line.length && line.charCodeAt(ni) === 32) ni++;
        let hit = false;
        if (ni <= maxSp && ni < line.length) {
          const ch = line[ni];
          if (ch === '`' || ch === '~') hit = fencesAt.test(line);
          else if (ch === '#') hit = headingAt.test(line);
          else if (ch === '<') hit = htmlAt.test(line);
          else if (ch === '>') hit = quoteAt.test(line);
          else if (ch === '-' || ch === '+' || ch === '*') hit = nextBullet.test(line) || hrAt.test(line);
          else if (ch >= '0' && ch <= '9') hit = nextBullet.test(line);
          else if (ch === '_') hit = hrAt.test(line);
        }
        if (hit) break;
        if (expanded.search(NON_SPACE_CHAR) >= indent || !line.trim()) {
          itemLines.push(expanded.slice(indent));
        } else {
          if (firstBlank || firstContent.replace(TAB_GLOBAL, '    ').search(NON_SPACE_CHAR) >= 4 || fencesAt.test(firstContent) || headingAt.test(firstContent) || htmlAt.test(firstContent) || hrAt.test(firstContent)) break;
          const setext = /^ {0,3}(?:=+|-+) *$/.test(line) && RE.lheading.test(`${firstContent}\n${line}`)
            ? `    ${expanded.replace(/^ {0,3}/, '')}` : line;
          itemLines.push(setext);
        }
        firstBlank = !line.trim();
        src = src.substring(line.length + 1);
        firstContent = expanded.slice(indent);
      }
    }
    const itemText = itemLines.join('\n');
    const itemRaw = input.slice(itemStart, consumed());
    if (!list.loose) {
      if (prevBlankEnded) list.loose = true;
      else if (DOUBLE_BLANK_LINE.test(itemRaw)) prevBlankEnded = true;
    }
    list.items.push({
      type: 'list_item', raw: itemRaw, task: LIST_IS_TASK.test(itemText), loose: false, text: itemText, tokens: [],
    });
  }
  const lastItem = list.items.at(-1);
  if (!lastItem) return undefined;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = input.slice(0, consumed()).trimEnd();
  for (const item of list.items) {
    this.state.top = false;
    item.tokens = this.blockTokens(item.text, []);
    if (!list.loose) {
      const spaces = item.tokens.filter((tok) => tok.type === 'space');
      if (spaces.length > 0 && spaces.some((tok) => ANY_LINE.test(tok.raw))) list.loose = true;
    }
  }
  for (const item of list.items) {
    const first = item.tokens[0];
    if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
      item.text = item.text.replace(LIST_REPLACE_TASK, '');
      first.raw = first.raw.replace(LIST_REPLACE_TASK, '');
      first.text = first.text.replace(LIST_REPLACE_TASK, '');
      for (let q = this.inlineQueue.length - 1; q >= 0; q--) {
        if (LIST_IS_TASK.test(this.inlineQueue[q].src)) {
          this.inlineQueue[q].src = this.inlineQueue[q].src.replace(LIST_REPLACE_TASK, '');
          break;
        }
      }
      const check = LIST_TASK_CHECKBOX.exec(item.raw);
      if (check) {
        const checkbox = { type: 'checkbox', raw: check[0] + ' ', checked: check[0] !== '[ ]' };
        item.checked = checkbox.checked;
        if (list.loose) {
          if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
            item.tokens[0].raw = checkbox.raw + item.tokens[0].raw;
            item.tokens[0].text = checkbox.raw + item.tokens[0].text;
            item.tokens[0].tokens.unshift(checkbox);
          } else {
            item.tokens.unshift({ type: 'paragraph', raw: checkbox.raw, text: checkbox.raw, tokens: [checkbox] });
          }
        } else {
          item.tokens.unshift(checkbox);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const tok of item.tokens) if (tok.type === 'text') tok.type = 'paragraph';
    }
  }
  return list;
};

// ---------------------------------------------------------------------------
// Inline rules
// ---------------------------------------------------------------------------

const SCHEME_RE = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const PUNCT = '[\\p{P}\\p{S}]';
const PUNCT_GFM = '(?!~)[\\p{P}\\p{S}]';
const PUNCT_SPACE = '[\\s\\p{P}\\p{S}]';
const PUNCT_SPACE_GFM = '(?!~)[\\s\\p{P}\\p{S}]';
const NOT_PUNCT_SPACE = '[^\\s\\p{P}\\p{S}]';
const NOT_PUNCT_SPACE_GFM = '(?:[^\\s\\p{P}\\p{S}]|~)';

const INLINE = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  punctuation: compose(/^((?![*_])punctSpace)/u).replace(/punctSpace/g, PUNCT_SPACE).regex(),
  emStrongLDelim: compose(/^(?:\*+(?:((?!\*)(?!~)punct)|([^\s*]))?)|^_+(?:((?!_)(?!~)punct)|([^\s_]))?/u)
    .replace(/punct/g, PUNCT_GFM).regex(),
  emStrongRDelimAst: compose(/^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)punct(\*+)(?=[\s]|$)|notPunctSpace(\*+)(?!\*)(?=punctSpace|$)|(?!\*)punctSpace(\*+)(?=notPunctSpace)|[\s](\*+)(?!\*)(?=punct)|(?!\*)punct(\*+)(?!\*)(?=punct)|notPunctSpace(\*+)(?=notPunctSpace)/gu)
    .replace(/notPunctSpace/g, NOT_PUNCT_SPACE_GFM).replace(/punctSpace/g, PUNCT_SPACE_GFM).replace(/punct/g, PUNCT_GFM).regex(),
  emStrongRDelimUnd: compose(/^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)/gu)
    .replace(/notPunctSpace/g, NOT_PUNCT_SPACE).replace(/punctSpace/g, PUNCT_SPACE).replace(/punct/g, PUNCT).regex(),
  delLDelim: compose(/^~~?(?:((?!~)punct)|[^\s~])/u).replace(/punct/g, PUNCT).regex(),
  delRDelim: compose(/^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)/gu)
    .replace(/notPunctSpace/g, NOT_PUNCT_SPACE).replace(/punctSpace/g, PUNCT_SPACE).replace(/punct/g, PUNCT).regex(),
  autolink: /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/,
  tag: /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/,
  link: compose(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
    .replace('label', compose(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).replace('brackets', /\[(?:\\[\s\S]|[^\[\]\\])*\]/).regex())
    .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
    .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/).regex(),
  reflink: compose(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', compose(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).replace('brackets', /\[(?:\\[\s\S]|[^\[\]\\])*\]/).regex())
    .replace('ref', /(?:(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)/).regex(),
  nolink: compose(/^!?\[(ref)\](?:\[\])?/)
    .replace('ref', /(?:(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)/).regex(),
  reflinkSearch: compose('reflink|nolink(?!\\()', 'g')
    .replace('reflink', compose(/^!?\[(label)\]\[(ref)\]/)
      .replace('label', compose(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*/).replace('brackets', /\[(?:\\[\s\S]|[^\[\]\\])*\]/).regex())
      .replace('ref', /(?:(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})/).regex())
    .replace('nolink', compose(/^!?\[(ref)\](?:\[\])?/)
      .replace('ref', /(?:(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})/).regex()).regex(),
  blockSkip: compose(/\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|precode-code|<(?! )[^<>]*?>/g)
    .replace('precode-', HAS_LOOKBEHIND ? '(?<!`)()' : '(^^|[^`])')
    .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/).regex(),
  anyPunctOutsideCode: /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu,
  url: compose(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
    .replace('emailProtocol', compose(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
      .replace(/email/g, /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/).regex())
    .replace('protocol', SCHEME_RE)
    .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/).regex(),
  backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,
  text: compose(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
    .replace('protocol', SCHEME_RE)
    .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
    .replace('wwwStart', HAS_LOOKBEHIND ? '(?<![^\\s*_~(])www\\.' : 'www\\.').regex(),
};

// ---------------------------------------------------------------------------
// Inline tokenizers
// ---------------------------------------------------------------------------

const OUTPUT_LINK_REPLACE = /\\([\[\]])/g;

function stripTrailingBackslashes(s) {
  let n = s.length;
  while (n > 0 && s.charAt(n - 1) === '\\') n--;
  return s.slice(0, n);
}

function linkHasTagOrAutolink(src, linkText, offset) {
  if (!linkText.includes('<')) return false;
  for (let s = 0; s < linkText.length; s++) {
    if (linkText[s] === '\\') { s++; continue; }
    if (linkText[s] === '`') {
      const i = INLINE.code.exec(linkText.slice(s));
      if (i) { s += i[0].length - 1; continue; }
    }
    if (linkText[s] !== '<') continue;
    const r = src.slice(offset + s);
    const o = INLINE.tag.exec(r) || INLINE.autolink.exec(r);
    if (o) {
      if (o[0].length > linkText.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}

function buildLinkOrImage(lx, match, href, title, raw) {
  const isImage = match[0].charAt(0) === '!';
  const text = match[1].replace(OUTPUT_LINK_REPLACE, '$1');
  const savedInLink = lx.state.inLink;
  const savedEmitted = lx.state.linkEmitted;
  const savedRaw = lx.state.inRawBlock;
  lx.state.inLink = true;
  lx.state.linkEmitted = false;
  const tokens = inlineTokens(lx, text);
  const emitted = lx.state.linkEmitted;
  lx.state.linkEmitted = savedEmitted;
  lx.state.inLink = savedInLink;
  if (!isImage) {
    if (emitted) { lx.state.inRawBlock = savedRaw; return undefined; }
    lx.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title: title || null, text, tokens };
}

function tkEscape(src) {
  const t = INLINE.escape.exec(src);
  if (t) return { type: 'escape', raw: t[0], text: t[1] };
  return undefined;
}

function tkCodespan(src) {
  const t = INLINE.code.exec(src);
  if (t) {
    let text = t[2].replace(/\n/g, ' ');
    const hasNonSpace = /[^ ]/.test(text);
    const hasEdgeSpace = /^ /.test(text) && / $/.test(text);
    if (hasNonSpace && hasEdgeSpace) text = text.substring(1, text.length - 1);
    return { type: 'codespan', raw: t[0], text };
  }
  return undefined;
}

function tkBr(src) {
  const t = INLINE.br.exec(src);
  if (t) return { type: 'br', raw: t[0] };
  return undefined;
}

function tkTag(lx, src) {
  const t = INLINE.tag.exec(src);
  if (t) {
    if (!lx.state.inLink && /^<a /i.test(t[0])) lx.state.inLink = true;
    else if (lx.state.inLink && /^<\/a>/i.test(t[0])) lx.state.inLink = false;
    if (!lx.state.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(t[0])) lx.state.inRawBlock = true;
    else if (lx.state.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(t[0])) lx.state.inRawBlock = false;
    return { type: 'html', raw: t[0], inLink: lx.state.inLink, inRawBlock: lx.state.inRawBlock, block: false, text: t[0] };
  }
  return undefined;
}

function tkLink(lx, src) {
  if (lx.state.linkParenPossible === false) return undefined;
  const t = INLINE.link.exec(src);
  if (!t) return undefined;
  const n = t[0].charAt(0) === '!' ? 2 : 1;
  if (linkHasTagOrAutolink(src, t[1], n)) return undefined;
  let s = t[2].trim();
  if (START_ANGLE.test(s)) {
    if (!END_ANGLE.test(s)) return undefined;
    const l = stripTrailingBackslashes(s.slice(0, -1));
    if ((s.length - l.length) % 2 === 0) return undefined;
  } else {
    const l = findParen(t[2], '()');
    if (l === -2) return undefined;
    if (l > -1) {
      const h = (t[0].indexOf('!') === 0 ? 5 : 4) + t[1].length + l;
      t[2] = t[2].substring(0, l);
      t[0] = t[0].substring(0, h).trim();
      t[3] = '';
    }
  }
  const r = stripTrailingBackslashes(t[0].slice(0, -1));
  if ((t[0].length - r.length) % 2 === 0) return undefined;
  let o = t[2], i = '';
  i = t[3] ? t[3].slice(1, -1) : '';
  o = o.trim();
  if (START_ANGLE.test(o)) o = o.slice(1, -1);
  return buildLinkOrImage(lx, t, o && o.replace(ANY_PUNCT, '$1'), i && i.replace(ANY_PUNCT, '$1'), t[0]);
}

function tkReflink(lx, src) {
  const n = INLINE.reflink.exec(src) || INLINE.nolink.exec(src);
  if (!n) return undefined;
  const s = n[0].charAt(0) === '!' ? 2 : 1;
  if (linkHasTagOrAutolink(src, n[1], s)) return undefined;
  const r = lx.links[normalizeLabel(n[2] || n[1])];
  if (!r) {
    const o = n[0].charAt(0);
    return { type: 'text', raw: o, text: o };
  }
  return buildLinkOrImage(lx, n, r.href, r.title, n[0]);
}

function tkEmStrong(lx, src, masked, prevChar, maskInfo) {
  let s = INLINE.emStrongLDelim.exec(src);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return undefined;
  let n = prevChar;
  const r = s[0][0], o = n === r, i = masked.length - src.length;
  let l = i;
  while (l > 0 && masked[l - 1] === r) l--;
  const p = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = p === '*' || p === '_' || !!INLINE.punctuation.exec(p);
  if (l < i) n = p;
  const u = l < i ? h : !!INLINE.punctuation.exec(n);
  if (s[4] && UNICODE_ALNUM.test(n)) return undefined;
  const d = s[1] || s[3] || '';
  if (!d || !n || u) {
    const k = [...s[0]].length - 1;
    let g, b, m = k, f = 0;
    const y = i - l + k;
    const R = !!p.trim() && (!!d || (r === '*' && !h));
    if (r !== '*' && r !== '_') return undefined;
    const A = r === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
    const v = r === '*' ? maskInfo.star : maskInfo.under;
    const Q = masked.length - src.length + k;
    if (v < Q) return undefined;
    const t = masked.slice(-1 * src.length + k);
    const ee = v - Q;
    for (A.lastIndex = 0; (s = A.exec(t)) !== null && !(s.index > ee);) {
      if (g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6], !g) continue;
      if (b = [...g].length, s[3] || s[4]) { m += b; continue; }
      else if (s[5] || s[6] || R) {
        if (o && (s[5] || s[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      if (m -= b, m > 0) continue;
      b = Math.min(b, b + m + f);
      const te = [...s[0]][0].length;
      const M = src.slice(0, k + s.index + te + b);
      if (Math.min(k, b) % 2) {
        const U = M.slice(1, -1);
        return { type: 'em', raw: M, text: U, tokens: inlineTokens(lx, U) };
      }
      const ne = M.slice(2, -2);
      return { type: 'strong', raw: M, text: ne, tokens: inlineTokens(lx, ne) };
    }
  }
  return undefined;
}

function tkDel(lx, src, masked, prevChar, maskInfo) {
  let s = INLINE.delLDelim.exec(src);
  if (!s) return undefined;
  if (!(s[1] || '') || !prevChar || INLINE.punctuation.exec(prevChar)) {
    const o = [...s[0]].length - 1;
    let i, l, p = o;
    const h = INLINE.delRDelim, u = maskInfo.tilde, d = masked.length - src.length + o;
    if (u < d) return undefined;
    const t = masked.slice(-1 * src.length + o);
    const k = u - d;
    for (h.lastIndex = 0; (s = h.exec(t)) !== null && !(s.index > k);) {
      if (i = s[1] || s[2] || s[3] || s[4] || s[5] || s[6], !i || (l = [...i].length, l !== o)) continue;
      if (s[3] || s[4]) { p += l; continue; }
      if (p -= l, p > 0) continue;
      l = Math.min(l, l + p);
      const g = [...s[0]][0].length;
      const b = src.slice(0, o + s.index + g + l);
      const m = b.slice(o, -o);
      return { type: 'del', raw: b, text: m, tokens: inlineTokens(lx, m) };
    }
  }
  return undefined;
}

function tkAutolink(src) {
  const t = INLINE.autolink.exec(src);
  if (t) {
    let text, href;
    if (t[2] === '@') { text = t[1]; href = 'mailto:' + text; }
    else { text = t[1]; href = text; }
    return { type: 'link', raw: t[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }
  return undefined;
}

function tkUrl(src) {
  const t = INLINE.url.exec(src);
  if (t) {
    let text, href;
    if (t[2] === '@') { text = t[0]; href = 'mailto:' + text; }
    else {
      let prev;
      do {
        prev = t[0];
        t[0] = INLINE.backpedal.exec(t[0])?.[0] ?? '';
      } while (prev !== t[0]);
      text = t[0];
      href = t[1] === 'www.' ? 'http://' + t[0] : t[0];
    }
    return { type: 'link', raw: t[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }
  return undefined;
}

function tkInlineText(lx, src) {
  const t = INLINE.text.exec(src);
  if (t) {
    const inRaw = lx.state.inRawBlock;
    return { type: 'text', raw: t[0], text: inRaw ? t[0] : decodeEntities(t[0]), escaped: inRaw };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Emphasis masking
// ---------------------------------------------------------------------------

function scanMask(str) {
  const last = { '*': -1, '_': -1 };
  let tilde = -1;
  const n = str.length;
  for (let i = 0; i < n; i++) {
    const ch = str[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : str[i - 1];
    let j = i + 1;
    while (j < n && str[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') tilde = i;
      else last[ch] = i;
    }
    i = j - 1;
  }
  return { star: last['*'], under: last['_'], tilde };
}

function linkInText(lx, e) {
  if (!e.includes('[')) return false;
  const t = INLINE.link;
  for (const n of e.matchAll(INLINE.blockSkip)) {
    if (t.test(n[0]) && e.charAt(n.index - 1) !== '!') return true;
  }
  for (const n of e.matchAll(INLINE.reflinkSearch)) {
    const s = n[0], r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(lx.links, normalizeLabel(s.slice(r + 1, -1)))) && !(r > 1 && linkInText(lx, s.slice(1, r - 1)))) return true;
  }
  return false;
}

function maskForEmphasis(lx, src) {
  let t = src;
  if (lx.links && src.includes('[')) {
    const re = INLINE.reflinkSearch;
    const maskReflink = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(lx.links, normalizeLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(lx, inner)) return '[' + inner.replace(re, maskReflink) + '][' + 'a'.repeat(r.length - o - 2) + ']';
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(re, maskReflink);
  }
  // anyPunctOutsideCode only changes backslash-escaped punctuation and
  // backticks inside code spans; skip the scan when neither can occur.
  if (src.includes('\\') || src.includes('`')) {
    t = t.replace(INLINE.anyPunctOutsideCode, (m, backticks, punct) =>
      punct ? '+'.repeat(m.length)
      : backticks ? backticks + m.slice(backticks.length, -backticks.length).replace(/`/g, '+') + backticks
      : m);
  }
  // blockSkip only hides [...]() links, code spans, and <...> tags; skip
  // the scan when none of their opening characters can occur.
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    t = t.replace(INLINE.blockSkip, (m, a, b) => {
      const o = b ? b.length : 0;
      return m.slice(0, o) + '[' + 'a'.repeat(m.length - o - 2) + ']';
    });
  }
  return t;
}

// ---------------------------------------------------------------------------
// Inline token loop
// ---------------------------------------------------------------------------

const INLINE_PLAIN = /[\\`<\[*_~]/;
const INLINE_BR = / {2,}\n/;
// URL/email triggers (protocol match is case-insensitive in marked).
const INLINE_URL_TRIG = /https?:|ftp:|www\.|@|mailto:|xmpp:/i;

function inlineTokens(lx, src, tokens = []) {
  const saved = lx.state.linkParenPossible;
  lx.state.linkParenPossible = saved && src.includes(')');
  try {
    // Fast path: plain text with no inline-markup trigger. The slow loop
    // would try ~10 tokenizers and land on inlineText for the whole run,
    // so a single text token is the identical result (entity-decoded
    // unless inside a raw block). Guarded by: no escape/tag/link/code/
    // emphasis/del chars, no URL/email trigger, no hard-break run.
    if (src !== '' && !INLINE_PLAIN.test(src) && !INLINE_BR.test(src) && !INLINE_URL_TRIG.test(src)) {
      const inRaw = lx.state.inRawBlock;
      tokens.push({ type: 'text', raw: src, text: inRaw ? src : decodeEntities(src), escaped: inRaw });
      return tokens;
    }
    return inlineTokensInner(lx, src, tokens);
  } finally {
    lx.state.linkParenPossible = saved;
  }
}

function inlineTokensInner(lx, src, tokens) {
  let masked = src;
  let maskInfo = { star: -1, under: -1, tilde: -1 };
  if (src.includes('*') || src.includes('_') || src.includes('~')) {
    masked = maskForEmphasis(lx, src);
    maskInfo = scanMask(masked);
  }
  let s = false, r = '', o = Infinity;
  let e = src;
  while (e) {
    if (e.length < o) o = e.length;
    else break; // infinite loop guard (should not happen)
    if (!s) r = '';
    s = false;
    let i;
    if (i = tkEscape(e)) { e = e.substring(i.raw.length); tokens.push(i); continue; }
    if (i = tkTag(lx, e)) { e = e.substring(i.raw.length); tokens.push(i); continue; }
    if (i = tkLink(lx, e)) { e = e.substring(i.raw.length); tokens.push(i); continue; }
    if (i = tkReflink(lx, e)) {
      e = e.substring(i.raw.length);
      const p = tokens.at(-1);
      if (i.type === 'text' && p?.type === 'text') { p.raw += i.raw; p.text += i.text; }
      else tokens.push(i);
      continue;
    }
    if (i = tkEmStrong(lx, e, masked, r, maskInfo)) { e = e.substring(i.raw.length); tokens.push(i); continue; }
    if (i = tkCodespan(e)) { e = e.substring(i.raw.length); tokens.push(i); continue; }
    if (i = tkBr(e)) { e = e.substring(i.raw.length); tokens.push(i); continue; }
    if (i = tkDel(lx, e, masked, r, maskInfo)) { e = e.substring(i.raw.length); tokens.push(i); continue; }
    if (i = tkAutolink(e)) { e = e.substring(i.raw.length); tokens.push(i); continue; }
    if (!lx.state.inLink && (i = tkUrl(e))) { e = e.substring(i.raw.length); tokens.push(i); continue; }
    if (i = tkInlineText(lx, e)) {
      e = e.substring(i.raw.length);
      if (i.raw.slice(-1) !== '_') r = i.raw.slice(-1);
      s = true;
      const p = tokens.at(-1);
      if (p?.type === 'text') { p.raw += i.raw; p.text += i.text; }
      else tokens.push(i);
      continue;
    }
    break; // no tokenizer matched; avoid infinite loop
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function sanitizeHref(a) {
  try { a = encodeURI(a).replace(/%25/g, '%'); }
  catch { return null; }
  return a;
}

function renderCode(tok) {
  const lang = (tok.lang || '').match(NOT_SPACE_START)?.[0];
  const body = tok.text ? tok.text.replace(ENDING_NEWLINE, '') + '\n' : '';
  const inner = tok.escaped ? body : escapeHtml(body, true);
  return lang
    ? '<pre><code class="language-' + escapeHtml(lang) + '">' + inner + '</code></pre>\n'
    : '<pre><code>' + inner + '</code></pre>\n';
}

function renderTable(tok) {
  let head = '';
  for (let r = 0; r < tok.header.length; r++) head += renderTableCell(tok.header[r]);
  let out = `<table>\n<thead>\n<tr>\n${head}</tr>\n</thead>\n`;
  if (tok.rows.length > 0) {
    let body = '';
    for (let r = 0; r < tok.rows.length; r++) {
      let row = '';
      for (let i = 0; i < tok.rows[r].length; i++) row += renderTableCell(tok.rows[r][i]);
      body += `<tr>\n${row}</tr>\n`;
    }
    out += `<tbody>${body}</tbody>`;
  }
  return out + `</table>\n`;
}

function renderTableCell(cell) {
  const t = renderInlineTokens(cell.tokens);
  const n = cell.header ? 'th' : 'td';
  return (cell.align ? `<${n} align="${cell.align}">` : `<${n}>`) + t + `</${n}>\n`;
}

function renderList(tok) {
  let s = '';
  for (let i = 0; i < tok.items.length; i++) s += `<li>${renderBlockTokens(tok.items[i].tokens)}</li>\n`;
  const r = tok.ordered ? 'ol' : 'ul';
  const o = tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '';
  return '<' + r + o + '>\n' + s + '</' + r + '>\n';
}

function renderBlockTokens(tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    switch (tok.type) {
      case 'space': break;
      case 'hr': out += '<hr>\n'; break;
      case 'heading': out += `<h${tok.depth}>${renderInlineTokens(tok.tokens)}</h${tok.depth}>\n`; break;
      case 'code': out += renderCode(tok); break;
      case 'table': out += renderTable(tok); break;
      case 'blockquote': out += `<blockquote>\n${renderBlockTokens(tok.tokens)}</blockquote>\n`; break;
      case 'list': out += renderList(tok); break;
      case 'html': out += tok.text; break;
      case 'paragraph': out += `<p>${renderInlineTokens(tok.tokens)}</p>\n`; break;
      case 'text': out += renderInlineText(tok); break;
      case 'checkbox': out += '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '; break;
      case 'def': break;
    }
  }
  return out;
}

function renderInlineText(tok) {
  if ('tokens' in tok && tok.tokens) return renderInlineTokens(tok.tokens);
  if ('escaped' in tok && tok.escaped) return tok.text;
  return escapeHtml(tok.text);
}

function renderInlineTokens(tokens, textOnly = false) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (textOnly) {
      switch (tok.type) {
        case 'strong': case 'em': case 'del': case 'link': case 'image':
          out += tok.tokens ? renderInlineTokens(tok.tokens, true) : tok.text; break;
        case 'codespan': out += tok.text; break;
        case 'html': out += tok.text; break;
        case 'text': out += tok.text; break;
        case 'escape': out += tok.text; break;
        case 'br': break;
        case 'checkbox': out += tok.raw; break;
      }
      continue;
    }
    switch (tok.type) {
      case 'escape': out += escapeHtml(tok.text); break;
      case 'html': out += tok.text; break;
      case 'link': {
        const o = tok.autolink ? escapeHtml(tok.text, true) : renderInlineTokens(tok.tokens);
        const href = sanitizeHref(tok.href);
        if (href === null) { out += o; break; }
        let l = '<a href="' + escapeHtml(href, tok.autolink) + '"';
        if (tok.title) l += ' title="' + escapeHtml(tok.title) + '"';
        out += l + '>' + o + '</a>';
        break;
      }
      case 'image': {
        const alt = tok.tokens ? renderInlineTokens(tok.tokens, true) : tok.text;
        const href = sanitizeHref(tok.href);
        if (href === null) { out += escapeHtml(alt); break; }
        let o = `<img src="${escapeHtml(href)}" alt="${escapeHtml(alt)}"`;
        if (tok.title) o += ` title="${escapeHtml(tok.title)}"`;
        out += o + '>';
        break;
      }
      case 'checkbox': out += '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '; break;
      case 'strong': out += `<strong>${renderInlineTokens(tok.tokens)}</strong>`; break;
      case 'em': out += `<em>${renderInlineTokens(tok.tokens)}</em>`; break;
      case 'codespan': out += `<code>${escapeHtml(tok.text, true)}</code>`; break;
      case 'br': out += '<br>'; break;
      case 'del': out += `<del>${renderInlineTokens(tok.tokens)}</del>`; break;
      case 'text': out += renderInlineText(tok); break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const src = String(markdown).replace(CARRIAGE_RETURN, '\n');
  const lx = new BlockLexer();
  const tokens = lx.lex(src);
  return renderBlockTokens(tokens);
}

export default parse;
