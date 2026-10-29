export type Verdict = 'ai-generated' | 'ai-edited' | 'synthetic' | 'none';

export type Signal = {
  source: 'iptc' | 'c2pa' | 'stable-diffusion' | 'comfyui' | 'invokeai';
  strength: 'strong' | 'medium';
  detail: string;
};

export type AiLabelResult = {
  /** Strongest label found. `none` means no label, not that the image is authentic. */
  verdict: Verdict;
  signals: Signal[];
  /** IPTC digital source type codes found anywhere in the file, e.g. `trainedAlgorithmicMedia`. */
  digitalSourceTypes: string[];
  c2pa: {
    present: boolean;
    /** C2PA actions recorded in the manifest, e.g. `c2pa.created`, `c2pa.edited`. */
    actions: string[];
    /** `claim_generator_info.name` or `claim_generator`, the tool that wrote the manifest. */
    claimGenerator: string | null;
    /** Description of the `c2pa.created` action, e.g. "Created by Google Generative AI." */
    createdBy: string | null;
  };
};

// IPTC NewsCodes digital source type vocabulary: https://cv.iptc.org/newscodes/digitalsourcetype/
const GENERATED = ['trainedAlgorithmicMedia'];
const EDITED = ['compositeWithTrainedAlgorithmicMedia'];
const SYNTHETIC = ['algorithmicMedia', 'compositeSynthetic'];
// The whole vocabulary, so a code is matched exactly even when a CBOR header letter follows it.
const VOCABULARY = [
  ...GENERATED, ...EDITED, ...SYNTHETIC, 'digitalCapture', 'computationalCapture', 'negativeFilm', 'positiveFilm',
  'print', 'humanEdits', 'minorHumanEdits', 'compositeCapture', 'algorithmicallyEnhanced', 'dataDrivenMedia',
  'digitalArt', 'digitalCreation', 'virtualRecording', 'screenCapture',
].sort((a, b) => b.length - a.length);
const SOURCE_TYPE = new RegExp(`newscodes/digitalsourcetype/(${VOCABULARY.join('|')})`, 'g');

const C2PA_ACTIONS = [
  'created', 'edited', 'opened', 'placed', 'converted', 'cropped', 'filtered', 'color_adjustments',
  'resized', 'transcoded', 'drawing', 'published', 'removed', 'repackaged', 'watermarked', 'unknown',
];

const C2PA_ACTION = new RegExp(`c2pa\\.(${[...C2PA_ACTIONS].sort((a, b) => b.length - a.length).join('|')})`, 'g');

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function detectAiLabel(input: Uint8Array | ArrayBuffer): AiLabelResult {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const text = new TextDecoder('latin1').decode(bytes);

  const digitalSourceTypes = unique(
    [...text.matchAll(SOURCE_TYPE)].map(m => m[1]),
  );
  const c2pa = readC2pa(bytes, text);
  const signals: Signal[] = [];

  for (const code of digitalSourceTypes) {
    if (![...GENERATED, ...EDITED, ...SYNTHETIC].includes(code)) continue;
    signals.push({
      source: c2pa.present ? 'c2pa' : 'iptc',
      strength: 'strong',
      detail: `digital source type ${code}`,
    });
  }

  const pngText = isPng(bytes) ? readPngText(bytes) : {};
  if (/Steps: \d+, Sampler: /.test(pngText.parameters ?? '') || /Steps: \d+, Sampler: /.test(text)) {
    signals.push({ source: 'stable-diffusion', strength: 'medium', detail: 'generation parameters (Steps, Sampler) in metadata' });
  }
  if (/"class_type"/.test(pngText.prompt ?? '') || /"nodes"/.test(pngText.workflow ?? '')) {
    signals.push({ source: 'comfyui', strength: 'medium', detail: 'ComfyUI prompt or workflow in PNG text chunk' });
  }
  if (pngText.invokeai_metadata) {
    signals.push({ source: 'invokeai', strength: 'medium', detail: 'InvokeAI metadata in PNG text chunk' });
  }

  return { verdict: verdictFor(digitalSourceTypes, signals), signals, digitalSourceTypes, c2pa };
}

