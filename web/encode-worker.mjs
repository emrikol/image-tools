// encode-worker.mjs — runs the WASM encoders off the main thread so the UI never freezes.
// The main thread sends the decoded pixels once ('load'), then requests encodes ('encode');
// results are transferred back. jSquash accepts a plain {data,width,height} like ImageData.

import { encode as encodeWebp } from 'https://esm.sh/@jsquash/webp@1.5.0';
import { encode as encodeAvif } from 'https://esm.sh/@jsquash/avif@2.1.0';

let img = null; // { data, width, height } held across encodes for the current image

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'load') {
    img = { data: m.data, width: m.width, height: m.height };
    self.postMessage({ id: m.id, ok: true });
    return;
  }
  if (m.type === 'encode') {
    try {
      const ab =
        m.format === 'avif'
          ? await encodeAvif(img, { quality: m.quality, speed: m.speed })
          : await encodeWebp(img, { quality: m.quality });
      const u8 = new Uint8Array(ab);
      self.postMessage({ id: m.id, ok: true, buf: u8 }, [u8.buffer]);
    } catch (err) {
      self.postMessage({ id: m.id, ok: false, error: String((err && err.message) || err) });
    }
  }
};
