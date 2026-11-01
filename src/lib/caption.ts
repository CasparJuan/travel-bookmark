/**
 * IG / 小紅書貼文文案的清洗與店名抽取。
 *
 * 為什麼需要清洗：IG 的 og:description 長這樣
 *   583 likes, 23 comments - 77_____eat on March 26, 2026: &quot;&#x53f0;&#x5357;...&quot;.
 * 兩個問題：
 *   ① numeric HTML entity 沒還原 → 中文全變成 &#x53f0; 這種東西，店名和縣市都比對不到
 *   ② 前面黏著一段 likes / comments / 帳號 / 日期的殼，那不是文案
 *
 * ⚠️ 文案來自使用者傳來的任意網址，內容不可信。這裡的 regex 不能有會互相重疊的
 * 連續量詞（例如 \s*X?\s*），否則一長串空白就會造成平方級回溯、卡死 webhook。
 * tests/caption.test.mjs 有對應的對抗輸入測試。
 */

/** 英文版 IG 殼：「583 likes, 23 comments - handle on March 26, 2026: "」 */
const IG_SHELL_EN =
  /^[ \t]*[\d.,]+\s*(?:[KkMm]\s*)?likes?\s*,\s*[\d.,]+\s*(?:[KkMm]\s*)?comments?\s*[-–—]\s*\S.{0,119}?\s+on\s+[A-Za-z]+\s+\d{1,2},\s*\d{4}\s*:\s*["“«]?/gm;

/** 繁中版 IG 殼：「583 個讚，23 則留言 - handle 於 2026 年 3 月 26 日：「」 */
const IG_SHELL_ZH =
  /^[ \t]*[\d.,]+\s*(?:[KkMm]\s*)?個讚\s*[，,]\s*[\d.,]+\s*(?:[KkMm]\s*)?則留言\s*[-–—]\s*\S.{0,119}?於\s*\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日\s*[：:]\s*[「"“]?/gm;

/** 去掉文案結尾被平台補上的收尾引號（"." 或 」）；沒有引號就原樣回傳 */
function stripClosingQuote(s: string): string {
  let end = s.trimEnd();
  if (end.endsWith(".")) end = end.slice(0, -1).trimEnd();
  return /["”»」]$/.test(end) ? end.slice(0, -1) : s;
}

/** 店名來源文字的長度上限。店名本身最多 30 字，夠用，也限制下面 regex 的輸入大小 */
const MAX_NAME_SOURCE = 200;

/**
 * 解 HTML entity（含 &#x53f0; 這種 numeric 形式）。
 * 刻意不用 DOM（這支在 Route Handler / Node 端跑，沒有 document）。
 */
function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : _;
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : _;
    })
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    // &amp; 一定要最後解，否則 &amp;quot; 會被提早還原成 &quot; 再被上面吃掉
    .replace(/&amp;/g, "&");
}

/**
 * 把貼文描述還原成人看得懂的文案。
 *
 * 不做的事：不截斷、不刪 hashtag —— hashtag 常常帶地名（#屏東美食），
 * 是判斷 city / district 的重要線索，刪掉反而讓辨識變差。
 */
export function cleanCaption(text: string | null | undefined): string | null {
  if (!text) return text ?? null;

  let s = decodeEntities(text);
  s = s.replace(IG_SHELL_EN, "").replace(IG_SHELL_ZH, "");
  s = stripClosingQuote(s);

  // 存進 DB 的描述是「og:title 換行 og:description」，而 og:title 就是文案第一行，
  // 剝完殼之後同一句會連著出現兩次 → 把重複的第一行拿掉。
  const lines = s.split("\n");
  if (lines.length >= 2) {
    // 下面只比前 12 字，先截短，避免整行都是句點時回溯
    const head = lines[0].trim().slice(0, 64).replace(/[.… ]+$/, "");
    const next = lines[1].trim();
    if (head.length >= 6 && next.startsWith(head.slice(0, Math.min(head.length, 12)))) {
      lines.shift();
    }
  }

  return lines.join("\n").trim();
}

/**
 * 地址的幾種組合。刻意不用「含 市/區/路/街/段/號 任一字」判斷：
 * 路易莎咖啡、老街肉圓、瑞豐夜市、段純貞牛肉麵都是店名，單字比對會全部誤殺。
 */
