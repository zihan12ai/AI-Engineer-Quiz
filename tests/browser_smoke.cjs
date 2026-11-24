/* Optional real-browser acceptance: seed-search, start server, then node tests/browser_smoke.cjs.
 * Requires installed Chrome/Edge; set CHROME_PATH or KEEPSTACK_URL if needed.
 */
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const base = process.env.KEEPSTACK_URL || "http://127.0.0.1:8000";
const candidates = [process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean);
const executable = candidates.find(candidate => fs.existsSync(candidate));
assert.ok(executable, "Install Chrome/Edge or set CHROME_PATH");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "keepstack-search-browser-"));
const downloadDir = path.join(profile, "downloads");
fs.mkdirSync(downloadDir);
const browser = spawn(executable, ["--headless=new", "--disable-gpu", "--remote-debugging-port=0",
  "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check", "about:blank"],
  { windowsHide: true, stdio: "ignore" });
let socket;

function parseCsv(text) {
  const rows = []; let row = [], value = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && c === ",") { row.push(value); value = ""; }
    else if (!quoted && c === "\n") { row.push(value.replace(/\r$/, "")); rows.push(row); row = []; value = ""; }
    else value += c;
  }
  return rows;
}

(async () => {
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 150 && !fs.existsSync(portFile); i++) await delay(100);
  const port = fs.readFileSync(portFile, "utf8").split("\n")[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let sequence = 0; const pending = new Map();
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data), request = pending.get(message.id);
    if (request) { pending.delete(message.id); clearTimeout(request.timer); message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result); }
  });
  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("CDP timeout: " + method)); }, 20000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const r = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ": " + r.exceptionDetails.exception?.description);
    return r.result.value;
  }
  async function waitFor(expression, label) {
    for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await delay(100); }
    throw new Error("Timed out: " + label);
  }
  async function action(expression) {
    await evaluate(expression);
    await waitFor('document.querySelector("#library-status").textContent === "" && document.querySelector("#library-error").classList.contains("hidden")', "library response");
  }
  async function tag(name) {
    const position = () => evaluate(`Array.from(document.querySelectorAll("#facet-tags button")).map(b => ({tag:b.dataset.tag,top:b.offsetTop}))`);
    const before = await position();
    await action(`Array.from(document.querySelectorAll("#facet-tags button")).find(b => b.dataset.tag === ${JSON.stringify(name)}).click()`);
    assert.deepEqual(await position(), before, "Tag buttons must stay in place after selection");
  }
  async function screenshot(filename) {
    const shot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    fs.mkdirSync("docs/screenshots", { recursive: true });
    fs.writeFileSync("docs/screenshots/" + filename, Buffer.from(shot.data, "base64"));
  }
  await cdp("Page.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir });
  await cdp("Page.navigate", { url: base });
  await waitFor('document.readyState === "complete" && !!document.querySelector("#login-form")', "login page");
  await evaluate(`document.querySelector("#login-user").value = ${JSON.stringify(process.env.KEEPSTACK_ADMIN_USER || "admin")}; document.querySelector("#login-pass").value = ${JSON.stringify(process.env.KEEPSTACK_ADMIN_PASSWORD || "admin")}; document.querySelector("#login-form").requestSubmit()`);
  await waitFor('!document.querySelector("#app").classList.contains("hidden") && document.querySelector("#result-title").textContent.includes("(")', "successful login");
  await action('document.querySelector("#search").value="harbor"; document.querySelector("#search").dispatchEvent(new Event("input"))');
  await action('const c = document.querySelector("#collection-filter"); c.value=Array.from(c.options).find(o => o.textContent === "Search acceptance demo").value; c.dispatchEvent(new Event("change"))');
  await tag("approved"); await tag("campaign"); await tag("internal"); await tag("internal");
  assert.equal(await evaluate('document.querySelector("#result-title").textContent'), "Results (25)");
  assert.equal(await evaluate('document.querySelectorAll("#grid .card").length'), 24);
  await action('document.querySelector("#sort").value="oldest"; document.querySelector("#sort").dispatchEvent(new Event("change"))');
  // Let visible thumbnails finish, without waiting on off-screen lazy images.
  await delay(300);
  await screenshot("search-filters.png");
  await action('document.querySelector("#page-next").click()');
  assert.equal(await evaluate('document.querySelectorAll("#grid .card").length'), 1);
  assert.match(await evaluate('document.querySelector("#page-info").textContent'), /25–25 of 25/);
  await screenshot("search-page-two.png");
  await evaluate('document.querySelector("#btn-export").click()');
  const csvPath = path.join(downloadDir, "keepstack-assets.csv");
  for (let i = 0; i < 150 && !fs.existsSync(csvPath); i++) await delay(100);
  const rows = parseCsv(fs.readFileSync(csvPath, "utf8").replace(/^\uFEFF/, ""));
  assert.equal(rows.length, 26, "CSV must include all 25 matches plus the header");
  const matches = await evaluate('api("/api/assets?" + queryParams(false) + "&limit=200").then(r => r.items.map(a => a.uuid))');
  assert.deepEqual(rows.slice(1).map(row => row[0]), matches);
  assert.match(rows[1][2], /港口/); assert.ok(rows[1][2].includes("\n"));
  rows.slice(1).forEach(row => { const tags = JSON.parse(row[5]); assert.ok(tags.includes("approved") && tags.includes("campaign") && !tags.includes("internal")); });
  console.log("PASS: real form login, three-state tag clicks, 25 matches over two pages, oldest sort, and actual CSV download of all 25 rows.");
  // Exercise metadata and tag edits through existing detail UI, then restore the demo.
  await action('document.querySelector("#page-prev").click()');
  await evaluate('document.querySelector("#grid .card").click()');
  await waitFor('!!document.querySelector("#d-save")', "asset drawer");
  const original = await evaluate('({title:document.querySelector("#e-title").value,description:document.querySelector("#e-description").value,uuid:document.querySelector("#grid .card").dataset.uuid})');
  try {
    await evaluate(`document.querySelector("#e-title").value="BrowserEditedHarbor"; document.querySelector("#e-description").value=${JSON.stringify('浏览器修改, "引号"\n换行')}; document.querySelector("#d-save").click()`);
    await waitFor('document.querySelector("#e-title")?.value === "BrowserEditedHarbor" && document.querySelector("#toast").textContent === "Saved"', "metadata saved");
    await evaluate('document.querySelector("#tag-add").value="browser-check"; document.querySelector("#tag-add").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');
    await waitFor('Array.from(document.querySelectorAll("#tag-row .rm")).some(b => b.dataset.tag === "browser-check")', "tag added");
    const edited = await evaluate('api("/api/assets?q=BrowserEditedHarbor&include_tag=browser-check").then(r => r.total)');
    assert.equal(edited, 1);
    const exported = await evaluate('api("/api/assets/export.csv?q=BrowserEditedHarbor&include_tag=browser-check").then(r => r.text())');
    assert.match(exported, /BrowserEditedHarbor/); assert.match(exported, /browser-check/);
    await evaluate('Array.from(document.querySelectorAll("#tag-row .rm")).find(b => b.dataset.tag === "browser-check").click()');
    await waitFor('!!document.querySelector("#tag-add") && !Array.from(document.querySelectorAll("#tag-row .rm")).some(b => b.dataset.tag === "browser-check")', "tag removed");
    assert.equal(await evaluate('api("/api/assets?include_tag=browser-check").then(r=>r.total)'), 0);
    console.log("PASS: title/description save, tag addition/removal through the drawer, and updated query/export results.");
  } finally {
    await evaluate(`api("/api/assets/${original.uuid}/tags/browser-check",{method:"DELETE"})`);
    await evaluate(`api("/api/assets/${original.uuid}",{method:"PATCH",json:${JSON.stringify({ title: original.title, description: original.description })}})`);
  }
  await evaluate('document.querySelector("#drawer-close").click()');
  await action('loadLibrary()');
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate('document.querySelector("#toast").classList.add("hidden"); window.scrollTo(0, document.querySelector("#view-library").getBoundingClientRect().top + window.scrollY - 200)');
  await delay(200);
  assert.ok(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), "Mobile layout should not overflow horizontally");
  await evaluate('document.querySelector("#facet-tags").scrollTop=100');
  const tagScroll = await evaluate('document.querySelector("#facet-tags").scrollTop');
  await tag("internal"); await tag("internal"); await tag("internal");
  assert.equal(await evaluate('document.querySelector("#facet-tags").scrollTop'), tagScroll);
  await screenshot("search-mobile.png");
  console.log("PASS: 390px layout; screenshots saved in docs/screenshots. Download directory:", downloadDir);
  await cdp("Browser.close");
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { if (socket) socket.close(); browser.kill(); });
