const AI_SHARE_CHUNK_BODY_CHAR_LIMIT = 5_500;

export type AiShareChunk = {
  index: number;
  total: number;
  text: string;
};

export function buildAiShareText(payload: { tripId?: string }) {
  const json = JSON.stringify(payload);
  const tripId = payload.tripId?.trim() || 'unknown';
  return [
    '運行履歴データ:',
    json,
    `TrackLogデータ終端:${tripId}:${json.length}`,
  ].join('\n');
}

export function splitAiShareText(
  text: string,
  bodyCharLimit = AI_SHARE_CHUNK_BODY_CHAR_LIMIT,
): AiShareChunk[] {
  if (!Number.isFinite(bodyCharLimit) || bodyCharLimit < 500) {
    throw new Error('分割文字数が不正です');
  }

  const characters = Array.from(text);
  if (characters.length <= bodyCharLimit) {
    return [{ index: 1, total: 1, text }];
  }

  const bodies: string[] = [];
  for (let offset = 0; offset < characters.length; offset += bodyCharLimit) {
    bodies.push(characters.slice(offset, offset + bodyCharLimit).join(''));
  }

  const total = bodies.length;
  return bodies.map((body, offset) => {
    const index = offset + 1;
    return {
      index,
      total,
      text: [
        `TrackLog運行履歴データ 分割 ${index}/${total}`,
        `全${total}通です。番号順に同じ会話へ貼り付けてください。`,
        body,
        `TrackLog分割終端:${index}/${total}`,
      ].join('\n'),
    };
  });
}
