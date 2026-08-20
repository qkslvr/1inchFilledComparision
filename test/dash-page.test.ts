import assert from 'node:assert/strict';
import test from 'node:test';
import { PAGE } from '../src/dash/page.js';

/** The dashboard is one big template literal that emits browser JavaScript, so
 *  a stray quote in a subtitle is a syntax error the compiler cannot see: the
 *  TypeScript is valid, the string it produces is not. That shipped once — an
 *  apostrophe in "the winning solver's" ended a single-quoted JS string and
 *  every dashboard went blank, including the ones that had nothing to do with
 *  the change, because they all share the same script block.
 *
 *  `new Function` compiles without executing, which is exactly the check the
 *  browser does before running any of it. */
function scriptBlocks(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
}

test('the page emits at least one script block', () => {
  assert.ok(scriptBlocks(PAGE).length > 0);
});

test('every emitted script block is syntactically valid JavaScript', () => {
  for (const [i, js] of scriptBlocks(PAGE).entries()) {
    assert.doesNotThrow(() => new Function(js), `script block ${i} does not parse`);
  }
});

test('the page has no unbalanced script or style tags', () => {
  // The style block for the solver controls was inserted by matching on
  // '<script>', so a mistake there would nest one inside the other and the
  // browser would silently swallow the rest of the page.
  const count = (re: RegExp) => (PAGE.match(re) ?? []).length;
  assert.equal(count(/<script>/g), count(/<\/script>/g));
  assert.equal(count(/<style>/g), count(/<\/style>/g));
  assert.ok(PAGE.indexOf('<style>') < PAGE.indexOf('</head>'), 'styles belong in the head');
});

test('every dataset the dashboard serves has a subtitle', () => {
  // A missing key falls back silently, which reads as the wrong description
  // rather than as a bug.
  for (const key of ['fusion', 'cow', 'cow-solver']) {
    assert.ok(PAGE.includes(`${key}:`) || PAGE.includes(`'${key}':`), `no subtitle for ${key}`);
  }
});
