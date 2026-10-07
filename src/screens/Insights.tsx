import { useEffect, useState } from 'react';
import { api, type Confidence, type Insight, type InsightsReport } from '../api.ts';
import { nis } from '../components/ChatParts.tsx';

const CONF: Record<Confidence, { label: string; cls: string }> = {
  observed: { label: 'נצפה', cls: 'live' },
  estimated: { label: 'הערכה', cls: 'estimate' },
  insufficient: { label: 'אין מספיק נתונים', cls: 'need' },
};

function Chip({ c }: { c: Confidence }) {
  return <span className={`tag ${CONF[c].cls}`} style={{ flexShrink: 0 }}>{CONF[c].label}</span>;
}

function Row({ i }: { i: Insight }) {
  return <div className="spread small" style={{ alignItems: 'flex-start', gap: 8 }}><span>{i.text}</span><Chip c={i.confidence} /></div>;
}

/** Household insights: what we can actually say from the purchases you confirmed. Grows more useful over time. */
export function Insights() {
  const [r, setR] = useState<InsightsReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.insights().then(setR).catch((e) => setErr((e as Error).message)); }, []);
  if (err) return <div className="banner warn">{err}</div>;
  if (!r) return <div className="stack"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>;

  const tile = (kind: string, title: string) => {
    const i = r.spending.find((x) => x.kind === kind);
    if (!i) return null;
    return (
      <div className="mini-card stack" style={{ flex: '1 1 45%', minWidth: 140 }}>
        <span className="faint">{title}</span>
        <b className="big-num" style={{ fontSize: 20 }}>{i.confidence === 'insufficient' || i.value === undefined ? '—' : nis(Math.round(i.value))}</b>
        <span className="faint" style={{ fontSize: 12 }}>{i.confidence === 'insufficient' ? i.text : CONF[i.confidence].label}</span>
      </div>
    );
  };
  const rows = r.categories.rows;
  const max = Math.max(1, ...rows.map((x) => x.amount));

  return (
    <div className="stack">
      <div><h2>תובנות</h2><div className="muted small">לפי הקניות שאישרתם בקניתי. נעשה מדויק יותר עם הזמן.</div></div>

      <div className="card stack" style={{ borderColor: 'var(--green, #16a34a)' }}>
        <div className="spread"><b>🗓️ מתי כדאי לעשות את הקנייה הבאה?</b><Chip c={r.nextShop.confidence} /></div>
        <div>{r.nextShop.text}</div>
      </div>

      <div className="card stack">
        <b>💸 הוצאות</b>
        <div className="row wrap" style={{ gap: 8 }}>
          {tile('month_spend', 'החודש')}
          {tile('monthly_avg', 'ממוצע חודשי')}
          {tile('last_shop', 'קנייה אחרונה')}
          {tile('avg_shop', 'ממוצע לקנייה')}
        </div>
        {r.spending.filter((i) => i.kind === 'last_month').map((i) => <Row key={i.id} i={i} />)}
      </div>

      <div className="card stack">
        <div className="spread"><b>🧺 על מה הולך הכסף</b><Chip c={r.categories.insight.confidence} /></div>
        {rows.length ? (
          <div className="stack" style={{ gap: 6 }} role="list" aria-label="פילוח הוצאות לפי קטגוריה">
            {rows.map((x) => (
              <div key={x.group} className="small" role="listitem">
                <div className="spread"><span>{x.group}</span><span className="muted">{nis(Math.round(x.amount))} · {Math.round(x.share * 100)}%</span></div>
                <div className="bar"><div style={{ width: `${Math.round((x.amount / max) * 100)}%` }} /></div>
              </div>
            ))}
          </div>
        ) : null}
        <div className="faint">{r.categories.insight.text}</div>
      </div>

      <div className="card stack">
        <b>🔁 קצב קניות</b>
        {r.rhythm.map((i) => <Row key={i.id} i={i} />)}
      </div>

      {r.consumption.length > 0 && (
        <div className="card stack">
          <b>🥚 מה למדתי על הצריכה</b>
          {r.consumption.slice(0, 4).map((i) => <Row key={i.id} i={i} />)}
        </div>
      )}

      <div className="card stack">
        <b>💰 חיסכון</b>
        {r.savings.insights.map((i) => <Row key={i.id} i={i} />)}
        <div className="faint">"נחסך" = מדוד מול הצעה אמיתית אחרת באותו רגע. "משוער" = לפי מחיר רגיל או המוצר הקבוע. "אפשר לחסוך" = מבצעים פתוחים, לא נספר כחיסכון.</div>
      </div>

      <div className="card stack">
        <div className="spread"><b>📅 יש יום זול יותר?</b><Chip c={r.weekday.confidence} /></div>
        <div className="small">{r.weekday.text}</div>
      </div>
    </div>
  );
}
