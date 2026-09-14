// state/ ディレクトリ（永続データ）の読み書き。
// GitHub Actions では内容が変わったときだけ commit & push される。
//
// 保持するのは3つ:
//   edges          … 「このマップの次はこれ」という観測。循環順を導出する材料
//   lastMap        … 直近に観測した現在マップ。循環を辿るときの出発点
//   slotMinutes    … 直近に観測した枠の長さ（診断用）
//   lastPostedDate … 投稿済みの日付（JST）。同じ日の二重投稿を防ぐ
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
  lastMap: string;
  slotMinutes: number;
  lastPostedDate: string;
  updatedAt: string;
};

function emptyState(): RotationState {
  return { edges: {}, lastMap: '', slotMinutes: 0, lastPostedDate: '', updatedAt: '' };
}

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

// 保存済みの state を返す。未記録・読取不能・壊れている場合は空の state（＝初回扱い）。
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
    return emptyState();
  }

  if (parsed === null || typeof parsed !== 'object') return emptyState();
  return {
    edges: parseEdges(parsed.edges),
    lastMap: typeof parsed.lastMap === 'string' ? parsed.lastMap : '',
    slotMinutes:
      typeof parsed.slotMinutes === 'number' && parsed.slotMinutes > 0 ? parsed.slotMinutes : 0,
    lastPostedDate: typeof parsed.lastPostedDate === 'string' ? parsed.lastPostedDate : '',
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
  };
}

export async function writeRotationState(state: Omit<RotationState, 'updatedAt'>): Promise<void> {
  // キー順を固定しておくと、差分が「本当に変わった行」だけになる。
  const edges: Record<string, RotationEdge> = {};
  for (const map of Object.keys(state.edges).sort()) edges[map] = state.edges[map];

  const saved: RotationState = { ...state, edges, updatedAt: new Date().toISOString() };
  await mkdir(dirname(ROTATION_PATH), { recursive: true });
  await writeFile(ROTATION_PATH, `${JSON.stringify(saved, null, 2)}\n`, 'utf8');
}
