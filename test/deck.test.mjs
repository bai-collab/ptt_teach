import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  validateDeck, parseDeckText, deriveRules, listReferencedPaths,
  inRange, isPageIndex, pageRule, isDiscPage, discKind, discPages, voteOptionCount,
  isVoteOption, isMapNode, isMapTag, isColumn, isSeekTime, normalizeSeek,
  MAX_DECK_JSON_LENGTH,
} from "../src/deck.js";

const EXAMPLE_TEXT = readFileSync(new URL("../examples/ai-era-education.deck.json", import.meta.url), "utf8");
const example = () => JSON.parse(EXAMPLE_TEXT);
const codes = (r) => (r.ok ? [] : r.errors.map((e) => e.code));
const bad = (r, code, path) => {
  assert.equal(r.ok, false, "應該驗證失敗");
  assert.ok(r.errors.some((e) => e.code === code && (path === undefined || e.path === path)),
    `預期 ${code}${path ? " @ " + path : ""}，實際 ${JSON.stringify(r.errors)}`);
};
const staticDeck = () => ({
  contract: 1, id: "plain-deck", title: "靜態", version: "1", entry: "index.html", runtime: "static",
  pages: [{ type: "html", path: "slides/a.html", title: "A" }, { type: "disc", kind: "wall", title: "牆" }],
});
const withPath = (p) => { const d = staticDeck(); d.pages[0].path = p; return validateDeck(d); };

test("範例 deck 合法，且輸出與輸入內容相同", () => {
  const r = validateDeck(example());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.deck, example());
});

test("deriveRules 與目前 worker 寫死的值一致", () => {
  const d = example();
  const rules = deriveRules(d);
  const total = d.segments.reduce((a, s) => a + s.duration, 0);
  assert.equal(rules.pageCount, 22);
  assert.equal(rules.maxSeekSeconds, total);
  assert.equal(total, 223);
  const disc = {};
  rules.pages.forEach((p, i) => { if (p.type === "disc") disc[i] = p; });
  assert.deepEqual(disc, {
    4: { type: "disc", kind: "vote", optionCount: 3 },
    9: { type: "disc", kind: "map", nodeCount: 8, tagCount: 4 },
    10: { type: "disc", kind: "vote", optionCount: 6 },
    13: { type: "disc", kind: "wall" },
    16: { type: "disc", kind: "wall" },
    20: { type: "disc", kind: "cols", columnCount: 3 },
  });
  assert.deepEqual(discPages(rules), [4, 9, 10, 13, 16, 20]);
  assert.deepEqual(discPages(rules, "vote"), [4, 10]);
  assert.deepEqual(rules.pages[0], { type: "anim", segStart: 0, segDuration: 10 });
  assert.deepEqual(rules.pages[1], { type: "anim", segStart: 10, segDuration: 13 });
  assert.ok(Object.isFrozen(rules) && Object.isFrozen(rules.pages) && rules.pages.every(Object.isFrozen));
});

