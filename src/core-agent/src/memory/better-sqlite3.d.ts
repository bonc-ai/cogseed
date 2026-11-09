/** Typed subset of better-sqlite3 used by the Core memory store. Keep result
 * rows unknown: each query must supply its own row shape at the call site.
 * This declaration adds no runtime dependency or untyped module escape hatch.
 */
declare module "better-sqlite3" {
  namespace Database {
    type BindValue = string | number | bigint | Buffer | null;

    interface RunResult {
      changes: number;
      lastInsertRowid: number | bigint;
    }

    interface Statement {
      run(...params: BindValue[]): RunResult;
      get(...params: BindValue[]): unknown;
      all(...params: BindValue[]): unknown[];
    }

    interface Database {
      exec(sql: string): this;
      pragma(source: string): unknown;
      prepare(sql: string): Statement;
      transaction<Args extends unknown[], Result>(fn: (...args: Args) => Result): (...args: Args) => Result;
      close(): this;
    }
  }

  const Database: {
    new(filename: string): Database.Database;
  };

  export = Database;
}
