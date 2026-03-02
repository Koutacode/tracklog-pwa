# CLAUDE.md — TrackLog Assist

AI assistant reference for the **TrackLog運行アシスト** repository.

---

## Project Overview

**TrackLog Assist** is a truck operations logging Android native application built with React + TypeScript + Capacitor. It logs trip events (rest stops, fuel, expressway usage, etc.), records GPS routes, and computes daily distance summaries.

> **Important:** Despite the folder/repo name `tracklog-pwa`, this is an **Android Native app only** (Capacitor). PWA installation flows were intentionally removed. Do not restore PWA-related code unless explicitly asked.

- **App ID:** `com.tracklog.assist`
- **App Name:** `TrackLog運行アシスト`
- **Version:** `0.1.2` (in `package.json`)
- **UI language:** Japanese

---

## Core Requirements (Never Break)

1. **Background route recording** — GPS continues when the app is backgrounded.
2. **Expressway detection** — Auto-detect highway entry/exit; confirm exit before ending event.
3. **Package ID** — `com.tracklog.assist` must never change.
4. **Diagnostics** — Status indicators must reflect real state; avoid hardcoding "yellow/warning" states.
5. **AI Summary** — The AI summary feature must not auto-insert fixed phrases like `要約してください`.

---

## Directory Structure

```
tracklog-pwa/
├── .github/workflows/         # CI and Notion sync GitHub Actions
├── android/                   # Capacitor Android project (generated)
├── docs/
│   ├── ANDROID.md             # Android build and device setup guide (Japanese)
│   ├── SYNC.md                # Notion↔GitHub sync guide (Japanese)
│   └── NOTION_SYNC_STATUS.md  # Auto-generated sync timestamps
├── output/                    # APK build output (gitignored)
├── public/                    # Static assets (icons, screenshots)
├── scripts/
│   ├── sync_notion_from_github.mjs   # Push GitHub metadata → Notion
│   └── pull_notion_status_to_repo.mjs # Pull Notion timestamps → repo
├── skills/
│   └── tracklog-release-notion/
│       ├── SKILL.md           # Agent skill definition for releases
│       └── scripts/prepare-tracklog-release.ps1
├── src/
│   ├── app/
│   │   ├── App.tsx                    # Router setup + global background jobs
│   │   ├── RouteTrackingSupervisor.tsx # GPS tracking lifecycle orchestrator
│   │   ├── IcResolverJob.tsx          # Background IC/expressway name resolver
│   │   ├── NativeUpdateNotice.tsx     # APK update checker
│   │   ├── version.ts                 # Exposes __APP_VERSION__, __BUILD_DATE__
│   │   └── releaseInfo.ts             # GitHub release metadata / APK URL
│   ├── db/
│   │   ├── db.ts                      # Dexie schema (3 tables)
│   │   └── repositories.ts            # All data access functions (~300 lines)
│   ├── domain/
│   │   ├── types.ts                   # Core event types and interfaces
│   │   ├── metrics.ts                 # Segment/total/day-run calculations
│   │   └── jst.ts                     # Japan Standard Time utilities
│   ├── services/
│   │   ├── routeTracking.ts           # Dual-mode GPS tracking (precision/battery)
│   │   ├── geo.ts                     # Browser geolocation + reverse geocoding
│   │   ├── icResolver.ts              # Overpass API expressway detection
│   │   ├── mapMatching.ts             # OSRM road snapping
│   │   ├── voiceControl.ts            # Japanese speech recognition
│   │   ├── wakeLock.ts                # Screen wake lock
│   │   ├── nativeExpresswayPrompt.ts  # Native Android dialog for expressway end
│   │   ├── nativeSetup.ts             # Capacitor plugin initialization
│   │   └── startupDiagnostics.ts      # Permission/battery startup checks
│   ├── state/
│   │   └── selectors.ts               # buildTripViewModel() and timeline
│   └── ui/
│       ├── components/
│       │   ├── BigButton.tsx          # Large touch button (primary/danger/neutral)
│       │   ├── OdoDialog.tsx          # Odometer input bottom sheet
│       │   ├── FuelDialog.tsx         # Fuel refill entry dialog
│       │   └── ConfirmDialog.tsx      # Generic confirmation modal
│       ├── screens/
│       │   ├── HomeScreen.tsx         # Main operation screen
│       │   ├── TripDetail.tsx         # Event editor and trip inspection
│       │   ├── HistoryScreen.tsx      # Past trips list
│       │   └── RouteMapScreen.tsx     # Leaflet map with GPS route
│       └── styles/
│           └── global.css             # Global CSS variables and shared classes
├── AGENTS.md                  # Japanese-language project rules (original)
├── CLAUDE.md                  # This file
├── capacitor.config.ts        # Capacitor app config (appId, webDir, etc.)
├── index.html                 # HTML entry point
├── package.json               # Dependencies and npm scripts
├── tsconfig.json              # TypeScript config (strict, ES2020)
└── vite.config.ts             # Vite build config with global defines
```

