// 1日分のローテーションを組み立てるモジュール。
//
// API が返すのは「今の枠」と「次の枠」の2つだけなので、1日分（4.5時間枠なら6〜7枠）は
// ここで外挿する。材料は2つ:
//   枠長   … API の current / next の実測（最優先。推測値は使わない）
//   並び順 … キャッシュに覚えており、実行のたびに観測で検算・更新する
//
// 並びは実行のたびに API の観測で検算し、ずれていたら自動で直す（applyObservation）。
// ランクのローテーションは「順序は変わらず、マップの顔ぶれだけが入れ替わる」ので、
// A -> D を1回観測すれば「A の次だった B が D になった」と確定できる。
// つまり集合を貯めて一巡待つ必要がなく、枠が変わった瞬間に復旧する。

import type { RankedRotation, RotationSlot } from './apexApi.ts';

// ---------------------------------------------------------------------------
// ローテーションの初期値（キャッシュが空のときだけ使う種）
// ---------------------------------------------------------------------------
//
// 生きている並びは Actions のキャッシュ側にあり、実行のたびに観測で更新される。
// ここを人が書き換える必要は無い。キャッシュを失ったときの出発点でしかなく、
// これが古くても数時間の観測で正しい並びへ復帰する。
//
// 名前は API が返す英語表記に合わせること（日本語表示は messages.ts の JP_MAP_NAMES）。
export const INITIAL_ROTATION = ["World's Edge", 'Storm Point', 'E-District'];

// Asia/Tokyo はサマータイムが無いので固定オフセットで正確に計算できる。
// Intl で日付を分解して組み直すより単純で、丸め誤差も入らない。
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export const DAY_MS = 24 * 60 * 60 * 1000;

// 枠長が壊れた値（極端に短い等）でも無限ループしないための上限。
const MAX_SLOTS_PER_DAY = 48;
// 観測が矛盾していても辿り続けないための上限。
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

// 観測（map -> 次のmap）を辿って循環が閉じるか試す。閉じたらその並びを返す。
// 途中で未知に当たる・別の場所へ合流する場合は null。
// 閉路に乗らなかったマップは前のローテーションの残骸なので落とす。
function closeCycle(observed: Record<string, string>, startMap: string): string[] | null {
  const maps = [startMap];
  const visited = new Set([startMap]);
  let node = startMap;

  while (maps.length <= MAX_CYCLE_LENGTH) {
    const next = observed[node];
    if (next === undefined) return null;
    if (next === startMap) return maps;
    if (visited.has(next)) return null;
    maps.push(next);
    visited.add(next);
    node = next;
  }
  return null;
}

export type CycleState = {
  // 判別できていれば並び、できていなければ空配列。
  cycle: string[];
  // 判別できないあいだ貯めておく観測。判別できたら空に戻す。
  observed: Record<string, string>;
  // 置き換え仮説で組んだ直後で、まだ次の観測で裏が取れていない状態。
  provisional: boolean;
};

export type CycleUpdate = CycleState & { note: string | null };

// 観測を貯め、循環が閉じたら並びとして採用する。
function accumulate(
  observed: Record<string, string>,
  current: string,
  next: string,
): CycleUpdate {
  const acc = { ...observed, [current]: next };
  const rebuilt = closeCycle(acc, current);
  if (rebuilt !== null) {
    return {
      cycle: rebuilt,
      observed: {},
      provisional: false,
      note: `観測から並びを組み直しました: ${rebuilt.join(' -> ')}`,
    };
  }
  const known = Object.entries(acc).map(([from, to]) => `${from}->${to}`).join(', ');
  return { cycle: [], observed: acc, provisional: false, note: `並びを判別中（判明分: ${known}）` };
}

// 観測した1組（current -> next）で、覚えている並びを検算・更新する。
//
// ランクのローテーションは順序が変わらず、マップの顔ぶれだけが入れ替わる。
// だから「A の次が D だった」という観測1つで、A の次にいたマップが D に
// 置き換わったと推測できる。ただしこれは「マップ数が変わっていない」ことを
// 前提にした仮説なので、次の観測で裏を取るまでは暫定として扱う。
//
// 裏が取れなければ（マップ数が増減した・複数同時に入れ替わった・順序が変わった）、
// 観測を貯めて循環が閉じるのを待つ方式へ落ちる。ここで置き換えを試し続けると、
// マップが増えた場合に延々と入れ替えを繰り返して収束しない。
export function applyObservation(
  state: CycleState,
  current: string,
  next: string | null,
): CycleUpdate {
  const { cycle, observed, provisional } = state;
  if (next === null || next === current) return { ...state, note: null };

  const currentIdx = cycle.indexOf(current);
  const nextIdx = cycle.indexOf(next);

  // 1) 覚えている並びと一致した。暫定だったものはここで確定する。
  if (currentIdx >= 0 && cycle[(currentIdx + 1) % cycle.length] === next) {
    return {
      cycle,
      observed: {},
      provisional: false,
      note: provisional ? `並びを確認しました: [${cycle.join(' -> ')}]` : null,
    };
  }

  // 2) 暫定の並びが外れた。置き換え1回では説明できない変化なので、観測を貯めにいく。
  if (provisional) return accumulate({}, current, next);

  // 3) 1マップだけ入れ替わったという仮説を立てる。
  if (currentIdx >= 0 && nextIdx < 0) {
    const replaced = cycle[(currentIdx + 1) % cycle.length];
    return {
      cycle: cycle.map((map) => (map === replaced ? next : map)),
      observed: {},
      provisional: true,
      note: `ローテーションが変わった可能性: ${replaced} -> ${next}（${current} の次）。暫定で反映します`,
    };
  }
  if (nextIdx >= 0 && currentIdx < 0) {
    const replaced = cycle[(nextIdx - 1 + cycle.length) % cycle.length];
    return {
      cycle: cycle.map((map) => (map === replaced ? current : map)),
      observed: {},
      provisional: true,
      note: `ローテーションが変わった可能性: ${replaced} -> ${current}（${next} の前）。暫定で反映します`,
    };
  }

  // 4) 仮説を立てられない。観測を貯める。
  return accumulate(observed, current, next);
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