test("helper 涵蓋頁碼、討論頁、選項／節點／標籤／欄、seek 邊界", () => {
  const rules = deriveRules(example());
  assert.equal(isPageIndex(rules, 0), true);
  assert.equal(isPageIndex(rules, 21), true);
  for (const p of [22, -1, 1.5, "4", NaN, null, undefined, "__proto__", "constructor"]) assert.equal(isPageIndex(rules, p), false, String(p));
  assert.equal(pageRule(rules, "constructor"), null);
  assert.equal(isDiscPage(rules, 4), true);
  assert.equal(isDiscPage(rules, 4, "vote"), true);
  assert.equal(isDiscPage(rules, 4, "wall"), false);
  assert.equal(isDiscPage(rules, 0), false);
  assert.equal(isDiscPage(rules, "4"), false);
  assert.equal(discKind(rules, 13), "wall");
  assert.equal(discKind(rules, 0), null);
  assert.equal(voteOptionCount(rules, 10), 6);
  assert.equal(voteOptionCount(rules, 9), 0);
  assert.equal(isVoteOption(rules, 4, 2), true);
  assert.equal(isVoteOption(rules, 4, 3), false);
  assert.equal(isVoteOption(rules, 10, 5), true);
  assert.equal(isVoteOption(rules, 9, 0), false);
  assert.equal(isMapNode(rules, 9, 7), true);
  assert.equal(isMapNode(rules, 9, 8), false);
  assert.equal(isMapTag(rules, 9, 3), true);
  assert.equal(isMapTag(rules, 9, 4), false);
  assert.equal(isColumn(rules, 20, 2), true);
  assert.equal(isColumn(rules, 20, 3), false);
  assert.equal(isColumn(rules, 4, 0), false);
  assert.equal(isSeekTime(rules, 0), true);
  assert.equal(isSeekTime(rules, 223), true);
  assert.equal(isSeekTime(rules, 223.01), false);
  assert.equal(isSeekTime(rules, -0.1), false);
  assert.equal(isSeekTime(rules, NaN), false);
  assert.equal(isSeekTime(rules, "5"), false);
  assert.equal(normalizeSeek(rules, 3000), 0);
  assert.equal(normalizeSeek(rules, 12.5), 12.5);
  assert.equal(inRange(3, 0, 3), true);
  assert.equal(inRange(3.5, 0, 4), false);
  assert.equal(inRange(Infinity, 0, Infinity), false);
  // 規則物件壞掉時 helper 不丟例外
  for (const junk of [null, undefined, 1, "x", {}, { pages: null }]) {
    assert.equal(isPageIndex(junk, 0), false);
    assert.equal(isDiscPage(junk, 0), false);
    assert.equal(isSeekTime(junk, 0), false);
    assert.deepEqual(discPages(junk), []);
  }
});

test("static deck：maxSeekSeconds 為 0，listReferencedPaths 去重", () => {
  const d = staticDeck();
  d.pages.push({ type: "html", path: "index.html" }, { type: "html", path: "slides/a.html" }, { type: "html", path: "b.html" });
  const rules = deriveRules(d);
  assert.equal(rules.maxSeekSeconds, 0);
  assert.equal(isSeekTime(rules, 0), true);
  assert.equal(isSeekTime(rules, 1), false);
  assert.deepEqual(listReferencedPaths(d), ["index.html", "slides/a.html", "b.html"]);
  assert.deepEqual(listReferencedPaths(example()), ["index.html"]);
});

test("deriveRules／listReferencedPaths 遇到不合格 deck 丟 TypeError", () => {
  assert.throws(() => deriveRules({}), TypeError);
  assert.throws(() => listReferencedPaths(null), TypeError);
});

test("缺少必要欄位", () => {
  const d = example(); delete d.title;
  bad(validateDeck(d), "required", "/title");
  const d2 = example(); delete d2.pages[4].options;
  bad(validateDeck(d2), "required", "/pages/4/options");
  const d3 = example(); delete d3.pages[0].seg;
  bad(validateDeck(d3), "required", "/pages/0/seg");
});

test("多餘欄位（頂層、頁面、segment、tag）", () => {
  const d = example(); d.extra = 1;
  bad(validateDeck(d), "additional", "/extra");
  const d2 = example(); d2.pages[13].options = ["a", "b"]; // wall 不得有 options
  bad(validateDeck(d2), "additional", "/pages/13/options");
  const d3 = example(); d3.segments[0].x = 1;
  bad(validateDeck(d3), "additional", "/segments/0/x");
  const d4 = example(); d4.pages[9].tags[0].x = 1;
  bad(validateDeck(d4), "additional", "/pages/9/tags/0/x");
});

