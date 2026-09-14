// 1日分のローテーションを組み立てるモジュール。
//
// API は「今の枠」と「次の枠」しか返さない（1回の呼び出し＝隣接1組）。
// 1日分を出すには残りを外挿する必要があり、その材料が2つある:
//   枠長   … API の current / next の実測（最優先。推測値は使わない）
//   循環順 … 観測したエッジ（A の次は B）を辿って導出した並び
//
// 循環順を「配列」ではなく「エッジの集合」で持つのが設計の要点。
// 配列だと [A,B,C] まで並んでも、本当は [A,B,D,C] かもしれず、
// 「循環が閉じたか」を判定できない。エッジなら出発点に戻れたかで確定を判定でき、
// シーズンでローテが変わってもエッジを上書きするだけで古い並びが自然に脱落する。

import type { RankedRotation, RotationSlot } from './apexApi.ts';
import type { RotationEdge } from './state.ts';

// Asia/Tokyo はサマータイムが無いので固定オフセットで正確に計算できる。
// Intl で日付を分解して組み直すより単純で、丸め誤差も入らない。
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export const DAY_MS = 24 * 60 * 60 * 1000;

// 枠長が壊れた値（極端に短い等）でも無限ループしないための上限。
const MAX_SLOTS_PER_DAY = 48;
// エッジが矛盾していても辿り続けないための上限。
const MAX_CYCLE_LENGTH = 16;

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

export type EdgeRecord = {
  edges: Record<string, RotationEdge>;
  changed: boolean;
  // 既存のエッジと矛盾したため、他のエッジを捨てて学習し直したか。
  reset: boolean;
};

// 観測した「current の次は next」を1本記録する。
// 同じ組み合わせなら何も変えない（＝state を書かずに済み、無駄なコミットが出ない）。
//
// 既存のエッジと食い違った場合は、そのエッジだけを直すのでは足りない。
// 例えば A->B->C->A が A->C->B->A に変わったとき、A->C だけ上書きすると
// 古い C->A が残って「A->C->A の2マップ循環」として誤って確定してしまう。
// 矛盾は「もう古いモデルは信用できない」という証拠なので、全部捨てて learn し直す。
export function recordEdge(
  edges: Record<string, RotationEdge>,
  current: RotationSlot,
  next: RotationSlot | null,
  atMs: number,
): EdgeRecord {
  if (next === null) return { edges, changed: false, reset: false };

  const existing = edges[current.map];
  if (existing !== undefined && existing.next === next.map) {
    return { edges, changed: false, reset: false };
  }

  const edge: RotationEdge = { next: next.map, seenAt: new Date(atMs).toISOString() };
  if (existing !== undefined) {
    return { edges: { [current.map]: edge }, changed: true, reset: true };
  }
  return { edges: { ...edges, [current.map]: edge }, changed: true, reset: false };
}

export type Cycle = {
  // startMap を先頭にした並び。
  maps: string[];
  // 出発点まで戻れたか。false なら循環がまだ確定していない。
  closed: boolean;
};

// startMap からエッジを辿って循環順を導出する。
// 出発点に戻れれば確定。未知のエッジに当たる、または途中で別の場所へ合流する
// （＝エッジが矛盾している）場合は未確定として、判明している分だけを返す。
//
// 常に「今のマップ」から辿るので、シーズン変更で使われなくなったマップは
// 経路から外れて自動的に無視される。明示的な削除処理は要らない。
export function deriveCycle(edges: Record<string, RotationEdge>, startMap: string): Cycle {
  const maps = [startMap];
  const visited = new Set([startMap]);
  let node = startMap;

  while (maps.length <= MAX_CYCLE_LENGTH) {
    const edge = edges[node];
    if (edge === undefined) return { maps, closed: false }; // 未観測のエッジ
    if (edge.next === startMap) return { maps, closed: true }; // 一周した
    if (visited.has(edge.next)) return { maps, closed: false }; // 途中で合流＝矛盾
    maps.push(edge.next);
    visited.add(edge.next);
    node = edge.next;
  }
  return { maps, closed: false };
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
  cycle: Cycle;
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

  if (!cycle.closed) {
    warnings.push(
      `循環がまだ確定していません（判明している並び: ${cycle.maps.join(' -> ')}）。観測が一周するまで外挿がずれることがあります。`,
    );
  }

  // 外挿は current を基準に前後へ伸ばすので、循環は current.map が先頭でなければならない。
  // deriveCycle をどこから辿って作った Cycle を渡されても正しく動くよう、ここで回し直す。
  // （この整列を呼び出し側の責任にすると、ずれた Cycle を渡されたときに
  //   エラーにならず「1日ぶんの並びが静かにずれた表」が出てしまう）
  const pivot = cycle.maps.indexOf(current.map);
  let cycleMaps: string[];
  if (pivot < 0) {
    cycleMaps = next === null ? [current.map] : [current.map, next.map];
    warnings.push(
      `現在のマップ ${current.map} が循環 [${cycle.maps.join(', ')}] に含まれていません。観測した2枠だけで外挿します。`,
    );
  } else {
    cycleMaps = [...cycle.maps.slice(pivot), ...cycle.maps.slice(0, pivot)];
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
