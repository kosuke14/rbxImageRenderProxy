'use strict';

const express = require('express');
const fs = require('fs/promises');
const sharp = require('sharp');
const nodeHtmlToImage = require('node-html-to-image');
const puppeteer = require('puppeteer');
const { fileTypeFromBuffer } = require('file-type');

const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();

/* ==============================
   設定
============================== */

const PORT = 3099;
const MAX_CONCURRENT = 4;              // 最大同時画像処理数
const MAX_IMAGE_PIXELS = 4_000_000;     // 4MP制限（DoS対策）

const SUPPORTED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/bmp',
  'image/tiff',
  'image/webp',
  'image/avif',
]);

/* ==============================
   並列制御（セマフォ）
============================== */

class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    await new Promise(resolve => this.queue.push(resolve));
    this.current++;
  }

  release() {
    this.current--;
    if (this.queue.length > 0) {
      this.queue.shift()();
    }
  }
}

const imageSemaphore = new Semaphore(MAX_CONCURRENT);

/* ==============================
   ユーティリティ
============================== */

async function fetchImageBuffer(src) {
  const res = await fetch(src).catch(() => null);
  if (!res || !res.ok) {
    throw new Error('Failed to fetch image');
  }
  return Buffer.from(await res.arrayBuffer());
}

async function normalizeImage(buffer) {
  const type = await fileTypeFromBuffer(buffer);
  if (!type) throw new Error('Unknown file type');

  if (!SUPPORTED_MIME.has(type.mime)) {
    throw new Error(`Unsupported mime type: ${type.mime}`);
  }

  return sharp(buffer, { failOnError: false })
    .ensureAlpha()
    .png()
    .toBuffer();
}

async function getImageMetadata(buffer) {
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) {
    throw new Error('Invalid image');
  }
  if (meta.width * meta.height > MAX_IMAGE_PIXELS) {
    throw new Error('Image too large');
  }
  return meta;
}

async function getImagePixels(buffer) {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;

  const colors = Array.from({ length: width }, () =>
    Array.from({ length: height })
  );

  let i = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      colors[x][y] = [
        data[i],
        data[i + 1],
        data[i + 2],
        data[i + 3],
      ];
      i += 4;
    }
  }

  return {
    size: [width, height],
    colors,
  };
}

function collectLinks() {
  const results = [];

  const isClickable = (el) => {
    if (el.tagName === 'A' && el.href) return true;
    if (el.tagName === 'AREA' && el.href) return true;
    if (el.tagName === 'BUTTON') return true;
    if (el.onclick) return true;
    if (el.getAttribute?.('role') === 'button') return true;
    const style = window.getComputedStyle(el);
    return style.cursor === 'pointer';
  };

  const collectFromDocument = (doc, offsetX, offsetY) => {
    // 通常要素
    for (const el of doc.querySelectorAll('*')) {
      if (!isClickable(el)) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      results.push({
        tag: el.tagName.toLowerCase(),
        href: el.href ?? null,
        x: rect.left + offsetX,
        y: rect.top + offsetY,
        width: rect.width,
        height: rect.height,
      });
    }

    // iframe / frame
    for (const frameEl of doc.querySelectorAll('iframe, frame')) {
      try {
        const r = frameEl.getBoundingClientRect();
        const ox = offsetX + r.left;
        const oy = offsetY + r.top;

        const childDoc = frameEl.contentDocument;
        if (childDoc) {
          collectFromDocument(childDoc, ox, oy);
        } else if (frameEl.src) {
          // cross-origin fallback
          results.push({
            tag: 'frame',
            href: frameEl.src,
            x: ox,
            y: oy,
            width: r.width,
            height: r.height,
          });
        }
      } catch {
        /* cross-origin */
      }
    }

    // frameset
    const fs = doc.querySelector('frameset');
    if (fs) {
      const rect = {
        x: offsetX,
        y: offsetY,
        width: window.innerWidth,
        height: window.innerHeight,
      };

      const parse = (v) => v.split(',').map(s => s.trim());
      const resolve = (defs, total) => {
        let fixed = 0, stars = 0;
        const parsed = defs.map(d => {
          if (d.endsWith('%')) return { t: '%', v: parseFloat(d) };
          if (d === '*') return { t: '*', v: 1 };
          if (/^\d+$/.test(d)) return { t: 'px', v: +d };
          return { t: '*', v: 1 };
        });

        for (const p of parsed) {
          if (p.t === 'px') fixed += p.v;
          if (p.t === '%') fixed += total * p.v / 100;
          if (p.t === '*') stars += p.v;
        }

        const remain = Math.max(0, total - fixed);
        return parsed.map(p =>
          p.t === 'px' ? p.v :
          p.t === '%' ? total * p.v / 100 :
          remain * p.v / stars
        );
      };

      const children = Array.from(fs.children);
      if (fs.cols) {
        let x = rect.x;
        const widths = resolve(parse(fs.cols), rect.width);
        children.forEach((frame, i) => {
          try {
            collectFromDocument(
              frame.contentDocument,
              x,
              rect.y
            );
          } catch {
            if (frame.src) {
              results.push({
                tag: 'frame',
                href: frame.src,
                x,
                y: rect.y,
                width: widths[i],
                height: rect.height,
              });
            }
          }
          x += widths[i];
        });
      }

      if (fs.rows) {
        let y = rect.y;
        const heights = resolve(parse(fs.rows), rect.height);
        children.forEach((frame, i) => {
          try {
            collectFromDocument(
              frame.contentDocument,
              rect.x,
              y
            );
          } catch {
            if (frame.src) {
              results.push({
                tag: 'frame',
                href: frame.src,
                x: rect.x,
                y,
                width: rect.width,
                height: heights[i],
              });
            }
          }
          y += heights[i];
        });
      }
    }
  };

  collectFromDocument(document, window.scrollX, window.scrollY);
  return results;
}

