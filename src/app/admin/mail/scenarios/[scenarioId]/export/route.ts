import "server-only";

import { requireOperator } from "@/lib/supabase/server";
import { isUuid } from "@/lib/uuid";
import { buildScenarioExportCsv, type ExportReaderRow } from "@/lib/csv/export-rows";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ scenarioId: string }> };

/**
 * シナリオ単位の読者一覧を UTAGE互換CSV（要件定義書 10.1）でエクスポートする。
 * UTF-8 BOM付き・日本語ヘッダー・CSVインジェクション対策込み。tenant_idスコープ必須。
 */
export async function GET(_request: Request, { params }: RouteParams): Promise<Response> {
  const { scenarioId } = await params;
  if (!isUuid(scenarioId)) {
    return new Response("Not Found", { status: 404 });
  }

  const { supabase, operator } = await requireOperator();

  const { data: scenario } = await supabase
    .from("scenarios")
    .select("id, name")
    .eq("tenant_id", operator.tenant_id)
    .eq("id", scenarioId)
    .maybeSingle();
  if (!scenario) {
    return new Response("Not Found", { status: 404 });
  }

  const { data: enrollments, error: enrollmentsError } = await supabase
    .from("scenario_readers")
    .select("reader_id, registered_at, registration_path")
    .eq("tenant_id", operator.tenant_id)
    .eq("scenario_id", scenarioId);
  if (enrollmentsError) {
    return new Response("Internal Server Error", { status: 500 });
  }

  const readerIds = Array.from(new Set((enrollments ?? []).map((row) => row.reader_id)));

  const exportRows: ExportReaderRow[] = [];

  if (readerIds.length > 0) {
    const [{ data: readers }, { data: readerLabels }, { data: labels }, { data: purchases }, { data: products }] =
      await Promise.all([
        supabase
          .from("readers")
          .select("id, email, name, custom_fields, unsubscribed_at")
          .eq("tenant_id", operator.tenant_id)
          .in("id", readerIds),
        supabase.from("reader_labels").select("reader_id, label_id").eq("tenant_id", operator.tenant_id).in("reader_id", readerIds),
        supabase.from("labels").select("id, name").eq("tenant_id", operator.tenant_id),
        supabase.from("purchases").select("reader_id, product_id").eq("tenant_id", operator.tenant_id).in("reader_id", readerIds),
        supabase.from("products").select("id, name").eq("tenant_id", operator.tenant_id),
      ]);

    const labelNameById = new Map((labels ?? []).map((label) => [label.id, label.name]));
    const productNameById = new Map((products ?? []).map((product) => [product.id, product.name]));

    const labelNamesByReaderId = new Map<string, string[]>();
    for (const link of readerLabels ?? []) {
      const name = labelNameById.get(link.label_id);
      if (!name) continue;
      const list = labelNamesByReaderId.get(link.reader_id) ?? [];
      list.push(name);
      labelNamesByReaderId.set(link.reader_id, list);
    }

    const purchasedProductNamesByReaderId = new Map<string, string[]>();
    for (const purchase of purchases ?? []) {
      const name = productNameById.get(purchase.product_id);
      if (!name) continue;
      const list = purchasedProductNamesByReaderId.get(purchase.reader_id) ?? [];
      list.push(name);
      purchasedProductNamesByReaderId.set(purchase.reader_id, list);
    }

    const readerById = new Map((readers ?? []).map((reader) => [reader.id, reader]));

    for (const enrollment of enrollments ?? []) {
      const reader = readerById.get(enrollment.reader_id);
      if (!reader) continue;
      exportRows.push({
        email: reader.email,
        name: reader.name,
        registeredAt: enrollment.registered_at,
        registrationPath: enrollment.registration_path,
        labels: labelNamesByReaderId.get(reader.id) ?? [],
        purchasedProducts: purchasedProductNamesByReaderId.get(reader.id) ?? [],
        unsubscribed: Boolean(reader.unsubscribed_at),
        customFields: (reader.custom_fields as Record<string, unknown>) ?? {},
      });
    }

    exportRows.sort((a, b) => a.email.localeCompare(b.email));
  }

  const csv = buildScenarioExportCsv(exportRows);
  const body = new TextEncoder().encode(csv);
  const encodedFilename = encodeURIComponent(`${scenario.name}.csv`);

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="export.csv"; filename*=UTF-8''${encodedFilename}`,
      "Cache-Control": "no-store",
    },
  });
}
