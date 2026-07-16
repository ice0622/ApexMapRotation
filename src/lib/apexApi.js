// Apex Legends Status API クライアント。
//
// APIキーは URL のクエリに含まれるため、エラーメッセージや例外オブジェクトに
// URL を含めない（＝キーを絶対にログへ出さない）ことをこのモジュールで保証する。

const API_ORIGIN = 'https://api.mozambiquehe.re';
const HTTP_TIMEOUT_MS = 10_000;
// User-Agent が無いと Cloudflare 側で 406 を返すため明示する。
const USER_AGENT = 'ApexMapRotation (+https://github.com/ice0622/ApexMapRotation)';

// API へ GET し、パース済み JSON を返す。失敗時はキーを含まないメッセージで throw。
async function apiGet(path, params, apiKey) {
  const url = new URL(path, API_ORIGIN);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set('auth', apiKey);

  let res;
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
function timerStringToMinutes(timer) {
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

// ランクマップのローテーション情報 { map, nextMap, remainingMins } を返す。
export async function fetchRankedMap(apiKey) {
  const data = await apiGet('/maprotation', { version: '2' }, apiKey);

  const ranked = data?.ranked ?? {};
  const map = ranked.current?.map;
  if (typeof map !== 'string' || map.length === 0) {
    throw new Error('map API response missing ranked.current.map');
  }
  const nextMap = typeof ranked.next?.map === 'string' && ranked.next.map.length > 0
    ? ranked.next.map
    : null;
  const remainingMins = typeof ranked.current?.remainingMins === 'number'
    ? ranked.current.remainingMins
    : timerStringToMinutes(ranked.current?.remainingTimer);

  return { map, nextMap, remainingMins };
}
