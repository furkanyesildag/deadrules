import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRuleSet } from '../dist/rules/parse.js';
import { emptyVariant, minusVariant, renderVariant } from '../dist/rules/render.js';

const CLAUDE_MD = `# Project

This file describes the repo.

## Style

- Always run \`npm test\` before saying you are done.
- Never edit files under \`generated/\`.
- Prefer small commits.
  - One logical change each.
  - Write the message in the imperative.

## Notes

Use the existing logger rather than console.log.

\`\`\`ts
// not a rule, just an example
const x = 1;
\`\`\`
`;

test('parses bullets, nested children, and imperative paragraphs', () => {
  const set = parseRuleSet([{ path: 'CLAUDE.md', content: CLAUDE_MD }]);
  const texts = set.rules.map((r) => r.text);

  assert.equal(set.rules.length, 4, `expected 4 rules, got ${texts.length}: ${JSON.stringify(texts)}`);
  assert.match(texts[0], /Always run/);
  assert.match(texts[1], /Never edit/);
  // A parent bullet owns its children, so they are one removable unit.
  assert.match(texts[2], /Prefer small commits/);
  assert.match(texts[2], /One logical change each/);
  assert.match(texts[3], /Use the existing logger/);
});

test('framing prose is not treated as a rule', () => {
  const set = parseRuleSet([{ path: 'CLAUDE.md', content: CLAUDE_MD }]);
  assert.ok(!set.rules.some((r) => /This file describes the repo/.test(r.text)));
});

test('code fences are never parsed as rules', () => {
  const set = parseRuleSet([{ path: 'CLAUDE.md', content: CLAUDE_MD }]);
  assert.ok(!set.rules.some((r) => /const x = 1/.test(r.text)));
});

test('rules carry their heading path', () => {
  const set = parseRuleSet([{ path: 'CLAUDE.md', content: CLAUDE_MD }]);
  assert.deepEqual(set.rules[0].section, ['Project', 'Style']);
  assert.deepEqual(set.rules[3].section, ['Project', 'Notes']);
});

test('ids are stable and hashes differ per rule', () => {
  const set = parseRuleSet([{ path: 'CLAUDE.md', content: CLAUDE_MD }]);
  assert.deepEqual(
    set.rules.map((r) => r.id),
    ['R01', 'R02', 'R03', 'R04'],
  );
  assert.equal(new Set(set.rules.map((r) => r.hash)).size, 4);
});

test('frontmatter is preserved and not parsed', () => {
  const mdc = `---
description: TypeScript rules
globs: "**/*.ts"
---

- Use strict mode everywhere.
`;
  const set = parseRuleSet([{ path: '.cursor/rules/ts.mdc', content: mdc }]);
  assert.equal(set.rules.length, 1);
  const [file] = renderVariant(set, emptyVariant(set));
  assert.match(file.content, /description: TypeScript rules/);
  assert.ok(!/Use strict mode/.test(file.content));
});

test('removing a rule leaves the rest of the file byte-identical', () => {
  const set = parseRuleSet([{ path: 'CLAUDE.md', content: CLAUDE_MD }]);
  const [file] = renderVariant(set, minusVariant(['R02']));

  assert.ok(!/Never edit files/.test(file.content), 'removed rule still present');
  assert.match(file.content, /Always run/);
  assert.match(file.content, /Prefer small commits/);
  assert.match(file.content, /One logical change each/);
  assert.match(file.content, /## Style/);
  assert.match(file.content, /const x = 1/);
});

test('removing a parent bullet takes its children with it', () => {
  const set = parseRuleSet([{ path: 'CLAUDE.md', content: CLAUDE_MD }]);
  const [file] = renderVariant(set, minusVariant(['R03']));
  assert.ok(!/Prefer small commits/.test(file.content));
  assert.ok(!/One logical change each/.test(file.content), 'orphaned child left behind');
  assert.ok(!/imperative/.test(file.content));
});

test('the empty variant removes every rule but keeps the scaffolding', () => {
  const set = parseRuleSet([{ path: 'CLAUDE.md', content: CLAUDE_MD }]);
  const [file] = renderVariant(set, emptyVariant(set));
  for (const rule of set.rules) {
    const head = rule.text.split('\n')[0].replace(/^[-*+]\s+/, '').slice(0, 20);
    assert.ok(!file.content.includes(head), `rule survived: ${head}`);
  }
  assert.match(file.content, /# Project/);
  assert.match(file.content, /This file describes the repo/);
});

test('no run of more than two blank lines survives a removal', () => {
  const spaced = '# T\n\n- one rule here\n\n\n- another rule here\n\n\n\n- third rule here now\n';
  const set = parseRuleSet([{ path: 'CLAUDE.md', content: spaced }]);
  const [file] = renderVariant(set, minusVariant(['R02']));
  assert.ok(!/\n{4,}/.test(file.content), JSON.stringify(file.content));
});
