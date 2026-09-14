// Apex Legends ランクマップの「1日のスケジュール」を Discord へ投稿するジョブ。
//
// 平常時は JST 0:00 に1通だけ送る。API は「今の枠」と「次の枠」しか返さないので、
// 残りの枠は rotation.ts で外挿する。並びは RANKED_MAP_POOL（どの3マップか）と
// API の観測から毎回その場で決まるため、順序だけが変わるシーズン更新には自動で追従する。
//
// マップの顔ぶれが変わって並びを判別できない日は、外挿をやめて実測の枠だけを投稿し、
// 枠が変わるたびに投稿し直す。間違った1日分を出すより、短くても確実な分を出す。
//
// cron は毎時。GitHub Actions の schedule は宣言どおりに走らない（実測で高頻度 cron は
// 3%程度まで間引かれる）ので、毎時にしておけば取りこぼしても次の時間で取り返せる。
// 完了済みの日は記録を読むだけで終わり、API も叩かない（平常時の API 呼び出しは1日1回）。
//
// TypeScript のまま Node 24 で直接実行する（ネイティブ type stripping、ビルド不要）。
// 実行時の依存パッケージはゼロ。機密（APIキー・Webhook URL）は絶対にログへ出力しない。

import { appendFile } from 'node:fs/promises';

import { fetchRankedRotation } from '../lib/apexApi.ts';
import type { RankedRotation } from '../lib/apexApi.ts';
import { sendDiscordNotification } from '../lib/discord.ts';
import { readMarker, writeMarker } from '../lib/postedMarker.ts';
import { getMockRotation } from '../lib/mockRotation.ts';
import {
  buildDaySchedule,
  jstDateKey,
  jstDayStart,
  resolveCycle,
  RANKED_MAP_POOL,
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

// 並びを判別できなかった日は、投稿そのものが成功していても失敗扱いで終える。
// ログに書くだけでは誰も見ないが、ジョブが赤くなれば GitHub から通知が届く。
function exitCodeFor(partial: boolean): number {
  if (!partial) return 0;
  console.error(
    'ランクのマップ構成が RANKED_MAP_POOL と一致していません。' +
      '確定分の投稿は完了していますが、定数を直すまで失敗扱いにします。',
  );
  return 1;
}

async function main(): Promise<number> {
  const cfg = loadConfig();
  console.log(`${cfg.useMock ? 'MOCK データ' : 'live API'} で実行${cfg.dryRun ? '（DRY_RUN）' : ''}`);

  const nowMs = Date.now();
  const dayStartMs = jstDayStart(nowMs);
  const today = jstDateKey(nowMs);

  const marker = await readMarker();
  const sameDay = marker !== null && marker.date === today;

  // 今日ぶんを完全な形で投稿済みなら、API も叩かずに終える。
  // 毎時走らせても平常時の API 呼び出しが1日1回で済むのはこの分岐のおかげ。
  if (sameDay && !marker.partial && !cfg.force) {
    console.log(`本日（${today}）は投稿済みです。FORCE=true で再投稿できます。`);
    return 0;
  }

  let rotation: RankedRotation;
  try {
    rotation = cfg.useMock ? getMockRotation(dayStartMs) : await fetchRankedRotation(cfg.apiKey);
  } catch (err) {
    // 次の時間の実行で取り直せばよいので、ここでは失敗扱いにしない。
    console.error(`ローテーション取得に失敗（スキップ）: ${(err as Error).message}`);
    return 0;
  }

  // いちど判別不能だった日は、そのあとの観測がたまたま集合に収まっていても信用しない。
  // 古い集合のまま消去法を使うと、抜けたはずのマップを含む「もっともらしいが
  // 間違った1日分」を自信満々に出してしまう。
  const poolTrusted = cfg.force || !(sameDay && marker.partial);
  const resolved = poolTrusted
    ? resolveCycle(RANKED_MAP_POOL, rotation)
    : { cycle: null, warnings: ['本日は既に判別不能と判定済みのため、外挿しません。'] };

  const schedule = buildDaySchedule({ rotation, cycle: resolved.cycle, dayStartMs });
  for (const warning of [...resolved.warnings, ...schedule.warnings]) {
    console.warn(`警告: ${warning}`);
  }

  // 判別できない日は枠が変わるたびに投稿し直すが、同じ枠のあいだは投げない。
  if (sameDay && marker.partial && marker.slotStartMs === rotation.current.startMs && !cfg.force) {
    console.log('確定分は投稿済みで、枠もまだ変わっていません。次の枠まで待ちます。');
    return exitCodeFor(schedule.partial);
  }

  const message = buildScheduleMessage(schedule.slots, dayStartMs, schedule.partial);
  console.log(`---\n${message}\n---`);
  console.log(
    `枠数=${schedule.slots.length} / 枠長=${schedule.slotMinutes}分 / ` +
      `観測=${rotation.current.map} -> ${rotation.next?.map ?? '(next なし)'} / ` +
      `並び=${resolved.cycle === null ? '判別不能' : `[${resolved.cycle.join(' -> ')}]`} / ` +
      `X換算=${twitterWeight(message)}/${TWITTER_LIMIT}`,
  );

  if (cfg.dryRun) {
    console.log('DRY_RUN のため送信しません。');
    return exitCodeFor(schedule.partial);
  }
  if (!cfg.webhook) {
    console.error('DISCORD_WEBHOOK_URL が未設定です。');
    return 1;
  }

  try {
    await sendDiscordNotification(cfg.webhook, message);
  } catch (err) {
    // 記録を進めない → 次の時間の実行で再送される（自己修復）。
    console.error(`Discord 送信に失敗（次回リトライ）: ${(err as Error).message}`);
    return 1;
  }

  await writeMarker({
    date: today,
    partial: schedule.partial,
    slotStartMs: rotation.current.startMs,
  });
  await signalPosted();
  console.log(`投稿しました（${today} / ${schedule.slots.length}枠${schedule.partial ? '・確定分のみ' : ''}）。`);
  return exitCodeFor(schedule.partial);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('想定外のエラー:', (err as Error)?.message ?? err);
    process.exit(1);
  });
