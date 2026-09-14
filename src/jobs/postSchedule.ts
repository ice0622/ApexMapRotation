// Apex Legends ランクマップの「1日のスケジュール」を Discord へ投稿するジョブ。
//
// 1日1回（JST 0:00）、その日のローテーションを時刻表として1通にまとめて送る。
// API は「今の枠」と「次の枠」しか返さないため、残りの枠は rotation.ts で外挿する。
// 外挿に使うマップの並びは rotation.ts の RANKED_ROTATION（手で書く定数）。
//
// GitHub Actions の schedule は宣言どおりに走らない（実測で高頻度 cron は3%程度まで
// 間引かれる）。そのため cron は1日3本あり、二重投稿は投稿済みの記録で防ぐ。
// その記録はコミットせず Actions のキャッシュに置く（postedMarker.ts）。
// リポジトリに書き込むものは何も無いので、bot によるコミットは発生しない。
//
// TypeScript のまま Node 24 で直接実行する（ネイティブ type stripping、ビルド不要）。
// 実行時の依存パッケージはゼロ（ネイティブ fetch / AbortSignal.timeout を利用）。
// 機密（APIキー・Webhook URL）は絶対にログへ出力しない。

import { appendFile } from 'node:fs/promises';

import { fetchRankedRotation } from '../lib/apexApi.ts';
import type { RankedRotation } from '../lib/apexApi.ts';
import { sendDiscordNotification } from '../lib/discord.ts';
import { readLastPostedDate, writeLastPostedDate } from '../lib/postedMarker.ts';
import { getMockRotation } from '../lib/mockRotation.ts';
import {
  buildDaySchedule,
  jstDateKey,
  jstDayStart,
  verifyRotation,
  RANKED_ROTATION,
} from '../lib/rotation.ts';
import { buildScheduleMessage, twitterWeight, TWITTER_LIMIT } from '../lib/messages.ts';

type Config = {
  apiKey: string;
  webhook: string;
  useMock: boolean;
  force: boolean;
  dryRun: boolean;
};

function loadConfig(): Config {
  const apiKey = (process.env.APEX_API_KEY ?? '').trim();
  return {
    apiKey,
    webhook: (process.env.DISCORD_WEBHOOK_URL ?? '').trim(),
    // API キーが未設定なら、明示指定が無くても自動でモックにフォールバックする。
    useMock: process.env.USE_MOCK === 'true' || apiKey === '',
    force: process.env.FORCE === 'true',
    dryRun: process.env.DRY_RUN === 'true',
  };
}

// 投稿できたことをワークフローへ伝える。キャッシュの保存はこの出力を見て判断する。
async function signalPosted(): Promise<void> {
  const out = process.env.GITHUB_OUTPUT;
  if (out) await appendFile(out, 'posted=true\n');
}

// 定数が実際のローテーションとずれていたら、投稿が成功していても失敗扱いで終える。
// ログに書くだけでは誰も見ないが、ジョブが赤くなれば GitHub から通知が届く。
function exitCodeFor(rotationWarnings: string[]): number {
  if (rotationWarnings.length === 0) return 0;
  console.error(
    'RANKED_ROTATION が実際のローテーションと一致していません。' +
      '投稿そのものは完了していますが、定数を直すまで失敗扱いにします。',
  );
  return 1;
}

async function main(): Promise<number> {
  const cfg = loadConfig();
  console.log(`${cfg.useMock ? 'MOCK データ' : 'live API'} で実行${cfg.dryRun ? '（DRY_RUN）' : ''}`);

  const nowMs = Date.now();
  const dayStartMs = jstDayStart(nowMs);
  const today = jstDateKey(nowMs);

  // cron は遅延・欠落に備えて1日3本走る。投稿済みならここで静かに終わる。
  if ((await readLastPostedDate()) === today && !cfg.force) {
    console.log(`本日（${today}）は投稿済みです。FORCE=true で再投稿できます。`);
    return 0;
  }

  let rotation: RankedRotation;
  try {
    rotation = cfg.useMock ? getMockRotation(dayStartMs) : await fetchRankedRotation(cfg.apiKey);
  } catch (err) {
    // 後続のリトライ枠で再試行するので、ここでは失敗扱いにしない。
    console.error(`ローテーション取得に失敗（スキップ）: ${(err as Error).message}`);
    return 0;
  }

  // 1日1回のこの観測が、定数のずれ＝シーズン変更を検知する唯一の機会。
  const rotationWarnings = verifyRotation(rotation, RANKED_ROTATION);
  const schedule = buildDaySchedule({ rotation, cycle: RANKED_ROTATION, dayStartMs });
  for (const warning of [...rotationWarnings, ...schedule.warnings]) {
    console.warn(`警告: ${warning}`);
  }

  const message = buildScheduleMessage(schedule.slots, dayStartMs);
  console.log(`---\n${message}\n---`);
  console.log(
    `枠数=${schedule.slots.length} / 枠長=${schedule.slotMinutes}分 / ` +
      `観測=${rotation.current.map} -> ${rotation.next?.map ?? '(next なし)'} / ` +
      `X換算=${twitterWeight(message)}/${TWITTER_LIMIT}`,
  );

  if (cfg.dryRun) {
    console.log('DRY_RUN のため送信しません。');
    return exitCodeFor(rotationWarnings);
  }
  if (!cfg.webhook) {
    console.error('DISCORD_WEBHOOK_URL が未設定です。');
    return 1;
  }

  try {
    await sendDiscordNotification(cfg.webhook, message);
  } catch (err) {
    // 投稿済みの記録は進めない → 後続のリトライ枠で再送される（自己修復）。
    console.error(`Discord 送信に失敗（次回リトライ）: ${(err as Error).message}`);
    return 1;
  }

  await writeLastPostedDate(today);
  await signalPosted();
  console.log(`投稿しました（${today} / ${schedule.slots.length}枠）。`);
  return exitCodeFor(rotationWarnings);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('想定外のエラー:', (err as Error)?.message ?? err);
    process.exit(1);
  });
