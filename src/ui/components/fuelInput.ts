export type FuelInputResult =
  | { ok: true; liters: number }
  | { ok: false; error: string };

export function parseFuelInput(raw: string): FuelInputResult {
  const normalized = raw.replace(/[０-９．]/g, character =>
    character === '．' ? '.' : String.fromCharCode(character.charCodeAt(0) - 0xfee0),
  );
  if (normalized === '') return { ok: false, error: '給油量を入力してください。' };
  if (/[,，、]/.test(normalized)) {
    return { ok: false, error: 'カンマは使えません。小数点「.」で入力してください（例：25.5）。' };
  }
  if (/[-−－]/.test(normalized)) {
    return { ok: false, error: '給油量は0より大きい数値で入力してください。' };
  }
  if ((normalized.match(/\./g) ?? []).length > 1) {
    return { ok: false, error: '小数点は1つだけ入力してください（例：25.5）。' };
  }
  if (normalized.trim() !== normalized || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) {
    return { ok: false, error: '数字と小数点だけで入力してください。単位や空白は不要です（例：25.5）。' };
  }
  const liters = Number(normalized);
  if (!Number.isFinite(liters)) {
    return { ok: false, error: '給油量が大きすぎます。入力した桁数を確認してください。' };
  }
  if (liters <= 0) {
    return { ok: false, error: '給油量は0より大きい数値で入力してください。' };
  }
  return { ok: true, liters };
}
