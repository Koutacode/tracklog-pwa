export const DAY_MS = 24 * 60 * 60 * 1000;

const jstDateFormatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export type JstDateInfo = {
  dateKey: string;
  dateLabel: string;
  dayStamp: number;
};

export function getJstDateInfo(ts: string): JstDateInfo {
  const parts = jstDateFormatter.formatToParts(new Date(ts));
  const lookup = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  const year = lookup('year');
  const month = lookup('month');
  const day = lookup('day');
  const yearNum = Number(year);
  const monthNum = Number(month);
  const dayNum = Number(day);
  const dayStamp = Date.UTC(yearNum, monthNum - 1, dayNum);
  return {
    dateKey: `${year}-${month}-${day}`,
    dateLabel: `${year}/${month}/${day}`,
    dayStamp,
  };
}
