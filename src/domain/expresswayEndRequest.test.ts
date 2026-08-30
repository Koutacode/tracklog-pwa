import type { endExpressway } from '../db/repositories';
import {
  assertExpresswayEndCommitAuthorization,
  decideExpresswayEndRequest,
  executeExpresswayEndRequest,
  INVALID_EXPRESSWAY_END_AUTHORIZATION,
  type ExpresswayEndCommitAuthorization,
} from './expresswayEndRequest';

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

type EndExpresswayParams = Parameters<typeof endExpressway>[0];

const manualAuthorization: ExpresswayEndCommitAuthorization = { source: 'manual_button' };
const voiceAuthorization: ExpresswayEndCommitAuthorization = { source: 'voice' };
const confirmedAutomaticAuthorization: ExpresswayEndCommitAuthorization = {
  source: 'automatic_detection',
  automaticConfirmation: 'confirmed',
};

const manualRequest: EndExpresswayParams = { tripId: 'trip-1', ...manualAuthorization };
const voiceRequest: EndExpresswayParams = { tripId: 'trip-1', ...voiceAuthorization };
const automaticRequest: EndExpresswayParams = {
  tripId: 'trip-1',
  ...confirmedAutomaticAuthorization,
};

// The directives are compile-time regression tests: source omission and an
// unconfirmed automatic request must remain impossible at the storage boundary.
// @ts-expect-error expressway end source is required
const missingSourceRequest: EndExpresswayParams = { tripId: 'trip-1' };
// @ts-expect-error automatic detection cannot be committed without confirmation
const unconfirmedAutomaticRequest: EndExpresswayParams = {
  tripId: 'trip-1',
  source: 'automatic_detection',
};

void manualRequest;
void voiceRequest;
void automaticRequest;
void missingSourceRequest;
void unconfirmedAutomaticRequest;

async function run() {
  assertEqual(
    decideExpresswayEndRequest('manual_button').disposition,
    'commit_immediately',
    'manual button ends immediately',
  );
  assertEqual(
    decideExpresswayEndRequest('voice').disposition,
    'commit_immediately',
    'voice ends immediately',
  );
  assertEqual(
    decideExpresswayEndRequest('automatic_detection').disposition,
    'requires_confirmation',
    'automatic detection requires confirmation',
  );

  const committedSources: string[] = [];
  const commit = async (authorization: { source: 'manual_button' | 'voice' }) => {
    committedSources.push(authorization.source);
    return true;
  };
  const automatic = await executeExpresswayEndRequest('automatic_detection', commit);
  assertEqual(automatic?.status, 'requires_confirmation', 'automatic request returns confirmation outcome');
  assertEqual(committedSources.length, 0, 'unconfirmed automatic request cannot call storage');

  const manual = await executeExpresswayEndRequest('manual_button', commit);
  const voice = await executeExpresswayEndRequest('voice', commit);
  assertEqual(manual?.status, 'completed', 'manual request commits');
  assertEqual(voice?.status, 'completed', 'voice request commits');
  assertEqual(committedSources.join(','), 'manual_button,voice', 'only immediate sources reach storage');

  let missingSourceError = '';
  try {
    assertExpresswayEndCommitAuthorization({ tripId: 'trip-1' });
  } catch (error) {
    missingSourceError = error instanceof Error ? error.message : '';
  }
  assertEqual(
    missingSourceError,
    INVALID_EXPRESSWAY_END_AUTHORIZATION,
    'runtime validation rejects a missing source',
  );

  let unconfirmedAutomaticError = '';
  try {
    assertExpresswayEndCommitAuthorization({ source: 'automatic_detection' });
  } catch (error) {
    unconfirmedAutomaticError = error instanceof Error ? error.message : '';
  }
  assertEqual(
    unconfirmedAutomaticError,
    INVALID_EXPRESSWAY_END_AUTHORIZATION,
    'runtime validation rejects unconfirmed automatic detection',
  );

  console.log('expresswayEndRequest: 12 contract assertions passed');
}

void run().catch(error => {
  globalThis.setTimeout(() => { throw error; }, 0);
});
