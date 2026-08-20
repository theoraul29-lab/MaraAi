import type { Express } from 'express';

const SENSITIVE_LOG_FIELDS = new Set([
  'password', 'passwordHash', 'password_hash',
  'resetToken', 'reset_token', 'token',
  'passwordConfirm', 'newPassword',
]);

function sanitizeForLog(obj: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_LOG_FIELDS.has(key)) {
      out[key] = '[REDACTED]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = sanitizeForLog(value as Record<string, any>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function attachRequestLogging(
  app: Express,
  log: (message: string, source?: string) => void,
): void {
  app.use((req, res, next) => {
    const start = Date.now();
    const { path } = req;
    let capturedJsonResponse: Record<string, any> | undefined;

    if (process.env.NODE_ENV !== 'production') {
      const originalResJson = res.json;
      res.json = function (bodyJson, ...args) {
        capturedJsonResponse = bodyJson;
        return originalResJson.apply(res, [bodyJson, ...args]);
      };
    }

    res.on('finish', () => {
      const duration = Date.now() - start;
      if (!path.startsWith('/api')) return;
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(sanitizeForLog(capturedJsonResponse))}`;
      }
      log(logLine);
    });

    next();
  });
}
