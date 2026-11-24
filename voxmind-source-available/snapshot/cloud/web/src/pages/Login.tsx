import { useState, type FormEvent } from "react";
import { api, ApiError, type User } from "../api.ts";
import { BrandMark } from "../ui/kit.tsx";

export function Login({ onSignedIn }: { onSignedIn: (user: User) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!email || !password) { setError("请填写邮箱和密码"); return; }
    setBusy(true); setError(null);
    try {
      const { user } = await api.post<{ user: User }>("/v1/auth/login", { email: email.trim(), password });
      onSignedIn(user);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? e.message : "连不上服务器，请稍后再试");
    } finally { setBusy(false); }
  }

  return (
    <main className="login">
      <div className="login-card">
        <div className="brand"><BrandMark /><b style={{ fontSize: 18 }}>VoxMind</b></div>
        <div className="sheet">
          <div>
            <form onSubmit={(e) => void submit(e)} noValidate>
              <div>
                <h1>登录控制台</h1>
                <p className="lede" style={{ marginTop: 4 }}>处理设备听到的待办，回听录音，管理你的设备。</p>
              </div>
              <div className="field">
                <label htmlFor="email">邮箱</label>
                <input id="email" type="email" autoComplete="username" value={email}
                       onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
              </div>
              <div className="field">
                <label htmlFor="password">密码</label>
                <input id="password" type="password" autoComplete="current-password" value={password}
                       onChange={(e) => setPassword(e.target.value)} />
              </div>
              {error && <p className="error-text" role="alert">{error}</p>}
              <button className="btn go" type="submit" disabled={busy} style={{ minHeight: 42 }}>
                {busy ? "正在登录" : "登录"}
              </button>
            </form>
          </div>
        </div>
        <p className="ink-2" style={{ fontSize: 13, fontWeight: 500 }}>没有账号请联系你的管理员。</p>
      </div>
    </main>
  );
}
