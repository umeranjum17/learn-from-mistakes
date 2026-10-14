import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plain } from '../src/check.mjs';

test('the sentence cap counts a sentence that starts lowercase, and e.g. does not end one', () => {
  assert.equal(plain('Retry failed. then it ran. then it passed.', 'change', { sentences: 3 }), '');
  assert.equal(plain('Retry failed. then it ran. then it passed. then it stopped.', 'change', { sentences: 3 }), 'change has more than 3 sentences');
  assert.equal(plain('Retry failed, e.g. the cache. Then it stopped.', 'change', { sentences: 2 }), '');
  assert.equal(plain('Retry failed, i.e. the cache. Then it stopped.', 'change', { sentences: 2 }), '');
});
