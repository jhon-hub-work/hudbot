import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const bot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mock = pathToFileURL(path.join(bot, 'test', 'mock-meeting.html')).href;

test('join gets into a meeting page and records its sound', { timeout: 120_000 }, async () => {
  const out = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['hudbot.js', 'join', mock, '--name', 'Test', '--no-make'], { cwd: bot });
    let text = '';
    p.stdout.on('data', (d) => (text += d));
    p.stderr.on('data', (d) => (text += d));
    p.on('close', (code) => (code === 0 ? resolve(text) : reject(new Error(`exit ${code}\n${text}`))));
  });
  const dir = out.match(/Recording folder: (.+)/)[1].trim();
  const pcm = await stat(path.join(dir, 'audio.pcm'));
  assert.ok(pcm.size > 100_000, `only ${pcm.size} bytes of sound`);
  const meta = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8'));
  assert.equal(meta.stop, 'the host ended the meeting');
});
