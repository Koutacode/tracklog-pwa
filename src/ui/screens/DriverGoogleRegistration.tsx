import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { driverCandidateAuth } from '../../services/driverCandidateAuth';
import { confirmDriverGoogleRegistration, getLocalDriverRegistrationFields } from '../../services/remoteAuth';
import { openExternalUrl } from '../../services/nativeShare';

type Candidate = Awaited<ReturnType<ReturnType<typeof driverCandidateAuth>['read']>>;
export default function DriverGoogleRegistration({ onComplete, onPendingChange }: {
  onComplete: () => Promise<void>; onPendingChange: (pending: boolean) => void;
}) {
  const [candidate, setCandidate] = useState<Candidate>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [vehicle, setVehicle] = useState('');
  const refresh = async () => {
    const value = await driverCandidateAuth().read();
    setCandidate(value); onPendingChange(!!value);
  };
  const action = async (fn: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'ログインを確認できませんでした。'); }
    finally { await refresh().catch(() => undefined); setBusy(false); }
  };
  useEffect(() => {
    let active = true;
    void refresh().catch(() => undefined);
    void getLocalDriverRegistrationFields().then(v => { if (active) { setName(v.displayName); setPhone(v.phone); setVehicle(v.vehicleLabel); } });
    return () => { active = false; };
  }, []);
  const start = (restart = false) => action(async () => {
    const url = await driverCandidateAuth().start(Capacitor.isNativePlatform(), window.location.origin, restart, candidate?.id);
    await refresh();
    if (Capacitor.isNativePlatform()) {
      if (!await openExternalUrl(url)) throw new Error('ブラウザを開けませんでした。取消して再試行してください。');
    } else window.location.assign(url);
  });
  return <section className="driver-registration" aria-busy={busy}>
    <h2>Googleで登録・ログイン</h2>
    <p>メールアドレスはGoogleアカウントから取得します。新しい端末は管理者の承認後に利用できます。</p>
    {!candidate && <button className="trip-btn trip-btn--primary" disabled={busy} onClick={() => void start()}>Googleで続ける</button>}
    {candidate && <>
      {candidate.email && <label className="settings-field">Googleアカウント<input value={candidate.email} readOnly /></label>}
      {(candidate.phase === 'selected' || candidate.phase === 'committing') && <>
        <label className="settings-field">名前<input value={name} onChange={e => setName(e.target.value)} disabled={busy} autoComplete="name" /></label>
        <label className="settings-field">電話番号（自己申告・本人確認には使用しません）<input value={phone} onChange={e => setPhone(e.target.value)} disabled={busy} type="tel" /></label>
        <label className="settings-field">車番<input value={vehicle} onChange={e => setVehicle(e.target.value)} disabled={busy} /></label>
        {candidate.phase === 'committing' && <p>登録の確定処理を再開します。同じアカウントで続けてください。保存済みの認証や登録情報がある場合は、その状態から再試行します。</p>}
        <button className="trip-btn trip-btn--primary" disabled={busy || !candidate.email} onClick={() => void action(async () => {
          await confirmDriverGoogleRegistration({ displayName: name, phone, vehicleLabel: vehicle }, candidate.id);
          onPendingChange(false); await onComplete();
        })}>{candidate.phase === 'committing' ? '確定処理を再試行' : 'このアカウントで登録を確定'}</button>
      </>}
      {candidate.phase === 'choosing' && <p>Googleでログインした後、この画面へ戻って登録を確認してください。</p>}
      {candidate.phase === 'expired' && <p>選択の有効期限が切れました。取消してやり直してください。</p>}
      <button className="trip-btn" disabled={busy} onClick={() => void action(refresh)}>状態を確認</button>
      {candidate.phase !== 'committing' && <button className="trip-btn" disabled={busy} onClick={() => void action(() => driverCandidateAuth().discard(candidate.id))}>仮ログインを取消</button>}
      {candidate.phase === 'committing' && <button className="trip-btn" disabled={busy} onClick={() => void start(true)}>同じGoogleアカウントで再認証</button>}
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
