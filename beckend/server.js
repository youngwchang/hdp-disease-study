require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { markdownToDocx } = require('./lib/docx-generator');
const orchestrator = require('./orchestrator');

const app = express();
const PORT = process.env.PORT || 3000;

// ── 미들웨어 ─────────────────────────────────────────
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || '*',
    'http://localhost:3000',
    'http://localhost:5500',
    /\.netlify\.app$/,
  ],
  methods: ['GET', 'POST'],
}));
app.use(express.json({ limit: '20mb' })); // IQVIA JSON 수용

// ── In-memory Job Store ────────────────────────────
const jobs = new Map();

// 1시간 지난 job 정리
setInterval(() => {
  const cutoff = Date.now() - 3600_000;
  for (const [id, job] of jobs.entries()) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}, 600_000);

// ── 헬스체크 ─────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok' }));

// ── POST /api/analyze ─────────────────────────────
// body: { disease: string, iqviaData?: object }
app.post('/api/analyze', (req, res) => {
  const { disease, iqviaData } = req.body;
  if (!disease?.trim()) {
    return res.status(400).json({ error: '질환명을 입력하세요.' });
  }

  const jobId = uuidv4();
  jobs.set(jobId, {
    status: 'running',
    events: [],
    result: null,
    error: null,
    createdAt: Date.now(),
  });

  // 분석 비동기 실행
  runAnalysis(jobId, disease.trim(), iqviaData || null);

  res.json({ jobId });
});

// ── GET /api/stream/:jobId  (SSE) ─────────────────
app.get('/api/stream/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // 이미 쌓인 이벤트 즉시 전송
  job.events.forEach(e => sendSSE(res, e));

  // 완료/실패 상태면 즉시 종료
  if (job.status === 'done' || job.status === 'error') {
    sendSSE(res, { type: job.status, data: job.result || job.error });
    return res.end();
  }

  // 실시간 이벤트 리스너 등록
  const listener = (event) => {
    sendSSE(res, event);
    if (event.type === 'done' || event.type === 'error') {
      cleanup();
      res.end();
    }
  };

  if (!job.listeners) job.listeners = [];
  job.listeners.push(listener);

  // 연결 종료 시 정리
  const cleanup = () => {
    if (job.listeners) {
      job.listeners = job.listeners.filter(l => l !== listener);
    }
    clearInterval(heartbeat);
  };
  req.on('close', cleanup);

  // 30초마다 heartbeat (연결 유지)
  const heartbeat = setInterval(() => sendSSE(res, { type: 'ping' }), 30_000);
});

// ── GET /api/download/:jobId/md ───────────────────
app.get('/api/download/:jobId/md', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job?.result) return res.status(404).json({ error: '결과 없음' });

  const filename = encodeURIComponent(job.result.title || 'report') + '.md';
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
  res.send(job.result.markdown);
});

// ── GET /api/download/:jobId/docx ─────────────────
app.get('/api/download/:jobId/docx', async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job?.result) return res.status(404).json({ error: '결과 없음' });

  try {
    const buffer = await markdownToDocx(job.result.markdown, job.result.title);
    const filename = encodeURIComponent(job.result.title || 'report') + '.docx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
    res.send(buffer);
  } catch (err) {
    console.error('DOCX 변환 오류:', err);
    res.status(500).json({ error: 'DOCX 변환 실패' });
  }
});

// ── 분석 실행 (비동기) ──────────────────────────────
async function runAnalysis(jobId, disease, iqviaData) {
  const job = jobs.get(jobId);

  const emit = (payload) => {
    const event = typeof payload === 'string'
      ? { type: 'progress', message: payload }
      : { type: 'progress', ...payload };

    job.events.push(event);
    if (job.listeners) job.listeners.forEach(l => l(event));
  };

  try {
    const result = await orchestrator.run(jobId, disease, iqviaData, emit);
    job.status = 'done';
    job.result = result;

    const doneEvent = { type: 'done' };
    job.events.push(doneEvent);
    if (job.listeners) job.listeners.forEach(l => l(doneEvent));
  } catch (err) {
    console.error(`[Job ${jobId}] 오류:`, err);
    job.status = 'error';
    job.error = err.message || '분석 중 오류 발생';

    const errEvent = { type: 'error', message: job.error };
    job.events.push(errEvent);
    if (job.listeners) job.listeners.forEach(l => l(errEvent));
  }
}

function sendSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ── 서버 시작 ─────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Disease Intel Backend running on port ${PORT}`);
});