test("const／enum 不符", () => {
  const d = example(); d.contract = 2;
  bad(validateDeck(d), "const", "/contract");
  const d2 = example(); d2.contract = "1";
  bad(validateDeck(d2), "const", "/contract");
  const d3 = example(); d3.runtime = "video";
  bad(validateDeck(d3), "enum", "/runtime");
  const d4 = example(); d4.pages[0].type = "slide";
  bad(validateDeck(d4), "enum", "/pages/0/type");
  const d5 = example(); d5.pages[4].kind = "poll";
  bad(validateDeck(d5), "enum", "/pages/4/kind");
  const d6 = example(); d6.id = "Bad_ID";
  bad(validateDeck(d6), "pattern", "/id");
});

test("路徑含 .. 或 . 片段", () => {
  bad(withPath("../x.html"), "path");
  bad(withPath("a/../x.html"), "path");
  bad(withPath("a/./x.html"), "path");
  bad(withPath("a..b.html"), "path");
});

test("絕對路徑、反斜線、雙斜線、URL", () => {
  bad(withPath("/index.html"), "path");
  bad(withPath("C:/x.html"), "path");
  bad(withPath("a\\b.html"), "path");
  bad(withPath("a//b.html"), "path");
  bad(withPath("https://evil.example/x.html"), "path");
  bad(withPath("a/b.html/"), "path");
  bad(withPath(""), "path");
});

test("路徑含 %（%2e）與非 ASCII", () => {
  bad(withPath("%2e%2e/x.html"), "path");
  bad(withPath("a%20b.html"), "path");
  bad(withPath("投影片.html"), "path");
  bad(withPath("ａ.html"), "path");
  bad(withPath("a\u0000.html"), "path");
});

test("路徑非 .html、太深、太長", () => {
  bad(withPath("x.htm"), "path");
  bad(withPath("x.HTML"), "path");
  bad(withPath("x.html.js"), "path");
  bad(withPath("a/b/c/d/e/f/g/h/i.html"), "path"); // 9 層
  assert.equal(withPath("a/b/c/d/e/f/g/i.html").ok, true); // 8 層
  bad(withPath("a".repeat(196) + ".html"), "path"); // 201 字元
  assert.equal(withPath("a".repeat(195) + ".html").ok, true); // 200 字元
  const d = staticDeck(); d.entry = "index.js";
  bad(validateDeck(d), "path", "/entry");
});

test("anim.seg 超出 segments 範圍、非整數", () => {
  const d = example(); d.pages[0].seg = 16;
  bad(validateDeck(d), "seg_range", "/pages/0/seg");
  const d2 = example(); d2.pages[0].seg = 1.5;
  bad(validateDeck(d2), "integer", "/pages/0/seg");
  const d3 = example(); d3.pages[0].seg = -1;
  bad(validateDeck(d3), "minimum", "/pages/0/seg");
});

test("static 不得有 anim 頁，也不得有 segments；timeline 必須有 segments", () => {
  const d = staticDeck(); d.pages.push({ type: "anim", seg: 0 });
  bad(validateDeck(d), "anim_forbidden", "/pages/2");
  const d2 = staticDeck(); d2.segments = [{ title: "x", duration: 1 }];
  bad(validateDeck(d2), "segments_forbidden", "/segments");
  const d3 = example(); delete d3.segments;
  bad(validateDeck(d3), "segments_required", "/segments");
});

test("頁數超過 100、0 頁", () => {
  const d = staticDeck(); d.pages = Array.from({ length: 101 }, () => ({ type: "disc", kind: "wall", title: "t" }));
  bad(validateDeck(d), "max_items", "/pages");
  d.pages.length = 100;
  assert.equal(validateDeck(d).ok, true);
  d.pages = [];
  bad(validateDeck(d), "min_items", "/pages");
});

