// Draws the slides as one self-contained HTML file. Arrow keys, space, the buttons or a swipe move between slides.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const bullets = (items) => `<ul>${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
const slide = (title, body) => `<section class="slide"><h2>${esc(title)}</h2>${body}</section>`;

export function deckHtml(s, meta = {}) {
  const when = meta.startedAt ? new Date(meta.startedAt).toLocaleString() : '';
  const facts = [when, meta.minutes ? `${meta.minutes} min` : ''].filter(Boolean).join(' · ');
  const parts = [`<section class="slide cover"><p class="meta">${esc(facts)}</p><h1>${esc(s.title)}</h1><p class="lead">${esc(s.in_short)}</p></section>`];
  for (const sl of s.slides) {
    const img = sl.frame ? `<img class="frame" src="${esc(sl.frame)}" alt="Screen capture from the meeting">` : '';
    parts.push(slide(sl.title, bullets(sl.points) + img));
  }
  if (s.decisions.length) parts.push(slide('Decisions', bullets(s.decisions)));
  if (s.actions.length) parts.push(slide('Action items', bullets(s.actions.map((a) => `${a.who}: ${a.task}${a.due ? ` (${a.due})` : ''}`))));
  if (s.for_you.length) parts.push(slide('For you', `<div class="callout">${bullets(s.for_you)}</div>`));
  if (s.uncertain.length) parts.push(slide('Check these', bullets(s.uncertain)));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(s.title)}</title>
<style>
  :root { --bg: #0e1116; --fg: #eef1f6; --muted: #9aa4b2; --accent: #7aa2ff; --card: #171c24; --line: #2a3240; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); }
  body { font: 18px/1.5 system-ui, "Segoe UI", Roboto, sans-serif; }
  .slide { display: none; min-height: 100vh; min-height: 100dvh; padding: 56px 16px 110px; max-width: 880px; margin: 0 auto; flex-direction: column; justify-content: center; }
  .slide.on { display: flex; }
  h1 { font-size: clamp(30px, 7vw, 52px); line-height: 1.15; margin: 0 0 20px; }
  h2 { font-size: clamp(26px, 6vw, 42px); margin: 0 0 24px; }
  .lead { font-size: clamp(19px, 3.6vw, 26px); color: var(--muted); margin: 0; }
  .meta { color: var(--muted); margin: 0 0 16px; }
  ul { margin: 0; padding-left: 1.2em; }
  li { font-size: clamp(19px, 3.6vw, 26px); margin: 0 0 16px; }
  .frame { display: block; width: 100%; margin-top: 12px; border-radius: 12px; border: 1px solid var(--line); }
  .callout { background: var(--card); border-left: 4px solid var(--accent); padding: 16px 18px; border-radius: 10px; }
  nav { position: fixed; left: 0; right: 0; bottom: 0; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; background: var(--bg); border-top: 1px solid var(--line); }
  button { background: var(--card); color: var(--fg); border: 1px solid var(--line); border-radius: 10px; padding: 10px 18px; font: inherit; cursor: pointer; }
  button:disabled { opacity: .35; cursor: default; }
  #count { color: var(--muted); }
</style>
</head>
<body>
<main>
${parts.join('\n')}
</main>
<nav>
  <button id="prev">&larr; Back</button>
  <span id="count"></span>
  <button id="next">Next &rarr;</button>
</nav>
<script>
  const slides = [...document.querySelectorAll('.slide')];
  const prev = document.getElementById('prev'), next = document.getElementById('next'), count = document.getElementById('count');
  let i = 0;
  function show(n) {
    i = Math.max(0, Math.min(slides.length - 1, n));
    slides.forEach((el, k) => el.classList.toggle('on', k === i));
    prev.disabled = i === 0;
    next.disabled = i === slides.length - 1;
    count.textContent = (i + 1) + ' / ' + slides.length;
    window.scrollTo(0, 0);
  }
  prev.onclick = () => show(i - 1);
  next.onclick = () => show(i + 1);
  addEventListener('keydown', (e) => {
    if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); show(i + 1); }
    if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); show(i - 1); }
  });
  let startX = null;
  addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; }, { passive: true });
  addEventListener('touchend', (e) => {
    if (startX === null) return;
    const dx = e.changedTouches[0].clientX - startX;
    startX = null;
    if (Math.abs(dx) > 50) show(i + (dx < 0 ? 1 : -1));
  });
  show(0);
</script>
</body>
</html>
`;
}

export async function buildDeck(dir, summary, meta) {
  const file = path.join(dir, 'slides.html');
  await writeFile(file, deckHtml(summary, meta));
  return file;
}
