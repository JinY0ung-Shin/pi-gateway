/** better-sqlite3 Database 중 migrate가 쓰는 부분 (shared가 better-sqlite3에 의존하지 않도록 모양으로만 받는다) */
interface MigrationDb {
  exec(sql: string): unknown;
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
  transaction(fn: () => void): () => void;
}

/**
 * 모듈별 마이그레이션. 각 모듈은 고유한 이름과 순서가 정해진 SQL 목록을 넘긴다.
 * 이미 적용된 단계는 건너뛴다. 단계를 수정하지 말고 뒤에 추가한다.
 */
export function migrate(db: MigrationDb, module: string, steps: readonly string[]): void {
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
