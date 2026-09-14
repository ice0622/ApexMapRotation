// state/ ディレクトリ（永続データ）の読み書き。
//
// 保持するのは観測したエッジ（「このマップの次はこれ」）だけ。
// ローテーションが変わったときしか中身が変わらないので、Actions が作る
// コミットも年に数回で済む。毎日変わる「投稿済みの記録」は Actions の
// キャッシュに逃がしている（postedMarker.ts）。
//
// 並び（sequence）を配列として持たないのが要点。配列だと「循環が閉じたか」を
// 判定できず、3マップ揃ったのか4マップ目が未観測なのかを区別できない。
// エッジだけを持ち、並びは毎回たどって導出する（rotation.ts の deriveCycle）。
//
// このモジュールは入出力と形の検証だけを担い、学習ロジックは rotation.ts に置く。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROTATION_PATH = fileURLToPath(new URL('../../state/rotation.json', import.meta.url));

// 「このマップの次はこのマップ」という観測1件。
export type RotationEdge = {
  next: string;
  seenAt: string;
};

export type RotationState = {
  edges: Record<string, RotationEdge>;
  updatedAt: string;
};

// 保存済みの edges から、形の正しいものだけを拾う。
function parseEdges(raw: unknown): Record<string, RotationEdge> {
  if (raw === null || typeof raw !== 'object') return {};
  const edges: Record<string, RotationEdge> = {};
  for (const [map, value] of Object.entries(raw as Record<string, unknown>)) {
    if (map.length === 0 || value === null || typeof value !== 'object') continue;
    const { next, seenAt } = value as { next?: unknown; seenAt?: unknown };
    if (typeof next !== 'string' || next.length === 0) continue;
    edges[map] = { next, seenAt: typeof seenAt === 'string' ? seenAt : '' };
  }
  return edges;
}

// 保存済みのエッジを返す。未記録・読取不能・壊れている場合は空（＝初回扱い）。
// ここでクラッシュさせると投稿ごと落ちるので、必ず学習し直せる形に倒す。
export async function readRotationState(): Promise<RotationState> {
  let parsed: Partial<RotationState> | null;
  try {
    parsed = JSON.parse(await readFile(ROTATION_PATH, 'utf8'));
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      console.warn(`state ファイルを読めませんでした（${e.message}）。初回扱いにします。`);
    }
    return { edges: {}, updatedAt: '' };
  }

  if (parsed === null || typeof parsed !== 'object') return { edges: {}, updatedAt: '' };
  return {
    edges: parseEdges(parsed.edges),
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
  };
}

export async function writeRotationState(edges: Record<string, RotationEdge>): Promise<void> {
  // キー順を固定しておくと、差分が「本当に変わった行」だけになる。
  const sorted: Record<string, RotationEdge> = {};
  for (const map of Object.keys(edges).sort()) sorted[map] = edges[map];

  const saved: RotationState = { edges: sorted, updatedAt: new Date().toISOString() };
  await mkdir(dirname(ROTATION_PATH), { recursive: true });
  await writeFile(ROTATION_PATH, `${JSON.stringify(saved, null, 2)}\n`, 'utf8');
}
