/**
 * Text-to-Speech proxy for TANAW.
 *
 * The browser's speechSynthesis API can read a page aloud but cannot save the
 * audio. This endpoint turns the page text into an MP3 (via Google Translate's
 * TTS voice, which supports Filipino) so the narration can be downloaded.
 *
 * POST /api/tts  { "text": "...", "lang": "fil" }  ->  audio/mpeg
 */

const MAX_CHARS = 5000;
const CHUNK_CHARS = 190;
const CONCURRENCY = 5;
const MAX_CHUNKS = 30;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TTS_HOSTS = [
  'https://translate.google.com/translate_tts',
  'https://translate.googleapis.com/translate_tts'
];

function splitText(text, max) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];

  const sentences = clean.match(/[^.!?…]+[.!?…]+["”’']?|[^.!?…]+$/g) || [clean];
  const chunks = [];
  let cur = '';

  for (const raw of sentences) {
    let sentence = raw.trim();
    if (!sentence) continue;

    // A single sentence can be longer than the upstream limit: split on spaces.
    while (sentence.length > max) {
      if (cur) {
        chunks.push(cur);
        cur = '';
      }
      let cut = sentence.lastIndexOf(' ', max);
      if (cut < max * 0.5) cut = max;
      chunks.push(sentence.slice(0, cut).trim());
      sentence = sentence.slice(cut).trim();
    }
    if (!sentence) continue;

    if (cur && (cur + ' ' + sentence).length > max) {
      chunks.push(cur);
      cur = sentence;
    } else {
      cur = cur ? cur + ' ' + sentence : sentence;
    }
  }

  if (cur) chunks.push(cur);
  return chunks;
}

async function fetchChunk(text, lang) {
  const query = '?ie=UTF-8&client=tw-ob&tl=' + encodeURIComponent(lang) +
    '&q=' + encodeURIComponent(text);

  let lastError = null;
  for (const host of TTS_HOSTS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(host + query, {
          headers: {
            'User-Agent': UA,
            'Referer': 'https://translate.google.com/',
            'Accept': 'audio/mpeg,*/*'
          }
        });
        if (response.ok) {
          const buffer = Buffer.from(await response.arrayBuffer());
          // Guard against HTML error pages being saved as .mp3.
          if (buffer.length > 2 && buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0) return buffer;
          lastError = new Error('Unexpected audio response');
        } else {
          lastError = new Error('Upstream HTTP ' + response.status);
        }
      } catch (error) {
        lastError = error;
      }
      // Small backoff before retrying.
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError || new Error('TTS request failed');
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  const parts = [];
  for await (const part of req) parts.push(part);
  if (!parts.length) return {};
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch (e) { return {}; }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  let payload = {};
  try {
    payload = await readJsonBody(req);
  } catch (e) {
    payload = {};
  }

  const text = String(payload.text || '').replace(/\s+/g, ' ').trim();
  const lang = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(String(payload.lang || '')) ? String(payload.lang) : 'fil';

  if (!text) {
    res.status(400).json({ error: 'Missing text.' });
    return;
  }
  if (text.length > MAX_CHARS) {
    res.status(413).json({ error: 'Text too long. Maximum is ' + MAX_CHARS + ' characters.' });
    return;
  }

  const chunks = splitText(text, CHUNK_CHARS).slice(0, MAX_CHUNKS);
  if (!chunks.length) {
    res.status(400).json({ error: 'No readable text.' });
    return;
  }

  try {
    const buffers = [];
    for (let i = 0; i < chunks.length; i += CONCURRENCY) {
      const batch = chunks.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(chunk => fetchChunk(chunk, lang)));
      buffers.push(...results);
    }

    const audio = Buffer.concat(buffers);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audio.length);
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
    res.status(200).send(audio);
  } catch (error) {
    res.status(502).json({ error: 'Hindi magawa ang audio sa ngayon. Subukan muli mamaya.' });
  }
};
