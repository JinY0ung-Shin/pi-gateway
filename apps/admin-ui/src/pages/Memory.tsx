import { useState } from "preact/hooks";
import { api, enc, formatBytes } from "../api";
import { EmptyRow, Modal, Notice, Pager, rowAction, Section, useAction, useLoad } from "../components";

/** 사용자별 장기 메모리 (memory 서비스의 wiki) 보기. 읽기 전용이다. */

interface Wiki {
  /** wiki 폴더 이름 (`u-<hash>`) */
  key: string;
  /** 주인이 적히기 전에 만들어진 wiki는 null이다 (그 사용자가 다음에 노트를 쓰면 적힌다) */
  owner: string | null;
  notes: number;
  bytes: number;
}

interface Note {
  path: string;
  bytes: number;
}

interface Found {
  query: string;
  hits: { path: string; snippet: string }[];
  /** 노트가 많아 읽지 않은 수 */
  unscanned: number;
}

const PAGE_SIZE = 50;

export function MemoryPage(props: { focus?: string }) {
  const { data, error } = useLoad<{ wikis: Wiki[] }>("/memory");
  const [page, setPage] = useState(1);
  const wikis = [...(data?.wikis ?? [])].sort((a, b) => b.bytes - a.bytes);
  const total = wikis.reduce((sum, w) => ({ notes: sum.notes + w.notes, bytes: sum.bytes + w.bytes }), { notes: 0, bytes: 0 });

  return (
    <>
      <Section
        title="사용자"
        actions={
          data && (
            <span class="muted small-text">
              노트 {total.notes.toLocaleString()}개 · {formatBytes(total.bytes)} · 크기 순
            </span>
          )
        }
      >
        {error && <Notice tone="error">{error}</Notice>}
        <table class="table">
          <thead>
            <tr>
              <th>user</th>
              <th class="num">노트</th>
              <th class="num">크기</th>
            </tr>
          </thead>
          <tbody>
            {data && wikis.length === 0 && <EmptyRow cols={3}>메모리를 가진 사용자가 없습니다.</EmptyRow>}
            {wikis.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((w) => (
              <tr key={w.key} {...(w.owner ? rowAction(() => (location.hash = `#/memory/${enc(w.owner!)}`)) : {})}>
                {w.owner ? (
                  <td class="clip mono">{w.owner}</td>
                ) : (
                  <td class="clip mono muted" title="주인이 적히기 전에 만들어진 wiki입니다. 그 사용자가 다음에 노트를 쓰면 이름이 보입니다.">
                    {w.key} (주인 기록 없음)
                  </td>
                )}
                <td class="num">{w.notes.toLocaleString()}</td>
                <td class="num">{formatBytes(w.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && <Pager page={page} pageSize={PAGE_SIZE} total={wikis.length} onPage={setPage} />}
      </Section>
      {props.focus && <WikiView key={props.focus} user={props.focus} />}
    </>
  );
}

/** 한 사용자의 노트 목록과 검색. 노트를 누르면 같은 창에서 전문을 본다. */
function WikiView(props: { user: string }) {
  const user = enc(props.user);
  const notes = useLoad<{ notes: Note[] }>(`/memory/notes?user=${user}`);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const action = useAction();

  const search = () => {
    const q = query.trim();
    if (!q) return setFound(null);
    void action.run(async () => setFound({ query: q, ...(await api<Omit<Found, "query">>("GET", `/memory/search?user=${user}&q=${enc(q)}`)) }));
  };
  const row = (path: string) => rowAction(() => setOpen(path));

  return (
    // 노트와 목록을 오갈 때 창을 다시 만들어 스크롤을 맨 위로 돌린다
    <Modal
      key={open ?? ""}
      title={<span class="mono">{open ?? props.user}</span>}
      actions={open && <button onClick={() => setOpen(null)}>목록으로</button>}
      onClose={() => (location.hash = "#/memory")}
    >
      {open ? (
        <NoteView user={user} path={open} />
      ) : (
        <>
          {action.view}
          {notes.error && <Notice tone="error">{notes.error}</Notice>}
          <div class="row">
            <input class="grow" value={query} placeholder="노트 검색 (낱말이 통째로 맞아야 합니다)" onInput={(e) => setQuery(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && search()} />
            <button disabled={action.busy} onClick={search}>
              검색
            </button>
            {found && (
              <button
                onClick={() => {
                  setQuery("");
                  setFound(null);
                }}
              >
                전체 목록
              </button>
            )}
          </div>
          {found ? (
            <>
              {found.unscanned > 0 && <Notice tone="warn">노트가 많아 경로 순으로 뒤쪽 {found.unscanned.toLocaleString()}개는 검색하지 않았습니다.</Notice>}
              <table class="table">
                <thead>
                  <tr>
                    <th>노트</th>
                    <th>내용</th>
                  </tr>
                </thead>
                <tbody>
                  {found.hits.length === 0 && <EmptyRow cols={2}>"{found.query}"에 맞는 노트가 없습니다.</EmptyRow>}
                  {found.hits.map((hit) => (
                    <tr key={hit.path} {...row(hit.path)}>
                      <td class="clip half mono" title={hit.path}>
                        {hit.path}
                      </td>
                      <td class="clip half muted" title={hit.snippet}>
                        {hit.snippet}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <>
              <table class="table">
                <thead>
                  <tr>
                    <th>노트</th>
                    <th class="num">크기</th>
                  </tr>
                </thead>
                <tbody>
                  {notes.data?.notes.length === 0 && <EmptyRow cols={2}>노트가 없습니다.</EmptyRow>}
                  {notes.data?.notes.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((note) => (
                    <tr key={note.path} {...row(note.path)}>
                      <td class="clip mono" title={note.path}>
                        {note.path}
                      </td>
                      <td class="num">{formatBytes(note.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {notes.data && <Pager page={page} pageSize={PAGE_SIZE} total={notes.data.notes.length} onPage={setPage} />}
            </>
          )}
        </>
      )}
    </Modal>
  );
}

function NoteView(props: { user: string; path: string }) {
  const { data, error } = useLoad<{ content: string }>(`/memory/note?user=${props.user}&path=${enc(props.path)}`);
  if (error) return <Notice tone="error">{error}</Notice>;
  return data === null ? <p class="muted">불러오는 중…</p> : <pre class="code-block">{data.content}</pre>;
}
