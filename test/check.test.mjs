import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plain } from '../src/check.mjs';

test('a sentence of 21 words is rejected and a sentence of 20 words passes', () => {
  const sentence = (n) => `${Array.from({ length: n }, (_, i) => `w${i}`).join(' ')}.`;
  assert.equal(plain(sentence(20), 'change', {}), '');
  assert.equal(plain(sentence(21), 'change', {}), 'change: sentence 1 has more than 20 words');
});

test('the sentence cap counts a sentence that starts lowercase, and e.g. does not end one', () => {
  assert.equal(plain('Retry failed. then it ran. then it passed.', 'change', { sentences: 3 }), '');
  assert.equal(plain('Retry failed. then it ran. then it passed. then it stopped.', 'change', { sentences: 3 }), 'change has more than 3 sentences');
  assert.equal(plain('Retry failed, e.g. the cache. Then it stopped.', 'change', { sentences: 2 }), '');
  assert.equal(plain('Retry failed, i.e. the cache. Then it stopped.', 'change', { sentences: 2 }), '');
});
