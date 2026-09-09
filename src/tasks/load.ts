import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { CONFIG_DIR } from '../config.js';
import type { Grader, Task } from '../types.js';

export const TASKS_DIR = join(CONFIG_DIR, 'tasks');

interface TaskFrontmatter {
  id?: string;
  base?: string;
  setup?: string[];
  grade?: Grader[];
  weight?: number;
  origin?: string;
  prompt?: string;
}

/**
 * Task files are markdown with a JSON frontmatter block:
 *
 *   ---
 *   { "grade": [{ "type": "run", "cmd": "npm test" }] }
 *   ---
 *   Add a DELETE /users/:id endpoint.
 *
 * JSON rather than YAML so the format needs no dependency and no guessing about
 * which YAML subset is supported.
 */
export function parseTaskFile(path: string, content: string): Task {
  const id = basename(path, extname(path));
  const lines = content.split('\n');
  let front: TaskFrontmatter = {};
  let body = content;

  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (end === -1) throw new Error(`${path}: frontmatter opened but never closed`);
    const json = lines.slice(1, end).join('\n').trim();
    if (json) {
      try {
        front = JSON.parse(json) as TaskFrontmatter;
      } catch (err) {
        throw new Error(`${path}: frontmatter is not valid JSON: ${(err as Error).message}`);
      }
    }
    body = lines.slice(end + 1).join('\n');
  }

  const prompt = (front.prompt ?? body).trim();
  if (!prompt) throw new Error(`${path}: task has no prompt`);

  const grade = front.grade ?? [];
  if (grade.length === 0) {
    throw new Error(
      `${path}: task has no graders, so every variant would score the same. Add at least one.`,
    );
  }

  return {
    id: front.id ?? id,
    prompt,
    ...(front.base !== undefined ? { base: front.base } : {}),
    ...(front.setup !== undefined ? { setup: front.setup } : {}),
    grade,
    weight: front.weight ?? 1,
    ...(front.origin !== undefined ? { origin: front.origin } : {}),
  };
}

export async function loadTasks(root: string, only?: string[]): Promise<Task[]> {
  const dir = join(root, TASKS_DIR);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    throw new Error(`no tasks found. Run \`deadrules init\` to create ${TASKS_DIR}/.`);
  }

  const tasks: Task[] = [];
  for (const name of entries.sort()) {
    if (!/\.mdx?$/i.test(name)) continue;
    const path = join(dir, name);
    tasks.push(parseTaskFile(path, await readFile(path, 'utf8')));
  }

  if (tasks.length === 0) throw new Error(`${TASKS_DIR}/ contains no task files.`);

  if (only && only.length > 0) {
    const wanted = new Set(only);
    const picked = tasks.filter((t) => wanted.has(t.id));
    const missing = only.filter((id) => !tasks.some((t) => t.id === id));
    if (missing.length) throw new Error(`unknown task(s): ${missing.join(', ')}`);
    return picked;
  }
  return tasks;
}
