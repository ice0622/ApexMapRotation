// 1日分のローテーションを組み立てるモジュール。
//
// API が返すのは「今の枠」と「次の枠」の2つだけなので、1日分（4.5時間枠なら6〜7枠）は
// ここで外挿する。材料は2つ:
//   枠長   … API の current / next の実測（最優先。推測値は使わない）
//   循環順 … 下の RANKED_ROTATION（手で書く定数）
//
// 循環順を自動で学習させる作りも試したが、割に合わなかった。API は隣接1組しか
// 返さないため、循環を確定するには一巡（約13.5時間）観測し続けるしかなく、
// その間は誤った表を出してしまう。ローテーションが変わるのはシーズンごと＝年に数回で、
// 手で3行書き換えれば済む。代わりに verifyRotation で「定数が古い」ことだけ自動検知する。

import type { RankedRotation, RotationSlot } from './apexApi.ts';

// ---------------------------------------------------------------------------
// ランクのマップローテーション（シーズンで変わったら手で書き換える）
// ---------------------------------------------------------------------------
//
// この順に一定の長さずつ回る。末尾の次は先頭に戻る。
// 名前は API が返す英語表記と完全に一致させること（日本語表示は messages.ts の
// JP_MAP_NAMES が担当する）。
//
// 並びが実際と食い違うと verifyRotation が警告を出し、ジョブが失敗扱いになって
// GitHub から通知が届く。そうなったらこの配列を直す。
export const RANKED_ROTATION = ["World's Edge", 'Storm Point', 'E-District'];

// Asia/Tokyo はサマータイムが無いので固定オフセットで正確に計算できる。
// Intl で日付を分解して組み直すより単純で、丸め誤差も入らない。
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export const DAY_MS = 24 * 60 * 60 * 1000;

// 枠長が壊れた値（極端に短い等）でも無限ループしないための上限。
const MAX_SLOTS_PER_DAY = 48;

// 指定時刻を含む JST の日の 00:00 を UNIX ミリ秒で返す。
export function jstDayStart(atMs: number): number {
  return Math.floor((atMs + JST_OFFSET_MS) / DAY_MS) * DAY_MS - JST_OFFSET_MS;
}

// JST の日付キー "YYYY-MM-DD"。同じ日に二重投稿しないための記録に使う。
export function jstDateKey(atMs: number): string {
  return new Date(atMs + JST_OFFSET_MS).toISOString().slice(0, 10);
}

// 循環順の index。外挿は前後どちらにも伸びるので、負数でも正しく回るよう剰余を補正する。
function cycleAt(cycle: string[], index: number): string {
  const n = cycle.length;
  return cycle[((index % n) + n) % n];
}

// API が返した「今 -> 次」が定数の並びと合っているか確かめる。
// 合わなければシーズンでローテーションが変わっている。直すのは手作業だが、
// 直すべきだということは毎日の実行が自動で教えてくれる。
export function verifyRotation(rotation: RankedRotation, cycle: string[]): string[] {
  const { current, next } = rotation;

  const index = cycle.indexOf(current.map);
  if (index < 0) {
    return [
      `現在のマップ "${current.map}" が RANKED_ROTATION [${cycle.join(', ')}] に含まれていません。` +
        `src/lib/rotation.ts の RANKED_ROTATION を更新してください。`,
    ];
  }
  if (next === null) return [];

  const expected = cycleAt(cycle, index + 1);
  if (next.map === expected) return [];
  return [
    `ローテーションが変わっています。API は "${current.map}" -> "${next.map}" を返しましたが、` +
      `RANKED_ROTATION では "${current.map}" -> "${expected}" です。` +
      `src/lib/rotation.ts の RANKED_ROTATION を更新してください。`,
  ];
}

export type DaySchedule = {
  slots: RotationSlot[];
  slotMinutes: number;
  warnings: string[];
};

// JST の1日ぶんの枠を返す。
// 0時をまたぐ枠は切り詰めず、実際の開始・終了時刻を保ったまま含める。
export function buildDaySchedule(opts: {
  rotation: RankedRotation;
  cycle: string[];
  dayStartMs: number;
}): DaySchedule {
  const { rotation, cycle, dayStartMs } = opts;
  const { current, next } = rotation;
  const dayEndMs = dayStartMs + DAY_MS;
  const warnings: string[] = [];

  // 枠長は current の実測を使う。next と食い違う場合はマップごとに長さが
  // 違う可能性があるため、外挿は current 基準で続けつつ警告だけ残す。
  const slotMs = current.endMs - current.startMs;
  if (next !== null) {
    const nextSlotMs = next.endMs - next.startMs;
    if (Math.abs(nextSlotMs - slotMs) > 60_000) {
      warnings.push(
        `枠長が一定ではない可能性があります（現在=${Math.round(slotMs / 60_000)}分 / 次=${Math.round(nextSlotMs / 60_000)}分）。外挿には現在の枠長を使います。`,
      );
    }
  }

  // 外挿は current を基準に前後へ伸ばすので、循環は current.map が先頭でなければならない。
  // 定数がどの順で書かれていても正しく動くよう、ここで回し直す。
  // （整列を呼び出し側の責任にすると、ずれた並びを渡されたときにエラーにならず
  //   「1日ぶんの並びが静かにずれた表」が出てしまう）
  const pivot = cycle.indexOf(current.map);
  let cycleMaps: string[];
  if (pivot < 0) {
    // verifyRotation が既に警告済み。ここでは観測できた2枠だけで外挿する。
    cycleMaps = next === null ? [current.map] : [current.map, next.map];
  } else {
    cycleMaps = [...cycle.slice(pivot), ...cycle.slice(0, pivot)];
  }

  const slots: RotationSlot[] = [];

  // 後方へ外挿: current の開始が日の始まりより後なら、その手前を埋める。
  // 日中に手動実行したとき 00:00 〜 current.start が空かないようにするためのもので、
  // 0時の定時実行では1周も回らない。
  let backStartMs = current.startMs;
  let backIdx = 0;
  while (backStartMs > dayStartMs && slots.length < MAX_SLOTS_PER_DAY) {
    backStartMs -= slotMs;
    backIdx -= 1;
    slots.unshift({
      map: cycleAt(cycleMaps, backIdx),
      startMs: backStartMs,
      endMs: backStartMs + slotMs,
    });
  }

  // API 実測の確定枠。
  slots.push(current);
  let forwardIdx = 1;
  let forwardMs = current.endMs;
  if (next !== null) {
    slots.push(next);
    forwardIdx = 2;
    forwardMs = next.endMs;
  }

  // 前方へ外挿: 日の終わりをまたぐ枠まで含める。
  while (forwardMs < dayEndMs && slots.length < MAX_SLOTS_PER_DAY) {
    slots.push({
      map: cycleAt(cycleMaps, forwardIdx),
      startMs: forwardMs,
      endMs: forwardMs + slotMs,
    });
    forwardMs += slotMs;
    forwardIdx += 1;
  }

  return {
    // 当日に少しでもかぶる枠だけを残す（境界の枠は丸ごと残す）。
    slots: slots.filter((slot) => slot.endMs > dayStartMs && slot.startMs < dayEndMs),
    slotMinutes: Math.round(slotMs / 60_000),
    warnings,
  };
}
