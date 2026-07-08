type FirebasePushConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  messagingSenderId: string;
  appId: string;
};

function envText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

export const FIREBASE_PUSH_CONFIG: FirebasePushConfig = {
  apiKey: envText(import.meta.env.VITE_FIREBASE_API_KEY),
  authDomain: envText(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN),
  projectId: envText(import.meta.env.VITE_FIREBASE_PROJECT_ID),
  messagingSenderId: envText(import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID),
  appId: envText(import.meta.env.VITE_FIREBASE_APP_ID),
};

export const FIREBASE_WEB_VAPID_KEY = envText(import.meta.env.VITE_FIREBASE_VAPID_KEY);

export function isFirebaseWebPushConfigured() {
  return (
    !!FIREBASE_PUSH_CONFIG.apiKey &&
    !!FIREBASE_PUSH_CONFIG.authDomain &&
    !!FIREBASE_PUSH_CONFIG.projectId &&
    !!FIREBASE_PUSH_CONFIG.messagingSenderId &&
    !!FIREBASE_PUSH_CONFIG.appId &&
    !!FIREBASE_WEB_VAPID_KEY
  );
}