function validateHttpSrc(src) {
  const u = new URL(src);

  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new Error('Invalid protocol');
  }

  // private / metadata IP block
  if (
    /^127\.|^10\.|^192\.168\.|^169\.254\./.test(u.hostname) ||
    u.hostname === 'localhost'
  ) {
    throw new Error('Forbidden host');
  }

  return u;
}

async function renderHtmlUrlToImage(src) {
  validateHttpSrc(src);

  const browser = await puppeteer.launch({
    executablePath: '/snap/bin/chromium',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  try {
    const page = await browser.newPage();

    await page.setViewport({
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
    });

    await page.goto(src, {
      waitUntil: 'networkidle0', // JS/CSS/画像が全部来るまで待つ
      timeout: 15_000,
    });

    const buffer = await page.screenshot({
      type: 'png',
      fullPage: true,
    });

    return buffer;
  } finally {
    await browser.close();
  }
}

async function renderHtmlUrlToImageWithLinks(src) {
  validateHttpSrc(src);

  const browser = await puppeteer.launch({
    executablePath: '/snap/bin/chromium',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  try {
    const page = await browser.newPage();

    await page.setViewport({
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
    });

    await page.goto(src, {
      waitUntil: 'networkidle0',
      timeout: 15_000,
    });

    // 🔽 リンク情報を先に取得
    const links = await page.evaluate(collectLinks);

    // 🔽 画像化
    const image = await page.screenshot({
      type: 'png',
      fullPage: true,
    });

    return { image, links };
  } finally {
    await browser.close();
  }
}

const isUrl = (s) => { try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; } };

async function renderHtmlFromSrc(src) {
    if (!isUrl(src)) {
      throw new Error('src must be a URL');
    }
    return await renderHtmlUrlToImage(src);
}

async function normalizeHtmlImage(buffer) {
  return sharp(buffer, { failOnError: false })
    .ensureAlpha()
    .png()
    .toBuffer();
}

/* ==============================
   ルート
============================== */

app.get('/', (_, res) => {
  res.type('html').send(`
    <h3>Welcome to Image Grabber for Roblox!</h3>
    <ul>
      <li><a href="/help">/help</a></li>
      <li><a href="/docs">/docs</a></li>
    </ul>
  `);
});

app.get('/ping', (_, res) => {
  res.json({ ok: true });
});

app.get('/docs', async (_, res) => {
  try {
    const file = await fs.readFile('docs.json', 'utf8');
    res.type('json').send(file);
  } catch {
    res.status(500).json({ error: 'Failed to read docs' });
  }
});

app.get('/help', async (_, res) => {
  try {
    const file = await fs.readFile('help.html', 'utf8');
    res.type('html').send(file);
  } catch {
    res.status(500).send('Failed to read help');
  }
});

/* ==============================
   画像API
============================== */

app.get('/image', async (req, res) => {
  const src = req.query.src ?? 'example.png';

  await imageSemaphore.acquire();
  try {
    const raw = await fetchImageBuffer(src);
    const buffer = await normalizeImage(raw);
    const meta = await getImageMetadata(buffer);
    const { size, colors } = await getImagePixels(buffer);

    res.json({
      success: true,
      size,
      colors,
    });
  } catch (e) {
    res.status(400).json({
      success: false,
      message: e.message,
    });
  } finally {
    imageSemaphore.release();
  }
});

app.get('/image/size', async (req, res) => {
  const src = req.query.src ?? 'example.png';

  await imageSemaphore.acquire();
  try {
    const raw = await fetchImageBuffer(src);
    const buffer = await normalizeImage(raw);
    const meta = await getImageMetadata(buffer);

    res.json({
      success: true,
      size: [meta.width, meta.height],
    });
  } catch (e) {
    res.status(400).json({
      success: false,
      message: e.message,
    });
  } finally {
    imageSemaphore.release();
  }
});

app.get('/image/converttopng', async (req, res) => {
  const src = req.query.src ?? 'example.png';

  await imageSemaphore.acquire();
  try {
    const raw = await fetchImageBuffer(src);
    const buffer = await normalizeImage(raw);

    res.type('png').send(buffer);
  } catch {
    res.status(400).send('Invalid image');
  } finally {
    imageSemaphore.release();
  }
});

app.get('/html', async (req, res) => {
  const src = req.query.src;

  if (!src) {
    return res.status(400).json({
      success: false,
      message: 'Missing src parameter',
    });
  }

  await imageSemaphore.acquire();
  try {
    const { image, links } = await renderHtmlUrlToImageWithLinks(src);
    const buffer = await normalizeHtmlImage(image);
    await getImageMetadata(buffer); // サイズ制限チェック
    const { size, colors } = await getImagePixels(buffer);

    res.json({
      success: true,
      size,
      colors,
      links,
    });
  } catch (e) {
    res.status(400).json({
      success: false,
      message: e.message,
    });
  } finally {
    imageSemaphore.release();
  }
});

app.get('/html/size', async (req, res) => {
  const src = req.query.src;

  if (!src) {
    return res.status(400).json({
      success: false,
      message: 'Missing src parameter',
    });
  }

  await imageSemaphore.acquire();
  try {
    const png = await renderHtmlFromSrc(src);
    const buffer = await normalizeHtmlImage(png);
    const meta = await getImageMetadata(buffer);

    res.json({
      success: true,
      size: [meta.width, meta.height],
    });
  } catch (e) {
    res.status(400).json({
      success: false,
      message: e.message,
    });
  } finally {
    imageSemaphore.release();
  }
});

app.get('/html/colors', async (req, res) => {
  const src = req.query.src;

  if (!src) {
    return res.status(400).json({
      success: false,
      message: 'Missing src parameter',
    });
  }

  await imageSemaphore.acquire();
  try {
    const png = await renderHtmlFromSrc(src);
    const buffer = await normalizeHtmlImage(png);
    await getImageMetadata(buffer);
    const { colors } = await getImagePixels(buffer);

    res.json({
      success: true,
      colors,
    });
  } catch (e) {
    res.status(400).json({
      success: false,
      message: e.message,
    });
  } finally {
    imageSemaphore.release();
  }
});

app.get('/html/converttopng', async (req, res) => {
  const src = req.query.src;

  if (!src) {
    return res.status(400).send('Missing src parameter');
  }

  await imageSemaphore.acquire();
  try {
    const png = await renderHtmlFromSrc(src);
    res.type('png').send(png);
  } catch {
    res.status(400).send('Failed to render html');
  } finally {
    imageSemaphore.release();
  }
});

/* ==============================
   エラー処理
============================== */

app.use((_, res) => {
  res.status(404).json({ error: 'Not Found' });
});

app.use((err, _, res, __) => {
  console.error(err);
  res.status(500).json({ error: 'Internal Server Error' });
});

/* ==============================
   起動
============================== */

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
