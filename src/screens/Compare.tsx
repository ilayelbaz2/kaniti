import { useEffect, useState } from 'react';
import type { BasketQuote, Comparison } from '../../shared/types.ts';
import type { Ctx } from '../App.tsx';
import { api } from '../api.ts';
import { nis, SourceTag } from '../components/ChatParts.tsx';

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
      {ok.map((q) => <QuoteCard key={q.providerId} q={q} win={q.providerId === cmp.recommendation.winnerId} bestOnline={bestOnline} threshold={threshold} />)}
      {failed.map((q) => (
        <div className="card stack" key={q.providerId} style={{ opacity: 0.75 }}>
          <b>{q.providerName}</b>
          <div className="small muted">{q.kind === 'online' ? 'לא הצלחתי להשלים סל חי כרגע. לא אציג מחירים כאילו זה checkout אמיתי.' : 'לא הצלחתי לקרוא את קובץ המחירים של הסניף כרגע.'}</div>
          {q.error && <div className="faint">{q.error}</div>}
        </div>
      ))}
      <div className="faint">"חי" = מחיר מאתר הרשת עכשיו. "נתוני סניף" = קבצי שקיפות המחירים של הסניף. דמי המשלוח לפי מחירון הרשת, לא מעגלת קניות אמיתית.</div>
      <button className="btn block" onClick={openConfirm}>קניתי — לאשר מה נקנה ✓</button>
    </div>
  );
}

function QuoteCard({ q, win, bestOnline, threshold }: { q: BasketQuote; win: boolean; bestOnline?: BasketQuote; threshold: number }) {
  const [open, setOpen] = useState(false);
  const pct = Math.round(q.completeness * 100);
  const missing = q.lines.filter((l) => l.missing);
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
        <span className="small muted">{q.kind === 'online' ? (q.deliveryFee ? `כולל משלוח ${nis(q.deliveryFee)}` : 'משלוח חינם') : 'איסוף עצמי'}</span>
      </div>
      <div className="row small"><div className="bar grow"><div style={{ width: `${pct}%` }} /></div><span>{pct}% מהסל</span></div>
      <div className="row wrap small muted">
        {missing.length > 0 && <span>חסרים {missing.length}</span>}
        {subs.length > 0 && <span>· {subs.length} החלפות</span>}
        {q.minOrderIssue && <span>· ⚠️ {q.minOrderIssue}</span>}
      </div>
      {saving !== null && (
        <div className={`banner ${saving >= threshold ? 'ok' : 'warn'}`}>
          {saving > 0 ? `חיסכון ~${nis(saving)} מול האונליין. הרף שלך לנסיעה: ${nis(threshold)} → ${saving >= threshold ? 'שווה לשקול נסיעה' : 'לא שווה לנסוע'}` : 'לא זול יותר מהאונליין'}
        </div>
      )}
      <button className="link" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(!open)}>{open ? 'סגור פירוט' : 'פתח פירוט'}</button>
      {open && (
        <div>
          {q.lines.map((l) => (
            <div className="price-row" key={l.needId}>
              <span className="grow">{l.label} × {l.quantity}<div className="faint">{l.missing ? 'לא נמצא' : l.product?.name}{l.product?.promoText ? ` · ${l.product.promoText}` : ''}</div></span>
              <b>{l.missing ? '—' : nis(Math.round(l.lineTotal * 10) / 10)}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
