# ApexMapRotation

Apex Legends の**ランクマップのローテーションを1日1回まとめて** Discord チャンネルに投稿する仕組み。
常時起動サーバーは使わず、GitHub Actions のスケジュール実行（バッチ）で完結するのでホスティングコストはゼロ。

## 仕組み

```
JST 0:00
  → Apex Legends API を呼ぶ（1日1回だけ）
  → ranked.current / ranked.next を「絶対時刻付きの枠」として取得
  → RANKED_ROTATION（手で書いた並び）で足りない枠を外挿し、当日 0:00〜24:00 を組む
  → 時刻表として1通だけ Discord Webhook に投稿
```

**API が1回で返すのは `current` と `next` の隣接1組だけ**です。1日分（4.5時間枠なら6〜7枠）を
出すには残りを計算で補う必要があり、そのためにマップの並びが要ります。

並びは [src/lib/rotation.ts](src/lib/rotation.ts) の `RANKED_ROTATION` 定数に手で書きます。
自動学習させる作りも試しましたが、割に合いませんでした。API が隣接1組しか返さない以上、
循環を確定するには一巡（約13.5時間）観測し続けるしかなく、その間は誤った表を出してしまいます。
ローテーションが変わるのはシーズンごと＝年に数回なので、手で3行書き換えるほうが確実です。

代わりに「**定数が実際とずれていること**」だけは自動で検知します（後述）。

## シーズンでローテーションが変わったら

[src/lib/rotation.ts](src/lib/rotation.ts) の `RANKED_ROTATION` を書き換えます。

```ts
export const RANKED_ROTATION = ["World's Edge", 'Storm Point', 'E-District'];
```

- **順序が重要**です。この順に一定の長さずつ回り、末尾の次は先頭に戻ります。
- 名前は API が返す英語表記と完全に一致させてください（日本語表示は
  [src/lib/messages.ts](src/lib/messages.ts) の `JP_MAP_NAMES` が担当します）。
- マップが増減する場合は要素を足し引きするだけです。

### ずれていることは自動で分かります

毎日の実行が、API の返した `current → next` を `RANKED_ROTATION` と照合します。
食い違っていた場合は**投稿そのものは行ったうえでジョブを失敗扱いにします**。
ログに書くだけでは気づけませんが、ジョブが赤くなれば GitHub から通知が届きます。

```
警告: ローテーションが変わっています。API は "World's Edge" -> "E-District" を返しましたが、
      RANKED_ROTATION では "World's Edge" -> "Storm Point" です。
RANKED_ROTATION が実際のローテーションと一致していません。
投稿そのものは完了していますが、定数を直すまで失敗扱いにします。
```

照合できるのは1日1枠ぶんなので、全ての並びを確かめるには数日かかります。

## ディレクトリ構成

```
src/
├── jobs/
│   └── postSchedule.ts     # 実行の入り口
└── lib/
    ├── apexApi.ts          # Apex Legends Status API クライアント（キー秘匿込み）
    ├── rotation.ts         # RANKED_ROTATION・外挿・照合・JSTの日境界
    ├── mockRotation.ts     # ダミーデータ
    ├── discord.ts          # Discord Webhook 送信
    ├── postedMarker.ts     # 投稿済みの記録（Actions のキャッシュに置く）
    └── messages.ts         # 通知の文面（見た目を変えるならここ）
tsconfig.json               # 型チェック用（ビルドには使わない）
.github/workflows/
```

TypeScript で書かれていますが**ビルドはありません**。Node 24 が `.ts` をそのまま実行します
（ネイティブ type stripping）。`tsc` は型チェック専用です（`npm run typecheck`）。

**リポジトリに書き込むものはありません。** 永続データを持たないので、bot による
自動コミットは一切発生せず、ワークフローの権限も `contents: read` だけです。

## 通知メッセージ

```
今日のランクマップ 9/14(月)
22:00-02:30 ワールズエッジ
02:30-07:00 ストームポイント
07:00-11:30 Eディストリクト
11:30-16:00 ワールズエッジ
16:00-20:30 ストームポイント
20:30-01:00 Eディストリクト
```

- 0時をまたぐ枠は**切り詰めません**。最初と最後の枠は前後の日にはみ出していますが、時刻はそのまま出します。
- 将来 X(Twitter) にそのまま流せるように、**マークダウンを使わず**マップ名は**日本語のみ**にしています。英名併記にすると X の 280 カウントを超えるためです。
- 280 を超える場合（枠が3時間以下に短くなったシーズンなど）は、終了時刻を省いた短縮形へ自動で切り替わります。