test("字串長度以 Unicode code point 計（emoji）", () => {
  const d = example(); d.title = "😀".repeat(80); // 80 code points，160 UTF-16 code units
  assert.equal(validateDeck(d).ok, true);
  d.title = "😀".repeat(81);
  bad(validateDeck(d), "max_length", "/title");
  const d2 = example(); d2.pages[0].text = "字".repeat(2001);
  bad(validateDeck(d2), "max_length", "/pages/0/text");
  const d3 = example(); d3.pages[4].options[0] = "a".repeat(41);
  bad(validateDeck(d3), "max_length", "/pages/4/options/0");
  const d4 = example(); d4.title = "";
  bad(validateDeck(d4), "min_length", "/title");
});

test("含 HTML 的字串原樣保存，不解析不轉義", () => {
  const d = example();
  const evil = `<img src=x onerror="alert(1)">&lt;b&gt;`;
  d.title = evil; d.pages[4].options[0] = "<script>x</script>"; d.pages[0].text = "<b>粗體</b>";
  const r = validateDeck(d);
  assert.equal(r.ok, true);
  assert.equal(r.deck.title, evil);
  assert.equal(r.deck.pages[4].options[0], "<script>x</script>");
  assert.equal(r.deck.pages[0].text, "<b>粗體</b>");
});

test("__proto__／constructor 鍵被拒，Object.prototype 未被污染", () => {
  const r = parseDeckText(EXAMPLE_TEXT.replace('"contract": 1,', '"contract": 1, "__proto__": {"polluted": true},'));
  bad(r, "additional", "/__proto__");
  const d = example(); d.pages[4] = JSON.parse(`{"type":"disc","kind":"vote","title":"t","options":["a","b"],"__proto__":{"polluted":true}}`);
  bad(validateDeck(d), "additional", "/pages/4/__proto__");
  const d2 = example(); d2.constructor = { prototype: { polluted: true } };
  bad(validateDeck(d2), "additional", "/constructor");
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test("輸出 deck 是全新純物件，不帶輸入原型", () => {
  const src = example();
  const proto = { injected: "yes" };
  Object.setPrototypeOf(src, proto);
  const r = validateDeck(src);
  assert.equal(r.ok, true);
  assert.equal(Object.getPrototypeOf(r.deck), Object.prototype);
  assert.equal(r.deck.injected, undefined);
  assert.notEqual(r.deck, src);
  assert.notEqual(r.deck.pages, src.pages);
  r.deck.pages[4].options[0] = "changed";
  assert.notEqual(src.pages[4].options[0], "changed");
});

test("非物件輸入（null、陣列、字串、數字等）回錯誤不丟例外", () => {
  for (const v of [null, undefined, [], [example()], "{}", EXAMPLE_TEXT, 42, true, Symbol("x"), () => 1, 10n]) {
    const r = validateDeck(v);
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].code, "type");
  }
  bad(parseDeckText("{not json"), "json");
  bad(parseDeckText(42), "type");
  assert.equal(parseDeckText(EXAMPLE_TEXT).ok, true);
});

test("怪異輸入不丟例外：循環、BigInt、會丟例外的 getter、深層巢狀", () => {
  const cyc = example(); cyc.pages[0].self = cyc;
  bad(validateDeck(cyc), "not_serializable");
  const big = example(); big.contract = 1n;
  bad(validateDeck(big), "not_serializable");
  const g = example(); Object.defineProperty(g, "title", { enumerable: true, get() { throw new Error("boom"); } });
  bad(validateDeck(g), "not_serializable");
  let deep = {}; for (let i = 0; i < 100000; i++) deep = { a: deep };
  const d = example(); d.pages[0].x = deep;
  const r = validateDeck(d);
  assert.equal(r.ok, false);
  const deepText = "[".repeat(200000) + "]".repeat(200000);
  assert.equal(parseDeckText(deepText).ok, false);
});

