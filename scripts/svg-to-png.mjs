#!/usr/bin/env node
/**
 * Rasterises an SVG at 2x through headless Chrome.
 *
 * npmjs.com does not render relative image paths, and raw.githubusercontent.com
 * serves SVG as text/plain, so the README has to point at absolute PNG URLs for
 * the images to appear in both places.
 *
 *   node scripts/svg-to-png.mjs docs/report.svg docs/report.png
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const run = promisify(execFile);
const [input, output] = process.argv.slice(2);
if (!input || !output) {
  process.stderr.write('usage: svg-to-png.mjs <in.svg> <out.png>\n');
  process.exit(1);
}

const svg = readFileSync(input, 'utf8');
const width = Number(/width="(\d+)"/.exec(svg)?.[1]);
const height = Number(/height="(\d+)"/.exec(svg)?.[1]);
if (!width || !height) {
  process.stderr.write(`could not read dimensions from ${input}\n`);
  process.exit(1);
}

const binaries = ['google-chrome', 'chromium', 'chromium-browser'];
let lastError;
for (const bin of binaries) {
  try {
    await run(bin, [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      '--default-background-color=00000000',
      '--force-device-scale-factor=2',
      `--window-size=${width},${height}`,
      `--screenshot=${resolve(output)}`,
      `file://${resolve(input)}`,
    ]);
    process.stdout.write(`${output}  ${width * 2}x${height * 2}\n`);
    process.exit(0);
  } catch (err) {
    lastError = err;
  }
}
process.stderr.write(`no Chrome found (${binaries.join(', ')}): ${lastError}\n`);
process.exit(1);
