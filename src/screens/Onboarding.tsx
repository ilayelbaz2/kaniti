import { useEffect, useRef, useState } from 'react';
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

// ---- delivery check ----
type DlvKind = 'loading' | 'ok' | 'login' | 'no' | 'unknown';
type DlvRow = { id: string; name: string; kind: DlvKind; r?: DeliveryResult };
function kindOf(r: DeliveryResult): Exclude<DlvKind, 'loading'> {
  if (r.status === 'confirmed') return 'ok';
  if (r.status === 'user_action_required' || r.needsLogin) return 'login';
  if (r.status === 'unavailable' || (!r.status && r.delivers === false)) return 'no';
  return 'unknown';
}
const DLV_ICON: Record<DlvKind, string> = { loading: '⏳', ok: '✅', login: '🔐', no: '❌', unknown: '?' };
const DLV_TEXT: Record<DlvKind, string> = {
  loading: 'בודק…',
  ok: 'משלוח לכתובת מאומת',
  login: 'צריך התחברות כדי לאמת — אבדוק כשתתחברו',
  no: 'לא שולחת לכתובת הזו',
  unknown: 'טרם אומת',
};

// ---- staples ----
type Level = 'always' | 'sometimes' | 'no';
const LEVELS: [Level, string][] = [['always', 'תמיד צריך'], ['sometimes', 'לפעמים'], ['no', 'לא אצלנו']];
const GROUPS: { id: string; emoji: string }[] = [
  { id: 'מקרר', emoji: '🧊' }, { id: 'מזווה', emoji: '🥫' }, { id: 'ילד', emoji: '🧸' }, { id: 'שתייה', emoji: '🥤' },
  { id: 'בשר/דגים', emoji: '🍗' }, { id: 'חטיפים', emoji: '🍿' }, { id: 'כביסה', emoji: '🧺' }, { id: 'ניקיון', emoji: '🧽' }, { id: 'נייר/בית', emoji: '🧻' },
];
const VISIBLE_PER_GROUP = 6;
type CustomRow = { key: string; group: string; label: string; level: 'always' | 'sometimes' };

