import assert from 'node:assert/strict';
import { findVoiceCommand, parseVoiceCommand, type VoiceCommandKind } from './voiceControl';

let assertions = 0;
const aliases: Array<[VoiceCommandKind, string[]]> = [
  ['trip_start', ['運行開始', '出発']],
  ['trip_end', ['運行終了']],
  ['rest_start', ['休息開始']],
  ['rest_end', ['休息終了']],
  ['break_start', ['休憩開始']],
  ['break_end', ['休憩終了']],
  ['load_start', ['積込開始', '積み込み開始', 'つみこみ開始']],
  ['load_end', ['積込終了', '積み込み終了', 'つみこみ終了']],
  ['unload_start', ['荷卸開始', '荷卸し開始', '荷降ろし開始', '荷下ろし開始', '荷おろし開始', 'におろし開始']],
  ['unload_end', ['荷卸終了', '荷卸し終了', '荷降ろし終了', '荷下ろし終了', '荷おろし終了', 'におろし終了']],
  ['expressway_start', ['高速開始', '高速道路開始']],
  ['expressway_end', ['高速終了', '高速道路終了']],
  ['expressway_keep', ['高速継続', '高速道路継続', 'まだ高速中', '継続']],
  ['boarding', ['乗船', 'フェリー乗船']],
  ['disembark', ['下船', 'フェリー下船']],
  ['point_mark', ['地点マーク', '地点記録', 'ポイントマーク']],
  ['geo_refresh', ['現在地更新', '位置情報更新', '現在地', '位置更新']],
];

function accept(raw: string, kind: VoiceCommandKind, odoKm?: number) {
  assert.deepEqual(parseVoiceCommand(raw), { kind, raw, ...(odoKm == null ? {} : { odoKm }) }, raw);
  assertions++;
}

function reject(raw: string) {
  assert.equal(parseVoiceCommand(raw), null, `must reject the entire sentence: ${raw}`);
  assertions++;
}

for (const [kind, names] of aliases) {
  for (const name of names) accept(name, kind);
  for (const suffix of ['してください', 'して下さい', 'お願いします', 'します', 'です']) {
    accept(`　${names[0]} ${suffix}。 `, kind);
  }
}

for (const [raw, odoKm] of [
  ['123456', 123456], ['１２３４５６', 123456], ['１２3４５6', 123456],
  ['一二三四五六', 123456], ['いちにさんよんごろく', 123456],
  ['イチ ニ サン ヨン ゴ ロク', 123456], ['いち　に　さん　よん　ご　ろく', 123456],
  ['一〇二零三四', 102034], ['いちぜろにれいさんよん', 102034],
  ['いちまるにしごく', 102459], ['イチシチハチキュウ', 1789],
  ['1234567', 1234567], ['0000123', 123],
] as const) {
  for (const [name, kind] of [['運行開始', 'trip_start'], ['出発', 'trip_start'], ['運行終了', 'trip_end'], ['休息開始', 'rest_start']] as const) {
    accept(`${name} ${raw}`, kind, odoKm);
  }
}
accept('運行終了 オド123456', 'trip_end', 123456);
accept('運行終了 ODO：１２３４５６', 'trip_end', 123456);
accept('運行終了 オドメーターは123456キロです。', 'trip_end', 123456);
accept('運行開始 メーター123456 km', 'trip_start', 123456);
accept('休息開始 オド123456キロメートル', 'rest_start', 123456);
accept('フェリー乗船してください', 'boarding');

for (const raw of [
  '', ' ', '　', '音声を認識できませんでした', 'やめて', '中止', 'キャンセル',
  '積込開始しないで', '運行終了しない123456', '終了じゃなくて開始', 'まだ終了しない',
  '運行終了じゃなくて運行開始123456', '運行終了123456じゃなく123457',
  '運行終了 オド12万3456', '運行終了12万3456', '運行終了 十二万三千四百五十六',
  '運行終了123456 休憩開始', '積込開始と荷卸し開始', '積込開始、荷卸し開始',
  '運行終了。運行開始123456', '運行終了123456\nやめて', '運行終了123456\n',
  '運行終了123456かも', '運行終了123456かな', '運行終了123456？',
  '運行終了123456?', '運行終了123456しますか', '運行終了123456でした',
  '123456運行終了', '運行終了を記録しないで', '「運行終了123456」と言わないで',
  '地点マークしないで', '運行を終了しないで', '休憩開始ではなく積込開始',
  '高速終了しません', '高速継続しない', '荷下ろし開始しないでください',
  '積込開始お願いしますがやめて', '積込開始のやり方を教えて',
  '運行終了123456します。やめて', '運行終了 オド',
  'フェリー乗船しないで', 'フェリー乗船しません', 'フェリー乗船かも',
  'フェリー乗船やめて', 'フェリー乗船じゃなくて下船',
]) reject(raw);

for (const [, names] of aliases) {
  for (const suffix of [
    'しない', 'しないで', 'しません', 'しないでください', 'ではない', 'じゃない',
    'じゃなくて運行開始', 'かもしれない', 'かな', 'したくない', 'する予定', 'するなら',
    'やめて', '中止', 'キャンセル', 'しなくてもいい', 'はしないです', 'したらだめ',
  ]) reject(`${names[0]}${suffix}`);
}

for (const first of aliases) {
  for (const second of aliases) {
    if (first[0] !== second[0]) reject(`${first[1][0]} ${second[1][0]}`);
  }
}

for (const number of [
  '12万3456', '１２万３４５６', '1.2.3', '１．２．３', '123456 123457',
  '12 3456', '1 2 3', '一二 三四', 'いち、に、さん', '123,456', '１２３，４５６',
  '-123456', '－１２３４５６', '+123456', '123456.7', '１２３４５６．７',
  '12345678', '一二三四五六七八', 'いちにさんよんごろくななはち',
  '123e3', '0x123', '0', '０００', 'Infinity', 'NaN', 'abc123456',
  '123456abc', 'いちにさんですよね', '123456/123457', '123456と123457',
]) {
  for (const name of ['運行開始', '運行終了', '休息開始']) reject(`${name} ${number}`);
}

for (const candidates of [
  [], [''], [' ', '運行終了123456'], ['聞き取れない', '運行終了123456'],
  ['運行終了123456', '聞き取れない'], ['運行終了しない123456', '運行終了123456'],
  ['運行終了123456', '運行終了しない123456'], ['運行終了123456', '運行開始123456'],
  ['運行終了123456', '運行終了123457'], ['運行終了', '運行終了123456'],
  ['運行終了123456', '運行終了'], ['運行終了123456', '運行終了12万3456'],
  ['積込開始', '荷卸し開始'], ['積込開始', '積込開始かも'],
  ['フェリー乗船', '下船'], ['フェリー乗船', 'フェリー乗船しないで'],
]) {
  assert.equal(findVoiceCommand(candidates), null, `all alternatives must agree: ${JSON.stringify(candidates)}`);
  assertions++;
}

for (const candidates of [
  ['運行終了 オド123456', '運行終了１２３４５６', '運行終了一二三四五六'],
  ['荷卸し開始', '荷降ろし開始', '荷下ろし開始', '荷おろし開始'],
  ['運行開始123456', '出発123456'], ['積込開始', '積み込み開始してください'],
  ['休憩開始'],
  ['フェリー乗船', '乗船してください'],
]) {
  assert.deepEqual(findVoiceCommand(candidates), parseVoiceCommand(candidates[0]), 'preserve the first transcript after semantic agreement');
  assertions++;
}

console.log(`voiceControl: ${assertions} affirmative, denial, correction, ODO and candidate-consensus cases passed`);
