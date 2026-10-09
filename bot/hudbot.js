#!/usr/bin/env node
// Hudbot for outside meetings.
//   join <link>  opens the meeting as a guest, records its sound and screen captures, then runs make
//   make <dir>   transcribes on this PC, writes the notes with Claude Haiku 5.5, and draws the slides
import { chromium } from 'playwright-core';
import { once } from 'node:events';
import { createWriteStream, existsSync } from 'node:fs';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize } from './summarize.js';
import { buildDeck } from './slides.js';
import { browserLink, cleanLink } from './links.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mmss = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const exists = (p) => access(p).then(() => true, () => false);
// Up to n captures spread evenly across the meeting.
const pick = (list, n) => (list.length <= n ? list : Array.from({ length: n }, (_, i) => list[Math.floor((i * list.length) / n)]));

const BRAVE = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
// The browser Hudbot opens: Brave when it is installed, else Edge. HUDBOT_BROWSER can name a Playwright channel
// (msedge, chrome) or the path to any Chromium .exe.
function browserOptions() {
  const setting = process.env.HUDBOT_BROWSER || (existsSync(BRAVE) ? BRAVE : 'msedge');
  return /\.exe$/i.test(setting) ? { executablePath: setting } : { channel: setting };
}
const JOIN_MS = 20 * 60e3;   // how long to wait in a lobby or waiting room before giving up
const NAME_BOX = '#input-for-name, input[aria-label*="name" i], input[placeholder*="name" i]';
// Buttons seen before the meeting starts, matched by visible text, in the order they usually come up.
const PRE_JOIN = [
  /join from (your )?browser/i,                          // Zoom launch page
  /continue without microphone/i,                     // Google Meet
  /join audio by computer|join with computer audio/i, // Zoom audio prompt
  /^(join|join now|ask to join|join meeting)$/i,      // the main join button
];
const LEAVE = /^leave( call| meeting)?$/i;           // only on screen once you are inside
const WAITING = /waiting room|let you in|host will admit/i;
const ENDED = /meeting has (been )?ended|ended by (the )?host|host has ended|meeting is over|removed from (the )?meeting/i;

const visible = (loc) => loc.first().isVisible().catch(() => false);
const bodyText = (page) => page.locator('body').innerText({ timeout: 2000 }).catch(() => '');

// One second of silence as a WAV file. Chromium uses it as the bot's microphone so nothing beeps into the meeting.
function silentWav(seconds) {
  const rate = 16000;
  const n = rate * seconds;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
}

// Loudness from 0 to 1 of a chunk of 16-bit audio.
function loudness(buf) {
  const s16 = new Int16Array(new Uint8Array(buf).buffer);
  let sum = 0;
  for (const v of s16) sum += v * v;
  return Math.sqrt(sum / (s16.length || 1)) / 32768;
}

// Gets through the pre-join screens. Resolves true once the Leave button is on screen.
async function getIn(page, name, log, isStopped) {
  const clicked = new Map();
  const deadline = Date.now() + JOIN_MS;
  let waiting = false;
  while (Date.now() < deadline && !isStopped()) {
    if (await visible(page.getByRole('button', { name: LEAVE }))) return true;
    if (ENDED.test(await bodyText(page))) throw new Error('the host ended the meeting before Hudbot got in');
    const box = page.locator(NAME_BOX).first();
    if ((await visible(box)) && !(await box.inputValue().catch(() => ''))) await box.fill(name).catch(() => {});
    for (const re of PRE_JOIN) {
      const btn = page.getByRole('button', { name: re }).or(page.getByRole('link', { name: re })).first();
      if ((await visible(btn)) && Date.now() - (clicked.get(re) ?? 0) > 8e3) {
        clicked.set(re, Date.now());
        await btn.click().catch(() => {});
      }
    }
    if (!waiting && WAITING.test(await bodyText(page))) {
      waiting = true;
      log('in the waiting room: the host has to let Hudbot in');
    }
    await sleep(1500);
  }
  return false;
}

