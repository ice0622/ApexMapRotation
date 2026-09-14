// 「その日はもう投稿したか」の記録。
//
// GitHub Actions の schedule は取りこぼすので投稿ジョブの cron は1日3本あるが、
// 3本とも投稿してしまっては困る。その重複を防ぐためだけの記録。
//
// リポジトリにコミットせず Actions のキャッシュに置く。毎日変わる値なので
// コミットすると履歴が1日1件ずつ膨らむ一方、失っても影響は「その日に最大3回
// 投稿する」だけで自己修復するため、消えてよい置き場所が向いている。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const MARKER_PATH = fileURLToPath(new URL('../../.cache/last_posted', import.meta.url));

// 最後に投稿した JST の日付 "YYYY-MM-DD"。記録が無ければ空文字。
export async function readLastPostedDate(): Promise<string> {
  try {
    return (await readFile(MARKER_PATH, 'utf8')).trim();
  } catch {
    return '';
  }
}

export async function writeLastPostedDate(date: string): Promise<void> {
  await mkdir(dirname(MARKER_PATH), { recursive: true });
  await writeFile(MARKER_PATH, `${date}\n`, 'utf8');
}
