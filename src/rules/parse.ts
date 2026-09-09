import { createHash } from 'node:crypto';
import type { Rule, RuleFile, RuleSet } from '../types.js';

const BULLET = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s*(```+|~~~+)/;

interface Block {
  start: number; // 0-based
  span: number;
  text: string;
  kind: 'bullet' | 'paragraph';
  section: string[];
}

function indentOf(line: string): number {
  const m = /^\s*/.exec(line);
  return m ? m[0].replace(/\t/g, '    ').length : 0;
}

/** Strips the frontmatter block, returning the body and the line it starts on. */
function splitFrontmatter(content: string): { offset: number; lines: string[] } {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return { offset: 0, lines };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') return { offset: i + 1, lines: lines.slice(i + 1) };
  }
  return { offset: 0, lines };
}

function fenceMarkerOf(line: string): string | null {
  const m = FENCE.exec(line);
  if (!m) return null;
  return (m[1] ?? '').startsWith('`') ? '```' : '~~~';
}

/**
 * Splits one rules file into atomic blocks.
 *
 * A list item owns its nested children: removing a parent without its children
 * would leave orphaned indentation, so the whole subtree is the unit.
 */
function blocksOf(content: string): Block[] {
  const { offset, lines } = splitFrontmatter(content);
  const blocks: Block[] = [];
  const section: string[] = [];
  let i = 0;
  let fence: string | null = null;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    const marker = fenceMarkerOf(line);
    if (marker) {
      if (fence === null) fence = marker;
      else if (line.trim().startsWith(fence)) fence = null;
      i++;
      continue;
    }
    if (fence !== null) {
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const depth = (heading[1] ?? '').length;
      section.length = Math.max(0, depth - 1);
      section[depth - 1] = (heading[2] ?? '').trim();
      i++;
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    if (BULLET.test(line)) {
      const baseIndent = indentOf(line);
      const start = i;
      i = consumeContinuation(lines, i + 1, baseIndent);
      blocks.push({
        start,
        span: i - start,
        text: dedent(lines.slice(start, i)).join('\n').trim(),
        kind: 'bullet',
        section: section.filter(Boolean),
      });
      continue;
    }

    // A paragraph: consecutive lines that are not headings, bullets, or blank.
    const start = i;
    let inFence: string | null = null;
    while (i < lines.length) {
      const cur = lines[i] ?? '';
      const curMarker = fenceMarkerOf(cur);
      if (curMarker) {
        if (inFence === null) inFence = curMarker;
        else if (cur.trim().startsWith(inFence)) inFence = null;
        i++;
        continue;
      }
      if (inFence !== null) {
        i++;
        continue;
      }
      if (cur.trim() === '' || HEADING.test(cur) || BULLET.test(cur)) break;
      i++;
    }
    blocks.push({
      start,
      span: i - start,
      text: lines.slice(start, i).join('\n').trim(),
      kind: 'paragraph',
      section: section.filter(Boolean),
    });
  }

  return blocks.map((b) => ({ ...b, start: b.start + offset }));
}

/** Extends a list item over its continuation lines and nested children. */
function consumeContinuation(lines: string[], from: number, baseIndent: number): number {
  let i = from;
  let fence: string | null = null;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (fence !== null) {
      if (line.trim().startsWith(fence)) fence = null;
      i++;
      continue;
    }

    const marker = fenceMarkerOf(line);
    if (marker && indentOf(line) > baseIndent) {
      fence = marker;
      i++;
      continue;
    }

    if (line.trim() === '') {
      // A blank line continues the item only if indented content follows it.
      let j = i;
      while (j < lines.length && (lines[j] ?? '').trim() === '') j++;
      if (j < lines.length && indentOf(lines[j] ?? '') > baseIndent) {
        i = j;
        continue;
      }
      break;
    }

    if (indentOf(line) > baseIndent) {
      i++;
      continue;
    }
    break;
  }

  return i;
}

function dedent(lines: string[]): string[] {
  const indents = lines.filter((l) => l.trim() !== '').map(indentOf);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min));
}

export function hashRule(file: string, text: string): string {
  const normalised = text.replace(/\s+/g, ' ').trim().toLowerCase();
  return createHash('sha256').update(`${file} ${normalised}`).digest('hex').slice(0, 8);
}

const IMPERATIVE =
  /\b(always|never|do not|don t|must|should|avoid|prefer|use|run|write|ensure|make sure|remember|keep|only)\b/i;

/**
 * A block is only worth ablating if it carries an instruction. Framing prose
 * ("This file describes the project") stays in every variant, so the
 * measurement is about rules rather than about document length.
 */
function isAblatable(block: Block): boolean {
  const text = block.text.trim();
  if (text.length < 8) return false;
  if (block.kind === 'bullet') return true;
  return IMPERATIVE.test(text.replace(/['’]/g, ' '));
}

export function parseRuleFile(file: RuleFile, startIndex: number): Rule[] {
  const blocks = blocksOf(file.content).filter(isAblatable);
  return blocks.map((b, n) => ({
    id: `R${String(startIndex + n + 1).padStart(2, '0')}`,
    hash: hashRule(file.path, b.text),
    file: file.path,
    line: b.start + 1,
    span: b.span,
    text: b.text,
    kind: b.kind,
    section: b.section,
  }));
}

export function parseRuleSet(files: RuleFile[]): RuleSet {
  const rules: Rule[] = [];
  for (const file of files) rules.push(...parseRuleFile(file, rules.length));
  return { files, rules };
}