async function join(url, opts) {
  const dir = path.join(here, 'out', new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'));
  await mkdir(path.join(dir, 'frames'), { recursive: true });
  const t0 = Date.now();
  const log = (msg) => console.log(`[${mmss((Date.now() - t0) / 1000)}] ${msg}`);
  const silence = path.join(dir, 'silence.wav');
  await writeFile(silence, silentWav(1));

  const meta = { url, name: opts.name, startedAt: new Date(t0).toISOString(), title: '', stop: '' };
  const pcm = createWriteStream(path.join(dir, 'audio.pcm'));
  const frames = [];
  let lastLoud = 0;
  let stop = null;   // set to the reason once the meeting is over
  process.once('SIGINT', () => { stop ??= 'you pressed Ctrl+C'; });

  const browser = await chromium.launch({
    ...browserOptions(),
    headless: false,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${silence}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  let failure = null;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await context.exposeFunction('__hudAudio', (b64) => {
      const buf = Buffer.from(b64, 'base64');
      pcm.write(buf);
      if (loudness(buf) > 0.005) lastLoud = Date.now();
    });
    await context.addInitScript({ path: path.join(here, 'tap-audio.js') });
    const page = await context.newPage();

    let lastHash = '';
    const shot = async () => {
      const buf = await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => null);
      if (!buf) return;
      const hash = createHash('md5').update(buf).digest('hex');
      if (hash === lastHash) return;   // same picture as last time
      lastHash = hash;
      const file = `frames/${String(frames.length + 1).padStart(4, '0')}.jpg`;
      await writeFile(path.join(dir, file), buf);
      const sec = Math.round((Date.now() - t0) / 1000);
      frames.push({ file, at: mmss(sec), sec });
    };

    await page.goto(browserLink(url), { waitUntil: 'domcontentloaded' });
    meta.title = await page.title().catch(() => '');
    log(`opened the link, joining as "${opts.name}"`);
    if (!(await getIn(page, opts.name, log, () => stop))) {
      if (stop) throw new Error('stopped before Hudbot got in');
      await page.screenshot({ path: path.join(dir, 'join-failed.jpg'), type: 'jpeg', quality: 70 }).catch(() => {});
      throw new Error(`could not get into the meeting. See ${path.join(dir, 'join-failed.jpg')}`);
    }

    const joinedAt = Date.now();
    const endAt = joinedAt + opts.maxMinutes * 60e3;
    let warned = false;
    let lastCheck = 0;
    let lastShot = 0;
    let lastLevel = 0;
    await shot();
    log('in the meeting: listening, and taking a screen capture every minute');
    while (!stop) {
      await sleep(1000);
      const now = Date.now();
      if (page.isClosed()) { stop = 'the browser window was closed'; break; }
      if (now >= endAt) { stop = `reached ${opts.maxMinutes} minutes`; break; }
      if (now - lastCheck > 15e3) {
        lastCheck = now;
        if (ENDED.test(await bodyText(page))) stop = 'the host ended the meeting';
      }
      if (now - lastShot > 60e3) { lastShot = now; await shot(); }
      if (now - lastLevel > 60e3) {
        lastLevel = now;
        log(now - lastLoud < 60e3 ? 'hearing the meeting' : 'quiet: no sound in the last minute');
      }
      if (!warned && now - joinedAt > 3 * 60e3 && now - lastLoud > 3 * 60e3) {
        warned = true;
        log('no meeting sound has reached Hudbot for 3 minutes. This site may use a path Hudbot cannot hear yet (see the README).');
      }
    }
  } catch (err) {
    failure = err;
  } finally {
    meta.stop = stop || (failure ? 'failed' : '');
    await browser.close().catch(() => {});
    pcm.end();
    await once(pcm, 'finish');
    await writeFile(path.join(dir, 'frames.json'), JSON.stringify(frames, null, 2));
    await writeFile(path.join(dir, 'meta.json'), JSON.stringify({ ...meta, endedAt: new Date().toISOString() }, null, 2));
    await rm(silence, { force: true });
  }
  if (failure) throw failure;
  log(`left the meeting (${stop}) after about ${Math.round((Date.now() - t0) / 60e3)} min`);
  console.log(`Recording folder: ${dir}`);
  if (!opts['no-make']) await make(dir, opts);
}

function transcribe(dir, lang) {
  return new Promise((resolve, reject) => {
    const py = spawn(process.env.HUDBOT_PYTHON || 'python', [path.join(here, 'transcribe.py'), dir, lang], { stdio: 'inherit' });
    py.on('error', reject);
    py.on('close', (code) => (code === 0
      ? resolve()
      : reject(new Error(`transcribe.py stopped with code ${code}. If it says No module named faster_whisper, set HUDBOT_PYTHON in bot/.env.`))));
  });
}

async function make(dir, opts) {
  const meta = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8').catch(() => '{}'));
  if (!(await exists(path.join(dir, 'transcript.json')))) {
    console.log('Transcribing on this PC (no API used). The first run downloads the speech model.');
    await transcribe(dir, opts.lang);
  }
  const segs = JSON.parse(await readFile(path.join(dir, 'transcript.json'), 'utf8'));
  if (!segs.length) throw new Error(`no speech found in ${dir}. Check the sound lines in the join log.`);
  const frames = JSON.parse(await readFile(path.join(dir, 'frames.json'), 'utf8').catch(() => '[]'));
  const minutes = Math.max(1, Math.round(segs.at(-1).end / 60));

  console.log(`Writing the notes with Claude Haiku 5.5, effort ${opts.effort} (${opts.engine})...`);
  const summary = await summarize({
    lines: segs.map((s) => ({ at: mmss(s.start), text: s.text })),
    frames: pick(frames, 8),
    meta: { ...meta, minutes },
    dir,
    engine: opts.engine,
    effort: opts.effort,
  });
  await writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  await buildDeck(dir, summary, { ...meta, minutes });
  if (!opts['keep-audio']) await rm(path.join(dir, 'audio.pcm'), { force: true });
  console.log(`Slides ready: ${path.join(dir, 'slides.html')}`);
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const USAGE = `Usage:
  npm run join -- "<meeting link>" [--name "Jhon Mycho"] [--max-minutes 120] [--no-make]
  npm run make -- "<folder in out/>" [--engine api|subscription] [--effort max|high|xhigh|medium|low] [--lang auto|tl|en] [--keep-audio]`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string', default: "Jhon Mycho" },
    'max-minutes': { type: 'string', default: '120' },
    engine: { type: 'string', default: 'api' },
    effort: { type: 'string', default: 'max' },
    lang: { type: 'string', default: 'auto' },
    'keep-audio': { type: 'boolean', default: false },
    'no-make': { type: 'boolean', default: false },
  },
});
const [cmd, target] = positionals;
const opts = { ...values, maxMinutes: Number(values['max-minutes']) };

try {
  if (!['api', 'subscription'].includes(opts.engine)) throw new Error(`unknown --engine "${opts.engine}"`);
  if (!EFFORTS.includes(opts.effort)) throw new Error(`unknown --effort "${opts.effort}"`);
  if (cmd === 'join' && target) await join(cleanLink(target), opts);
  else if (cmd === 'make' && target) await make(path.resolve(target), opts);
  else console.log(USAGE);
} catch (err) {
  console.error(`Hudbot stopped: ${err.message}`);
  process.exitCode = 1;
}
