// Apex Legends ランクマップ変更通知
//
// cron（check モード）: 現在マップが前回と変わったときだけ Discord に通知する。
// 手動（status モード）: 現在のマップ・次のマップ・残り時間をその場で Discord に出す。
//
// 依存パッケージは使わない（Node 24 のネイティブ fetch / AbortSignal.timeout を利用）。
// 機密（APIキー・Webhook URL）は絶対にログへ出力しない。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
// 通知の文面は messages.js に集約。文言を変えるときはそちらを編集する。
import { buildChangeMessage, buildStatusMessage } from './messages.js';

const STATE_PATH = fileURLToPath(new URL('../state/last_map.json', import.meta.url));
const API_BASE = 'https://api.mozambiquehe.re/maprotation';
const HTTP_TIMEOUT_MS = 10_000;

// モック時に使う仮想のローテーション。
const MOCK_ROTATION = ['E-District', "World's Edge", 'Storm Point', 'Broken Moon'];

// ---------------------------------------------------------------------------
// 設定・状態
// ---------------------------------------------------------------------------

function loadConfig() {
  const apiKey = (process.env.APEX_API_KEY ?? '').trim();
  const webhook = (process.env.DISCORD_WEBHOOK_URL ?? '').trim();
  const explicitMock = process.env.USE_MOCK === 'true';
  // API キーが未設定なら、明示指定が無くても自動でモックにフォールバックする。
  const useMock = explicitMock || apiKey === '';
  const mode = process.env.MODE === 'status' ? 'status' : 'check';
  return { apiKey, webhook, useMock, explicitMock, mode };
}

async function readState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_PATH, 'utf8'));
    // map が非空文字列のときだけ「前回値あり」とみなす。
    if (parsed && typeof parsed.map === 'string' && parsed.map.length > 0) return parsed;
    return null;
  } catch (err) {
    if (err.code === 'ENOENT') return null; // 初回実行
    console.warn(`state ファイルを読めませんでした（${err.message}）。初回扱いにします。`);
    return null; // 壊れたファイルは初回扱いで再シード（クラッシュさせない）
  }
}

async function writeState(map) {
  const state = { map, updatedAt: new Date().toISOString() };
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// マップ取得
// ---------------------------------------------------------------------------

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

function getMockMap(previousMap, explicitMock) {
  const rotation = MOCK_ROTATION;
  let idx;
  if (process.env.MOCK_MAP) {
    return {
      map: process.env.MOCK_MAP,
      nextMap: rotation[0],
      remainingMins: 83,
    };
  }
  if (explicitMock) {
    // 明示モック（テスト意図）: 前回の「次」を返す → 必ず変化が起き通知が発火する。
    const prevIdx = rotation.indexOf(previousMap);
    idx = (prevIdx + 1 + rotation.length) % rotation.length;
  } else {
    // 自動モック（キー未設定）: 固定値 → 初回シードのみで以降は静か。
    idx = 0;
  }
  return {
    map: rotation[idx],
    nextMap: rotation[(idx + 1) % rotation.length],
    remainingMins: 83,
  };
}

async function getCurrentMap(cfg, previousMap) {
  if (cfg.useMock) return getMockMap(previousMap, cfg.explicitMock);

  // 注意: この URL には APIキーが含まれる。絶対にログへ出さないこと。
  const url = `${API_BASE}?auth=${encodeURIComponent(cfg.apiKey)}&version=2`;
  let res;
  try {
    res = await fetch(url, {
      headers: {
        // User-Agent が無いと Cloudflare 側で 406 を返すため明示する。
        'User-Agent': 'ApexMapRotation (+https://github.com/ice0622/ApexMapRotation)',
        Accept: 'application/json, */*',
      },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    // fetch のエラーオブジェクトは URL（＝キー）を含み得るので中身は出さない。
    throw new Error('map API request failed (network/timeout)');
  }
  if (!res.ok) {
    // 本文にキーは含まれない（キーはURLのクエリのみ）。原因特定のため先頭のみ出す。
    const body = await res.text().catch(() => '');
    throw new Error(`map API returned HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('map API returned malformed JSON');
  }

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

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

async function sendDiscordNotification(webhook, content) {
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Discord webhook HTTP ${res.status} ${body.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------

async function main() {
  const cfg = loadConfig();
  console.log(
    `mode=${cfg.mode} / ${cfg.useMock ? `MOCK (explicit=${cfg.explicitMock})` : 'live API'}`,
  );

  const previousMap = (await readState())?.map ?? null;

  let current;
  try {
    current = await getCurrentMap(cfg, previousMap);
  } catch (err) {
    console.error(`マップ取得に失敗（スキップ）: ${err.message}`);
    // check は静かに緑のまま / status は手動操作なので失敗を可視化する。
    return cfg.mode === 'status' ? 1 : 0;
  }

  // --- status モード: 現在状況をそのまま通知（state は触らない） ---
  if (cfg.mode === 'status') {
    if (!cfg.webhook) {
      console.error('DISCORD_WEBHOOK_URL が未設定です。');
      return 1;
    }
    try {
      await sendDiscordNotification(cfg.webhook, buildStatusMessage(current));
    } catch (err) {
      console.error(`Discord 送信に失敗: ${err.message}`);
      return 1;
    }
    console.log(`ステータス通知を送信しました（現在: ${current.map}）。`);
    return 0;
  }

  // --- check モード: 変化時のみ通知 ---
  if (previousMap === null) {
    console.log(`初回実行: state を "${current.map}" にシード（通知なし）。`);
    await writeState(current.map);
    return 0;
  }
  if (previousMap === current.map) {
    console.log(`変化なし（現在も "${current.map}"）。`);
    return 0;
  }

  // 変化あり
  if (!cfg.webhook) {
    console.error('マップが変化しましたが DISCORD_WEBHOOK_URL が未設定です。');
    return 1;
  }
  try {
    await sendDiscordNotification(cfg.webhook, buildChangeMessage(previousMap, current));
  } catch (err) {
    // state はあえて更新しない → 次回実行で再検知・再送信（自己修復）。
    console.error(`Discord 送信に失敗（state 未更新・次回リトライ）: ${err.message}`);
    return 1;
  }
  await writeState(current.map);
  console.log(`通知しました: ${previousMap} -> ${current.map}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('想定外のエラー:', err?.message ?? err);
    process.exit(1);
  });
