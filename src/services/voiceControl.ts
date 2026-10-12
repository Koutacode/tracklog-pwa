import { Capacitor } from '@capacitor/core';
import { SpeechRecognition } from '@capacitor-community/speech-recognition';

export type VoiceCommandKind =
  | 'trip_start'
  | 'trip_end'
  | 'rest_start'
  | 'rest_end'
  | 'break_start'
  | 'break_end'
  | 'load_start'
  | 'load_end'
  | 'unload_start'
  | 'unload_end'
  | 'expressway_start'
  | 'expressway_end'
  | 'expressway_keep'
  | 'boarding'
  | 'disembark'
  | 'point_mark'
  | 'geo_refresh';

export type VoiceCommand = {
  kind: VoiceCommandKind;
  raw: string;
  odoKm?: number;
};

const ZENKAKU_DIGITS = '０１２３４５６７８９';
const HANKAKU_DIGITS = '0123456789';
const KANJI_DIGIT_MAP: Record<string, string> = {
  '〇': '0',
  '零': '0',
  '一': '1',
  '二': '2',
  '三': '3',
  '四': '4',
  '五': '5',
  '六': '6',
  '七': '7',
  '八': '8',
  '九': '9',
};
const SPOKEN_DIGIT_PATTERNS: Array<[pattern: string, digit: string]> = [
  ['きゅう', '9'],
  ['しち', '7'],
  ['ぜろ', '0'],
  ['れい', '0'],
  ['まる', '0'],
  ['いち', '1'],
  ['さん', '3'],
  ['よん', '4'],
  ['ろく', '6'],
  ['なな', '7'],
  ['はち', '8'],
  ['に', '2'],
  ['し', '4'],
  ['ご', '5'],
  ['く', '9'],
];

function toHalfWidthDigits(text: string): string {
  return text.replace(/[０-９]/g, ch => HANKAKU_DIGITS[ZENKAKU_DIGITS.indexOf(ch)] ?? ch);
}

