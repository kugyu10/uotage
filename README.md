# uotage

ステップ配信／デッドラインファネル特化型の自作マーケティングツール。

仕様は [`docs/要件定義書.md`](docs/要件定義書.md) を唯一の正とする。
用語は UTAGE のユビキタス言語に準拠する（要件定義書 1.5 の対応表）。

## 構成

| 領域 | 採用技術 |
| :--- | :--- |
| フロント／API | Next.js 16 (App Router) + Vercel |
| DB | Supabase (PostgreSQL) |
| 管理画面の認証 | Supabase Auth (Magic Link) |
| メール配信 | Resend（Batch API） |
| 送信キュー | Supabase pg_cron + Edge Functions（1分間隔） |
| 決済 | Stripe (Checkout + Webhook) |

## セットアップ

```bash
npm install
cp .env.example .env.local   # 値を埋める
npm run probe                # 疎通・認証の確認
npm run dev
```

`npm run probe` は Supabase / Resend / Stripe に実際にリクエストを投げ、
キーが有効か、**送信ドメインが Resend で verified になっているか**までを判定する。
実装に入る前にこれが全て緑になっていること。

### 事前に人手が必要なもの

コードでは片付かず、ダッシュボードや DNS の操作が要るもの。

1. **Supabase** — プロジェクト作成、API キーの取得
2. **Resend** — API キー発行、独自ドメインの追加と **SPF / DKIM / DMARC の DNS レコード登録**
   （伝播に数分〜数時間かかる。ここが最も待たされる）
3. **Stripe** — テストキーと Webhook シークレットの取得
4. **外部予約ツール** — TimeRex / Calendly 等の予約 URL

## スクリプト

| コマンド | 内容 |
| :--- | :--- |
| `npm run dev` | 開発サーバー |
| `npm run build` | 本番ビルド |
| `npm run typecheck` | 型検査（`next build` で生成される route 型に依存するため、初回は build を先に実行する） |
| `npm run lint` | ESLint |
| `npm run probe` | 疎通・認証チェック |
