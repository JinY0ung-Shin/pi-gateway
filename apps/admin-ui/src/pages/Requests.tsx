import { useState } from "preact/hooks";
import { api, enc, formatTime } from "../api";
import { Modal, Notice, Section, useAction, useLoad } from "../components";

/** agent가 request_admin으로 남긴 요청. 처리하면 지운다. */

interface AdminRequest {
  id: number;
  user: string;
  sessionId: string;
  title: string;
  detail: string;
  createdAt: string;
}

export function RequestsPage() {
  const { data, error, reload } = useLoad<{ items: AdminRequest[] }>("/requests");
  const [open, setOpen] = useState<AdminRequest | null>(null);

  return (
    <Section title="요청" actions={<button onClick={() => void reload()}>새로고침</button>}>
      {error && <Notice tone="error">{error}</Notice>}
      <table class="table">
        <thead>
          <tr>
            <th>받은 시각</th>
            <th>user</th>
            <th>요청</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.length === 0 && (
            <tr>
              <td colSpan={3} class="muted">
                남은 요청이 없습니다.
              </td>
            </tr>
          )}
          {data?.items.map((r) => (
            <tr key={r.id} class="clickable" onClick={() => setOpen(r)}>
              <td>{formatTime(r.createdAt)}</td>
              <td class="mono">{r.user}</td>
              <td>{r.title}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {open && (
        <RequestModal
          request={open}
          onClose={() => setOpen(null)}
          onDeleted={async () => {
            setOpen(null);
            await reload();
          }}
        />
      )}
    </Section>
  );
}

function RequestModal(props: { request: AdminRequest; onClose: () => void; onDeleted: () => Promise<void> }) {
  const r = props.request;
  const action = useAction();
  return (
    <Modal
      title={r.title}
      onClose={props.onClose}
      actions={
        <button
          class="danger"
          disabled={action.busy}
          onClick={() =>
            confirm("처리한 요청을 지울까요?") &&
            action.run(async () => {
              await api("DELETE", `/requests/${r.id}`);
              await props.onDeleted();
            })
          }
        >
          처리 완료 (삭제)
        </button>
      }
    >
      {action.view}
      <p class="muted small-text">
        <span class="mono">{r.user}</span> · {formatTime(r.createdAt)} · 세션{" "}
        <a class="mono" href={`#/history/${enc(r.sessionId)}`}>
          {r.sessionId}
        </a>
      </p>
      <div class="code-block">{r.detail}</div>
    </Modal>
  );
}
