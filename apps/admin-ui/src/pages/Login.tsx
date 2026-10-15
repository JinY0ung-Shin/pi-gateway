import { useState } from "preact/hooks";
import { api, errorText } from "../api";
import { Notice } from "../components";

export function Login(props: { onLogin: () => void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/login", { apiKey: key });
      setKey("");
      props.onLogin();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="login">
      <form class="card login-card" onSubmit={submit}>
        <h1>pi-gateway 관리</h1>
        <p class="muted">관리자 API 키(ADMIN_API_KEY)로 로그인합니다.</p>
        <label class="field">
          <span>관리자 키</span>
          <input type="password" autocomplete="current-password" value={key} onInput={(e) => setKey((e.currentTarget as HTMLInputElement).value)} autofocus required />
        </label>
        {error && <Notice tone="error">{error}</Notice>}
        <button class="primary" type="submit" disabled={busy || !key}>
          {busy ? "확인 중…" : "로그인"}
        </button>
      </form>
    </div>
  );
}
