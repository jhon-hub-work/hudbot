// Writes the notes: a title, a short story, slide-sized points, decisions, action items and what to check.
// Default engine: the Anthropic API, Claude Haiku 5.5 at effort max (uses your API credit).
// Subscription engine: your Claude Code login on this PC, through `claude -p` (text only, no screen captures).
import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const MODEL = 'claude-haiku-5-5';

export const SYSTEM = `You are Hudbot. Jhon could not attend this meeting, so you sat in on it for him. Explain it in short, plain slides he can read in a few minutes. Use only what the transcript and the screen captures show. Never invent names, numbers, dates or decisions. The transcript comes from speech recognition, so some words are wrong: when something is unclear, put it under "uncertain" instead of guessing. The sound has no speaker labels, so an action owner is a name only if someone was named out loud; otherwise write "Unassigned". Explain any jargon the meeting used. Write plain slide text: never address Jhon by name, and never talk about yourself, your own arithmetic or the transcript quality (say unclear things under "uncertain").`;

export const ASK = `Reply with one JSON object and nothing else, with exactly these keys:
{"title": "max 8 words",
 "in_short": "two plain sentences: what the meeting was about and how it ended",
 "slides": [{"title": "max 6 words", "points": ["up to 3 short points, max 18 words each"], "frame": "file name of a screen capture to show on this slide, or empty"}],
 "decisions": ["..."],
 "actions": [{"who": "name or Unassigned", "task": "...", "due": "or empty"}],
 "for_you": ["what Jhon needs to do or check, or empty"],
 "uncertain": ["what was unclear in the transcript"]}
Make 5 to 7 slides, short enough to read in one glance. The first slide is the short version. For a long meeting, group topics so each slide stays small. Use an empty list when there is nothing for a key.`;

// lines: [{at: "mm:ss", text}], frames: [{file, at}], meta: {title, startedAt, minutes}, dir: run folder
export async function summarize({ lines, frames, meta, dir, engine, effort }) {
  const transcript = [
    `Meeting: ${meta.title || 'untitled'}`,
    `Started: ${meta.startedAt || 'unknown'}, about ${meta.minutes} min long`,
    '',
    'Transcript:',
    ...lines.map((l) => `[${l.at}] ${l.text}`),
  ].join('\n');
  const reply = engine === 'subscription'
    ? await viaSubscription(transcript, effort)
    : await viaApi(transcript, frames, dir, effort);
  return normalize(parseNotes(reply), frames.map((f) => f.file), engine === 'subscription' ? 'subscription' : 'api');
}

async function viaApi(transcript, frames, dir, effort) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('no ANTHROPIC_API_KEY. Put your key in bot/.env first.');
  const client = new Anthropic();
  const content = [{ type: 'text', text: transcript }];
  for (const f of frames) {
    const data = (await readFile(path.join(dir, f.file))).toString('base64');
    content.push({ type: 'text', text: `Screen capture ${f.file}, taken at ${f.at}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
  }
  content.push({ type: 'text', text: ASK });
  try {
    const msg = await client.messages.stream({
      model: MODEL,
      max_tokens: 128000,   // Haiku 5.5's output limit. At max effort most of this goes to thinking.
      thinking: { type: 'adaptive' },
      output_config: { effort },
      system: SYSTEM,
      messages: [{ role: 'user', content }],
    }).finalMessage();
    if (msg.stop_reason === 'refusal') throw new Error('Claude declined to write these notes');
    if (msg.stop_reason === 'max_tokens') {
      throw new Error(`the notes ran out of room: thinking used the whole 128,000-token budget. The transcript is saved. Try: npm run make -- "${dir}" --effort high`);
    }
    return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  } catch (err) {
    // 402 is billing_error. Some accounts report an empty balance as a 400 "credit balance" error instead.
    if (err instanceof Anthropic.APIError && (err.status === 402 || (err.status === 400 && /credit balance/i.test(err.message)))) {
      throw new Error(`your Anthropic API credit is used up. The transcript is saved in ${dir}. Finish on your Claude subscription with: npm run make -- "${dir}" --engine subscription`);
    }
    throw err;
  }
}

function viaSubscription(transcript, effort) {
  return new Promise((resolve, reject) => {
    const claude = spawn('claude', ['-p', '--model', MODEL, '--effort', effort]);
    let out = '';
    let err = '';
    claude.stdout.on('data', (d) => (out += d));
    claude.stderr.on('data', (d) => (err += d));
    claude.on('error', reject);
    claude.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`claude -p stopped with code ${code}: ${err.trim()}`))));
    claude.stdin.end(`${SYSTEM}\n\n${transcript}\n\n${ASK}`);
  });
}

// Pulls the JSON object out of the reply, even when the model wrapped it in words or a code fence.
export function parseNotes(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('the reply had no JSON in it');
  const out = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(out.slides) || !out.slides.length) throw new Error('the reply had no slides');
  return out;
}

// Cleans the reply into the shape slides.js expects. A frame Claude invented is dropped.
export function normalize(out, frameFiles, engine) {
  const list = (v, n = 20) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean).slice(0, n) : []);
  const text = (v, n) => String(v ?? '').slice(0, n);
  return {
    title: text(out.title, 80) || 'Meeting notes',
    in_short: text(out.in_short, 600),
    slides: out.slides.slice(0, 12).map((s) => ({
      title: text(s.title, 80),
      points: list(s.points, 4).map((p) => p.slice(0, 200)),
      frame: frameFiles.includes(s.frame) ? s.frame : '',
    })),
    decisions: list(out.decisions),
    actions: (Array.isArray(out.actions) ? out.actions : [])
      .slice(0, 30)
      .map((a) => ({ who: text(a?.who, 60) || 'Unassigned', task: text(a?.task, 200), due: text(a?.due, 60) }))
      .filter((a) => a.task),
    for_you: list(out.for_you),
    uncertain: list(out.uncertain),
    model: MODEL,
    engine,
    at: new Date().toISOString(),
  };
}
