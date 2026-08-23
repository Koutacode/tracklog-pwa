import { useCallback, useEffect, useRef, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import {
  confirmBreakToRest,
  getActiveTripId,
  getBreakToRestPromptState,
  setBreakToRestPromptDecision,
} from '../db/repositories';
import { getDriverIdentity } from '../services/remoteAuth';
import { applyCurrentNativeTrackingStateFast } from '../services/nativeTrackingFastApply';
import BreakToRestConfirmDialog from '../ui/components/BreakToRestConfirmDialog';
import OdoDialog from '../ui/components/OdoDialog';
import { requestRouteTrackingSync } from './routeTrackingSignal';
import {
  notifyBreakToRestModalState,
  notifyTrackLogEventsChanged,
} from './breakToRestConfirmationSignal';

type PromptState = NonNullable<Awaited<ReturnType<typeof getBreakToRestPromptState>>>;

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message;
  return '操作に失敗しました。もう一度お試しください。';
}

export default function BreakToRestConfirmationGate() {
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const operationLockedRef = useRef(false);
  const refreshSequenceRef = useRef(0);
  const promptRef = useRef<PromptState | null>(null);

  useEffect(() => {
    promptRef.current = prompt;
  }, [prompt]);

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequenceRef.current;
    try {
      const identity = await getDriverIdentity();
      if (
        !identity.configured
        || !identity.authInitialized
        || !identity.profileComplete
        || identity.approvalStatus !== 'approved'
      ) {
        if (sequence === refreshSequenceRef.current) setPrompt(null);
        return;
      }
      const tripId = await getActiveTripId();
      const nextPrompt = tripId
        ? await getBreakToRestPromptState({ tripId })
        : null;
      if (sequence === refreshSequenceRef.current) setPrompt(nextPrompt);
    } catch (error) {
      if (sequence === refreshSequenceRef.current && promptRef.current) {
        setErrorMessage(getErrorMessage(error));
      }
    }
  }, []);

  const runOperation = useCallback(async (task: () => Promise<void>) => {
    if (operationLockedRef.current) return;
    operationLockedRef.current = true;
    setBusy(true);
    setErrorMessage(null);
    try {
      await task();
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      operationLockedRef.current = false;
      setBusy(false);
    }
  }, []);

  const decide = useCallback((decision: 'approved' | 'declined') => {
    const current = prompt;
    if (!current) return;
    void runOperation(async () => {
      await setBreakToRestPromptDecision({
        tripId: current.tripId,
        breakStartId: current.breakStartId,
        decision,
      });
      if (decision === 'declined') {
        await applyCurrentNativeTrackingStateFast();
        requestRouteTrackingSync();
      }
      await refresh();
    });
  }, [prompt, refresh, runOperation]);

  const confirm = useCallback((odoKm: number) => {
    const current = prompt;
    if (!current) return;
    void runOperation(async () => {
      await confirmBreakToRest({
        tripId: current.tripId,
        breakStartId: current.breakStartId,
        odoKm,
      });
      await applyCurrentNativeTrackingStateFast();
      requestRouteTrackingSync();
      notifyTrackLogEventsChanged();
      await refresh();
    });
  }, [prompt, refresh, runOperation]);

  const modalOpen = prompt != null;
  useEffect(() => {
    notifyBreakToRestModalState(modalOpen);
  }, [modalOpen]);

  useEffect(() => {
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const timerId = window.setInterval(() => void refresh(), 15000);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    const resumeListener = Capacitor.isNativePlatform()
      ? CapacitorApp.addListener('resume', () => void refresh())
      : null;
    return () => {
      window.clearInterval(timerId);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
      if (resumeListener) void resumeListener.then(listener => listener.remove());
      notifyBreakToRestModalState(false);
    };
  }, [refresh]);

  return (
    <>
      <BreakToRestConfirmDialog
        open={prompt?.decision === 'pending'}
        busy={busy}
        errorMessage={errorMessage}
        onApprove={() => decide('approved')}
        onDecline={() => decide('declined')}
      />
      <OdoDialog
        open={prompt?.decision === 'approved'}
        title="休息開始の距離"
        description="現在のオドメーター（km）を入力してください"
        confirmText="休息に変更"
        allowZero
        cancelable={false}
        busy={busy}
        errorMessage={errorMessage}
        zIndex={12000}
        onCancel={() => undefined}
        onConfirm={confirm}
      />
    </>
  );
}
