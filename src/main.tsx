import React from 'react';
import ReactDOM from 'react-dom/client';
import { seedNativeDriverSessionBeforeClient } from './services/nativeAuthBootstrap';
import './ui/styles/global.css';

// Mount the root component into the DOM. The strict mode helps catch
// unexpected side effects during development. Production builds omit it.
async function bootstrap() {
  const root = ReactDOM.createRoot(document.getElementById('root')!);
  root.render(
    <div className="screen-shell">
      <div className="screen-card screen-card--narrow" role="status" aria-live="polite">
        登録端末を確認しています…
      </div>
    </div>,
  );
  try {
    await seedNativeDriverSessionBeforeClient();
  } catch (error) {
    console.warn('[resident-location] pre-client session seed skipped', error);
  }

  // App imports create the Supabase clients. Keep them after the native seed so
  // supabase-js cannot refresh an older WebView token first.
  const [{ default: App }, { restoreNativeResidentLocationSession }] = await Promise.all([
    import('./app/App'),
    import('./services/nativeResidentLocation'),
  ]);
  try {
    await restoreNativeResidentLocationSession();
  } catch (error) {
    console.warn('[resident-location] startup session restore skipped', error);
  }
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void bootstrap();
