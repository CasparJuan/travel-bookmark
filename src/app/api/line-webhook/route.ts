import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { detectPlatform, platformEmoji, placeTypeEmoji } from "@/lib/utils";
import { cleanCaption, extractPlaceName } from "@/lib/caption";

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const DEFAULT_GROUP_ID = process.env.LINE_DEFAULT_GROUP_ID || "";
const DEFAULT_USER_ID = process.env.LINE_DEFAULT_USER_ID || "";

// Server-side Supabase client (anon key + RPC with SECURITY DEFINER)
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function verifySignature(body: string, signature: string): boolean {
  const hash = crypto
    .createHmac("SHA256", CHANNEL_SECRET)
    .update(body)
    .digest("base64");
  return hash === signature;
}

async function replyMessage(replyToken: string, messages: { type: string; text: string }[]) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });
}

const CITIES = [
  "台北", "新北", "基隆", "桃園", "新竹", "苗栗",
  "台中", "彰化", "南投", "雲林",
  "嘉義", "台南", "高雄", "屏東",
  "宜蘭", "花蓮", "台東",
  "澎湖", "金門", "馬祖",
];

function extractUrl(text: string): string | null {
  const urlRegex = /(https?:\/\/[^\s]+)/;
  const match = text.match(urlRegex);
  return match ? match[1] : null;
}

function extractCity(text: string): string | null {
  for (const city of CITIES) {
    if (text.includes(city)) return city;
  }
  return null;
}

function guessPlaceType(text: string): string | null {
  const lower = text.toLowerCase();
  if (/餐廳|美食|小吃|料理|麵|飯|鍋|燒烤|bbq|food|restaurant|拉麵|壽司|丼|串燒|熱炒|牛排|火鍋|滷肉/.test(lower)) return "restaurant";
  if (/咖啡|cafe|coffee|甜點|蛋糕|下午茶|dessert/.test(lower)) return "cafe";
  if (/酒吧|bar|pub|調酒|居酒屋|啤酒/.test(lower)) return "bar";
  if (/住宿|飯店|民宿|hotel|旅館|villa|露營|glamping/.test(lower)) return "hotel";
  if (/景點|秘境|步道|瀑布|海邊|山|溫泉|古蹟|老街|夜景|觀景/.test(lower)) return "attraction";
  return null;
}

