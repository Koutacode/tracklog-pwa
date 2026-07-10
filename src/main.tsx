import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './app/App';
import { restoreNativeResidentLocationSession } from './services/nativeResidentLocation';
import './ui/styles/global.css';

// Mount the root component into the DOM. The strict mode helps catch
// unexpected side effects during development. Production builds omit it.
async function bootstrap() {
  try {
    await restoreNativeResidentLocationSession();
  } catch (error) {
    console.warn('[resident-location] startup session restore skipped', error);
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void bootstrap();
