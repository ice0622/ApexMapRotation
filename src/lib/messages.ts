// Discord に送るメッセージの「文面」をまとめたモジュール。
// 通知の文言・レイアウトを変えたいときは、このファイルだけを編集すればよい。
//
// 文面は X(Twitter) にもそのまま流せる形に保つ。そのための制約が3つある:
//   - マークダウン（**太字** など）を使わない。X では記号がそのまま表示される。
//   - マップ名は日本語のみ。英名を併記すると 280 カウントを超える。
//   - 280 を超えたら終了時刻を落とした短縮形へ自動で切り替える。

import type { RotationSlot } from './apexApi.ts';

// 英語マップ名 → 日本語表記。未登録のマップは英語のまま表示する。
export const JP_MAP_NAMES: Record<string, string> = {
  "World's Edge": 'ワールズエッジ',
  'E-District': 'Eディストリクト',
  'Storm Point': 'ストームポイント',
  'Broken Moon': 'ブロークンムーン',
  'Kings Canyon': 'キングスキャニオン',
  'Olympus': 'オリンパス',
};

// 見出し・記号。見た目の調整はここを書き換える。
export const TEXT = {
  title: '今日のランクマップ',
  rangeSeparator: '-',
  untilSuffix: 'まで',
  // 並びが判別できず、確定した枠だけを出すときに最後へ足す1行。
  partialNote: '※新しいマップを確認中のため、ここまで',
};

// 表示時刻のタイムゾーン。
export const TIME_ZONE = 'Asia/Tokyo';

// X の1ポストあたりの上限カウント。
export const TWITTER_LIMIT = 280;

const HHMM = new Intl.DateTimeFormat('ja-JP', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: TIME_ZONE,
});

// "9/14(月)" を返す。
const MONTH_DAY = new Intl.DateTimeFormat('ja-JP', {
  month: 'numeric',
  day: 'numeric',
  weekday: 'short',
  timeZone: TIME_ZONE,
});

// "World's Edge" -> "ワールズエッジ"。未登録なら英語のまま。
export function mapLabel(name: string): string {
  return JP_MAP_NAMES[name] ?? name;
}

// X の文字数カウント。ラテン文字などは1、日本語や絵文字は2で数える。
// 今は送信しないが、フォーマットが 280 に収まっているかの確認に使う。
export function twitterWeight(text: string): number {
  let weight = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const isSingleWidth =
      code <= 0x10ff ||
      (code >= 0x2000 && code <= 0x200d) ||
      (code >= 0x2010 && code <= 0x201f) ||
      (code >= 0x2032 && code <= 0x2037);
    weight += isSingleWidth ? 1 : 2;
  }
  return weight;
}

function hhmm(atMs: number): string {
  return HHMM.format(new Date(atMs));
}

function render(
  slots: RotationSlot[],
  dayStartMs: number,
  compact: boolean,
  partial: boolean,
): string {
  const lines = [`${TEXT.title} ${MONTH_DAY.format(new Date(dayStartMs))}`];
  slots.forEach((slot, index) => {
    // 日をまたぐ枠も時刻をそのまま出す。1日の時刻表として上から読めば
    // 最初と最後の枠が前後の日にはみ出しているのは読み取れる。
    const start = hhmm(slot.startMs);
    const end = hhmm(slot.endMs);
    const name = mapLabel(slot.map);
    if (!compact) {
      lines.push(`${start}${TEXT.rangeSeparator}${end} ${name}`);
      return;
    }
    // 短縮形では終了時刻を次の行の開始時刻から読むので、最終行だけ補う。
    const tail = index === slots.length - 1 ? `（${end}${TEXT.untilSuffix}）` : '';
    lines.push(`${start} ${name}${tail}`);
  });
  if (partial) lines.push(TEXT.partialNote);
  return lines.join('\n');
}

// 1日のスケジュール:
//   今日のランクマップ 9/14(月)
//   22:00-02:30 ストームポイント
//   02:30-07:00 ワールズエッジ
//   ...
//   20:30-01:00 Eディストリクト
// partial=true は「並びが分からず確定分だけ」の状態。注記を1行足す。
export function buildScheduleMessage(
  slots: RotationSlot[],
  dayStartMs: number,
  partial: boolean,
): string {
  const full = render(slots, dayStartMs, false, partial);
  if (twitterWeight(full) <= TWITTER_LIMIT) return full;
  // 枠長が短いシーズンだと時間帯レンジでは 280 を超える。終了時刻を落として収める。
  return render(slots, dayStartMs, true, partial);
}
