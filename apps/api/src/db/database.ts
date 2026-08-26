import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import initSqlJs, { type Database as SqlJsDatabase, type SqlValue } from "sql.js";

import { databaseSchema } from "./schema.js";

type QueryParams = SqlValue[] | Record<string, SqlValue>;

const require = createRequire(import.meta.url);

export interface AppDatabase {
  all<T extends object>(sql: string, params?: QueryParams): T[];
  get<T extends object>(sql: string, params?: QueryParams): T | undefined;
  run(sql: string, params?: QueryParams): number;
  transaction(work: () => void): void;
  close(): void;
}

class SqlJsDatabaseAdapter implements AppDatabase {
  private transactionDepth = 0;

  public constructor(
    private readonly database: SqlJsDatabase,
    private readonly databaseFile: string
  ) {}

  public all<T extends object>(sql: string, params?: QueryParams): T[] {
    const statement = this.database.prepare(sql);
    try {
      if (params) {
        statement.bind(params);
      }

      const rows: T[] = [];
      while (statement.step()) {
        rows.push(statement.getAsObject() as T);
      }
      return rows;
    } finally {
      statement.free();
    }
  }

  public get<T extends object>(sql: string, params?: QueryParams): T | undefined {
    const statement = this.database.prepare(sql);
    try {
      if (params) {
        statement.bind(params);
      }
      return statement.step() ? statement.getAsObject() as T : undefined;
    } finally {
      statement.free();
    }
  }

  public run(sql: string, params?: QueryParams): number {
    this.database.run(sql, params);
    const changedRows = this.database.getRowsModified();
    this.persistIfReady();
    return changedRows;
  }

  public transaction(work: () => void): void {
    this.database.run("BEGIN");
    this.transactionDepth += 1;

    try {
      work();
      this.database.run("COMMIT");
    } catch (error) {
      this.database.run("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth -= 1;
      this.persistIfReady();
    }
  }

  public close(): void {
    this.persist();
    this.database.close();
  }

  private persistIfReady(): void {
    if (this.transactionDepth === 0) {
      this.persist();
    }
  }

  private persist(): void {
    fs.writeFileSync(this.databaseFile, Buffer.from(this.database.export()));
  }
}

export async function createDatabase(databaseFile: string): Promise<AppDatabase> {
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true });

  const SQL = await initSqlJs({
    locateFile: (fileName) => path.join(path.dirname(require.resolve("sql.js")), fileName)
  });
  const existingDatabase = fs.existsSync(databaseFile)
    ? new Uint8Array(fs.readFileSync(databaseFile))
    : undefined;
  const database = new SQL.Database(existingDatabase);

  database.run("PRAGMA foreign_keys = ON");
  database.exec(databaseSchema);

  fs.writeFileSync(databaseFile, Buffer.from(database.export()));
  return new SqlJsDatabaseAdapter(database, databaseFile);
}
