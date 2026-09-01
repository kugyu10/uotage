import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ホームディレクトリに置き去りの package-lock.json を Turbopack が
  // ルート候補として拾ってしまうため、明示的にこのリポジトリを指す。
  turbopack: {
    root: __dirname,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // /course と /offer は URL クエリに読者トークンを持つ。
          // クロスオリジンへはオリジンのみを送る（ブラウザ既定値の明示）。
          // no-referrer にはしない: ドメイン制限付きの動画埋め込みが
          // Referer のオリジンで再生を許可するため。
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // 自サイトはどこにも埋め込ませない（/course は埋め込む側）。
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
  // Content-Security-Policy は未設定。導入には以下2点の解決が必要で、
  // ヘッダーだけ先に入れると動画再生と hydration が壊れる。
  //   1. frame-src をオペレーター設定の products.content_url に応じて
  //      リクエスト単位で組み立てる必要がある（静的ヘッダーでは表現できない）
  //   2. Next.js の hydration インラインスクリプトに nonce を通す必要がある
};

export default nextConfig;
