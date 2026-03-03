# CLAUDE.md — TrackLog PWA

This file provides guidance for AI assistants (Claude Code and others) working in this repository.

---

## Project Overview

**TrackLog運行アシスト** is an **Android Native** truck operation logging app built with React + TypeScript + Capacitor. It records daily driving duty logs for Japanese truck operators, including GPS route tracking, expressway detection, and regulatory compliance reporting.

- Package ID: `com.tracklog.assist`
- This is **Android Native only** — do NOT restore PWA install prompts or PWA updater logic unless explicitly asked.
- UI language: Japanese (日本語). All user-facing strings must remain in Japanese.

---

## Repository Structure

```
tracklog-pwa/
├── src/
│   ├── app/                  # Root routing, background supervisors
│   │   ├── App.tsx           # Router + persistent background jobs
│   │   ├── IcResolverJob.tsx # Background expressway IC name resolver
│   │   ├── RouteTrackingSupervisor.tsx  # GPS tracking lifecycle
│   │   ├── NativeUpdateNotice.tsx       # APK update checker
│   │   ├── version.ts        # __APP_VERSION__ injection
│   │   └── releaseInfo.ts    # GitHub release APK asset config
│   ├── db/
│   │   ├── db.ts             # Dexie (IndexedDB) schema, 3 migrations
│   │   └── repositories.ts   # Data access objects (DAO pattern)
│   ├── domain/
│   │   ├── types.ts          # Core data types (EventType, AppEvent, RoutePoint, etc.)
│   │   ├── reportTypes.ts    # Regulatory report data types
│   │   ├── reportLogic.ts    # Japanese truck regulation compliance logic
│   │   ├── metrics.ts        # KPI calculations
│   │   └── jst.ts            # Japan Standard Time utilities
│   ├── services/
│   │   ├── routeTracking.ts  # GPS tracking, precision/battery modes
│   │   ├── icResolver.ts     # Overpass API expressway IC lookup
│   │   ├── geo.ts            # Reverse geocoding with caching
│   │   ├── voiceControl.ts   # Japanese speech recognition commands
│   │   └── mapMatching.ts    # GPS route snapping
│   ├── state/                # State selectors
│   ├── ui/
│   │   ├── screens/          # Full-page views (Home, TripDetail, RouteMap, History, Report)
│   │   ├── components/       # Reusable UI components (dialogs, buttons)
│   │   └── styles/           # Global CSS
│   └── main.tsx              # React app entry point
├── android/                  # Capacitor Android native project
├── scripts/                  # GitHub ↔ Notion sync scripts
├── skills/                   # Local Claude skills
│   └── tracklog-release-notion/SKILL.md
├── docs/                     # Developer documentation
├── .github/workflows/        # CI/CD GitHub Actions
├── AGENTS.md                 # Local agent rules (also read this)
├── capacitor.config.ts       # Capacitor app config
├── vite.config.ts            # Vite build config
└── tsconfig.json
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| UI Framework | React 19 |
| Routing | React Router 7 |
| Language | TypeScript 5.9 (strict mode) |
| Build Tool | Vite 7 |
| Local Database | Dexie 4 (IndexedDB) |
| Native Bridge | Capacitor 8 (Android) |
| Maps | Leaflet 1.9 |
| GPS | `@capacitor-community/background-geolocation` |
| Speech | `@capacitor-community/speech-recognition` |
| Notifications | `@capacitor/local-notifications` |

---

## Architecture

The codebase follows a **layered architecture**:

```
UI Layer      → src/ui/           (React screens + components)
App Layer     → src/app/          (routing, background supervisors)
Service Layer → src/services/     (GPS, IC resolver, geocoding, voice)
Domain Layer  → src/domain/       (types, business rules, calculations)
DB Layer      → src/db/           (Dexie schema, DAOs)
Native Layer  → android/ + Capacitor plugins
```

### Key Patterns

- **Repository Pattern**: `db/repositories.ts` and `db/reportRepository.ts` abstract all database access.
- **Background Supervisors**: `IcResolverJob` and `RouteTrackingSupervisor` are persistent React components that run background logic on mount and clean up on unmount.
- **Offline-First**: All data lives in IndexedDB. The `syncStatus` field on events tracks pending/synced/error state.
- **Event Sourcing**: All driver actions are recorded as immutable events (`trip_start`, `rest_start`, `refuel`, etc.).

### Core Domain Types (`src/domain/types.ts`)

```typescript
type EventType = 'trip_start' | 'trip_end' | 'rest_start' | 'rest_end'
               | 'break_start' | 'break_end' | 'load_start' | 'load_end'
               | 'unload_start' | 'unload_end' | 'refuel' | 'boarding'
               | 'expressway' | 'expressway_start' | 'expressway_end' | 'point_mark';

