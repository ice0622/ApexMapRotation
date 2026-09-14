# ApexMapRotation

Apex Legends の**ランクマップのローテーションを1日1回まとめて** Discord チャンネルに投稿する仕組み。
常時起動サーバーは使わず、GitHub Actions のスケジュール実行（バッチ）で完結するのでホスティングコストはゼロ。

## 仕組み

```
[投稿ジョブ] JST 0:00
  → Apex Legends API を呼ぶ（平常時、APIを叩くのはここだけ）
  → ranked.current / ranked.next を「絶対時刻付きの枠」として取得
  → state の循環順を使って足りない枠を外挿し、当日 0:00〜24:00 を組む
  → 時刻表として1通だけ Discord Webhook に投稿

[観測ジョブ] 毎時（学習が必要なときだけ動く）
  → 循環が確定済みなら API を叩かず即終了
  → 未確定なら観測してエッジを1本記録する（Discord へは何も送らない）
```

### なぜ2つに分かれているか

**API が1回で返すのは `current` と `next` の隣接1組だけ**です。3マップの循環を確定するには、
違う枠にいるタイミングで複数回観測するしかありません。投稿は1日1回で足りますが、
学習にはそれより細かい観測が要る。この2つは要求する頻度が違うので分けています。

ただしローテーションは一定周期の規則的な並びなので、**いったん循環が確定すればあとは計算で出せます**。
観測ジョブは確定済みなら API を叩かずに終了するため、**平常時の API 呼び出しは1日1回だけ**です。

シーズンでローテが変わると、その1日1回の観測が既存のエッジと矛盾します。すると学習が
リセットされて未確定に戻り、観測ジョブがまた動き出し、半日ほどで再確定してまた静かになります。

## ディレクトリ構成

```
src/
├── jobs/                   # 実行の入り口（1ジョブ = 1ファイル）
│   ├── postSchedule.ts     #   1日のスケジュール投稿
│   └── observeRotation.ts  #   循環順の学習（通知なし）
└── lib/                    # ジョブ間で共有する部品
    ├── apexApi.ts          #   Apex Legends Status API クライアント（キー秘匿込み）
    ├── rotation.ts         #   外挿・循環の導出・JSTの日境界
    ├── mockRotation.ts     #   ダミーデータ
    ├── discord.ts          #   Discord Webhook 送信
    ├── state.ts            #   state/ の読み書き
    └── messages.ts         #   通知の文面（見た目を変えるならここ）
state/                      # 学習したエッジ・投稿済み日付（Actions が自動 commit）
tsconfig.json               # 型チェック用（ビルドには使わない）
.github/workflows/          # ジョブごとのワークフロー
```

TypeScript で書かれていますが**ビルドはありません**。Node 24 が `.ts` をそのまま実行します
（ネイティブ type stripping）。`tsc` は型チェック専用です（`npm run typecheck`）。

## 通知メッセージ

```
今日のランクマップ 9/14(月)
22:00-02:30 ストームポイント
02:30-07:00 ワールズエッジ
07:00-11:30 Eディストリクト
11:30-16:00 ストームポイント
16:00-20:30 ワールズエッジ
20:30-01:00 Eディストリクト
```

- 0時をまたぐ枠は**切り詰めません**。最初と最後の枠は前後の日にはみ出していますが、時刻はそのまま出します（上から順に読めば分かるため）。
- 将来 X(Twitter) にそのまま流せるように、**マークダウンを使わず**マップ名は**日本語のみ**にしています。英名併記にすると X の 280 カウントを超えるためです。
- 280 を超える場合（枠が3時間以下に短くなったシーズンなど）は、終了時刻を省いた短縮形へ自動で切り替わります。

通知の文面はすべて [src/lib/messages.ts](src/lib/messages.ts) に集約しています。
見出しや区切り記号を変えたいときは `TEXT` 定数を、日本語マップ名を追加したいときは `JP_MAP_NAMES` を編集してください。

