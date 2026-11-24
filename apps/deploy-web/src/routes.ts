// The URL structure is routes/web.php's, one to one (design §3.1). A route
// whose page is not ported yet renders NotPorted, which the parity harness
// reports as a failing (not missing) route once deploy-web is the target.
export type PageKey = "login" | "register" | "forgot-password" | "reset-password" | "profile.appearance" | "profile" | "password.confirm" | "verify.email" | "verify.verify" | "two-factor.login" | "not-ported";

const ROUTES: Array<[RegExp, PageKey]> = [
  [/^\/login\/?$/, "login"],
  [/^\/register\/?$/, "register"],
  [/^\/forgot-password\/?$/, "forgot-password"],
  [/^\/reset-password\/[^/]+\/?$/, "reset-password"],
  [/^\/profile\/appearance\/?$/, "profile.appearance"],
  [/^\/profile\/?$/, "profile"],
  [/^\/user\/confirm-password\/?$/, "password.confirm"],
  [/^\/verify\/?$/, "verify.email"],
  [/^\/email\/verify\/[^/]+\/[^/]+\/?$/, "verify.verify"],
  [/^\/two-factor-challenge\/?$/, "two-factor.login"],
];

export function pageFor(pathname: string): PageKey {
  for (const [re, key] of ROUTES) if (re.test(pathname)) return key;
  return "not-ported";
}
