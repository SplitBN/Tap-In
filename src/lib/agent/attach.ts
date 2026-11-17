// Attachments for the agent (contract v2): images downscaled, PDFs as files (≤ 10 MB), text-like files inlined
// (≤ 30k chars), videos as video (≤ 20 MB) when the provider supports it, else ~6 frames as images.
import { downscaleImage } from './image';
import type { AIPart } from './types';

const MB = 1024 * 1024;
const TEXT_MAX = 30_000;
const TEXT_RE = /^(text\/|application\/(json|csv|xml|x-ndjson))|\.(txt|csv|tsv|json|md|markdown|xml|log)$/i;

export class AttachError extends Error {}

const b64 = (file: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => { const s = String(r.result); resolve(s.slice(s.indexOf(',') + 1)); };
  r.onerror = () => reject(new AttachError('Couldn’t read that file.'));
  r.readAsDataURL(file);
});

/** One picked file → the parts to send. `video` = the chat's provider takes video directly. */
export async function fileToParts(file: File, opts: { video: boolean }): Promise<AIPart[]> {
  const type = file.type || '';
  if (type.startsWith('image/')) return [await downscaleImage(file)];
  if (type.startsWith('video/')) {
    if (opts.video) {
      if (file.size > 20 * MB) throw new AttachError('Videos can be up to 20 MB. Trim it and try again.');
      return [{ type: 'video', mime: type, base64: await b64(file) }];
    }
    const frames = await videoFrames(file, 6);
    return [{ type: 'text', text: `[Video "${file.name}": this model can't watch video, so here are ${frames.length} frames evenly spread through it.]` }, ...frames];
  }
  if (type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    if (file.size > 10 * MB) throw new AttachError('PDFs can be up to 10 MB.');
    return [{ type: 'file', mime: 'application/pdf', name: file.name, base64: await b64(file) }];
  }
  if (TEXT_RE.test(type) || TEXT_RE.test(file.name)) {
    if (file.size > 5 * MB) throw new AttachError('That file is too big to read here (5 MB max).');
    const text = await file.text();
    const cut = text.length > TEXT_MAX;
    return [{ type: 'text', text: `[File "${file.name}"${cut ? `, first ${TEXT_MAX} of ${text.length} characters` : ''}]\n${text.slice(0, TEXT_MAX)}` }];
  }
  throw new AttachError('Photos, videos, PDFs and text files (CSV, JSON, TXT, MD) work here.');
}

/** ~n frames spread through a video, as ≤1024 px JPEG images. */
export async function videoFrames(file: File, n: number): Promise<Extract<AIPart, { type: 'image' }>[]> {
  const url = URL.createObjectURL(file);
  try {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    await new Promise<void>((res, rej) => { v.onloadedmetadata = () => res(); v.onerror = () => rej(new AttachError('Couldn’t open that video.')); setTimeout(() => rej(new AttachError('Couldn’t open that video.')), 10_000); });
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 1;
    const out: Extract<AIPart, { type: 'image' }>[] = [];
    for (let i = 0; i < n; i++) {
      v.currentTime = Math.min(dur - 0.05, (dur * (i + 0.5)) / n);
      await new Promise<void>((res) => { const t = setTimeout(res, 3000); v.onseeked = () => { clearTimeout(t); res(); }; });
      const scale = Math.min(1, 1024 / Math.max(v.videoWidth || 1, v.videoHeight || 1));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round((v.videoWidth || 640) * scale)); c.height = Math.max(1, Math.round((v.videoHeight || 360) * scale));
      c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
      const d = c.toDataURL('image/jpeg', 0.8);
      out.push({ type: 'image', mime: 'image/jpeg', base64: d.slice(d.indexOf(',') + 1) });
    }
    return out;
  } finally { URL.revokeObjectURL(url); }
}
