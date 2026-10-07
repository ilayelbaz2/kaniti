import { useEffect, useMemo, useState } from 'react';
import type { Comparison } from '../../shared/types.ts';
import type { Ctx } from '../App.tsx';
import { api } from '../api.ts';
import { nis } from '../components/ChatParts.tsx';

type Row = { needId: string; label: string; emoji: string; quantity: number; unit: string; productName?: string; price?: number; on: boolean };

export function ConfirmSheet({ ctx, onClose }: { ctx: Ctx; onClose: () => void }) {
  const { state, setState, toast, go } = ctx;
  const b = state.basket;
  const [cmp, setCmp] = useState<Comparison | null>(null);
  const [storeId, setStoreId] = useState<string>('');
  const [otherStore, setOtherStore] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState('');
  const [saving, setSaving] = useState(false);

  const [seed, setSeed] = useState<Awaited<ReturnType<typeof api.cartSeed>>>(null);
  useEffect(() => {
    Promise.all([api.comparison().catch(() => null), api.cartSeed().catch(() => null)]).then(([c, sd]) => {
      setCmp(c);
      setSeed(sd);
      if (sd) { setStoreId(sd.providerId); if (sd.total) setTotal(String(Math.round(sd.total * 100) / 100)); }
      else if (c?.recommendation.winnerId) setStoreId(c.recommendation.winnerId);
    });
  }, []);

  const quote = cmp?.quotes.find((q) => q.providerId === storeId);
  useEffect(() => {
    if (!b) return;
    const fromCart = seed && seed.providerId === storeId ? seed : null;
    setRows(b.items.filter((i) => i.accepted && i.condition?.met !== false).map((i) => {
      const s = fromCart?.items.find((x) => x.needId === i.needId);
      if (fromCart) return { needId: i.needId, label: i.label, emoji: i.emoji, quantity: s?.quantity ?? i.quantity, unit: i.unit, productName: s?.productName ?? i.product?.name, price: s?.price ?? i.product?.price, on: !!s };
      const line = quote?.lines.find((l) => l.needId === i.needId && !l.missing);
      const price = line ? line.lineTotal / line.quantity : i.product?.price;
      return { needId: i.needId, label: i.label, emoji: i.emoji, quantity: i.quantity, unit: i.unit, productName: line?.product?.name ?? i.product?.name, price, on: !line && quote ? false : true };
    }));
  }, [b, quote, seed, storeId]);

  const computed = useMemo(() => Math.round(rows.filter((r) => r.on).reduce((s, r) => s + (r.price ?? 0) * r.quantity, 0) + (quote?.deliveryFee ?? 0)), [rows, quote]);
  const storeName = storeId === 'other' ? otherStore.trim() : quote?.providerName ?? (seed?.providerId === storeId ? seed.providerName : '');

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.purchase({
        storeName: storeName || seed?.providerName || 'לא צוין', viaCart: !!seed && seed.providerId === storeId, providerId: storeId && storeId !== 'other' ? storeId : undefined,
        total: total ? parseFloat(total) : computed,
        items: rows.filter((x) => x.on).map((x) => ({ needId: x.needId, quantity: x.quantity, productName: x.productName, price: x.price })),
      });
      setState(r.state);
      toast('נשמר! אלמד מזה לקנייה הבאה 🧠');
      onClose();
      try { sessionStorage.setItem('kaniti.homeTab', 'history'); } catch { /* ignore */ }
      go('home');
    } catch (e) { toast((e as Error).message); } finally { setSaving(false); }
  };

  return (
    <>
      <div className="sheet-back" onClick={onClose} />
      <div className="sheet stack" role="dialog" aria-label="אישור קנייה">
        <div className="grab" />
        <h2>מה בפועל נקנה?</h2>
        {!b || b.items.length === 0 ? <div className="muted">אין סל פעיל לאשר.</div> : (
          <>
            <div className="group-title">איפה קניתם?</div>
            <div className="chips">
              {seed && !cmp?.quotes.some((q) => q.providerId === seed.providerId) && <button className={`chip ${storeId === seed.providerId ? 'on' : ''}`} onClick={() => setStoreId(seed.providerId)}>{seed.providerName}</button>}
              {cmp?.quotes.filter((q) => q.ok).map((q) => <button key={q.providerId} className={`chip ${storeId === q.providerId ? 'on' : ''}`} onClick={() => setStoreId(q.providerId)}>{q.providerName}</button>)}
              <button className={`chip ${storeId === 'other' ? 'on' : ''}`} onClick={() => setStoreId('other')}>מקום אחר</button>
            </div>
            {storeId === 'other' && <input className="field" placeholder="שם החנות" value={otherStore} onChange={(e) => setOtherStore(e.target.value)} />}
            {seed && seed.providerId === storeId && <div className="banner ok small">מילאתי לפי העגלה שהכנתי ב{seed.providerName}. תקנו אם שיניתם משהו באתר.</div>}
            <div className="group-title">פריטים (בטלו סימון למה שלא נקנה)</div>
            <div className="card stack">
              {rows.map((r, idx) => (
                <div className="spread" key={r.needId} style={{ opacity: r.on ? 1 : 0.45 }}>
                  <button className="row grow" style={{ textAlign: 'start' }} onClick={() => setRows(rows.map((x, j) => (j === idx ? { ...x, on: !x.on } : x)))}>
                    <span className={`tick ${r.on ? 'on' : ''}`}>{r.on ? '✓' : ''}</span>
                    <span>{r.emoji} {r.label}</span>
                  </button>
                  <div className="qty">
                    <button onClick={() => setRows(rows.map((x, j) => (j === idx ? { ...x, quantity: Math.max(0, x.quantity - 1), on: x.quantity - 1 > 0 } : x)))}>−</button>
                    <span>{r.quantity}</span>
                    <button onClick={() => setRows(rows.map((x, j) => (j === idx ? { ...x, quantity: x.quantity + 1, on: true } : x)))}>+</button>
                  </div>
                </div>
              ))}
            </div>
            <div className="group-title">סכום ששולם</div>
            <input className="field" inputMode="decimal" placeholder={`~${nis(computed)} (לפי ההשוואה)`} value={total} onChange={(e) => setTotal(e.target.value)} />
            <button className="btn block" disabled={saving || (storeId === 'other' && !otherStore.trim()) || !storeId} onClick={save}>{saving ? 'שומר…' : 'אשר קנייה'}</button>
          </>
        )}
        <button className="btn ghost" onClick={onClose}>ביטול</button>
      </div>
    </>
  );
}