文面はすべて [src/lib/messages.ts](src/lib/messages.ts) に集約しています。
見出しや区切り記号は `TEXT` 定数を、日本語マップ名は `JP_MAP_NAMES` を編集してください。

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

cron は `0 15,16,17 * * *`（UTC）＝ JST 0:00 / 1:00 / 2:00 の**3本**です。

**GitHub の schedule は宣言どおりには実行されません。** このリポジトリの実測では
`*/5 * * * *`（本来1日288回）が **約3時間に1回まで間引かれていました**（8日間で60回＝3%）。
そのため設計は「時刻はあてにせず、抜けても次で取り返す」前提になっています。

**投稿は1日1回です。** 投稿済みの日付を `actions/cache` に記録しており、同じ日の2本目以降は
何も送らずに終了します。この記録をコミットしないのは、毎日変わる値なので履歴が
1日1件ずつ膨らむ一方、失っても影響は「その日に最大3回投稿する」だけで翌日には戻るからです。
キャッシュは7日アクセスが無いと消えますが、毎日読むので実質消えません。

## 手動実行

Actions タブ → **Post Apex ranked map schedule** → **Run workflow**

- `force: true` — 本日投稿済みでも再投稿する
- `use_mock: true` — APIキー無しでもダミーデータで Discord 送信を確認できる
- `dry_run: true` — 送信せず、文面と文字数をログにだけ出す

```bash
gh workflow run post-schedule.yml -f dry_run=true
```

## ローカル開発

**Node 24 以上が必要です**（`.ts` の直接実行のため）。実行だけなら `npm install` は不要です。

```bash
cp .env.example .env
# .env の DISCORD_WEBHOOK_URL に本物の Webhook を入れると実際に投稿が届く

npm run post:dry      # 送信せず文面と文字数だけ出す（フォーマット調整用）
npm run post:mock     # ダミーデータで実際に Discord へ送る
npm run post          # 通常実行

npm ci                # 型チェックを使う場合のみ（typescript を入れる）
npm run typecheck     # 型チェック（CI でも push 時に自動実行）
```

枠が短いときの短縮形を試すには `MOCK_SLOT_MINUTES=180 npm run post:dry` のように指定します。
同じ日に2回投稿を試すときは `FORCE=true` を付けないと「投稿済み」で止まります
（ローカルの記録は `.cache/`。`rm -rf .cache` で消せます）。

## モックモード

`APEX_API_KEY` が未設定、または `USE_MOCK=true` のときは実APIを呼ばずダミーデータを使います。
前日22時を起点に4.5時間の枠を並べ、実行時刻を含む枠を `current` とするので、本番と同じ形の
スケジュールが1日分出ます。並びは本番と同じ `RANKED_ROTATION` を使います。

## 依存関係とサプライチェーン対策

- **実行時依存はゼロ**です。本番（Actions の cron）は `npm install` 自体を行わず、Node 24 が `.ts` を直接実行します。
- devDependencies は `typescript` と `@types/node` の2つだけ（型チェック専用・バージョン完全固定・どちらも install スクリプトなし）。
- [.npmrc](.npmrc) で `ignore-scripts=true`（install スクリプトの自動実行を禁止）と `save-exact=true` を設定済み。
- ワークフローの権限は `contents: read` のみです。

## 注意点

- Apex Legends API は非公式サービスで公式のSLAはありません。取得に失敗したときは投稿せずスキップし、同じ日の次のリトライ枠で再試行します。
- Discord への送信に失敗した場合は投稿済みの記録を進めないので、次のリトライ枠で再送されます。
- **実測できるのは `current` と `next` の2枠だけで、それ以降は `RANKED_ROTATION` からの外挿です。** 定数が古いと当日分がずれますが、ジョブが失敗扱いになるので気づけます。
- 枠の長さは API の実測値（`start` / `end`）をそのまま使うため、定数で持つ必要はありません。
- リポジトリに **60日間** 活動が無いとスケジュールは自動停止します（GitHub仕様）。手動実行や任意のコミットで復帰します。

## クレジット

Data provided by [Apex Legends Status](https://apexlegendsapi.com).
