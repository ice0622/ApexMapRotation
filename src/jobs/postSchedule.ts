// Apex Legends ランクマップの「1日のスケジュール」を Discord へ投稿するジョブ。
//
// API は「今の枠」と「次の枠」しか返さないので、残りの枠は rotation.ts で外挿する。
// 外挿に使う並びは Actions のキャッシュに覚えており、実行のたびに観測で検算・更新する。
// ランクの順序は変わらずマップの顔ぶれだけが入れ替わるため、1回の観測で置き換えを
// 特定でき、枠が変わった瞬間に自動復旧する。人が定数を直す必要は無い。
//
// 投稿するかどうかは「組み立てた文面が前回と違うか」だけで決める。
//   同じ日・同じ並び → 文面が同一 → 投稿しない
//   顔ぶれが変わった / 判別中から判明した / 日付が変わった → 文面が変わる → 投稿する
//
// cron は毎時だが、覚えている枠の終了時刻を過ぎるまでは API を叩かない。
// 結果、API 呼び出しは「枠が変わるたび＋日付が変わるとき」の1日6〜7回で済む。
//
// TypeScript のまま Node 24 で直接実行する（ネイティブ type stripping、ビルド不要）。
// 実行時の依存パッケージはゼロ。機密（APIキー・Webhook URL）は絶対にログへ出力しない。

import { appendFile } from 'node:fs/promises';

import { fetchRankedRotation } from '../lib/apexApi.ts';
import type { RankedRotation } from '../lib/apexApi.ts';
import { sendDiscordNotification } from '../lib/discord.ts';
import { readMemory, writeMemory } from '../lib/memory.ts';
import { getMockRotation } from '../lib/mockRotation.ts';
import {
  applyObservation,
  buildDaySchedule,
  jstDayStart,
  DAY_MS,
  INITIAL_ROTATION,
} from '../lib/rotation.ts';
import { buildScheduleMessage, twitterWeight, TWITTER_LIMIT } from '../lib/messages.ts';

// API の値が壊れていても毎回叩きに行かないための下限。
const MIN_RECHECK_MS = 5 * 60_000;

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

// キャッシュを保存すべきかをワークフローへ伝える。
async function signalChanged(): Promise<void> {
  const out = process.env.GITHUB_OUTPUT;
  if (out) await appendFile(out, 'changed=true\n');
}

async function main(): Promise<number> {
  const cfg = loadConfig();
  console.log(`${cfg.useMock ? 'MOCK データ' : 'live API'} で実行${cfg.dryRun ? '（DRY_RUN）' : ''}`);

  const nowMs = Date.now();
  const dayStartMs = jstDayStart(nowMs);
  const memory = await readMemory(INITIAL_ROTATION);

  // 枠も日付も変わっていなければ、出す内容は前回と同じにしかならない。API を叩かない。
  if (nowMs < memory.nextCheckMs && !cfg.force) {
    const waitMins = Math.ceil((memory.nextCheckMs - nowMs) / 60_000);
    console.log(`枠も日付も変わっていません（あと約${waitMins}分）。API は叩きません。`);
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

  // 観測で並びを検算・更新する。顔ぶれが変わっていればここで自動的に直る。
  const update = applyObservation(memory, rotation.current.map, rotation.next?.map ?? null);
  if (update.note !== null) console.warn(`警告: ${update.note}`);

  const cycle = update.cycle.length >= 2 ? update.cycle : null;
  const schedule = buildDaySchedule({ rotation, cycle, dayStartMs });
  for (const warning of schedule.warnings) console.warn(`警告: ${warning}`);

  const message = buildScheduleMessage(schedule.slots, dayStartMs, schedule.partial);

  // 次に確認すべき時刻。枠の終わりか日付が変わる時刻の早いほう。
  const nextCheckMs = Math.max(
    Math.min(rotation.current.endMs, dayStartMs + DAY_MS),
    nowMs + MIN_RECHECK_MS,
  );
  const nextMemory = {
    cycle: update.cycle,
    observed: update.observed,
    provisional: update.provisional,
    lastMessage: memory.lastMessage,
    nextCheckMs,
  };

  console.log(
    `枠数=${schedule.slots.length} / 枠長=${schedule.slotMinutes}分 / ` +
      `観測=${rotation.current.map} -> ${rotation.next?.map ?? '(next なし)'} / ` +
      `並び=${cycle === null ? '判別中' : `[${cycle.join(' -> ')}]${update.provisional ? '（暫定）' : ''}`}`,
  );

  // 出す内容が前回と同じなら投稿しない。この1行で「同じ日は1回だけ」も
  // 「顔ぶれが変わったら出し直す」も「判別中から判明したら出し直す」もまかなえる。
  if (message === memory.lastMessage && !cfg.force) {
    console.log('前回と同じ内容なので投稿しません。');
    if (!cfg.dryRun) {
      await writeMemory(nextMemory);
      await signalChanged();
    }
    return 0;
  }

  console.log(`---\n${message}\n---`);
  console.log(`X換算=${twitterWeight(message)}/${TWITTER_LIMIT}`);

  if (cfg.dryRun) {
    console.log('DRY_RUN のため送信せず、記録も更新しません。');
    return 0;
  }
  if (!cfg.webhook) {
    console.error('DISCORD_WEBHOOK_URL が未設定です。');
    return 1;
  }

  try {
    await sendDiscordNotification(cfg.webhook, message);
  } catch (err) {
    // lastMessage を進めない → 次の時間の実行で再送される（自己修復）。
    console.error(`Discord 送信に失敗（次回リトライ）: ${(err as Error).message}`);
    return 1;
  }

  await writeMemory({ ...nextMemory, lastMessage: message });
  await signalChanged();
  console.log(`投稿しました（${schedule.slots.length}枠${schedule.partial ? '・確定分のみ' : ''}）。`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('想定外のエラー:', (err as Error)?.message ?? err);
    process.exit(1);
  });
