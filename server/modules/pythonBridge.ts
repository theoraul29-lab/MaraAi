import type { Request, Response } from 'express';
import { z } from 'zod';
import { fetchAllowedExternalUrl } from '../lib/ssrf-guard.js';

const pythonBridgeRequestSchema = z
  .object({
    url: z.string().trim().max(2048),
    method: z.enum(['GET', 'HEAD']).optional(),
  })
  .strict();

export async function fetchWithPython(req: Request, res: Response) {
  try {
    const parsed = pythonBridgeRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: 'Invalid outbound request.', errors: parsed.error.flatten() });
    }

    const response = await fetchAllowedExternalUrl(parsed.data.url, {
      method: parsed.data.method ?? 'GET',
      headers: { Accept: 'application/json, text/plain;q=0.9, */*;q=0.1' },
    });

    const contentType = response.headers.get('content-type') || '';
    let data: any;

    try {
      if (contentType.includes('application/json')) {
        data = await response.json();
      } else {
        data = await response.text();
      }
    } catch {
      data = null;
    }

    res.json({
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      data,
    });
  } catch (error: any) {
    const status = /allowlist|private|https|resolve/i.test(String(error?.message ?? '')) ? 400 : 500;
    res.status(status).json({ message: error.message || 'Python bridge request failed' });
  }
}
