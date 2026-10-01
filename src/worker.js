const MAX_PEERS = 4;
const STUN_ONLY = [{ urls: "stun:stun.cloudflare.com:3478" }];

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/ws/")) {
      const room = url.pathname.slice(4);
      if (!/^[a-z0-9-]{6,64}$/.test(room)) return new Response("bad room", { status: 400 });
      return env.ROOM.get(env.ROOM.idFromName(room)).fetch(req);
    }
    if (url.pathname === "/api/ice") return ice(env);
    const n = url.pathname.match(/^\/api\/(?:notes|room)\/([a-z0-9-]{6,64})\/(audio|lines|summarize|status)$/);
    if (n) return env.ROOM.get(env.ROOM.idFromName(n[1])).fetch(req);
    return env.ASSETS.fetch(req);
  },
};

// Short-lived TURN credentials from Cloudflare. Falls back to STUN-only if secrets are unset.
async function ice(env) {
  let iceServers = STUN_ONLY;
  if (env.TURN_KEY_ID && env.TURN_API_TOKEN) {
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.TURN_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: 86400 }),
      },
    );
    if (r.ok) iceServers = (await r.json()).iceServers;
  }
  return Response.json({ iceServers }, { headers: { "Cache-Control": "no-store" } });
}

const KEEP_MS = 30 * 864e5;     // notes are deleted 30 days after the last activity
const ROOM_MS = 24 * 36e5;      // a meeting link dies 24h after it was first used, even if nobody ends it
const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

// Whisper invents text on silence and noise. Drop the usual suspects.
const JUNK = /^[\s.!,]*(thank you\.?|thanks for watching[.!]?|you|bye\.?|\.+)?[\s.!,]*$/i;
function looksBad(t) {
  if (JUNK.test(t)) return true;
  const odd = [...t].filter((c) => c.charCodeAt(0) > 0x24f || /[ÞþðÆæ]/.test(c)).length;
  if (odd / t.length > 0.05) return true;
  const w = t.toLowerCase().split(/\s+/);
  return w.length >= 8 && new Set(w).size / w.length < 0.4;
}

// Spoken-language hints for Whisper. Taglish uses Tagalog plus a sample sentence so it keeps English words as English.
const ASR = {
  tl: { language: "tl", initial_prompt: "Kumusta, okay na ba tayo? Sige, simulan na natin ang meeting. Pakisend na lang bukas yung budget, ha, then i-check natin sa Friday." },
  en: { language: "en" },
};

