import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import config from '../tailwind.config';
import {
  Alert,
  Badge,
  Button,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Label,
  LoadingRegion,
  PageHeader,
  SectionHeader,
  Select,
  SeverityLabel,
  Skeleton,
  Spinner,
  StatusLabel,
  Textarea,
} from '../src/components/ui/primitives';
import { RiskBadge, RunStatusBadge, SeverityBadge } from '../src/components/risk';
import { cn } from '../src/lib/cn';

const render = renderToStaticMarkup;
const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
const colors = Object.fromEntries(
  [...css.matchAll(/--cl-([\w-]+): (\d+) (\d+) (\d+);/g)].map((m) => [
    m[1]!,
    [Number(m[2]), Number(m[3]), Number(m[4])],
  ]),
);
function luminance(rgb: number[]) {
  const linear = rgb.map((v) =>
    v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4,
  );
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}
function contrast(a: string, b: string) {
  assert.ok(colors[a], `Missing token ${a}`);
  assert.ok(colors[b], `Missing token ${b}`);
  const [hi, lo] = [luminance(colors[a]!), luminance(colors[b]!)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

test('Tailwind semantic color roles reference defined CSS tokens with opacity support', () => {
  const mapped = JSON.stringify(config.theme?.extend?.colors);
  const references = [...mapped.matchAll(/var\(--cl-([\w-]+)\)/g)];
  assert.ok(references.length > 50);
  for (const m of references) assert.ok(colors[m[1]!], `Undefined ${m[1]}`);
  assert.match(mapped, /<alpha-value>/);
});

test('major text, status, severity, diff and button combinations meet 4.5:1', () => {
  const pairs: [string, string][] = [
    ['text-primary', 'canvas'],
    ['text-secondary', 'surface'],
    ['text-muted', 'surface-subtle'],
    ['text-muted', 'surface-muted'],
    ['text-inverse', 'interactive'],
    ['text-inverse', 'interactive-hover'],
    ['text-inverse', 'success-solid'],
    ['text-inverse', 'success-hover'],
    ['text-inverse', 'danger-solid'],
    ['text-inverse', 'danger-hover'],
    ['selected-text', 'selected'],
    ['selected-text', 'selected-hover'],
    ['diff-add-text', 'diff-add-bg'],
    ['diff-delete-text', 'diff-delete-bg'],
    ['diff-line-number', 'surface'],
    ...[
      'success',
      'warning',
      'danger',
      'info',
      'unavailable',
      'uncertain',
      'critical',
      'high',
      'medium',
      'low',
    ].map((s): [string, string] => [`${s}-text`, `${s}-bg`]),
  ];
  for (const [fg, bg] of pairs)
    assert.ok(contrast(fg, bg) >= 4.5, `${fg}/${bg}: ${contrast(fg, bg)}`);
});

test('control borders and focus contrast exceed 3:1 on representative surfaces', () => {
  for (const bg of ['canvas', 'surface', 'surface-subtle', 'surface-raised', 'selected']) {
    assert.ok(contrast('focus', bg) >= 3);
    assert.ok(contrast('border-strong', bg) >= 3);
  }
  assert.notDeepEqual(colors.focus, colors['selected-text']);
  assert.notDeepEqual(colors['selected-text'], colors['success-text']);
});

test('button retains native submit type and pending/disabled contracts', () => {
  const html = render(
    <Button type="submit" loading>
      Sign in
    </Button>,
  );
  assert.match(html, /type="submit"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /Sign in/);
  assert.match(render(<Button disabled>Accept proposal</Button>), /disabled=""/);
  assert.doesNotMatch(render(<Button>Review</Button>), /disabled=|aria-busy=/);
});

test('semantic typography and text color merge independently', () => {
  const button = render(<Button variant="primary">Sign in</Button>);
  assert.match(button, /text-content-inverse/);
  assert.match(button, /text-compact/);
  const badge = render(<Badge tone="info">Running</Badge>);
  assert.match(badge, /text-metadata/);
  assert.match(badge, /text-state-info-text/);
  assert.equal(
    cn('text-compact text-content-inverse', 'text-body text-content-primary'),
    'text-body text-content-primary',
  );
  assert.equal(cn('text-sm text-white', 'text-lg text-black'), 'text-lg text-black');
  assert.equal(
    cn('px-control-x py-section-y rounded-control', 'px-4 py-2 rounded-lg'),
    'px-4 py-2 rounded-lg',
  );
  assert.equal(
    cn('px-4 py-2 rounded-lg', 'px-section-x py-section-y rounded-frame'),
    'px-section-x py-section-y rounded-frame',
  );
  const dense = render(<Button density="comfortable">Review</Button>);
  assert.match(dense, /min-h-row-comfortable/);
  assert.doesNotMatch(dense, /min-h-[89](?:\s|\")/);
});

test('button presentation supports existing variants and opt-in density without DOM prop leakage', () => {
  for (const variant of ['primary', 'secondary', 'ghost', 'approve', 'reject', 'danger'] as const) {
    assert.match(render(<Button variant={variant}>Action</Button>), />Action<\/button>/);
  }
  assert.match(render(<Button density="compact">Review</Button>), /min-h-row-compact/);
  assert.match(render(<Button density="comfortable">Review</Button>), /min-h-row-comfortable/);
  assert.doesNotMatch(render(<Button density="compact">Review</Button>), /density=/);
  assert.match(render(<Button size="sm">Review</Button>), /min-h-7/);
});

test('icon-only native name is forwarded; spinner is decorative and non-focusable', () => {
  assert.match(
    render(
      <Button aria-label="Copy review link">
        <Spinner />
      </Button>,
    ),
    /aria-label="Copy review link"/,
  );
  const spinner = render(<Spinner />);
  assert.match(spinner, /aria-hidden="true"/);
  assert.match(spinner, /focusable="false"/);
});

test('header variants preserve heading levels and wrap titles/actions without framing', () => {
  const title = 'A long source and provenance title that must remain readable';
  for (const Component of [SectionHeader, CardHeader]) {
    const html = render(<Component title={title} actions={<Button>Inspect source</Button>} />);
    assert.match(html, /<h2/);
    assert.match(html, /break-words/);
    assert.match(html, /flex-wrap/);
    assert.doesNotMatch(html, /truncate/);
  }
  const page = render(<PageHeader title={title} />);
  assert.match(page, /<h1/);
  assert.doesNotMatch(page, /rounded|shadow|bg-surface/);
  assert.doesNotMatch(render(<SectionHeader title={title} />), /rounded|shadow|border/);
});

test('status text/context is explicit, escaped and separate from severity', () => {
  for (const tone of [
    'neutral',
    'success',
    'warning',
    'danger',
    'info',
    'unavailable',
    'uncertain',
  ] as const) {
    assert.match(
      render(<StatusLabel label="UNCERTAIN" tone={tone} context="cleanup" />),
      /UNCERTAIN.*cleanup/,
    );
  }
  assert.match(render(<StatusLabel label="<script>" />), /&lt;script&gt;/);
  assert.match(render(<SeverityLabel severity="HIGH" />), /text-severity-high-text.*HIGH/);
  assert.doesNotMatch(render(<StatusLabel label="HIGH" />), /severity-high/);
});

test('compatibility risk wrappers preserve level/score and severity order labels', () => {
  assert.match(render(<RiskBadge level="HIGH" score={78} />), /HIGH.*78/);
  assert.doesNotMatch(render(<RiskBadge level="HIGH" />), /numeric/);
  for (const severity of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const) {
    assert.match(render(<SeverityBadge severity={severity} />), new RegExp(`>${severity}<`));
  }
  assert.match(render(<RunStatusBadge status="COMPLETED" />), /text-state-info-text.*COMPLETED/);
  assert.doesNotMatch(render(<RunStatusBadge status="COMPLETED" />), /SAFE|success/);
  for (const status of ['UNCERTAIN', 'UNAVAILABLE', 'FAILED', 'RUNNING']) {
    assert.match(render(<RunStatusBadge status={status} />), new RegExp(status));
  }
});

test('native form labels, disabled, invalid and error associations are preserved', () => {
  assert.match(render(<Label htmlFor="email">Email</Label>), /for="email"/);
  for (const Component of [Input, Select, Textarea]) {
    const html = render(
      <Component id="field" disabled aria-invalid="true" aria-describedby="field-error" />,
    );
    assert.match(html, /disabled=""/);
    assert.match(html, /aria-invalid="true"/);
    assert.match(html, /aria-describedby="field-error"/);
    assert.match(html, /disabled:text-content-disabled/);
    assert.match(html, /aria-\[invalid=true\]:border-state-danger-solid/);
  }
});

test('alerts preserve error versus polite feedback semantics', () => {
  assert.match(render(<Alert>Could not load review</Alert>), /role="alert"/);
  for (const tone of ['warning', 'info', 'success'] as const) {
    assert.match(
      render(
        <Alert tone={tone} title="Outcome">
          Explanation
        </Alert>,
      ),
      /role="status"/,
    );
  }
});

test('loading has a named status without duplicate decorative announcements', () => {
  const html = render(
    <LoadingRegion label="Loading review">
      <Skeleton className="h-8" />
    </LoadingRegion>,
  );
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /role="status"/);
  assert.match(html, /Loading review/);
  assert.match(render(<Skeleton />), /aria-hidden="true"/);
  assert.match(
    render(
      <p>
        <Skeleton />
      </p>,
    ),
    /<p><span/,
  );
  assert.doesNotMatch(html, /progressbar|percent/);
});

test('empty state supports legacy action plus optional secondary action', () => {
  const html = render(
    <EmptyState
      title="No findings"
      description="Within this analyzed scope"
      action={<Button>Inspect analysis</Button>}
      secondaryAction={<Button>Return to review</Button>}
    />,
  );
  assert.match(html, /No findings/);
  assert.match(html, /Within this analyzed scope/);
  assert.match(html, /Inspect analysis/);
  assert.match(html, /Return to review/);
  assert.doesNotMatch(render(<EmptyState title="No conversation" />), /<button/);
});

test('field values remain available rather than ellipsis-truncated', () => {
  const html = render(
    <dl>
      <Field label="Source revision">{'a'.repeat(40)}</Field>
    </dl>,
  );
  assert.match(html, /<dt/);
  assert.match(html, /<dd/);
  assert.doesNotMatch(html, /truncate/);
  assert.match(html, /a{40}/);
});

test('focus, reduced motion, density and geometry foundations are explicit', () => {
  assert.match(css, /:focus-visible\s*\{[^}]*outline: 2px solid rgb\(var\(--cl-focus\)\)/s);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none/);
  assert.match(css, /--cl-row-compact: 36px/);
  assert.match(css, /--cl-row-comfortable: 44px/);
  assert.match(css, /--cl-radius-control: 4px/);
  assert.match(css, /color-scheme: light/);
  assert.doesNotMatch(css, /gradient|\.dark\s*\{/);
});
