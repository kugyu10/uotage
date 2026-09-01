import "server-only";

import { requireOperator } from "@/lib/supabase/server";
import {
  fetchAllPages,
  fetchInChunks,
  MAX_PAGINATED_ROWS,
  SUPABASE_PAGE_SIZE,
  TOO_MANY_ROWS,
} from "@/lib/supabase/paginate";
import { isUuid } from "@/lib/uuid";
import { buildScenarioExportCsv, type ExportReaderRow } from "@/lib/csv/export-rows";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ scenarioId: string }> };

/**
 * シナリオ単位の読者一覧を UTAGE互換CSV（要件定義書 10.1）でエクスポートする。
 * UTF-8 BOM付き・日本語ヘッダー・CSVインジェクション対策込み。tenant_idスコープ必須。
 *
 * 件数対策の方針（レビュー指摘: `.in("id", readerIds)` に読者IDを全件渡していた）:
 *   - 起点の scenario_readers を `.range()` でページングする。読者2,000人で約74KBの
 *     クエリ文字列になり、PostgREST/プロキシのURI長制限に当たっていた。
 *     `db-max-rows` が設定された環境では `.range()` 無しの取得が黙って打ち切られるため、
 *     ページングはその取りこぼし対策も兼ねる。
 *   - readers / reader_labels / purchases は reader_id を `.in()` に渡すが、
 *     fetchInChunks で SUPABASE_IN_CHUNK_SIZE 件ずつに割るためURI長が有界になる。
 *   - scenario_readers 起点の join 1本にはしなかった。埋め込みリソース（labels や
 *     purchases のような 1:N）を join で引くと1読者が複数行に分解され、PostgREST の
 *     行数上限とページング境界がラベル単位になってページングの意味が崩れるため。
 *
 * ストリーミング（Transfer-Encoding: chunked）にはしていない。CSVのヘッダー行は
 * custom_fields の全キーの和集合で決まる（buildScenarioExportCsv）ため、
 * 1行目を書き出す前に全行を読み終える必要がある。二度読みするほうがDB負荷が上がるので、
 * 上限件数（MAX_PAGINATED_ROWS）を設けたうえでメモリに積む方式を選んだ。
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

  // ラベル名・商品名の引き当て表。テナント単位では件数が小さいはずだが、
  // 打ち切られると名前が空欄のCSVを黙って出すことになるためページングする。
  const exportRows: ExportReaderRow[] = [];

  try {
    const [labels, products] = await Promise.all([
      fetchAllPages<{ id: string; name: string }>((from, to) =>
        supabase.from("labels").select("id, name").eq("tenant_id", operator.tenant_id).order("id").range(from, to),
      ),
      fetchAllPages<{ id: string; name: string }>((from, to) =>
        supabase.from("products").select("id, name").eq("tenant_id", operator.tenant_id).order("id").range(from, to),
      ),
    ]);
    const labelNameById = new Map(labels.map((label) => [label.id, label.name]));
    const productNameById = new Map(products.map((product) => [product.id, product.name]));

    // scenario_readers を1ページずつ進め、そのページ分の関連データだけを引く。
    // reader_id で order することで、ページ境界での重複・欠落を防ぐ。
    for (let from = 0; ; from += SUPABASE_PAGE_SIZE) {
      const { data: enrollments, error: enrollmentsError } = await supabase
        .from("scenario_readers")
        .select("reader_id, registered_at, registration_path")
        .eq("tenant_id", operator.tenant_id)
        .eq("scenario_id", scenarioId)
        .order("reader_id")
        .range(from, from + SUPABASE_PAGE_SIZE - 1);
      if (enrollmentsError) {
        return new Response("Internal Server Error", { status: 500 });
      }

      const page = enrollments ?? [];
      if (page.length === 0) break;

      const readerIds = Array.from(new Set(page.map((row) => row.reader_id)));

      const [readers, readerLabels, purchases] = await Promise.all([
        fetchInChunks<
          string,
          {
            id: string;
            email: string;
            name: string | null;
            custom_fields: unknown;
            unsubscribed_at: string | null;
          }
        >(readerIds, (chunk, pageFrom, pageTo) =>
          supabase
            .from("readers")
            .select("id, email, name, custom_fields, unsubscribed_at")
            .eq("tenant_id", operator.tenant_id)
            .in("id", chunk)
            .order("id")
            .range(pageFrom, pageTo),
        ),
        // 1読者が複数ラベルを持つため、1チャンク分でも行数はページサイズを超えうる。
        // fetchInChunks はチャンク内をさらにページングするのでそれも吸収される。
        fetchInChunks<string, { reader_id: string; label_id: string }>(readerIds, (chunk, pageFrom, pageTo) =>
          supabase
            .from("reader_labels")
            .select("reader_id, label_id")
            .eq("tenant_id", operator.tenant_id)
            .in("reader_id", chunk)
            .order("reader_id")
            .order("label_id")
            .range(pageFrom, pageTo),
        ),
        fetchInChunks<string, { reader_id: string; product_id: string }>(readerIds, (chunk, pageFrom, pageTo) =>
          supabase
            .from("purchases")
            .select("reader_id, product_id")
            .eq("tenant_id", operator.tenant_id)
            .in("reader_id", chunk)
            .order("reader_id")
            .order("product_id")
            .range(pageFrom, pageTo),
        ),
      ]);

      const labelNamesByReaderId = new Map<string, string[]>();
      for (const link of readerLabels) {
        const name = labelNameById.get(link.label_id);
        if (!name) continue;
        const list = labelNamesByReaderId.get(link.reader_id) ?? [];
        list.push(name);
        labelNamesByReaderId.set(link.reader_id, list);
      }

      const purchasedProductNamesByReaderId = new Map<string, string[]>();
      for (const purchase of purchases) {
        const name = productNameById.get(purchase.product_id);
        if (!name) continue;
        const list = purchasedProductNamesByReaderId.get(purchase.reader_id) ?? [];
        list.push(name);
        purchasedProductNamesByReaderId.set(purchase.reader_id, list);
      }

      const readerById = new Map(readers.map((reader) => [reader.id, reader]));

      for (const enrollment of page) {
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

      // 全体の上限。超える場合は不完全なCSVを返さず 413 にする。
      if (exportRows.length > MAX_PAGINATED_ROWS) throw new Error(TOO_MANY_ROWS);
      if (page.length < SUPABASE_PAGE_SIZE) break;
    }
  } catch (error) {
    if (error instanceof Error && error.message === TOO_MANY_ROWS) {
      return new Response("読者数が多すぎるため一括エクスポートできません。", {
        status: 413,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return new Response("Internal Server Error", { status: 500 });
  }

  exportRows.sort((a, b) => a.email.localeCompare(b.email));

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
