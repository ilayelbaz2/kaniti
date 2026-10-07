import { useEffect, useState } from 'react';
import type { BasketQuote, Comparison } from '../../shared/types.ts';
import type { Ctx } from '../App.tsx';
import { api } from '../api.ts';
import { nis, SourceTag } from '../components/ChatParts.tsx';
import { DELIVERY_LABEL, deliveryTagClass } from './CartSheet.tsx';
import { productLine } from '../../shared/product.ts';

const STAGES = ['בודק מחירים בכל רשת…', 'מחשב משלוח ושלמות סל…', 'בוחר המלצה…'];

export function Compare({ ctx }: { ctx: Ctx }) {
  const { state, openConfirm, go } = ctx;
  const [cmp, setCmp] = useState<Comparison | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState(0);
  const b = state.basket;
  const hasBasket = b?.status === 'building' && b.items.length > 0;

  const run = async () => {
    setLoading(true); setError(null); setStage(0);
    const t = setInterval(() => setStage((s) => Math.min(STAGES.length - 1, s + 1)), 1500);
    try { setCmp(await api.compare()); } catch (e) { setError((e as Error).message); } finally { clearInterval(t); setLoading(false); }
  };

  useEffect(() => {
    if (!hasBasket) return;
    api.comparison().then((c) => (c?.quotes ? setCmp(c) : run())).catch(() => run());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasBasket]);

  if (!hasBasket) return <div className="screen"><div className="empty"><div className="emo">⚖️</div><h2>אין סל להשוות</h2><div>בנו סל ואז אגיד לכם איפה הכי משתלם.</div><button className="btn" onClick={() => go('basket')}>לסל</button></div></div>;
  if (loading) return <div className="screen stack"><h1>איפה הכי משתלם הפעם?</h1><div className="stages">{STAGES.map((s, i) => <div key={s} className={i < stage ? 'done' : i === stage ? 'on' : ''}>{s}</div>)}</div><div className="skeleton" /><div className="skeleton" /></div>;
  if (error) return <div className="screen"><div className="empty"><div className="emo">😕</div><div>{error}</div><button className="btn" onClick={run}>לנסות שוב</button></div></div>;
  if (!cmp) return null;

  const ok = cmp.quotes.filter((q) => q.ok);
  const failed = cmp.quotes.filter((q) => !q.ok);
  const bestOnline = ok.find((q) => q.kind === 'online');
  const threshold = state.household?.driveSavingsThresholdNis ?? 60;

  return (
    <div className="screen stack">
      <div className="screen-head"><h1>איפה הכי משתלם הפעם?</h1><button className="link" onClick={run}>רענן</button></div>
      <div className="faint" style={{ marginTop: -10 }}>סל נוכחי: {cmp.itemsCount} פריטים · נבדק {new Date(cmp.createdAt).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}</div>
      {state.demoPrices && <div className="banner demo">מצב דמו — המחירים אינם אמיתיים</div>}
      <div className="reco">{cmp.recommendation.text}</div>
      {ok.map((q) => <QuoteCard key={q.providerId} q={q} win={q.providerId === cmp.recommendation.winnerId} bestOnline={bestOnline} threshold={threshold} onCart={ctx.openCart} />)}
      {failed.map((q) => (
        <div className="card stack" key={q.providerId} style={{ opacity: 0.75 }}>
          <b>{q.providerName}</b>
          <div className="small muted">{q.kind === 'online' ? 'לא הצלחתי להשלים סל חי כרגע. לא אציג מחירים כאילו זה checkout אמיתי.' : 'לא הצלחתי לקרוא את קובץ המחירים של הסניף כרגע.'}</div>
          {q.error && <div className="faint">{q.error}</div>}
        </div>
      ))}
      <div className="faint">"חי אונליין" = מחיר מאתר הרשת עכשיו. "קובץ מחירים רשמי" = קבצי שקיפות המחירים של הסניף (לא מחיר אונליין). דמי משלוח "לפי האתר" נקראו מאתר הרשת לכתובת שלכם; "הערכה" = מחירון הרשת. הסכום הסופי נקבע בעגלה באתר הרשת.</div>
      <button className="btn block" onClick={openConfirm}>קניתי — לאשר מה נקנה ✓</button>
    </div>
  );
}

