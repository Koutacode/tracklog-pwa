type RecordedEvent = { type: string; ts: string };

const timestampFormatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** Display only timestamps that were actually recorded, even without a GPS address. */
export function TripRecordedTimes({ events }: { events: readonly RecordedEvent[] }) {
  const valid = events.filter(event => Number.isFinite(Date.parse(event.ts)));
  const start = valid.filter(event => event.type === 'trip_start')
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))[0];
  const end = valid.filter(event => event.type === 'trip_end')
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];
  const entries = [
    ...(start ? [{ label: '運行開始', ts: start.ts }] : []),
    ...(end ? [{ label: '運行終了', ts: end.ts }] : []),
  ];
  if (entries.length === 0) return null;

  return (
    <dl className="trip-recorded-times" aria-label="記録した運行開始・終了時刻（日本時間）">
      {entries.map(entry => (
        <div key={entry.label}>
          <dt>{entry.label}</dt>
          <dd><time dateTime={entry.ts}>{timestampFormatter.format(new Date(entry.ts))}</time></dd>
        </div>
      ))}
    </dl>
  );
}
