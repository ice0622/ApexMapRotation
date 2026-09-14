// Apex Legends Status API クライアント。
//
// APIキーは URL のクエリに含まれるため、エラーメッセージや例外オブジェクトに
// URL を含めない（＝キーを絶対にログへ出さない）ことをこのモジュールで保証する。

const API_ORIGIN = 'https://api.mozambiquehe.re';
const HTTP_TIMEOUT_MS = 10_000;
// User-Agent が無いと Cloudflare 側で 406 を返すため明示する。
const USER_AGENT = 'ApexMapRotation (+https://github.com/ice0622/ApexMapRotation)';

// ローテーションの1枠。start/end は UNIX ミリ秒の絶対時刻。
// 1日分のスケジュールを組むには「残り時間」のような相対値では足りないので、
// このモジュールで絶対時刻へ正規化してから外へ渡す。
export type RotationSlot = {
  map: string;
  startMs: number;
  endMs: number;
};

// API が返すのは「今の枠」と「次の枠」の2つだけ。
// 1日分（4.5時間枠なら6〜7枠）はこの2枠を起点に rotation.ts で外挿する。
export type RankedRotation = {
  current: RotationSlot;
  next: RotationSlot | null;
};

// /maprotation レスポンスの想定形。実際の値は実行時に検証するため全て unknown で受ける。
type SlotResponse = {
  start?: unknown; // UNIX 秒
  end?: unknown; // UNIX 秒
  map?: unknown;
  DurationInMinutes?: unknown;
  remainingMins?: unknown;
  remainingTimer?: unknown;
};

type MapRotationResponse = {
  ranked?: {
    current?: SlotResponse;
    next?: SlotResponse;
  };
};

// API へ GET し、パース済み JSON を返す。失敗時はキーを含まないメッセージで throw。
async function apiGet(
  path: string,
  params: Record<string, string>,
  apiKey: string,
): Promise<unknown> {
  const url = new URL(path, API_ORIGIN);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set('auth', apiKey);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, */*' },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    // fetch のエラーオブジェクトは URL（＝キー）を含み得るので中身は出さない。
    throw new Error(`API ${path} request failed (network/timeout)`);
  }
  if (!res.ok) {
    // 本文にキーは含まれない（キーはURLのクエリのみ）。原因特定のため先頭のみ出す。
    const body = await res.text().catch(() => '');
    throw new Error(`API ${path} returned HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  try {
    return await res.json();
  } catch {
    throw new Error(`API ${path} returned malformed JSON`);
  }
}

// "01:23:45" -> 83（分）。分に満たない端数は切り捨て。
function timerStringToMinutes(timer: unknown): number | null {
  if (typeof timer !== 'string') return null;
  const parts = timer.split(':').map((n) => Number.parseInt(n, 10));
  if (parts.some(Number.isNaN)) return null;
  let seconds = 0;
  if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
  else if (parts.length === 1) seconds = parts[0];
  else return null;
  return Math.floor(seconds / 60);
}

// 正の有限数だけを通す。API は欠損を 0 や null で返すことがあるため 0 も弾く。
function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

// 枠1つ分を絶対時刻へ正規化する。
// start / end / DurationInMinutes は欠けることがあるので、揃っている情報から
// 残りを逆算する。それでも決まらなければ null を返し、呼び出し側に判断を委ねる。
function parseSlot(
  raw: SlotResponse | undefined,
  fallback: { startMs?: number | null; endMs?: number | null },
): RotationSlot | null {
  if (!raw) return null;
  const map = typeof raw.map === 'string' && raw.map.length > 0 ? raw.map : null;
  if (map === null) return null;

  const durationMins = positiveNumber(raw.DurationInMinutes);
  const durationMs = durationMins === null ? null : durationMins * 60_000;
  const startSec = positiveNumber(raw.start);
  const endSec = positiveNumber(raw.end);

  let startMs = startSec === null ? (fallback.startMs ?? null) : startSec * 1000;
  let endMs = endSec === null ? (fallback.endMs ?? null) : endSec * 1000;

  if (startMs === null && endMs !== null && durationMs !== null) startMs = endMs - durationMs;
  if (endMs === null && startMs !== null && durationMs !== null) endMs = startMs + durationMs;
  if (startMs === null || endMs === null || endMs <= startMs) return null;

  return { map, startMs, endMs };
}

// ランクマップの「今の枠」と「次の枠」を絶対時刻付きで返す。
export async function fetchRankedRotation(apiKey: string): Promise<RankedRotation> {
  const data = (await apiGet('/maprotation', { version: '2' }, apiKey)) as MapRotationResponse;
  const ranked = data?.ranked ?? {};

  // current は end が欠けていても「今 + 残り時間」で復元できる。
  const remainingMins =
    positiveNumber(ranked.current?.remainingMins) ??
    timerStringToMinutes(ranked.current?.remainingTimer);
  const current = parseSlot(ranked.current, {
    endMs: remainingMins === null ? null : Date.now() + remainingMins * 60_000,
  });
  if (current === null) {
    throw new Error('map API response missing usable ranked.current (map / start / end)');
  }

  // next は start が欠けていても current の終わりに連結しているとみなせる。
  const next = parseSlot(ranked.next, { startMs: current.endMs });

  return { current, next };
}
