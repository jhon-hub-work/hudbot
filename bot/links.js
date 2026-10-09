// Meeting link helpers.
// Zoom's /j/ link opens a launch page that offers the desktop app first. The /wc/ form goes straight to the browser client.

// Links pasted from chat often keep their <angle brackets> or stray spaces. Remove them, and check it is a link.
export function cleanLink(text) {
  const link = String(text || '').trim().replace(/^<+|>+$/g, '').trim();
  if (!/^(https?|file):\/\//.test(link)) throw new Error(`not a meeting link: ${text}`);
  return link;
}

// The page Hudbot opens: Zoom's browser client for a Zoom /j/ link, otherwise the link itself.
export function browserLink(link) {
  const u = new URL(link);
  const m = u.pathname.match(/^\/j\/(\d+)\/?$/);
  if (m) u.pathname = `/wc/${m[1]}/join`;
  u.hash = '';
  return u.href;
}
