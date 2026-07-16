// Apex Legends ランクマップ変更通知（ジョブの入り口）
//
// cron（check モード）: 現在マップが前回と変わったときだけ Discord に通知する。
// 手動（status モード）: 現在のマップ・次のマップ・残り時間をその場で Discord に出す。
//
// TypeScript のまま Node 24 で直接実行する（ネイティブ type stripping、ビルド不要）。
// 実行時の依存パッケージはゼロ（ネイティブ fetch / AbortSignal.timeout を利用）。
// 機密（APIキー・Webhook URL）は絶対にログへ出力しない。
//
// 共通部品は src/lib/ に分離している:
//   apexApi.ts  … API 呼び出し / discord.ts … Webhook 送信
//   state.ts    … 前回値の永続化 / messages.ts … 通知文面

import { fetchRankedMap } from '../lib/apexApi.ts';
import type { RankedMap } from '../lib/apexApi.ts';
import { sendDiscordNotification } from '../lib/discord.ts';
import { readLastMap, writeLastMap } from '../lib/state.ts';
import { buildChangeMessage, buildStatusMessage } from '../lib/messages.ts';

// モック時に使う仮想のローテーション。
const MOCK_ROTATION = ['E-District', "World's Edge", 'Storm Point', 'Broken Moon'];

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

type Config = {
  apiKey: string;
  webhook: string;
  useMock: boolean;
  explicitMock: boolean;
  mode: 'check' | 'status';
};

function loadConfig(): Config {
  const apiKey = (process.env.APEX_API_KEY ?? '').trim();
  const webhook = (process.env.DISCORD_WEBHOOK_URL ?? '').trim();
  const explicitMock = process.env.USE_MOCK === 'true';
  // API キーが未設定なら、明示指定が無くても自動でモックにフォールバックする。
  const useMock = explicitMock || apiKey === '';
  const mode = process.env.MODE === 'status' ? 'status' : 'check';
  return { apiKey, webhook, useMock, explicitMock, mode };
}

// ---------------------------------------------------------------------------
// マップ取得
// ---------------------------------------------------------------------------

function getMockMap(previousMap: string | null, explicitMock: boolean): RankedMap {
  const rotation = MOCK_ROTATION;
  const mockMap = process.env.MOCK_MAP;
  if (mockMap) {
    return {
      map: mockMap,
      nextMap: rotation[0],
      remainingMins: 83,
    };
  }
  let idx: number;
  if (explicitMock) {
    // 明示モック（テスト意図）: 前回の「次」を返す → 必ず変化が起き通知が発火する。
    const prevIdx = previousMap === null ? -1 : rotation.indexOf(previousMap);
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

async function getCurrentMap(cfg: Config, previousMap: string | null): Promise<RankedMap> {
  if (cfg.useMock) return getMockMap(previousMap, cfg.explicitMock);
  return fetchRankedMap(cfg.apiKey);
}

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const cfg = loadConfig();
  console.log(
    `mode=${cfg.mode} / ${cfg.useMock ? `MOCK (explicit=${cfg.explicitMock})` : 'live API'}`,
  );

  const previousMap = (await readLastMap())?.map ?? null;

  let current: RankedMap;
  try {
    current = await getCurrentMap(cfg, previousMap);
  } catch (err) {
    console.error(`マップ取得に失敗（スキップ）: ${(err as Error).message}`);
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
      console.error(`Discord 送信に失敗: ${(err as Error).message}`);
      return 1;
    }
    console.log(`ステータス通知を送信しました（現在: ${current.map}）。`);
    return 0;
  }

  // --- check モード: 変化時のみ通知 ---
  if (previousMap === null) {
    console.log(`初回実行: state を "${current.map}" にシード（通知なし）。`);
    await writeLastMap(current.map);
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
    console.error(`Discord 送信に失敗（state 未更新・次回リトライ）: ${(err as Error).message}`);
    return 1;
  }
  await writeLastMap(current.map);
  console.log(`通知しました: ${previousMap} -> ${current.map}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('想定外のエラー:', (err as Error)?.message ?? err);
    process.exit(1);
  });
