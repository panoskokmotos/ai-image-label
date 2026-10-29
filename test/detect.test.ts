import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { detectAiLabel } from '../src/index.ts';

const enc = new TextEncoder();
const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(parts.flatMap(p => (typeof p === 'string' ? [...enc.encode(p)] : p)));
const cborText = (s: string) => {
  const b = [...enc.encode(s)];
  return b.length < 24 ? [0x60 + b.length, ...b] : [0x78, b.length, ...b];
};
const xmp = (code: string) =>
  bytes(`<x:xmpmeta><rdf:Description Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/${code}"/></x:xmpmeta>`);

function png(chunks: [string, number[]][]) {
  const out = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (const [type, data] of [...chunks, ['IEND', []] as [string, number[]]]) {
    const n = data.length;
    out.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255, ...enc.encode(type), ...data, 0, 0, 0, 0);
  }
  return new Uint8Array(out);
}

test('IPTC trainedAlgorithmicMedia in XMP is ai-generated', () => {
  const r = detectAiLabel(xmp('trainedAlgorithmicMedia'));
  assert.equal(r.verdict, 'ai-generated');
  assert.deepEqual(r.digitalSourceTypes, ['trainedAlgorithmicMedia']);
  assert.equal(r.signals[0].source, 'iptc');
  assert.equal(r.c2pa.present, false);
});

test('compositeWithTrainedAlgorithmicMedia is ai-edited, not ai-generated', () => {
  assert.equal(detectAiLabel(xmp('compositeWithTrainedAlgorithmicMedia')).verdict, 'ai-edited');
});

test('algorithmicMedia is synthetic, and is not matched inside trainedAlgorithmicMedia', () => {
  assert.equal(detectAiLabel(xmp('algorithmicMedia')).verdict, 'synthetic');
  assert.deepEqual(detectAiLabel(xmp('trainedAlgorithmicMedia')).digitalSourceTypes, ['trainedAlgorithmicMedia']);
});

test('a camera source type carries no AI label', () => {
  const r = detectAiLabel(xmp('digitalCapture'));
  assert.equal(r.verdict, 'none');
  assert.deepEqual(r.signals, []);
});

test('C2PA manifest: actions, claim generator and created-by description', () => {
  const r = detectAiLabel(
    bytes(
      'jumbc2pa', 'c2pa.claim.v2', 'claim_generator_info', [0xa2], cborText('name'), cborText('Example C2PA Library'),
      'c2pa.actions.v2', cborText('c2pa.created'), cborText('description'), cborText('Created by Example Generative AI.'),
      'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia', 'c2pa.edited', 'c2pa.signature',
    ),
  );
  assert.equal(r.verdict, 'ai-generated');
  assert.equal(r.c2pa.present, true);
  assert.equal(r.c2pa.claimGenerator, 'Example C2PA Library');
  assert.equal(r.c2pa.createdBy, 'Created by Example Generative AI.');
  assert.deepEqual(r.c2pa.actions, ['c2pa.created', 'c2pa.edited']);
  assert.equal(r.signals[0].source, 'c2pa');
});

test('C2PA manifest without an AI source type is present but not labelled AI', () => {
  const r = detectAiLabel(bytes('jumbc2pa', 'c2pa.claim', 'c2pa.opened', 'c2pa.signature'));
  assert.equal(r.c2pa.present, true);
  assert.equal(r.verdict, 'none');
});

test('Stable Diffusion parameters in a PNG tEXt chunk', () => {
  const r = detectAiLabel(png([['tEXt', [...enc.encode('parameters'), 0, ...enc.encode('a cat\nSteps: 20, Sampler: Euler a, CFG scale: 7')]]]));
  assert.equal(r.verdict, 'ai-generated');
  assert.equal(r.signals[0].source, 'stable-diffusion');
  assert.equal(r.signals[0].strength, 'medium');
});

test('ComfyUI prompt in a PNG iTXt chunk', () => {
  const data = [...enc.encode('prompt'), 0, 0, 0, 0, 0, ...enc.encode('{"3":{"class_type":"KSampler"}}')];
  assert.equal(detectAiLabel(png([['iTXt', data]])).signals[0].source, 'comfyui');
});

test('an image with no metadata has no label', () => {
  const r = detectAiLabel(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...enc.encode('JFIF'), 0xff, 0xd9]));
  assert.equal(r.verdict, 'none');
  assert.equal(r.c2pa.present, false);
});

test('accepts an ArrayBuffer', () => {
  assert.equal(detectAiLabel(xmp('trainedAlgorithmicMedia').buffer as ArrayBuffer).verdict, 'ai-generated');
});

// Optional: real files kept out of git. Put labelled AI images in test/fixtures/local/ai/ and
// metadata-stripped copies in test/fixtures/local/stripped/.
const local = 'test/fixtures/local';
for (const [dir, expected] of [['ai', 'ai-generated'], ['stripped', 'none']] as const) {
  const path = `${local}/${dir}`;
  if (!existsSync(path)) continue;
  for (const file of readdirSync(path)) {
    test(`local ${dir}/${file} is ${expected}`, () => {
      const r = detectAiLabel(readFileSync(`${path}/${file}`));
      assert.equal(r.verdict, expected);
      if (expected === 'ai-generated' && r.c2pa.present) assert.ok(r.c2pa.actions.length > 0, 'C2PA actions read');
    });
  }
}
