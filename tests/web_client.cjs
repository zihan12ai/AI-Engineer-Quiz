/* Lightweight DOM/Fetch harness shared by the frontend behavior tests. */
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));

function createPage({ accepted = true, fetchResponse } = {}) {
  const elements = new Map(), storage = new Map(), requests = [], downloads = [], blobs = [];
  function element(selector) {
    if (!elements.has(selector)) {
      const classes = new Set(["#app", "#login", "#login-error", "#library-error"].includes(selector) ? ["hidden"] : []);
      elements.set(selector, {
        value: "", textContent: "", innerHTML: "", disabled: false, listeners: new Map(),
        classList: {
          add: name => classes.add(name), remove: name => classes.delete(name),
          contains: name => classes.has(name),
          toggle(name, force) {
            if (force === undefined ? !classes.has(name) : force) classes.add(name); else classes.delete(name);
          },
        },
        addEventListener(event, callback) { this.listeners.set(event, callback); },
      });
    }
    return elements.get(selector);
  }
  const context = vm.createContext({
    document: {
      querySelector: element, querySelectorAll: () => [],
      body: { append() {}, classList: { add() {}, remove() {} } },
      createElement: () => ({ click() { downloads.push({ href: this.href, download: this.download }); }, remove() {} }),
    },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key),
    },
    URLSearchParams, AbortController,
    URL: class extends URL {
      static createObjectURL(blob) { blobs.push(blob); return "blob:test-download"; }
      static revokeObjectURL() {}
    },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; }, clearTimeout,
    async fetch(url, options) {
      const request = new Request(new URL(url, "http://localhost:8000"), options);
      requests.push(request);
      if (fetchResponse) {
        const response = await fetchResponse(request);
        if (response) return response;
      }
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
  return { element, storage, requests, downloads, blobs,
    evaluate: expression => vm.runInContext(expression, context),
    async fire(selector, event, values = {}) {
      await element(selector).listeners.get(event)({ target: element(selector), ...values });
      await flush();
    },
    async submit(password = "admin") {
      element("#login-user").value = "admin";
      element("#login-pass").value = password;
      let prevented = false;
      await element("#login-form").listeners.get("submit")({ preventDefault() { prevented = true; } });
      await flush();
      assert.equal(prevented, true);
    },
  };
}

module.exports = { createPage, flush };
