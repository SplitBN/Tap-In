// Rest-over alert. iOS web apps can't show a live lock-screen timer (Live Activities are native-only) and the
// per-minute cron is far too coarse for a 90 s rest, so each device gets a tiny Durable Object whose alarm fires
// at the exact second the rest ends and sends one push. The app schedules it only when it goes to the background
// with a rest running, and cancels it when it comes back, so the in-app timer and the push never both alert.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';
import { sendPush } from './reminders';

interface Pending { at: number; title: string; body: string; sub: { endpoint: string; p256dh: string; auth: string } }

export class RestAlarm extends DurableObject<Env> {
  async schedule(p: Pending) {
    await this.ctx.storage.put('pending', p);
    await this.ctx.storage.setAlarm(p.at);
  }

  async cancel() {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.delete('pending');
  }

  async alarm() {
    const p = await this.ctx.storage.get<Pending>('pending');
    await this.ctx.storage.delete('pending');
    if (!p || Date.now() - p.at > 60_000) return; // stale: a late "rest over" is worse than none
    // short TTL + high urgency: deliver now or not at all; same tag replaces an older rest alert
    await sendPush(this.env, p.sub, { title: p.title, body: p.body, url: './#/', tag: 'rest' }, { ttl: 60, urgency: 'high' });
  }
}
