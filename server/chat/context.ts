// Short conversational memory: what we were just talking about, so "למה בחרת דווקא בזה?" / "תוסיף אותו" /
// "תוסיף 2" work. Lives 30 minutes. The household state stays the source of truth — this is only a pointer.
import { kvGet, kvSet } from '../db.ts';
import { now } from '../clock.ts';

export type ChatContext = {
  focusNeedId?: string; // the product/need the last turn was about
  focusLabel?: string; // an unknown product the last turn was about (e.g. "חרדל")
  focusProviderId?: string;
  lastIntent?: string;
  at: string;
};

const TTL_MS = 30 * 60 * 1000;

export function loadContext(): ChatContext | null {
  const c = kvGet<ChatContext>('chatContext');
  if (!c) return null;
  return now().getTime() - new Date(c.at).getTime() > TTL_MS ? null : c;
}

export function saveContext(patch: Partial<ChatContext>) {
  const prev = loadContext() ?? { at: now().toISOString() };
  kvSet('chatContext', { ...prev, ...patch, at: now().toISOString() });
}