---

## Development Commands

```bash
# Install dependencies
npm ci

# TypeScript type checking (used in CI)
npm run typecheck

# Start Vite dev server (web preview only)
npm run dev

# Production web build → dist/
npm run build

# Preview built output
npm run preview

# Sync web build into Android project
npm run cap:sync:android

# Full Android build (Windows PowerShell)
npm run release:prepare
# Equivalent manual steps:
#   npm run build
#   npm run cap:sync:android
#   cd android && .\gradlew.bat assembleDebug

# Notion sync (requires NOTION_TOKEN)
npm run sync:notion:push   # GitHub → Notion
npm run sync:notion:pull   # Notion → repo file
```

---

## CI/CD

### GitHub Actions Workflows

| Workflow | Trigger | Purpose |
|---|---|---|
| `ci.yml` | Push/PR to `main` | `typecheck` + `build` |
| `sync-notion-from-github.yml` | Push to `main` | Sync GitHub metadata → Notion (skips if no `NOTION_TOKEN`) |
| `sync-github-from-notion.yml` | Hourly cron (`:17`) | Mirror Notion timestamps → `docs/NOTION_SYNC_STATUS.md` |

### Required Secrets (for Notion sync)

- `NOTION_TOKEN` — Notion API key
- `NOTION_PAGE_TRACKLOG` — Main TrackLog page ID
- `NOTION_PAGE_APPS` — Personal apps page ID
- `NOTION_PAGE_IMPROVEMENTS` — Improvements sub-page ID

### Optional GitHub Variables

- `NOTION_CHANGE_ITEMS` — Release changelog (3-6 items)
- `NOTION_DEVICE_VERIFICATION` — Device test summary
- `TRACKLOG_APP_ID` — Default: `com.tracklog.assist`
- `TRACKLOG_APP_MODE` — Default: `Android Native (Capacitor)`
- `LOCAL_APK_PATH` — Default: `output/tracklog-assist-debug.apk`

---

## Architecture

### Local-First / Offline-First

All core operations work without network. Services like Nominatim (reverse geocoding), Overpass API (expressway detection), and OSRM (map matching) are optional. Failures degrade gracefully.

### Event Sourcing

All user actions append immutable events to IndexedDB. Trip state is always derived/computed from events — never stored directly. This supports audit trails and offline sync.

### Data Flow

```
User Action → repositories.ts → Dexie (IndexedDB)
                                      ↓
                              selectors.ts → TripViewModel (computed)
                                      ↓
                              UI screens (React state)
```

---

## Data Layer (`src/db/`)

### Dexie Schema (`db.ts`)

Three IndexedDB tables:

| Table | Type | Key Indexes |
|---|---|---|
| `events` | `AppEvent` | `id`, `tripId`, `type`, `ts`, `[tripId+ts]`, `[tripId+type]`, `[tripId+type+ts]` |
| `meta` | Key-value `MetaRow` | `key` |
| `routePoints` | `RoutePoint` | `id`, `tripId`, `ts`, `[tripId+ts]` |

### Meta Keys

| Key | Type | Purpose |
|---|---|---|
| `activeTripId` | `string` | Currently active trip UUID |
| `autoExpresswayConfig` | JSON string | Speed/duration thresholds for auto detection |
| `routeTrackingEnabled` | `'0'` or `'1'` | Whether GPS tracking is active |
| `routeTrackingMode` | `'precision'` \| `'battery'` | Tracking accuracy mode |
| `pendingExpresswayEndPrompt` | JSON string | Expressway exit detection awaiting user decision |
| `pendingExpresswayEndDecision` | JSON string | User's decision on expressway exit prompt |

