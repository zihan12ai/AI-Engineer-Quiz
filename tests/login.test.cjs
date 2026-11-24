/* Run with: node --test tests/login.test.cjs (Node.js 22+). */
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const source = readFileSync(path.join(__dirname, "../web/app.js"), "utf8");

function loginPage({ accepted = true } = {}) {
  const elements = new Map();
  const storage = new Map();
  const requests = [];
  function element(selector) {
    if (!elements.has(selector)) {
      const classes = new Set(["#app", "#login", "#login-error"].includes(selector) ? ["hidden"] : []);
      elements.set(selector, {
        value: "", textContent: "", innerHTML: "", listeners: new Map(),
        classList: {
          add: name => classes.add(name),
          remove: name => classes.delete(name),
          contains: name => classes.has(name),
          toggle(name, force) {
            const enabled = force === undefined ? !classes.has(name) : force;
            if (enabled) classes.add(name); else classes.delete(name);
          },
        },
        addEventListener(event, callback) { this.listeners.set(event, callback); },
      });
    }
    return elements.get(selector);
  }
  const context = vm.createContext({
    document: { querySelector: element, querySelectorAll: () => [] },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
    URLSearchParams, setTimeout, clearTimeout,
    async fetch(url, options) {
      // Use real Fetch validation: GET with a body must fail before a response.
      const request = new Request(new URL(url, "http://localhost:8000"), options);
      requests.push(request);
      if (new URL(request.url).pathname === "/api/auth/login") {
        return Response.json(accepted
          ? { token: "test-token", user: { username: "admin", role: "admin" } }
          : { detail: "Invalid credentials" }, { status: accepted ? 200 : 401 });
      }
      assert.equal(new URL(request.url).pathname, "/api/assets");
      assert.equal(request.headers.get("Authorization"), "Bearer test-token");
      return Response.json({ items: [], total: 0, facets: {} });
    },
  });
  vm.runInContext(source, context, { filename: "web/app.js" });
  return { element, storage, requests, async submit(password = "admin") {
    element("#login-user").value = "admin";
    element("#login-pass").value = password;
    let prevented = false;
    await element("#login-form").listeners.get("submit")({ preventDefault() { prevented = true; } });
    // enterApp starts an asynchronous library request; let it finish as well.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(prevented, true);
  } };
}

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
