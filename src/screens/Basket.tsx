import { useState } from 'react';
import type { BasketItem, ProductSearchResult } from '../../shared/types.ts';
import type { Ctx } from '../App.tsx';
import { productLine } from '../../shared/product.ts';
import { api } from '../api.ts';
import { nis } from '../components/ChatParts.tsx';

type Filter = 'all' | 'need' | 'opportunity' | 'discovery';
const STATUS_LABEL = { need: 'צריך', opportunity: 'שווה לנצל', discovery: 'אולי תאהבו' } as const;

export function BasketScreen({ ctx }: { ctx: Ctx }) {
  const { state, setState, go, toast } = ctx;
  const [filter, setFilter] = useState<Filter>('all');
  const [building, setBuilding] = useState(false);
  const b = state.basket;

  const build = async () => {
    setBuilding(true);
    try {
      const r = await api.build(14);
      setState(r.state);
      if (r.failures.length) toast(`${r.failures.map((f) => f.name).join(', ')} לא החזירו מחיר — המשכתי בלעדיהם`);
    } catch (e) { toast((e as Error).message); } finally { setBuilding(false); }
  };

  if (building) return <div className="screen stack"><h1>בונה סל…</h1><div className="stages"><div className="on">בודק מה כנראה חסר ומחפש מבצעים…</div></div><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>;
  if (!b || b.status !== 'building' || b.items.length === 0) {
    return (
      <div className="screen">
        <div className="empty">
          <div className="emo">🧺</div>
          <h2>{b?.status === 'purchased' ? 'הקנייה האחרונה אושרה ✓' : 'אין עדיין סל'}</h2>
          <div>{b?.status === 'purchased' ? 'כשתרצו — אבנה את הבאה לפי מה שלמדתי.' : 'אבנה סל לשבועיים לפי מה שאתם צורכים ומה שכנראה חסר.'}</div>
          <button className="btn" onClick={build}>בנה קנייה</button>
          <button className="btn ghost" onClick={() => ctx.openAdd()}>＋ הוסף מוצר</button>
        </div>
      </div>
    );
  }

  const active = b.items.filter((i) => i.accepted && i.condition?.met !== false);
  const total = Math.round(active.reduce((s, i) => s + (i.product?.price ?? 0) * i.quantity, 0));
  const deals = active.filter((i) => i.product?.promoText).length; // anything bought at a promotion price, however it got here
  const sugg = b.items.filter((i) => i.status === 'discovery' && !i.accepted).length;
  const shown = b.items.filter((i) => filter === 'all' || i.status === filter);
  const subs = b.items.filter((i) => i.usualProductName);

  return (
    <div className="screen" style={{ paddingBottom: 'calc(var(--nav-h) + 96px)' }}>
      <div className="sum-head">
        <div className="spread"><h1>הסל שלי</h1>{b.priced && <span className="big-num">~{nis(total)}</span>}</div>
        <div className="muted small" style={{ margin: '4px 0 10px' }}>{active.length === 1 ? 'פריט אחד' : `${active.length} פריטים`}{deals ? ` · ${deals === 1 ? 'אחד במבצע' : `${deals} במבצע`}` : ''}{sugg ? ` · ${sugg === 1 ? 'הצעה אחת' : `${sugg} הצעות`}` : ''}</div>
        <button className="btn ghost block" style={{ marginBottom: 8 }} onClick={() => ctx.openAdd()}>＋ הוסף מוצר</button>
        <div className="chips scroll">
          {([['need', 'הכרחי'], ['opportunity', 'סטוק'], ['discovery', 'הפתעות'], ['all', 'הכול']] as const).map(([f, l]) => (
            <button key={f} className={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>{l}</button>
          ))}
        </div>
      </div>
      <div className="stack">
        {state.demoPrices && <div className="banner demo">מצב דמו — המחירים אינם אמיתיים</div>}
        {b.priceSourceNote && !state.demoPrices && <div className="faint">{b.priceSourceNote}</div>}
        {b.notes.map((n) => <div key={n} className="banner warn">{n}</div>)}
        {filter === 'all' && subs.map((i) => <SubstitutionCard key={'s' + i.needId} item={i} ctx={ctx} />)}
        {shown.map((i) => <ItemCard key={i.needId} item={i} ctx={ctx} />)}
        {shown.length === 0 && <div className="empty"><div>אין פריטים בקטגוריה הזאת</div></div>}
        {b.skipped.length > 0 && (
          <details className="skipped card">
            <summary>דילגתי הפעם על {b.skipped.length} פריטים</summary>
            <div className="stack" style={{ paddingTop: 6 }}>
              {b.skipped.map((s) => (
                <div className="spread small" key={s.needId}>
                  <span>{s.emoji} <b>{s.label}</b> — <span className="muted">{s.reason}</span></span>
                  <button className="link" onClick={async () => setState(await api.add(s.needId))}>להוסיף</button>
                </div>
              ))}
            </div>
          </details>
        )}
        <button className="link" style={{ alignSelf: 'center', padding: 10 }} onClick={build}>לבנות מחדש</button>
      </div>
      <div className="sticky-cta"><button className="btn block" onClick={() => go('compare')}>השווה רשתות ⚖️</button></div>
    </div>
  );
}

function ItemCard({ item: i, ctx }: { item: BasketItem; ctx: Ctx }) {
  const { setState, toast } = ctx;
  const [menu, setMenu] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  const [alts, setAlts] = useState<ProductSearchResult[] | null>(null);
  const [learn, setLearn] = useState(false);
  const pending = i.status === 'discovery' && !i.accepted;
  const blocked = i.condition?.met === false;

  const act = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { toast((e as Error).message); } };
  const pref = (patch: unknown, msg: string) => act(async () => { setState(await api.patchNeed(i.needId, patch)); toast(msg); setMenu(false); });

  return (
    <div className={`card item ${blocked ? 'dim' : ''}`}>
      <div className="top">
        <span className="emo">{i.emoji}</span>
        <div className="grow">
          <div className="spread">
            <span className="name">{i.label} <span className="muted" style={{ fontWeight: 400 }}>× {i.quantity} {i.unit}</span></span>
            {i.condition ? <span className="tag estimate">{i.condition.met ? '✓ בתנאי — עמד' : '⏳ בתנאי'}</span>
              : <span className={`tag ${i.status}`}>{i.status === 'opportunity' ? '🔥 ' : i.status === 'discovery' ? '💡 ' : ''}{STATUS_LABEL[i.status]}</span>}
          </div>
          {i.product ? (
            <div className="prod">{productLine(i.product)} · <b>{nis(i.product.price)}{i.product.byWeight ? ' לק״ג' : ''}</b>{i.product.regularPrice && i.product.regularPrice > i.product.price ? <s className="faint"> {nis(i.product.regularPrice)}</s> : null}{i.product.unitPriceText ? ` · ${i.product.unitPriceText}` : ''}{i.lockedByUser ? ' · 🔒' : ''}</div>
          ) : <div className="prod faint">אין מחיר כרגע</div>}
        </div>
      </div>
      <div className="reason">{blocked ? `⏳ ${i.condition?.note}` : i.reason}</div>
      {i.uncertain && !i.lockedByUser && !alts && (
        <div className="banner warn small row">
          <span className="grow">לא בטוח שזה המוצר הנכון — לא אכניס אותו לעגלה בלי אישור.</span>
          <button className="btn small" onClick={() => act(async () => setAlts(await api.alternatives(i.needId)))}>בחרו מוצר</button>
        </div>
      )}
      {why && <div className="why">{why}</div>}
      {pending ? (
        <div className="row">
          <button className="btn small" onClick={() => act(async () => setState(await api.accept(i.needId)))}>הוסף לסל</button>
          <button className="btn small ghost" onClick={() => act(async () => setState(await api.remove(i.needId)))}>לא הפעם</button>
        </div>
      ) : (
        <div className="controls">
          <div className="qty">
            <button aria-label="פחות" onClick={() => act(async () => setState(await api.qty(i.needId, i.quantity - 1)))}>−</button>
            <span>{i.quantity}</span>
            <button aria-label="יותר" onClick={() => act(async () => setState(await api.qty(i.needId, i.quantity + 1)))}>+</button>
          </div>
          <div className="row">
            <button className="btn small ghost" onClick={() => act(async () => setWhy(why ? null : (await api.why(i.needId)).text))}>למה?</button>
            <button className="icon-btn" aria-label="עוד" onClick={() => setMenu(!menu)}>…</button>
          </div>
        </div>
      )}
      {menu && (
        <div className="menu">
          <button className="chip" onClick={() => act(async () => setAlts(await api.alternatives(i.needId)))}>↔ החלף</button>
          <button className="chip" onClick={() => act(async () => { setState(await api.remove(i.needId)); toast(`${i.label} — לא בקנייה הזאת`); })}>לא הפעם</button>
          <button className="chip" onClick={() => act(async () => { setState(await api.lock(i.needId, !i.lockedByUser)); setMenu(false); })}>{i.lockedByUser ? '🔓 שחרר' : '🔒 נעל בחירה'}</button>
          {i.product?.brand && <button className="chip" onClick={() => pref({ preferredBrands: [i.product!.brand], flexibility: 'brand_flexible' }, `אעדיף ${i.product!.brand}`)}>תמיד תעדיף {i.product.brand}</button>}
          <button className="chip" onClick={() => pref({ flexibility: 'category_flexible', preferredBrands: [] }, 'המותג לא חשוב — אלך לפי מחיר')}>לא אכפת לי מהמותג</button>
          <button className="chip" onClick={() => act(async () => { await api.patchNeed(i.needId, { neverSuggest: true, active: false }); setState(await api.remove(i.needId, false)); toast('לא אציע יותר'); })}>אל תציע את זה</button>
        </div>
      )}
      {alts && (
        <div className="stack">
          {alts.length === 0 && <div className="faint">אין חלופות כרגע.</div>}
          {alts.map((p) => (
            <button key={p.productId} className="provider-row" onClick={() => act(async () => {
              const r = await api.replace(i.needId, p.productId);
              setState(r.state); setAlts(null); setMenu(false);
              if (r.replacements >= 1) setLearn(true);
            })}>
              <span className="grow small">{productLine(p)}{p.promoText ? <span className="faint"> · {p.promoText}</span> : null}</span>
              <b>{nis(p.promoPrice ?? p.price)}</b>
            </button>
          ))}
        </div>
      )}
      {learn && (
        <div className="mini-card stack" style={{ borderColor: 'var(--violet)' }}>
          <div className="small">🧠 שמתי לב שהחלפת את ה{i.label} שבחרתי. מה יותר חשוב לך?</div>
          <div className="chips">
            <button className="chip" onClick={() => { void pref({ flexibility: 'category_flexible' }, 'הבנתי — הכי זול'); setLearn(false); }}>הכי זול</button>
            <button className="chip" onClick={() => { void pref({ flexibility: 'brand_flexible' }, 'הבנתי — יש מותגים שאתם אוהבים'); setLearn(false); }}>יש כמה מותגים שאני אוהב</button>
            <button className="chip" onClick={() => setLearn(false)}>אלמד בהמשך</button>
          </div>
        </div>
      )}
    </div>
  );
}

function SubstitutionCard({ item: i, ctx }: { item: BasketItem; ctx: Ctx }) {
  const { setState, toast } = ctx;
  const [gone, setGone] = useState(false);
  if (gone) return null;
  return (
    <div className="card stack" style={{ borderColor: 'var(--amber)' }}>
      <div className="small">החלפתי הפעם:</div>
      <b>{i.usualProductName} ← {i.product ? productLine(i.product) : ''}</b>
      <div className="small muted">אתם גמישים במותג ב{i.label}, ויצא משתלם יותר.</div>
      <div className="row">
        <button className="btn small" onClick={async () => { setState(await api.lock(i.needId, true)); setGone(true); }}>נשמע טוב</button>
        <button className="btn small ghost" onClick={async () => {
          const alts = await api.alternatives(i.needId);
          const back = alts.find((p) => p.name === i.usualProductName);
          if (!back) { toast('לא מצאתי את המוצר הרגיל כרגע'); return; }
          setState((await api.replace(i.needId, back.productId)).state);
          setGone(true);
        }}>תחזיר ל{i.usualProductName}</button>
      </div>
    </div>
  );
}