const ADDRESS_SHAPES = [
  /\d+\s*號/, // 太原路1190號
  /[一-鿿]{2}[縣市].{1,8}?[區鄉鎮市]/, // 台中市北屯區
  /[區鄉鎮].{1,6}?[路街](?:[一二三四五六七八九十\d]|$)/, // 北屯區太原路
  /[路街][一二三四五六七八九十\d]+段/, // 太原路三段
  /^(?:.{2}[縣市]|.{1,4}[區鄉鎮])$/, // 只寫行政區：台中市、北屯區
];

export function looksLikeAddress(text: string): boolean {
  return ADDRESS_SHAPES.some((shape) => shape.test(text));
}

/** 單店文常見「📍店名 📍IG 📍營業時間 📍地址 📍電話」，後面這些欄位不是店名 */
const NON_NAME_FIELD =
  /^(?:店家|店舖)?(?:地址|地點|電話|營業時間|公休)|^(?:IG|FB|Instagram|Facebook)(?:[：:\s]|$)/i;

/** 名稱前後多餘的符號 */
const EDGE_SYMBOLS = /^[\s:：|｜\-–—~～·•.,，。、]+|[\s:：|｜\-–—~～·•.,，。、]+$/g;

/** 把「📍」或「店名：」後面的文字清成店名；看起來不是店名就回 null */
function cleanPlaceName(raw: string): string | null {
  const name = raw
    .slice(0, MAX_NAME_SOURCE)
    .replace(/[@＠][\w.]+/g, "")
    .replace(/[#＃]\S*/g, "")
    .replace(/[\p{Extended_Pictographic}️‍]/gu, "")
    .replace(EDGE_SYMBOLS, "")
    .replace(/^(?:店名|店家)\s*[：:]/, "")
    .split(/[|｜]/)[0]
    .replace(EDGE_SYMBOLS, "");

  if (name.length < 2 || name.length > 30) return null;
  if (/[，。！？]/.test(name)) return null; // 是句子，不是店名
  if (NON_NAME_FIELD.test(name) || looksLikeAddress(name)) return null;
  return name;
}

/**
 * 從文案抽店名，webhook 用它決定收藏標題。
 *
 * 📍 與「店名：」是作者親手標的，比任何字尾猜測都可靠，所以放最前面。
 * 2026-11-01 實例：reel DfLt1vyS-qf 的文案有「📍IGNIS伊尼斯鐵板燒」，
 * 只跑字尾規則的話，抓到的會是地址「北屯區廍子里太原路三段1190號」。
 */
export function extractPlaceName(caption: string): string | null {
  if (!caption) return null;

  // Pattern 1: 📍 後面同一行；地址或欄位就跳過，改看下一個 📍
  for (const segment of caption.split("📍").slice(1)) {
    const name = cleanPlaceName(segment.split(/[\r\n]/)[0]);
    if (name) return name;
  }

  // Pattern 2: 以「店名：」「店家：」開頭的行
  for (const [, value] of caption.matchAll(/^[ \t]*(?:店名|店家)[ \t]*[：:](.+)$/gm)) {
    const name = cleanPlaceName(value);
    if (name) return name;
  }

  // Pattern 3: Look for text ending with common place suffixes
  // e.g., "羊燒味 溫體羊肉專賣店", "老宅咖啡廳", "XX燒烤店"
  const suffixPattern = /([^\s，,。！!？?、\n]{2,15}(?:店|廳|館|堂|舍|居|屋|坊|軒|閣|苑|齋|號|樓|亭|寮|小吃|食堂|餐廳|咖啡|酒吧|旅館|民宿|飯店))/g;
  const suffixMatches = (caption.match(suffixPattern) ?? []).filter((match) => !looksLikeAddress(match));
  if (suffixMatches.length > 0) {
    // Pick the longest match as it's likely the full name
    const best = suffixMatches.sort((a, b) => b.length - a.length)[0];
    // Clean up leading filler words
    return best.replace(/^[的在是有個一這那去到了也都很超好最]/, '').trim();
  }

  // Pattern 4: Look for quoted names「XX」or【XX】
  const quotedMatch = caption.match(/[「【]([^」】]{2,20})[」】]/);
  if (quotedMatch) return quotedMatch[1];

  // Pattern 5: If the caption is short enough (≤15 chars), it might be the name itself
  const firstLine = caption.split(/[\n\r]/)[0].trim();
  if (firstLine.length <= 15 && !/[？?！!]/.test(firstLine)) {
    return firstLine;
  }

  return null;
}
