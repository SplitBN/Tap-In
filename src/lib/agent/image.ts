// Photos for the agent: downscaled to fit 1024 px, re-encoded as JPEG (also strips EXIF/location).
import type { AIPart } from './types';

export async function downscaleImage(file: File, max = 1024, quality = 0.82): Promise<Extract<AIPart, { type: 'image' }>> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions).catch(() => createImageBitmap(file));
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); // transparent PNGs → white, not black
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const url = canvas.toDataURL('image/jpeg', quality);
  return { type: 'image', mime: 'image/jpeg', base64: url.slice(url.indexOf(',') + 1) };
}