// Fetch OG meta from URL for auto-classification
async function fetchOgMeta(url: string): Promise<{ title: string | null; description: string | null; placeName: string | null; imageUrl: string | null }> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; TravelBookmarkBot/1.0)" },
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
    });
    const html = await res.text();

    const ogTitle = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"/)
      || html.match(/<meta[^>]*content="([^"]*)"[^>]*property="og:title"/);
    const ogDesc = html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]*)"/)
      || html.match(/<meta[^>]*content="([^"]*)"[^>]*property="og:description"/);
    const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/);

    // Clean up IG-style titles
    let rawTitle = cleanCaption(ogTitle?.[1] || titleTag?.[1] || null);
    if (rawTitle) {
      const igMatch = rawTitle.match(/在 Instagram[：:]\s*["""]?(.+)/) || rawTitle.match(/on Instagram[：:]\s*["""]?(.+)/);
      if (igMatch) {
        rawTitle = igMatch[1].replace(/["""]\s*$/, '');
      }
    }

    // description 刻意保留原文：handleUrl 會把 title 與 description 併起來再一次 cleanCaption()，
    // 這樣「og:title 就是文案第一行」造成的重複才偵測得到。
    const rawDesc = ogDesc?.[1] || null;

    // Try to extract actual place name from title + description
    const combined = [rawTitle, cleanCaption(rawDesc)].filter(Boolean).join(" ");
    const placeName = extractPlaceName(combined);

    // For display: truncate rawTitle
    if (rawTitle) {
      rawTitle = rawTitle.split(/[\n\r]/)[0].trim();
      if (rawTitle.length > 60) {
        rawTitle = rawTitle.substring(0, 57) + '...';
      }
    }

    // Extract og:image
    const ogImage = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]*)"/)
      || html.match(/<meta[^>]*content="([^"]*)"[^>]*property="og:image"/);

    return {
      title: rawTitle,
      description: rawDesc,
      placeName,
      imageUrl: ogImage?.[1] || null,
    };
  } catch {
    return { title: null, description: null, placeName: null, imageUrl: null };
  }
}

async function handleUrl(url: string, extraText: string, replyToken: string) {
  const platform = detectPlatform(url);
  const cleanText = extraText.replace(/(https?:\/\/[^\s]+)/g, "").trim();

  // 1. Try to extract city from user's message text
  let city = extractCity(cleanText);
  let placeType = guessPlaceType(cleanText);

  // 2. Fetch OG meta for more info
  const og = await fetchOgMeta(url);
  const ogCombined = [og.title, cleanCaption(og.description)].filter(Boolean).join(" ");

  // 3. Determine title: user text > extracted place name > OG title
  let title: string | null = cleanText || null;
  if (!title && og.placeName) {
    title = og.placeName;
  }
  // Store full OG caption as description (even if we extracted a place name from it)
  const description = cleanCaption(
    og.title && og.title !== title
      ? og.title + (og.description ? `\n${og.description}` : '')
      : og.description || null
  );

  // Try to extract city/placeType from OG meta if not found in user text
  if (!city) {
    city = extractCity(ogCombined);
  }
  if (!placeType) {
    placeType = guessPlaceType(ogCombined);
  }

  // Check if this URL already exists (RPC returns existing on conflict)
  const { data, error } = await supabase.rpc("insert_bookmark_from_bot", {
    p_group_id: DEFAULT_GROUP_ID,
    p_created_by: DEFAULT_USER_ID,
    p_url: url,
    p_platform: platform,
    p_title: title || og.title || null,
    p_description: description,
    p_image_url: og.imageUrl,
    p_city: city,
    p_place_type: placeType,
  });

  if (error) {
    console.error("[line-webhook] insert_bookmark_from_bot failed:", error);
    const hint = error.message?.includes("fetch failed")
      ? "\n連不到資料庫，可能是 Supabase 專案被暫停了"
      : "";
    await replyMessage(replyToken, [
      { type: "text", text: `❌ 儲存失敗：${error.message}${hint}` },
    ]);
    return;
  }

  // Detect duplicate: if returned record has a different created_at than now, it's existing
  const isDuplicate = data && new Date(data.created_at).getTime() < Date.now() - 10000;

  if (isDuplicate) {
    const existingTitle = data.title || "未命名";
    await replyMessage(replyToken, [
      { type: "text", text: `⚠️ 這個連結已經收藏過了！\n📌 ${existingTitle}${data.city ? `\n📍 ${data.city}` : ''}` },
    ]);
    return;
  }

  const emoji = platformEmoji(platform);
  const typeEmoji = placeTypeEmoji(placeType);
  const parts = [`${emoji} 已收藏！`];
  if (title) parts.push(`📌 ${title}`);
  if (!title && og.title) parts.push(`📝 ${og.title}`);
  if (city) parts.push(`📍 ${city}`);
  if (placeType) parts.push(`${typeEmoji} ${placeType}`);
  if (!title) parts.push(`\n💡 沒偵測到店名，你可以到網頁上編輯`);
  if (!city) parts.push(`\n💡 我沒偵測到地區，你可以補充：「嘉義」就好`);

  await replyMessage(replyToken, [
    { type: "text", text: parts.join("\n") },
  ]);
}

async function handleQuery(text: string, replyToken: string) {
  const cityMatch = text.match(/(台北|新北|基隆|桃園|新竹|苗栗|台中|彰化|南投|雲林|嘉義|台南|高雄|屏東|宜蘭|花蓮|台東|澎湖|金門|馬祖)/);

  if (cityMatch) {
    const city = cityMatch[1];
    const { data } = await supabase.rpc("query_bookmarks_by_city", {
      p_group_id: DEFAULT_GROUP_ID,
      p_city: city,
    });

    const bookmarks = data || [];
    if (bookmarks.length === 0) {
      await replyMessage(replyToken, [
        { type: "text", text: `📍 ${city} 目前沒有收藏，傳連結給我開始收集吧！` },
      ]);
      return;
    }

    const list = bookmarks
      .map((b: Record<string, string | boolean>, i: number) => {
        const emoji = placeTypeEmoji(b.place_type as string);
        const visited = b.visited ? "✅" : "⬜";
        return `${i + 1}. ${visited} ${emoji} ${b.title || "未命名"}\n   ${b.url}`;
      })
      .join("\n\n");

    await replyMessage(replyToken, [
      { type: "text", text: `📍 ${city} 的收藏（${bookmarks.length} 筆）：\n\n${list}` },
    ]);
    return;
  }

  // General search
  const { data } = await supabase.rpc("search_bookmarks", {
    p_group_id: DEFAULT_GROUP_ID,
    p_keyword: text,
  });

  const bookmarks = data || [];
  if (bookmarks.length === 0) {
    await replyMessage(replyToken, [
      { type: "text", text: `🔍 找不到「${text}」相關的收藏。\n\n💡 傳連結收藏，或輸入縣市名查看該地區收藏！` },
    ]);
    return;
  }

  const list = bookmarks
    .map((b: Record<string, string>, i: number) => `${i + 1}. ${placeTypeEmoji(b.place_type)} ${b.title || "未命名"}（${b.city || "未分類"}）\n   ${b.url}`)
    .join("\n\n");

  await replyMessage(replyToken, [
    { type: "text", text: `🔍 「${text}」的搜尋結果：\n\n${list}` },
  ]);
}

async function handleStats(replyToken: string) {
  const { data } = await supabase.rpc("bookmark_stats", {
    p_group_id: DEFAULT_GROUP_ID,
  });

  const stats = data || { total: 0, by_city: [] };
  const cityList = (stats.by_city || [])
    .map((c: { city: string; count: number }) => `  ${c.city}: ${c.count}`)
    .join("\n");

  await replyMessage(replyToken, [
    {
      type: "text",
      text: `📊 收藏統計\n\n總共：${stats.total} 筆\n\n按地區：\n${cityList || "  尚無資料"}`,
    },
  ]);
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("x-line-signature") || "";

  if (!verifySignature(body, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }

  const payload = JSON.parse(body);
  const events = payload.events || [];

  for (const event of events) {
    if (event.type !== "message" || !event.replyToken) continue;

    const { message, replyToken } = event;

    if (message.type === "text") {
      const text = message.text.trim();
      const url = extractUrl(text);

      if (url) {
        await handleUrl(url, text, replyToken);
      } else if (/^(help|說明|幫助)$/i.test(text)) {
        await replyMessage(replyToken, [
          {
            type: "text",
            text: `📍 Travel Bookmark 使用說明\n\n🔗 傳連結 → 自動收藏\n支援 IG / 小紅書 / YouTube / TikTok\n\n🔍 輸入縣市名 → 查看該地區收藏\n例：「台南」「花蓮」\n\n🔎 輸入關鍵字 → 搜尋收藏\n例：「燒烤」「咖啡」\n\n📊 輸入「統計」→ 查看收藏統計`,
          },
        ]);
      } else if (/^(統計|stats)$/i.test(text)) {
        await handleStats(replyToken);
      } else {
        await handleQuery(text, replyToken);
      }
    } else if (message.type === "image") {
      await replyMessage(replyToken, [
        { type: "text", text: "📸 收到圖片！圖片辨識功能開發中，請先傳連結或文字描述 🙏" },
      ]);
    }
  }

  return NextResponse.json({ status: "ok" });
}

export async function GET() {
  return NextResponse.json({ status: "Travel Bookmark LINE Bot is running" });
}
