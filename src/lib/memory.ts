// ジョブが実行をまたいで覚えておくこと。
//
// リポジトリにはコミットせず Actions のキャッシュに置く。毎日変わる値なので
// コミットすると履歴が膨らむ一方、失っても数時間で学習し直せるためである。
//
// 覚えるのは4つ:
//   cycle        … 現時点で最良のローテーションの並び。これが生きている値で、
//                  コードの INITIAL_ROTATION はキャッシュが空のときの種でしかない
//   observed     … 並びを判別できないときに貯める観測（map -> 次のmap）
//   provisional  … 置き換え仮説で組んだ直後で、まだ裏が取れていない状態
//   lastMessage  … 最後に投稿した文面。これと違う文面ができたときだけ投稿する
//   nextCheckMs  … この時刻を過ぎるまでは何も変わりようがないので API を叩かない

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const MEMORY_PATH = fileURLToPath(new URL('../../.cache/memory.json', import.meta.url));

export type Memory = {
  cycle: string[];
  observed: Record<string, string>;
  provisional: boolean;
  lastMessage: string;
  nextCheckMs: number;
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0);
}

function parseObserved(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== 'object') return {};
  const observed: Record<string, string> = {};
  for (const [map, next] of Object.entries(raw as Record<string, unknown>)) {
    if (map.length > 0 && typeof next === 'string' && next.length > 0) observed[map] = next;
  }
  return observed;
}

// 記録が無い・壊れている場合は fallbackCycle（コードの種）で始める。
// ここでクラッシュさせると投稿ごと落ちるので、必ず動く形に倒す。
export async function readMemory(fallbackCycle: string[]): Promise<Memory> {
  const empty: Memory = {
    cycle: [...fallbackCycle],
    observed: {},
    provisional: false,
    lastMessage: '',
    nextCheckMs: 0,
  };
  try {
    const parsed = JSON.parse(await readFile(MEMORY_PATH, 'utf8')) as Partial<Memory>;
    return {
      cycle: isStringArray(parsed?.cycle) && parsed.cycle.length >= 2 ? parsed.cycle : empty.cycle,
      observed: parseObserved(parsed?.observed),
      provisional: parsed?.provisional === true,
      lastMessage: typeof parsed?.lastMessage === 'string' ? parsed.lastMessage : '',
      nextCheckMs: typeof parsed?.nextCheckMs === 'number' ? parsed.nextCheckMs : 0,
    };
  } catch {
    return empty;
  }
}

export async function writeMemory(memory: Memory): Promise<void> {
  await mkdir(dirname(MEMORY_PATH), { recursive: true });
  await writeFile(MEMORY_PATH, `${JSON.stringify(memory, null, 2)}\n`, 'utf8');
}
