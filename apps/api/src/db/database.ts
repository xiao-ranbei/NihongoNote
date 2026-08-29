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

/**
 * sql.js 没有增量落盘：任何一次写入都要把整个库 export() 成字节再写文件。
 * 分析一篇长文会触发上百次 segment 状态更新，同步落盘意味着上百次全量序列化，
 * 长文本下能把分析耗时拖到不可接受。
 *
 * 这里改成「标脏 + 空闲 2 秒后写一次 + 退出前补写」，并用临时文件原子替换，
 * 避免写一半崩溃留下损坏的 .db。最坏情况是崩溃时丢掉最后 2 秒的写入，
 * 而分析进度本来就有 recoverInterruptedAnalyses() 兜底回退到 queued。
 */
const persistIdleDelayMs = 2_000;

class SqlJsDatabaseAdapter implements AppDatabase {
  private transactionDepth = 0;
  private pendingPersist: NodeJS.Timeout | undefined;
  private dirty = false;
  private closed = false;

  public constructor(
    private readonly database: SqlJsDatabase,
    private readonly databaseFile: string
  ) {
    this.registerShutdownHooks();
  }

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
    if (this.closed) {
      return;
    }
    this.flush();
    this.closed = true;
    this.database.close();
  }

  private persistIfReady(): void {
    if (this.transactionDepth === 0) {
      this.schedulePersist();
    }
  }

  private schedulePersist(): void {
    if (this.closed) {
      return;
    }

    this.dirty = true;
    if (this.pendingPersist) {
      return;
    }

    this.pendingPersist = setTimeout(() => {
      this.pendingPersist = undefined;
      this.flush();
    }, persistIdleDelayMs);
    // 空闲定时器不该拖住进程退出，退出路径另有 flush 兜底。
    this.pendingPersist.unref();
  }

  private flush(): void {
    if (!this.dirty || this.closed) {
      return;
    }
    this.dirty = false;
    this.persist();
  }

  private persist(): void {
    const bytes = Buffer.from(this.database.export());
    const temporaryFile = `${this.databaseFile}.tmp`;

    fs.mkdirSync(path.dirname(this.databaseFile), { recursive: true });
    fs.writeFileSync(temporaryFile, bytes);
    // 同分区 rename 是原子的：要么拿到完整的旧库，要么拿到完整的新库。
    fs.renameSync(temporaryFile, this.databaseFile);
  }

  private registerShutdownHooks(): void {
    // exit 回调只能做同步工作，persist 全同步，安全。
    process.on("exit", () => this.flush());
    process.on("beforeExit", () => this.flush());

    // 信号只补写不关闭：Fastify 自己有关闭流程，这里抢着 close 会打断它。
    // 重新投递同一个信号，让进程按默认语义退出。
    const onSignal = (signal: NodeJS.Signals): void => {
      this.flush();
      process.kill(process.pid, signal);
    };
    process.once("SIGINT", () => onSignal("SIGINT"));
    process.once("SIGTERM", () => onSignal("SIGTERM"));
  }
}

function hasColumn(database: SqlJsDatabase, tableName: string, columnName: string): boolean {
  const statement = database.prepare(`PRAGMA table_info(${tableName})`);
  try {
    while (statement.step()) {
      const row = statement.getAsObject() as { name?: unknown };
      if (row.name === columnName) {
        return true;
      }
    }
    return false;
  } finally {
    statement.free();
  }
}

function migrateDatabase(database: SqlJsDatabase): void {
  if (!hasColumn(database, "segments", "error_message")) {
    database.run("ALTER TABLE segments ADD COLUMN error_message TEXT");
  }
  if (!hasColumn(database, "segment_analyses", "usage_json")) {
    database.run("ALTER TABLE segment_analyses ADD COLUMN usage_json TEXT NOT NULL DEFAULT 'null'");
  }
  if (!hasColumn(database, "documents", "content_type")) {
    database.run("ALTER TABLE documents ADD COLUMN content_type TEXT NOT NULL DEFAULT 'article'");
  }
  if (!hasColumn(database, "documents", "content_type_source")) {
    database.run("ALTER TABLE documents ADD COLUMN content_type_source TEXT NOT NULL DEFAULT 'default'");
  }
  if (!hasColumn(database, "documents", "content_type_suggestion_json")) {
    database.run("ALTER TABLE documents ADD COLUMN content_type_suggestion_json TEXT NOT NULL DEFAULT 'null'");
  }
  if (!hasColumn(database, "documents", "content_blocks_json")) {
    database.run("ALTER TABLE documents ADD COLUMN content_blocks_json TEXT NOT NULL DEFAULT '[]'");
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
  migrateDatabase(database);

  fs.writeFileSync(databaseFile, Buffer.from(database.export()));
  return new SqlJsDatabaseAdapter(database, databaseFile);
}
