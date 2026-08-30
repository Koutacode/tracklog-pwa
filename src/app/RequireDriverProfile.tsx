import type { FormEvent, ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Link, useNavigate } from 'react-router-dom';
import type { DriverIdentity } from '../domain/remoteTypes';
import { getActiveTripId } from '../db/repositories';
import {
  getDriverIdentity,
  getDriverAuthWorkflowErrorCode,
  initializeDriverIdentity,
  onDriverAuthStateChange,
  sendDriverMagicLink,
  setDriverProfileLocal,
  verifyDriverEmailOtp,
} from '../services/remoteAuth';
import type { DriverProfileField } from '../services/driverProfileValidation';
import {
  normalizePhoneInput,
  toHalfWidthDigits,
  normalizeVehicleLabelInput,
  validateDriverProfile,
} from '../services/driverProfileValidation';
import { hydrateRemoteSyncState } from '../services/remoteSync';
import {
  checkNativeSetupReadiness,
  classifyNativeSetupStepReturn,
  runNativeSetupStep,
} from '../services/nativeSetup';
import type { NativeSetupReadiness, NativeSetupStepId } from '../services/nativeSetup';
import { requestRouteTrackingSync } from './routeTrackingSignal';
import {
  getDriverProfileEnrollmentErrorMessage,
  getDriverRegistrationGateModel,
} from './driverRegistrationGateModel';
import { TRACKLOG_EVENTS_CHANGED_EVENT } from '../services/localEventsChanged';
import { didActiveTripEnd, shouldShowDeviceSetupGate } from './deviceSetupGatePolicy';

type Props = {
  children: ReactElement;
};

function hasApprovedProfile(identity: DriverIdentity | null) {
  if (!identity) return false;
  if (!identity.configured) return false;
  return identity.authInitialized && identity.profileComplete && identity.approvalStatus === 'approved';
}

function formatDriverAuthError(error: any) {
  const enrollmentMessage = getDriverProfileEnrollmentErrorMessage(error);
  if (enrollmentMessage) return enrollmentMessage;
  const workflowCode = getDriverAuthWorkflowErrorCode(error);
  if (workflowCode === 'driver_otp_session_invalid') {
    return '認証セッションを確認できません。最新の認証メールからもう一度お試しください。';
  }
  if (workflowCode === 'driver_auth_email_mismatch') {
    return '認証したアカウントと登録メールが異なります。この端末に登録したメールでログインしてください。';
  }
  if (workflowCode === 'driver_native_credentials_update_failed') {
    return 'メール認証は完了しましたが、端末に認証情報を保存できませんでした。承認申請を再送してください。';
  }
  if (workflowCode === 'driver_profile_enrollment_failed') {
    return 'メール認証は完了しましたが、承認申請を送信できませんでした。通信を確認して「承認申請を再送」を押してください。';
  }
  if (workflowCode === 'driver_auth_session_refresh_failed') {
    return 'ログイン状態を更新できませんでした。通信状態を確認して再試行してください。';
  }
  if (workflowCode === 'driver_enrollment_session_changed') {
    return '認証中にセッションが更新されました。認証状態を更新してから再試行してください。';
  }
  const raw = `${error?.message ?? error ?? ''}`.trim();
  if (!raw) return '認証に失敗しました';
  const normalized = raw.toLowerCase();
  if (normalized.includes('edge function returned a non-2xx status code')) {
    return 'クラウド同期の確認に失敗しました。通信状態を確認して、認証状態を更新してください。';
  }
  if (
    normalized.includes('rate limit') ||
    normalized.includes('email rate limit') ||
    normalized.includes('over_email_send_rate_limit')
  ) {
    return 'メール送信の上限に達しています。少し待ってから再度試してください。';
  }
  if (normalized.includes('otp') || normalized.includes('token')) {
    return '認証コードが無効です。最新の認証メールで再度試してください。';
  }
  return raw;
}

