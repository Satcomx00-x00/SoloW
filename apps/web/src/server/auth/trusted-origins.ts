/** The spellings of "this machine" a browser may put in an `Origin` header. */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"] as const;

/**
 * The origins BetterAuth accepts a sign-in or sign-up from, given `SOLOW_WEB_URL`.
 *
 * The launchers default `SOLOW_WEB_URL` to `http://localhost:<port>` while binding the server to
 * `127.0.0.1`, so the address an Owner is most likely to paste — the one the server printed it is
 * listening on — was refused with BetterAuth's bare "Invalid origin" on the very first screen.
 *
 * When the configured host is a loopback name, every other loopback spelling on the same scheme
 * and port is trusted too. They all name the same machine and the same listening socket, so this
 * admits no page that could not already reach the server; a cross-site request still cannot
 * claim a loopback `Origin`, because the browser sets that header, not the page. A non-loopback
 * URL — a LAN address, a real domain — is trusted exactly as written and nothing else.
 */
export function trustedOriginsFor(webUrl: string): string[] {
  const url = new URL(webUrl);
  const configured = url.origin;
  if (!(LOOPBACK_HOSTS as readonly string[]).includes(url.hostname)) return [configured];

  const port = url.port ? `:${url.port}` : "";
  const loopback = LOOPBACK_HOSTS.map((host) => `${url.protocol}//${host}${port}`);
  return [configured, ...loopback.filter((origin) => origin !== configured)];
}
