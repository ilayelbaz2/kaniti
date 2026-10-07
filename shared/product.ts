// How a concrete product identifies itself on every screen: brand + name (+ variant, which lives in the name) + size.
// Pure; shared by server and client. Display only — the raw provider name stays the matching key.

export type ProductIdentity = { name: string; brand?: string; sizeText?: string; unitPriceText?: string; byWeight?: boolean; price?: number };

const norm = (s: string) => s.replace(/[֑-ׇ"'׳״`.\-–]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

/** Feeds sometimes put placeholders in the brand/manufacturer field. */
export function cleanBrand(b?: string): string | undefined {
  const t = (b ?? '').trim();
  if (!t || /^(general|כללי|לא ידוע|unknown|n\/?a|-+|\d+|ללא|ללא מותג|no brand|יצרן לא ידוע)$/i.test(t) || t.length > 40) return undefined;
  return t;
}

/** "819 מ״ל" / "1.5 ליטר" / "500 גרם" / "12 יח׳" / "6*1.5" found in a name or size text. */
export function sizeIn(s: string): string | undefined {
  const m = s.match(/(\d+(?:[.,]\d+)?\s*[*xX×]\s*)?\d+(?:[.,]\d+)?\s*(?:מ"ל|מ״ל|מל|ml|ליטר|ל'|ל׳|ל(?=\s|$)|גרם|גר'|גר׳|גר(?=\s|$)|ג'|ג׳|ג(?=\s|$)|ק"ג|ק״ג|קג|קילו|kg|g|יח'|יח׳|יחידות|יח(?=\s|$)|כביסות|טבליות|גלילים|שקיות|מטר)/i);
  return m?.[0].replace(/\s+/g, ' ').trim();
}

/** Brand + name, without repeating the brand if the name already says it. */
export function productTitle(p: ProductIdentity): string {
  const name = p.name.replace(/\s+/g, ' ').trim();
  const brand = cleanBrand(p.brand);
  if (!brand) return name;
  const n = norm(name);
  const tokens = norm(brand).split(' ').filter((w) => w.length >= 3);
  if (n.includes(norm(brand)) || tokens.some((w) => n.includes(w))) return name;
  return `${brand} ${name}`;
}

/** The pack size to show next to the title, unless the name already contains it. Weighted items: per kg. */
export function productSize(p: ProductIdentity): string | undefined {
  if (p.byWeight || /לק"?ג|לק״ג/.test(p.sizeText ?? '')) return 'לפי משקל';
  const s = (p.sizeText ?? '').trim();
  if (!s) return undefined;
  const inName = sizeIn(p.name);
  if (inName && norm(inName).replace(/\s/g, '') === norm(sizeIn(s) ?? s).replace(/\s/g, '')) return undefined;
  return s;
}

/** One line: "לנור מרכך כביסה מרוכז כחול · 819 מ״ל" or "פרגיות עוף טוב · ₪39.90 לק״ג". */
export function productLine(p: ProductIdentity): string {
  const title = productTitle(p);
  if (p.byWeight || /לק"?ג|לק״ג/.test(p.sizeText ?? '')) {
    const per = p.unitPriceText ?? (p.price !== undefined ? `₪${p.price} לק״ג` : 'לפי משקל');
    return `${title} · ${per}`;
  }
  const size = productSize(p);
  return size ? `${title} · ${size}` : title;
}

/** No brand AND no size anywhere = we can't tell the user what exactly this is. */
export function identityGaps(p: ProductIdentity): { ambiguous: boolean; missing: ('brand' | 'size')[] } {
  const missing: ('brand' | 'size')[] = [];
  const hasBrand = !!cleanBrand(p.brand);
  const hasSize = !!(p.byWeight || p.sizeText?.trim() || sizeIn(p.name));
  if (!hasBrand) missing.push('brand');
  if (!hasSize) missing.push('size');
  return { ambiguous: !hasBrand && !hasSize, missing };
}
