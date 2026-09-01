import { notFound, redirect } from "next/navigation";

import { Countdown } from "@/app/offer/[slug]/countdown";
import { findActiveOffer } from "@/lib/public-access";

export const dynamic = "force-dynamic";

export default async function OfferPage({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const token = typeof query.token === "string" ? query.token : "";
  if (!token) notFound();
  const serverNow = new Date();
  const offer = await findActiveOffer(slug, token, serverNow);
  if (!offer) redirect("/offer-ended");

  return (
    <main className="public-card-page"><section>
      <p className="eyebrow">期間限定・個別相談</p>
      <h1>{offer.funnelName}</h1>
      <p>現在の状況を整理し、次の一歩を一緒に設計します。</p>
      <Countdown deadlineAt={offer.deadlineAt} serverNow={serverNow.toISOString()} />
      <a className="primary-link" href={offer.bookingUrl} rel="nofollow noreferrer">個別相談の日程を選ぶ</a>
    </section></main>
  );
}