export function Onboarding({ onDone }: { onDone: (s: AppState) => void }) {
  const [step, setStep] = useState(0);
  const [adults, setAdults] = useState(2);
  const [kids, setKids] = useState<number[]>([]);
  const [kosher, setKosher] = useState(false);
  const [dairy, setDairy] = useState(false);
  const [dairyWho, setDairyWho] = useState<'all' | 'kids'>('kids');
  const [veg, setVeg] = useState(false);
  const [otherOn, setOtherOn] = useState(false);
  const [other, setOther] = useState('');
  // address & delivery
  const [city, setCity] = useState('');
  const [street, setStreet] = useState('');
  const [online, setOnline] = useState<{ id: string; name: string }[]>([]);
  const [rows, setRows] = useState<DlvRow[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const touched = useRef(new Set<string>());
  const checkGen = useRef(0);
  const [chains, setChains] = useState<{ id: string; name: string }[]>([]);
  const [chain, setChain] = useState<string | null>(null);
  const [stores, setStores] = useState<StoreOption[] | null>(null);
  const [storeErr, setStoreErr] = useState<string | null>(null);
  const [dlvErr, setDlvErr] = useState<string | null>(null);
  const [physical, setPhysical] = useState<{ chainId: string; storeId: string; name: string }[]>([]);
  // flex
  const [flexIdx, setFlexIdx] = useState(0);
  const [flex, setFlex] = useState<Partial<Record<FlexKey, FlexAnswer>>>({});
  // staples
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [levels, setLevels] = useState<Record<string, Level>>({});
  const [openGroups, setOpenGroups] = useState<string[]>(['מקרר', 'מזווה']);
  const [moreGroups, setMoreGroups] = useState<string[]>([]);
  const [customs, setCustoms] = useState<CustomRow[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const [addText, setAddText] = useState('');
  const [addLevel, setAddLevel] = useState<'always' | 'sometimes'>('always');
  const [annoy, setAnnoy] = useState('');
  // threshold
  const [threshold, setThreshold] = useState<number | null>(null);
  const [customThreshold, setCustomThreshold] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  useEffect(() => {
    api.catalog().then(setCatalog).catch(() => {});
    api.providers().then((p) => { setChains(p.physicalChains); setOnline(p.online); }).catch(() => {});
  }, []);

  const toggle = (arr: string[], v: string, set: (x: string[]) => void) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  // ---------- address & delivery ----------
  const hasHouseNo = /\d/.test(street);
  const addrOk = city.trim().length > 1 && street.trim().length > 1 && hasHouseNo;
  const editAddress = (fn: () => void) => { fn(); if (rows) { checkGen.current++; setRows(null); } };

  function resolveRow(gen: number, id: string, r: DeliveryResult | null, err?: string) {
    if (gen !== checkGen.current) return; // address changed since
    const result: DeliveryResult = r ?? { providerId: id, name: '', status: 'unknown', delivers: null, checkedLive: false, note: `לא הצלחתי לבדוק כרגע${err ? ` (${err})` : ''}` };
    const kind = kindOf(result);
    setRows((prev) => prev?.map((x) => (x.id === id ? { ...x, name: result.name || x.name, kind, r: result } : x)) ?? prev);
    if (!touched.current.has(id)) setChosen((c) => (kind === 'no' ? c.filter((x) => x !== id) : c.includes(id) ? c : [...c, id]));
  }

  function checkOne(gen: number, id: string) {
    const c = city.trim(), s = street.trim();
    api.deliveryCheck(c, s, id)
      .then((res) => resolveRow(gen, id, res.find((x) => x.providerId === id) ?? res[0] ?? null))
      .catch((e) => resolveRow(gen, id, null, (e as Error).message));
  }

  async function checkDelivery() {
    const gen = ++checkGen.current;
    touched.current = new Set();
    setDlvErr(null);
    setRows([]);
    let list = online;
    if (!list.length) {
      try { list = (await api.providers()).online; setOnline(list); } catch (e) { setDlvErr((e as Error).message); }
      if (gen !== checkGen.current) return;
    }
    setRows(list.map((p) => ({ id: p.id, name: p.name, kind: 'loading' })));
    setChosen(list.map((p) => p.id));
    for (const p of list) checkOne(gen, p.id);
  }

  function retry(id: string) {
    setRows((prev) => prev?.map((x) => (x.id === id ? { ...x, kind: 'loading' } : x)) ?? prev);
    checkOne(checkGen.current, id);
  }

  function pickRow(id: string) {
    touched.current.add(id);
    toggle(chosen, id, setChosen);
  }

  async function pickChain(id: string) {
    setChain(id); setStores(null); setStoreErr(null);
    try { setStores(await api.stores(id, city)); } catch (e) { setStoreErr((e as Error).message); }
  }

  const renderRow = (d: DlvRow) => {
    const on = chosen.includes(d.id);
    const showMoney = d.kind === 'ok' && d.r && (d.r.deliveryFee != null || d.r.minOrder != null);
    return (
      <div key={d.id} className={`provider-row dlv ${on ? 'on' : ''} k-${d.kind}`}>
        <button className="dlv-main" onClick={() => pickRow(d.id)} aria-pressed={on}>
          <span className="check">{on ? '✓' : ''}</span>
          <span className="grow dlv-text">
            <span className="dlv-name">{d.name}</span>
            <span className={`dlv-tag k-${d.kind}`}><span className="dlv-ico">{DLV_ICON[d.kind]}</span> {DLV_TEXT[d.kind]}</span>
            {showMoney && (
              <span className="faint">
                {[d.r!.deliveryFee != null ? `משלוח ₪${d.r!.deliveryFee}` : '', d.r!.minOrder != null ? `מינימום הזמנה ₪${d.r!.minOrder}` : ''].filter(Boolean).join(' · ')}
              </span>
            )}
            {d.kind === 'ok' && d.r?.addressText && <span className="faint">לכתובת: {d.r.addressText}</span>}
            {d.kind !== 'loading' && d.r?.note && <span className="faint dlv-note">{d.r.note}</span>}
          </span>
        </button>
        {d.kind === 'unknown' && <button className="link dlv-retry" onClick={() => retry(d.id)}>לנסות שוב</button>}
      </div>
    );
  };

  // ---------- staples ----------
  const allDairyFree = dairy && dairyWho === 'all';
  const kidDairyOnly = dairy && dairyWho === 'kids';
  const visibleItem = (c: CatalogItem) => {
    if (allDairyFree && c.dairy) return false;
    if (kidDairyOnly && c.id === 'KIDS_DAIRY') return false; // their desserts are dairy-free ones
    if (c.id === 'DAIRY_FREE_DESSERT' && !(dairy && kids.length)) return false;
    if (veg && c.group === 'בשר/דגים') return false;
    if (c.group === 'ילד' && !kids.length) return false;
    return true;
  };
  const visibleCatalog = catalog.filter(visibleItem);
  const groups = GROUPS.map((g) => ({
    ...g,
    items: visibleCatalog.filter((c) => c.group === g.id).sort((a, b) => Number(b.staple) - Number(a.staple)),
    customs: customs.filter((c) => c.group === g.id),
  })).filter((g) => g.items.length > 0 || g.customs.length > 0);

  const setLevel = (id: string, l: Level) => setLevels((prev) => {
    const n = { ...prev };
    if (n[id] === l) delete n[id]; else n[id] = l;
    return n;
  });

  function addCustom(group: string) {
    const label = addText.trim();
    if (!label) return;
    setCustoms([...customs, { key: `${group}:${Date.now()}`, group, label, level: addLevel }]);
    setAddText(''); setAddLevel('always'); setAdding(null);
  }

  const groupSummary = (items: CatalogItem[], cs: CustomRow[]) => {
    const always = items.filter((c) => levels[c.id] === 'always').length + cs.filter((c) => c.level === 'always').length;
    const some = items.filter((c) => levels[c.id] === 'sometimes').length + cs.filter((c) => c.level === 'sometimes').length;
    if (!always && !some) return null;
    return [always ? `${always} תמיד` : '', some ? `${some} לפעמים` : ''].filter(Boolean).join(' · ');
  };

  async function finish() {
    setSaving(true); setSaveErr(null);
    try {
      const visibleIds = new Set(visibleCatalog.map((c) => c.id));
      const stapleLevels = Object.fromEntries(Object.entries(levels).filter(([id]) => visibleIds.has(id)));
      const s = await api.onboarding({
        adults, children: kids.map((age) => ({ age })), kosher, dairyAllergy: dairy, dairyAllergyWho: dairyWho, vegetarian: veg,
        otherConstraint: otherOn ? other : undefined, address: { city: city.trim(), street: street.trim() || undefined },
        onlineProviders: chosen, physicalStores: physical, flex, threshold: threshold ?? 60,
        stapleLevels,
        customStaples: customs.map((c) => ({ label: c.label, level: c.level })),
        annoyText: annoy.trim() || undefined,
        staples: Object.entries(stapleLevels).filter(([, l]) => l !== 'no').map(([id]) => id),
      });
      onDone(s);
    } catch (e) { setSaveErr((e as Error).message); } finally { setSaving(false); }
  }

  const next = () => { setStep((s) => Math.min(STEPS, s + 1)); window.scrollTo(0, 0); };
  const back = () => { setStep((s) => Math.max(0, s - 1)); window.scrollTo(0, 0); };
  const canNext = [true, true, addrOk && rows !== null, flexIdx >= FLEX_CARDS.length, true, threshold !== null][step];

  const pending = rows?.filter((r) => r.kind !== 'no') ?? [];
  const unavailable = rows?.filter((r) => r.kind === 'no') ?? [];
  const stillChecking = rows?.some((r) => r.kind === 'loading');

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
          {dairy && (
            <div className="card stack">
              <b>האלרגיה לחלב — של מי?</b>
              <div className="chips">
                <button className={`chip ${dairyWho === 'kids' ? 'on' : ''}`} onClick={() => setDairyWho('kids')}>רק הילד/ה</button>
                <button className={`chip ${dairyWho === 'all' ? 'on' : ''}`} onClick={() => setDairyWho('all')}>כל הבית</button>
              </div>
              <div className="faint">{dairyWho === 'kids' ? 'אצלכם יהיו מוצרי חלב, אבל מה שמיועד לילד (מעדנים, ממרחים) — רק פרווה.' : 'לא אציע שום מוצר חלבי.'}</div>
            </div>
          )}
          {otherOn && <input className="field" placeholder="למשל: בלי גלוטן" value={other} onChange={(e) => setOther(e.target.value)} autoFocus />}
        </div>
      )}

      {step === 2 && (
        <div className="onb-body" key="s2">
          <h1>לאן מביאים את הקניות? 🚚</h1>
          <div className="stack">
            <label className="addr-field">
              <span className="addr-label">עיר</span>
              <input className="field" placeholder="למשל: רמת גן" value={city} autoComplete="address-level2" onChange={(e) => { const v = e.target.value; editAddress(() => setCity(v)); }} />
            </label>
            <label className="addr-field">
              <span className="addr-label">רחוב ומספר בית</span>
              <input className="field" placeholder="למשל: ביאליק 12" value={street} autoComplete="street-address" onChange={(e) => { const v = e.target.value; editAddress(() => setStreet(v)); }} />
            </label>
            {street.trim().length > 1 && !hasHouseNo && <div className="addr-warn">חסר מספר בית — בלעדיו אי אפשר לבדוק משלוח לכתובת</div>}
            <button className="btn" disabled={!addrOk || !!stillChecking} onClick={checkDelivery}>{stillChecking ? 'בודק מי שולח אליכם…' : rows ? 'בדוק שוב' : 'בדוק מי שולח אליי'}</button>
          </div>
          {rows && (
            <div className="stack">
              {rows.length === 0 && !dlvErr && <div className="stages"><div className="on">בודק מי שולח אליכם…</div></div>}
              {dlvErr && <div className="banner warn">לא הצלחתי לטעון את רשימת הרשתות ({dlvErr}). נסו שוב, או המשיכו ואבדוק אחר כך.</div>}
              {pending.length > 0 && <div className="faint">סמנו את הרשתות שתרצו שאשווה:</div>}
              {pending.map(renderRow)}
              {unavailable.length > 0 && (
                <details className="dlv-no">
                  <summary>לא שולחים אליכם ({unavailable.length})</summary>
                  <div className="stack">{unavailable.map(renderRow)}</div>
                </details>
              )}
              {rows.length > 0 && <div className="dlv-legend">✅ מאומת לכתובת · 🔐 צריך התחברות · ? טרם אומת · ❌ לא שולחת</div>}
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
          <div className="faint">אפשר לשנות בכל רגע במסך 'הבית'</div>
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
          <h1>מה אסור שייגמר בבית?</h1>
          <p className="sub">זה לא רשימת קניות — רק מה שחשוב שיהיה. כמה וכמה אני אלמד לבד.</p>
          {catalog.length === 0 && <div className="skeleton" />}
          {groups.map((g) => {
            const open = openGroups.includes(g.id);
            const more = moreGroups.includes(g.id);
            const shown = more ? g.items : g.items.slice(0, VISIBLE_PER_GROUP);
            const summary = groupSummary(g.items, g.customs);
            return (
              <div key={g.id} className={`st-group ${open ? 'open' : ''}`}>
                <button className="st-head" onClick={() => toggle(openGroups, g.id, setOpenGroups)} aria-expanded={open}>
                  <span className="st-gemo">{g.emoji}</span>
                  <span className="grow"><b>{g.id}</b>{summary ? <span className="st-count">{summary}</span> : <span className="st-count faint">{g.items.length + g.customs.length} פריטים</span>}</span>
                  <span className="st-chev">⌄</span>
                </button>
                {open && (
                  <div className="st-list">
                    {shown.map((c) => {
                      const lv = levels[c.id];
                      return (
                        <div key={c.id} className={`st-row ${lv ?? ''}`}>
                          <span className="st-emo">{c.emoji}</span>
                          <span className="st-label">{c.label}</span>
                          <div className="seg" role="group" aria-label={c.label}>
                            {LEVELS.map(([l, t]) => (
                              <button key={l} className={`${lv === l ? 'on' : ''} ${l}`} aria-pressed={lv === l} onClick={() => setLevel(c.id, l)}>{t}</button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                    {g.customs.map((c) => (
                      <div key={c.key} className={`st-row ${c.level}`}>
                        <span className="st-emo">🛒</span>
                        <span className="st-label">{c.label}</span>
                        <div className="seg two" role="group" aria-label={c.label}>
                          {LEVELS.slice(0, 2).map(([l, t]) => (
                            <button key={l} className={`${c.level === l ? 'on' : ''} ${l}`} aria-pressed={c.level === l} onClick={() => setCustoms(customs.map((x) => (x.key === c.key ? { ...x, level: l as 'always' | 'sometimes' } : x)))}>{t}</button>
                          ))}
                          <button className="st-x" aria-label={`הסר ${c.label}`} onClick={() => setCustoms(customs.filter((x) => x.key !== c.key))}>×</button>
                        </div>
                      </div>
                    ))}
                    {g.items.length > VISIBLE_PER_GROUP && !more && (
                      <button className="link st-more" onClick={() => setMoreGroups([...moreGroups, g.id])}>עוד… ({g.items.length - VISIBLE_PER_GROUP})</button>
                    )}
                    {adding === g.id ? (
                      <form className="st-add" onSubmit={(e) => { e.preventDefault(); addCustom(g.id); }}>
                        <input className="field" placeholder="מה עוד?" value={addText} onChange={(e) => setAddText(e.target.value)} autoFocus />
                        <div className="row">
                          <div className="seg two grow">
                            {LEVELS.slice(0, 2).map(([l, t]) => (
                              <button type="button" key={l} className={`${addLevel === l ? 'on' : ''} ${l}`} aria-pressed={addLevel === l} onClick={() => setAddLevel(l as 'always' | 'sometimes')}>{t}</button>
                            ))}
                          </div>
                          <button className="btn small" type="submit" disabled={!addText.trim()}>הוסף</button>
                          <button className="btn small ghost" type="button" onClick={() => { setAdding(null); setAddText(''); }}>ביטול</button>
                        </div>
                      </form>
                    ) : (
                      <button className="link st-more" onClick={() => { setAdding(g.id); setAddText(''); setAddLevel('always'); }}>+ הוסף משלך</button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <div className="card stack">
            <b>יש עוד משהו שאתה תמיד מתעצבן כשנגמר?</b>
            <input className="field" placeholder="למשל: קטשופ, נייר אפייה…" value={annoy} onChange={(e) => setAnnoy(e.target.value)} />
          </div>
          <button className="link" style={{ alignSelf: 'center', minHeight: 40 }} onClick={next}>דלג — אלמד תוך כדי</button>
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
          {saveErr && <div className="banner warn">לא הצלחתי לשמור ({saveErr}). נסו שוב.</div>}
        </div>
      )}

      <div className="row onb-nav">
        {step > 0 && <button className="btn ghost" onClick={back}>חזרה</button>}
        {step < STEPS - 1
          ? <button className="btn block grow" disabled={!canNext} onClick={next}>ממשיכים</button>
          : <button className="btn block grow" disabled={!canNext || saving} onClick={finish}>{saving ? 'שומר…' : 'בוא נבנה קנייה'}</button>}
      </div>
    </div>
  );
}
