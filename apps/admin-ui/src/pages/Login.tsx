import { useState } from "preact/hooks";
import { api } from "../api";
import { Brand, useAction } from "../components";

export function Login(props: { onLogin: () => void }) {
  const [key, setKey] = useState("");
  const action = useAction();

  const submit = (e: Event) => {
    e.preventDefault();
    void action.run(async () => {
      await api("POST", "/login", { apiKey: key });
      setKey("");
      props.onLogin();
    });
  };

  return (
    <div class="login">
      <form class="card login-card" onSubmit={submit}>
        <Brand />
        <p class="muted">관리자 API 키(ADMIN_API_KEY)로 로그인합니다.</p>
        <label class="field">
          <span>관리자 키</span>
          <input type="password" autocomplete="current-password" value={key} onInput={(e) => setKey((e.currentTarget as HTMLInputElement).value)} autofocus required />
        </label>
        {action.view}
        <button class="primary" type="submit" disabled={action.busy || !key}>
          {action.busy ? "확인 중…" : "로그인"}
        </button>
      </form>
    </div>
  );
}
