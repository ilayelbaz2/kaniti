import { useEffect, useRef, useState } from 'react';
import type { Ctx } from '../App.tsx';
import { ChatPart, nis } from '../components/ChatParts.tsx';

const STAGES = ['בודק מה כנראה חסר…', 'מחפש מבצעים רלוונטיים…', 'משווה רשתות ששולחות אליכם…'];
const QUICK = [
  { label: 'בנה קנייה', send: '#build 14' },
  { label: 'מה חסר בבית?', send: 'מה חסר בבית?' },
  { label: 'מבצעים', send: '#deals' },
  { label: 'איפה הכי זול?', send: '#compare' },
];

export function Chat({ ctx }: { ctx: Ctx }) {
  const { state, messages, busy, sendChat, go } = ctx;
  const [text, setText] = useState('');
  const [used, setUsed] = useState<Set<string>>(new Set());
  const [stage, setStage] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.text ?? '';
  const heavy = busy && /קנייה|#build|#compare|השווה|משתלם|תבנה|זול|מבצע|#deals/.test(lastUser);

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' }); }, [messages, busy]);
  useEffect(() => {
    if (!heavy) { setStage(0); return; }
    const t = setInterval(() => setStage((s) => Math.min(STAGES.length - 1, s + 1)), 1400);
    return () => clearInterval(t);
  }, [heavy]);

  const b = state.basket;
  const building = b?.status === 'building' && b.items.length > 0;
  const count = building ? b!.items.filter((i) => i.accepted && i.condition?.met !== false).length : 0;
  const total = building && b!.priced ? Math.round(b!.items.filter((i) => i.accepted && i.condition?.met !== false).reduce((s, i) => s + (i.product?.price ?? 0) * i.quantity, 0)) : null;
  const status = building
    ? `סל בבנייה · ${count} פריטים${total ? ` · ~${nis(total)}` : ''}`
    : state.nextShopInDays !== null && state.nextShopInDays <= 1 ? 'הגיע הזמן לקנייה' : `הקנייה הבאה בעוד ~${Math.max(1, state.nextShopInDays ?? 14)} ימים`;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setText('');
    void sendChat(t);
  };

  return (
    <div className="chat-screen">
      <div className="chat-head">
        <div><div className="faint">קנייה הבאה</div><div className="status">{status}</div></div>
        {building && <button className="basket-pill" onClick={() => go('basket')}>🧺 סל: {count}</button>}
      </div>
      {state.demoPrices && <div className="banner demo" style={{ borderRadius: 0 }}>מצב דמו — המחירים אינם אמיתיים</div>}
      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && (
          <div className="msg assistant"><div className="bubble">אני כבר יודע את הבסיס.{'\n'}רוצה שאנסה לבנות את הקנייה הראשונה שלכם?</div>
            <div className="comps"><div className="chips"><button className="chip quick" onClick={() => sendChat('#build 14', 'בנה קנייה')}>בנה קנייה</button><button className="chip quick" onClick={() => sendChat('#deals', 'קודם נראה מבצעים')}>קודם נראה מבצעים</button></div></div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.text && <div className="bubble">{m.text}</div>}
            {m.components && m.components.length > 0 && (
              <div className="comps">
                {m.components.map((c, i) => {
                  const key = `${m.id}:${i}`;
                  return <ChatPart key={key} c={c} send={sendChat} used={used.has(key)} markUsed={() => setUsed((s) => new Set(s).add(key))} />;
                })}
              </div>
            )}
          </div>
        ))}
        {busy && (
          <div className="msg assistant">
            {heavy
              ? <div className="bubble stages">{STAGES.map((s, i) => <div key={s} className={i < stage ? 'done' : i === stage ? 'on' : ''} style={i > stage ? { opacity: 0.4 } : undefined}>{s}</div>)}</div>
              : <div className="bubble typing"><span /><span /><span /></div>}
          </div>
        )}
      </div>
      <div className="chips scroll" style={{ padding: '4px 16px', margin: 0 }}>
        {QUICK.map((q) => <button key={q.label} className="chip" disabled={busy} onClick={() => sendChat(q.send, q.label)}>{q.label}</button>)}
      </div>
      <form className="composer" onSubmit={submit}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="כתוב… למשל: יש לנו 10 ביצים" aria-label="הודעה" />
        <button className="send" type="submit" disabled={!text.trim() || busy} aria-label="שלח">➤</button>
      </form>
    </div>
  );
}
