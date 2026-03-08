import { BrowserRouter, Routes, Route } from 'react-router-dom';
import IcResolverJob from './IcResolverJob';
import LocalRecoveryBootstrap from './LocalRecoveryBootstrap';
import NativeUpdateNotice from './NativeUpdateNotice';
import RouteTrackingSupervisor from './RouteTrackingSupervisor';
import { APP_VERSION } from './version';

// Screens
import HomeScreen from '../ui/screens/HomeScreen';
import TripDetail from '../ui/screens/TripDetail';
import HistoryScreen from '../ui/screens/HistoryScreen';
import RouteMapScreen from '../ui/screens/RouteMapScreen';
import ReportDashboard from '../ui/screens/ReportDashboard';

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
      <Routes>
        <Route path="/" element={<HomeScreen />} />
        <Route path="/trip/:tripId" element={<TripDetail />} />
        <Route path="/trip/:tripId/route" element={<RouteMapScreen />} />
        <Route path="/history" element={<HistoryScreen />} />
        <Route path="/report" element={<ReportDashboard />} />
      </Routes>
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
