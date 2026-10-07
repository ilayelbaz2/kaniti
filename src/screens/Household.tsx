import { useEffect, useState } from 'react';
import type { Flexibility, HouseholdNeed, Purchase } from '../../shared/types.ts';
import type { Ctx } from '../App.tsx';
import { api, type LearningEventRow } from '../api.ts';
import { nis } from '../components/ChatParts.tsx';

const FLEX: [Flexibility, string][] = [
  ['exact_product', 'רק מוצר/מותג מסוים'],
  ['brand_flexible', 'מותג מועדף, אבל מחליף כשמשתלם'],
  ['category_flexible', 'מחיר קודם — המותג לא חשוב'],
  ['exploratory', 'תפתיע אותי'],
];
const FLEX_SHORT: Record<Flexibility, string> = { exact_product: 'רק המוצר הקבוע', brand_flexible: 'די גמיש במותג', category_flexible: 'מותג לא חשוב, מחיר חשוב', exploratory: 'פתוחים לגיוון' };
const fmt = (x: number) => (x >= 10 ? Math.round(x) : Math.round(x * 10) / 10);

export function HouseholdScreen({ ctx }: { ctx: Ctx }) {
  const [tab, setTab] = useState<'learned' | 'history'>(() => { try { return sessionStorage.getItem('kaniti.homeTab') === 'history' ? 'history' : 'learned'; } catch { return 'learned'; } });
  const pick = (t: 'learned' | 'history') => { setTab(t); try { sessionStorage.setItem('kaniti.homeTab', t); } catch { /* ignore */ } };
  return (
    <div className="screen">
      <div className="tabs"><button className={tab === 'learned' ? 'on' : ''} onClick={() => pick('learned')}>מה למדת עלינו</button><button className={tab === 'history' ? 'on' : ''} onClick={() => pick('history')}>קניות קודמות</button></div>
      {tab === 'learned' ? <Learned ctx={ctx} /> : <History />}
    </div>
  );
}

function Learned({ ctx }: { ctx: Ctx }) {
  const { state, setState, toast } = ctx;
  const h = state.household!;
  const [events, setEvents] = useState<LearningEventRow[] | null>(null);
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => { api.providers().then((p) => setProviders(p.online)).catch(() => {}); }, []);

  const active = state.needs.filter((n) => n.active);
  const learning = active.filter((n) => n.qtySource === 'default' && n.flexConfidence < 0.5);
  const rest = active.filter((n) => !learning.includes(n));
  const groups: [string, HouseholdNeed[]][] = [
    ['חובה (אלרגיות והגבלות)', active.filter((n) => n.hardConstraints.length)],
    ['קבועים', rest.filter((n) => n.flexibility === 'exact_product' && !n.hardConstraints.length)],
    ['קונים בקביעות', rest.filter((n) => n.flexibility === 'brand_flexible' && !n.hardConstraints.length)],
    ['בחירות גמישות', rest.filter((n) => (n.flexibility === 'category_flexible' || n.flexibility === 'exploratory') && !n.hardConstraints.length)],
    ['עוד לומד', learning.filter((n) => !n.hardConstraints.length)],
  ];
  const never = state.needs.filter((n) => n.neverSuggest && !n.hardConstraints.length);
  const constraints = [h.kosher ? 'שומרים כשרות' : '', ...h.allergies.map((a) => `אלרגיה ל${a}`), ...h.dietNotes].filter(Boolean);

  return (
    <div className="stack">
      <div><h2>מה למדתי עליכם</h2><div className="muted small">אפשר לתקן אותי בכל רגע</div></div>
      <div className="card stack">
        <div className="spread"><b>🏠 הבית</b><span className="muted small">{h.adults} מבוגרים{h.children.length ? ` · ${h.children.length} ילדים` : ''} · {h.homeAddress.city}</span></div>
        {constraints.length > 0 && <div className="chips">{constraints.map((c) => <span key={c} className="chip on">🛡️ {c}</span>)}</div>}
        <div className="spread small"><span>רף חיסכון לנסיעה לסופר</span>
          <div className="chips">{[30, 60, 100].map((v) => <button key={v} className={`chip ${h.driveSavingsThresholdNis === v ? 'on' : ''}`} onClick={async () => setState(await api.patchHousehold({ driveSavingsThresholdNis: v }))}>₪{v}</button>)}</div>
        </div>
        <div className="small muted">רשתות שאני משווה:</div>
        <div className="chips">
          {providers.map((p) => {
            const on = h.onlineProviders.includes(p.id);
            return <button key={p.id} className={`chip ${on ? 'on' : ''}`} onClick={async () => setState(await api.patchHousehold({ onlineProviders: on ? h.onlineProviders.filter((x) => x !== p.id) : [...h.onlineProviders, p.id] }))}>{p.name}</button>;
          })}
          {h.physicalStores.map((s) => <span key={s.chainId + s.storeId} className="chip on">🏬 {s.name}</span>)}
        </div>
      </div>
      {groups.filter(([, ns]) => ns.length).map(([title, ns]) => (
        <div key={title} className="stack">
          <div className="group-title">{title}</div>
          {ns.map((n) => <NeedCard key={n.id} n={n} ctx={ctx} />)}
        </div>
      ))}
      {never.length > 0 && <><div className="group-title">לא להציע</div><div className="chips">{never.map((n) => <button key={n.id} className="chip" onClick={async () => { setState(await api.patchNeed(n.id, { neverSuggest: false })); toast(`${n.label} — חזר לרשימה`); }}>{n.emoji} {n.label} ↺</button>)}</div></>}
      <details className="card" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && !events) api.events().then(setEvents); }}>
        <summary className="small muted" style={{ cursor: 'pointer' }}>יומן למידה (מה שינה את דעתי)</summary>
        <div className="stack" style={{ paddingTop: 8 }}>
          {!events && <div className="faint">טוען…</div>}
          {events?.map((e) => <div key={e.id} className="small"><span className="faint">{new Date(e.createdAt).toLocaleDateString('he-IL')}</span> · {EVENT_LABEL[e.type] ?? e.type}{e.label ? ` · ${e.label}` : ''}</div>)}
        </div>
      </details>
    </div>
  );
}

