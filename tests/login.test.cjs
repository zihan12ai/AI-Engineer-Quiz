/* Run with: node --test tests/login.test.cjs (Node.js 22+). */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createPage: loginPage } = require("./web_client.cjs");

test("login form posts credentials, persists the token, and opens the library", async () => {
  const page = loginPage();
  await page.submit();
  assert.equal(page.requests.length, 2, "login should be followed by a library request");
  const request = page.requests[0];
  assert.equal(request.method, "POST");
  assert.equal(request.headers.get("Content-Type"), "application/json");
  assert.deepEqual(await request.json(), { username: "admin", password: "admin" });
  assert.equal(page.storage.get("keepstack_token"), "test-token");
  assert.equal(page.element("#login").classList.contains("hidden"), true);
  assert.equal(page.element("#app").classList.contains("hidden"), false);
  assert.equal(page.element("#user-label").textContent, "admin (admin)");
  assert.equal(page.element("#login-error").classList.contains("hidden"), true);
  assert.equal(page.element("#result-title").textContent, "Library (0)");
});

test("rejected credentials keep the login visible and do not persist a token", async () => {
  const page = loginPage({ accepted: false });
  await page.submit("wrong-password");
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].method, "POST");
  assert.deepEqual(await page.requests[0].json(), { username: "admin", password: "wrong-password" });
  assert.equal(page.storage.has("keepstack_token"), false);
  assert.equal(page.element("#login").classList.contains("hidden"), false);
  assert.equal(page.element("#app").classList.contains("hidden"), true);
  assert.equal(page.element("#login-error").classList.contains("hidden"), false);
  assert.equal(page.element("#login-error").textContent, "Invalid credentials");
});
