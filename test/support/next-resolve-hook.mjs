// #9: Next.js 16 の "next/server" 等はサブパスに .js 拡張子が無いと
// Node の素の ESM ローダーが解決できない（package.json に exports マップが無いため）。
// Next のビルド（webpack/turbopack）は問題なく解決するが、`node --test` で
// src/proxy.ts 等を直接 import して実行するにはこのフックが要る。
// 対象は最小限（next/server, next/navigation, next/headers, next/cache）に絞る。
//
// 合わせて tsconfig.json の "@/*": ["./src/*"] パスエイリアスも、
// Node の素の ESM ローダーは解釈しないため、ここで src/ への相対パスに変換する。
const BARE_SUBPATHS = new Set(["next/server", "next/navigation", "next/headers", "next/cache"]);

const SRC_DIR_URL = new URL("../../src/", import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  if (BARE_SUBPATHS.has(specifier)) {
    return nextResolve(`${specifier}.js`, context);
  }
  if (specifier.startsWith("@/")) {
    const hasExtension = /\.[a-zA-Z]+$/.test(specifier);
    const target = new URL(`${specifier.slice(2)}${hasExtension ? "" : ".ts"}`, SRC_DIR_URL);
    return nextResolve(target.href, context);
  }
  return nextResolve(specifier, context);
}
