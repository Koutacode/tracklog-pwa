function tryParseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function extractJsonCandidate(text: string): string | null {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }

  const firstObject = text.indexOf('{');
  const lastObject = text.lastIndexOf('}');
  if (firstObject >= 0 && lastObject > firstObject) {
    return text.slice(firstObject, lastObject + 1).trim();
  }

  return null;
}

function looksLikeSharedTracklogText(text: string): boolean {
  return text.includes('運行履歴データ')
    || (text.includes('"tripId"') && text.includes('"summary"'))
    || (text.includes('"timeline"') && text.includes('"segments"'));
}

function hasUnbalancedJsonDelimiters(text: string): boolean {
  let braces = 0;
  let brackets = 0;
  let inString = false;
  let escaped = false;

  for (const ch of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      braces += 1;
      continue;
    }
    if (ch === '}') {
      braces -= 1;
      continue;
    }
    if (ch === '[') {
      brackets += 1;
      continue;
    }
    if (ch === ']') {
      brackets -= 1;
    }
  }

  return inString || braces > 0 || brackets > 0;
}

export function parseJsonInput<T>(input: string, errorMessage: string): T {
  const trimmed = input.trim();
  const direct = tryParseJson<T>(trimmed);
  if (direct !== null) return direct;

  const candidate = extractJsonCandidate(trimmed);
  if (candidate) {
    const extracted = tryParseJson<T>(candidate);
    if (extracted !== null) return extracted;
  }

  if (looksLikeSharedTracklogText(trimmed) && hasUnbalancedJsonDelimiters(candidate ?? trimmed)) {
    throw new Error('共有テキストが途中で切れています。最新版のアプリで再共有して貼り付けてください');
  }

  throw new Error(errorMessage);
}
