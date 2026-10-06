import { useEffect, useState } from 'react';
import type { Deal } from '../../shared/types.ts';
import type { Ctx } from '../App.tsx';
import { api } from '../api.ts';
import { nis, SourceTag } from '../components/ChatParts.tsx';

type Kind = Deal['kind'];
const TABS: [Kind, string][] = [['now', 'שווה עכשיו'], ['stock', 'סטוק'], ['discovery', 'אולי תאהבו']];

export function Deals({ ctx }: { ctx: Ctx }) {
  const { setState, toast } = ctx;
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [failures, setFailures] = useState<string[]>([]);
  const [demo, setDemo] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Kind>('now');

  const load = async () => {
    setDeals(null); setError(null);
    try {
      const r = await api.deals();
      setDeals(r.deals); setFailures(r.failures.map((f) => f.name)); setDemo(r.demo); setNames(r.providers);
      if (!r.deals.some((d) => d.kind === 'now') && r.deals.some((d) => d.kind === 'stock')) setTab('stock');
    } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void load(); }, []);

  const take = async (d: Deal, qty: number) => {
    setState(await api.add(d.needId, qty));
    setDeals((ds) => ds?.filter((x) => x.id !== d.id) ?? null);
    toast(`${d.label} × ${qty} בסל ✓`);
  };
  const skip = async (d: Deal) => {
    await api.dismissDeal(d.id, d.needId);
    setDeals((ds) => ds?.filter((x) => x.id !== d.id) ?? null);
  };

  const shown = deals?.filter((d) => d.kind === tab) ?? [];
  return (
    <div className="screen stack">
      <div className="screen-head"><h1>מצאתי בשבילכם</h1><button className="link" onClick={load}>רענן</button></div>
      <div className="chips scroll">{TABS.map(([k, l]) => <button key={k} className={`chip ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}{deals ? ` · ${deals.filter((d) => d.kind === k).length}` : ''}</button>)}</div>
      {demo && <div className="banner demo">מצב דמו — המחירים אינם אמיתיים</div>}
      {failures.length > 0 && <div className="banner warn">{failures.join(', ')} לא החזירו מחיר כרגע — המשכתי עם שאר הרשתות.</div>}
      {error && <div className="empty"><div className="emo">😕</div><div>{error}</div><button className="btn" onClick={load}>לנסות שוב</button></div>}
      {!deals && !error && <><div className="stages"><div className="on">מחפש מבצעים רלוונטיים…</div></div><div className="skeleton" /><div className="skeleton" /></>}
      {deals && shown.length === 0 && (
        <div className="empty"><div className="emo">🤷</div><div>{tab === 'discovery' ? 'אין כרגע משהו חדש ששווה להציע.' : 'אין כרגע מבצעים ששווים משהו בשבילכם.'}</div><div className="faint">מבצע של 40% על משהו שלא קונים — זה לא מבצע.</div></div>
      )}
      {shown.map((d) => (
        <div key={d.id} className={`card stack ${d.kind === 'discovery' ? 'discovery-card' : ''}`}>
          <div className="spread">
            <b>{d.kind === 'stock' ? '📦' : d.kind === 'discovery' ? '💡' : '🔥'} {d.emoji} {d.label} — {nis(d.product.promoPrice ?? d.product.price)}</b>
            <SourceTag s={d.product.source} />
          </div>
          <div className="faint">{d.product.name}{d.product.promoText ? ` · ${d.product.promoText}` : ''} · ‎−{d.discountPct}% · {names[d.product.providerId] ?? d.product.providerId}</div>
          <div className="small muted">{d.kind === 'now' ? 'מחיר טוב מאוד · ' : d.kind === 'stock' ? 'מתאים לסטוק · ' : ''}{d.why}</div>
          <div className="row wrap">
            {d.kind === 'stock' ? <>
              <button className="btn small" onClick={() => take(d, d.suggestQty)}>קח {d.suggestQty}</button>
              <button className="btn small ghost" onClick={() => take(d, 1)}>קח 1</button>
              <button className="btn small ghost" onClick={() => skip(d)}>דלג</button>
            </> : <>
              <button className="btn small" onClick={() => take(d, d.suggestQty)}>{d.kind === 'discovery' ? 'הוסף' : 'הוסף לסל'}</button>
              <button className="btn small ghost" onClick={() => skip(d)}>{d.kind === 'discovery' ? 'לא הפעם' : 'לא מעניין'}</button>
            </>}
            {d.kind !== 'discovery' && <button className="link small" onClick={async () => { await api.alwaysDeal(d.needId); toast('אראה לכם תמיד כשזה זול'); }}>תמיד תראה לי אם זול</button>}
          </div>
        </div>
      ))}
    </div>
  );
}
