import net from 'net';
import tls from 'tls';

type RedisReply = string | number | null;

function encodeCommand(parts: string[]): string {
  return `*${parts.length}\r\n${parts
    .map((part) => `$${Buffer.byteLength(part)}\r\n${part}\r\n`)
    .join('')}`;
}

function parseRedisReply(buffer: string): RedisReply {
  if (!buffer) return null;
  const prefix = buffer[0];
  if (prefix === '+') return buffer.slice(1).trim();
  if (prefix === ':') return Number.parseInt(buffer.slice(1).trim(), 10);
  if (prefix === '$') {
    const [, payload = ''] = buffer.split('\r\n', 2);
    return payload || null;
  }
  return null;
}

async function runCommand(redisUrl: URL, parts: string[]): Promise<RedisReply> {
  const port = Number.parseInt(redisUrl.port || '', 10) || 6379;
  const host = redisUrl.hostname;
  const password = redisUrl.password || undefined;
  const commands: string[][] = [];
  if (password) commands.push(['AUTH', password]);
  commands.push(parts);

  return new Promise((resolve, reject) => {
    const socket =
      redisUrl.protocol === 'rediss:'
        ? tls.connect({ host, port, servername: host })
        : net.createConnection({ host, port });

    let buffer = '';
    let replies = 0;
    const expectedReplies = commands.length;

    socket.setTimeout(2_500);
    socket.on('connect', () => {
      for (const command of commands) {
        socket.write(encodeCommand(command));
      }
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const segments = buffer.split('\r\n');
      while (segments.length > 1) {
        const line = segments.shift() ?? '';
        if (!line) continue;
        if (line.startsWith('$')) {
          const bulkLength = Number.parseInt(line.slice(1), 10);
          const payload = segments.shift() ?? '';
          buffer = segments.join('\r\n');
          replies += 1;
          if (replies === expectedReplies) {
            socket.end();
            resolve(payload.slice(0, Math.max(0, bulkLength)));
          }
          return;
        }

        replies += 1;
        const reply = parseRedisReply(`${line}\r\n`);
        if (line.startsWith('-')) {
          socket.destroy();
          reject(new Error(reply ? String(reply) : 'Redis error'));
          return;
        }
        if (replies === expectedReplies) {
          socket.end();
          resolve(reply);
          return;
        }
      }
      buffer = segments.join('\r\n');
    });
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Redis timeout'));
    });
    socket.on('error', reject);
  });
}

export async function incrementRedisWindowCounter(
  key: string,
  windowMs: number,
): Promise<number | null> {
  const rawUrl = process.env.REDIS_URL;
  if (!rawUrl) return null;

  const redisUrl = new URL(rawUrl);
  const count = await runCommand(redisUrl, ['INCR', key]);
  if (typeof count !== 'number' || !Number.isFinite(count)) return null;
  if (count === 1) {
    await runCommand(redisUrl, ['PEXPIRE', key, String(windowMs)]);
  }
  return count;
}
