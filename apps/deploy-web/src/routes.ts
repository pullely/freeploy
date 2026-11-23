// The URL structure is routes/web.php's, one to one (design §3.1). A route
// whose page is not ported yet renders NotPorted, which the parity harness
// reports as a failing (not missing) route once deploy-web is the target.
export type PageKey = "login" | "not-ported";

const ROUTES: Array<[RegExp, PageKey]> = [[/^\/login\/?$/, "login"]];

export function pageFor(pathname: string): PageKey {
  for (const [re, key] of ROUTES) if (re.test(pathname)) return key;
  return "not-ported";
}
