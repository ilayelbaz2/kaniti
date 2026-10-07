import { useEffect, useRef, useState } from 'react';
import type { CartJob, DeliveryStatus, ProviderDelivery } from '../../shared/types.ts';
import type { Ctx } from '../App.tsx';
import { api } from '../api.ts';
import { nis } from '../components/ChatParts.tsx';
import { productLine } from '../../shared/product.ts';

const TERMINAL = ['ready', 'partial', 'failed', 'unsupported'];

export const DELIVERY_LABEL: Record<DeliveryStatus, string> = {
  confirmed: '✅ משלוח לכתובת שלך מאומת',
  unavailable: '⛔ הרשת לא שולחת כרגע לכתובת הזו',
  user_action_required: '📍 צריך לבחור/לאשר כתובת באתר הסופר',
  unknown: '❔ לא הצלחתי לאמת משלוח לכתובת',
};
export const deliveryTagClass = (s: DeliveryStatus) => (s === 'confirmed' ? 'live' : s === 'unavailable' ? 'need' : 'estimate');

/** Delivery to the household's address as the supermarket page showed it. */
export function DeliveryFacts({ d, fee, feeEstimated, window: slot }: { d?: ProviderDelivery; fee?: number; feeEstimated?: boolean; window?: string }) {
  const status = d?.deliveryStatus ?? 'unknown';
  return (
    <>
      <div className="spread"><span className="muted">משלוח</span><span className={`tag ${deliveryTagClass(status)}`}>{DELIVERY_LABEL[status]}</span></div>
      {d?.confirmedAddressText && <div className="spread"><span className="muted">כתובת באתר</span><b>{d.confirmedAddressText}</b></div>}
      {d?.restrictionMessage && <div className="small" style={{ color: "#b45309" }}>{d.restrictionMessage}</div>}
      <div className="spread"><span className="muted">דמי משלוח</span><b>{fee === undefined ? 'לא ידוע' : feeEstimated ? `~${nis(fee)} (הערכה לפי מחירון — האתר לא הציג)` : `${nis(fee)} (לפי האתר)`}</b></div>
      {(slot || d?.deliveryWindows?.length) && <div className="spread"><span className="muted">חלון משלוח</span><b className="small">{slot ?? d!.deliveryWindows!.slice(0, 2).join(' · ')}</b></div>}
      {d?.minimumOrder !== undefined && <div className="spread"><span className="muted">מינימום הזמנה</span><b>{nis(d.minimumOrder)}</b></div>}
    </>
  );
}

