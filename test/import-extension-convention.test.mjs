// issue #4: 相対importの拡張子規約。
//
// 決定（案A）: リポジトリ全体（src/**）で相対importは拡張子を明記する。
//   - 理由: `node --test --experimental-strip-types` は拡張子補完を行わないため、
//     拡張子なしの相対importを持つモジュールは実テストから直接 import できない
//     （ERR_MODULE_NOT_FOUND）。規約を1つにすれば、今後どのモジュールでも
//     追加設定なしに実テストが書ける。tsconfig の allowImportingTsExtensions により
//     typecheck / next build (Turbopack) はどちらも通る。
//   - 案B（src/lib/csv/ 限定）は規約の混在が場当たりに広がる、
//     案C（vitest 導入）は極小に保っている devDependencies が増えるため不採用。
//
// このテストが規約の強制装置。拡張子なしの相対importが src/** に入ると落ちる。
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const SRC_ROOT = new URL('../src/', import.meta.url);

/** 相対importで許す拡張子。CSSはグローバルスタイルの副作用import用。 */
const ALLOWED_EXTENSIONS = ['.ts', '.tsx', '.css'];

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
const SPECIFIER_PATTERN = /(?:from\s*|import\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;

test('src/** の相対importはすべて拡張子を明記している (issue #4 の規約)', async () => {
  const files = await collectSourceFiles(SRC_ROOT);
  assert.ok(files.length > 0, 'src 配下のソースが見つからない');

  const violations = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(SPECIFIER_PATTERN)) {
      const specifier = match[1];
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
      if (!ALLOWED_EXTENSIONS.some((extension) => specifier.endsWith(extension))) {
        violations.push(`${path.relative(process.cwd(), file.pathname)}: "${specifier}"`);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `拡張子なしの相対importがある（node --test から直接 import できない）:\n${violations.join('\n')}`,
  );
});
