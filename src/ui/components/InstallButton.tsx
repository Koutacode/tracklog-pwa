import { useEffect, useState } from 'react';

type BeforeInstallPromptEventLike = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

function isStandalone(): boolean {
  return (
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    // iOS Safari specific
    (navigator as any).standalone === true
  );
}

export default function InstallButton() {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEventLike | null>(null);
  const [installed, setInstalled] = useState<boolean>(isStandalone());
  const [installing, setInstalling] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    function onBIP(e: Event) {
      e.preventDefault();
      setPromptEvent(e as BeforeInstallPromptEventLike);
    }
    function onInstalled() {
      setInstalled(true);
      setPromptEvent(null);
    }
    window.addEventListener('beforeinstallprompt', onBIP);
    window.addEventListener('appinstalled', onInstalled);
    setChecked(true);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBIP);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (installed) return null;

  const canPrompt = !!promptEvent;
  const label = canPrompt
    ? installing
      ? '追加中…'
      : 'アプリを追加'
    : '追加方法を表示';

  return (
    <button
      onClick={async () => {
        if (!promptEvent) {
          alert(
            'インストールが見つからない場合は、ブラウザのメニューから「アプリをインストール」または「ホーム画面に追加」を選択してください。\n準備ができ次第、このボタンが有効になります。',
          );
          return;
        }
        try {
          setInstalling(true);
          await promptEvent.prompt();
          await promptEvent.userChoice;
        } finally {
          setInstalling(false);
          setPromptEvent(null);
        }
      }}
      disabled={installing}
      style={{
        width: '100%',
        height: 52,
        borderRadius: 12,
        border: '1px solid #164e63',
        background: !promptEvent ? '#1f2937' : '#0f766e',
        color: '#fff',
        fontWeight: 800,
        fontSize: 16,
        opacity: installing ? 0.7 : 1,
      }}
    >
      {!checked ? '準備中…' : label}
    </button>
  );
}