function DriverRegistrationGate(props: {
  identity: DriverIdentity;
  loading: boolean;
  onRefresh: () => Promise<void>;
}) {
  const { identity, loading, onRefresh } = props;
  const [displayName, setDisplayName] = useState(identity.displayName);
  const [vehicleLabel, setVehicleLabel] = useState(identity.vehicleLabel);
  const [phone, setPhone] = useState(identity.phone);
  const [email, setEmail] = useState(identity.email ?? '');
  const [otpToken, setOtpToken] = useState('');
  const [otpRequested, setOtpRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<DriverProfileField, string>>>({});
  const [enrollmentFailed, setEnrollmentFailed] = useState(false);

  useEffect(() => {
    setDisplayName(identity.displayName);
    setVehicleLabel(identity.vehicleLabel);
    setPhone(identity.phone);
    setEmail(identity.email ?? '');
    if (identity.authInitialized && identity.approvalStatus === 'unregistered') {
      setEnrollmentFailed(true);
    } else if (identity.approvalStatus !== 'unregistered') {
      setEnrollmentFailed(false);
    }
  }, [identity]);

  const enrollmentRetry = enrollmentFailed || (
    identity.configured
    && identity.authInitialized
    && identity.profileComplete
    && identity.approvalStatus === 'unregistered'
  );

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const validation = validateDriverProfile({ displayName, vehicleLabel, phone, email });
    setDisplayName(validation.value.displayName);
    setVehicleLabel(validation.value.vehicleLabel);
    setPhone(validation.value.phone);
    setEmail(validation.value.email);
    setFieldErrors(validation.errors);
    if (!validation.valid) {
      setMessage(validation.firstError);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await setDriverProfileLocal(validation.value);
      await hydrateRemoteSyncState();
      if (identity.configured && !identity.authInitialized && !enrollmentRetry) {
        await sendDriverMagicLink(validation.value.email);
        setOtpRequested(true);
        setMessage('認証メールを送信しました。メール本文の認証コードをこの画面に入力してください。');
      } else {
        setMessage(enrollmentRetry
          ? '承認申請を再送しました。管理者の承認をお待ちください。'
          : '端末プロフィールを保存しました。管理者の承認後に利用できます。');
      }
      await onRefresh();
    } catch (error: any) {
      setMessage(formatDriverAuthError(error) || '登録に失敗しました');
      if (getDriverAuthWorkflowErrorCode(error) === 'driver_profile_enrollment_failed') {
        setEnrollmentFailed(true);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleVerifyCode = async () => {
    const validation = validateDriverProfile({ displayName, vehicleLabel, phone, email });
    setDisplayName(validation.value.displayName);
    setVehicleLabel(validation.value.vehicleLabel);
    setPhone(validation.value.phone);
    setEmail(validation.value.email);
    setFieldErrors(validation.errors);
    if (!validation.valid) {
      setMessage(validation.firstError);
      return;
    }
    const normalizedToken = toHalfWidthDigits(otpToken).replace(/\D/g, '').slice(0, 10);
    setOtpToken(normalizedToken);
    if (normalizedToken.length < 6 || normalizedToken.length > 10) {
      setMessage('認証メールに記載された認証コードを入力してください。');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await setDriverProfileLocal(validation.value);
      await hydrateRemoteSyncState();
      const verifiedIdentity = await verifyDriverEmailOtp(validation.value.email, normalizedToken);
      setMessage(
        verifiedIdentity.approvalStatus === 'approved'
          ? 'メール認証と管理者承認を確認しました。'
          : verifiedIdentity.approvalStatus === 'pending'
            ? 'メール認証と承認申請が完了しました。管理者の承認待ちです。'
            : 'メール認証は完了しました。端末の承認申請を再送してください。',
      );
      await onRefresh();
    } catch (error: any) {
      const enrollmentMessage = getDriverProfileEnrollmentErrorMessage(error);
      setMessage(enrollmentMessage ?? formatDriverAuthError(error));
      const workflowCode = getDriverAuthWorkflowErrorCode(error);
      if (workflowCode === 'driver_profile_enrollment_failed') {
        setEnrollmentFailed(true);
      }
      if (enrollmentMessage || workflowCode === 'driver_native_credentials_update_failed') {
        await onRefresh();
      }
    } finally {
      setBusy(false);
    }
  };

  const gateModel = getDriverRegistrationGateModel(identity);
  const statusLabel = gateModel.statusLabel;
  const showOtpPanel = identity.configured
    && !identity.authInitialized
    && !enrollmentRetry
    && (otpRequested || !!identity.email?.trim());

  return (
    <div className="screen-shell">
      <div className="screen-card screen-card--narrow">
        <div className="screen-card__header">
          <div>
            <div className="screen-card__eyebrow">初回登録</div>
            <h1 className="screen-card__title">端末プロフィール登録</h1>
          </div>
          <div className="screen-card__actions">
            <Link to="/driver-login" className="pill-link">
              登録済みログイン
            </Link>
          </div>
        </div>

        <div className="settings-note">
          名前、メールアドレス、電話番号、車両番号を登録し、メール本文の認証コードで認証してください。メール認証と管理者承認が完了するまで運行開始画面は利用できません。
          {!identity.configured && ' 現在はクラウド設定を読み込めていないため、管理者承認を確認できません。'}
        </div>

        {gateModel.showStatusCard && (
          <div className={`approval-wait-card approval-wait-card--${gateModel.cardStatus ?? 'unregistered'}`}>
            <strong>{statusLabel}</strong>
            {gateModel.statusMessage && <span>{gateModel.statusMessage}</span>}
          </div>
        )}

        {gateModel.showRegistrationForm && <form className="driver-registration" onSubmit={handleSubmit}>
          <label className="settings-field">
            <span>名前</span>
            <input
              value={displayName}
              onChange={event => setDisplayName(event.target.value)}
              placeholder="例: 山田 太郎"
              aria-invalid={fieldErrors.displayName ? true : undefined}
              required
            />
            {fieldErrors.displayName && <small className="settings-field-error">{fieldErrors.displayName}</small>}
          </label>
          <label className="settings-field">
            <span>メールアドレス</span>
            <input
              value={email}
              onChange={event => setEmail(event.target.value)}
              placeholder="driver@example.com"
              type="email"
              aria-invalid={fieldErrors.email ? true : undefined}
              required
            />
            {fieldErrors.email && <small className="settings-field-error">{fieldErrors.email}</small>}
          </label>
          <label className="settings-field">
            <span>電話番号</span>
            <input
              value={phone}
              onChange={event => setPhone(normalizePhoneInput(event.target.value))}
              placeholder="例: 090-1234-5678"
              inputMode="tel"
              aria-invalid={fieldErrors.phone ? true : undefined}
              required
            />
            {fieldErrors.phone && <small className="settings-field-error">{fieldErrors.phone}</small>}
          </label>
          <label className="settings-field">
            <span>車両番号（車番）</span>
            <input
              value={vehicleLabel}
              onChange={event => setVehicleLabel(normalizeVehicleLabelInput(event.target.value))}
              placeholder="例: 札幌101か8916"
              aria-invalid={fieldErrors.vehicleLabel ? true : undefined}
              required
            />
            {fieldErrors.vehicleLabel && <small className="settings-field-error">{fieldErrors.vehicleLabel}</small>}
          </label>

          <div className="settings-info-row">
            <span>認証状態</span>
            <strong>{statusLabel}</strong>
          </div>

          <button className="trip-btn trip-btn--primary" disabled={busy || loading} type="submit">
            {busy
              ? '処理中…'
              : enrollmentRetry || gateModel.canRetryEnrollment
                ? '承認申請を再送'
                : identity.configured && !identity.authInitialized
                  ? '登録して認証メールを送信'
                  : '登録する'}
          </button>
          <button
            className="trip-btn"
            disabled={busy || loading}
            type="button"
            onClick={async () => {
              setMessage(null);
              await onRefresh();
            }}
          >
            {loading ? '確認中…' : '認証状態を更新'}
          </button>
        </form>}

        {gateModel.showRegistrationForm && showOtpPanel && (
          <div className="driver-registration">
            <div className="settings-note">
              認証メールに表示された認証コードをここに入力すると、このPWA内でメール認証が完了します。
            </div>
            <label className="settings-field">
              <span>認証コード</span>
              <input
                value={otpToken}
                onChange={event => setOtpToken(toHalfWidthDigits(event.target.value).replace(/\D/g, '').slice(0, 10))}
                placeholder="40055812"
                inputMode="numeric"
                maxLength={10}
              />
            </label>
            <button
              className="trip-btn"
              disabled={busy || loading || otpToken.length < 6 || otpToken.length > 10}
              type="button"
              onClick={handleVerifyCode}
            >
              認証コードでメール認証
            </button>
          </div>
        )}

        {gateModel.showApprovalRefresh && (
          <button
            className="trip-btn trip-btn--primary"
            disabled={busy || loading}
            type="button"
            onClick={async () => {
              setMessage(null);
              await onRefresh();
            }}
          >
            {loading ? '確認中…' : '承認状態を更新'}
          </button>
        )}

        {message && <div className="settings-toast">{message}</div>}
      </div>
    </div>
  );
}

function DeviceSetupGate(props: {
  readiness: NativeSetupReadiness | null;
  loading: boolean;
  onRefresh: () => Promise<void>;
}) {
  const { readiness, loading, onRefresh } = props;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [retryStepId, setRetryStepId] = useState<NativeSetupStepId | null>(null);
  const serviceAttemptedRef = useRef(false);
  const awaitingSettingsReturnRef = useRef(false);
  const refreshComparisonStepRef = useRef<NativeSetupStepId | null>(null);

  const steps = readiness?.steps ?? [];
  const activeStep = readiness?.activeStep ?? null;

  const runActiveStep = async () => {
    if (!activeStep || activeStep.id === 'native-only') return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await runNativeSetupStep(activeStep.id);
      if (activeStep.id === 'resident-service') {
        refreshComparisonStepRef.current = activeStep.id;
        setMessage(result.destination === 'resident-service-running'
          ? '位置記録サービスの動作を確認しました。'
          : 'まだ起動を確認できません。通信状態を確認してもう一度お試しください。');
        await onRefresh();
      } else if (result.opened) {
        awaitingSettingsReturnRef.current = true;
        refreshComparisonStepRef.current = activeStep.id;
        setRetryStepId(null);
        setMessage('設定後にTrackLogへ戻ると自動で確認します。');
      } else {
        refreshComparisonStepRef.current = activeStep.id;
        await onRefresh();
      }
    } catch (error: any) {
      setMessage(error?.message ?? '端末設定を確認できませんでした');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let active = true;
    let resumeListener: { remove(): void } | null = null;
    let stateListener: { remove(): void } | null = null;
    const refreshAfterSettingsReturn = () => {
      if (!active || !awaitingSettingsReturnRef.current) return;
      // Android may emit both `resume` and an active app-state event for the
      // same return. Consume the pending navigation before the async refresh.
      awaitingSettingsReturnRef.current = false;
      void onRefresh();
    };
    void CapacitorApp.addListener('resume', () => {
      refreshAfterSettingsReturn();
    }).then(listener => {
      if (active) resumeListener = listener;
      else void listener.remove();
    });
    void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) refreshAfterSettingsReturn();
    }).then(listener => {
      if (active) stateListener = listener;
      else void listener.remove();
    });
    return () => {
      active = false;
      void resumeListener?.remove();
      void stateListener?.remove();
    };
  }, [onRefresh]);

  useEffect(() => {
    const previousStepId = refreshComparisonStepRef.current;
    if (!previousStepId || loading) return;
    refreshComparisonStepRef.current = null;
    const currentStepId = activeStep && activeStep.id !== 'native-only'
      ? activeStep.id
      : null;
    const outcome = classifyNativeSetupStepReturn(previousStepId, currentStepId);
    if (outcome === 'unchanged') {
      if (previousStepId === 'resident-service') {
        setMessage('まだ位置記録サービスを起動できません。「動作確認をやり直す」を押してください。');
      } else {
        setRetryStepId(previousStepId);
        setMessage('まだ設定されていません。「もう一度開く」を押してください。');
      }
      return;
    }
    setRetryStepId(null);
    setMessage(outcome === 'complete'
      ? 'すべての端末設定を確認しました。'
      : '設定できました。次の項目へ進みます。');
  }, [activeStep?.id, loading]);

  useEffect(() => {
    if (activeStep?.id !== 'resident-service') {
      serviceAttemptedRef.current = false;
      return;
    }
    if (serviceAttemptedRef.current || busy || loading) return;
    serviceAttemptedRef.current = true;
    void runActiveStep();
  }, [activeStep?.id, busy, loading]);

  const actionLabel = (() => {
    if (!activeStep) return '設定状態を再確認';
    if (retryStepId === activeStep.id && activeStep.id !== 'resident-service') return 'もう一度開く';
    if (activeStep.id === 'location-enabled') return '端末の位置情報設定を開く';
    if (activeStep.id === 'location-precise') return '正確な位置情報を許可する';
    if (activeStep.id === 'location-background') return '常時位置情報の設定を開く';
    if (activeStep.id === 'notification') return '通知を許可・設定する';
    if (activeStep.id === 'battery-opt') return '電池最適化の設定を開く';
    return '動作確認をやり直す';
  })();

  return (
    <div className="screen-shell">
      <div className="screen-card screen-card--narrow">
        <div className="screen-card__header">
          <div>
            <div className="screen-card__eyebrow">初回設定</div>
            <h1 className="screen-card__title">端末設定を完了してください</h1>
          </div>
        </div>

        <div className="settings-note">
          必要な設定を1つずつ案内します。ボタンを押すと対象のAndroid設定を開き、TrackLogへ戻った後は自動で次へ進みます。
        </div>

        <div className="setup-check-list">
          {loading && steps.length === 0 ? (
            <div className="setup-check-row setup-check-row--warn">
              <strong>確認中</strong>
              <span>端末設定の状態を確認しています。</span>
            </div>
          ) : activeStep ? (
            <>
              <div className="setup-check-row setup-check-row--ok">
                <strong>進捗</strong>
                <span>端末設定・あと{readiness?.remaining ?? 0}項目</span>
              </div>
              <div className={`setup-check-row setup-check-row--${activeStep.level}`}>
                <strong>{activeStep.label}</strong>
                <span>{activeStep.detail}</span>
                {activeStep.instruction && <span>{activeStep.instruction}</span>}
              </div>
            </>
          ) : null}
        </div>

        <div className="setup-gate-actions">
          <button
            className="trip-btn trip-btn--primary"
            disabled={busy || loading || !activeStep}
            type="button"
            onClick={() => void runActiveStep()}
          >
            {busy ? '確認中…' : actionLabel}
          </button>
          <button
            className="trip-btn"
            disabled={busy || loading}
            type="button"
            onClick={() => void onRefresh().then(() => setMessage('設定状態を再確認しました。'))}
          >
            {loading ? '確認中…' : '設定状態を再確認'}
          </button>
        </div>

        {message && <div className="settings-toast">{message}</div>}
      </div>
    </div>
  );
}

