import assert from 'node:assert/strict';
import {
  isMissingParentReportConflict,
  MISSING_PARENT_CONFIRMATION_DELAY_MS,
  shouldConfirmMissingParentReport,
} from './reportSyncConflict';

assert.equal(isMissingParentReportConflict({
  status: 'conflict',
  entityType: 'report',
  code: 'missing_parent',
}), true);

assert.equal(isMissingParentReportConflict({
  status: 'conflict',
  entityType: 'event',
  code: 'missing_parent',
}), false);

assert.equal(isMissingParentReportConflict({
  status: 'conflict',
  entityType: 'report',
  code: 'revision_conflict',
}), false);

assert.equal(isMissingParentReportConflict({
  status: 'applied',
  entityType: 'report',
  code: 'missing_parent',
}), false);

const firstSeenAt = '2026-07-10T10:00:00.000Z';
const mutationId = '00000000-0000-4000-8000-000000000001';
const firstSeenMs = Date.parse(firstSeenAt);

assert.equal(shouldConfirmMissingParentReport(null, mutationId, firstSeenMs + 60_000), false);
assert.equal(shouldConfirmMissingParentReport({ mutationId, firstSeenAt }, 'different', firstSeenMs + 60_000), false);
assert.equal(shouldConfirmMissingParentReport(
  { mutationId, firstSeenAt },
  mutationId,
  firstSeenMs + MISSING_PARENT_CONFIRMATION_DELAY_MS - 1,
), false);
assert.equal(shouldConfirmMissingParentReport(
  { mutationId, firstSeenAt },
  mutationId,
  firstSeenMs + MISSING_PARENT_CONFIRMATION_DELAY_MS,
), true);
assert.equal(shouldConfirmMissingParentReport(
  { mutationId, firstSeenAt: 'invalid' },
  mutationId,
  firstSeenMs + 60_000,
), false);

console.log('reportSyncConflict: 9 tests passed');
