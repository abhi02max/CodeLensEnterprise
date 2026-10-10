import assert from 'node:assert/strict';
import { test } from 'node:test';
import { operationPollingInterval as interval } from '../src/lib/operation-polling';

test('active materialization and validation retain one-second reads', () => {
  for (const status of ['QUEUED', 'PREPARING', 'APPLYING', 'RUNNING']) {
    assert.equal(interval([{ status, cleanup: 'NOT_STARTED' }]), 1000);
    assert.equal(interval([{ state: status, cleanup: 'DISPOSED' }]), 1000);
  }
});

test('authoritative success, failure and cancellation stop periodic reads', () => {
  for (const status of ['APPLIED', 'COMPLETED', 'FAILED', 'CANCELLED']) {
    assert.equal(interval([{ status, cleanup: 'DISPOSED' }]), false);
  }
  assert.equal(interval([]), false);
});

test('uncertain cleanup remains recoverable without inventing termination', () => {
  assert.equal(interval([{ status: 'FAILED', cleanup: 'UNCERTAIN' }]), 10_000);
  assert.equal(interval([{ status: 'APPLIED', cleanup: 'UNCERTAIN' }]), 10_000);
});

test('unknown, absent and failed reads retain conservative recovery', () => {
  assert.equal(interval(undefined), 10_000);
  assert.equal(interval([{ status: 'UNKNOWN', cleanup: 'DISPOSED' }]), 10_000);
  assert.equal(interval([{ cleanup: 'NOT_STARTED' }]), 10_000);
  assert.equal(interval([{ status: 'APPLIED', cleanup: 'DISPOSED' }], true), 10_000);
});

test('a terminal row cannot suppress another active operation', () => {
  assert.equal(
    interval([
      { status: 'FAILED', cleanup: 'DISPOSED' },
      { status: 'APPLYING', cleanup: 'UNCERTAIN' },
    ]),
    1000,
  );
});

test('recovery resumes active polling and stops only after authoritative readback', () => {
  assert.equal(interval([{ state: 'UNKNOWN', cleanup: 'UNCERTAIN' }]), 10_000);
  assert.equal(interval([{ state: 'RUNNING', cleanup: 'NOT_STARTED' }]), 1000);
  assert.equal(interval([{ state: 'FAILED', cleanup: 'DISPOSED' }]), false);
});
