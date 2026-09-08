import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Monitor } from './monitor.mjs';
import { discover, collect, fetchTape, resolveTape } from './providers.mjs';
import { openTapeSocket } from './tape-socket.mjs';
const envFile = fileURLToPath(new URL('../.env.local', import.meta.url));
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const monitor = new Monitor({
  discover,
  collect,
  fetchTape,
  resolveTape,
  openTapeSocket,
});
// Only this machine's tabs subscribe; the bound cap keeps a runaway reloader
// from holding an unbounded number of open responses.
const MAX_STREAMS = 8;
const streams = new Set();
const state = monitor.state;
const cycle = () => monitor.refresh();
const summary = () => monitor.summary();
function reply(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}
async function body(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 8192) throw new Error('请求过大');
  }
  return JSON.parse(text || '{}');
}
export const server = http.createServer(async (req, res) => {
  const host = req.headers.host || '';
  if (!/^(localhost|127\.0\.0\.1):\d+$/.test(host))
    return reply(res, 403, { error: '只允许本机请求' });
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && url.pathname === '/api/state')
      return reply(res, 200, summary());
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      if (streams.size >= MAX_STREAMS)
        return reply(res, 503, { error: '事件流连接数已达上限' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Content-Type-Options': 'nosniff',
        // Proxies that buffer would defeat the point of pushing at all.
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();
      const send = (data) => {
        if (res.writableEnded) return;
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };
      // A subscriber that connects between two events would otherwise render
      // nothing until the next one; open with the current state.
      send(summary());
      const off = monitor.subscribe(send);
      const beat = setInterval(() => {
        if (!res.writableEnded) res.write(': keep-alive\n\n');
      }, 15000);
      beat.unref?.();
      const close = () => {
        if (!streams.delete(close)) return;
        clearInterval(beat);
        off();
        res.end();
      };
      streams.add(close);
      res.on('close', close);
      res.on('error', close);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/report') {
      const report = state.reports[url.searchParams.get('id')];
      return reply(
        res,
        report ? 200 : 404,
        report || { error: '扫描报告尚未生成' },
      );
    }
    if (req.method !== 'POST') return reply(res, 404, { error: '接口不存在' });
    if (!req.headers['content-type']?.startsWith('application/json'))
      return reply(res, 415, { error: '需要 JSON 请求' });
    if (
      req.headers.origin &&
      !/^http:\/\/(localhost|127\.0\.0\.1):(3000|4319)$/.test(
        req.headers.origin,
      )
    )
      return reply(res, 403, { error: '拒绝跨站请求' });
    const input = await body(req);
    if (url.pathname === '/api/monitor') {
      if (input.config) monitor.configure(input.config);
      if (input.enabled === false) monitor.pause();
      else if (input.enabled === true || input.config) monitor.resume();
      return reply(res, 200, summary());
    }
    if (url.pathname === '/api/refresh') {
      if (!state.enabled)
        return reply(res, 409, { error: '监控已暂停，请先恢复' });
      void cycle();
      void monitor.pollTape();
      return reply(res, 202, summary());
    }
    if (url.pathname === '/api/settings') {
      if (
        typeof input.xToken !== 'string' ||
        input.xToken.length > 2000 ||
        /\s/.test(input.xToken)
      )
        throw new Error('X Token 格式无效');
      const lines = fs.existsSync(envFile)
        ? fs
            .readFileSync(envFile, 'utf8')
            .split('\n')
            .filter((l) => !l.startsWith('X_BEARER_TOKEN='))
        : [];
      if (input.xToken) lines.push(`X_BEARER_TOKEN=${input.xToken}`);
      fs.writeFileSync(envFile, lines.filter(Boolean).join('\n') + '\n', {
        mode: 0o600,
      });
      fs.chmodSync(envFile, 0o600);
      process.env.X_BEARER_TOKEN = input.xToken;
      return reply(res, 200, { ok: true, x: Boolean(input.xToken) });
    }
    return reply(res, 404, { error: '接口不存在' });
  } catch (e) {
    return reply(res, 400, { error: String(e.message).slice(0, 180) });
  }
});
server.listen(4319, '127.0.0.1', () => {
  console.log('Meme Scout data service: http://127.0.0.1:4319');
  monitor.resume();
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    monitor.pause();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
