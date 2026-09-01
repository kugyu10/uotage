type Option = { id: string; name: string };

export type ProductFormValues = {
  id?: string;
  name?: string;
  stripe_price_id?: string;
  content_url?: string | null;
  post_purchase_scenario_id?: string | null;
  post_purchase_label_id?: string | null;
};

export function ProductForm({
  action,
  scenarios,
  labels,
  initial,
  submitLabel,
}: {
  action: (formData: FormData) => Promise<void>;
  scenarios: Option[];
  labels: Option[];
  initial?: ProductFormValues;
  submitLabel: string;
}) {
  return (
    <form action={action} className="admin-form">
      {initial?.id ? <input type="hidden" name="id" defaultValue={initial.id} /> : null}
      <label>
        商品名
        <input type="text" name="name" defaultValue={initial?.name} required maxLength={200} />
      </label>
      <label>
        Stripe Price ID
        <input type="text" name="stripe_price_id" defaultValue={initial?.stripe_price_id} required placeholder="price_..." />
      </label>
      <label>
        コースURL（content_url）
        <input type="url" name="content_url" defaultValue={initial?.content_url ?? ""} />
      </label>
      <label>
        購入後に登録するシナリオ
        <select name="post_purchase_scenario_id" defaultValue={initial?.post_purchase_scenario_id ?? ""}>
          <option value="">未選択</option>
          {scenarios.map((scenario) => (
            <option key={scenario.id} value={scenario.id}>{scenario.name}</option>
          ))}
        </select>
      </label>
      <label>
        購入後に付与するラベル
        <select name="post_purchase_label_id" defaultValue={initial?.post_purchase_label_id ?? ""}>
          <option value="">未選択</option>
          {labels.map((label) => (
            <option key={label.id} value={label.id}>{label.name}</option>
          ))}
        </select>
      </label>
      <button type="submit">{submitLabel}</button>
    </form>
  );
}
