import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

/**
 * 給 Vercel Cron 每天打一次（見 vercel.json），定期對資料庫做一次查詢，
 * 避免 Supabase 專案因閒置被暫停。
 *
 * 有設 CRON_SECRET 時，Vercel Cron 會自動帶 `Authorization: Bearer <CRON_SECRET>`。
 */
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const { error } = await supabase.from("bookmarks").select("id").limit(1);

  if (error) {
    // 詳細原因只留在伺服器 log，這支沒設 CRON_SECRET 時任何人都能呼叫
    console.error("[keep-alive] query failed:", error);
    return NextResponse.json({ ok: false }, { status: 503 });
  }

  return NextResponse.json({ ok: true });
}
