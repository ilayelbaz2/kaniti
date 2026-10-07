import { useEffect, useRef, useState } from 'react';
import type { Ctx } from '../App.tsx';
import { api, type SearchCard, type SearchResponse } from '../api.ts';
import { nis } from '../components/ChatParts.tsx';
import { productLine } from '../../shared/product.ts';

/** "+ הוסף מוצר": search → pick an exact product (or let Kaniti pick the best value) → quantity → add. */
export function AddProductSheet({ ctx, initial, onClose }: { ctx: Ctx; initial?: string; onClose: () => void }) {
  const [q, setQ] = useState(initial ?? '');
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [pick, setPick] = useState<SearchCard | 'auto' | null>(null);
  const [qty, setQty] = useState(1);
  const [saving, setSaving] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const text = q.trim();
    setPick(null);
    if (text.length < 2) { setRes(null); return; }
    const my = ++seq.current;
    setLoading(true);
    const t = setTimeout(() => {
      api.search(text).then((r) => { if (my === seq.current) setRes(r); }).catch(() => { if (my === seq.current) setRes({ query: text, results: [], failures: ['שגיאה'] }); })
        .finally(() => { if (my === seq.current) setLoading(false); });
    }, 450);
    return () => clearTimeout(t);
  }, [q]);

  const add = async () => {
    if (!pick || !res) return;
    setSaving(true);
    try {
      const product = pick === 'auto' ? undefined : { providerId: pick.providerId, productId: pick.productId };
      const s = res.concept ? await api.add(res.concept.id, qty, product) : await api.addLabel(res.query, qty, product);
      ctx.setState(s);
      ctx.toast(pick === 'auto' ? `${res.concept?.label ?? res.query} נוסף — אבחר את המשתלם` : `נוסף: ${productLine(pick)}`);
      onClose();
    } catch (e) { ctx.toast((e as Error).message); } finally { setSaving(false); }
  };

  return (
    <>
      <div className="sheet-back" onClick={onClose} />
      <div className="sheet stack" role="dialog" aria-label="הוספת מוצר">
        <div className="grab" />
        <h2>הוסף מוצר</h2>
        <input className="field" autoFocus placeholder="מה להוסיף? למשל: חרדל, פרגיות, מרכך כביסה" value={q} onChange={(e) => setQ(e.target.value)} />
        {loading && <div className="stages"><div className="on">מחפש ברשתות שלכם…</div></div>}
        {res && !loading && (
          <div className="stack" style={{ maxHeight: '50vh', overflowY: 'auto' }}>
            <button className={`card stack ${pick === 'auto' ? 'win' : ''}`} style={{ textAlign: 'start' }} onClick={() => setPick('auto')}>
              <b>✨ תן לקניתי לבחור את המשתלם</b>
              <span className="small muted">{res.concept ? `${res.concept.emoji} ${res.concept.label}` : res.query} — אבחר את המוצר הכי משתלם בכל רשת, לפי ההעדפות שלכם</span>
            </button>
            {res.results.length === 0 && <div className="faint">{res.failures.length ? `לא הצלחתי לחפש כרגע (${res.failures.join(', ')}).` : `לא מצאתי "${res.query}" ברשתות שלכם. אפשר עדיין להוסיף לרשימה — אחפש שוב כשיהיו מחירים.`}</div>}
            {res.results.map((r) => (
              <button key={`${r.providerId}|${r.productId}`} className={`card stack ${pick !== 'auto' && pick?.productId === r.productId && pick.providerId === r.providerId ? 'win' : ''}`} style={{ textAlign: 'start', gap: 2 }} onClick={() => setPick(r)}>
                <div className="spread" style={{ alignItems: 'flex-start' }}>
                  <b className="small">{productLine(r)}</b>
                  <b>{nis(r.promoPrice ?? r.price)}</b>
                </div>
                <div className="row wrap small muted" style={{ gap: 6 }}>
                  <span>{r.providerName}</span>
                  {r.promoPrice && r.promoPrice < r.price && <s className="faint">{nis(r.price)}</s>}
                  {r.promoText && <span className="tag opportunity">🔥 {r.promoText}</span>}
                  {r.unitPriceText && <span className="faint">{r.unitPriceText}</span>}
                  {r.ambiguous && <span className="tag estimate">פרטים חסרים</span>}
                </div>
              </button>
            ))}
          </div>
        )}
        {pick && (
          <div className="spread">
            <span>כמות</span>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn ghost" style={{ minWidth: 44 }} onClick={() => setQty(Math.max(1, qty - 1))} aria-label="פחות">−</button>
              <b style={{ minWidth: 24, textAlign: 'center' }}>{qty}</b>
              <button className="btn ghost" style={{ minWidth: 44 }} onClick={() => setQty(qty + 1)} aria-label="עוד">+</button>
            </div>
          </div>
        )}
        <button className="btn block" disabled={!pick || saving} onClick={add}>{saving ? 'מוסיף…' : 'הוסף לסל'}</button>
        <button className="btn ghost" onClick={onClose}>סגור</button>
      </div>
    </>
  );
}
