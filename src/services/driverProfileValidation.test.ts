import { createSyncMutationId } from '../db/db';
import {
  normalizePhoneInput,
  normalizeVehicleLabelInput,
  validateDriverProfile,
} from './driverProfileValidation';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const normalizedVehicle = normalizeVehicleLabelInput('札幌１０１ か ８９１６');
assert(normalizedVehicle === '札幌101か8916', 'vehicle digits and spaces must normalize');
assert(normalizePhoneInput('０９０－１２３４－５６７８') === '090-1234-5678', 'phone digits must normalize');

const valid = validateDriverProfile({
  displayName: '山田 太郎',
  email: 'Test.User@Example.com',
  phone: '090-1234-5678',
  vehicleLabel: '札幌101か8916',
});
assert(valid.valid, 'valid profile must pass');
assert(valid.value.email === 'Test.User@Example.com', 'email case must be preserved');

const invalid = validateDriverProfile({
  displayName: '',
  email: 'invalid',
  phone: '123',
  vehicleLabel: '掃除号',
});
assert(!invalid.valid, 'invalid profile must fail');
assert(!!invalid.errors.displayName && !!invalid.errors.email && !!invalid.errors.phone && !!invalid.errors.vehicleLabel,
  'every invalid registration field must be reported');

const mutationIds = Array.from({ length: 1_000 }, () => createSyncMutationId());
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
assert(mutationIds.every(value => uuidV4.test(value)), 'sync mutation IDs must always be UUID v4');
assert(new Set(mutationIds).size === mutationIds.length, 'sync mutation IDs must be unique');

console.log('driverProfileValidation: 7 tests passed');
