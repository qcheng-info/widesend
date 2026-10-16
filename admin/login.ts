// The dashboard's password sign-in page. Messages are fixed text, never user input.
export type LoginMessage = 'wrong' | 'limited' | null;
const messages: Record<Exclude<LoginMessage, null>, string> = {
  wrong: 'That password is not right.',
  limited: 'Too many attempts from your network. Try again later.',
};

export function loginPage(message: LoginMessage = null): string {
  const alert = message ? `<p class="login-error" role="alert">${messages[message]}</p>` : '';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>WideSend admin sign-in</title>
    <link rel="icon" href="/widesend.svg" />
    <link rel="stylesheet" href="/admin.css" />
  </head>
  <body>
    <main class="login">
      <img src="/widesend.svg" alt="" width="40" height="40" />
      <h1>WideSend admin</h1>
      <form method="post" action="/login">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required autofocus />
        ${alert}
        <button type="submit">Sign in</button>
      </form>
    </main>
  </body>
</html>
`;
}
