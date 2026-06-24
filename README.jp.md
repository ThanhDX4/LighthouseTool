# Lighthouse 監査ツール

複数のルートに対してLighthouse監査(median-of-N)を実行し、結果を1つのExcelワークブックにエクスポートする社内Webアプリケーション。

---

## 主な機能

### **Static Flowモード(デフォルト)**

- React + Vite設定フォーム(Basic Auth、フォームログインに対応)
- Fastify API: CSRF保護、バリデーション、レート制限、認証情報の暗号化、SSE進捗、JWTダウンロードトークン
- BullMQ Worker(`concurrency: 1`): 実行ごとに新しいChrome、フォームログインCookieの保持、`computeMedianRun`による中央値計算
- Excelエクスポート: `Summary`シート、ルート別シート、`Diagnostics`、`Run Configuration`

### **Manual Chrome Tabsモード** _(オプション)_

- 専用のChromeプロファイルで認証済みタブ(OTP/ログイン)を監査
- **ローカル・シングルユーザー専用** — デフォルトで無効、ループバック呼び出しのみ受け付け
- `MANUAL_CHROME_ENABLED=true`と`ALLOWED_HOSTS`(ドメインホワイトリスト)が必要
- Chromeプロファイルは再利用可能、実行間でログイン不要
- **プライバシー:** 表示URLは`origin + pathname`のみ(query/fragmentは保存しない)、HTMLエビデンスはデフォルトで無効

---

## インストール & 実行

### **必要要件**

- Node.js(LTS推奨)
- pnpm(corepack)
- Redis(ローカルまたはリモート)
- Chrome/Chromium

### **開発モード**

```bash
# 依存関係のインストール
corepack enable
pnpm install

# ターミナル1: API + UI(Vite開発サーバー)を起動
pnpm run dev

# ターミナル2: Workerを起動
pnpm run dev:worker
```

- **UI:** `http://localhost:5173` (APIプロキシ → `http://localhost:3000`)
- **シークレット未設定:** 自動的に開発用デフォルト値を使用

### **本番ビルド**

```bash
# アプリケーションをビルド
pnpm run build

# APIサーバー + Workerを起動
pnpm start
```

**注意:**

- `.env`に`ENCRYPTION_KEY`と`DOWNLOAD_TOKEN_SECRET`が必要(本番環境)
- APIサーバーのみ起動(Workerなし): `pnpm run start:server`

### **環境変数の設定**

```bash
# テンプレートから.envファイルを作成
cp .env.example .env

# ENCRYPTION_KEYを生成(32バイトbase64)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**重要な環境変数:**

- `ENCRYPTION_KEY`: 認証情報の暗号化(本番環境必須)
- `DOWNLOAD_TOKEN_SECRET`: ダウンロード用JWTトークン(本番環境必須)
- `ALLOWED_HOSTS`: ドメインホワイトリスト(推奨)
- `REDIS_URL`: Redis接続(デフォルト `redis://localhost:6379`)

---

## Manual Chrome Tabsの設定

### **モードの有効化**

```bash
MANUAL_CHROME_ENABLED=true
ALLOWED_HOSTS=example.com,staging.example.com
MANUAL_CHROME_PROFILE_DIR=.lh-audit/chrome-profile  # デフォルト
MANUAL_CHROME_PORT=9222                              # デフォルト
MANUAL_CHROME_AUTO_OPEN=true                         # サーバー起動時に自動でChromeを開く
```

### **使用方法**

1. **Chromeプロファイルを開く:**
    - UI → `Manual Chrome Tabs`を選択 → `Open Chrome profile`をクリック
    - または`MANUAL_CHROME_AUTO_OPEN=true`でサーバー起動時に自動起動

2. **手動認証:**
    - タブ内でログイン/OTP実行(`ALLOWED_HOSTS`のドメインのみ)
    - タブを開いたままにする

3. **監査を実行:**
    - `Scan tabs`をクリック → 監査するタブを選択 → 実行
    - Chrome は監査後も開いたまま、再ログイン不要

### **セキュリティ & プライバシー**

- **URLサニタイゼーション:** `origin + pathname`のみ保存、クエリ文字列/フラグメントは保存しない
- **HTMLエビデンス:** デフォルトで無効、有効化には同意チェックボックスが必要
    - 制限: `MANUAL_CHROME_MAX_EVIDENCE_BYTES`、`MANUAL_CHROME_MAX_EVIDENCE_FILES`
- **監査禁止URL:** OTP、パスワードリセットトークン、セッショントークンをクエリ/フラグメントに含むURL

### **エラー処理**

| 状況                         | 解決方法                                           |
| ---------------------------- | -------------------------------------------------- |
| Chrome起動中にサーバー再起動 | Chromeを閉じる → `Open Chrome profile`を再クリック |
| ポート`9222`が使用中         | 他のChromeを閉じるか`MANUAL_CHROME_PORT`を変更     |
| 自動起動失敗                 | ログを確認、手動で`Open Chrome profile`をクリック  |

---

## テスト & 検証

### **テストの実行**

```bash
# 型チェック
pnpm run typecheck

# ユニットテスト
pnpm test

# ビルド検証
pnpm run build
```

### **受け入れテスト** _(ステージング)_

- 3パス × 2フォームファクター × 5実行
- Basic Auth成功/失敗
- フォームログインフィクスチャ
- Chromeクラッシュリカバリー
- 24時間クリーンアップ検証

**ドメイン制限:**

```bash
ALLOWED_HOSTS=staging.example.com,example.com
```

---

## プロジェクト構成

```
.
├── src/
│   ├── api/          # Fastify APIサーバー
│   ├── worker/       # BullMQ Worker
│   └── web/          # React + Vite UI
├── .env.example      # 環境変数テンプレート
├── package.json
└── README.md
```

---

## トラブルシューティング

### **Redis接続失敗**

```bash
# Redisが起動しているか確認
redis-cli ping

# またはローカルにRedisをインストール
# macOS: brew install redis && brew services start redis
# Ubuntu: sudo apt install redis-server && sudo systemctl start redis
```

### **Chromeが見つからない**

- Chrome/Chromiumがインストールされているか確認
- またはPuppeteer Chromeをインストール: `npx puppeteer browsers install chrome`

### **ポート競合**

- APIポート`3000`: `.env`の`PORT`を変更
- Chrome CDPポート`9222`: `MANUAL_CHROME_PORT`を変更
- Vite開発ポート`5173`: `vite.config.ts`で変更

---

## ライセンス & サポート

社内ツール - FPT Software専用
