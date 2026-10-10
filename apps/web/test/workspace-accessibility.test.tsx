import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { restoreReviewFocus } from '../src/components/workspace/review-workspace';
import { ContextPanel } from '../src/components/workspace/context-panel';
import { ToolRunsPanel } from '../src/components/workspace/tool-runs-panel';
import type { RagContextSummary, ToolRunSummary } from '../src/lib/types';

// tsx's preserve-mode transform uses the classic runtime; Next uses automatic JSX.
const runtime = globalThis as typeof globalThis & { React?: typeof React };
const previousReact = runtime.React;
before(() => {
  runtime.React = React;
});
after(() => {
  if (previousReact) runtime.React = previousReact;
  else Reflect.deleteProperty(runtime, 'React');
});

function target(connected = true, visible = true) {
  let focused = 0;
  return {
    element: {
      isConnected: connected,
      getClientRects: () => (visible ? [{}] : []),
      focus: () => focused++,
    } as unknown as HTMLElement,
    count: () => focused,
  };
}

test('closing a drawer restores its still-visible opener', () => {
  const origin = target(),
    fallback = target();
  restoreReviewFocus(origin.element, fallback.element);
  assert.equal(origin.count(), 1);
  assert.equal(fallback.count(), 0);
});

test('a breakpoint-hidden opener returns focus to the visible changes region', () => {
  const origin = target(true, false),
    fallback = target();
  restoreReviewFocus(origin.element, fallback.element);
  assert.equal(origin.count(), 0);
  assert.equal(fallback.count(), 1);
});

test('a removed opener returns focus to the connected fallback', () => {
  const origin = target(false),
    fallback = target();
  restoreReviewFocus(origin.element, fallback.element);
  assert.equal(origin.count(), 0);
  assert.equal(fallback.count(), 1);
});

test('unmounted or hidden targets never receive focus', () => {
  const origin = target(false),
    fallback = target(true, false);
  restoreReviewFocus(origin.element, fallback.element);
  restoreReviewFocus(null, null);
  assert.equal(origin.count() + fallback.count(), 0);
});

test('repository context metadata keeps source meaning with the semantic muted color', () => {
  const context = {
    chunkCount: 1,
    totalTokens: 10,
    chunks: [
      {
        path: 'src/input.ts',
        symbol: 'input',
        forFilePath: 'src/check.ts',
        score: 0.5,
        kind: 'METHOD',
        sources: ['LEXICAL'],
      },
    ],
  } as RagContextSummary;
  const html = renderToStaticMarkup(<ContextPanel context={context} />);
  assert.match(html, /text-content-muted[^>]*> · input/);
  assert.match(html, /text-content-muted[^>]*>for src\/check.ts/);
  assert.match(html, /lexical/);
  assert.match(html, /0\.50/);
});

test('pipeline sequence and timing remain readable without changing recorded status', () => {
  const runs = [
    {
      id: 'tool',
      tool: 'static_analysis',
      sequence: 1,
      status: 'SUCCESS',
      durationMs: 640,
      cacheHit: false,
      error: null,
    },
  ] as ToolRunSummary[];
  const html = renderToStaticMarkup(<ToolRunsPanel toolRuns={runs} />);
  assert.match(html, /text-content-muted[^>]*>1/);
  assert.match(html, /text-content-muted[^>]*>640ms/);
  assert.match(html, /success/);
  assert.doesNotMatch(html, /text-slate-400/);
});
