import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { getEventsByTripId } from '../../db/repositories';
import { buildTripViewModel } from '../../state/selectors';
import { buildAiShareText, splitAiShareText, type AiShareChunk } from '../../services/aiShareText';
import { buildTripAiSummaryPayload, copyTripAiSummaryText } from '../../services/tripAiSummary';

type AiCopySession = {
  tripId: string;
  text: string;
  chunks: AiShareChunk[];
  selectedChunkIndex: number;
  status: string;
};

export default function TripAiSummaryAction({
  tripId,
  disabled = false,
  dialogBlocked = false,
  className = 'trip-detail__button trip-detail__button--accent',
}: {
  tripId?: string;
  disabled?: boolean;
  dialogBlocked?: boolean;
  className?: string;
}) {
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiCopySession, setAiCopySession] = useState<AiCopySession | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(false);
  const requestIdRef = useRef(0);
  const tripIdRef = useRef(tripId);
  const disabledRef = useRef(disabled);
  const dialogBlockedRef = useRef(dialogBlocked);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dialogId = useId();
  const statusId = `${dialogId}-status`;
  tripIdRef.current = tripId;
  disabledRef.current = disabled;
  dialogBlockedRef.current = dialogBlocked;

  useEffect(() => {
    mountedRef.current = true;
    requestIdRef.current += 1;
    setAiCopySession(null);
    setError(null);
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, [tripId, dialogBlocked]);

  // Hide the previous trip's dialog immediately, before effect cleanup runs.
  const session = !dialogBlocked && aiCopySession?.tripId === tripId ? aiCopySession : null;
  const selectedChunk = session?.chunks[session.selectedChunkIndex];
  const dialogOpen = session != null;

  useEffect(() => {
    if (!dialogOpen) return;
    const trigger = buttonRef.current;
    const dialog = dialogRef.current;
    const firstButton = dialog?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    (firstButton ?? dialog)?.focus();
    return () => {
      if (!dialogBlockedRef.current && !disabledRef.current && trigger?.isConnected) trigger.focus();
    };
  }, [dialogOpen]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialogOpen || sharing || !dialog || dialog.contains(document.activeElement)) return;
    // Disabling the clicked copy button can move browser focus to the body.
    // Restore it after copying so Escape and keyboard navigation still work.
    const firstButton = dialog.querySelector<HTMLButtonElement>('button:not(:disabled)');
    (firstButton ?? dialog).focus();
  }, [dialogOpen, sharing]);

  async function handleCopyAi() {
    const targetTripId = tripId;
    if (!targetTripId || disabled || dialogBlocked || busyRef.current) return;
    busyRef.current = true;
    const requestId = ++requestIdRef.current;
    const isCurrent = () => mountedRef.current
      && requestIdRef.current === requestId
      && tripIdRef.current === targetTripId
      && !dialogBlockedRef.current;
    setSharing(true);
    setError(null);
    try {
      const events = await getEventsByTripId(targetTripId);
      if (!isCurrent()) return;
      const vm = buildTripViewModel(targetTripId, events);
      const text = buildAiShareText(buildTripAiSummaryPayload(targetTripId, vm, events));
      const copiedLength = await copyTripAiSummaryText(text);
      if (!isCurrent()) return;
      if (copiedLength !== text.length) throw new Error('コピー文字数が一致しません');
      setAiCopySession({
        tripId: targetTripId,
        text,
        chunks: splitAiShareText(text),
        selectedChunkIndex: 0,
        status: `全文 ${text.length.toLocaleString('ja-JP')}文字をコピーしました`,
      });
    } catch {
      if (isCurrent()) setError('AI要約用データの全文コピーに失敗しました。もう一度お試しください。');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setSharing(false);
    }
  }

  async function handleCopyAiText(text: string, status: string) {
    const targetTripId = session?.tripId;
    if (!targetTripId || dialogBlocked || busyRef.current) return;
    busyRef.current = true;
    const requestId = ++requestIdRef.current;
    const isCurrent = () => mountedRef.current
      && requestIdRef.current === requestId
      && tripIdRef.current === targetTripId
      && !dialogBlockedRef.current;
    setSharing(true);
    setError(null);
    try {
      const copiedLength = await copyTripAiSummaryText(text);
      if (!isCurrent()) return;
      if (copiedLength !== text.length) throw new Error('コピー文字数が一致しません');
      setAiCopySession(current => current?.tripId === targetTripId ? { ...current, status } : current);
    } catch {
      if (isCurrent()) setError('AI要約用データのコピーに失敗しました。もう一度お試しください。');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setSharing(false);
    }
  }

  function closeDialog() {
    if (!busyRef.current) setAiCopySession(null);
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeDialog();
      return;
    }
    if (event.key !== 'Tab') return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (!first || !last) {
      event.preventDefault();
      event.currentTarget.focus();
    } else if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <>
      <div className="trip-ai-summary-action">
        <button
          type="button"
          ref={buttonRef}
          className={className}
          disabled={disabled || dialogBlocked || !tripId || sharing}
          aria-haspopup="dialog"
          onClick={() => void handleCopyAi()}
        >
          {sharing ? 'コピー中…' : 'AI要約'}
        </button>
        {error && !session && <div className="trip-detail__alert" role="alert">{error}</div>}
      </div>
      {session && selectedChunk && createPortal(
        <div className="ai-copy-modal" onClick={event => {
          if (event.target === event.currentTarget) closeDialog();
        }}>
          <div
            className="ai-copy-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby={dialogId}
            aria-describedby={statusId}
            ref={dialogRef}
            tabIndex={-1}
            onKeyDown={handleDialogKeyDown}
          >
            <div id={dialogId} className="ai-copy-card__title">AI要約用データ</div>
            <div id={statusId} className="ai-copy-card__status" aria-live="polite">{session.status}</div>
            {error && <div className="trip-detail__alert" role="alert">{error}</div>}
            <div className="ai-copy-card__meta">全文 {session.text.length.toLocaleString('ja-JP')}文字</div>
            <button
              type="button"
              className="trip-detail__button trip-detail__button--accent ai-copy-card__primary"
              disabled={sharing}
              onClick={() => void handleCopyAiText(
                session.text,
                `全文 ${session.text.length.toLocaleString('ja-JP')}文字をコピーしました`,
              )}
            >
              全文をコピー
            </button>

            {session.chunks.length > 1 && (
              <div className="ai-copy-card__chunk">
                <div className="ai-copy-card__chunk-label">貼り付け先で全文が切れる場合</div>
                <div className="ai-copy-card__chunk-meta">
                  <strong>分割 {selectedChunk.index}/{selectedChunk.total}</strong>
                  <span>{selectedChunk.text.length.toLocaleString('ja-JP')}文字</span>
                </div>
                <div className="ai-copy-card__chunk-actions">
                  <button
                    type="button"
                    className="trip-detail__button trip-detail__button--small"
                    title="前の分割へ"
                    aria-label="前の分割へ"
                    disabled={sharing || session.selectedChunkIndex === 0}
                    onClick={() => setAiCopySession(current => current ? {
                      ...current,
                      selectedChunkIndex: Math.max(0, current.selectedChunkIndex - 1),
                    } : current)}
                  >
                    ←
                  </button>
                  <button
                    type="button"
                    className="trip-detail__button trip-detail__button--accent ai-copy-card__chunk-copy"
                    disabled={sharing}
                    onClick={() => void handleCopyAiText(
                      selectedChunk.text,
                      `分割 ${selectedChunk.index}/${selectedChunk.total} をコピーしました`,
                    )}
                  >
                    分割 {selectedChunk.index}/{selectedChunk.total} をコピー
                  </button>
                  <button
                    type="button"
                    className="trip-detail__button trip-detail__button--small"
                    title="次の分割へ"
                    aria-label="次の分割へ"
                    disabled={sharing || session.selectedChunkIndex >= session.chunks.length - 1}
                    onClick={() => setAiCopySession(current => current ? {
                      ...current,
                      selectedChunkIndex: Math.min(current.chunks.length - 1, current.selectedChunkIndex + 1),
                    } : current)}
                  >
                    →
                  </button>
                </div>
              </div>
            )}

            <button
              type="button"
              className="trip-detail__button ai-copy-card__close"
              disabled={sharing}
              onClick={closeDialog}
            >
              閉じる
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