test("NaN／Infinity／非數字 duration 被拒", () => {
  for (const v of [NaN, Infinity, -Infinity, "10", null]) {
    const d = example(); d.segments[0].duration = v;
    bad(validateDeck(d), "type", "/segments/0/duration");
  }
  const d = example(); d.segments[0].duration = 0;
  bad(validateDeck(d), "minimum", "/segments/0/duration");
  const d2 = example(); d2.segments[0].duration = 600.5;
  bad(validateDeck(d2), "maximum", "/segments/0/duration");
});

test("總長超過 7200 秒被拒，剛好 7200 通過", () => {
  const d = example();
  d.segments = Array.from({ length: 16 }, (_, i) => ({ title: "s" + i, duration: 450 }));
  assert.equal(validateDeck(d).ok, true);
  d.segments.push({ title: "x", duration: 0.5 });
  bad(validateDeck(d), "total_duration", "/segments");
});

test("顏色格式錯誤", () => {
  for (const c of ["red", "#fff", "#12345g", "#1234567", " #123456", 123456]) {
    const d = example(); d.pages[9].tags[0].color = c;
    assert.equal(validateDeck(d).ok, false, String(c));
  }
  const ok = example(); ok.pages[9].tags[0].color = "#aBcDeF";
  assert.equal(validateDeck(ok).ok, true);
});

test("投票 1 個選項／9 個選項被拒，2 與 8 通過", () => {
  const d = example(); d.pages[4].options = ["only"];
  bad(validateDeck(d), "min_items", "/pages/4/options");
  d.pages[4].options = Array.from({ length: 9 }, (_, i) => "o" + i);
  bad(validateDeck(d), "max_items", "/pages/4/options");
  d.pages[4].options = ["a", "b"];
  assert.equal(validateDeck(d).ok, true);
  d.pages[4].options = Array.from({ length: 8 }, (_, i) => "o" + i);
  assert.equal(validateDeck(d).ok, true);
});

test("地圖 7 個標籤、1 個節點被拒", () => {
  const d = example(); d.pages[9].tags = Array.from({ length: 7 }, (_, i) => ({ label: "t" + i, color: "#000000" }));
  bad(validateDeck(d), "max_items", "/pages/9/tags");
  const d2 = example(); d2.pages[9].nodes = ["n"];
  bad(validateDeck(d2), "min_items", "/pages/9/nodes");
  const d3 = example(); d3.pages[9].tags = [];
  bad(validateDeck(d3), "min_items", "/pages/9/tags");
});

test("分欄 5 欄、1 欄被拒", () => {
  const d = example(); d.pages[20].columns = ["a", "b", "c", "d", "e"];
  bad(validateDeck(d), "max_items", "/pages/20/columns");
  d.pages[20].columns = ["a"];
  bad(validateDeck(d), "min_items", "/pages/20/columns");
});

test("大小上限：超過 256 KiB 回 too_large", () => {
  const d = example(); d.pages[0].text = "x".repeat(MAX_DECK_JSON_LENGTH);
  const r = validateDeck(d);
  assert.deepEqual(codes(r), ["too_large"]);
  bad(parseDeckText(" ".repeat(MAX_DECK_JSON_LENGTH + 1)), "too_large");
  bad(validateDeck({ s: "a".repeat(10_000_000) }), "too_large");
});

test("錯誤數量有上限", () => {
  const d = staticDeck();
  for (let i = 0; i < 500; i++) d["k" + i] = 1;
  const r = validateDeck(d);
  assert.equal(r.ok, false);
  assert.ok(r.errors.length <= 101);
  assert.equal(r.errors.at(-1).code, "too_many_errors");
});

test("模組沒有任何 import（可在 Workers 打包）", () => {
  const src = readFileSync(new URL("../src/deck.js", import.meta.url), "utf8");
  assert.equal(/^\s*import\b/m.test(src), false);
  assert.equal(/\bimport\s*\(/.test(src), false);
  assert.equal(/\brequire\s*\(/.test(src), false);
  assert.equal(/\bprocess\.|\bBuffer\b/.test(src), false);
});
