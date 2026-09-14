// node:sqlite (Node 22.5+, experimental) の最小型定義。
// このリポジトリの @types/node にはまだ node:sqlite の型が含まれていないため、
// test/unit/delivery-queue-claim.test.ts と test/unit/d1-tenant-db.test.ts が使う範囲だけを宣言する。
// PR #21 が同一内容のファイルを追加している。両方マージするとコンフリクトになるので、
// 後からマージする側でどちらか一方を採用して解消すること。
// @types/node が node:sqlite を含むバージョンに上がったらこのファイルは削除してよい。
declare module "node:sqlite" {
  type SQLInputValue = string | number | bigint | null | Uint8Array;

  interface StatementSync {
    all(...params: SQLInputValue[]): unknown[];
    get(...params: SQLInputValue[]): unknown;
    run(...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }

  class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }

  export { DatabaseSync, StatementSync };
}
