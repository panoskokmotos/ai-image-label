# ai-image-label

Detect AI-generation labels in image files. Zero dependencies. Works in Node and the browser.

Google, OpenAI, Adobe and others write a label into the images their AI tools make: an [IPTC digital source type](https://cv.iptc.org/newscodes/digitalsourcetype/) and often a [C2PA](https://c2pa.org) manifest (Content Credentials). Stable Diffusion and ComfyUI write their generation settings into the file. This library reads all of these in a few milliseconds, without a network call.

```bash
npm install ai-image-label
```

```js
import { detectAiLabel } from 'ai-image-label';
import { readFile } from 'node:fs/promises';

const result = detectAiLabel(await readFile('photo.jpg'));
// result.verdict: 'ai-generated' | 'ai-edited' | 'synthetic' | 'none'
```

In the browser, pass the bytes of a `File`:

```js
const result = detectAiLabel(await file.arrayBuffer());
```

## What you get

For an image made with Google Gemini:

```json
{
  "verdict": "ai-generated",
  "signals": [{ "source": "c2pa", "strength": "strong", "detail": "digital source type trainedAlgorithmicMedia" }],
  "digitalSourceTypes": ["trainedAlgorithmicMedia"],
  "c2pa": {
    "present": true,
    "actions": ["c2pa.created", "c2pa.edited"],
    "claimGenerator": "Google C2PA Core Generator Library",
    "createdBy": "Created by Google Generative AI."
  }
}
```

| Verdict | Meaning |
|---|---|
| `ai-generated` | Labelled `trainedAlgorithmicMedia`, or carries Stable Diffusion / ComfyUI / InvokeAI generation metadata |
| `ai-edited` | Labelled `compositeWithTrainedAlgorithmicMedia`: a real image edited with AI |
| `synthetic` | Labelled `algorithmicMedia` or `compositeSynthetic`: made by an algorithm, not a trained model |
| `none` | No AI label found. **This does not mean the image is real.** See the limits below |

Each signal has a `strength`. `strong` is a standard label (IPTC or C2PA). `medium` is tool metadata such as Stable Diffusion's `Steps: 20, Sampler: ...` text.

## What it checks

- IPTC digital source type, wherever it appears: XMP, or inside a C2PA manifest.
- C2PA manifest presence, its actions, the claim generator and the `c2pa.created` description.
- PNG `tEXt` and `iTXt` chunks: Stable Diffusion WebUI `parameters`, ComfyUI `prompt` / `workflow`, InvokeAI metadata.
- Stable Diffusion parameters embedded anywhere else (for example a JPEG comment).

## Limits

Read these before you rely on it.

- **It reads labels. It does not verify them.** C2PA signatures are not checked, so a label can be forged. To verify a manifest, use [c2pa-rs](https://github.com/contentauth/c2pa-rs) or the [c2pa npm package](https://github.com/contentauth/c2pa-js).
- **Labels are easy to remove.** A screenshot, a re-save in many editors, or sending through WhatsApp or most social networks strips them. Those images come back `none`.
- **Invisible watermarks are out of scope.** Google's SynthID lives in the pixels, not the metadata, and needs Google's own detector.
- **`none` is not proof of a real photo.** Treat it as "no label", and combine it with other checks.

## Tested on

- Unit tests with fixtures built in code for each format and verdict (`npm test`).
- 8 real images generated with Google Gemini in September 2026: all 8 return `ai-generated` with their C2PA actions and generator. Metadata-stripped copies of the same 8 all return `none`, as expected.
- Not yet tested on real files from ChatGPT / DALL-E, Adobe Firefly or Midjourney. If you have one, a pull request with the result is very welcome.

Real test images stay out of git. To run them locally, put labelled AI images in `test/fixtures/local/ai/` and stripped copies in `test/fixtures/local/stripped/`.

## Where it comes from

Extracted from [Verified Delivery Copilot](https://github.com/panoskokmotos/verified-delivery-copilot), which checks donation delivery photos for nonprofits. There, this check stops a labelled AI image before any model call is spent.

## License

MIT