/** Prepares the real supermarket cart and hands off. Payment always happens on the supermarket's own site. */
export function CartSheet({ ctx, providerId, verifyOnly, onClose }: { ctx: Ctx; providerId?: string; verifyOnly?: boolean; onClose: () => void }) {
  const [job, setJob] = useState<CartJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (providerId ? api.prepareCart(providerId, verifyOnly) : api.cartJob()).then(setJob).catch((e) => setError((e as Error).message));
  }, [providerId, verifyOnly]);

  useEffect(() => {
    if (!job || TERMINAL.includes(job.status)) return;
    const t = setInterval(() => api.cartJob().then((j) => j && setJob(j)).catch(() => {}), 1500);
    return () => clearInterval(t);
  }, [job?.status, job?.id]);

  const added = job?.lines.filter((l) => l.state === 'added') ?? [];
  const notAdded = job?.lines.filter((l) => l.state === 'failed' || l.state === 'skipped') ?? [];
  const unverified = job?.lines.filter((l) => l.state === 'unverified') ?? [];
  const total = job?.cartTotal ?? (job ? added.reduce((s, l) => s + (l.price ?? 0) * l.quantity, 0) + (job.deliveryFee ?? 0) : 0);

  return (
    <>
      <div className="sheet-back" onClick={onClose} />
      <div className="sheet stack" role="dialog" aria-label="הכנת עגלה">
        <div className="grab" />
        {error && <><h2>לא הצלחתי להתחיל</h2><div className="banner warn">{error}</div></>}
        {!job && !error && <div className="stages"><div className="on">מתחיל…</div></div>}
        {job && (
          <>
            {job.demo && <div className="banner demo">מצב דמו — לא נוצרה עגלה אמיתית</div>}
            {job.verifyOnly && job.status === 'ready' ? (
              <>
                <h2>משלוח מ{job.providerName}</h2>
                <div className="card stack">
                  <DeliveryFacts d={job.delivery} fee={job.deliveryFee} feeEstimated={job.deliveryFeeEstimated} />
                </div>
                <div className="faint">נקרא מהאתר של {job.providerName} עצמו, לפי הכתובת שנבחרה שם. לא נוסף שום דבר לעגלה.</div>
              </>
            ) : (job.status === 'ready' || job.status === 'partial') ? (
              <>
                <h2>{job.status === 'ready' ? 'העגלה מוכנה 🎯' : 'לא הצלחתי להכין את כל העגלה'}</h2>
                <div className="small muted">{job.message}</div>
                <div className="card stack">
                  <div className="spread"><span className="muted">רשת</span><b>{job.providerName}</b></div>
                  <DeliveryFacts d={job.delivery} fee={job.deliveryFee} feeEstimated={job.deliveryFeeEstimated} window={job.deliveryWindow} />
                  <div className="spread"><span className="muted">בעגלה באתר</span><b>{added.length}/{job.lines.length} פריטים{job.cartVerified ? ' ✓ נבדק' : ''}</b></div>
                  {job.substitutions > 0 && <div className="spread"><span className="muted">תחליפים</span><b>{job.substitutions}</b></div>}
                  <div className="spread"><span className="muted">סה״כ{job.cartTotal !== undefined ? ' (לפי העגלה באתר)' : ' (הערכה)'}</span><b className="big-num" style={{ fontSize: 22 }}>{job.cartTotal !== undefined ? nis(Math.round(total * 10) / 10) : `~${nis(Math.round(total))}`}</b></div>
                </div>
                {job.delivery?.deliveryStatus !== 'confirmed' && <div className="banner warn">משלוח לכתובת שלכם לא אומת באתר. בדקו את הכתובת והמשלוח בעגלה לפני התשלום.</div>}
                <details className="card" open={notAdded.length + unverified.length > 0}>
                  <summary className="small"><b>פירוט לפי פריט</b></summary>
                  <div className="stack" style={{ marginTop: 8 }}>
                    {job.lines.map((l) => (
                      <div key={l.needId} className="small">
                        {l.state === 'added' ? '✅' : l.state === 'unverified' ? '❔' : '❌'} {l.productName ? productLine({ name: l.productName, brand: l.brand, sizeText: l.sizeText, byWeight: l.byWeight }) : l.label} × {l.quantity}
                        {l.reason ? <span className="faint"> — {l.reason}</span> : null}
                      </div>
                    ))}
                    {notAdded.length > 0 && <div className="faint">את מה שלא נכנס אפשר להוסיף ידנית באתר.</div>}
                  </div>
                </details>
                {job.preexistingItems ? <div className="banner warn">בעגלה באתר יש עוד {job.preexistingItems} פריטים שהיו שם לפני כן — הסכום כולל אותם. בדקו לפני התשלום.</div> : null}
                {job.anonymous && <div className="banner warn">לא הייתם מחוברים: העגלה נשמרה רק בחלון Chrome שקניתי פתחה במחשב הזה — היא לא תופיע בטלפון או בדפדפן אחר. כדי לשמור אותה בחשבון, התחברו באותו חלון.</div>}
                <div className="banner ok small">התשלום והאישור הסופי נעשים באתר של {job.providerName}. קניתי לא שומרת ולא רואה פרטי תשלום.</div>
                {job.demo
                  ? <div className="faint">במצב דמו אין עגלה אמיתית להציג.</div>
                  : <button className="btn block" onClick={() => api.showCart().then((r) => ctx.toast(r.message)).catch((e) => ctx.toast((e as Error).message))}>הצג את העגלה בחלון שנפתח במחשב 🛒</button>}
                {job.cartUrl && !job.demo && !job.anonymous && <a className="btn ghost block" href={job.cartUrl} target="_blank" rel="noreferrer" style={{ textAlign: 'center', textDecoration: 'none' }}>פתח את האתר של {job.providerName} (העגלה בחשבון שלכם) ↗</a>}
                <button className="btn ghost" onClick={() => { onClose(); ctx.openConfirm(); }}>סיימתי להזמין — לאשר מה נקנה</button>
              </>
            ) : job.status === 'failed' || job.status === 'unsupported' ? (
              <>
                <h2>{job.status === 'unsupported' ? 'הכנת עגלה לא זמינה' : job.delivery?.deliveryStatus === 'unavailable' ? 'הרשת לא שולחת כרגע לכתובת הזו' : 'לא הצלחתי להכין את העגלה'}</h2>
                <div className="banner warn">{job.message}</div>
                {job.delivery && <div className="card stack"><DeliveryFacts d={job.delivery} fee={job.deliveryFee} feeEstimated={job.deliveryFeeEstimated} /></div>}
                {job.status === 'failed' && job.delivery?.deliveryStatus !== 'unavailable' && <button className="btn" onClick={() => { setJob(null); api.prepareCart(job.providerId, job.verifyOnly).then(setJob).catch((e) => setError((e as Error).message)); }}>לנסות שוב</button>}
              </>
            ) : (
              <>
                <h2>{job.verifyOnly ? `בודק משלוח ב${job.providerName}` : `מכין עגלה ב${job.providerName}`}</h2>
                <div className="stages">
                  <div className={job.status === 'starting' ? 'on' : 'done'}>פותח את האתר</div>
                  <div className={job.status === 'adding' ? 'on' : ''} style={job.status === 'adding' ? undefined : { opacity: 0.4 }}>{job.message}</div>
                </div>
              </>
            )}
          </>
        )}
        <button className="btn ghost" onClick={onClose}>סגור</button>
      </div>
    </>
  );
}
