import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, parseNotes } from '../summarize.js';

test('reads the JSON even when the reply has words around it', () => {
  const reply = 'Here you go:\n```json\n{"title":"Budget call","in_short":"We talked budget.","slides":[{"title":"Short version","points":["Budget is due Friday"],"frame":"frames/0002.jpg"}],"decisions":[],"actions":[],"for_you":["Send the file"],"uncertain":[]}\n```';
  const s = normalize(parseNotes(reply), ['frames/0001.jpg'], 'api');
  assert.equal(s.title, 'Budget call');
  assert.equal(s.slides[0].frame, '', 'a capture name Hudbot did not send is dropped');
  assert.deepEqual(s.for_you, ['Send the file']);
});

test('a reply without slides is an error', () => {
  assert.throws(() => parseNotes('{"title":"x"}'), /no slides/);
});
