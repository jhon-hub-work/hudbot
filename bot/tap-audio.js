// Browser side of Hudbot. Playwright injects this file into the meeting page before the page's own code runs.
// It sends the meeting's remote audio to Node as 16 kHz mono 16-bit PCM, one second per call to window.__hudAudio.
// Two sources, never both: remote WebRTC audio tracks (Meet, Teams, most web calls), or the page's Web Audio
// output when no WebRTC audio shows up (clients that decode the meeting themselves).
// ponytail: ScriptProcessorNode is deprecated but Chromium still runs it; AudioWorklet is the upgrade path.
(() => {
  const RATE = 16000;
  const nativeConnect = AudioNode.prototype.connect;
  let mixer = null;         // our own AudioContext that adds the remote WebRTC tracks together
  let mixIn = null;
  let rtcSeen = false;      // once WebRTC audio exists, Web Audio output is dropped so nothing is heard twice
  const taps = new Map();   // one summing tap per page AudioContext, for the Web Audio path
  let queue = [];           // Float32 blocks at RATE waiting to be sent
  let queued = 0;

  // Average the block down to 16 kHz, then send whole seconds.
  function sink(block, rate) {
    const ratio = rate / RATE;
    const n = Math.floor(block.length / ratio);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * ratio);
      const b = Math.max(a + 1, Math.min(block.length, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = a; j < b; j++) sum += block[j];
      out[i] = sum / (b - a);
    }
    queue.push(out);
    queued += n;
    while (queued >= RATE) {
      const second = new Float32Array(RATE);
      let at = 0;
      while (at < RATE) {
        const head = queue[0];
        const take = Math.min(head.length, RATE - at);
        second.set(head.subarray(0, take), at);
        at += take;
        if (take < head.length) queue[0] = head.subarray(take);
        else queue.shift();
      }
      queued -= RATE;
      Promise.resolve(window.__hudAudio(toBase64(second))).catch(() => {});
    }
  }

  function toBase64(f32) {
    const i16 = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const bytes = new Uint8Array(i16.buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  // A ScriptProcessor hands over its input block about every 85 ms. Its gain is 0, so it adds no sound.
  function wire(ctx, input, onBlock) {
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    nativeConnect.call(input, proc);
    nativeConnect.call(proc, mute);
    nativeConnect.call(mute, ctx.destination);
    proc.onaudioprocess = (e) => onBlock(e.inputBuffer.getChannelData(0), ctx.sampleRate);
  }

  // Path 1: WebRTC remote audio. Each remote audio track goes into our mixer.
  const NativeRTC = window.RTCPeerConnection;
  const playing = [];       // keeps the helper <audio> elements alive
  if (NativeRTC) {
    const Patched = function (...args) {
      const pc = new NativeRTC(...args);
      pc.addEventListener('track', (e) => {
        if (e.track.kind !== 'audio') return;
        rtcSeen = true;
        if (!mixer) {
          mixer = new AudioContext();
          mixIn = mixer.createGain();
          wire(mixer, mixIn, sink);
        }
        const stream = new MediaStream([e.track]);
        // Chromium only feeds a remote track into Web Audio while an <audio> element also plays it.
        // The element is muted, so nothing plays twice.
        const el = document.createElement('audio');
        el.muted = true;
        el.srcObject = stream;
        el.play().catch(() => {});
        playing.push(el);
        nativeConnect.call(mixer.createMediaStreamSource(stream), mixIn);
      });
      return pc;
    };
    Patched.prototype = NativeRTC.prototype;
    Object.setPrototypeOf(Patched, NativeRTC);
    window.RTCPeerConnection = Patched;
  }

  // Path 2: Web Audio. Anything a page connects to its speakers is also copied into a tap.
  function tapFor(ctx) {
    if (!taps.has(ctx)) {
      const sum = ctx.createGain();
      taps.set(ctx, sum);
      wire(ctx, sum, (block, rate) => { if (!rtcSeen) sink(block, rate); });
    }
    return taps.get(ctx);
  }
  AudioNode.prototype.connect = function (dest, ...rest) {
    const out = nativeConnect.call(this, dest, ...rest);
    if (dest instanceof AudioDestinationNode && this.context !== mixer) {
      nativeConnect.call(this, tapFor(this.context));
    }
    return out;
  };
})();