function QuoteCard({ q, win, bestOnline, threshold, onCart }: { q: BasketQuote; win: boolean; bestOnline?: BasketQuote; threshold: number; onCart: (id: string, verifyOnly?: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const pct = Math.round(q.completeness * 100);
  const missing = q.lines.filter((l) => l.missing && !l.uncertain);
  const unsure = q.lines.filter((l) => l.uncertain);
  const subs = q.lines.filter((l) => l.substituted);
  const saving = q.kind === 'physical' && bestOnline ? Math.round(bestOnline.total - q.total) : null;
  return (
    <div className={`card stack quote ${win ? 'win' : ''}`}>
      <div className="spread">
        <b>{win ? '🏆 ' : ''}{q.kind === 'physical' ? '🚗 ' : '🚚 '}{q.providerName}</b>
        <SourceTag s={q.source} />
      </div>
      <div className="spread">
        <span className="big-num">{q.kind === 'physical' ? '~' : ''}{nis(Math.round(q.total))}</span>
        <span className="small muted">{q.kind === 'online' ? (q.deliveryFeeEstimated ? (q.deliveryFee ? `כולל משלוח ~${nis(q.deliveryFee)} (לפי מחירון)` : 'משלוח חינם (לפי מחירון)') : q.deliveryFee ? `כולל משלוח ${nis(q.deliveryFee)} (לפי האתר)` : 'משלוח חינם (לפי האתר)') : 'איסוף עצמי'}</span>
      </div>
      <div className="row small"><div className="bar grow"><div style={{ width: `${pct}%` }} /></div><span>{pct}% מהסל</span></div>
      <div className="row wrap small muted">
        {missing.length > 0 && <span>חסרים: {missing.map((l) => l.label).join(', ')}</span>}
        {unsure.length > 0 && <span>· לא בטוח: {unsure.map((l) => l.label).join(', ')}</span>}
        {subs.length > 0 && <span>· {subs.length} החלפות</span>}
        {q.minOrderIssue && <span>· ⚠️ {q.minOrderIssue}</span>}
      </div>
      {saving !== null && (
        <div className={`banner ${saving >= threshold ? 'ok' : 'warn'}`}>
          {saving > 0 ? `חיסכון ~${nis(saving)} מול האונליין. הרף שלך לנסיעה: ${nis(threshold)} → ${saving >= threshold ? 'שווה לשקול נסיעה' : 'לא שווה לנסוע'}` : 'לא זול יותר מהאונליין'}
        </div>
      )}
      {q.kind === 'online' && q.delivery && (q.delivery.confirmedAddressText || q.delivery.deliveryWindows?.length || q.delivery.restrictionMessage) && (
        <div className="small muted">
          {q.delivery.confirmedAddressText && <div>📍 {q.delivery.confirmedAddressText}</div>}
          {q.delivery.deliveryWindows?.length ? <div>🕒 {q.delivery.deliveryWindows.slice(0, 2).join(' · ')}</div> : null}
          {q.delivery.minimumOrder !== undefined && !q.minOrderIssue && <div>מינימום הזמנה {nis(q.delivery.minimumOrder)}</div>}
          {q.delivery.restrictionMessage && <div>⚠️ {q.delivery.restrictionMessage}</div>}
          <div className="faint">נבדק באתר {new Date(q.delivery.checkedAt).toLocaleDateString('he-IL')}</div>
        </div>
      )}
      <div className="row wrap small">
        {q.kind === 'online' && q.deliveryStatus && <span className={`tag ${deliveryTagClass(q.deliveryStatus)}`}>{DELIVERY_LABEL[q.deliveryStatus]}</span>}
        {q.kind === 'online' && <span className={`tag ${q.cartSupported ? 'live' : 'need'}`}>{q.cartSupported ? '🛒 הכנת עגלה נתמכת' : 'הכנת עגלה לא זמינה'}</span>}
        <span className="faint">עודכן {new Date(q.fetchedAt).toLocaleString('he-IL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      {q.kind === 'online' && q.cartSupported && q.deliveryStatus !== 'unavailable' && <button className={`btn ${win ? '' : 'ghost'}`} onClick={() => onCart(q.providerId)}>הכן עגלה ב{q.providerName.replace(' אונליין', '').replace(' · דמו', '')} 🛒</button>}
      {q.kind === 'online' && q.cartSupported && q.deliveryStatus !== 'confirmed' && <button className="link" style={{ alignSelf: 'flex-start' }} onClick={() => onCart(q.providerId, true)}>בדוק משלוח לכתובת שלי באתר הרשת</button>}
      <button className="link" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(!open)}>{open ? 'סגור פירוט' : 'פתח פירוט'}</button>
      {open && (
        <div>
          {q.lines.map((l) => (
            <div className="price-row" key={l.needId}>
              <span className="grow">{l.label} × {l.quantity}<div className="faint">{l.uncertain ? `לא בטוח: ${l.product ? productLine(l.product) : ''}` : l.missing ? 'לא נמצא' : l.product ? productLine(l.product) : ''}{l.product?.promoText ? ` · ${l.product.promoText}` : ''}</div></span>
              <b>{l.missing ? '—' : nis(Math.round(l.lineTotal * 10) / 10)}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
