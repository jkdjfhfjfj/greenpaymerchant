import assert from 'node:assert/strict';
import test from 'node:test';
import { formatFinancialAmount } from './money-format';

test('financial displays preserve KES wallet cents and provider fees', () => {
  assert.match(formatFinancialAmount(1.5, 'KES'), /1\.50$/);
  assert.match(formatFinancialAmount(150.25, 'KES'), /150\.25$/);
  assert.match(formatFinancialAmount(99.01, 'UGX'), /99\.01$/);
});

test('SLL display keeps the original currency and numeric denomination', () => {
  assert.equal(formatFinancialAmount(1500.25, 'SLL'), 'SLL 1,500.25');
});

test('missing or nonfinite amounts are not displayed as spendable funds', () => {
  assert.equal(formatFinancialAmount(null), '—');
  assert.equal(formatFinancialAmount(Infinity), '—');
  assert.equal(formatFinancialAmount(NaN, 'USD', '-'), '-');
});