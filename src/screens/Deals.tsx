import { useEffect, useState } from 'react';
import type { Deal } from '../../shared/types.ts';
import type { Ctx } from '../App.tsx';
import { api } from '../api.ts';
import { nis, SourceTag } from '../components/ChatParts.tsx';
import { productLine } from '../../shared/product.ts';

const SECTIONS: [Deal['kind'], string, string, string][] = [
  ['now', '🔥', 'שווה עכשיו', 'דברים שתצטרכו בקרוב, במחיר טוב'],
  ['stock', '📦', 'שווה לעשות סטוק', 'נשמרים לאורך זמן, במחיר חריג'],
  ['anyway', '🛒', 'דברים שאתם קונים בכל מקרה', 'מחיר טוב כרגע — לא בהכרח מבצע'],
  ['discovery', '💡', 'אולי תאהבו', 'משהו חדש, במידה'],
];

const endsText = (iso?: string) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `עד ${d.toLocaleDateString('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric' })}`;
};

export function Deals({ ctx }: { ctx: Ctx }) {
  const { setState, toast, state } = ctx;
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [failures, setFailures] = useState<string[]>([]);
  const [demo, setDemo] = useState(false);
  const [note, setNote] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setDeals(null); setError(null);
    try {
      const r = await api.deals();
      setDeals(r.deals); setFailures(r.failures.map((f) => f.name)); setDemo(r.demo); setNote(r.note);
    } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void load(); }, []);

  const inBasket = (needId: string) => state.basket?.status === 'building' ? state.basket.items.find((i) => i.needId === needId && i.accepted) : undefined;
  const take = async (d: Deal, qty: number) => {
    const cur = inBasket(d.needId);
    setState(await api.add(d.needId, (cur?.quantity ?? 0) + qty, { providerId: d.product.providerId, productId: d.product.productId }));
    toast(`${productLine(d.product)} × ${qty} בסל ✓`);
  };
  const skip = async (d: Deal) => {
    await api.dismissDeal(d.id, d.needId);
    setDeals((ds) => ds?.filter((x) => x.id !== d.id) ?? null);
  };

  return (
    <div className="screen stack">
      <div className="screen-head"><h1>מצאתי בשבילכם</h1><button className="link" onClick={load}>רענן</button></div>
      {demo && <div className="banner demo">מצב דמו — המחירים אינם אמיתיים</div>}
      {failures.length > 0 && <div className="banner warn">{failures.join(', ')} לא החזירו מחיר כרגע — המשכתי עם שאר הרשתות.</div>}
      {error && <div className="empty"><div className="emo">😕</div><div>{error}</div><button className="btn" onClick={load}>לנסות שוב</button></div>}
      {!deals && !error && <><div className="stages"><div className="on">בודק מבצעים בכל הרשתות שלכם…</div></div><div className="skeleton" /><div className="skeleton" /></>}
      {deals && note && <div className={deals.length ? 'faint' : 'empty'}>{!deals.length && <div className="emo">🤷</div>}<div>{note}</div>{!deals.length && <div className="faint">מבצע של 40% על משהו שלא קונים — זה לא מבצע.</div>}</div>}
      {deals && SECTIONS.map(([kind, icon, title, sub]) => {
        const list = deals.filter((d) => d.kind === kind);
        if (!list.length) return null;
        return (
          <section key={kind} className="stack">
            <div><div className="group-title">{icon} {title} · {list.length}</div><div className="faint">{sub}</div></div>
            {list.map((d) => {
              const cur = inBasket(d.needId);
              const eff = d.product.promoPrice ?? d.product.price;
              return (
                <div key={d.id} className={`card stack ${kind === 'discovery' ? 'discovery-card' : ''}`}>
                  <div className="spread" style={{ alignItems: 'flex-start' }}>
                    <b>{d.emoji} {productLine(d.product)}</b>
                    <SourceTag s={d.product.source} />
                  </div>
                  <div className="row wrap small" style={{ gap: 8 }}>
                    <b className="big-num" style={{ fontSize: 20 }}>{nis(eff)}{d.product.byWeight ? ' לק״ג' : ''}</b>
                    {d.regularPrice && d.regularPrice > eff && <s className="faint">{nis(d.regularPrice)}</s>}
                    {d.discountPct > 0 && <span className="tag opportunity">‎−{d.discountPct}%</span>}
                    <span className="muted">{d.providerName ?? d.product.providerId}</span>
                  </div>
                  <div className="faint">{[d.product.promoText, d.unitPriceText, endsText(d.promoEndsAt) ?? (d.product.promoText ? 'לא ידוע עד מתי' : null)].filter(Boolean).join(' · ')}</div>
                  <div className="small muted">{d.why}</div>
                  {cur && <div className="small">✓ כבר בסל ({cur.quantity} × {cur.unit})</div>}
                  <div className="row wrap">
                    {kind === 'stock' ? <>
                      <button className="btn small" onClick={() => take(d, d.suggestQty)}>{cur ? `עוד ${d.suggestQty}` : `קח ${d.suggestQty}`}</button>
                      {d.suggestQty > 1 && <button className="btn small ghost" onClick={() => take(d, 1)}>{cur ? 'עוד 1' : 'קח 1'}</button>}
                      <button className="btn small ghost" onClick={() => skip(d)}>דלג</button>
                    </> : <>
                      <button className="btn small" onClick={() => take(d, d.suggestQty)}>{cur ? `הוסף עוד ${d.suggestQty}` : kind === 'discovery' ? 'הוסף' : `הוסף לסל (${d.suggestQty})`}</button>
                      <button className="btn small ghost" onClick={() => skip(d)}>{kind === 'discovery' ? 'לא הפעם' : 'לא מעניין'}</button>
                    </>}
                    {kind !== 'discovery' && <button className="chip" onClick={async () => { await api.alwaysDeal(d.needId); toast('אראה לכם תמיד כשזה זול'); }}>🔔 תמיד תראה לי אם זול</button>}
                  </div>
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