const EVENT_LABEL: Record<string, string> = {
  stock_report: 'דיווח מלאי', preference_statement: 'העדפה', removed_product: 'הוסר מהסל', replaced_product: 'הוחלף מוצר',
  quantity_changed: 'שינוי כמות', accepted_product: 'נוסף לסל', purchase_confirmed: 'קנייה אושרה', deal_dismissed: 'מבצע נדחה',
  deal_accepted: 'הצעה התקבלה', quantity_feedback: 'משוב כמות',
};

function NeedCard({ n, ctx }: { n: HouseholdNeed; ctx: Ctx }) {
  const { setState, toast } = ctx;
  const [edit, setEdit] = useState(false);
  const [brand, setBrand] = useState('');
  const conf = n.qtySource === 'user' || (n.qtySource === 'learned' && n.flexConfidence > 0.5) ? 'גבוה' : n.qtySource === 'learned' ? 'בינוני' : 'נמוך';
  const patch = async (p: Partial<HouseholdNeed>) => setState(await api.patchNeed(n.id, p));
  const stock = n.currentStockEstimate ?? 0;
  return (
    <div className="card stack">
      <div className="spread">
        <b>{n.emoji} {n.label}</b>
        <button className="link" onClick={() => setEdit(!edit)}>{edit ? 'סגור' : 'ערוך'}</button>
      </div>
      <div className="small muted">~{fmt(n.typical14DayQty)} לשבועיים · ביטחון: {conf}{n.stockAsOf ? ` · בבית עכשיו ~${fmt(stock)}` : ''}</div>
      {n.hardConstraints.length > 0 && <div className="chips">{n.hardConstraints.map((h) => <span key={h} className="chip on">🛡️ חובה: {h}</span>)}</div>}
      <div className="small">{FLEX_SHORT[n.flexibility]}{n.preferredBrands.length ? ` · ${n.preferredBrands.join(', ')}` : ''}{n.forbiddenBrands.length ? ` · בלי ${n.forbiddenBrands.join(', ')}` : ''}{n.dealSensitivity === 'high' ? ' · פתוחים למבצעים' : ''}</div>
      {n.id === 'COLA_ZERO' && n.flexConfidence < 0.5 && (
        <div className="chips"><button className="chip" onClick={() => patch({ flexibility: 'exact_product', preferredBrands: ['קוקה קולה'] })}>רק Coca-Cola</button><button className="chip" onClick={() => patch({ flexibility: 'brand_flexible' })}>אפשר חלופות</button></div>
      )}
      {edit && (
        <div className="stack" style={{ borderTop: '1px dashed var(--line)', paddingTop: 10 }}>
          <div className="small"><b>מה חשוב?</b></div>
          <div className="chips">{FLEX.map(([f, l]) => <button key={f} className={`chip ${n.flexibility === f ? 'on' : ''}`} onClick={() => patch({ flexibility: f })}>{l}</button>)}</div>
          <div className="spread small"><span>כמה לשבועיים</span>
            <div className="qty"><button onClick={() => patch({ typical14DayQty: Math.max(0.5, +(n.typical14DayQty - 1).toFixed(1)) })}>−</button><span>{fmt(n.typical14DayQty)}</span><button onClick={() => patch({ typical14DayQty: +(n.typical14DayQty + 1).toFixed(1) })}>+</button></div>
          </div>
          <div className="spread small"><span>יש בבית עכשיו</span>
            <div className="qty"><button onClick={async () => setState(await api.setStock(n.id, Math.max(0, Math.round(stock) - 1)))}>−</button><span>{fmt(stock)}</span><button onClick={async () => setState(await api.setStock(n.id, Math.round(stock) + 1))}>+</button></div>
          </div>
          <div className="small"><b>מותגים שלא להציע</b></div>
          <div className="chips">
            {n.forbiddenBrands.map((b) => <button key={b} className="chip on" onClick={() => patch({ forbiddenBrands: n.forbiddenBrands.filter((x) => x !== b) })}>{b} ×</button>)}
            <form className="row" onSubmit={(e) => { e.preventDefault(); if (brand.trim()) { void patch({ forbiddenBrands: [...n.forbiddenBrands, brand.trim()] }); setBrand(''); } }}>
              <input className="field" style={{ padding: '6px 10px', width: 120 }} placeholder="+ הוסף" value={brand} onChange={(e) => setBrand(e.target.value)} />
            </form>
          </div>
          <button className="link small" style={{ alignSelf: 'flex-start' }} onClick={async () => { await patch({ active: false }); toast(`${n.label} — הוצא מהרשימה הקבועה`); }}>זה לא משהו שאנחנו קונים קבוע</button>
        </div>
      )}
    </div>
  );
}

