type ProductOption = { id: string; name: string };

export type FunnelFormValues = {
  id?: string;
  name?: string;
  slug?: string;
  trigger_type?: string;
  product_id?: string | null;
  deadline_hours?: number;
  booking_url?: string | null;
  is_active?: boolean;
};

export function FunnelForm({
  action,
  products,
  initial,
  submitLabel,
}: {
  action: (formData: FormData) => Promise<void>;
  products: ProductOption[];
  initial?: FunnelFormValues;
  submitLabel: string;
}) {
  return (
    <form action={action} className="admin-form">
      {initial?.id ? <input type="hidden" name="id" defaultValue={initial.id} /> : null}
      <label>
        名称
        <input type="text" name="name" defaultValue={initial?.name} required maxLength={200} />
      </label>
      <label>
        スラッグ（半角英数字とハイフン）
        <input type="text" name="slug" defaultValue={initial?.slug} required pattern="[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?" />
      </label>
      <label>
        トリガー種別
        <select name="trigger_type" defaultValue={initial?.trigger_type ?? "registration"}>
          <option value="registration">登録</option>
          <option value="purchase">購入</option>
        </select>
      </label>
      <label>
        対象商品（購入トリガーは必須。登録トリガーでは任意 — 「購入済みには送らない」の判定対象）
        <select name="product_id" defaultValue={initial?.product_id ?? ""}>
          <option value="">未選択</option>
          {products.map((product) => (
            <option key={product.id} value={product.id}>{product.name}</option>
          ))}
        </select>
      </label>
      <label>
        期限（時間）
        <input type="number" name="deadline_hours" min={0} defaultValue={initial?.deadline_hours ?? 0} required />
      </label>
      <label>
        予約ページURL（booking_url）
        <input type="url" name="booking_url" defaultValue={initial?.booking_url ?? ""} />
      </label>
      <label className="admin-checkbox">
        <input type="checkbox" name="is_active" defaultChecked={initial?.is_active ?? true} />
        公開する
      </label>
      <button type="submit">{submitLabel}</button>
    </form>
  );
}
