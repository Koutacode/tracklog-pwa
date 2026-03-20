import { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import IcResolverJob from './IcResolverJob';
import LocalRecoveryBootstrap from './LocalRecoveryBootstrap';
import NativeUpdateNotice from './NativeUpdateNotice';
import RouteTrackingSupervisor from './RouteTrackingSupervisor';
import { APP_VERSION } from './version';

const HomeScreen = lazy(() => import('../ui/screens/HomeScreen'));
const TripDetail = lazy(() => import('../ui/screens/TripDetail'));
const HistoryScreen = lazy(() => import('../ui/screens/HistoryScreen'));
const RouteMapScreen = lazy(() => import('../ui/screens/RouteMapScreen'));
const ReportDashboard = lazy(() => import('../ui/screens/ReportDashboard'));

// Keep routing aligned with the Vite base URL.
const routerBase = import.meta.env.BASE_URL;

/**
 * App configures the top-level routing and persistent components for the
 * native app. IcResolverJob and RouteTrackingSupervisor run globally to keep
 * expressway resolution and background route tracking stable. The current app
 * version is displayed in the bottom-right corner for debugging.
 */
export default function App() {
  return (
    <BrowserRouter basename={routerBase}>
      <IcResolverJob />
      <LocalRecoveryBootstrap />
      <NativeUpdateNotice />
      <RouteTrackingSupervisor />
      <Suspense fallback={<div style={{ padding: 24, color: '#fff' }}>読み込み中…</div>}>
        <Routes>
          <Route path="/" element={<HomeScreen />} />
          <Route path="/trip/:tripId" element={<TripDetail />} />
          <Route path="/trip/:tripId/route" element={<RouteMapScreen />} />
          <Route path="/history" element={<HistoryScreen />} />
          <Route path="/report" element={<ReportDashboard />} />
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
    </BrowserRouter>
  );
}