function verdictFor(codes: string[], signals: Signal[]): Verdict {
  if (codes.some(c => GENERATED.includes(c))) return 'ai-generated';
  if (codes.some(c => EDITED.includes(c))) return 'ai-edited';
  if (codes.some(c => SYNTHETIC.includes(c))) return 'synthetic';
  if (signals.some(s => s.strength === 'medium')) return 'ai-generated';
  return 'none';
}

function readC2pa(bytes: Uint8Array, text: string): AiLabelResult['c2pa'] {
  const present = /c2pa\.(claim|signature)/.test(text);
  if (!present) return { present, actions: [], claimGenerator: null, createdBy: null };
  const actions = unique([...text.matchAll(C2PA_ACTION)].map(m => `c2pa.${m[1]}`));
  const infoAt = indexOf(bytes, ascii('claim_generator_info'));
  const claimGenerator =
    (infoAt >= 0 ? cborTextAfterKey(bytes, 'name', infoAt) : null) ?? cborTextAfterKey(bytes, 'claim_generator', 0, Infinity);
  const createdAt = indexOf(bytes, ascii('c2pa.created'));
  const createdBy = createdAt >= 0 ? cborTextAfterKey(bytes, 'description', createdAt) : null;
  return { present, actions, claimGenerator, createdBy };
}

/** Finds the CBOR text key `key` within `maxDistance` bytes of `from` and decodes the text string that follows it. */
function cborTextAfterKey(bytes: Uint8Array, key: string, from: number, maxDistance = 512): string | null {
  const keyBytes = ascii(key);
  const header = cborTextHeader(keyBytes.length);
  const at = indexOf(bytes, [...header, ...keyBytes], from);
  if (at < 0 || at - from > maxDistance) return null;
  return cborText(bytes, at + header.length + keyBytes.length);
}

function cborTextHeader(length: number): number[] {
  if (length < 24) return [0x60 + length];
  return [0x78, length];
}

function cborText(bytes: Uint8Array, at: number): string | null {
  const head = bytes[at];
  let length: number;
  let start: number;
  if (head >= 0x60 && head <= 0x77) [length, start] = [head - 0x60, at + 1];
  else if (head === 0x78) [length, start] = [bytes[at + 1], at + 2];
  else if (head === 0x79) [length, start] = [(bytes[at + 1] << 8) | bytes[at + 2], at + 3];
  else return null;
  if (start + length > bytes.length) return null;
  return new TextDecoder().decode(bytes.subarray(start, start + length));
}

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

/** Uncompressed tEXt and iTXt chunks, keyword to text. */
function readPngText(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const latin1 = new TextDecoder('latin1');
  const utf8 = new TextDecoder();
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at);
    const type = latin1.decode(bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'tEXt') {
      const nul = data.indexOf(0);
      if (nul > 0) out[latin1.decode(data.subarray(0, nul))] = latin1.decode(data.subarray(nul + 1));
    } else if (type === 'iTXt') {
      const nul = data.indexOf(0);
      const compressed = data[nul + 1] === 1;
      if (nul > 0 && !compressed) {
        let p = nul + 3;
        p = data.indexOf(0, p) + 1;
        p = data.indexOf(0, p) + 1;
        if (p > 0) out[latin1.decode(data.subarray(0, nul))] = utf8.decode(data.subarray(p));
      }
    } else if (type === 'IEND') break;
    at += 12 + length;
  }
  return out;
}

function ascii(s: string): number[] {
  return [...s].map(c => c.charCodeAt(0));
}

function indexOf(bytes: Uint8Array, needle: number[], from = 0): number {
  outer: for (let i = from; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
