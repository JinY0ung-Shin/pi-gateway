import Database from "better-sqlite3";

export type Db = Database.Database;

export function openDatabase(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("secure_delete = ON");
  return db;
}

/** 순서가 정해진 마이그레이션. 이미 적용된 단계는 건너뛴다. 단계는 수정하지 말고 뒤에 추가한다. */
export function migrate(db: Db, module: string, steps: readonly string[]): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       module TEXT NOT NULL,
       step INTEGER NOT NULL,
       applied_at TEXT NOT NULL,
       PRIMARY KEY (module, step)
     )`,
  );
  const applied = new Set(
    (db.prepare("SELECT step FROM schema_migrations WHERE module = ?").all(module) as { step: number }[]).map(
      (row) => row.step,
    ),
  );
  const record = db.prepare("INSERT INTO schema_migrations (module, step, applied_at) VALUES (?, ?, ?)");
  db.transaction(() => {
    steps.forEach((sql, step) => {
      if (applied.has(step)) return;
      db.exec(sql);
      record.run(module, step, new Date().toISOString());
    });
  })();
}
