// APIキーが無いときに使うダミーのローテーション。
// 投稿ジョブと観測ジョブの両方から使うので lib に置いている。
//
// 前日22時を起点に枠を並べ、実行時刻を含む枠を current とする。
// 0時に実行すれば「前日22:00 開始の枠」が current になり、本番と同じ形になる。
// 並びは INITIAL_ROTATION の記載順をそのまま使う。別に持つと、モックで動かしたときだけ
// 照合が警告を出してしまい、本当のずれと見分けがつかなくなる。

import type { RankedRotation, RotationSlot } from './apexApi.ts';
import { INITIAL_ROTATION } from './rotation.ts';

// 既定の枠長。MOCK_SLOT_MINUTES で上書きでき、枠が短いときの短縮形も試せる。
const MOCK_SLOT_MINUTES = 270;

// MOCK_POOL でモック側の並びだけを差し替えられる。覚えている並びと食い違う状態を
// 作れるので、シーズンでマップ構成が変わった日の挙動をローカルで確認できる。
//   MOCK_POOL="Broken Moon,Storm Point,E-District" npm run post:dry
function mockPool(): string[] {
  const override = (process.env.MOCK_POOL ?? '').trim();
  if (override === '') return INITIAL_ROTATION;
  return override.split(',').map((map) => map.trim()).filter((map) => map.length > 0);
}

export function getMockRotation(dayStartMs: number): RankedRotation {
  const pool = mockPool();
  const slotMinutes = Number(process.env.MOCK_SLOT_MINUTES) || MOCK_SLOT_MINUTES;
  const slotMs = slotMinutes * 60_000;
  const nowMs = Date.now();

  let startMs = dayStartMs - 2 * 60 * 60 * 1000; // 前日 22:00
  let index = 0;
  while (startMs + slotMs <= nowMs) {
    startMs += slotMs;
    index += 1;
  }

  const slotAt = (i: number, at: number): RotationSlot => ({
    map: pool[i % pool.length],
    startMs: at,
    endMs: at + slotMs,
  });
  return { current: slotAt(index, startMs), next: slotAt(index + 1, startMs + slotMs) };
}
