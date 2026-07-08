import { Suspense, lazy, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import AdminAuthBridge from './AdminAuthBridge';
import IcResolverJob from './IcResolverJob';
import LocalRecoveryBootstrap from './LocalRecoveryBootstrap';
import NativeUpdateNotice from './NativeUpdateNotice';
import PwaBootstrap from './PwaBootstrap';
import RequireDriverProfile from './RequireDriverProfile';
import RemoteSyncBootstrap from './RemoteSyncBootstrap';
import RouteTrackingSupervisor from './RouteTrackingSupervisor';
import { onDriverAuthStateChange } from '../services/remoteAuth';
import { runRemoteSync } from '../services/remoteSync';
import { APP_VERSION } from './version';
import AdminMessageToastHost from '../ui/components/AdminMessageToastHost';

const HomeScreen = lazy(() => import('../ui/screens/HomeScreen'));
const TripDetail = lazy(() => import('../ui/screens/TripDetail'));
const HistoryScreen = lazy(() => import('../ui/screens/HistoryScreen'));
const RouteMapScreen = lazy(() => import('../ui/screens/RouteMapScreen'));
const ReportDashboard = lazy(() => import('../ui/screens/ReportDashboard'));
const SettingsScreen = lazy(() => import('../ui/screens/SettingsScreen'));
const LoginScreen = lazy(() => import('../ui/screens/LoginScreen'));
const AdminDashboard = lazy(() => import('../ui/screens/AdminDashboard'));
const AdminDeviceDetail = lazy(() => import('../ui/screens/AdminDeviceDetail'));
const AdminTripDetail = lazy(() => import('../ui/screens/AdminTripDetail'));

// Keep routing aligned with the Vite base URL.
const routerBase = import.meta.env.BASE_URL;

function AppShell() {
  const location = useLocation();
  const isAdminRoute =
    location.pathname.startsWith('/login') || location.pathname.startsWith('/admin');

  useEffect(() => {
    const unsubscribe = onDriverAuthStateChange(() => {
      void runRemoteSync('driver-auth');
    });
    return () => {
      unsubscribe();
    };
  }, []);

  return (
    <>
      <AdminAuthBridge />
      <PwaBootstrap />
      {!isAdminRoute && (
        <>
          <IcResolverJob />
          <LocalRecoveryBootstrap />
          <NativeUpdateNotice />
          <AdminMessageToastHost />
          <RouteTrackingSupervisor />
          <RemoteSyncBootstrap />
        </>
      )}
      <Suspense fallback={<div style={{ padding: 24, color: '#fff' }}>読み込み中…</div>}>
        <Routes>
          <Route path="/setup" element={<Navigate to="/" replace />} />
          <Route path="/" element={<RequireDriverProfile><HomeScreen /></RequireDriverProfile>} />
          <Route path="/settings" element={<RequireDriverProfile><SettingsScreen /></RequireDriverProfile>} />
          <Route path="/trip/:tripId" element={<RequireDriverProfile><TripDetail /></RequireDriverProfile>} />
          <Route path="/trip/:tripId/route" element={<RequireDriverProfile><RouteMapScreen /></RequireDriverProfile>} />
          <Route path="/history" element={<RequireDriverProfile><HistoryScreen /></RequireDriverProfile>} />
          <Route path="/report" element={<RequireDriverProfile><ReportDashboard /></RequireDriverProfile>} />
          <Route path="/login" element={<LoginScreen />} />
          <Route path="/admin" element={<AdminDashboard />} />
          <Route path="/admin/devices/:deviceId" element={<AdminDeviceDetail />} />
          <Route path="/admin/trips/:tripId" element={<AdminTripDetail />} />
        </Routes>
      </Suspense>
      <div
        style={{
          position: 'fixed',
          right: 10,
          bottom: 10,
          opacity: 0.5,
          fontSize: 12,
        }}
      >
        v{APP_VERSION}
      </div>
    </>
  );
}

/**
 * App configures the top-level routing and persistent components for the
 * native app. Operator-only jobs are skipped on admin routes so the web
 * management UI does not start local recovery or route tracking workers.
 */
export default function App() {
  return (
    <BrowserRouter basename={routerBase}>
      <AppShell />
    </BrowserRouter>
  );
}
