// 「その日に何をどこまで投稿したか」の記録。
//
// 3つの判断に使う:
//   date        … 同じ日に二重投稿しない
//   partial     … その日は並びを判別できなかった。以降の実行も判別不能として扱う
//   slotStartMs … 判別できない日に、枠が変わったときだけ再投稿する
//
// partial を覚えておくのが要点。ランクの構成が変わった日は、あとの観測が
// たまたま古い集合の中に収まることがある。そのとき消去法を使うと、抜けたはずの
// マップを含む「もっともらしいが間違った1日分」を自信満々に投稿してしまう。
//
// リポジトリにコミットせず Actions のキャッシュに置く。毎日変わる値なので
// コミットすると履歴が1日1件ずつ膨らむ一方、失っても影響は「その日にもう一度
// 投稿する」程度で自己修復するため、消えてよい置き場所が向いている。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const MARKER_PATH = fileURLToPath(new URL('../../.cache/last_posted.json', import.meta.url));

export type PostedMarker = {
  date: string;
  partial: boolean;
  slotStartMs: number;
};

// 記録が無い・壊れている場合は null（＝まだ投稿していない扱い）。
export async function readMarker(): Promise<PostedMarker | null> {
  try {
    const parsed = JSON.parse(await readFile(MARKER_PATH, 'utf8')) as Partial<PostedMarker>;
    if (typeof parsed?.date !== 'string' || parsed.date.length === 0) return null;
    return {
      date: parsed.date,
      partial: parsed.partial === true,
      slotStartMs: typeof parsed.slotStartMs === 'number' ? parsed.slotStartMs : 0,
    };
  } catch {
    return null;
  }
}

export async function writeMarker(marker: PostedMarker): Promise<void> {
  await mkdir(dirname(MARKER_PATH), { recursive: true });
  await writeFile(MARKER_PATH, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
}
