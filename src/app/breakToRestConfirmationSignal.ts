export {
  TRACKLOG_EVENTS_CHANGED_EVENT,
  notifyTrackLogEventsChanged,
} from '../services/localEventsChanged';
export const BREAK_TO_REST_MODAL_STATE_EVENT = 'tracklog-break-to-rest-modal-state';

let breakToRestModalOpen = false;

export function isBreakToRestModalOpen() {
  return breakToRestModalOpen;
}

export function notifyBreakToRestModalState(open: boolean) {
  breakToRestModalOpen = open;
  window.dispatchEvent(new CustomEvent(BREAK_TO_REST_MODAL_STATE_EVENT, {
    detail: { open },
  }));
}
