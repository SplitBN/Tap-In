// Renders PNG app icons from public/icon.svg. Usage: node scripts/icons.mjs
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
const svg = readFileSync('public/icon.svg');
const render = (s) => sharp(svg, { density: 384 }).resize(s, s).png();
await render(192).toFile('public/icon-192.png');
await render(512).toFile('public/icon-512.png');
// iOS and maskable icons want a full-bleed square (the OS rounds corners); maskable gets a 20% safe zone.
for (const [s, out, pad] of [[180, 'apple-touch-icon.png', 0], [512, 'icon-maskable-512.png', 0.2]]) {
  const inner = await render(Math.round(s * (1 - pad))).toBuffer();
  await sharp({ create: { width: s, height: s, channels: 4, background: '#0b0c0f' } })
    .composite([{ input: inner, gravity: 'center' }]).png().toFile('public/' + out);
}
console.log('icons done');
