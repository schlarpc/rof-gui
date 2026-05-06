/**
 * Shared helpers for the Node-side debug/render scripts: locating a vector
 * by filename substring across the corpus, and decoding FLAC to mono f32
 * PCM via the ffmpeg CLI.
 */

import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

export const SAMPLE_RATE = 48000;

export const SEARCH_DIRS: readonly string[] = [
  join(REPO_ROOT, 'test-corpus', 'validation'),
  join(REPO_ROOT, 'test-corpus', 'test')
];

export interface FoundVector {
  dir: string;
  name: string;
  path: string;
}

export function findVector(filterArg: string): FoundVector | null {
  for (const dir of SEARCH_DIRS) {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    const f = entries.find(name => name.endsWith('.flac') && name.includes(filterArg));
    if (f) return { dir, name: f, path: join(dir, f) };
  }
  return null;
}

export function decodeFlac(path: string, sampleRate: number = SAMPLE_RATE): Float32Array {
  const tmp = mkdtempSync(join(tmpdir(), 'rof-'));
  const pcmPath = join(tmp, 'audio.pcm');
  try {
    const result = spawnSync('ffmpeg', [
      '-loglevel', 'error',
      '-i', path,
      '-ac', '1',
      '-ar', String(sampleRate),
      '-f', 'f32le',
      '-y', pcmPath
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (result.status !== 0) {
      throw new Error(`ffmpeg failed for ${path}: status ${result.status}`);
    }
    const buf = readFileSync(pcmPath);
    return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
