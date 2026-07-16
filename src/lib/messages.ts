// Discord に送るメッセージの「文面」をまとめたモジュール。
// 通知の文言・レイアウトを変えたいときは、このファイルだけを編集すればよい。

import type { RankedMap } from './apexApi.ts';

// 英語マップ名 → 日本語表記。未登録のマップは英語のまま表示する。
export const JP_MAP_NAMES: Record<string, string> = {
  "World's Edge": 'ワールズエッジ',
  'E-District': 'Eディストリクト',
  'Storm Point': 'ストームポイント',
  'Broken Moon': 'ブロークンムーン',
  'Kings Canyon': 'キングスキャニオン',
  'Olympus': 'オリンパス',
};

// 通知の見出し・ラベル。表示文言はここを書き換える。
export const TEXT = {
  changeTitle: '🗺️ ランクマップが変わりました',
  statusTitle: '🗺️ 現在のランクマップ情報',
  prevLabel: '以前',
  currentLabel: '今',
  nextLabel: '次',
  untilLabel: '次の切替まで',
};

// 「次（21:45）」の切替時刻の表示に使うタイムゾーン。
export const TIME_ZONE = 'Asia/Tokyo';

// "World's Edge" -> "World's Edge（ワールズエッジ）"、未登録なら英語のみ。
export function formatMap(name: string): string {
  const jp = JP_MAP_NAMES[name];
  return jp ? `${name}（${jp}）` : name;
}

// 分数 -> "約1時間23分" / "約45分"。null は null のまま返す。
export function humanizeMinutes(mins: number | null | undefined): string | null {
  if (mins == null || Number.isNaN(mins)) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `約${h}時間${m}分` : `約${m}分`;
}

// Discord の太字（マークダウン）。
function bold(text: string): string {
  return `**${text}**`;
}

// 残り分数から次の切替時刻を "21:45" 形式（TIME_ZONE 基準）で返す。不明なら null。
function formatSwitchTime(remainingMins: number | null): string | null {
  if (remainingMins == null || Number.isNaN(remainingMins)) return null;
  const at = new Date(Date.now() + remainingMins * 60_000);
  return new Intl.DateTimeFormat('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: TIME_ZONE,
  }).format(at);
}

// "次（21:45）" のラベル。切替時刻が不明なら "次" だけ。
function nextLabel(remainingMins: number | null): string {
  const time = formatSwitchTime(remainingMins);
  return time ? `${TEXT.nextLabel}（${time}）` : TEXT.nextLabel;
}

// マップ変更通知:
//   🗺️ ランクマップが変わりました
//   **以前**
//   E-District（Eディストリクト）
//   **今**
//   World's Edge（ワールズエッジ）
//   **次（21:45）**
//   Storm Point（ストームポイント）
export function buildChangeMessage(prevMap: string, current: RankedMap): string {
  const lines = [
    TEXT.changeTitle,
    bold(TEXT.prevLabel),
    formatMap(prevMap),
    bold(TEXT.currentLabel),
    formatMap(current.map),
  ];
  if (current.nextMap) {
    lines.push(bold(nextLabel(current.remainingMins)), formatMap(current.nextMap));
  }
  return lines.join('\n');
}

// ステータス通知（status モード）:
//   🗺️ 現在のランクマップ情報
//   **今**
//   World's Edge（ワールズエッジ）
//   **次（21:45）**
//   Storm Point（ストームポイント）
//   （次の切替まで 約1時間23分）
export function buildStatusMessage(current: RankedMap): string {
  const lines = [TEXT.statusTitle, bold(TEXT.currentLabel), formatMap(current.map)];
  if (current.nextMap) {
    lines.push(bold(nextLabel(current.remainingMins)), formatMap(current.nextMap));
  }
  const remaining = humanizeMinutes(current.remainingMins);
  if (remaining) lines.push(`（${TEXT.untilLabel} ${remaining}）`);
  return lines.join('\n');
}
