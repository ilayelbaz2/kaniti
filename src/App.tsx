import { useCallback, useEffect, useState } from 'react';
import type { AppState, ChatMessage } from '../shared/types.ts';
import { api } from './api.ts';
import { Onboarding } from './screens/Onboarding.tsx';
import { Chat } from './screens/Chat.tsx';
import { BasketScreen } from './screens/Basket.tsx';
import { Deals } from './screens/Deals.tsx';
import { Compare } from './screens/Compare.tsx';
import { HouseholdScreen } from './screens/Household.tsx';
import { ConfirmSheet } from './screens/Confirm.tsx';
import { CartSheet } from './screens/CartSheet.tsx';

export type Tab = 'chat' | 'basket' | 'deals' | 'compare' | 'home';
const TABS: { id: Tab; label: string; ico: string }[] = [
  { id: 'chat', label: 'צ׳אט', ico: '💬' },
  { id: 'basket', label: 'סל', ico: '🧺' },
  { id: 'deals', label: 'מבצעים', ico: '🔥' },
  { id: 'compare', label: 'השוואה', ico: '⚖️' },
  { id: 'home', label: 'הבית', ico: '🏠' },
];

export type Ctx = {
  state: AppState;
  setState: (s: AppState) => void;
  refresh: () => Promise<void>;
  go: (t: Tab) => void;
  openConfirm: () => void;
  openCart: (providerId?: string, verifyOnly?: boolean) => void;
  toast: (t: string) => void;
  sendChat: (text: string, label?: string) => Promise<void>;
  messages: ChatMessage[];
  busy: boolean;
};

const tabFromHash = (): Tab => (TABS.some((t) => '#' + t.id === location.hash) ? (location.hash.slice(1) as Tab) : 'chat');

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(tabFromHash());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cartFor, setCartFor] = useState<{ providerId?: string; verifyOnly?: boolean } | null>(null);
  const [toastText, setToastText] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try { setState(await api.state()); setError(null); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (state?.household?.onboardedAt) api.chatHistory().then(setMessages).catch(() => {}); }, [state?.household?.onboardedAt]);
  useEffect(() => {
    const on = () => setTab(tabFromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const go = (t: Tab) => { location.hash = t; setTab(t); window.scrollTo(0, 0); };
  const toast = (t: string) => { setToastText(t); setTimeout(() => setToastText(null), 2600); };

  const sendChat = async (text: string, label?: string) => {
    if (text.startsWith('@open:')) {
      const target = text.slice(6);
      if (target === 'confirm') setConfirmOpen(true);
      else if (target.startsWith('cart')) setCartFor({ providerId: target.split(':')[1] || undefined });
      else go(target as Tab);
      return;
    }
    const temp: ChatMessage = { id: 'tmp' + Date.now(), role: 'user', text: label ?? text, createdAt: new Date().toISOString() };
    setMessages((m) => [...m, temp]);
    setBusy(true);
    try {
      const r = await api.chat(text, label);
      setMessages((m) => [...m.filter((x) => x.id !== temp.id), ...r.messages]);
      setState(r.state);
    } catch (e) {
      setMessages((m) => [...m, { id: 'err' + Date.now(), role: 'assistant', text: `אופס, משהו נתקע: ${(e as Error).message}`, createdAt: new Date().toISOString() }]);
    } finally {
      setBusy(false);
    }
  };

  if (error && !state) return <div className="empty"><div className="emo">🔌</div><div>לא מצליח להתחבר לשרת.</div><button className="btn" onClick={refresh}>לנסות שוב</button></div>;
  if (!state) return <div className="screen stack"><div className="skeleton" /><div className="skeleton" /></div>;
  if (!state.household?.onboardedAt) return <Onboarding onDone={(s) => { setState(s); go('chat'); }} />;

  const ctx: Ctx = { state, setState, refresh, go, openConfirm: () => setConfirmOpen(true), openCart: (providerId?: string, verifyOnly?: boolean) => setCartFor({ providerId, verifyOnly }), toast, sendChat, messages, busy };
  const count = state.basket?.status === 'building' ? state.basket.items.filter((i) => i.accepted && i.condition?.met !== false).length : 0;

  return (
    <div className="app">
      {tab === 'chat' && <Chat ctx={ctx} />}
      {tab === 'basket' && <BasketScreen ctx={ctx} />}
      {tab === 'deals' && <Deals ctx={ctx} />}
      {tab === 'compare' && <Compare ctx={ctx} />}
      {tab === 'home' && <HouseholdScreen ctx={ctx} />}
      <nav className="nav">
        <div className="nav-inner">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => go(t.id)} aria-label={t.label}>
              <span className="ico">{t.ico}</span>
              {t.label}
              {t.id === 'basket' && count > 0 && <span className="badge">{count}</span>}
            </button>
          ))}
        </div>
      </nav>
      {confirmOpen && <ConfirmSheet ctx={ctx} onClose={() => setConfirmOpen(false)} />}
      {cartFor && <CartSheet ctx={ctx} providerId={cartFor.providerId} verifyOnly={cartFor.verifyOnly} onClose={() => { setCartFor(null); void refresh(); }} />}
      {toastText && <div className="toast">{toastText}</div>}
    </div>
  );
}
