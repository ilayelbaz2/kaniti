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
  // Only the whole brand counts as "already in the name" — "עוף טוב" is not in "פרגיות עוף".
  if (` ${norm(name)} `.includes(` ${norm(brand)} `) || norm(name).startsWith(norm(brand))) return name;
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
  // Weighted: the price shown next to it is per kg; the line just says how it's sold.
  if (p.byWeight || /לק"?ג|לק״ג/.test(p.sizeText ?? '')) return `${title} · נמכר לפי משקל`;
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

/** Estimated amounts without fake precision: "~2 בקבוקים", "פחות מ־1 בקבוקים" (never "~6.9 בקבוקים"). */
export function qtyText(x: number, unit: string): string {
  const u = unit ? ` ${unit}` : '';
  if (x <= 0.05) return `0${u}`;
  if (x < 1) return unit ? `פחות מ־1 (${unit})` : 'פחות מ־1';
  return `~${Math.round(x)}${u}`;
}

/** Usage per two weeks: "~8 קופסאות לשבועיים", or "בערך פעם ב־7 שבועות" for slow items like Vanish. */
export function per14Text(x: number, unit: string): string {
  if (x <= 0) return 'לא בשימוש';
  if (x < 1) return `בערך אחת ל־${Math.max(3, Math.round(2 / x))} שבועות`;
  return `~${Math.round(x)}${unit ? ` ${unit}` : ''} לשבועיים`;
}