## セットアップ

1. **Discord Webhook を作成**
   対象チャンネル → 連携 → Webhook → 新しいWebhook → URLをコピー。
   ※ Webhook URL は知っている人が誰でも投稿できるため、秘密として扱ってください。

2. **GitHub のシークレットを登録**
   リポジトリの **Settings → Secrets and variables → Actions** に登録：

   | シークレット名 | 内容 |
   |---|---|
   | `DISCORD_WEBHOOK_URL` | 通知先チャンネルの Webhook URL |
   | `APEX_API_KEY` | Apex Legends Status の APIキー（後から追加でOK） |

   `APEX_API_KEY` を登録するまでは自動でモックモードになります。

3. **Actions を有効化**
   Actions タブでワークフローを有効化すれば、毎日 JST 0:00 の投稿が動き始めます。

## 実行スケジュール

| ワークフロー | cron（UTC） | 実際にすること |
|---|---|---|
| [post-schedule.yml](.github/workflows/post-schedule.yml) | `0 15,16,17 * * *` | JST 0:00 に投稿。1:00 / 2:00 は遅延・欠落に対するリトライ |
| [observe-rotation.yml](.github/workflows/observe-rotation.yml) | `0 * * * *` | 毎時。循環が確定していれば API を叩かず即終了 |

**GitHub の schedule は宣言どおりには実行されません。** このリポジトリの実測では
`*/5 * * * *`（本来1日288回）が **約3時間に1回まで間引かれていました**（8日間で60回＝3%）。
そのため設計は「時刻はあてにせず、抜けても次で取り返す」前提になっています。

- 投稿の重複はキャッシュに置いた投稿済み日付で防ぐので、リトライが全部走っても投稿は1日1回。
- 観測は間引かれて2〜3時間おきになっても、枠長（4.5時間）より短ければ全ての枠を `current` として捉えられます。
- 2つのワークフローは同じ state を書くため、同一の `concurrency` グループ（`rotation-state`）で直列化しています。

## 手動実行

Actions タブから **Run workflow** で実行できます。

**Post Apex ranked map schedule**
- `force: true` — 本日投稿済みでも再投稿する
- `use_mock: true` — APIキー無しでもダミーデータで Discord 送信を確認できる
- `dry_run: true` — 送信せず、文面と文字数をログにだけ出す

**Observe Apex ranked rotation**
- `force: true` — 確定済みでも観測する
- `use_mock: true` — ダミーデータで動作確認

```bash
gh workflow run post-schedule.yml -f dry_run=true
gh workflow run observe-rotation.yml -f force=true
```

## ローカル開発

**Node 24 以上が必要です**（`.ts` の直接実行のため）。実行だけなら `npm install` は不要です。

```bash
cp .env.example .env
# .env の DISCORD_WEBHOOK_URL に本物の Webhook を入れると実際に投稿が届く

npm run post:dry      # 送信せず文面と文字数だけ出す（フォーマット調整用）
npm run post:mock     # ダミーデータで実際に Discord へ送る
npm run post          # 通常実行
npm run observe       # 観測（確定済みなら何もしない）
npm run observe:mock  # ダミーデータで観測

npm ci                # 型チェックを使う場合のみ（typescript を入れる）
npm run typecheck     # 型チェック（CI でも push 時に自動実行）
```

`npm run post:dry` は state を書き換えないので、フォーマットの試行錯誤はこれで回してください。
枠が短いときの短縮形を試すには `MOCK_SLOT_MINUTES=180 npm run post:dry` のように指定します。

> ローカル実行は作業ツリーの `state/rotation.json` を書き換えますが、**コミットはしません**（コミットは GitHub Actions の役割）。
> テストで汚れたら `git checkout -- state/rotation.json` で戻してください。
> 同じ日に2回投稿を試すときは `FORCE=true` を付けないと「投稿済み」で止まります。

## モックモード

