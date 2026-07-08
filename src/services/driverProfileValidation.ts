export type DriverProfileDraft = {
  displayName: string;
  vehicleLabel?: string | null;
  phone?: string | null;
  email?: string | null;
};

export type NormalizedDriverProfile = {
  displayName: string;
  vehicleLabel: string;
  phone: string;
  email: string;
};

export type DriverProfileField = keyof NormalizedDriverProfile;

export type DriverProfileValidationResult =
  | {
      valid: true;
      value: NormalizedDriverProfile;
      errors: Partial<Record<DriverProfileField, string>>;
    }
  | {
      valid: false;
      value: NormalizedDriverProfile;
      errors: Partial<Record<DriverProfileField, string>>;
      firstError: string;
    };

const FULLWIDTH_DIGIT_OFFSET = '０'.charCodeAt(0) - '0'.charCodeAt(0);
const VEHICLE_LABEL_PATTERN = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z]{1,8}[0-9]{2,3}[ぁ-んA-Za-z][0-9]{1,4}$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function toHalfWidthDigits(value: string) {
  return value.replace(/[０-９]/g, digit =>
    String.fromCharCode(digit.charCodeAt(0) - FULLWIDTH_DIGIT_OFFSET),
  );
}

export function normalizeDisplayNameInput(value: string | null | undefined) {
  return (value ?? '').trim().replace(/\s+/g, ' ');
}

export function normalizeEmailInput(value: string | null | undefined) {
  return (value ?? '').trim();
}

export function normalizePhoneInput(value: string | null | undefined) {
  return toHalfWidthDigits(value ?? '')
    .replace(/[＋]/g, '+')
    .replace(/[ー－―‐]/g, '-')
    .replace(/[　]/g, ' ')
    .trim();
}

export function normalizeVehicleLabelInput(value: string | null | undefined) {
  return toHalfWidthDigits(value ?? '')
    .replace(/[　\s\-ー－―‐]/g, '')
    .trim();
}

export function sameEmailAddress(left: string | null | undefined, right: string | null | undefined) {
  return normalizeEmailInput(left).toLowerCase() === normalizeEmailInput(right).toLowerCase();
}

function compactPhone(value: string) {
  return value.replace(/[()\s.-]/g, '');
}

function isValidPhone(value: string) {
  const compact = compactPhone(value);
  if (/^0\d{9,10}$/.test(compact)) return true;
  if (/^\+81\d{9,10}$/.test(compact)) return true;
  return false;
}

function isValidVehicleLabel(value: string) {
  return VEHICLE_LABEL_PATTERN.test(value);
}

export function validateDriverProfile(input: DriverProfileDraft): DriverProfileValidationResult {
  const value: NormalizedDriverProfile = {
    displayName: normalizeDisplayNameInput(input.displayName),
    vehicleLabel: normalizeVehicleLabelInput(input.vehicleLabel),
    phone: normalizePhoneInput(input.phone),
    email: normalizeEmailInput(input.email),
  };
  const errors: Partial<Record<DriverProfileField, string>> = {};

  if (!value.displayName) {
    errors.displayName = '名前を入力してください';
  } else if (value.displayName.length > 40) {
    errors.displayName = '名前は40文字以内で入力してください';
  }

  if (!value.email) {
    errors.email = 'メールアドレスを入力してください';
  } else if (value.email.length > 254 || !EMAIL_PATTERN.test(value.email)) {
    errors.email = 'メールアドレスの形式を確認してください';
  }

  if (!value.phone) {
    errors.phone = '電話番号を入力してください';
  } else if (!isValidPhone(value.phone)) {
    errors.phone = '電話番号は 090-1234-5678 または +81-90-1234-5678 の形式で入力してください';
  }

  if (!value.vehicleLabel) {
    errors.vehicleLabel = '車番を入力してください';
  } else if (value.vehicleLabel.length > 24) {
    errors.vehicleLabel = '車番は24文字以内で入力してください';
  } else if (!isValidVehicleLabel(value.vehicleLabel)) {
    errors.vehicleLabel = '車番は 札幌101か8916 の形式で入力してください';
  }

  const firstError = errors.displayName ?? errors.email ?? errors.phone ?? errors.vehicleLabel;
  if (firstError) {
    return {
      valid: false,
      value,
      errors,
      firstError,
    };
  }
  return {
    valid: true,
    value,
    errors,
  };
}

export function assertValidDriverProfile(input: DriverProfileDraft) {
  const result = validateDriverProfile(input);
  if (!result.valid) {
    throw new Error(result.firstError);
  }
  return result.value;
}
