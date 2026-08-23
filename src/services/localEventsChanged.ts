export const TRACKLOG_EVENTS_CHANGED_EVENT = 'tracklog-events-changed';

/**
 * Notify mounted local views that event rows changed in Dexie.
 * The event deliberately carries no coordinates, names, or authentication data.
 */
export function notifyTrackLogEventsChanged() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(TRACKLOG_EVENTS_CHANGED_EVENT));
}
