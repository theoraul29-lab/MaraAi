/**
 * SQLite backup service.
 *
 * - Uses `VACUUM INTO` for an atomic consistent snapshot.
 * - Verifies every snapshot with `PRAGMA integrity_check`.
 * - Keeps the last 7 daily backups and 4 weekly backups.
 * - Optionally uploads snapshots to S3-compatible object storage.
 * - Runs a monthly restore drill by opening the snapshot read-only.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const BACKUP_DIR = process.env.BACKUP_DIR || '/data/backups';
const DAILY_BACKUPS_TO_KEEP = 7;
const WEEKLY_BACKUPS_TO_KEEP = 4;
const BACKUP_HOUR_UTC = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

function getDbPath(): string {
  const url = process.env.DATABASE_URL;
  if (url) {
    if (url.startsWith('sqlite:////')) return url.slice('sqlite:///'.length);
    if (url.startsWith('sqlite:///')) return url.slice('sqlite:///'.length);
    if (url.startsWith('sqlite://')) return url.slice('sqlite://'.length);
  }
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH;
  if (process.env.DATABASE_FILE) return process.env.DATABASE_FILE;
  if (fs.existsSync('/data')) return '/data/maraai.sqlite';
  return path.resolve(process.cwd(), 'maraai.sqlite');
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function backupStamp(now = new Date()): string {
  return `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}_${pad2(now.getUTCHours())}-${pad2(now.getUTCMinutes())}`;
}

function isoWeekId(now = new Date()): string {
  const utcDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utcDate.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${utcDate.getUTCFullYear()}-W${pad2(week)}`;
}

function buildBackupPath(kind: 'daily' | 'weekly', now = new Date()): string {
  if (kind === 'weekly') {
    return path.join(BACKUP_DIR, `maraai_weekly_${isoWeekId(now)}_${backupStamp(now)}.sqlite`);
  }
  return path.join(BACKUP_DIR, `maraai_daily_${backupStamp(now)}.sqlite`);
}

function hasWeeklyBackupForCurrentWeek(now = new Date()): boolean {
  const prefix = `maraai_weekly_${isoWeekId(now)}_`;
  return fs
    .readdirSync(BACKUP_DIR, { withFileTypes: true })
    .some((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.sqlite'));
}

function escapeSqlitePath(filePath: string): string {
  return filePath.replaceAll("'", "''");
}

function verifyBackupIntegrity(filePath: string): void {
  const backupDb = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const row = backupDb.pragma('integrity_check', { simple: true }) as unknown;
    const result =
      typeof row === 'string'
        ? row
        : Array.isArray(row)
          ? row[0]?.integrity_check ?? row[0]
          : 'unknown';
    if (result !== 'ok') {
      throw new Error(`Integrity check failed: ${result}`);
    }
  } finally {
    backupDb.close();
  }
}

function buildSignatureKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = crypto.createHmac('sha256', `AWS4${secret}`).update(dateStamp).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
  return crypto.createHmac('sha256', kService).update('aws4_request').digest();
}

async function uploadBackupToS3(filePath: string): Promise<void> {
  const bucket = process.env.BACKUP_S3_BUCKET;
  const region = process.env.BACKUP_S3_REGION;
  const accessKeyId = process.env.BACKUP_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.BACKUP_S3_SECRET_ACCESS_KEY;
  if (!bucket || !region || !accessKeyId || !secretAccessKey) return;

  const prefix = (process.env.BACKUP_S3_PREFIX ?? 'maraai-backups').replace(/^\/+|\/+$/g, '');
  const endpoint = process.env.BACKUP_S3_ENDPOINT || `https://${bucket}.s3.${region}.amazonaws.com`;
  const endpointUrl = new URL(endpoint);
  const objectKey = `${prefix}/${path.basename(filePath)}`;
  const requestPath = `${endpointUrl.pathname.replace(/\/$/, '')}/${objectKey}`;
  const uploadUrl = new URL(endpointUrl.origin);
  uploadUrl.pathname = requestPath;

  const body = await fs.promises.readFile(filePath);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = crypto.createHash('sha256').update(body).digest('hex');
  const canonicalHeaders =
    `host:${uploadUrl.host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    'PUT',
    uploadUrl.pathname,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const signingKey = buildSignatureKey(secretAccessKey, dateStamp, region, 's3');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(uploadUrl, {
    method: 'PUT',
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(body.length),
      'X-Amz-Content-Sha256': payloadHash,
      'X-Amz-Date': amzDate,
    },
  });
  if (!response.ok) {
    throw new Error(`S3 upload failed with status ${response.status}`);
  }
}

function pruneBackups(): void {
  const backupFiles = fs
    .readdirSync(BACKUP_DIR)
    .filter((name) => /^maraai_(daily|weekly)_.*\.sqlite$/.test(name))
    .map((name) => ({
      name,
      kind: name.includes('_weekly_') ? 'weekly' : 'daily',
      mtimeMs: fs.statSync(path.join(BACKUP_DIR, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const daily = backupFiles.filter((file) => file.kind === 'daily').slice(DAILY_BACKUPS_TO_KEEP);
  const weekly = backupFiles.filter((file) => file.kind === 'weekly').slice(WEEKLY_BACKUPS_TO_KEEP);
  for (const file of [...daily, ...weekly]) {
    fs.unlinkSync(path.join(BACKUP_DIR, file.name));
    console.info(`[backup:db] Removed old ${file.kind} backup: ${file.name}`);
  }
}

function runRestoreDrill(filePath: string): void {
  verifyBackupIntegrity(filePath);
  const markerName = `.restore-drill-${path.basename(filePath).slice(0, 20)}.ok`;
  fs.writeFileSync(path.join(BACKUP_DIR, markerName), new Date().toISOString());
}

function maybeRunMonthlyRestoreDrill(filePath: string): void {
  const monthMarker = `.restore-drill-${new Date().toISOString().slice(0, 7)}.ok`;
  const markerPath = path.join(BACKUP_DIR, monthMarker);
  if (fs.existsSync(markerPath)) return;
  runRestoreDrill(filePath);
  fs.writeFileSync(markerPath, new Date().toISOString());
  console.info(`[backup:db] Monthly restore drill passed for ${path.basename(filePath)}`);
}

function createConsistentSnapshot(sourcePath: string, destinationPath: string): void {
  if (fs.existsSync(destinationPath)) fs.unlinkSync(destinationPath);
  const sqlite = new Database(sourcePath, { fileMustExist: true });
  try {
    sqlite.pragma('busy_timeout = 5000');
    sqlite.exec(`VACUUM INTO '${escapeSqlitePath(destinationPath)}';`);
  } finally {
    sqlite.close();
  }
}

export async function runDbBackup(): Promise<{ success: boolean; file?: string; error?: string }> {
  const startedAt = Date.now();
  try {
    const src = getDbPath();
    if (!fs.existsSync(src)) {
      return { success: false, error: `DB file not found: ${src}` };
    }

    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    const now = new Date();
    const dailyPath = buildBackupPath('daily', now);
    createConsistentSnapshot(src, dailyPath);
    verifyBackupIntegrity(dailyPath);

    if (!hasWeeklyBackupForCurrentWeek(now)) {
      try {
        const weeklyPath = buildBackupPath('weekly', now);
        // The weekly artifact intentionally reuses the already-verified daily
        // snapshot so retention can keep separate daily/weekly copies without a
        // second VACUUM INTO pass against the live database.
        fs.copyFileSync(dailyPath, weeklyPath);
        verifyBackupIntegrity(weeklyPath);
      } catch (err) {
        console.warn('[backup:db] Weekly backup failed but daily snapshot remains valid:', err);
      }
    }

    maybeRunMonthlyRestoreDrill(dailyPath);
    await uploadBackupToS3(dailyPath);
    pruneBackups();

    const durationMs = Date.now() - startedAt;
    const bytes = fs.statSync(dailyPath).size;
    console.info(`[backup:db] Backup created: ${dailyPath} (${bytes} bytes, ${durationMs} ms)`);
    return { success: true, file: dailyPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[backup:db] Backup failed:', message);
    return { success: false, error: message };
  }
}

function msUntilNextUtcHour(targetHour: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(targetHour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}

if (
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('dbBackup.ts') || process.argv[1].endsWith('dbBackup.js'))
) {
  runDbBackup().then((result) => {
    process.exit(result.success ? 0 : 1);
  });
}

export function scheduleDbBackup(): void {
  if (process.env.NODE_ENV !== 'production' && !process.env.FORCE_DB_BACKUP_SCHEDULE) {
    console.info('[backup:db] Scheduler skipped (non-production). Set FORCE_DB_BACKUP_SCHEDULE=1 to enable locally.');
    return;
  }

  const delay = msUntilNextUtcHour(BACKUP_HOUR_UTC);
  console.info(`[backup:db] First backup in ${Math.round(delay / 60000)} min (at 03:00 UTC daily)`);

  setTimeout(() => {
    void runDbBackup();
    setInterval(() => {
      void runDbBackup();
    }, DAY_MS);
  }, delay);
}