export default function RequireDriverProfile({ children }: Props) {
  const navigate = useNavigate();
  const [identity, setIdentity] = useState<DriverIdentity | null>(null);
  const [loading, setLoading] = useState(true);
  const [setupReadiness, setSetupReadiness] = useState<NativeSetupReadiness | null>(null);
  const [setupLoading, setSetupLoading] = useState(false);
  const [activeTripState, setActiveTripState] = useState<{
    known: boolean;
    tripId: string | null;
  }>({ known: false, tripId: null });
  const wasBlockedRef = useRef(false);
  const identityRefreshVersionRef = useRef(0);
  const setupRefreshInFlightRef = useRef<Promise<void> | null>(null);
  const setupRefreshSequenceRef = useRef(0);
  const lastLifecycleSetupRefreshAtRef = useRef(0);
  const activeTripStateRef = useRef(activeTripState);

  activeTripStateRef.current = activeTripState;

  const refreshNativeSetup = (): Promise<void> => {
    if (setupRefreshInFlightRef.current) return setupRefreshInFlightRef.current;
    const refreshSequence = ++setupRefreshSequenceRef.current;
    setSetupLoading(true);
    const refreshPromise = Promise.resolve().then(async () => {
      try {
        setSetupReadiness(await checkNativeSetupReadiness({ fresh: true }));
      } catch (error) {
        // A failed fresh read must not leave an old `ready` result capable of
        // starting the next trip. Active trips still bypass the gate below.
        setSetupReadiness(null);
        throw error;
      }
    }).finally(() => {
      if (setupRefreshSequenceRef.current === refreshSequence) {
        setupRefreshInFlightRef.current = null;
        setSetupLoading(false);
      }
    });
    setupRefreshInFlightRef.current = refreshPromise;
    return refreshPromise;
  };

  const refreshNativeSetupRef = useRef(refreshNativeSetup);
  refreshNativeSetupRef.current = refreshNativeSetup;

  const refreshIdentity = async () => {
    const refreshVersion = ++identityRefreshVersionRef.current;
    setLoading(true);
    try {
      let next: DriverIdentity;
      try {
        next = await initializeDriverIdentity();
      } catch {
        next = await getDriverIdentity();
      }
      if (refreshVersion === identityRefreshVersionRef.current) setIdentity(next);
    } catch {
      // Keep the last known gate state when both Auth and local persistence are unavailable.
    } finally {
      if (refreshVersion === identityRefreshVersionRef.current) setLoading(false);
    }
  };

  const refreshIdentityRef = useRef(refreshIdentity);
  refreshIdentityRef.current = refreshIdentity;

  useEffect(() => {
    void refreshIdentityRef.current();
    return () => {
      identityRefreshVersionRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!hasApprovedProfile(identity)) {
      setActiveTripState({ known: false, tripId: null });
      return;
    }
    let active = true;
    const refreshActiveTrip = () => {
      void getActiveTripId().then(tripId => {
        if (!active) return;
        const previous = activeTripStateRef.current;
        const next = { known: true, tripId };
        const tripEnded = didActiveTripEnd({
          previousKnown: previous.known,
          previousTripId: previous.tripId,
          currentKnown: next.known,
          currentTripId: next.tripId,
        });
        if (tripEnded) {
          // Invalidate the earlier snapshot in the same update that exposes the
          // no-active-trip state, so there is no frame where a new trip can use
          // stale `ready: true` data.
          setSetupReadiness(null);
          void refreshNativeSetupRef.current().catch(() => undefined);
        }
        activeTripStateRef.current = next;
        setActiveTripState(next);
      }).catch(() => {
        // Keep the previous known state. On first-load failure this leaves a
        // neutral loading screen rather than incorrectly blocking an active trip.
      });
    };
    refreshActiveTrip();
    window.addEventListener(TRACKLOG_EVENTS_CHANGED_EVENT, refreshActiveTrip);
    return () => {
      active = false;
      window.removeEventListener(TRACKLOG_EVENTS_CHANGED_EVENT, refreshActiveTrip);
    };
  }, [
    identity?.configured,
    identity?.authInitialized,
    identity?.profileComplete,
    identity?.approvalStatus,
  ]);

  useEffect(() => {
    const recheckIdentity = () => {
      void refreshIdentityRef.current();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') recheckIdentity();
    };
    const unsubscribeAuth = onDriverAuthStateChange(event => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'SIGNED_OUT') {
        recheckIdentity();
      }
    });
    window.addEventListener('online', recheckIdentity);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      unsubscribeAuth();
      window.removeEventListener('online', recheckIdentity);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (!hasApprovedProfile(identity) || !Capacitor.isNativePlatform()) return;
    let active = true;
    let resumeListener: { remove(): void } | null = null;
    let stateListener: { remove(): void } | null = null;
    const refreshAfterNativeReturn = () => {
      if (!active) return;
      const now = Date.now();
      // Android commonly emits resume, appStateChange and visibilitychange for
      // one foreground transition. Keep a single fresh native snapshot.
      if (now - lastLifecycleSetupRefreshAtRef.current < 750) return;
      lastLifecycleSetupRefreshAtRef.current = now;
      void refreshNativeSetupRef.current().catch(() => undefined);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshAfterNativeReturn();
    };
    void CapacitorApp.addListener('resume', refreshAfterNativeReturn).then(listener => {
      if (active) resumeListener = listener;
      else void listener.remove();
    });
    void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) refreshAfterNativeReturn();
    }).then(listener => {
      if (active) stateListener = listener;
      else void listener.remove();
    });
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      active = false;
      void resumeListener?.remove();
      void stateListener?.remove();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [
    identity?.configured,
    identity?.authInitialized,
    identity?.profileComplete,
    identity?.approvalStatus,
  ]);

  useEffect(() => {
    if (!hasApprovedProfile(identity)) {
      setSetupReadiness(null);
      return;
    }
    void refreshNativeSetupRef.current().catch(() => undefined);
  }, [identity?.configured, identity?.authInitialized, identity?.profileComplete, identity?.approvalStatus]);

  useEffect(() => {
    if (!identity) return;
    if (!hasApprovedProfile(identity)) {
      wasBlockedRef.current = true;
      return;
    }
    if (setupReadiness && !setupReadiness.ready) {
      wasBlockedRef.current = true;
      return;
    }
    if (setupReadiness?.ready && wasBlockedRef.current) {
      wasBlockedRef.current = false;
      navigate('/', { replace: true });
    }
  }, [identity, navigate, setupReadiness]);

  useEffect(() => {
    requestRouteTrackingSync();
  }, [
    identity?.configured,
    identity?.authInitialized,
    identity?.profileComplete,
    identity?.approvalStatus,
    setupReadiness?.ready,
  ]);

  if (!identity) {
    return <div style={{ padding: 24, color: '#fff' }}>登録状態を確認中…</div>;
  }

  if (!hasApprovedProfile(identity)) {
    return (
      <DriverRegistrationGate
        identity={identity as DriverIdentity}
        loading={loading}
        onRefresh={refreshIdentity}
      />
    );
  }

  if (!setupReadiness?.ready && !activeTripState.known) {
    return <div style={{ padding: 24, color: '#fff' }}>運行状態を確認中…</div>;
  }

  if (shouldShowDeviceSetupGate({
    approved: true,
    setupReady: setupReadiness?.ready === true,
    activeTripKnown: activeTripState.known,
    activeTripId: activeTripState.tripId,
  })) {
    return (
      <DeviceSetupGate
        readiness={setupReadiness}
        loading={setupLoading}
        onRefresh={refreshNativeSetup}
      />
    );
  }

  return children;
}
