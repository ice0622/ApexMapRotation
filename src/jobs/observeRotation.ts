// マップの循環順を学習するためだけのジョブ。Discord へは何も送らない。
//
// なぜ投稿ジョブと分けるか:
//   API が1回の呼び出しで返すのは current と next の隣接1組だけ。
//   3マップの循環を確定するには、違う枠にいるタイミングで複数回観測するしかない。
//   投稿は1日1回でよいが、学習だけはそれより細かい観測が要る。
//
// なぜ毎回 API を叩かないか:
//   ローテーションは一定周期の規則的な並びなので、いったん循環が確定すれば
//   あとは計算で出せる。確定済みなら API を叩かずに即終了する。
//   平常時の API 呼び出しは投稿ジョブの1日1回だけになる。
//
//   シーズンでローテが変わると、その1日1回の観測が既存のエッジと矛盾して
//   学習がリセットされる → 未確定に戻る → このジョブがまた観測を始め、
//   枠長より短い間隔で回るので半日ほどで再確定する。

import { fetchRankedRotation } from '../lib/apexApi.ts';
import type { RankedRotation } from '../lib/apexApi.ts';
import { readRotationState, writeRotationState } from '../lib/state.ts';
import { getMockRotation } from '../lib/mockRotation.ts';
import { deriveCycle, isCycleConfirmed, jstDayStart, recordEdge } from '../lib/rotation.ts';

async function main(): Promise<number> {
  const apiKey = (process.env.APEX_API_KEY ?? '').trim();
  const useMock = process.env.USE_MOCK === 'true' || apiKey === '';
  const force = process.env.FORCE === 'true';

  const state = await readRotationState();

  // 確定済みなら API を叩かない。ここが「観測を間引く」仕組みの本体。
  if (!force && isCycleConfirmed(state.edges)) {
    const known = deriveCycle(state.edges, Object.keys(state.edges)[0]);
    console.log(`循環は確定済み（${known.maps.join(' -> ')}）。API は叩きません。`);
    return 0;
  }

  const nowMs = Date.now();
  let rotation: RankedRotation;
  try {
    rotation = useMock ? getMockRotation(jstDayStart(nowMs)) : await fetchRankedRotation(apiKey);
  } catch (err) {
    // 次の観測で取り直せばよいので失敗扱いにしない。
    console.error(`ローテーション取得に失敗（スキップ）: ${(err as Error).message}`);
    return 0;
  }

  const recorded = recordEdge(state.edges, rotation.current, rotation.next, nowMs);
  if (recorded.reset) {
    console.warn('警告: ローテーションの並びが変わりました。学習済みのエッジを破棄して学習し直します。');
  }
  const cycle = deriveCycle(recorded.edges, rotation.current.map);
  const slotMinutes = Math.round((rotation.current.endMs - rotation.current.startMs) / 60_000);

  console.log(
    `観測: ${rotation.current.map} -> ${rotation.next?.map ?? '(next なし)'} / 枠長=${slotMinutes}分 / ` +
      `循環=[${cycle.maps.join(' -> ')}]${cycle.closed ? '（確定）' : '（未確定）'}`,
  );

  // 内容が変わったときだけ書く。毎回書くと updatedAt だけの差分で
  // 中身が同じコミットが積み上がってしまう。
  if (!recorded.changed) {
    console.log('エッジに変化なし。書き込みません。');
    return 0;
  }

  await writeRotationState(recorded.edges);
  console.log(
    isCycleConfirmed(recorded.edges)
      ? '循環が確定しました。次回以降は API を叩きません。'
      : 'エッジを更新しました。まだ未確定なので観測を続けます。',
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('想定外のエラー:', (err as Error)?.message ?? err);
    process.exit(1);
  });
