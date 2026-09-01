import { NextResponse } from "next/server";

import { createUserClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (code) {
    const { error } = await (await createUserClient()).auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL("/admin", request.url));
  }
  return NextResponse.redirect(new URL("/login?error=callback", request.url));
}
