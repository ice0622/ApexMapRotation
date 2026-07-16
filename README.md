# ApexMapRotation

Apex Legends の**ランクマップが変わったときだけ** Discord チャンネルに自動通知する仕組み。
常時起動サーバーは使わず、GitHub Actions のスケジュール実行（バッチ）で完結するのでホスティングコストはゼロ。

## 仕組み

```
GitHub Actions (5分おきの schedule)
  → Apex Legends API (maprotation, version=2) を呼ぶ
  → ranked.current.map（現在のランクマップ）を取得
  → state/last_map.json の前回値と比較
  → 変化があったときだけ Discord Webhook に通知
  → 新しいマップ名を state に保存（変化時のみ commit & push）
```

> **5分おきは「監視間隔」であって「通知間隔」ではありません。**
> チェックは5分おきに走りますが、Discord への通知は**現在のマップが実際に変わったときだけ**です。変化がなければ何も送信しません。

## 通知メッセージ

**マップが変わったとき（自動）:**

```
🗺️ ランクマップが変わりました
以前
E-District（Eディストリクト）
今
World's Edge（ワールズエッジ）
次（21:45）
Storm Point（ストームポイント）
```

「次（21:45）」の時刻は次にマップが切り替わる時刻（日本時間）です。ラベル（以前・今・次）は Discord 上では太字で表示されます。

**手動で現在の状況を確認したとき（status モード）:**

```
🗺️ 現在のランクマップ情報
今
World's Edge（ワールズエッジ）
次（21:45）
Storm Point（ストームポイント）
（次の切替まで 約1時間23分）
```

マップ名は「英語（日本語）」併記。日本語表記の無い新規マップは英語のみで表示します。

通知の文面はすべて [src/messages.js](src/messages.js) に集約しています。
文言やラベルを変えたいときは `TEXT` 定数を、日本語マップ名を追加したいときは `JP_MAP_NAMES` を編集してください。

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
   Actions タブでワークフローを有効化すれば、5分おきのスケジュールが動き始めます。

## 手動実行

Actions タブ → **Check Apex ranked map** → **Run workflow** から手動実行できます。

- `action: check` — その場でチェックし、変化していれば通知（通常と同じ挙動）。
- `action: status` — 現在のマップ・次のマップ・残り時間を**今すぐ**通知（変化に関係なく送信、state は更新しない）。
- `use_mock: true` — APIキー無しでもダミーデータで Discord 送信を確認できる。

コマンドラインからは [GitHub CLI](https://cli.github.com/) でも実行できます：

```bash
gh workflow run check-map.yml -f action=status
```

## ローカル開発

```bash
cp .env.example .env
# .env の DISCORD_WEBHOOK_URL に本物の Webhook を入れると実際に通知が届く

npm run check         # 通常のチェック（変化時のみ通知）
npm run check:mock    # ダミーデータで変更通知をテスト
npm run status        # 現在の状況＋残り時間を通知
npm run status:mock   # ダミーデータでステータス通知をテスト
```

`npm run check:mock` を2回実行すると、1回目は state をシード（通知なし）、2回目でマップが変わったとみなして通知が届きます。

> ローカル実行は作業ツリーの `state/last_map.json` を書き換えますが、**コミットはしません**（コミットは GitHub Actions の役割）。
> テストで汚れたら `git checkout -- state/last_map.json` で戻してください。

## モックモード

`APEX_API_KEY` が未設定、または `USE_MOCK=true` のときは実APIを呼ばずダミーデータを使います。

- **自動モック**（キー未設定）: 固定マップを返すのでスケジュール実行は静かなまま。
- **明示モック**（`USE_MOCK=true`）: 前回の「次のマップ」を返すので必ず変化が起き、通知の疎通を確認できます。

## 状態管理

前回の現在マップ名は [state/last_map.json](state/last_map.json) に保存します。変化があったときだけ
`github-actions[bot]` 名義で自動 commit & push されます。

## 注意点

- Apex Legends API は非公式サービスで公式のSLAはありません。取得に失敗したときは通知せずスキップします（誤検知防止）。
- GitHub Actions のスケジュールはベストエフォートで、数分〜十数分の遅延や稀に欠落があります。ランクマップの変化は数時間単位なので実用上は問題ありません。
- リポジトリに **60日間** 活動が無いとスケジュールは自動停止します（GitHub仕様）。手動実行や任意のコミットで復帰します。

## クレジット

Data provided by [Apex Legends Status](https://apexlegendsapi.com).