`APEX_API_KEY` が未設定、または `USE_MOCK=true` のときは実APIを呼ばずダミーデータを使います。
前日22時を起点に4.5時間の枠を並べ、実行時刻を含む枠を `current` とするので、本番と同じ形の
スケジュールが1日分出ます。`MOCK_SLOT_MINUTES` で枠の長さを変えられます。

## 依存関係とサプライチェーン対策

- **実行時依存はゼロ**です。本番（Actions の cron）は `npm install` 自体を行わず、Node 24 が `.ts` を直接実行します。
- devDependencies は `typescript` と `@types/node` の2つだけ（型チェック専用・バージョン完全固定・どちらも install スクリプトなし）。
- [.npmrc](.npmrc) で `ignore-scripts=true`（install スクリプトの自動実行を禁止）と `save-exact=true` を設定済み。
- CI の型チェック（[typecheck.yml](.github/workflows/typecheck.yml)）は `permissions: contents: read` のみで、シークレットにアクセスできません。

## 状態管理

### リポジトリに置くもの: [state/rotation.json](state/rotation.json)

観測したエッジ（有向辺）だけを保存します。

```json
{ "edges": { "Storm Point": { "next": "World's Edge", "seenAt": "..." }, ... } }
```

**並びを配列で持たず、エッジの集合で持っている**のが設計の要点です。
配列だと `[A, B, C]` まで並んでも本当は `[A, B, D, C]` かもしれず、**循環が閉じたかを判定できません**。
エッジなら出発点に戻れたかで確定を判定でき、確定するまで API を叩き続けるという制御ができます。

判定は「閉じていること」だけでは足りません。前のローテーションの残骸が1本混じっていると
古い循環だけで閉じてしまうので、**観測した全マップがその循環に乗っていること**まで確認します
（`isCycleConfirmed`）。循環が閉じた時点で、乗っていないマップは捨てます。

観測が既存のエッジと食い違った場合は、そのエッジだけを直すのでは足りません。
`A→B→C→A` が `A→C→B→A` に変わったとき `A→C` だけ上書きすると、古い `C→A` が残って
「`A→C→A` の2マップ循環」として誤って確定してしまいます。矛盾は「古いモデルはもう信用できない」
という証拠なので、**全エッジを破棄して学習し直します**。

初期値には git 履歴で実測した `Storm Point → World's Edge → E-District` を入れてあります。

### キャッシュに置くもの: 投稿済みの日付

「その日はもう投稿したか」の記録は `actions/cache` に置き、**コミットしません**。

毎日変わる値なのでコミットすると履歴が1日1件ずつ膨らむ一方、失っても影響は
「その日に最大3回投稿する」だけで翌日には自然に戻ります。消えてよい置き場所が向いています。
キャッシュは7日アクセスが無いと消えますが、毎日読むので実質消えません。

### コミットの頻度

`state/rotation.json` はローテーションを学習したときしか変わりません。つまり
`github-actions[bot]` のコミットは**シーズンが変わったときなど年に数回だけ**です。
同じ観測を繰り返しただけでは `seenAt` も含めて書き直さないので、中身が同じコミットは出ません。

## 注意点

- Apex Legends API は非公式サービスで公式のSLAはありません。取得に失敗したときは投稿せずスキップし、同じ日の次のリトライ枠で再試行します。
- Discord への送信に失敗した場合は投稿済みの記録を進めないので、次のリトライ枠で再送されます（学習結果は投稿の成否と切り離して保存されるため、観測はやり直しになりません）。
- **実測できるのは `current` と `next` の2枠だけで、それ以降は外挿です。** ローテーションの長さや並びが予告なく変わると当日分がずれることがあります。ずれは Actions のログに警告として出て、翌日以降は自動で補正されます（Discord の文面には出しません）。
- リポジトリに **60日間** 活動が無いとスケジュールは自動停止します（GitHub仕様）。手動実行や任意のコミットで復帰します。

## クレジット

Data provided by [Apex Legends Status](https://apexlegendsapi.com).