function b64(buf) {
  const u = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

const mmss = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  #live() {
    return this.state.getWebSockets().filter((w) => !w.deserializeAttachment().dead);
  }

  async #lines() {
    return [...(await this.state.storage.list({ prefix: "l:" })).values()];
  }

  async #touch() {
    await this.state.storage.setAlarm(Date.now() + KEEP_MS);
  }

  // After 30 days the notes go. The "ended" mark stays so an old link never comes back to life.
  async alarm() {
    const keys = [...(await this.state.storage.list({ prefix: "l:" })).keys(), "summary"];
    for (let i = 0; i < keys.length; i += 128) await this.state.storage.delete(keys.slice(i, i + 128));
  }

  // Has this meeting ended (by the host, or by age)?
  async #ended() {
    const st = this.state.storage;
    let ended = await st.get("ended");
    let created = await st.get("created");
    if (!created) { created = Date.now(); await st.put("created", created); }
    if (!ended && Date.now() - created > ROOM_MS) { ended = Date.now(); await st.put("ended", ended); }
    return ended || 0;
  }

  async #endMeeting() {
    await this.state.storage.put("ended", Date.now());
    const msg = JSON.stringify({ type: "ended" });
    for (const w of this.state.getWebSockets()) {
      try { w.send(msg); w.close(1000, "ended"); } catch {}
    }
  }

  async #notes(req, url) {
    const action = url.pathname.split("/")[4];
    if (action === "status") return json({ ended: !!(await this.#ended()) });
    if (action === "lines" && req.method === "GET") {
      return json({ lines: await this.#lines(), summary: (await this.state.storage.get("summary")) || null });
    }
    if (action === "audio" && req.method === "POST") {
      const buf = await req.arrayBuffer();
      if (buf.byteLength < 2000 || buf.byteLength > 5_000_000) return json({ ok: true, text: "" });
      const name = (url.searchParams.get("name") || "Guest").slice(0, 30);
      const t = Number(url.searchParams.get("t")) || Date.now();
      let text = "";
      try {
        const r = await this.env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio: b64(buf), vad_filter: true, ...ASR[url.searchParams.get("asr")] });
        text = (r.text || "").trim();
      } catch (e) {
        return json({ ok: false, error: String(e.message || e) }, 502);
      }
      if (!text || looksBad(text)) return json({ ok: true, text: "" });
      await this.state.storage.put(`l:${String(t).padStart(15, "0")}:${crypto.randomUUID().slice(0, 4)}`, { t, name, text });
      await this.#touch();
      // live captions: everyone in the room sees this line
      const cap = JSON.stringify({ type: "caption", name, text, t });
      for (const w of this.state.getWebSockets()) { try { w.send(cap); } catch {} }
      return json({ ok: true, text });
    }
    if (action === "summarize" && req.method === "POST") {
      const taglish = url.searchParams.get("lang") === "taglish";
      const lines = await this.#lines();
      if (!lines.length) return json({ ok: false, error: "Hudbot didn't hear any speech yet." });
      const t0 = lines[0].t;
      const transcript = lines.map((l) => `[${mmss(l.t - t0)}] ${l.name}: ${l.text}`).join("\n").slice(-30000);
      const people = [...new Set(lines.map((l) => l.name))];
      let out;
      try {
        const r = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
          max_tokens: 1400,
          messages: [
            { role: "system", content: `You are Hudbot, the note-taker for a video meeting. You get a transcript with speaker names and write the minutes of meeting (MoM) ${taglish ? "in natural Taglish (a relaxed mix of Tagalog and English, the way Filipinos speak at work)" : "in clear English, even when people mix Filipino and English"}. The transcript comes from speech recognition, so some lines may be noise, gibberish or in a wrong language; ignore those. Use only facts from the transcript. Never invent names, dates, numbers or decisions. Reply with one JSON object and nothing else.` },
            { role: "user", content: `Transcript:\n${transcript}\n\nReturn JSON with exactly these keys: {"title": short title, max 8 words, "summary": 2 to 4 sentences, "topics": [short strings], "decisions": [strings], "actions": [{"owner": name or "Unassigned", "task": string, "due": string or ""}], "followups": [strings]}. Use empty arrays when there is nothing.` },
          ],
        });
        const raw = typeof r.response === "string" ? r.response : JSON.stringify(r.response);
        out = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);
      } catch (e) {
        return json({ ok: false, error: "Hudbot couldn't write the summary: " + String(e.message || e) }, 502);
      }
      const arr = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).slice(0, 20) : []);
      const summary = {
        title: String(out.title || "Meeting notes").slice(0, 80),
        summary: String(out.summary || ""),
        topics: arr(out.topics),
        decisions: arr(out.decisions),
        actions: (Array.isArray(out.actions) ? out.actions : []).slice(0, 30).map((a) => ({ owner: String(a?.owner || "Unassigned"), task: String(a?.task || ""), due: String(a?.due || "") })).filter((a) => a.task),
        followups: arr(out.followups),
        people,
        startedAt: t0,
        minutes: Math.max(1, Math.round((lines.at(-1).t - t0) / 60000)),
        at: Date.now(),
      };
      await this.state.storage.put("summary", summary);
      await this.#touch();
      return json({ ok: true, summary });
    }
    return json({ ok: false, error: "not found" }, 404);
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) return this.#notes(req, url);
    if (req.headers.get("Upgrade") !== "websocket") return new Response("websocket only", { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    const reject = (type) => {
      server.accept();
      server.send(JSON.stringify({ type }));
      server.close(1000, type);
      return new Response(null, { status: 101, webSocket: client });
    };
    if (await this.#ended()) return reject("ended");
    // A phone that dropped and came back must not count twice: retire its old socket first.
    const cid = (url.searchParams.get("cid") || "").slice(0, 32);
    for (const w of this.state.getWebSockets()) {
      const a = w.deserializeAttachment();
      if (cid && a.cid === cid && !a.dead) {
        w.serializeAttachment({ ...a, dead: true });
        this.#broadcast(w, { type: "leave", id: a.id });
        try { w.close(1000, "replaced"); } catch {}
      }
    }
    const peers = this.#live();
    if (peers.length >= MAX_PEERS) return reject("full");

    // The person who pressed "New meeting" holds a secret key and becomes the host. Nobody else can claim it.
    const hk = url.searchParams.get("hk") || "";
    let hostKey = await this.state.storage.get("host");
    if (hk.length >= 16 && !hostKey) { hostKey = hk; await this.state.storage.put("host", hk); }
    const host = !!hostKey && hk === hostKey;

    const name = (url.searchParams.get("name") || "Guest").slice(0, 30);
    const me = { id: crypto.randomUUID().slice(0, 8), name, host, cid };
    this.state.acceptWebSocket(server);
    server.serializeAttachment(me);
    server.send(JSON.stringify({ type: "welcome", id: me.id, host, peers: peers.map((w) => { const { id, name } = w.deserializeAttachment(); return { id, name }; }) }));
    this.#broadcast(server, { type: "join", id: me.id, name });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const me = ws.deserializeAttachment();
    if (m.type === "end") return me.host && (await this.#endMeeting());
    if (m.type === "state") return this.#broadcast(ws, { type: "state", id: me.id, cam: !!m.cam, mic: !!m.mic, share: !!m.share });
    if (m.type !== "signal") return;
    const target = this.state.getWebSockets().find((w) => w.deserializeAttachment().id === m.to);
    target?.send(JSON.stringify({ type: "signal", from: me.id, data: m.data }));
  }

  webSocketClose(ws) {
    const a = ws.deserializeAttachment();
    if (!a.dead) this.#broadcast(ws, { type: "leave", id: a.id });
    try { ws.close(); } catch {}
  }

  webSocketError(ws) {
    this.webSocketClose(ws);
  }

  #broadcast(except, msg) {
    const s = JSON.stringify(msg);
    for (const w of this.state.getWebSockets()) if (w !== except) { try { w.send(s); } catch {} }
  }
}
