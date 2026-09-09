#!/usr/bin/env node
/**
 * Renders ANSI terminal output to an SVG, so the README image is generated from
 * the real reporter rather than drawn by hand and left to drift.
 *
 *   FORCE_COLOR=1 deadrules ablate | node scripts/render-svg.mjs > docs/report.svg
 *
 * Reads ANSI text on stdin, writes SVG on stdout. --title sets the prompt line.
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? fallback);
};

const TITLE = flag('title', 'deadrules ablate');
const CAPTION = flag('caption', '');
const FONT_SIZE = 13;
const CHAR_W = 7.8;
const LINE_H = 20;
const PAD_X = 20;
const PAD_TOP = 52;
const PAD_BOTTOM = 20;

// A dark palette with enough contrast for the two verdict colours to stay
// distinguishable for the most common forms of colour blindness.
const THEME = {
  bg: '#15171c',
  chrome: '#20232b',
  text: '#d6dbe5',
  dim: '#6f7a8d',
  bold: '#f2f5fa',
  31: '#f2777a', // harmful
  32: '#9ece6a', // load-bearing
  33: '#e0af68', // warnings
  36: '#7dcfff', // the honesty footer
};

const ESC = String.fromCharCode(27);
const SGR = () => new RegExp(`${ESC}\\[([0-9;]*)m`, 'g');
const stripAnsi = (s) => s.replace(SGR(), '');

const escapeXml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Splits one ANSI line into styled runs, continuing from the previous line.
 *
 * A terminal keeps an SGR state until it is reset, so a styled block spanning
 * several lines stays styled. Resetting per line dropped the styling from every
 * continuation line.
 */
function parseLine(line, carried) {
  const runs = [];
  let style = { ...carried };
  let buffer = '';

  const flush = () => {
    if (buffer) runs.push({ text: buffer, ...style });
    buffer = '';
  };

  const pattern = SGR();
  let last = 0;
  let match;
  while ((match = pattern.exec(line)) !== null) {
    buffer += line.slice(last, match.index);
    flush();
    last = pattern.lastIndex;
    for (const code of (match[1] || '0').split(';')) {
      if (code === '0' || code === '') style = { color: THEME.text, bold: false, dim: false };
      else if (code === '1') style = { ...style, bold: true, color: THEME.bold };
      else if (code === '2') style = { ...style, dim: true, color: THEME.dim };
      else if (THEME[code]) style = { ...style, color: THEME[code] };
    }
  }
  buffer += line.slice(last);
  flush();
  return { runs, style };
}

const raw = readFileSync(0, 'utf8').replace(/\s+$/, '');
const lines = raw.split('\n');
const width =
  Math.max(78, ...lines.map((l) => stripAnsi(l).length)) * CHAR_W +
  PAD_X * 2;
const captionH = CAPTION ? LINE_H + 14 : 0;
const height = PAD_TOP + lines.length * LINE_H + PAD_BOTTOM + captionH;

let carried = { color: THEME.text, bold: false, dim: false };
const body = lines
  .map((line, i) => {
    const parsed = parseLine(line, carried);
    carried = parsed.style;
    const runs = parsed.runs;
    if (runs.length === 0) return '';
    const y = PAD_TOP + i * LINE_H;
    let column = 0;
    const spans = runs
      .map((run) => {
        const x = PAD_X + column * CHAR_W;
        column += run.text.length;
        if (!run.text.trim()) return '';
        const weight = run.bold ? ' font-weight="600"' : '';
        return `<text x="${x.toFixed(1)}" y="${y}" fill="${run.color}"${weight} xml:space="preserve">${escapeXml(run.text)}</text>`;
      })
      .filter(Boolean)
      .join('');
    return spans;
  })
  .filter(Boolean)
  .join('\n    ');

const caption = CAPTION
  ? `<text x="${PAD_X}" y="${height - 14}" fill="${THEME.dim}" font-size="11" font-style="italic">${escapeXml(CAPTION)}</text>`
  : '';

process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width)}" height="${Math.round(height)}" viewBox="0 0 ${Math.round(width)} ${Math.round(height)}" font-family="ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="${FONT_SIZE}">
  <rect width="100%" height="100%" rx="10" fill="${THEME.bg}"/>
  <rect width="100%" height="34" rx="10" fill="${THEME.chrome}"/>
  <rect y="24" width="100%" height="10" fill="${THEME.chrome}"/>
  <circle cx="20" cy="17" r="5" fill="#f2777a"/>
  <circle cx="38" cy="17" r="5" fill="#e0af68"/>
  <circle cx="56" cy="17" r="5" fill="#9ece6a"/>
  <text x="76" y="21" fill="${THEME.dim}" font-size="12">$ ${escapeXml(TITLE)}</text>
  <g>
    ${body}
  </g>
  ${caption}
</svg>
`);
