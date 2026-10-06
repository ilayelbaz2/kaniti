import { useEffect, useState } from 'react';
import type { AppState } from '../../shared/types.ts';
import { api, type CatalogItem, type DeliveryResult, type StoreOption } from '../api.ts';

type FlexKey = 'COLA_ZERO' | 'LAUNDRY_SOFTENER' | 'CREAM_CHEESE';
type FlexAnswer = 'strict' | 'deal' | 'any';
const FLEX_CARDS: { id: FlexKey; emoji: string; label: string; options: [FlexAnswer, string][] }[] = [
  { id: 'COLA_ZERO', emoji: '🥤', label: 'קולה זירו', options: [['strict', 'רק המוצר הזה'], ['deal', 'מותג אחר אם ממש משתלם'], ['any', 'לא אכפת לי']] },
  { id: 'LAUNDRY_SOFTENER', emoji: '🧴', label: 'מרכך כביסה', options: [['strict', 'יש מותג מועדף'], ['deal', 'מה שבמבצע'], ['any', 'תפתיע אותי']] },
  { id: 'CREAM_CHEESE', emoji: '🧀', label: 'גבינת שמנת', options: [['strict', 'מותג קבוע'], ['deal', 'הטעם/מותג יכולים להשתנות'], ['any', 'הכי משתלם']] },
];
const STEPS = 6;

