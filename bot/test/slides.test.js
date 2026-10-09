import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deckHtml } from '../slides.js';

const summary = {
  title: 'Budget <script>alert(1)</script>',
  in_short: 'We agreed on the budget.',
  slides: [
    { title: 'Short version', points: ['Budget due Friday'], frame: 'frames/0001.jpg' },
    { title: 'Next steps', points: ['Send the file'], frame: '' },
  ],
  decisions: ['Ship on Friday'],
  actions: [{ who: 'Unassigned', task: 'Send the budget', due: 'Thu' }],
  for_you: ['Reply to Dr L'],
  uncertain: ['A name was unclear'],
};

test('one slide per section, extra slides only when they have content', () => {
  const html = deckHtml(summary, { minutes: 30 });
  // cover + 2 slides + decisions + action items + for you + check these
  assert.equal((html.match(/<section class="slide/g) || []).length, 7);
  assert.ok(html.includes('src="frames/0001.jpg"'));
});

test('text from the meeting is escaped, never run', () => {
  const html = deckHtml(summary, {});
  assert.ok(!html.includes('<script>alert'), 'a raw script tag leaked into the page');
  assert.ok(html.includes('Budget &lt;script&gt;'));
});

test('no extra slides when there is nothing for them', () => {
  const html = deckHtml({ ...summary, decisions: [], actions: [], for_you: [], uncertain: [] }, {});
  assert.equal((html.match(/<section class="slide/g) || []).length, 3);
});
