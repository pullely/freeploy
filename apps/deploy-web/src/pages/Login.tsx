// Derived from coollabsio/coolify@91b7e3e:resources/views/auth/login.blade.php (Apache-2.0), modified.
// /login: Coolify's markup (generated from the reference's rendered page) with
// the brand swapped. Submitting it signs in through Freeploy's identity
// service (DP-13); until then the form posts nowhere.
import { LoginMarkup } from "./generated/LoginMarkup";

export function LoginPage() {
  return <LoginMarkup />;
}
