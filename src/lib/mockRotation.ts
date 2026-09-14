// APIキーが無いときに使うダミーのローテーション。
// 投稿ジョブと観測ジョブの両方から使うので lib に置いている。
//
// 前日22時を起点に枠を並べ、実行時刻を含む枠を current とする。
// 0時に実行すれば「前日22:00 開始の枠」が current になり、本番と同じ形になる。

import type { RankedRotation, RotationSlot } from './apexApi.ts';

const MOCK_ROTATION = ['Storm Point', "World's Edge", 'E-District'];
// 既定の枠長。MOCK_SLOT_MINUTES で上書きでき、枠が短いときの短縮形も試せる。
const MOCK_SLOT_MINUTES = 270;

export function getMockRotation(dayStartMs: number): RankedRotation {
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
    map: MOCK_ROTATION[i % MOCK_ROTATION.length],
    startMs: at,
    endMs: at + slotMs,
  });
  return { current: slotAt(index, startMs), next: slotAt(index + 1, startMs + slotMs) };
}
