import { TRACKLOG_EVENTS_CHANGED_EVENT } from '../../../services/localEventsChanged';

type EventSubscriptionTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export function subscribeHomeEventsChanged(
  refresh: () => void | Promise<void>,
  target: EventSubscriptionTarget = window,
) {
  const handleEventsChanged = () => {
    void refresh();
  };
  target.addEventListener(TRACKLOG_EVENTS_CHANGED_EVENT, handleEventsChanged);
  return () => {
    target.removeEventListener(TRACKLOG_EVENTS_CHANGED_EVENT, handleEventsChanged);
  };
}