### Key Repository Functions (`repositories.ts`)

```typescript
// Trip lifecycle
startTrip(tripId, odoKm, geo?)
endTrip(tripId, odoKm, totalKm, lastLegKm, geo?)
getActiveTripId(): Promise<string | null>
clearActiveTripId()

// Events
addEvent(event)
updateEvent(id, patch)
deleteEvent(id)
getEventsByTripId(tripId): Promise<AppEvent[]>

// Paired sessions (rest/break/load/unload/expressway)
startRest(tripId, geo?)  // Creates rest_start + restSessionId
endRest(tripId, geo?)    // Creates rest_end matching restSessionId
startExpressway(tripId, geo?, reason?)
endExpressway(tripId, geo?)

// Configuration
getAutoExpresswayConfig(): Promise<AutoExpresswayConfig>
setAutoExpresswayConfig(config)
getRouteTrackingMode(): Promise<RouteTrackingMode>
setRouteTrackingMode(mode)

// Route points
addRoutePoint(tripId, point)
pruneRoutePointsForRetention(tripId)

// Utilities
uuid(): string         // crypto.randomUUID() with fallback
nowIso(): string       // Current timestamp as ISO string
setMeta(key, value)    // Pass null to delete
getMeta(key)
```

---

## Domain Types (`src/domain/types.ts`)

### Event Types (Discriminated Union)

```typescript
type EventType =
  | 'trip_start' | 'trip_end'
  | 'rest_start' | 'rest_end'
  | 'break_start' | 'break_end'
  | 'load_start' | 'load_end'
  | 'unload_start' | 'unload_end'
  | 'refuel' | 'boarding' | 'expressway'
  | 'expressway_start' | 'expressway_end'
  | 'point_mark'
```

### BaseEvent Structure

```typescript
type BaseEvent = {
  id: string            // UUID
  tripId: string        // Parent trip UUID
  type: EventType
  ts: string            // ISO timestamp (UTC)
  geo?: Geo             // { lat, lng, accuracy? }
  address?: string      // Reverse-geocoded address string
  syncStatus: 'pending' | 'synced' | 'error'
  extras?: Record<string, unknown>
}
```

### Notable extras Fields

| Event | extras field |
|---|---|
| `trip_start` | `{ odoKm: number }` |
| `trip_end` | `{ odoKm, totalKm, lastLegKm }` |
| `rest_start/end` | `{ restSessionId }` |
| `break_start/end` | `{ breakSessionId }` |
| `load_start/end` | `{ loadSessionId }` |
| `unload_start/end` | `{ unloadSessionId }` |
| `expressway_start/end` | `{ expresswaySessionId }` |
| `refuel` | `{ liters: number }` |

Session IDs link paired events. Legacy data may lack session IDs; fallback uses timestamp proximity.

### Computed Models

```typescript
type TripViewModel = {
  tripId: string
  hasTripEnd: boolean
  odoStart: number
  odoEnd?: number
  totalKm?: number
  lastLegKm?: number
  segments: Segment[]    // Distance legs between rest stops
  dayRuns: DayRun[]      // Per-JST-day distance summaries
  timeline: TimelineItem[]
  validation: { ok: boolean; errors: string[] }
}
```

`buildTripViewModel()` in `src/state/selectors.ts` derives this from raw events.

---

## Services (`src/services/`)

### `routeTracking.ts` — GPS Tracking

Two modes configurable by user:

| Mode | Interval | Min Distance | Max Accuracy | Use Case |
|---|---|---|---|---|
| `precision` | 6s | 12m | 35m | High-accuracy routing |
| `battery` | 15s | 40m | 70m | Longer battery life |

- Uses `@capacitor-community/background-geolocation` on Android
- Falls back to browser `navigator.geolocation` for web dev
- Buffers up to 120 pending points before flush
- Validates points for jitter and velocity outliers

### `geo.ts` — Geolocation & Reverse Geocoding

- `getGeo()` — browser geolocation, 5s timeout then 8s retry
- `reverseGeocode(lat, lng)` — Nominatim (OpenStreetMap) API
- Formats Japanese addresses: postal code, prefecture, city, ward, street
- Returns `undefined` on failure (non-blocking)

### `icResolver.ts` — Expressway Detection

