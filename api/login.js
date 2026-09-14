// The door. `/api/login?token=…` sets the viewing cookie and goes to the world; without a
// token it asks for one. The token itself never appears in a page: it lives in Doppler and in
// the cookie, and the only way to give it to someone is to tell them.
import { isViewToken, viewCookie } from '../cloud/auth.js';

const FORM = `<!doctype html><meta charset="utf-8"><title>Superset Agent Fleet</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1a1626;color:#f1e9d2;font:16px/1.5 ui-monospace,Menlo,monospace}
form{display:grid;gap:12px;padding:32px;border:2px solid #4c3f6b;background:#241d36}input{font:inherit;padding:8px 10px;background:#141020;color:inherit;border:2px solid #4c3f6b;min-width:28ch}
button{font:inherit;padding:8px 14px;background:#f4b942;color:#1a1626;border:0;cursor:pointer}p{margin:0;color:#c8b8e6}</style>
<form method="get" action="/api/login"><p>The fleet is behind a token.</p><input name="token" type="password" autofocus placeholder="view token" autocomplete="current-password"><button>Open the world</button>#WRONG#</form>`;

export async function GET(request) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') ?? '';
  if (token && isViewToken(token)) {
    return new Response(null, {
      status: 303,
      headers: { location: '/', 'set-cookie': viewCookie(token), 'cache-control': 'no-store' },
    });
  }
  const html = FORM.replace('#WRONG#', token ? '<p>That is not it.</p>' : '');
  return new Response(html, {
    status: token ? 401 : 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
