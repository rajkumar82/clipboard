const express = require('express');
const path = require('path');
const fs = require('fs/promises');

const PORT = process.env.PORT || 8080;
const BUCKET = process.env.BUCKET; // if unset, clips are stored in ./data
const TTL_MS = 3 * 24 * 60 * 60 * 1000; // clips live for 3 days
const MAX_TEXT = 100 * 1000; // characters
const NAME_RE = /^[a-z0-9_-]{1,64}$/;

// ---- storage: one JSON file per clip, either in GCS or in ./data ----

function gcsStorage(bucketName) {
  const { Storage } = require('@google-cloud/storage');
  const bucket = new Storage().bucket(bucketName);
  return {
    async read(name) {
      try {
        const [buf] = await bucket.file(`${name}.json`).download();
        return JSON.parse(buf.toString());
      } catch (err) {
        if (err.code === 404) return null;
        throw err;
      }
    },
    async write(name, clip) {
      await bucket.file(`${name}.json`).save(JSON.stringify(clip), {
        contentType: 'application/json',
      });
    },
    async remove(name) {
      await bucket.file(`${name}.json`).delete({ ignoreNotFound: true });
    },
  };
}

function localStorage(dir) {
  const file = (name) => path.join(dir, `${name}.json`);
  return {
    async read(name) {
      try {
        return JSON.parse(await fs.readFile(file(name), 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },
    async write(name, clip) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file(name), JSON.stringify(clip));
    },
    async remove(name) {
      await fs.rm(file(name), { force: true });
    },
  };
}

const store = BUCKET ? gcsStorage(BUCKET) : localStorage(path.join(__dirname, 'data'));

// ---- api ----

const app = express();
app.use(express.json({ limit: '300kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.param('name', (req, res, next, raw) => {
  const name = String(raw).trim().toLowerCase();
  if (!NAME_RE.test(name)) {
    return res.status(400).json({ error: 'Name must be 1-64 characters: letters, digits, - or _' });
  }
  req.clipName = name;
  next();
});

app.get('/api/clips/:name', async (req, res, next) => {
  try {
    const clip = await store.read(req.clipName);
    if (!clip) return res.status(404).json({ error: 'Not found' });
    if (Date.now() - clip.savedAt > TTL_MS) {
      // the bucket lifecycle rule deletes lazily, so enforce expiry here too
      await store.remove(req.clipName);
      return res.status(404).json({ error: 'Not found' });
    }
    res.set('Cache-Control', 'no-store');
    res.json({ text: clip.text, savedAt: clip.savedAt, expiresAt: clip.savedAt + TTL_MS });
  } catch (err) {
    next(err);
  }
});

app.put('/api/clips/:name', async (req, res, next) => {
  try {
    const text = req.body && req.body.text;
    if (typeof text !== 'string') return res.status(400).json({ error: 'text (string) is required' });
    if (text.length > MAX_TEXT) return res.status(413).json({ error: `Max ${MAX_TEXT} characters` });
    const clip = { text, savedAt: Date.now() };
    await store.write(req.clipName, clip);
    res.json({ savedAt: clip.savedAt, expiresAt: clip.savedAt + TTL_MS });
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error' });
});

app.listen(PORT, () => {
  console.log(`Clipboard listening on :${PORT} (storage: ${BUCKET ? `gcs://${BUCKET}` : './data'})`);
});