- Queries Overpass API for motorway junctions, toll booths, ETC gantries
- Primary endpoint: `https://overpass-api.de/api/interpreter`
- Fallback: `https://overpass.kumi.systems/api/interpreter`
- 4-second per-endpoint timeout
- Default search radius: 5000m
- Returns `ExpresswaySignal` with `onExpresswayRoad`, `nearIc`, `nearEtcGate`

### `mapMatching.ts` — Route Snapping

- Sends GPS points to OSRM API to snap to road network
- Falls back to raw points if offline/error

### `voiceControl.ts` — Speech Recognition

- Uses `@capacitor-community/speech-recognition`
- Parses Japanese voice commands
- Normalizes full-width digits, katakana → hiragana
- Supports 19 command types including `trip_start`, `rest_start`, `expressway_end`
- Extracts odometer values from speech

### `wakeLock.ts` — Screen Wake Lock

- Prevents device sleep during active trips
- Uses Web Screen Wake Lock API

---

## Automatic Expressway Detection Logic

Multi-stage algorithm running in `RouteTrackingSupervisor`:

1. **Entry detection:** Speed >78 km/h for 6+ seconds with acceleration signal (0.18 m/s²)
2. **Confirmation:** 2+ hits over 12+ seconds required
3. **IC proximity:** Overpass API checked (5km radius); resolves IC name
4. **Exit detection:** Speed <34 km/h for 24+ seconds with deceleration signal (-0.28 m/s²)
5. **User confirmation:** Prompts user to "End expressway" or "Continue" before recording exit event
6. **IC retry:** Up to 6 retries with exponential backoff (2s → 2 min → 60 min cap)

Configuration stored in `meta.autoExpresswayConfig`:
```typescript
type AutoExpresswayConfig = {
  speedKmh: number       // Entry speed threshold (default: 78)
  durationSec: number    // Entry hold duration (default: 6)
  endSpeedKmh: number    // Exit speed threshold (default: 34)
  endDurationSec: number // Exit hold duration (default: 24)
}
```

---

## UI Screens

### `HomeScreen.tsx`
Main operation screen with large touch buttons. Controls:
- Start/end trip (requires ODO reading)
- Start/end rest, break, load, unload
- Manual/auto expressway start/end
- Refuel, boarding, point mark events
- Voice command toggle
- Route tracking mode selector
- Auto-expressway config settings
- Startup diagnostics display
- Wake lock status

### `TripDetail.tsx`
Full trip inspection and editing:
- Event list with timestamps, types, addresses
- Edit event timestamps, types, numeric values
- Distance summary (ODO range, total km, last leg km)
- Day-by-day segment breakdown
- Comprehensive validation (missing trip_start, orphaned events, negative distances)
- AI summary export (structured JSON for ChatGPT/Claude)
- Event deletion

### `HistoryScreen.tsx`
Past trip list with:
- Trip status (active/completed)
- ODO range, total km, duration
- Navigation to TripDetail and RouteMap
- Trip deletion

### `RouteMapScreen.tsx`
GPS route visualization using Leaflet:
- Color-coded routes by day
- Date-based visibility toggle
- OSRM map matching applied
- Distance computed via Haversine formula

---

## Styling Conventions

- **No CSS framework** (no Tailwind, no CSS Modules)
- **Inline styles** preferred for component-specific styling
- **Global CSS** (`global.css`) for shared classes and CSS custom properties
- **Dark theme** with CSS variables:
  ```css
  --bg: #060913
  --surface: rgba(15, 23, 42, 0.7)
  --border: rgba(148, 163, 184, 0.22)
  --text: #e2e8f0
  --accent: #38bdf8
  ```
- **Glassmorphism** via `backdrop-filter: blur(10px)`
- **Font stack:** `'Manrope', 'Noto Sans JP', 'Inter', 'Helvetica Neue', system-ui`
- **Touch targets:** BigButton min-height 78px
- Key shared CSS classes: `.card`, `.pill-link`, `.page-shell`, `.auto-expressway-overlay`, `.history-card`

---

## TypeScript Configuration

- Strict mode enabled
- Target: ES2020
- JSX: react-jsx
- Module resolution: Node
- Source: `src/` directory only

### Global Build-Time Constants (via `vite.config.ts` `define`)

