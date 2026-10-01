// Hudbot: the drawing plus a tiny scheduler that makes it do things on its own.
(() => {
  const SVG = `<svg class="hb" viewBox="-8 -6 136 138" aria-hidden="true" data-mood="idle"><g class="hb-hop"><g class="hb-all">
    <g class="hb-leg l"><path d="M44 104V119H35"/></g>
    <g class="hb-leg r"><path d="M76 104V119H85"/></g>
    <g class="hb-arm l"><path d="M16 72L2 89"/></g>
    <g class="hb-arm r"><path d="M104 72L118 89"/></g>
    <g class="hb-ant"><path d="M60 30V15"/><circle cx="60" cy="11" r="5"/></g>
    <rect class="hb-body" x="16" y="30" width="88" height="76" rx="32"/>
    <rect class="hb-face" x="28" y="46" width="64" height="42" rx="21"/>
    <g class="hb-eyes"><g class="hb-look">
      <g class="hb-eye"><circle cx="48" cy="66" r="6.5"/></g><g class="hb-eye"><circle cx="72" cy="66" r="6.5"/></g>
    </g></g>
    <g class="hb-happy"><path d="M40 69Q48 59 56 69"/><path d="M64 69Q72 59 80 69"/></g>
    <g class="hb-asleep"><path d="M41 67H55"/><path d="M65 67H79"/></g>
    <ellipse class="hb-mouth" cx="60" cy="79" rx="4" ry="3"/>
    <ellipse class="hb-cheek" cx="36" cy="78" rx="5" ry="3"/><ellipse class="hb-cheek" cx="84" cy="78" rx="5" ry="3"/>
    <g class="hb-pad"><rect x="34" y="88" width="52" height="26" rx="5"/><path d="M42 97H78M42 105H68"/></g>
    <g class="hb-ripples"><circle cx="108" cy="58" r="8"/><circle cx="108" cy="58" r="8"/></g>
    <g class="hb-zz"><text x="92" y="38">z</text><text x="104" y="24">z</text></g>
    <g class="hb-spark"><path d="M6 24l5 5M11 24l-5 5"/><path d="M110 10l5 5M115 10l-5 5"/><path d="M116 44l4 4M120 44l-4 4"/></g>
  </g></g></svg>`;

  const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const rand = (a, b) => a + Math.random() * (b - a);

  // host: an element to draw the bot into. roam: how many px it may stroll sideways (0 = stays put).
  window.mountHudbot = (host, { roam = 0, mood = "idle", behave = true } = {}) => {
    host.classList.add("hbslot");
    host.innerHTML = SVG;
    const svg = host.firstElementChild;
    let current = mood, x = 0, busy = false, timer;
    svg.dataset.mood = mood;

    const act = (name, ms) => {
      if (busy) return;
      busy = true;
      svg.classList.add("act-" + name);
      setTimeout(() => { svg.classList.remove("act-" + name); busy = false; }, ms);
    };
    const walk = () => {
      if (!roam || busy) return;
      busy = true;
      const to = x < roam / 2 ? rand(roam * 0.6, roam) : rand(0, roam * 0.35);
      const ms = Math.max(1000, Math.abs(to - x) * 26);
      host.style.transition = `transform ${ms}ms var(--ease-io)`;
      host.style.transform = `translateX(${to}px)`;
      svg.classList.add("walking");
      x = to;
      setTimeout(() => { svg.classList.remove("walking"); busy = false; }, ms);
    };
    const doRandom = () => {
      const r = Math.random();
      if (r < 0.28) walk();
      else if (r < 0.46) act("wave", 1700);
      else if (r < 0.60) act(Math.random() < 0.5 ? "look-l" : "look-r", 1500);
      else if (r < 0.72) act("stretch", 1700);
      else if (r < 0.82) act("yawn", 1900);
      else if (r < 0.92) act("hop", 800);
      else act("tap", 1000);
    };
    const loop = () => {
      timer = setTimeout(() => {
        if (!document.hidden && current === "idle" && host.getClientRects().length) doRandom();
        loop();
      }, rand(4200, 9500));
    };
    if (behave && !reduce()) loop();

    return {
      el: svg,
      setMood(m) { if (m !== current) { current = m; svg.dataset.mood = m; } },
      poke() { if (current === "idle") act("wave", 1700); },
      get mood() { return current; },
    };
  };
})();
