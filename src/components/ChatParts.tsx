import { productLine } from '../../shared/product.ts';
import { useState } from 'react';
import type { ChatComponent, PriceSource } from '../../shared/types.ts';

export const SOURCE_LABEL: Record<PriceSource, string> = { live: 'חי אונליין', branch_data: 'קובץ מחירים רשמי של הסניף', estimate: 'הערכה', demo: 'דמו' };
export const SourceTag = ({ s }: { s: PriceSource }) => <span className={`tag ${s}`}>{SOURCE_LABEL[s]}</span>;
export const nis = (n: number) => `₪${n % 1 === 0 ? n : n.toFixed(2).replace(/0$/, '')}`;

type Send = (text: string, label?: string) => void;

export function ChatPart({ c, send, used, markUsed }: { c: ChatComponent; send: Send; used: boolean; markUsed: () => void }) {
  const once = (text: string, label?: string) => { if (used) return; markUsed(); send(text, label); };
  switch (c.type) {
    case 'quick_replies':
      return <div className="chips">{c.options.map((o) => <button key={o.send + o.label} className="chip quick" onClick={() => send(o.send, o.label)}>{o.label}</button>)}</div>;
    case 'state_change':
      return <div className="changes">{c.changes.map((x) => <div key={x}>{x}</div>)}</div>;
    case 'question':
      return (
        <div className="mini-card stack">
          <b>{c.question.text}</b>
          <div className="chips">{c.question.options.map((o) => <button key={o.value} className="chip" disabled={used} style={used ? { opacity: 0.5 } : undefined} onClick={() => once(`#stock ${c.question.needId} ${o.value}`, `${c.question.text.replace('?', '')} — ${o.label}`)}>{o.label}</button>)}</div>
        </div>
      );
    case 'stock_confirm':
      return <StockConfirm rows={c.rows} send={send} used={used} markUsed={markUsed} />;
    case 'basket_summary':
      return (
        <div className="mini-card summary-card stack">
          <div className="spread"><b>הסל מוכן 🎯</b>{c.total !== undefined && <span className="big-num" style={{ fontSize: 22 }}>~{nis(c.total)}</span>}</div>
          <div className="row wrap small muted">
            <span>{c.items} פריטים</span>
            {c.deals > 0 && <span>· 🔥 {c.deals} מבצעים טובים</span>}
            {c.substitutions > 0 && <span>· ↔ {c.substitutions} תחליפים</span>}
            {c.discoveries > 0 && <span>· 💡 {c.discoveries} הצעות</span>}
          </div>
        </div>
      );
    case 'deal': {
      const d = c.deal;
      return (
        <div className={`mini-card stack ${d.kind === 'discovery' ? 'discovery-card' : 'deal-card'}`}>
          <div className="small">{d.kind === 'discovery' ? '💡 אולי תאהבו' : '🔥 מצאתי מחיר טוב'}</div>
          <div className="spread"><b>{d.emoji} {d.label}</b><span><b>{nis(d.product.promoPrice ?? d.product.price)}</b> <span className="faint">‎−{d.discountPct}%</span></span></div>
          <div className="faint">{productLine(d.product)}{d.product.promoText ? ` · ${d.product.promoText}` : ''}</div>
          <div className="small muted">{d.why}</div>
          <div className="chips">
            <button className="chip quick" disabled={used} onClick={() => once(`#deal take ${d.needId} ${d.suggestQty}`, `להכניס ${d.suggestQty} ${d.label}`)}>להכניס {d.suggestQty}</button>
            <button className="chip" disabled={used} onClick={() => once(`#deal skip ${d.id} ${d.needId}`, 'לא מעניין')}>לא מעניין</button>
          </div>
        </div>
      );
    }
    case 'learning':
      return (
        <div className="mini-card stack" style={{ borderColor: 'var(--violet)' }}>
          <div className="small">🧠 {c.text}</div>
          <div className="chips">{c.options.map((o) => <button key={o.label} className="chip" disabled={used} onClick={() => once(o.send, o.label)}>{o.label}</button>)}</div>
        </div>
      );
    case 'prices':
      return (
        <div className="mini-card">
          {c.rows.map((r, i) => (
            <div className="price-row" key={r.provider}>
              <span className="grow"><b>{i === 0 ? '🏆 ' : ''}{r.provider}</b><div className="faint">{r.name}{r.promoText ? ` · ${r.promoText}` : ''}</div></span>
              <span style={{ textAlign: 'end' }}><b>{nis(r.price)}</b><div><SourceTag s={r.source} /></div></span>
            </div>
          ))}
          {c.failures.length > 0 && <div className="faint" style={{ marginTop: 6 }}>{c.failures.join(', ')} לא החזירו מחיר כרגע.</div>}
        </div>
      );
    case 'progress':
      return <div className="stages">{c.stages.map((s) => <div key={s} className="done">{s}</div>)}</div>;
  }
}

function StockConfirm({ rows, send, used, markUsed }: { rows: Extract<ChatComponent, { type: 'stock_confirm' }>['rows']; send: Send; used: boolean; markUsed: () => void }) {
  const [edit, setEdit] = useState(false);
  const [vals, setVals] = useState<Record<string, number>>(() => Object.fromEntries(rows.map((r) => [r.needId, Math.round(r.value * 10) / 10])));
  const save = async () => {
    markUsed();
    setEdit(false);
    const changed = rows.filter((r) => vals[r.needId] !== Math.round(r.value * 10) / 10);
    for (const r of changed) await send(`#setstock ${r.needId} ${vals[r.needId]}`, `${r.label}: ${vals[r.needId]} ${r.unit}`);
  };
  return (
    <div className="mini-card stack">
      {rows.map((r) => (
        <div className="spread" key={r.needId}>
          <span>{r.emoji} {r.label}</span>
          {edit ? (
            <div className="qty">
              <button onClick={() => setVals({ ...vals, [r.needId]: Math.max(0, +(vals[r.needId] - 1).toFixed(1)) })}>−</button>
              <span>{vals[r.needId]}</span>
              <button onClick={() => setVals({ ...vals, [r.needId]: +(vals[r.needId] + 1).toFixed(1) })}>+</button>
            </div>
          ) : <span className="muted">{r.text}</span>}
        </div>
      ))}
      {!used && (
        <div className="chips">
          {edit ? <button className="chip quick" onClick={save}>שמור</button> : <>
            <button className="chip quick" onClick={() => { markUsed(); send('#stockok', 'הכול נכון'); }}>הכול נכון</button>
            <button className="chip" onClick={() => setEdit(true)}>לתקן</button>
          </>}
        </div>
      )}
    </div>
  );
}
