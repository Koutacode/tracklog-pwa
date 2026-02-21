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

function normalizeVoiceText(raw: string): string {
  const converted = toHalfWidthDigits(raw)
    .trim()
    .replace(/[。．\.、,！!？?\s　:：]/g, '');
  return converted.toLowerCase();
}

function parseOdoKm(digits: string | undefined): number | undefined {
  if (!digits) return undefined;
  const n = Number(digits);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n);
}

function pickLongest(matches: string[] | null): string | undefined {
  if (!matches || matches.length === 0) return undefined;
  return matches.reduce((best, cur) => (cur.length > best.length ? cur : best), matches[0]);
}

function extractAsciiDigits(text: string): string | undefined {
  const match = text.match(/(\d{1,7}(?:\.\d+)?)/);
  if (!match) return undefined;
  return match[1];
}

function extractKanjiDigits(text: string): string | undefined {
  const longest = pickLongest(text.match(/[〇零一二三四五六七八九]{2,7}/g));
  if (!longest) return undefined;
  return longest
    .split('')
    .map(ch => KANJI_DIGIT_MAP[ch] ?? '')
    .join('');
}

function extractSpokenDigits(text: string): string | undefined {
  const hira = katakanaToHiragana(text).replace(/[^ぁ-ん]/g, '');
  if (!hira) return undefined;
  let best = '';
  for (let start = 0; start < hira.length; start++) {
    let cursor = start;
    let digits = '';
    while (cursor < hira.length && digits.length < 7) {
      let matched = false;
      for (const [pattern, digit] of SPOKEN_DIGIT_PATTERNS) {
        if (!hira.startsWith(pattern, cursor)) continue;
        digits += digit;
        cursor += pattern.length;
        matched = true;
        break;
      }
      if (!matched) break;
      if (digits.length > best.length) {
        best = digits;
      }
    }
  }
  return best.length >= 2 ? best : undefined;
}

function extractOdoKm(text: string): number | undefined {
  const normalized = toHalfWidthDigits(text);
  const asciiDigits = extractAsciiDigits(normalized);
  if (asciiDigits) return parseOdoKm(asciiDigits);
  const kanjiDigits = extractKanjiDigits(normalized);
  if (kanjiDigits) return parseOdoKm(kanjiDigits);
  const spokenDigits = extractSpokenDigits(normalized);
  if (spokenDigits) return parseOdoKm(spokenDigits);
  return undefined;
}

function extractOdoKmAfterKeywords(text: string, keywords: string[]): number | undefined {
  for (const keyword of keywords) {
    const idx = text.indexOf(keyword);
    if (idx < 0) continue;
    const tail = text.slice(idx + keyword.length);
    const parsed = extractOdoKm(tail);
    if (parsed != null) return parsed;
  }
  return extractOdoKm(text);
}

function includesAny(text: string, patterns: string[]) {
  return patterns.some(p => text.includes(p));
}

export function parseVoiceCommand(raw: string): VoiceCommand | null {
  const text = normalizeVoiceText(raw);
  if (!text) return null;

  if (includesAny(text, ['現在地更新', '位置情報更新', '現在地', '位置更新'])) {
    return { kind: 'geo_refresh', raw };
  }
  if (includesAny(text, ['高速継続', '高速道路継続', 'まだ高速中', '継続'])) {
    return { kind: 'expressway_keep', raw };
  }
  if (includesAny(text, ['高速道路終了', '高速終了'])) {
    return { kind: 'expressway_end', raw };
  }
  if (includesAny(text, ['高速道路開始', '高速開始'])) {
    return { kind: 'expressway_start', raw };
  }
  if (includesAny(text, ['積込開始', '積み込み開始', 'つみこみ開始'])) {
    return { kind: 'load_start', raw };
  }
  if (includesAny(text, ['積込終了', '積み込み終了', 'つみこみ終了'])) {
    return { kind: 'load_end', raw };
  }
  if (includesAny(text, ['荷卸開始', '荷下ろし開始', 'におろし開始'])) {
    return { kind: 'unload_start', raw };
  }
  if (includesAny(text, ['荷卸終了', '荷下ろし終了', 'におろし終了'])) {
    return { kind: 'unload_end', raw };
  }
  if (includesAny(text, ['休憩開始'])) {
    return { kind: 'break_start', raw };
  }
  if (includesAny(text, ['休憩終了'])) {
    return { kind: 'break_end', raw };
  }
  if (includesAny(text, ['休息終了'])) {
    return { kind: 'rest_end', raw };
  }
  if (includesAny(text, ['休息開始'])) {
    const odoKm = extractOdoKmAfterKeywords(text, ['休息開始']);
    return { kind: 'rest_start', raw, odoKm };
  }
  if (includesAny(text, ['運行終了'])) {
    const odoKm = extractOdoKmAfterKeywords(text, ['運行終了']);
    return { kind: 'trip_end', raw, odoKm };
  }
  if (includesAny(text, ['運行開始', '出発'])) {
    const odoKm = extractOdoKmAfterKeywords(text, ['運行開始', '出発']);
    return { kind: 'trip_start', raw, odoKm };
  }
  if (includesAny(text, ['乗船'])) {
    return { kind: 'boarding', raw };
  }
  if (includesAny(text, ['地点マーク', '地点記録', 'ポイントマーク'])) {
    return { kind: 'point_mark', raw };
  }
  return null;
}

export function findVoiceCommand(matches: string[]): VoiceCommand | null {
  for (const candidate of matches) {
    const parsed = parseVoiceCommand(candidate);
    if (parsed) return parsed;
  }
  return null;
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
