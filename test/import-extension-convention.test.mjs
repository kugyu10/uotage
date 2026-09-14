// issue #4: 相対importの拡張子規約。
//
// 決定（案A）: リポジトリ全体（src/**）で相対importは拡張子を明記する。
//   - 理由: 規約を1つに統一し、「どこを触っているかで書き方が変わる」状態を解消するため。
//     tsconfig の allowImportingTsExtensions により typecheck / next build (Turbopack)
//     はどちらも通る。
//   - 実テストからの直接importへの寄与は限定的（レビューで判明した実測、issue #4 参照）。
//     `.ts` の拡張子明記だけが `node --test --experimental-strip-types` からの
//     直接importに寄与する。`.tsx` は node の型ストリッピングの対象外
//     （拡張子を明記しても `ERR_UNKNOWN_FILE_EXTENSION` になり import できない）なので、
//     `.tsx` に拡張子を足すのは表記統一が目的であり、実テスト可能性の話ではない。
//     さらに `@/` パスエイリアスは tsconfig の paths でしか解決されず node には
//     わからないため（`ERR_MODULE_NOT_FOUND`）、拡張子規約だけでは
//     `@/` を使うモジュールは実テストに到達できない。本PR時点で新たに実テスト可能に
//     なったモジュールは0件（変更した13箇所はすべて `.tsx` で、`@/` を使わない
//     `.ts` の直接import可能化はこのPRの範囲外）。
//   - 案B（src/lib/csv/ 限定）は規約の混在が場当たりに広がる、
//     案C（vitest 導入）は極小に保っている devDependencies が増えるため不採用。
//
// このテストが規約の強制装置。拡張子なしの相対importが src/** に入ると落ちる。
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const SRC_ROOT = new URL('../src/', import.meta.url);

/**
 * 相対importの指定子末尾に拡張子が付いているかの判定。
 * 許可リスト方式ではなく「拡張子が付いているか」そのものを見る
 * （規約の趣旨が「拡張子を明記する」であるため。.json / .svg など将来の
 * 拡張子追加でも許可リストの更新漏れによる誤検知が起きない）。
 */
const HAS_EXTENSION_PATTERN = /\.[a-z0-9]+$/i;

async function collectSourceFiles(dirUrl) {
  const entries = await readdir(dirUrl, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dirUrl);
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(child)));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(child);
    }
  }
  return files;
}

// import / export ... from '...'、import('...')、副作用 import '...' の指定子を拾う。
// テンプレートリテラル（`./foo`）の動的importも検出対象に含める。
const SPECIFIER_PATTERN = /(?:from\s*|import\s*\(\s*|^\s*import\s+)["'`]([^"'`]+)["'`]/gm;

test('src/** の相対importはすべて拡張子を明記している (issue #4 の規約)', async () => {
  const files = await collectSourceFiles(SRC_ROOT);
  assert.ok(files.length > 0, 'src 配下のソースが見つからない');

  const violations = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(SPECIFIER_PATTERN)) {
      const specifier = match[1];
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
      if (!HAS_EXTENSION_PATTERN.test(specifier)) {
        violations.push(`${path.relative(process.cwd(), file.pathname)}: "${specifier}"`);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `拡張子なしの相対importがある（リポジトリの規約違反。拡張子を明記すること）:\n${violations.join('\n')}`,
  );
});