function katakanaToHiragana(text: string): string {
  return text.replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

// Only explicitly supported affirmative sentences are commands. Keep separators
// intact so distinct numbers, decimal points and later clauses cannot be joined.
function normalizeVoiceText(raw: string): string | null {
  if (/[\r\n\u2028\u2029]/u.test(raw)) return null;
  const text = toHalfWidthDigits(raw).trim().toLowerCase();
  if (!text) return null;
  return text
    .replace(/[。！!]$/u, '')
    .trim()
    .replace(/(?:してください|して下さい|お願いします|します|です)$/u, '')
    .trim();
}

const COMMAND_ALIASES: ReadonlyArray<{
  kind: VoiceCommandKind;
  aliases: readonly string[];
  acceptsOdo?: boolean;
}> = [
  { kind: 'geo_refresh', aliases: ['現在地更新', '位置情報更新', '現在地', '位置更新'] },
  { kind: 'expressway_keep', aliases: ['高速継続', '高速道路継続', 'まだ高速中', '継続'] },
  { kind: 'expressway_end', aliases: ['高速道路終了', '高速終了'] },
  { kind: 'expressway_start', aliases: ['高速道路開始', '高速開始'] },
  { kind: 'load_start', aliases: ['積込開始', '積み込み開始', 'つみこみ開始'] },
  { kind: 'load_end', aliases: ['積込終了', '積み込み終了', 'つみこみ終了'] },
  { kind: 'unload_start', aliases: ['荷卸開始', '荷卸し開始', '荷降ろし開始', '荷下ろし開始', '荷おろし開始', 'におろし開始'] },
  { kind: 'unload_end', aliases: ['荷卸終了', '荷卸し終了', '荷降ろし終了', '荷下ろし終了', '荷おろし終了', 'におろし終了'] },
  { kind: 'break_start', aliases: ['休憩開始'] },
  { kind: 'break_end', aliases: ['休憩終了'] },
  { kind: 'rest_end', aliases: ['休息終了'] },
  { kind: 'rest_start', aliases: ['休息開始'], acceptsOdo: true },
  { kind: 'trip_end', aliases: ['運行終了'], acceptsOdo: true },
  { kind: 'trip_start', aliases: ['運行開始', '出発'], acceptsOdo: true },
  { kind: 'disembark', aliases: ['フェリー下船', '下船'] },
  { kind: 'boarding', aliases: ['乗船', 'フェリー乗船'] },
  { kind: 'point_mark', aliases: ['地点マーク', '地点記録', 'ポイントマーク'] },
];

function parseSpokenDigitSequence(text: string): string | null {
  const hiragana = katakanaToHiragana(text);
  let cursor = 0;
  let digits = '';
  while (cursor < hiragana.length) {
    const token = SPOKEN_DIGIT_PATTERNS.find(([word]) => hiragana.startsWith(word, cursor));
    if (!token) return null;
    digits += token[1];
    if (digits.length > 7) return null;
    cursor += token[0].length;
    while (hiragana[cursor] === ' ' || hiragana[cursor] === '　') cursor++;
  }
  return digits.length >= 2 ? digits : null;
}

function parseWholeOdo(text: string): number | null {
  const value = text
    .replace(/^(?:オドメーター|オド|odo|メーター)[ 　]*(?:は|[:：])?[ 　]*/u, '')
    .replace(/[ 　]*(?:km|キロメートル|キロ)$/u, '')
    .trim();
  let digits: string | null = null;
  if (/^[0-9]{1,7}$/u.test(value)) {
    digits = value;
  } else if (/^[〇零一二三四五六七八九]{2,7}$/u.test(value)) {
    digits = [...value].map(character => KANJI_DIGIT_MAP[character]).join('');
  } else {
    digits = parseSpokenDigitSequence(value);
  }
  if (digits == null) return null;
  const odoKm = Number(digits);
  return Number.isSafeInteger(odoKm) && odoKm > 0 ? odoKm : null;
}

export function parseVoiceCommand(raw: string): VoiceCommand | null {
  const text = normalizeVoiceText(raw);
  if (!text) return null;
  for (const command of COMMAND_ALIASES) {
    for (const alias of command.aliases) {
      if (text === alias) return { kind: command.kind, raw };
      if (!command.acceptsOdo) continue;
      // A command must be at the beginning, with the entire remainder being one
      // valid ODO expression. An invalid ODO must never become a missing ODO.
      const match = text.match(new RegExp(`^${alias}([\\s\\S]+)$`, 'u'));
      if (!match) continue;
      const odoKm = parseWholeOdo(match[1].trim());
      if (odoKm != null) return { kind: command.kind, raw, odoKm };
    }
  }
  return null;
}

export function findVoiceCommand(matches: string[]): VoiceCommand | null {
  if (matches.length === 0) return null;
  const first = parseVoiceCommand(matches[0]);
  if (!first) return null;
  for (const candidate of matches.slice(1)) {
    const parsed = parseVoiceCommand(candidate);
    if (!parsed || parsed.kind !== first.kind || parsed.odoKm !== first.odoKm) return null;
  }
  return first;
}

export async function checkVoiceRecognitionAvailable(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const available = await SpeechRecognition.available();
    return !!available.available;
  } catch {
    return false;
  }
}

async function ensureVoicePermission(): Promise<boolean> {
  const current = await SpeechRecognition.checkPermissions();
  if (current.speechRecognition === 'granted') return true;
  if (current.speechRecognition === 'denied') return false;
  const requested = await SpeechRecognition.requestPermissions();
  return requested.speechRecognition === 'granted';
}

export async function listenVoiceCommandJa(): Promise<string[]> {
  const available = await checkVoiceRecognitionAvailable();
  if (!available) throw new Error('この端末では音声認識を利用できません。');
  const granted = await ensureVoicePermission();
  if (!granted) throw new Error('音声認識の権限が拒否されています。');
  try {
    const listening = await SpeechRecognition.isListening();
    if (listening.listening) {
      await SpeechRecognition.stop();
    }
  } catch {
    // ignore state check failures
  }
  const result = await SpeechRecognition.start({
    language: 'ja-JP',
    maxResults: 5,
    partialResults: false,
    popup: true,
    prompt: 'コマンドを話してください',
  });
  const matches = Array.isArray(result.matches) ? result.matches : [];
  return matches.map(m => String(m).trim()).filter(Boolean);
}
