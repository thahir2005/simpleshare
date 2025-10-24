// SimpleShare backend with SSE progress updates
require('dotenv').config();

const express = require('express');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve storage and frontend
app.use('/public', express.static(path.join(__dirname, '..', 'storage')));
app.use('/', express.static(path.join(__dirname, '..', 'frontend')));

// In-memory job store: { [jobId]: { status, progress, url, clients: [res,...], error } }
const jobs = {};

/** Helper: broadcast an event to all SSE clients for a job */
function broadcast(jobId, event, payload) {
  const j = jobs[jobId];
  if (!j) return;
  j.status = payload.status ?? j.status;
  j.progress = payload.progress ?? j.progress;
  j.error = payload.error ?? j.error;
  j.url = payload.url ?? j.url;
  const data = JSON.stringify({
    status: j.status,
    progress: j.progress,
    url: j.url,
    error: j.error
  });
  (j.clients || []).forEach(res => {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${data}\n\n`);
    } catch (e) { /* ignore broken clients */ }
  });
}

// SSE endpoint: client subscribes for job updates
app.get('/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  if (!jobs[jobId]) {
    return res.status(404).json({ error: 'job not found' });
  }

  // SSE headers
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders();

  // send initial state
  res.write(`data: ${JSON.stringify({
    status: jobs[jobId].status,
    progress: jobs[jobId].progress,
    url: jobs[jobId].url,
    error: jobs[jobId].error
  })}\n\n`);

  // attach to clients
  jobs[jobId].clients.push(res);

  // remove client on close
  req.on('close', () => {
    const idx = jobs[jobId].clients.indexOf(res);
    if (idx !== -1) jobs[jobId].clients.splice(idx, 1);
  });
});

// POST to create/launch conversion job
app.post('/convert', (req, res) => {
  const url = req.body.url;
  if (!url) return res.status(400).json({ error: 'missing url' });

  const jobId = uuidv4();
  const outFile = path.join(__dirname, '..', 'storage', `${jobId}.mp4`);
  const tmpFile = path.join(__dirname, '..', 'storage', `${jobId}.%(ext)s`);

  // initialize job
  jobs[jobId] = {
    status: 'queued',
    progress: 0,
    url: null,
    error: null,
    clients: []
  };

  // Immediately respond with jobId so frontend can connect to SSE
  res.json({ jobId, statusUrl: `${req.protocol}://${req.get('host')}/status/${jobId}` });

  // Start async work
  (async () => {
    try {
      broadcast(jobId, 'update', { status: 'starting', progress: 0 });

      // 1) Download with yt-dlp (spawn so we can parse progress lines)
      // Use --newline so progress lines come as separate stdout lines.
      broadcast(jobId, 'update', { status: 'downloading', progress: 0 });
      await new Promise((resolve, reject) => {
        const ytdlpArgs = ['-f', 'bestvideo+bestaudio/best', '-o', tmpFile, '--newline', url];
        const ytdlp = spawn('yt-dlp', ytdlpArgs);

        ytdlp.stdout.setEncoding('utf8');
        ytdlp.stdout.on('data', (chunk) => {
          const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
          lines.forEach(line => {
            // Typical progress lines look like: [download]  12.3% of 3.45MiB at 123.45KiB/s ETA 00:12
            const m = line.match(/\[download\]\s+([0-9.]+)%/);
            if (m) {
              const pct = Math.round(parseFloat(m[1]));
              broadcast(jobId, 'download-progress', { status: 'downloading', progress: pct });
            } else {
              // also broadcast generic messages occasionally
              broadcast(jobId, 'message', { status: 'downloading', progress: jobs[jobId].progress });
            }
          });
        });

        let stderr = '';
        ytdlp.stderr.on('data', d => { stderr += d.toString(); });

        ytdlp.on('error', (err) => reject(new Error('yt-dlp spawn failed: ' + err.message)));
        ytdlp.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error('yt-dlp failed: ' + stderr));
        });
      });

      // find downloaded file
      const files = fs.readdirSync(path.join(__dirname, '..', 'storage'));
      const matched = files.find(f => f.startsWith(jobId + '.'));
      if (!matched) throw new Error('downloaded file not found');
      const downloaded = path.join(__dirname, '..', 'storage', matched);

      // 2) Transcode with ffmpeg and emit progress via -progress pipe:1
      broadcast(jobId, 'update', { status: 'converting', progress: 0 });
      await new Promise((resolve, reject) => {
        // ffmpeg -progress pipe:1 will write key=value lines to stdout periodically.
        const ffmpegArgs = [
          '-y', '-i', downloaded,
          '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.0',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '128k',
          '-movflags', '+faststart',
          '-vf', "scale='min(1280,iw)':'-2'",
          '-progress', 'pipe:1',
          '-nostats',
          outFile
        ];
        const ffmpeg = spawn('ffmpeg', ffmpegArgs);

        ffmpeg.stdout.setEncoding('utf8');
        let stdoutBuf = '';
        let durationSeconds = null;
        let lastPercent = 0;

        ffmpeg.stdout.on('data', (chunk) => {
          stdoutBuf += chunk;
          // parse completed key=value blocks
          const lines = stdoutBuf.split(/\r?\n/);
          // keep incomplete tail in buffer
          stdoutBuf = lines.pop();
          lines.forEach(line => {
            const [k, v] = line.split('=');
            if (!k) return;
            if (k === 'out_time_ms') {
              const outMs = parseInt(v, 10);
              if (durationSeconds) {
                const pct = Math.min(100, Math.round((outMs / 1000) / durationSeconds * 100));
                // don't spam small changes
                if (pct !== lastPercent) {
                  lastPercent = pct;
                  broadcast(jobId, 'convert-progress', { status: 'converting', progress: pct });
                }
              } else {
                // without duration we just surface converting messages
                broadcast(jobId, 'convert-progress', { status: 'converting', progress: jobs[jobId].progress });
              }
            } else if (k === 'progress' && v === 'end') {
              // finished
            } else if (k === 'duration') {
              // some ffmpeg builds may provide duration; parse if available (seconds as float)
              const d = parseFloat(v);
              if (!isNaN(d)) durationSeconds = d;
            }
          });
        });

        // sometimes ffmpeg prints duration to stderr — try to parse it
        let stderrBuf = '';
        ffmpeg.stderr.on('data', (chunk) => {
          const s = chunk.toString();
          stderrBuf += s;
          // look for "Duration: 00:00:12.34"
          const m = s.match(/Duration:\s*([0-9]+):([0-9]{2}):([0-9.]+)/);
          if (m) {
            const hrs = parseInt(m[1], 10);
            const mins = parseInt(m[2], 10);
            const secs = parseFloat(m[3]);
            durationSeconds = hrs * 3600 + mins * 60 + secs;
          }
        });

        ffmpeg.on('error', (err) => reject(new Error('ffmpeg spawn failed: ' + err.message)));
        ffmpeg.on('close', (code) => {
          // remove intermediate downloaded file
          try { fs.unlinkSync(downloaded); } catch (e) {}
          if (code === 0) resolve();
          else reject(new Error('ffmpeg failed: ' + stderrBuf));
        });
      });

      // done — set public URL and notify clients
      const publicUrl = `${process.env.PUBLIC_URL || 'http://localhost:5000'}/public/${jobId}.mp4`;
      broadcast(jobId, 'done', { status: 'done', progress: 100, url: publicUrl });
      // keep job record (url) for later /status checks
      jobs[jobId].url = publicUrl;
      jobs[jobId].status = 'done';
      jobs[jobId].progress = 100;
    } catch (err) {
      console.error('Job error', err.message || err);
      broadcast(jobId, 'error', { status: 'error', progress: jobs[jobId].progress || 0, error: err.message || String(err) });
      jobs[jobId].status = 'error';
      jobs[jobId].error = err.message || String(err);
    }
  })();
});

// health
app.get('/health', (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 5000;
app.listen(port, () => console.log(`✅ SimpleShare backend running at http://localhost:${port}`));