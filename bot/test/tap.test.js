import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';

const tapFile = fileURLToPath(new URL('../tap-audio.js', import.meta.url));

// A tone sent as a WebRTC track to a second connection in the same page.
const WEBRTC = `<script>
  (async () => {
    const ac = new AudioContext(), osc = ac.createOscillator(), out = ac.createMediaStreamDestination();
    osc.connect(out); osc.start();
    const a = new RTCPeerConnection(), b = new RTCPeerConnection();
    const gathered = (pc) => new Promise((r) => {
      if (pc.iceGatheringState === 'complete') return r();
      pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && r());
    });
    a.addTrack(out.stream.getAudioTracks()[0], out.stream);
    await a.setLocalDescription(await a.createOffer());
    await gathered(a);
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await gathered(b);
    await a.setRemoteDescription(b.localDescription);
  })();
</script>`;

// A tone sent straight to the speakers, the way a page that decodes the meeting itself would play it.
// Kept at about -74 dB so the test is not audible.
const WEBAUDIO = `<script>
  const ac = new AudioContext(), osc = ac.createOscillator(), quiet = ac.createGain();
  quiet.gain.value = 0.0002;
  osc.connect(quiet);
  quiet.connect(ac.destination);
  osc.start();
</script>`;

async function listen(html, ms) {
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: false,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const context = await browser.newContext();
    const chunks = [];
    await context.exposeFunction('__hudAudio', (b64) => { chunks.push(Buffer.from(b64, 'base64')); });
    await context.addInitScript({ path: tapFile });
    const page = await context.newPage();
    await page.setContent(html);
    await new Promise((r) => setTimeout(r, ms));
    return Buffer.concat(chunks);
  } finally {
    await browser.close();
  }
}

// Loudness from 0 to 1 of 16-bit mono PCM.
function loudness(pcm) {
  const s = new Int16Array(new Uint8Array(pcm).buffer);
  let sum = 0;
  for (const v of s) sum += v * v;
  return s.length ? Math.sqrt(sum / s.length) / 32768 : 0;
}

test('WebRTC audio reaches the tap as 16 kHz PCM', { timeout: 90_000 }, async () => {
  const pcm = await listen(WEBRTC, 5000);
  assert.ok(pcm.length > 64000, `only ${pcm.length} bytes arrived`);
  assert.ok(loudness(pcm) > 0.1, `too quiet: ${loudness(pcm).toFixed(3)}`);
});

test('Web Audio output reaches the tap as 16 kHz PCM', { timeout: 90_000 }, async () => {
  const pcm = await listen(WEBAUDIO, 5000);
  assert.ok(pcm.length > 64000, `only ${pcm.length} bytes arrived`);
  assert.ok(loudness(pcm) > 0.00005, `no signal: ${loudness(pcm).toFixed(6)}`);
});
