/**
 * The sign-in form served at /login in password mode. Inline CSS, no JS, no external assets:
 * it must render even when the web bundle is missing, and it deliberately reveals the service
 * is omp-ui to an unauthenticated caller (accepted trade-off for usability).
 */
export function loginPage(error: string | null): string {
  const errorHtml = error
    ? `<p role="alert" style="margin:0 0 12px;color:#f87171;font-size:13px">${escapeHtml(error)}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>omp-ui — Sign in</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { display:flex; align-items:center; justify-content:center; min-height:100dvh;
         background:#0a0b0d; color:#c8d0da; font:14px/1.5 system-ui,sans-serif; padding:24px; }
  .card { width:100%; max-width:340px; }
  h1 { font-size:18px; font-weight:600; color:#e6ebf2; margin-bottom:4px; }
  .sub { font-size:12px; color:#8b95a3; margin-bottom:20px; }
  label { display:block; font-size:12px; color:#8b95a3; margin-bottom:6px; }
  input[type="password"] { width:100%; padding:9px 12px; border:1px solid #2a3038;
    border-radius:6px; background:#14171b; color:#e6ebf2; font:inherit; outline:none; }
  input[type="password"]:focus { border-color:#4a5568; }
  button { margin-top:12px; width:100%; padding:9px 12px; border:none; border-radius:6px;
    background:#c8d0da; color:#0a0b0d; font:inherit; font-weight:600; cursor:pointer; }
  button:hover { background:#e6ebf2; }
  .hint { margin-top:16px; font-size:11px; color:#8b95a3; text-align:center; }
</style>
</head>
<body>
<div class="card">
  <h1>omp-ui</h1>
  <p class="sub">Remote access &mdash; sign in to continue</p>
  ${errorHtml}
  <form method="post" action="/login">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" required autofocus autocomplete="current-password">
    <button type="submit">Sign in</button>
  </form>
  <p class="hint">or open a pairing link with an access token</p>
</div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
