/**
 * 環境変数の読み込み。
 *
 * `serverEnv` はサーバーサイド専用。Client Component から import すると
 * service role キーがバンドルに混入するため、読み出し時に実行環境を検査して落とす。
 * 要件定義書 6.1「service role キーはクライアントに一切露出させない」に対応。
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `環境変数 ${name} が未設定です。.env.example を参照して .env.local に値を入れてください。`,
    );
  }
  return value;
}

/** ブラウザに露出してよい値。 */
export const publicEnv = {
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  stripePublishableKey: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "",
  bookingUrl: process.env.NEXT_PUBLIC_BOOKING_URL ?? "",
};

/** サーバーサイド専用。参照した時点で初めて検証する。 */
export const serverEnv = {
  get supabaseUrl() {
    return required("NEXT_PUBLIC_SUPABASE_URL");
  },
  get supabaseServiceRoleKey() {
    assertServer("SUPABASE_SERVICE_ROLE_KEY");
    return required("SUPABASE_SERVICE_ROLE_KEY");
  },
  get resendApiKey() {
    assertServer("RESEND_API_KEY");
    return required("RESEND_API_KEY");
  },
  get resendFrom() {
    const email = required("RESEND_FROM_EMAIL");
    const name = process.env.RESEND_FROM_NAME;
    return name ? `${name} <${email}>` : email;
  },
  get stripeSecretKey() {
    assertServer("STRIPE_SECRET_KEY");
    return required("STRIPE_SECRET_KEY");
  },
  get stripeWebhookSecret() {
    assertServer("STRIPE_WEBHOOK_SECRET");
    return required("STRIPE_WEBHOOK_SECRET");
  },
};

function assertServer(name: string): void {
  if (typeof window !== "undefined") {
    throw new Error(
      `${name} はサーバーサイド専用です。Client Component から参照しようとしています。`,
    );
  }
}
