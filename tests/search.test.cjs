const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createPage, flush } = require("./web_client.cjs");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const result = total => Response.json({ items: [], total, facets: {} });

test("filter and sort changes reset pagination and clear removes every condition", async () => {
  const page = createPage();
  await page.submit();
  page.evaluate('state.offset = 48; state.q = "harbor"; state.media = "image"; state.includeTags.add("approved"); state.excludeTags.add("internal")');
  page.element("#collection-filter").value = "7";
  await page.fire("#collection-filter", "change");
  let query = new URL(page.requests.at(-1).url).searchParams;
  assert.equal(query.get("offset"), "0");
  assert.equal(query.get("collection_id"), "7");
  assert.equal(query.get("media_type"), "image");
  assert.deepEqual(query.getAll("include_tag"), ["approved"]);
  assert.deepEqual(query.getAll("exclude_tag"), ["internal"]);
  page.evaluate("state.offset = 24");
  page.element("#sort").value = "oldest";
  await page.fire("#sort", "change");
  query = new URL(page.requests.at(-1).url).searchParams;
  assert.equal(query.get("sort"), "oldest");
  assert.equal(query.get("offset"), "0");
  await page.fire("#clear-filters", "click");
  query = new URL(page.requests.at(-1).url).searchParams;
  assert.equal(query.get("q"), "");
  for (const key of ["collection_id", "media_type", "include_tag", "exclude_tag"]) assert.equal(query.has(key), false);
  assert.equal(page.element("#search").value, "");
});

test("older responses cannot overwrite the newest search results", async () => {
  const old = deferred(), latest = deferred();
  const page = createPage({ fetchResponse: request => {
    const q = new URL(request.url).searchParams.get("q");
    if (q === "old") return old.promise;
    if (q === "latest") return latest.promise;
  } });
  await page.submit();
  const oldLoad = page.evaluate('state.q = "old"; loadLibrary()');
  const oldRequest = page.requests.at(-1);
  const newLoad = page.evaluate('state.q = "latest"; conditionsChanged()');
  latest.resolve(result(3)); await newLoad;
  old.resolve(result(99)); await oldLoad;
  assert.equal(oldRequest.signal.aborted, true);
  assert.equal(page.element("#result-title").textContent, "Results (3)");
  assert.equal(page.element("#page-info").textContent, "1–3 of 3 matches · Page 1");
});

test("typing invalidates an old response before the debounce timer fires", async () => {
  const old = deferred();
  const page = createPage({ fetchResponse: request => {
    if (new URL(request.url).searchParams.get("q") === "old") return old.promise;
  } });
  await page.submit();
  const oldLoad = page.evaluate('state.q = "old"; loadLibrary()');
  page.element("#search").value = "new";
  await page.fire("#search", "input");
  old.resolve(result(99)); await oldLoad;
  assert.equal(page.element("#result-title").textContent, "Search results");
  assert.equal(page.element("#library-status").textContent, "Loading matches…");
  await page.evaluate("loadLibrary()"); // use the latest keyword; clears the pending timer
  assert.equal(new URL(page.requests.at(-1).url).searchParams.get("q"), "new");
  assert.equal(page.element("#result-title").textContent, "Results (0)");
});

test("a failed library request shows retry and can recover", async () => {
  let fail = true;
  const page = createPage({ fetchResponse: request => {
    if (new URL(request.url).pathname === "/api/assets" && fail) { fail = false; throw new Error("offline"); }
  } });
  await page.submit();
  assert.equal(page.element("#library-error").classList.contains("hidden"), false);
  assert.equal(page.element("#page-next").disabled, true);
  await page.fire("#retry-library", "click");
  assert.equal(page.element("#library-error").classList.contains("hidden"), true);
  assert.equal(page.element("#result-title").textContent, "Library (0)");
});

test("previous and next pages work and a removed last page returns to a valid page", async () => {
  let total = 49;
  const page = createPage({ fetchResponse: request => {
    if (new URL(request.url).pathname === "/api/assets") return result(total);
  } });
  await page.submit();
  assert.equal(page.element("#page-prev").disabled, true);
  await page.fire("#page-next", "click");
  assert.equal(new URL(page.requests.at(-1).url).searchParams.get("offset"), "24");
  assert.equal(page.element("#page-prev").disabled, false);
  await page.fire("#page-prev", "click");
  assert.equal(new URL(page.requests.at(-1).url).searchParams.get("offset"), "0");
  page.evaluate("state.offset = 48"); total = 24;
  await page.evaluate("loadLibrary()");
  assert.equal(new URL(page.requests.at(-1).url).searchParams.get("offset"), "0");
  assert.equal(page.element("#page-next").disabled, true);
});

test("CSV download preserves filters and auth, omits pagination, and uses a file download", async () => {
  const page = createPage({ fetchResponse: request => {
    if (new URL(request.url).pathname.endsWith("export.csv")) return new Response("uuid,title\r\n", { headers: { "Content-Type": "text/csv" } });
  } });
  await page.submit();
  page.evaluate('state.q = "海港 harbor"; state.collection = "2"; state.media = "image"; state.sort = "oldest"; state.offset = 24; state.includeTags.add("approved"); state.includeTags.add("campaign"); state.excludeTags.add("internal")');
  await page.fire("#btn-export", "click");
  const request = page.requests.at(-1), query = new URL(request.url).searchParams;
  assert.equal(request.headers.get("Authorization"), "Bearer test-token");
  assert.equal(query.get("q"), "海港 harbor");
  assert.equal(query.get("collection_id"), "2");
  assert.equal(query.get("media_type"), "image");
  assert.equal(query.get("sort"), "oldest");
  assert.deepEqual(query.getAll("include_tag"), ["approved", "campaign"]);
  assert.deepEqual(query.getAll("exclude_tag"), ["internal"]);
  assert.equal(query.has("offset"), false); assert.equal(query.has("limit"), false);
  assert.deepEqual(page.downloads, [{ href: "blob:test-download", download: "keepstack-assets.csv" }]);
  assert.equal(await page.blobs[0].text(), "uuid,title\r\n");
  assert.equal(page.element("#btn-export").disabled, false);
});

test("CSV failure shows an error and enables retry", async () => {
  const page = createPage({ fetchResponse: request => {
    if (new URL(request.url).pathname.endsWith("export.csv")) return new Response("failed", { status: 500 });
  } });
  await page.submit();
  await page.fire("#btn-export", "click");
  await flush();
  assert.match(page.element("#toast").textContent, /CSV download failed/);
  assert.equal(page.downloads.length, 0);
  assert.equal(page.element("#btn-export").disabled, false);
});
