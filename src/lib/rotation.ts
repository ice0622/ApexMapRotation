// 1日分のローテーションを組み立てるモジュール。
//
// API が返すのは「今の枠」と「次の枠」の2つだけなので、1日分（4.5時間枠なら6〜7枠）は
// ここで外挿する。材料は2つ:
//   枠長   … API の current / next の実測（最優先。推測値は使わない）
//   並び順 … 下の RANKED_MAP_POOL（集合）と観測から毎回導出する
//
// 定数として持つのは「どの3マップか」という集合だけで、並び順は持たない。
// 3マップなら観測1組から並びが一意に決まるため（resolveCycle 参照）、
// 順序だけが変わるシーズン更新には手を加えずに追従できる。

import type { RankedRotation, RotationSlot } from './apexApi.ts';

// ---------------------------------------------------------------------------
// ランクに出るマップの集合（顔ぶれが変わったら手で書き換える）
// ---------------------------------------------------------------------------
//
// **順序は不問**。並びは毎回 API の観測から resolveCycle が決める。
// 名前は API が返す英語表記と完全に一致させること（日本語表示は messages.ts の
// JP_MAP_NAMES が担当する）。
//
// ここに無いマップを API が返したらランクの構成が変わっている。そのときは
// 外挿をやめて確定分だけを投稿し、ジョブを失敗扱いにして GitHub から通知する。
export const RANKED_MAP_POOL = ["World's Edge", 'Storm Point', 'E-District'];

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

export type CycleResolution = {
  // 並びが決まらなければ null。呼び出し側は外挿をやめて実測の枠だけを出す。
  cycle: string[] | null;
  warnings: string[];
};

// 観測した1組（current -> next）と集合から、ローテーションの並びを組み立てる。
//
// 3マップなら観測1組で一意に決まる。{A,B,C} を全部回る循環で A->B が確定しているなら、
// B の次は C しか残らない（A に戻ると C を飛ばしてしまう）。
// だから並び順を定数で持つ必要はなく、「どの3マップか」だけ分かっていればよい。
// 4マップ以上だと A->B の先が2通りありうるので、1組では決まらない。
export function resolveCycle(pool: string[], rotation: RankedRotation): CycleResolution {
  const { current, next } = rotation;

  if (next === null) {
    return { cycle: null, warnings: ['API が次の枠を返しませんでした。確定分だけを出します。'] };
  }

  const unknown = [current.map, next.map].filter((map) => !pool.includes(map));
  if (unknown.length > 0) {
    return {
      cycle: null,
      warnings: [
        `${unknown.join(' / ')} が RANKED_MAP_POOL [${pool.join(', ')}] にありません。` +
          `ランクのマップ構成が変わっています。src/lib/rotation.ts の RANKED_MAP_POOL を更新してください。`,
      ],
    };
  }
  if (current.map === next.map) {
    return { cycle: null, warnings: [`API が同じマップを続けて返しました（${current.map}）。`] };
  }

  const rest = pool.filter((map) => map !== current.map && map !== next.map);
  if (pool.length === 2 && rest.length === 0) return { cycle: [current.map, next.map], warnings: [] };
  if (pool.length === 3 && rest.length === 1) {
    return { cycle: [current.map, next.map, rest[0]], warnings: [] };
  }
  return {
    cycle: null,
    warnings: [
      `マップ ${pool.length} 個では観測1組から並びが一意に決まりません（決まるのは2個か3個のときだけ）。`,
    ],
  };
}

export type DaySchedule = {
  slots: RotationSlot[];
  slotMinutes: number;
  // 並びが分からず、実測できた枠だけを返したか。
  partial: boolean;
  warnings: string[];
};

// JST の1日ぶんの枠を返す。
// 0時をまたぐ枠は切り詰めず、実際の開始・終了時刻を保ったまま含める。
export function buildDaySchedule(opts: {
  rotation: RankedRotation;
  // null なら外挿しない。間違った1日分を出すより、短くても確実な分だけを出す。
  cycle: string[] | null;
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

  const inDay = (slot: RotationSlot) => slot.endMs > dayStartMs && slot.startMs < dayEndMs;

  // 並びが分からないときは外挿しない。API が保証する枠だけを返す。
  if (cycle === null) {
    const measured = next === null ? [current] : [current, next];
    return {
      slots: measured.filter(inDay),
      slotMinutes: Math.round(slotMs / 60_000),
      partial: true,
      warnings,
    };
  }

  // 外挿は current を基準に前後へ伸ばすので、循環は current.map が先頭でなければならない。
  // 定数がどの順で書かれていても正しく動くよう、ここで回し直す。
  const pivot = cycle.indexOf(current.map);
  const cycleMaps = [...cycle.slice(pivot), ...cycle.slice(0, pivot)];

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
    slots: slots.filter(inDay),
    slotMinutes: Math.round(slotMs / 60_000),
    partial: false,
    warnings,
  };
}
