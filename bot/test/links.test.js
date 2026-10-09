import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserLink, cleanLink } from '../links.js';

test('a Zoom /j/ link becomes the browser join page, password kept', () => {
  assert.equal(
    browserLink('https://us05web.zoom.us/j/81009541567?pwd=abc.1#success'),
    'https://us05web.zoom.us/wc/81009541567/join?pwd=abc.1',
  );
});

test('other links are opened as they are', () => {
  assert.equal(browserLink('https://meet.google.com/abc-defg-hij'), 'https://meet.google.com/abc-defg-hij');
});

test('angle brackets and spaces from chat are removed, and non-links are refused', () => {
  assert.equal(cleanLink('  <https://zoom.us/j/1?pwd=x>  '), 'https://zoom.us/j/1?pwd=x');
  assert.throws(() => cleanLink('zoom meeting 123'), /not a meeting link/);
});
