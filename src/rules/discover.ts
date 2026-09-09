import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { RuleFile } from '../types.js';

/** Rules files understood out of the box, in the order they are reported. */
const WELL_KNOWN = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  'GEMINI.md',
  '.cursorrules',
  join('.github', 'copilot-instructions.md'),
];

/** Directories scanned for per-file rule documents. */
const RULE_DIRS = [join('.cursor', 'rules'), join('.claude', 'rules')];

async function readIfPresent(root: string, rel: string): Promise<RuleFile | null> {
  try {
    const content = await readFile(join(root, rel), 'utf8');
    return content.trim() ? { path: rel.split(sep).join('/'), content } : null;
  } catch {
    return null;
  }
}

async function readDirFiles(root: string, dir: string): Promise<RuleFile[]> {
  let entries: string[];
  try {
    entries = await readdir(join(root, dir));
  } catch {
    return [];
  }
  const out: RuleFile[] = [];
  for (const name of entries.sort()) {
    if (!/\.(mdc?|markdown)$/i.test(name)) continue;
    const file = await readIfPresent(root, join(dir, name));
    if (file) out.push(file);
  }
  return out;
}

/**
 * Finds the rules files an agent would actually load for this repo.
 *
 * Explicit paths win: when the user names files, only those are read, so a run
 * can be scoped to a single document.
 */
export async function discoverRuleFiles(root: string, explicit?: string[]): Promise<RuleFile[]> {
  if (explicit && explicit.length > 0) {
    const out: RuleFile[] = [];
    for (const path of explicit) {
      const rel = relative(root, join(root, path));
      const file = await readIfPresent(root, rel);
      if (!file) throw new Error(`rules file not found or empty: ${path}`);
      out.push(file);
    }
    return out;
  }

  const out: RuleFile[] = [];
  for (const rel of WELL_KNOWN) {
    const file = await readIfPresent(root, rel);
    if (file) out.push(file);
  }
  for (const dir of RULE_DIRS) out.push(...(await readDirFiles(root, dir)));
  return out;
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