function History() {
  const [list, setList] = useState<Purchase[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { api.purchases().then(setList).catch(() => setList([])); }, []);
  if (!list) return <div className="stack"><div className="skeleton" /><div className="skeleton" /></div>;
  if (!list.length) return <div className="empty"><div className="emo">🧾</div><div>עוד אין קניות. אחרי שתאשרו קנייה ראשונה היא תופיע כאן.</div></div>;
  return (
    <div className="stack">
      {list.map((p, idx) => (
        <div className="card stack" key={p.id}>
          <div className="spread"><b>{new Date(p.createdAt).toLocaleDateString('he-IL', { day: 'numeric', month: 'short', year: 'numeric' })}</b><span className="big-num" style={{ fontSize: 20 }}>{nis(Math.round(p.total))}</span></div>
          <div className="small muted">{p.storeName} · {p.items.length} פריטים</div>
          <div className="row wrap small">{p.dealsUsed > 0 && <span>🔥 {p.dealsUsed} מבצעים נוצלו</span>}{p.substitutions > 0 && <span>↔ {p.substitutions} תחליפים</span>}</div>
          <button className="link" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? 'סגור' : 'פתח'}</button>
          {open === p.id && p.items.map((i) => (
            <div className="price-row" key={i.needId}><span>{i.emoji} {i.label} × {i.quantity}<div className="faint">{i.productName}</div></span>{i.status === 'opportunity' && <span className="tag opportunity">סטוק</span>}</div>
          ))}
          {idx === 0 && <QtyFeedback p={p} onChange={(np) => setList(list.map((x) => (x.id === np.id ? np : x)))} />}
        </div>
      ))}
    </div>
  );
}

/** Occasional, light: only for the latest purchase, a few of the bigger items. */
function QtyFeedback({ p, onChange }: { p: Purchase; onChange: (p: Purchase) => void }) {
  const candidates = [...p.items].sort((a, b) => b.quantity - a.quantity).slice(0, 3);
  const pending = candidates.filter((i) => !p.feedback?.[i.needId]);
  const ageDays = (Date.now() - new Date(p.createdAt).getTime()) / 86400000;
  if (!pending.length || ageDays < 3) return null;
  return (
    <div className="mini-card stack">
      <b className="small">איך הייתה הכמות?</b>
      {pending.map((i) => (
        <div className="spread small" key={i.needId}>
          <span>{i.emoji} {i.label}</span>
          <div className="chips">{([['too_much', 'נשאר הרבה'], ['right', 'היה בול'], ['ran_out', 'נגמר מהר']] as const).map(([v, l]) => (
            <button key={v} className="chip" onClick={async () => onChange(await api.feedback(p.id, i.needId, v))}>{l}</button>
          ))}</div>
        </div>
      ))}
    </div>
  );
}
