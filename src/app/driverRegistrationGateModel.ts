import type { DriverApprovalStatus, DriverIdentity } from '../domain/remoteTypes';

export type DriverRegistrationGateMode =
  | 'cloud-unconfigured'
  | 'email-authentication'
  | 'profile-incomplete'
  | 'enrollment-incomplete'
  | 'approval-pending'
  | 'rejected'
  | 'approved';

export type DriverRegistrationGateModel = {
  mode: DriverRegistrationGateMode;
  statusLabel: string;
  statusMessage: string | null;
  showStatusCard: boolean;
  showRegistrationForm: boolean;
  showApprovalRefresh: boolean;
  canRetryEnrollment: boolean;
  cardStatus: DriverApprovalStatus | null;
};

type DriverRegistrationState = Pick<
  DriverIdentity,
  'configured' | 'authInitialized' | 'profileComplete' | 'approvalStatus'
>;

const ENROLLMENT_FAILURE_MESSAGE =
  'メール認証は完了しましたが、端末の承認申請を完了できませんでした。「承認申請を再送」を押してください。';

export function isDriverProfileEnrollmentError(error: unknown) {
  return !!error
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'driver_profile_enrollment_failed';
}

export function getDriverProfileEnrollmentErrorMessage(error: unknown): string | null {
  return isDriverProfileEnrollmentError(error) ? ENROLLMENT_FAILURE_MESSAGE : null;
}

export function getDriverRegistrationGateModel(
  identity: DriverRegistrationState,
): DriverRegistrationGateModel {
  if (!identity.configured) {
    return {
      mode: 'cloud-unconfigured',
      statusLabel: 'クラウド未設定',
      statusMessage: null,
      showStatusCard: false,
      showRegistrationForm: true,
      showApprovalRefresh: false,
      canRetryEnrollment: false,
      cardStatus: null,
    };
  }
  if (!identity.authInitialized) {
    return {
      mode: 'email-authentication',
      statusLabel: 'メール認証待ち',
      statusMessage: null,
      showStatusCard: false,
      showRegistrationForm: true,
      showApprovalRefresh: false,
      canRetryEnrollment: false,
      cardStatus: null,
    };
  }
  if (!identity.profileComplete) {
    return {
      mode: 'profile-incomplete',
      statusLabel: '登録情報不足',
      statusMessage: null,
      showStatusCard: false,
      showRegistrationForm: true,
      showApprovalRefresh: false,
      canRetryEnrollment: false,
      cardStatus: null,
    };
  }
  if (identity.approvalStatus === 'approved') {
    return {
      mode: 'approved',
      statusLabel: '承認済み',
      statusMessage: null,
      showStatusCard: false,
      showRegistrationForm: false,
      showApprovalRefresh: false,
      canRetryEnrollment: false,
      cardStatus: 'approved',
    };
  }
  if (identity.approvalStatus === 'pending') {
    return {
      mode: 'approval-pending',
      statusLabel: '管理者承認待ち',
      statusMessage: 'メール認証と承認申請は完了しています。管理者が許可すると、この端末で機能を使えるようになります。',
      showStatusCard: true,
      showRegistrationForm: false,
      showApprovalRefresh: true,
      canRetryEnrollment: false,
      cardStatus: 'pending',
    };
  }
  if (identity.approvalStatus === 'rejected') {
    return {
      mode: 'rejected',
      statusLabel: '拒否済み',
      statusMessage: 'この登録は管理者により拒否されています。内容を確認する場合は管理者へ連絡してください。',
      showStatusCard: true,
      showRegistrationForm: false,
      showApprovalRefresh: true,
      canRetryEnrollment: false,
      cardStatus: 'rejected',
    };
  }
  return {
    mode: 'enrollment-incomplete',
    statusLabel: '承認申請未完了',
    statusMessage: 'メール認証は完了していますが、管理者への承認申請を確認できません。「承認申請を再送」を押してください。',
    showStatusCard: true,
    showRegistrationForm: true,
    showApprovalRefresh: false,
    canRetryEnrollment: true,
    cardStatus: 'unregistered',
  };
}
