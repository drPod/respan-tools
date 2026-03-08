# CLI Browser Auth - Frontend Integration Spec

## What happens

When a user runs `respan auth login` and picks "Browser login", the CLI:

1. Starts a temporary local HTTP server on `http://localhost:18392`
2. Opens the browser to your login page with special query params
3. Waits up to 120 seconds for a callback redirect
4. Receives tokens via the redirect, then shuts down the server

## The login URL the CLI opens

```
https://platform.respan.ai/login?mode=cli&redirect_uri=http://localhost:18392/callback
```

If enterprise login:

```
https://platform.respan.ai/login?mode=cli&redirect_uri=http://localhost:18392/callback&enterprise=true
```

## What the frontend needs to do

### 1. Detect CLI mode

Check for `mode=cli` in the login page query params. When present, the login page is being used by the CLI tool, not a normal browser session.

### 2. Let the user log in normally

Email/password, Google OAuth, SSO — whatever auth methods you support. No change to the actual auth flow.

### 3. After successful login, redirect to the callback URL

Instead of navigating to the dashboard, redirect to the `redirect_uri` from the query params with the JWT tokens appended:

```
http://localhost:18392/callback?token={access_token}&refresh_token={refresh_token}&email={user_email}
```

### Callback query params

| Param | Required | Description |
|---|---|---|
| `token` | Yes | JWT access token |
| `refresh_token` | Yes | JWT refresh token — CLI uses this to refresh sessions |
| `email` | No | Shown in the CLI as confirmation ("Logged in as user@example.com") |

If `token` is missing, the CLI treats it as a failed login.

## UX considerations

- After redirecting, the user sees a plain HTML page from the CLI's local server saying "Login successful! You can close this window." — the frontend doesn't need to render anything post-redirect
- Consider showing a "Logging in via CLI..." message or a simpler UI when `mode=cli` is detected, since the user will be redirected to localhost anyway
- The CLI times out after **120 seconds** — if the user takes longer, they'll need to re-run `respan auth login`

## Security notes

- The `redirect_uri` will always be `http://localhost:18392/callback` — validate that it matches localhost before redirecting tokens to it
- Tokens are passed as query params in a localhost redirect, so they never leave the user's machine