export function Onboarding({ onDone }: { onDone: (s: AppState) => void }) {
  const [step, setStep] = useState(0);
  const [adults, setAdults] = useState(2);
  const [kids, setKids] = useState<number[]>([]);
  const [kosher, setKosher] = useState(false);
  const [dairy, setDairy] = useState(false);
  const [veg, setVeg] = useState(false);
  const [otherOn, setOtherOn] = useState(false);
  const [other, setOther] = useState('');
  const [city, setCity] = useState('');
  const [street, setStreet] = useState('');
  const [delivery, setDelivery] = useState<DeliveryResult[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [chains, setChains] = useState<{ id: string; name: string }[]>([]);
  const [chain, setChain] = useState<string | null>(null);
  const [stores, setStores] = useState<StoreOption[] | null>(null);
  const [storeErr, setStoreErr] = useState<string | null>(null);
  const [physical, setPhysical] = useState<{ chainId: string; storeId: string; name: string }[]>([]);
  const [flexIdx, setFlexIdx] = useState(0);
  const [flex, setFlex] = useState<Partial<Record<FlexKey, FlexAnswer>>>({});
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [staples, setStaples] = useState<string[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [custom, setCustom] = useState<string[]>([]);
  const [customText, setCustomText] = useState('');
  const [threshold, setThreshold] = useState<number | null>(null);
  const [customThreshold, setCustomThreshold] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.catalog().then(setCatalog).catch(() => {});
    api.providers().then((p) => setChains(p.physicalChains)).catch(() => {});
  }, []);

  const toggle = (arr: string[], v: string, set: (x: string[]) => void) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  async function checkDelivery() {
    setChecking(true);
    setDelivery(null);
    try {
      const r = await api.deliveryCheck(city.trim(), street.trim() || undefined);
      setDelivery(r);
      setChosen(r.filter((x) => x.delivers === true).map((x) => x.providerId));
    } finally { setChecking(false); }
  }

  async function pickChain(id: string) {
    setChain(id); setStores(null); setStoreErr(null);
    try { setStores(await api.stores(id, city)); } catch (e) { setStoreErr((e as Error).message); }
  }

  async function finish() {
    setSaving(true);
    try {
      const s = await api.onboarding({
        adults, children: kids.map((age) => ({ age })), kosher, dairyAllergy: dairy, vegetarian: veg,
        otherConstraint: otherOn ? other : undefined, address: { city: city.trim(), street: street.trim() || undefined },
        onlineProviders: chosen, physicalStores: physical, flex, staples, customStaples: custom, threshold: threshold ?? 60,
      });
      onDone(s);
    } finally { setSaving(false); }
  }

  const next = () => setStep((s) => Math.min(STEPS, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));
  const canNext = [true, true, city.trim().length > 1 && delivery !== null, flexIdx >= FLEX_CARDS.length, staples.length + custom.length > 0, threshold !== null][step];

  return (
    <div className="onb">
      <div className="onb-progress">{Array.from({ length: STEPS }, (_, i) => <span key={i} className={i <= step ? 'done' : ''} />)}</div>

      {step === 0 && (
        <div className="onb-body" key="s0">
          <h1>מי אוכל בבית? 🍽️</h1>
          <div className="card stack">
            <div className="spread"><span className="t">מבוגרים</span>
              <div className="stepper">
                <button onClick={() => setAdults(Math.max(1, adults - 1))} aria-label="פחות">−</button>
                <span className="val">{adults}</span>
                <button onClick={() => setAdults(Math.min(8, adults + 1))} aria-label="יותר">+</button>
              </div>
            </div>
          </div>
          {kids.map((age, i) => (
            <div className="card kid" key={i}>
              <span style={{ fontSize: 26 }}>{age < 3 ? '👶' : age < 12 ? '🧒' : '🧑'}</span>
              <span className="grow">ילד/ה · גיל</span>
              <div className="stepper">
                <button onClick={() => setKids(kids.map((a, j) => (j === i ? Math.max(0, a - 1) : a)))}>−</button>
                <span className="val">{age}</span>
                <button onClick={() => setKids(kids.map((a, j) => (j === i ? Math.min(18, a + 1) : a)))}>+</button>
              </div>
              <button className="icon-btn" onClick={() => setKids(kids.filter((_, j) => j !== i))} aria-label="הסר">×</button>
            </div>
          ))}
          <button className="chip quick" style={{ alignSelf: 'flex-start' }} onClick={() => setKids([...kids, 5])}>+ הוסף ילד</button>
        </div>
      )}

      {step === 1 && (
        <div className="onb-body" key="s1">
          <h1>יש משהו שאני חייב לדעת?</h1>
          <p className="sub">דברים כאלה אני לא מאלתר.</p>
          <div className="big-cards">
            {([['✡️', 'שומרים כשרות', kosher, setKosher], ['🥛', 'אלרגיה לחלב', dairy, setDairy], ['🥗', 'צמחוני/טבעוני בבית', veg, setVeg], ['✏️', 'אחר', otherOn, setOtherOn]] as const).map(([emo, t, on, set]) => (
              <button key={t} className={`big-card ${on ? 'on' : ''}`} onClick={() => set(!on)}><span className="emo">{emo}</span><span className="t">{t}</span></button>
            ))}
          </div>
          {otherOn && <input className="field" placeholder="למשל: בלי גלוטן" value={other} onChange={(e) => setOther(e.target.value)} autoFocus />}
        </div>
      )}

      {step === 2 && (
        <div className="onb-body" key="s2">
          <h1>מאיפה בכלל אפשר להביא לכם קניות? 🚚</h1>
          <div className="stack">
            <input className="field" placeholder="עיר (למשל: רמת גן)" value={city} onChange={(e) => { setCity(e.target.value); setDelivery(null); }} />
            <input className="field" placeholder="רחוב ומספר (לא חובה)" value={street} onChange={(e) => setStreet(e.target.value)} />
            <button className="btn" disabled={city.trim().length < 2 || checking} onClick={checkDelivery}>{checking ? 'בודק מי שולח אליכם…' : 'בדוק מי שולח אליי'}</button>
          </div>
          {checking && <div className="stages"><div className="on">בודק מי שולח אליכם…</div></div>}
          {delivery && (
            <div className="stack">
              <div className="faint">סמנו את הרשתות שתרצו שאשווה:</div>
              {delivery.map((d) => (
                <button key={d.providerId} className={`provider-row ${chosen.includes(d.providerId) ? 'on' : ''}`} onClick={() => toggle(chosen, d.providerId, setChosen)}>
                  <span className="check">{chosen.includes(d.providerId) ? '✓' : ''}</span>
                  <span className="grow">
                    <div className="row"><b>{d.name}</b>{d.delivers === true ? <span className="tag live">שולחים</span> : d.delivers === null ? <span className="tag estimate">לא בטוח</span> : <span className="tag need">לא באזור</span>}</div>
                    <div className="faint">{d.note}</div>
                  </span>
                </button>
              ))}
              <div className="group-title">יש סופר פיזי שאתם אוהבים במיוחד? (לא חובה)</div>
              <div className="chips">{chains.map((c) => <button key={c.id} className={`chip ${chain === c.id ? 'on' : ''}`} onClick={() => pickChain(c.id)}>{c.name}</button>)}</div>
              {chain && !stores && !storeErr && <div className="faint">טוען סניפים…</div>}
              {storeErr && <div className="banner warn">לא הצלחתי לטעון סניפים כרגע ({storeErr}). אפשר להוסיף אחר כך.</div>}
              {stores && (
                <select className="field" value="" onChange={(e) => {
                  const s = stores.find((x) => x.storeId === e.target.value);
                  if (s && chain) setPhysical([...physical.filter((p) => p.chainId !== chain), { chainId: chain, storeId: s.storeId, name: `${s.name}${s.city ? ` (${s.city})` : ''}` }]);
                }}>
                  <option value="">בחרו סניף…</option>
                  {stores.map((s) => <option key={s.storeId} value={s.storeId}>{s.name} · {s.city}</option>)}
                </select>
              )}
              {physical.length > 0 && <div className="chips">{physical.map((p) => <button key={p.chainId + p.storeId} className="chip on" onClick={() => setPhysical(physical.filter((x) => x !== p))}>🏬 {p.name} ×</button>)}</div>}
            </div>
          )}
        </div>
      )}

      {step === 3 && (
        <div className="onb-body" key="s3">
          <h1>עכשיו אני רוצה להבין איפה מותר לי להיות חכם 😏</h1>
          {flexIdx < FLEX_CARDS.length ? (
            <div className="flex-card stack" key={flexIdx}>
              <div className="spread"><span className="emo">{FLEX_CARDS[flexIdx].emoji}</span><span className="faint">{flexIdx + 1}/{FLEX_CARDS.length}</span></div>
              <h2>{FLEX_CARDS[flexIdx].label}</h2>
              <div className="stack">
                {FLEX_CARDS[flexIdx].options.map(([v, t]) => (
                  <button key={v} className={`big-card ${flex[FLEX_CARDS[flexIdx].id] === v ? 'on' : ''}`} onClick={() => { setFlex({ ...flex, [FLEX_CARDS[flexIdx].id]: v }); setTimeout(() => setFlexIdx((i) => i + 1), 180); }}>
                    <span className="t">{t}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex-card stack"><span className="emo">🧠</span><h2>הבנתי את הסגנון שלכם.</h2><p className="muted">על כל השאר אלמד תוך כדי.</p><button className="link" onClick={() => setFlexIdx(0)}>לענות מחדש</button></div>
          )}
        </div>
      )}

      {step === 4 && (
        <div className="onb-body" key="s4">
          <h1>מה כמעט תמיד צריך להיות בבית?</h1>
          <div className="chips">
            {catalog.filter((c) => c.staple || showAll).map((c) => (
              <button key={c.id} className={`chip ${staples.includes(c.id) ? 'on' : ''}`} style={{ fontSize: 16, padding: '9px 14px' }} onClick={() => toggle(staples, c.id, setStaples)}>{c.emoji} {c.label}</button>
            ))}
            {custom.map((c) => <button key={c} className="chip on" onClick={() => setCustom(custom.filter((x) => x !== c))}>🛒 {c} ×</button>)}
          </div>
          {!showAll && <button className="link" style={{ alignSelf: 'flex-start' }} onClick={() => setShowAll(true)}>עוד מוצרים…</button>}
          <form className="row" onSubmit={(e) => { e.preventDefault(); if (customText.trim()) { setCustom([...custom, customText.trim()]); setCustomText(''); } }}>
            <input className="field" placeholder="+ משהו אחר" value={customText} onChange={(e) => setCustomText(e.target.value)} />
            <button className="btn ghost" type="submit">הוסף</button>
          </form>
        </div>
      )}

      {step === 5 && (
        <div className="onb-body" key="s5">
          <h1>כמה צריך לחסוך כדי לשלוח אותך לסופר? 🚗</h1>
          <div className="big-cards">
            {([[30, 'אני זורם'], [60, 'שיהיה שווה את זה'], [100, 'רק אם זה באמת משמעותי']] as const).map(([v, t]) => (
              <button key={v} className={`big-card ${threshold === v ? 'on' : ''}`} onClick={() => { setThreshold(v); setCustomThreshold(''); }}><span className="emo" style={{ fontWeight: 700, fontSize: 22 }}>₪{v}</span><span className="t">{t}</span></button>
            ))}
          </div>
          <input className="field" inputMode="numeric" placeholder="סכום אחר" value={customThreshold} onChange={(e) => { setCustomThreshold(e.target.value); const n = parseInt(e.target.value); setThreshold(Number.isFinite(n) ? n : null); }} />
          {threshold !== null && <div className="banner ok">סיימנו. מכאן אני אלמד תוך כדי.</div>}
        </div>
      )}

      <div className="row" style={{ marginTop: 18 }}>
        {step > 0 && <button className="btn ghost" onClick={back}>חזרה</button>}
        {step < STEPS - 1
          ? <button className="btn block grow" disabled={!canNext} onClick={next}>ממשיכים</button>
          : <button className="btn block grow" disabled={!canNext || saving} onClick={finish}>{saving ? 'שומר…' : 'בוא נבנה קנייה'}</button>}
      </div>
    </div>
  );
}
