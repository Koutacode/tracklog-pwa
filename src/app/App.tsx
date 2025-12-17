import { BrowserRouter, Routes, Route } from 'react-router-dom';
import PwaUpdater from './PwaUpdater';
import IcResolverJob from './IcResolverJob';
import { APP_VERSION } from './version';

// Screens
import HomeScreen from '../ui/screens/HomeScreen';
import TripDetail from '../ui/screens/TripDetail';
import HistoryScreen from '../ui/screens/HistoryScreen';

// Ensure routing works under GitHub Pages subpath (/runlog-pwa/).
const routerBase = import.meta.env.BASE_URL;

/**
 * App configures the top-level routing and persistent components. The
 * PwaUpdater and IcResolverJob components are mounted once to handle
 * service worker updates and expressway IC resolution. The current app
 * version is displayed in the bottom-right corner for debugging.
 */
export default function App() {
  return (
    <BrowserRouter basename={routerBase}>
      <PwaUpdater />
      <IcResolverJob />
      <Routes>
        <Route path="/" element={<HomeScreen />} />
        <Route path="/trip/:tripId" element={<TripDetail />} />
        <Route path="/history" element={<HistoryScreen />} />
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
