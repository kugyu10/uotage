// #9 レビュー指摘[高]-4: requireOperator() が service role クライアント（RLS 迂回）を
// 返すようになったため、tenant_id によるスコープ漏れを検出する回帰ガードが無いと
// 将来の1行の書き忘れがクロステナントのデータ漏洩に直結する。
//
// src/app/admin/** の全 `.from("...")` / `.rpc("...")` 呼び出しについて、
// 呼び出し文（直後の `;` または次の `.from(`/`.rpc(` のどちらか早い方まで）に
// "tenant_id" が含まれるかを機械的に走査する。
// 含まれない呼び出しは EXEMPT にリストされたものだけ許可する
// （EXEMPT の妥当性は個別に確認済み。理由は各エントリのコメントを参照）。
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ADMIN_DIR = fileURLToPath(new URL("../src/app/admin", import.meta.url));

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

// このファイルの呼び出しに限り、tenant_id を含まない .rpc() 呼び出しを許可する。
// append_step_message / move_step_message は security invoker で
// 「呼び出し元の RLS がテナント越えを弾く」前提だったが、#9 で requireOperator() が
// service role クライアントになりその前提が崩れたため、呼び出し側の
// assertScenarioOwnership() で明示的にテナント境界を検証するよう修正した
// （RPC自体は target_scenario_id しか受け取らない設計のため、tenant_id という
// 文字列はRPC呼び出し文そのものには現れない）。
const EXEMPT_RPC_CALLS = new Set(["append_step_message", "move_step_message"]);

test("src/app/admin 配下の .from()/.rpc() 呼び出しは全て tenant_id でスコープされている", async () => {
  const files = await walk(ADMIN_DIR);
  const violations = [];

  for (const file of files) {
    const rawSrc = await readFile(file, "utf8");
    // 行頭が `//` の行はコードとして扱わない（コメントアウトされた
    // assertScenarioOwnership() 呼び出しを「有効な事前検証」と誤検知しないため）。
    const src = rawSrc
      .split("\n")
      .map((line) => (line.trim().startsWith("//") ? "" : line))
      .join("\n");
    const relPath = path.relative(ADMIN_DIR, file);
    const callRe = /\.(from|rpc)\(\s*"([^"]+)"/g;
    let match;
    while ((match = callRe.exec(src))) {
      const [, kind, name] = match;
      const start = match.index;
      // statement の終端は「次に現れる ; 」と「次に現れる別の .from(/.rpc( 呼び出し」の
      // どちらか早い方で打ち切る。Promise.all([...]) のように複数呼び出しを1つの配列に
      // まとめている箇所では ; が配列全体の終端まで来ないため、";" だけで区切ると
      // 兄弟クエリが持つ tenant_id を「自分にもある」と誤判定してしまう（レビュー #2 🟡-2）。
      const semiIndex = src.indexOf(";", start);
      const nextCallRe = /\.(?:from|rpc)\(/g;
      nextCallRe.lastIndex = start + 1;
      const nextCallMatch = nextCallRe.exec(src);
      const nextCallIndex = nextCallMatch ? nextCallMatch.index : -1;
      const candidates = [semiIndex, nextCallIndex].filter((i) => i !== -1);
      const end = candidates.length === 0 ? src.length : Math.min(...candidates);
      const statement = src.slice(start, end);
      if (statement.includes("tenant_id")) continue;

      if (kind === "rpc" && EXEMPT_RPC_CALLS.has(name)) {
        // 免除リストのRPCは、呼び出しを含む「同じ関数」の中で assertScenarioOwnership() が
        // その呼び出しより前に出現することを必須にする（免除の濫用を防ぐ）。ファイル全体での
        // 最初の出現位置で判定すると、他の関数にガードが1つでも残っていれば常にそのインデックスが
        // 呼び出し位置より前になり、この呼び出し自身のガード欠落を検出できない（レビュー #2 🟡-1）。
        // そのため探索の開始位置を、直前の関数宣言まで遡って固定する。
        const funcDeclRe = /\b(?:export\s+)?(?:async\s+)?function\s+\w+/g;
        let funcStart = 0;
        let declMatch;
        while ((declMatch = funcDeclRe.exec(src))) {
          if (declMatch.index > start) break;
          funcStart = declMatch.index;
        }
        const guardIndex = src.indexOf("assertScenarioOwnership(", funcStart);
        if (guardIndex !== -1 && guardIndex < start) continue;
        violations.push(
          `${relPath}: .rpc("${name}") は免除対象だが assertScenarioOwnership() による事前検証が見つからない`,
        );
        continue;
      }

      const line = rawSrc.slice(0, start).split("\n").length;
      violations.push(`${relPath}:${line}: .${kind}("${name}") の呼び出し文に tenant_id が無い`);
    }
  }

  assert.deepEqual(violations, []);
});
