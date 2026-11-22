# Signing in

Finken has its own sign-in. Accounts, passwords and sessions are kept in Finken's own database, and no outside sign-in company is involved. This is the default (`AUTH_MODE=password`).

An outside provider is still possible later, as a setting (see the end of this page).

## What is stored, and how

| What | Kept as | Why it is safe |
| --- | --- | --- |
| Password | A **scrypt hash** with its own random salt (`users.password_hash`) | Hashing is one-way: nobody can turn the hash back into the password, Finken included. scrypt is slow and memory-heavy on purpose (OWASP settings: N=2^15, r=8, p=3), so a stolen database can't be cracked quickly. The settings are stored with each hash, so they can be raised later and old passwords are upgraded at the next sign-in. |
| Session (one per signed-in device) | A row in `sessions`, holding only a SHA-256 hash of the refresh token | A copy of the database can't be used to sign in. |
| Emailed links (confirming the email, setting a new password) | SHA-256 hashes in `email_tokens`, with expiry times | Same reason. Each link works once. |

Passwords are never written to logs, never kept on the device, and never sent anywhere except to Finken's server over the encrypted connection.

## Rules

- **Passwords** need at least 10 characters (128 at most). The most common passwords (`password123`, `Pakistan123` and so on), repeated characters, number runs and passwords containing the email or name are refused. A few unrelated words together make a strong password that's easy to remember.
- **Wrong passwords:**
  - "Wrong email" and "wrong password" get the same answer, in about the same time, so nobody can find out who has an account.
  - After **5 wrong passwords in a row**, the account waits **15 minutes**, even for the right password. Unknown emails are counted the same way.
  - Each network address may try 30 times every 10 minutes.
- **One account per email,** however it's typed.
- **Forgot your password?** The answer is always the same, whether or not the email has an account.
  - Real accounts get a link that works once, for 30 minutes. Asking again replaces the earlier link.
  - Setting the new password signs out every device, signs this one in, and lifts any waiting period.
- **Confirming the email:** a link (48 hours) is sent on sign-up. Settings shows whether the email is confirmed and can send the link again.
- **Changing the password** needs the current one, and signs out every other device.
- **Sign out other devices** is in Settings → Sign-in and security.

## Sessions

- **Signing in** gives the app an **access token** that lasts 15 minutes and is kept only in memory, never in the page's storage.
- **A refresh token** is kept in a cookie (`finken_session`) that page scripts can't read (`HttpOnly`). It's sent only to Finken itself (`SameSite=Strict`), and in staging and production only over https (`Secure`). It lasts 30 days.
- **Renewing:** shortly before the access token runs out, the app asks for a new one. Every renewal **swaps the refresh token for a new one**.
  - If an old refresh token is ever used again, someone has a copy, so the whole session ends for everyone holding it.
  - Two tabs renewing at the same moment is allowed for 60 seconds.
- **Every request** checks that its session is still open. So logging out, "sign out other devices", changing the password and resetting it all take effect immediately, not when the token runs out.
- **Cross-site forgery:** renewing and logging out also need a header (`X-Finken-Session`) that another website can't add.
- **Deleting the account** removes its sessions. Tokens left over from before can never bring it back.

## Emails

Only two kinds are sent: "confirm your email" and "set a new password". They contain only the link. The link's token comes after `#`, so it never appears in a server's logs, and the app removes it from the address straight away.

- **Staging and production** send through your own mail server (`SMTP_URL`, `MAIL_FROM`). The API won't start without them there.
- **Development** sends nothing. The email is printed in the API's window, listed at `GET /v1/dev/mail` (development servers only), and the app shows a "Development: open the email's link" button.

## Settings

| Setting | Value |
| --- | --- |
| `AUTH_MODE` | `password` |
| `AUTH_SECRET` | At least 32 random characters, which sign the access tokens. Make one with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. Changing it signs everyone out of their current access token (sessions continue). Keep it in the host's secret store. |
| `APP_URL` | The web app's address, for links in emails, such as `https://app.finken.pk` (https in staging and production) |
| `SMTP_URL` | Your mail server, such as `smtps://user:password@mail.finken.pk:465` |
| `MAIL_FROM` | Who emails come from, such as `Finken <no-reply@finken.pk>` |

Serve the web app and the API (`/api`) from the same domain, so the cookie belongs to Finken alone.

## Trying it locally

Run each command in its own terminal, then open http://localhost:5173 and choose **Get Started**:

```bash
npm run dev:api:local   # the API with Finken's own sign-in; keeps accounts and records in apps/api/.local-data
npm run dev:account     # the app
```

To start again empty, stop the API and delete `apps/api/.local-data`. `npm run dev:api:memory` keeps nothing between starts.

## What is tested

- **Server** (`apps/api/src/signIn.test.ts`):
  - how passwords are hashed and checked, and the password rules;
  - one account per email;
  - the same answer for a wrong email and a wrong password;
  - the 15-minute wait, for real and unknown emails alike;
  - the limits per address;
  - refresh tokens swapped on every use, two tabs, and a copied token ending the session;
  - the forgery header;
  - logging out and signing out other devices taking effect at once;
  - forged, changed, unsigned and other-server tokens refused;
  - deleted accounts never coming back;
  - changing and resetting passwords, single-use and expiring links, "forgot" answering the same either way;
  - the production requirements.
- **In a real browser** (`tests/browser/src/password.spec.ts`):
  - creating an account and a refused weak password;
  - the session cookie unreadable by the page, and no token or password in the page's storage;
  - staying signed in after reopening;
  - confirming the email;
  - wrong passwords;
  - forgot and reset, a used link refused, and still signed in afterwards;
  - changing the password.

## An outside provider instead

If Finken ever uses an outside sign-in company, the same app works with any OpenID Connect provider (Auth0, Okta, Microsoft Entra ID, AWS Cognito, Keycloak, Zitadel):
- set `AUTH_MODE=oidc` with `AUTH_ISSUER`, `AUTH_AUDIENCE` and `AUTH_JWKS_URL` on the API;
- set `VITE_AUTH_ISSUER` and `VITE_AUTH_CLIENT_ID` on the web build.

The provider's app must be a single-page application, with `https://<domain>/auth/callback` as its return address. A stand-in provider for trying this runs with `npm run dev:api:sign-in` and `npm run dev:sign-in` (`apps/api/scripts/dev-sign-in.ts`, tested in `tests/e2e/src/sign-in.e2e.test.ts` and `tests/browser/src/sign-in.spec.ts`).