type BaseEvent = {
  id: string; tripId: string; type: EventType;
  ts: string; // ISO timestamp
  geo?: Geo; address?: string;
  syncStatus: 'pending' | 'synced' | 'error';
  extras?: Record<string, unknown>;
};
```

### Database Schema (`src/db/db.ts`)

| Table | Key | Purpose |
|-------|-----|---------|
| `events` | `id` | All operation events |
| `meta` | `key` | Key-value metadata (active trip, config) |
| `routePoints` | `id` | GPS coordinate history |
| `reportTrips` | `id` | Monthly/weekly report snapshots |

---

## Development Workflows

### Local Development

```bash
npm run dev         # Start Vite dev server with HMR
npm run typecheck   # Run TypeScript type checking (no emit)
npm run build       # Production Vite build → dist/
```

### Android Build

```bash
npm run build
npm run cap:sync:android           # Sync dist/ to android/
cd android && ./gradlew assembleDebug
# APK output: output/tracklog-assist-debug.apk
```

### Release

Use the local skill for automated releases:

```powershell
powershell -ExecutionPolicy Bypass -File skills/tracklog-release-notion/scripts/prepare-tracklog-release.ps1 -Build -SyncAndroid -AssembleDebug
```

### Notion Sync

```bash
npm run sync:notion:push   # Push GitHub state → Notion
npm run sync:notion:pull   # Pull Notion status → docs/NOTION_SYNC_STATUS.md
```

---

## CI/CD

### GitHub Actions Workflows

| Workflow | Trigger | Purpose |
|---------|---------|---------|
| `ci.yml` | Push/PR to `main` | `typecheck` + `build` |
| `sync-notion-from-github.yml` | Push to `main` | GitHub → Notion sync |
| `sync-github-from-notion.yml` | Hourly at :17 | Notion → GitHub mirror |

**Required Secrets**: `NOTION_TOKEN`, optionally `NOTION_PAGE_TRACKLOG`, `NOTION_PAGE_APPS`, `NOTION_PAGE_IMPROVEMENTS`

**Build Globals (vite.config.ts)**:
- `__APP_VERSION__` — from `package.json`
- `__BUILD_DATE__` — ISO timestamp at build time
- `__TRACKLOG_GITHUB_OWNER__` — `'Koutacode'`
- `__TRACKLOG_GITHUB_REPO__` — `'tracklog-pwa'`
- `__TRACKLOG_RELEASE_APK_NAME__` — `'tracklog-assist-debug.apk'`

---

## Key Conventions

### TypeScript

- **Strict mode** is on — do not disable `strict`, `noImplicitAny`, or `strictNullChecks`.
- `isolatedModules: true` — each file must be independently compilable.
- Use `tsc --noEmit` (`npm run typecheck`) to validate before committing.
- No test framework is configured; the CI only runs typecheck + build.

### Code Style

- No linter/formatter is configured. Match the style of existing files.
- Japanese strings in UI — do not translate to English.
- Prefer editing existing files over creating new ones.

### Critical Product Constraints

- **Background GPS tracking** is the #1 requirement — never break it.
- **Expressway detection** must remain reliable; the exit flow requires a user confirmation action (end/continue).
- Diagnostic status indicators must reflect real state — do not hard-code colors.
- Do not auto-insert any fixed AI summary phrases (e.g., `要約してください`).
- Do not add PWA install prompts, service workers for offline caching, or PWA updater logic.
- Maintain package ID `com.tracklog.assist` — do not change it.

### GPS Tracking Modes (`src/services/routeTracking.ts`)

- **Precision mode**: 6–12m intervals, high accuracy
- **Battery-saving mode**: 30m intervals
- Auto-switches based on speed
- Drops stale points older than 90 seconds
- Queue max: 120 pending records

### IC Resolver (`src/app/IcResolverJob.tsx` + `src/services/icResolver.ts`)

- Polls for pending expressway events every 60 seconds
- Uses Overpass API (2 redundant endpoints) within 220m radius
- Exponential backoff: 2–60 minute retry intervals

### Reporting Logic (`src/domain/reportLogic.ts`)

- Japanese truck operation regulations (2024 amendment)
- Limits: 13h max driving, 9h daily, 8h minimum rest
- Segment-based KPI tracking with compliance alerts

---

## After Implementing Changes

Per `AGENTS.md`, after completing any implementation:

1. Run `npm run typecheck` to confirm no type errors.
2. Run `npm run build` to confirm the build succeeds.
3. Commit with a clear, descriptive message.
4. Update GitHub and Notion if documentation-level changes were made.

---

## Related Files

- `AGENTS.md` — Local agent operational rules (Japanese)
- `docs/ANDROID.md` — Android-specific build notes
- `docs/SYNC.md` — GitHub ↔ Notion sync setup
- `skills/tracklog-release-notion/SKILL.md` — Release automation skill
