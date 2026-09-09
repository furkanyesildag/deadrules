import type { RuleFile, RuleSet, Variant } from '../types.js';

/**
 * Rebuilds every rules file with the variant's rules deleted.
 *
 * Only the removed lines change: everything else stays byte-identical, so a
 * measured difference cannot be blamed on incidental reformatting.
 */
export function renderVariant(set: RuleSet, variant: Variant): RuleFile[] {
  if (variant.files) return variant.files;
  const removed = new Set(variant.removed);

  return set.files.map((file) => {
    const drop = new Set<number>();
    for (const rule of set.rules) {
      if (rule.file !== file.path || !removed.has(rule.id)) continue;
      for (let n = 0; n < rule.span; n++) drop.add(rule.line - 1 + n);
    }
    if (drop.size === 0) return file;

    const kept = file.content.split('\n').filter((_, i) => !drop.has(i));
    return { path: file.path, content: tidy(kept) };
  });
}

/** Collapses the blank-line runs that deleting whole blocks leaves behind. */
function tidy(lines: string[]): string {
  const out: string[] = [];
  let blanks = 0;
  for (const line of lines) {
    if (line.trim() === '') {
      blanks++;
      if (blanks > 2) continue;
    } else {
      blanks = 0;
    }
    out.push(line);
  }
  while (out.length && (out[out.length - 1] ?? '').trim() === '') out.pop();
  return out.join('\n') + '\n';
}

export function baselineVariant(): Variant {
  return { id: 'baseline', label: 'all rules', removed: [] };
}

export function emptyVariant(set: RuleSet): Variant {
  return { id: 'empty', label: 'no rules', removed: set.rules.map((r) => r.id) };
}

/** A variant that is an entire alternative version of the rules files. */
export function literalVariant(id: string, label: string, files: RuleFile[]): Variant {
  return { id, label, removed: [], files };
}

export function minusVariant(ids: string[]): Variant {
  const sorted = [...ids].sort();
  return {
    id: `minus-${sorted.join('+')}`,
    label: sorted.length === 1 ? `without ${sorted[0]}` : `without ${sorted.length} rules`,
    removed: sorted,
  };
}