```typescript
declare const __APP_VERSION__: string
declare const __BUILD_DATE__: string
declare const __TRACKLOG_GITHUB_OWNER__: string
declare const __TRACKLOG_GITHUB_REPO__: string
declare const __TRACKLOG_RELEASE_APK_NAME__: string
```

These are declared in `src/vite-env.d.ts`.

---

## Key Patterns and Conventions

### 1. Paired Event Sessions
Start/end event pairs share a session ID in `extras`:
```typescript
// rest_start: { extras: { restSessionId: 'abc-uuid' } }
// rest_end:   { extras: { restSessionId: 'abc-uuid' } }
```
Always use the repository functions (`startRest()`, `endRest()`, etc.) to create paired events — don't create them manually.

### 2. JST Day Boundaries
Days reset at **midnight Japan Standard Time (UTC+9)**, not UTC.
Use `getJstDateInfo(ts)` from `src/domain/jst.ts` for all date grouping.

### 3. Defensive JSON Serialization
All meta values are stored as JSON strings with type validation on read.
Use the existing `normalize*()` functions; don't trust raw `JSON.parse()` results from meta.

### 4. Graceful Service Degradation
Network services (Nominatim, Overpass, OSRM) may be unavailable. All callers must handle `undefined`/`null` return values without breaking core functionality.

### 5. No Flux/Redux State Management
There is no global state store. UI state lives in `useState`. Persistent state lives in Dexie. Pass data as props or re-query Dexie after mutations.

### 6. Background Supervisor Components
`IcResolverJob` and `RouteTrackingSupervisor` run as always-mounted React components in `App.tsx`. They poll on intervals (60s and 15s respectively) and respond to `online` and `visibilitychange` browser events.

### 7. Validation Accumulation
Validation (in `buildTripViewModel` and `TripDetail`) collects **all** errors, not just the first. Never break validation to fail-fast.

---

## Testing

There are **no unit tests** in this project. CI runs only:
1. `npm run typecheck` — TypeScript type checking
2. `npm run build` — Vite production build

When making changes, always run `npm run typecheck` to verify correctness.

---

## Release Workflow

1. Implement changes on a feature branch
2. Commit with descriptive message (see recent git log for style: `feat(native):`, `fix:`, `chore:`)
3. Merge to `main` — CI runs typecheck + build
4. On main push: Notion sync runs automatically (if `NOTION_TOKEN` set)
5. For APK release: run `npm run release:prepare` (Windows/PowerShell only)
6. APK output: `output/tracklog-assist-debug.apk`
7. Update Notion pages: change items, device verification results, SHA-256 checksum

### Local Skill for Release
```bash
powershell -ExecutionPolicy Bypass -File skills/tracklog-release-notion/scripts/prepare-tracklog-release.ps1 -Build -SyncAndroid -AssembleDebug
```
See `skills/tracklog-release-notion/SKILL.md` for full release checklist.

---

## Notion Sync Policy

When updating the repo, both GitHub and Notion should be updated.

**Target Notion pages:**
- `個人アプリ` (Personal Apps)
- `TrackLog運行アシスト｜機能・アップデート・配布情報` (Main TrackLog page)
- `改善点` (Improvements — sub-page of TrackLog)

Automatic sync runs via GitHub Actions. Manual sync:
```bash
npm run sync:notion:push   # Push changes to Notion
npm run sync:notion:pull   # Pull Notion status to docs/NOTION_SYNC_STATUS.md
```

---

## External APIs Used

| Service | Endpoint | Purpose | Required? |
|---|---|---|---|
| Nominatim (OSM) | `nominatim.openstreetmap.org` | Reverse geocoding | Optional |
| Overpass API | `overpass-api.de` / `overpass.kumi.systems` | Expressway detection | Optional |
| OSRM | Public OSRM instance | Route map matching | Optional |

All are public APIs. No API keys required. All degrade gracefully on failure.

---

## Device Verification Checklist

When verifying on physical Android device:
1. Uninstall → reinstall → verify startup (no crash/ANR)
2. Confirm background process survives app switch
3. Check permissions: Location (Always), Notifications, Exact Alarm
4. Confirm battery optimization exclusion for `com.tracklog.assist`
5. Test background GPS recording with screen off
6. Test expressway auto-detection (speed threshold triggers correctly)
