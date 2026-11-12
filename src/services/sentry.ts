import type { BrowserOptions, Breadcrumb, ErrorEvent, EventHint } from '@sentry/browser';
import type { Integration, Log, Metric, TransactionEvent } from '@sentry/core';
import { breadcrumbsIntegration, init as initSentryBrowser } from '@sentry/browser';
import { APP_VERSION } from '../app/version';
import { scrubSentryBreadcrumb, scrubSentryEvent } from './sentryPrivacy';

// @sentry/capacitor の sentry-android は使わない。
// プラグインの initNativeSdk は、位置情報を消さない独自の beforeSend をネイティブへ設定する。
// JS の beforeSend / beforeBreadcrumb は、ネイティブのクラッシュや ANR には届かない。
// 同じ消し方をネイティブの送信にかけられないため、送るのは @sentry/browser だけにする。

const BLOCKED_INTEGRATION_NAMES = new Set([
  'Replay',
  'BrowserTracing',
  'BrowserProfiling',
  'BrowserSession',
  'HttpContext',
  'WebVitals',
  'FetchStreamPerformance',
]);

export const TRACKLOG_DISABLED_BREADCRUMB_SOURCES = {
  console: false,
  dom: false,
  fetch: false,
  history: false,
  sentry: false,
  xhr: false,
} as const;

export function selectTracklogSentryIntegrations(defaults: Integration[]): Integration[] {
  return defaults.flatMap(integration => {
    if (BLOCKED_INTEGRATION_NAMES.has(integration.name)) return [];
    if (integration.name === 'Breadcrumbs') {
      return [breadcrumbsIntegration(TRACKLOG_DISABLED_BREADCRUMB_SOURCES)];
    }
    return [integration];
  });
}

export type TracklogSentryConfig = {
  dsn: string;
  release: string;
  environment: string;
};

function readEnvDsn(): string {
  try {
    const value = import.meta.env.VITE_SENTRY_DSN;
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
}

function readEnvironment(): string {
  try {
    const mode = import.meta.env.MODE;
    return typeof mode === 'string' && mode.trim() ? mode.trim() : 'production';
  } catch {
    return 'production';
  }
}

export function buildTracklogSentryOptions(config: TracklogSentryConfig): BrowserOptions {
  const dsn = config.dsn.trim();
  return {
    dsn,
    sendDefaultPii: false,
    sendClientReports: false,
    release: config.release,
    environment: config.environment,
    // この SDK は tracesSampleRate を書くと性能計測が有効になる。0 でも span の記録がオンになるため置かない。
    enableLogs: false,
    debug: false,
    profileSessionSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    enhanceFetchErrorMessages: false,
    tracePropagationTargets: [],
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      queryParams: false,
      urlQueryParams: false,
      stackFrameVariables: false,
      frameContextLines: 0,
      databaseQueryData: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
    },
    integrations: selectTracklogSentryIntegrations,
    beforeBreadcrumb(breadcrumb: Breadcrumb) {
      return scrubSentryBreadcrumb(breadcrumb);
    },
    beforeSend(event: ErrorEvent, hint: EventHint) {
      clearHintAttachments(hint);
      return scrubSentryEvent(event);
    },
    beforeSendTransaction(_event: TransactionEvent, _hint: EventHint) {
      return null;
    },
    beforeSendLog(_log: Log) {
      return null;
    },
    beforeSendMetric(_metric: Metric) {
      return null;
    },
  };
}

export function clearHintAttachments(hint: EventHint | undefined): void {
  if (!hint) return;
  try {
    hint.attachments = [];
  } catch {
    try {
      hint.attachments?.splice(0, hint.attachments.length);
    } catch {
      // 添付を空にできない場合でも、イベント本文の位置情報は消したまま送る。
    }
  }
}

export type TracklogSentryInitDeps = {
  dsn?: string | null;
  release?: string;
  environment?: string;
  init?: (options: BrowserOptions) => void;
};

let started = false;

export function initTracklogSentry(deps?: TracklogSentryInitDeps): boolean {
  const dsnProvided = !!deps && Object.prototype.hasOwnProperty.call(deps, 'dsn');
  const dsn = dsnProvided ? (deps?.dsn ?? '').trim() : readEnvDsn();
  if (!dsn) return false;

  const options = buildTracklogSentryOptions({
    dsn,
    release: deps?.release?.trim() || `tracklog-assist@${APP_VERSION}`,
    environment: deps?.environment?.trim() || readEnvironment(),
  });
  const init = deps?.init ?? initSentryBrowser;
  if (!deps?.init) {
    if (started) return true;
    started = true;
  }
  try {
    init(options);
    return true;
  } catch {
    if (!deps?.init) started = false;
    return false;
  }
}
