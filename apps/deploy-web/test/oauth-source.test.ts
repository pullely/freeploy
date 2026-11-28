import { test } from "node:test";
import assert from "node:assert/strict";
import { followHtmlUrl, httpBuildQuery, oauthApiUrlFromHtmlUrl, oauthApplicationsUrl, oauthAuthorizeUrl, oauthWebhookUrl, phpUrlencode, selectGiteaProvider } from "../src/lib/oauth-source.ts";

test("the API URL derived from the HTML URL: /api/v4 for GitLab, /api/v1 for Gitea, the trailing slashes trimmed", () => {
  assert.equal(oauthApiUrlFromHtmlUrl("gitlab", "https://gitlab.example.com/"), "https://gitlab.example.com/api/v4");
  assert.equal(oauthApiUrlFromHtmlUrl("gitea", "https://git.example.com//"), "https://git.example.com/api/v1");
});

test("updatingHtmlUrl(): the API URL follows the HTML URL while it is empty or the derived one, and is kept otherwise", () => {
  assert.equal(followHtmlUrl("gitlab", "https://gitlab.com", "https://gitlab.com/api/v4", "https://gitlab.acme.test"), "https://gitlab.acme.test/api/v4");
  assert.equal(followHtmlUrl("gitlab", "https://gitlab.com", "", "https://gitlab.acme.test/"), "https://gitlab.acme.test/api/v4");
  assert.equal(followHtmlUrl("gitlab", "https://gitlab.com", "https://api.acme.test/v4", "https://gitlab.acme.test"), "https://api.acme.test/v4");
  assert.equal(followHtmlUrl("gitea", "https://gitea.com", "https://gitea.com/api/v1", "https://codeberg.org"), "https://codeberg.org/api/v1");
});

test("selectProvider(): Gitea.com and Codeberg fill in their URLs and the default SSH user and port; self-hosted changes nothing", () => {
  const fields = { html_url: "https://git.acme.test", api_url: "https://git.acme.test/api/v1", custom_user: "forgejo", custom_port: "2222", name: "x" };
  assert.deepEqual(selectGiteaProvider("codeberg.org", fields), { ...fields, html_url: "https://codeberg.org", api_url: "https://codeberg.org/api/v1", custom_user: "git", custom_port: "22" });
  assert.deepEqual(selectGiteaProvider("gitea.com", fields), { ...fields, html_url: "https://gitea.com", api_url: "https://gitea.com/api/v1", custom_user: "git", custom_port: "22" });
  assert.equal(selectGiteaProvider("self-hosted", fields), fields);
});

test("getOAuthUrl(): PHP's http_build_query() of the client id, redirect URI, scopes and state (php -r, coolify@91b7e3e's PHP 8.3)", () => {
  // php -r 'echo "https://gitlab.acme.test/oauth/authorize?".http_build_query(["client_id"=>"gl client~1","redirect_uri"=>"…","response_type"=>"code","scope"=>"api read_user read_repository","state"=>"a.b-c_d"]);'
  assert.equal(
    oauthAuthorizeUrl("gitlab", { htmlUrl: "https://gitlab.acme.test/", clientId: "gl client~1", redirectUri: "https://app.freeploy.io/webhooks/source/gitlab/redirect", state: "a.b-c_d" }),
    "https://gitlab.acme.test/oauth/authorize?client_id=gl+client%7E1&redirect_uri=https%3A%2F%2Fapp.freeploy.io%2Fwebhooks%2Fsource%2Fgitlab%2Fredirect&response_type=code&scope=api+read_user+read_repository&state=a.b-c_d",
  );
  // A null value is left out, as http_build_query() leaves it.
  assert.equal(
    oauthAuthorizeUrl("gitea", { htmlUrl: "https://gitea.com", clientId: null, redirectUri: "http://localhost/webhooks/source/gitea/redirect", state: "s*t!" }),
    "https://gitea.com/login/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%2Fwebhooks%2Fsource%2Fgitea%2Fredirect&response_type=code&scope=read%3Auser+read%3Arepository+read%3Aorganization&state=s%2At%21",
  );
  assert.equal(phpUrlencode("a b'(x)"), "a+b%27%28x%29");
  assert.equal(httpBuildQuery([["a", "1"], ["b", null], ["c", "x y"]]), "a=1&c=x+y");
});

test("Step 1's link and the webhook URL", () => {
  assert.equal(oauthApplicationsUrl("gitlab", "https://gitlab.com/"), "https://gitlab.com/-/profile/applications");
  assert.equal(oauthApplicationsUrl("gitea", "https://codeberg.org"), "https://codeberg.org/user/settings/applications");
  assert.equal(oauthWebhookUrl("gitlab", "https://api.freeploy.io/"), "https://api.freeploy.io/webhooks/source/gitlab/events");
  assert.equal(oauthWebhookUrl("gitea", "http://127.0.0.1:8787"), "http://127.0.0.1:8787/webhooks/source/gitea/events");
});
