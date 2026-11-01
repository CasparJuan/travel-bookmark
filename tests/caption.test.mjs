// 執行：npm test（Node 內建 test runner；直接 import .ts 需要 Node 23.6 以上）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { cleanCaption, extractPlaceName, looksLikeAddress } from "../src/lib/caption.ts";

// https://www.instagram.com/reel/DfLt1vyS-qf/ 的原始 og:description，
// 2026-11-01 以 webhook 的 User-Agent 實抓，保留 entity 與「69 likes」外殼。
const IGNIS_RAW = readFileSync(
  new URL("./fixtures/ig-ignis-og-description.txt", import.meta.url),
  "utf8",
);

test("real IG post: 📍 line wins over the address in the caption", () => {
  const caption = cleanCaption(IGNIS_RAW);
  assert.match(caption, /📍IGNIS伊尼斯鐵板燒/);
  assert.equal(extractPlaceName(caption), "IGNIS伊尼斯鐵板燒");
});

test("real IG post: same result on title + description, as fetchOgMeta joins them", () => {
  const firstLine = "台中鐵板燒情緒價值真的給好給滿！總結一句好吃，很直得回訪！";
  assert.equal(extractPlaceName(`${firstLine} ${cleanCaption(IGNIS_RAW)}`), "IGNIS伊尼斯鐵板燒");
});

test("cleanCaption decodes hex, decimal and named entities", () => {
  assert.equal(
    cleanCaption("&#x53f0;&#20013; &quot;a&quot; &amp; &lt;b&gt; it&#39;s"),
    `台中 "a" & <b> it's`,
  );
});

test("📍 strips @handle, #tag and stray symbols", () => {
  assert.equal(extractPlaceName("📍 老宅咖啡 @oldhouse.tw #台中美食 ｜"), "老宅咖啡");
  assert.equal(extractPlaceName("📍店名：老宅咖啡"), "老宅咖啡");
  assert.equal(extractPlaceName("📍老宅咖啡｜台中北屯"), "老宅咖啡");
});

test("📍 skips addresses and moves on to the next 📍", () => {
  const caption = "好吃\n📍台中市北屯區太原路三段1190號\n📍IGNIS伊尼斯鐵板燒 @ignis1190_1";
  assert.equal(extractPlaceName(caption), "IGNIS伊尼斯鐵板燒");
});

test("📍 skips field labels: 地址, 電話, 營業時間, IG", () => {
  const caption = [
    "📍地址：台中市西區民生路1號",
    "📍電話：04-1234-5678",
    "📍營業時間 12:00-21:00",
    "📍IG：@oldhouse",
    "📍老宅咖啡",
  ].join("\n");
  assert.equal(extractPlaceName(caption), "老宅咖啡");
});

test("📍 keeps names that only happen to contain address characters", () => {
  for (const name of ["路易莎咖啡", "瑞豐夜市", "老街肉圓", "段純貞牛肉麵", "IGNIS伊尼斯鐵板燒"]) {
    assert.equal(extractPlaceName(`📍${name}`), name);
  }
});

test("店名： and 店家： lines work; 店家地址： is not a name", () => {
  assert.equal(extractPlaceName("超好吃\n店名：老宅咖啡廳 @oldhouse"), "老宅咖啡廳");
  assert.equal(extractPlaceName("超好吃\n店家: 阿明小吃"), "阿明小吃");
  assert.equal(extractPlaceName("這間真的很值得專程跑一趟來吃吃看\n店家地址：臺中市北屯區廍子里太原路三段1190號之1"), null);
});

test("suffix rule no longer returns an address", () => {
  const caption = "這間真的很值得專程跑一趟來吃吃看\n店家地址：臺中市北屯區廍子里太原路三段1190號之1";
  assert.equal(looksLikeAddress("北屯區廍子里太原路三段1190號"), true);
  assert.equal(extractPlaceName(caption), null);
  assert.equal(extractPlaceName(`${caption}\n老宅咖啡廳`), "老宅咖啡廳");
});

test("looksLikeAddress covers common address shapes", () => {
  for (const text of ["台中市北屯區", "北屯區太原路", "太原路三段", "太原路1190號", "北屯區", "台中市"]) {
    assert.equal(looksLikeAddress(text), true, text);
  }
});

test("existing rules still work", () => {
  assert.equal(extractPlaceName("推薦 老宅咖啡廳 真的讚"), "老宅咖啡廳");
  assert.equal(extractPlaceName("週末去吃了「阿明的家」真的很不錯，下次還要再來一次"), "阿明的家");
  assert.equal(extractPlaceName("阿明牛肉麵"), "阿明牛肉麵");
  assert.equal(extractPlaceName(""), null);
});
