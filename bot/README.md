# Hudbot for outside meetings

Hudbot joins a meeting link as a guest, records what is said and what is on screen, then writes a transcript, notes and a slide deck for you to read later.

## Set up once

1. Copy `.env.example` to `.env`. Paste your Anthropic API key after `ANTHROPIC_API_KEY=`.
2. In this folder, run `npm install`.
3. Microsoft Edge must be installed. It is on this PC.
4. The first transcript downloads the Whisper `large-v3-turbo` speech model (about 1.6 GB) from Hugging Face. It runs on your GPU, and no audio goes to any API.

## Join a meeting

```bash
npm run join -- "https://zoom.us/j/123456789?pwd=abc"
```

- A Brave window opens and joins as **Jhon Mycho**. Edge is used if Brave isn't installed. Use `--name "Jhon"` for the plain name.
- Hudbot leaves when the host ends the meeting, after `--max-minutes` (default 120), or when you press Ctrl+C.
- Meeting sound plays out of your speakers while Hudbot is in the call.
- Add `--no-make` to record only and write the notes later.

## Make the notes again

```bash
npm run make -- "out/2026-10-09-05-39-12"
```

- Uses the saved recording. If the transcript already exists, it is reused.
- Notes use Claude Haiku 5.5 at `--effort max`, as you asked. On a 7-line test it thought for about 43,000 tokens: about 2.5 minutes and roughly 2 cents. A long meeting costs more. If the run says it ran out of room, use `--effort high`.
- When the API credit runs out, the run stops and keeps the transcript. Finish on your Claude subscription with `--engine subscription`. That uses your Claude Code login, so it is text only: no screen captures.

## Output

Each run makes a folder in `out/`:

- `slides.html`: open it in a browser. Arrow keys, space or a swipe move between slides.
- `summary.json`: the notes as data.
- `transcript.txt`: the words with timestamps.
- `frames/`: screen captures, one a minute when the picture changes.
- `join-failed.jpg`: only when Hudbot could not get in. Send it over if a link does not work.

## Limits and things to know

- **Speaker names are unknown.** Hudbot hears one mixed sound, so it cannot tell who said what. Owners are a name only when someone was named out loud.
- **Only tested on a mock page so far.** Zoom, Meet and Teams have not been checked live. Run one real meeting before you rely on it.
- **Tell the room.** Recording people without telling them can break privacy law in some places. The bot's name in the call is the notice.
- **Screen captures show faces.** The transcript and the captures go to Anthropic when the notes are written.
- **Meeting links are saved** in `meta.json` in the run folder, so the passcode is on disk. Delete old run folders when done.

## Tests

```bash
npm test
```

Runs the slide and notes checks, a check that Edge hears WebRTC and Web Audio sound, and a join against the mock meeting page. The test tones are about -74 dB, so you will not hear them.
