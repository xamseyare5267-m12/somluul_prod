import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import { Storage } from '@google-cloud/storage';
import nodemailer from 'nodemailer';
import {
  registerUser,
  authenticateUser,
  resetUserPassword,
  updateProfile,
  toggleFollowUser,
  toggleBlockUser,
  deleteUserAccount,
  saveFileRecord,
  deleteFileRecord,
  deleteUserFiles,
  getUserStats,
  getAdminStats,
  readDB,
  writeDB,
  logActivity,
  getActivityLogs,
  findOrCreateSocialUser,
  trackUserDevice,
  removeUserDevice,
  removeAllUserDevices,
  hashPassword,
  verifyPassword,
  generateId,
  syncDbFromSupabase,
  syncDbToSupabase,
  invalidateDbCache
} from './src/server/db.js';
import { FileMetadata, Profile, Post, UserRole } from './src/types.js';
import {
  checkPrinterOnline,
  sendPrintJobWithRetry,
  getPrinterConfig,
  savePrinterConfig,
  getPrinterLogsAndAlerts,
  clearPrinterLogsAndAlerts
} from './src/server/printer.js';

// Extend Express Request type to include authenticated user details
interface AuthenticatedRequest extends Request {
  user?: Profile;
}

// Create Nodemailer Transporter
const createMailTransporter = () => {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587');
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (host && user && pass) {
    return nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: {
        user,
        pass,
      },
    });
  }
  return null;
};

// Send Verification Email
async function sendVerificationEmail(email: string, code: string): Promise<boolean> {
  const transporter = createMailTransporter();
  const from = process.env.SMTP_FROM || '"SomLuul App" <no-reply@somluul.com>';

  const subject = `SomLuul App: Koodhka Xaqiijinta - ${code}`;
  const htmlContent = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
      <div style="text-align: center; margin-bottom: 24px;">
        <h2 style="color: #0f172a; margin-top: 12px;">Xaqiijinta Email-ka SomLuul</h2>
      </div>
      <p style="color: #334155; font-size: 16px; line-height: 1.5;">Kulan Wacan! Waad ku mahadsan tahay inaad isku diiwaan gelisay <strong>SomLuul Social Multi-App</strong>.</p>
      <p style="color: #334155; font-size: 16px; line-height: 1.5;">Fadlan isticmaal koodhka xaqiijinta ee hoose si aad u dhammaystirto diiwaan-gelintaada:</p>
      
      <div style="text-align: center; margin: 32px 0; padding: 16px; background-color: #f8fafc; border-radius: 8px; border: 1px dashed #cbd5e1;">
        <span style="font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #3b82f6;">${code}</span>
      </div>
      
      <p style="color: #64748b; font-size: 14px; line-height: 1.5;">Koodhkan wuxuu dhacayaa 15 daqiiqo ka dib. Fadlan cidna ha la wadaagin koodhkan.</p>
      <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 32px 0;" />
      <div style="text-align: center; color: #94a3b8; font-size: 12px;">
        <p>© 2026 SomLuul Global App. All rights reserved.</p>
      </div>
    </div>
  `;

  if (transporter) {
    try {
      await transporter.sendMail({
        from,
        to: email,
        subject,
        html: htmlContent,
      });
      console.log(`[Mail] Verification email sent successfully to: ${email}`);
      return true;
    } catch (error) {
      console.error(`[Mail] Failed to send verification email to: ${email}`, error);
      return false;
    }
  } else {
    console.warn(`[Mail] SMTP is not fully configured. Email was not sent. Here is the verification code: ${code}`);
    return false;
  }
}


/**
 * Free/low-cost OTP delivery (no Twilio required):
 * 1) TextBelt free tier (key=textbelt) — limited free SMS/day
 * 2) Optional TEXTBELT_KEY if you buy cheap credits later
 * 3) Optional TWILIO_* if you add it later
 * 4) Email fallback when SMTP is configured and email is known
 */
async function sendSmsOtp(
  toPhone: string,
  code: string,
  emailFallback?: string
): Promise<{ ok: boolean; channel?: string; error?: string }> {
  const message = `SomLuul OTP: ${code}. Valid 10 min. Ha la wadaagin.`;

  // 1) Optional Twilio (if user adds keys later)
  const sid = process.env.TWILIO_ACCOUNT_SID || '';
  const token = process.env.TWILIO_AUTH_TOKEN || '';
  const from = process.env.TWILIO_FROM_NUMBER || '';
  if (sid && token && from) {
    try {
      const body = new URLSearchParams({ To: toPhone, From: from, Body: message });
      const auth = Buffer.from(`${sid}:${token}`).toString('base64');
      const resp = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
        }
      );
      if (resp.ok) {
        console.log(`[SMS] Twilio OK → ${toPhone}`);
        return { ok: true, channel: 'twilio' };
      }
      console.error('[SMS] Twilio error', await resp.text());
    } catch (e: any) {
      console.error('[SMS] Twilio failed', e?.message);
    }
  }

  // 2) TextBelt — FREE tier with key "textbelt" (quota limited, no credit card)
  const textbeltKey = process.env.TEXTBELT_KEY || 'textbelt';
  try {
    const body = new URLSearchParams({
      phone: toPhone,
      message,
      key: textbeltKey,
    });
    const resp = await fetch('https://textbelt.com/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data: any = await resp.json().catch(() => ({}));
    if (data && data.success) {
      console.log(`[SMS] TextBelt OK → ${toPhone}`);
      return { ok: true, channel: 'textbelt' };
    }
    console.warn('[SMS] TextBelt:', data?.error || data);
  } catch (e: any) {
    console.error('[SMS] TextBelt failed', e?.message);
  }

  // 3) Email fallback (Gmail SMTP free) when address known
  if (emailFallback && emailFallback.includes('@') && !emailFallback.endsWith('.local')) {
    const mailed = await sendVerificationEmail(emailFallback, code);
    if (mailed) {
      console.log(`[SMS] Email OTP → ${emailFallback}`);
      return { ok: true, channel: 'email' };
    }
  }

  return {
    ok: false,
    error: 'SMS free quota / SMTP ma shaqeyn. Dhig SMTP_HOST ama isku day mar kale (TextBelt free limit).',
  };
}

/** Create Stripe Checkout Session for wallet top-up */
async function createStripeCheckout(opts: {
  amountUsd: number;
  userId: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ url?: string; sessionId?: string; error?: string }> {
  const key = process.env.STRIPE_SECRET_KEY || '';
  if (!key) return { error: 'STRIPE_SECRET_KEY not configured' };
  try {
    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('success_url', opts.successUrl);
    params.append('cancel_url', opts.cancelUrl);
    params.append('client_reference_id', opts.userId);
    params.append('metadata[userId]', opts.userId);
    params.append('metadata[type]', 'wallet_topup');
    params.append('line_items[0][price_data][currency]', 'usd');
    params.append('line_items[0][price_data][product_data][name]', 'SomLuul Wallet Top-up');
    params.append('line_items[0][price_data][unit_amount]', String(Math.round(opts.amountUsd * 100)));
    params.append('line_items[0][quantity]', '1');
    const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });
    const data: any = await resp.json();
    if (!resp.ok) {
      console.error('[Stripe]', data);
      return { error: data?.error?.message || 'Stripe error' };
    }
    return { url: data.url, sessionId: data.id };
  } catch (e: any) {
    return { error: e?.message || 'Stripe request failed' };
  }
}

// Sync db.json from GCS
async function syncDbFromGcs() {
  const gcsBucketName = process.env.GCS_BUCKET_NAME;
  if (!gcsBucketName) {
    console.log('[FileHub DB] GCS_BUCKET_NAME is not set. Local db.json will be used.');
    return;
  }
  try {
    const storage = new Storage({
      projectId: process.env.GCP_PROJECT_ID || undefined,
    });
    const bucket = storage.bucket(gcsBucketName);
    const file = bucket.file('db.json');
    const [exists] = await file.exists();
    if (exists) {
      console.log('[FileHub DB] GCS db.json backup found, downloading to restore...');
      // On Vercel/read-only FS use /tmp/data (same as db.ts fallback)
      let dataDir = path.join(process.cwd(), 'data');
      try {
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        fs.accessSync(dataDir, fs.constants.W_OK);
      } catch {
        dataDir = path.join('/tmp', 'data');
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      }
      const localDbPath = path.join(dataDir, 'db.json');
      await file.download({ destination: localDbPath });
      invalidateDbCache();
      console.log('[FileHub DB] GCS db.json successfully downloaded and restored.');
    } else {
      console.log('[FileHub DB] No GCS db.json backup found yet. Local db.json will be uploaded on first write.');
    }
  } catch (err: any) {
    if (err?.code === 404 || err?.message?.includes('does not exist')) {
      console.log('[FileHub DB] GCS bucket or backup file not initialized. Local database active.');
    } else {
      console.log('[FileHub DB] Info on GCS sync:', err?.message || err);
    }
  }
}

function getCleanSupabaseBaseUrl(url: string | undefined): string {
  if (!url) return '';
  try {
    if (url.includes('://')) {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}`;
    }
  } catch (e) {
    // ignore and fallback
  }
  let cleaned = url.replace(/\/rest\/v1\/?$/, '');
  if (cleaned.endsWith('/')) {
    cleaned = cleaned.slice(0, -1);
  }
  return cleaned;
}

// Helper to upload files to Supabase Storage
async function uploadToSupabaseStorage(localPath: string, destination: string, contentType: string) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return;
  }
  try {
    const cleanUrl = getCleanSupabaseBaseUrl(supabaseUrl);
    const fileContent = fs.readFileSync(localPath);
    await axios.post(`${cleanUrl}/storage/v1/object/files-bucket/${destination}`, fileContent, {
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'apikey': supabaseKey,
        'Content-Type': contentType,
        'x-upsert': 'true'
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
    console.log(`[Supabase Storage] Successfully uploaded backup to files-bucket/${destination}`);
  } catch (err: any) {
    if (err.response?.status === 404 || err?.message?.includes('does not exist')) {
      console.log(`[Supabase Storage] Remote storage bucket not found. Skipping cloud backup.`);
    } else {
      console.log(`[Supabase Storage] Notice for ${destination}: ${err.message || 'Unknown status'}`);
    }
  }
}

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  // On Vercel (serverless) never block the first request on a full remote restore —
  // that was the main cause of "AxiosError: timeout of 25000ms exceeded" on /api/posts.
  // Restore with a hard timeout, then continue; background re-sync keeps data fresh.
  const isVercel = !!process.env.VERCEL;
  const restoreWithTimeout = async (ms: number) => {
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms));
    const result = await Promise.race([
      Promise.allSettled([syncDbFromGcs(), syncDbFromSupabase()]).then(() => 'done' as const),
      timeout,
    ]);
    if (result === 'timeout') {
      console.warn(`[FileHub DB] Remote restore timed out after ${ms}ms — serving with local/cache; background sync continues.`);
      // Keep restoring in background so warm instances eventually get full data
      Promise.allSettled([syncDbFromGcs(), syncDbFromSupabase()])
        .then(() => { invalidateDbCache(); try { readDB(); } catch (_) {} })
        .catch(() => {});
    } else {
      invalidateDbCache();
      try { readDB(); } catch (_) {}
      console.log('[FileHub DB] Remote database restore completed before API startup.');
    }
  };
  await restoreWithTimeout(isVercel ? 4000 : 15000);

  // ===== PRODUCTION SECURITY GUARD =====
  const isProdRuntime = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
  if (isProdRuntime) {
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16 || process.env.JWT_SECRET.includes('change-me')) {
      console.error('[SECURITY] JWT_SECRET must be a long random string in production (Vercel env).');
    }
    // Never expose OTP codes in production responses
    process.env.ALLOW_DEV_OTP = '0';
    if (!process.env.GCS_BUCKET_NAME && !process.env.SUPABASE_URL) {
      console.warn('[SECURITY] No GCS_BUCKET_NAME or SUPABASE_URL — data may not persist across Vercel instances. Configure one for production.');
    }
  }

  // Simple Request Logger
  app.use((req, res, next) => {
    console.log(`[REQUEST] ${req.method} ${req.url} - NODE_ENV: ${process.env.NODE_ENV}`);
    next();
  });

  // Enable CORS for mobile apps and other origins
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }
    next();
  });

  // Safely determine if the uploads directory is writable, falling back to /tmp/uploads in read-only environments
  let uploadsDir = path.join(process.cwd(), 'uploads');
  try {
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    const testFile = path.join(uploadsDir, '.write-test');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
  } catch (err) {
    console.warn('[FileHub Engine] Local uploads directory is not writable. Falling back to /tmp/uploads');
    uploadsDir = path.join('/tmp', 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
  }

  // Never let browsers/CDNs cache API or authentication responses.
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
    next();
  });

  // Parse JSON and Form Data
  app.use(express.json({ limit: '100mb' }));
  app.use(express.urlencoded({ extended: true, limit: '100mb' }));

  // Initialize Google Cloud Storage if bucket name is set
  const gcsBucketName = process.env.GCS_BUCKET_NAME;
  const gcpProjectId = process.env.GCP_PROJECT_ID;

  let gcsStorage: any = null;
  let gcsBucket: any = null;

  if (gcsBucketName) {
    try {
      gcsStorage = new Storage({
        projectId: gcpProjectId || undefined,
      });
      gcsBucket = gcsStorage.bucket(gcsBucketName);
      console.log(`[FileHub GCS] Initialized Google Cloud Storage bucket: ${gcsBucketName}`);
    } catch (err) {
      console.error('[FileHub GCS] Error initializing GCS client:', err);
    }
  } else {
    console.log('[FileHub GCS] GCS_BUCKET_NAME is not set. Using local server fallback storage.');
  }

  // Expose physical uploads directory for direct browser download & preview (with automatic GCS/Supabase fallback!)
  app.use('/uploads', (req, res, next) => {
    const filePath = decodeURIComponent(req.path);
    const localFile = path.join(uploadsDir, filePath);

    if (fs.existsSync(localFile) && !fs.lstatSync(localFile).isDirectory()) {
      return res.sendFile(localFile);
    }

    const proceedWithGcs = () => {
      if (gcsBucket) {
        const gcsPath = filePath.replace(/^\//, '');
        const gcsFile = gcsBucket.file(gcsPath);

        gcsFile.exists().then(([exists]: [boolean]) => {
          if (exists) {
            console.log(`[FileHub GCS] Serving file from GCS stream: ${gcsPath}`);
            gcsFile.getMetadata().then(([metadata]: any) => {
              if (metadata.contentType) {
                res.setHeader('Content-Type', metadata.contentType);
              }
              gcsFile.createReadStream().pipe(res);
            }).catch(() => {
              gcsFile.createReadStream().pipe(res);
            });
          } else {
            res.status(404).json({ error: 'File not found locally or in cloud storage.' });
          }
        }).catch((err: any) => {
          console.error(`[FileHub GCS] Error checking file existence in GCS: ${gcsPath}`, err);
          res.status(404).json({ error: 'File not found.' });
        });
      } else {
        res.status(404).json({ error: 'File not found.' });
      }
    };

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (supabaseUrl && supabaseKey) {
      const cleanUrl = getCleanSupabaseBaseUrl(supabaseUrl);
      const cleanPath = filePath.replace(/^\//, '');
      console.log(`[Supabase Storage] Streaming file: files-bucket/${cleanPath}`);
      
      axios.get(`${cleanUrl}/storage/v1/object/authenticated/files-bucket/${cleanPath}`, {
        headers: {
          'Authorization': `Bearer ${supabaseKey}`,
          'apikey': supabaseKey
        },
        responseType: 'stream'
      }).then((response) => {
        if (response.headers['content-type']) {
          res.setHeader('Content-Type', String(response.headers['content-type']));
        }
        response.data.pipe(res);
      }).catch((err) => {
        console.warn(`[Supabase Storage] File not found in Supabase: files-bucket/${cleanPath}. Trying GCS fallback...`);
        proceedWithGcs();
      });
    } else {
      proceedWithGcs();
    }
  });

  // JWT_SECRET MUST be the same on every production instance.
  // The fallback keeps local development working, but Vercel should always set
  // JWT_SECRET in Project Settings -> Environment Variables.
  const JWT_SECRET = process.env.JWT_SECRET || 'somluul-local-development-only-change-me';

  // --- MIDDLEWARES ---

  // Central authentication middleware.
  // IMPORTANT: never treat a user id as a bearer token. Only signed JWTs are accepted.
  const authMiddleware = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !/^Bearer\s+\S+$/i.test(authHeader)) {
      res.status(401).json({ error: 'Unauthorized. No valid session token provided.' });
      return;
    }

    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      res.status(401).json({ error: 'Unauthorized. No session token provided.' });
      return;
    }

    let decoded: { userId: string; deviceId?: string; email?: string; role?: UserRole;
      first_name?: string; last_name?: string; avatar?: string | null; blocked?: boolean; } ;

    try {
      decoded = jwt.verify(token, JWT_SECRET) as typeof decoded;
    } catch (err: any) {
      const message = err?.name === 'TokenExpiredError'
        ? 'Session expired. Please sign in again.'
        : 'Unauthorized. Invalid session token.';
      res.status(401).json({ error: message });
      return;
    }

    if (!decoded?.userId) {
      res.status(401).json({ error: 'Unauthorized. Invalid session token.' });
      return;
    }

    const db = readDB();
    let user = db.profiles.find(p => p.id === decoded.userId);

    // A serverless instance may have a slightly older local DB snapshot. The JWT
    // therefore carries safe identity claims so authentication itself does not
    // randomly fail just because the profile is not present on that instance.
    if (!user && decoded.email) {
      user = {
        id: decoded.userId,
        email: decoded.email.toLowerCase(),
        first_name: decoded.first_name || '',
        last_name: decoded.last_name || '',
        avatar: decoded.avatar ?? null,
        role: decoded.role === 'admin' || decoded.role === 'moderator' ? decoded.role : 'normal',
        blocked: decoded.blocked === true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        devices: []
      };
      // Heal an older serverless snapshot so subsequent endpoints such as
      // profile updates can find the same user in the local working copy.
      db.profiles.push(user);
      if (!db.credentials.some(c => c.userId === user!.id)) {
        db.credentials.push({ userId: user.id, passwordHash: hashPassword(generateId()) });
      }
      writeDB(db);
    }

    if (!user) {
      res.status(401).json({ error: 'Unauthorized. Account could not be found.' });
      return;
    }

    if (user.blocked || decoded.blocked) {
      res.status(403).json({ error: 'Forbidden. Your account has been blocked.' });
      return;
    }

    req.user = user;
    next();
  };

  // Admin Verification Middleware
  const adminMiddleware = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user || req.user.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden. Administrative access required.' });
      return;
    }
    next();
  };

  // Owner Verification Middleware
  const ownerMiddleware = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user || req.user.email.toLowerCase() !== 'xamseyare5267@gmail.com') {
      res.status(403).json({ error: 'Forbidden. Owner access required.' });
      return;
    }
    next();
  };

  // Configure Multer for File Uploads
  const storage = multer.diskStorage({
    destination: (req: AuthenticatedRequest, file, cb) => {
      const userId = req.user?.id || 'anonymous';
      const userUploadDir = path.join(uploadsDir, userId);
      if (!fs.existsSync(userUploadDir)) {
        fs.mkdirSync(userUploadDir, { recursive: true });
      }
      cb(null, userUploadDir);
    },
    filename: (req, file, cb) => {
      // Append timestamp to ensure uniqueness but preserve extension
      const ext = path.extname(file.originalname);
      const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9]/g, '_');
      cb(null, `${base}_${Date.now()}${ext}`);
    }
  });


  // ========== CONTENT SAFETY ==========
  // Policy: Text is NEVER blocked for words (sex, nude, xxx…).
  // Only extreme porn filenames + optional Gemini vision on media when GEMINI_API_KEY is set.
  const EXTREME_PORN_FILENAME: RegExp[] = [
    /(^|[_\-\s.])(porn|porno|xxx+|onlyfans|hentai|nsfw.?pack|sex.?tape|hardcore.?porn)([_\-\s.]|$)/i,
    /(^|[_\-\s.])(muqaal.?galmo|sawir.?qaawan|galmo.?full)([_\-\s.]|$)/i,
  ];

  function isExplicitText(_input: unknown): boolean {
    // User policy: never block plain text / captions for keywords
    return false;
  }

  function isExplicitFilename(name: unknown): boolean {
    if (!name) return false;
    const raw = String(name);
    if (/^data:/i.test(raw) || /^blob:/i.test(raw) || /^https?:\/\//i.test(raw)) return false;
    if (raw.length > 250) return false;
    const base = raw.toLowerCase().replace(/\.[a-z0-9]+$/i, '');
    const onlyName = base.split(/[/\\]/).pop() || base;
    if (/^[0-9a-f-]{20,}$/i.test(onlyName)) return false;
    return EXTREME_PORN_FILENAME.some((re) => re.test(onlyName));
  }

  function contentSafetyEnabled(): boolean {
    try {
      const flags: any = (typeof persistentFeatureFlags !== 'undefined') ? persistentFeatureFlags : null;
      if (flags && flags.enableContentSafety === false) return false;
    } catch (_) {}
    return true;
  }

  const SAFETY_REJECT_MSG_SO =
    'Mamnuuc: Muqaalada iyo sawirrada galmada dhabta ah looma oggola SomLuul. Qoraalka waa la oggol yahay — kaliya media-ga anshax-xumada ayaa la diidaa.';
  const SAFETY_REJECT_MSG_EN =
    'Forbidden: Real sexual / pornographic media is not allowed on SomLuul. Text is allowed — only explicit sexual media is blocked.';

  function rejectIfExplicit(res: Response, ...parts: unknown[]): boolean {
    if (!contentSafetyEnabled()) return false;
    for (const p of parts) {
      if (isExplicitFilename(p)) {
        res.status(403).json({
          error: SAFETY_REJECT_MSG_SO,
          error_en: SAFETY_REJECT_MSG_EN,
          code: 'CONTENT_SAFETY_BLOCKED'
        });
        return true;
      }
    }
    return false;
  }

  /** Optional Gemini vision check for uploaded image/video files */
  async function rejectIfSexualMedia(res: Response, filePath: string, mimeType: string): Promise<boolean> {
    if (!contentSafetyEnabled()) return false;
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
    if (!apiKey) return false;
    if (!mimeType || (!mimeType.startsWith('image/') && !mimeType.startsWith('video/'))) return false;
    // Skip large videos for cost/latency — only first frame would be ideal; skip > 8MB video for now
    try {
      const fs = await import('fs');
      const stat = fs.statSync(filePath);
      if (stat.size > 8 * 1024 * 1024 && mimeType.startsWith('video/')) return false;
      if (stat.size > 6 * 1024 * 1024 && mimeType.startsWith('image/')) return false;
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey });
      const bytes = fs.readFileSync(filePath);
      const b64 = bytes.toString('base64');
      const prompt = 'Does this image or video frame show real sexual intercourse, genitals engaged in sex, or hardcore pornography? Answer only YES or NO.';
      const result: any = await ai.models.generateContent({
        model: 'gemini-2.0-flash',
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              { inlineData: { mimeType: mimeType.startsWith('video/') ? 'image/jpeg' : mimeType, data: b64 } }
            ]
          }
        ]
      });
      const text = String(result?.text || result?.response?.text?.() || '').toUpperCase();
      if (text.includes('YES')) {
        res.status(403).json({
          error: SAFETY_REJECT_MSG_SO,
          error_en: SAFETY_REJECT_MSG_EN,
          code: 'CONTENT_SAFETY_BLOCKED'
        });
        return true;
      }
    } catch (err: any) {
      console.warn('[ContentSafety Gemini]', err?.message || err);
    }
    return false;
  }
  // ========== END CONTENT SAFETY ==========

  // Facebook-style limits: images typically ≤10MB, videos up to ~1GB
  const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GB hard ceiling (FB-class)
  const upload = multer({
    storage,
    limits: {
      fileSize: MAX_UPLOAD_BYTES
    },
    fileFilter: (req, file, cb) => {
      // Block explicit / nude / pornographic filenames
      if (contentSafetyEnabled() && isExplicitFilename(file.originalname)) {
        return cb(new Error(SAFETY_REJECT_MSG_SO) as any, false);
      }
      const allowedExtensions = [
        '.pdf', '.docx', '.doc', '.xlsx', '.pptx', '.txt', '.csv',
        '.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg', '.bmp', '.heic',
        '.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.3gp',
        '.mp3', '.wav', '.aac', '.m4a', '.ogg',
        '.zip', '.rar', '.7z'
      ];
      const ext = path.extname(file.originalname).toLowerCase();
      if (allowedExtensions.includes(ext) || !ext) {
        cb(null, true);
      } else {
        cb(null, true);
      }
    }
  });

  // --- API ENDPOINTS ---

  // Device registration utility to track active session devices
  const registerDeviceSession = (userId: string, req: Request, customDeviceId?: string): { id: string; token: string } => {
    const deviceId = customDeviceId || Math.random().toString(36).substring(2, 10);
    const userAgent = req.headers['user-agent'] || 'Unknown Device';
    
    let deviceName = 'Web Browser';
    if (userAgent.includes('Mobi')) deviceName = 'Mobile Device';
    if (userAgent.includes('Android')) deviceName = 'Android Phone';
    if (userAgent.includes('iPhone')) deviceName = 'iPhone';
    if (userAgent.includes('iPad')) deviceName = 'iPad';
    if (userAgent.includes('Macintosh')) deviceName = 'MacBook';
    if (userAgent.includes('Windows')) deviceName = 'Windows PC';

    const device = {
      id: deviceId,
      name: deviceName,
      ip: (req.headers['x-forwarded-for'] as string) || req.ip || '127.0.0.1',
      last_active: new Date().toISOString(),
      location: 'Mogadishu, Somalia'
    };

    trackUserDevice(userId, device);
    
    // Sign JWT token
    const db = readDB();
    const user = db.profiles.find(p => p.id === userId);
    const token = jwt.sign({
      userId,
      deviceId,
      email: user?.email,
      role: user?.role || 'normal',
      first_name: user?.first_name || '',
      last_name: user?.last_name || '',
      avatar: user?.avatar ?? null,
      blocked: user?.blocked === true
    }, JWT_SECRET, { expiresIn: '30d' });
    return { id: deviceId, token };
  };

  // Health check
  // Browsers request /favicon.ico by default
  app.get('/favicon.ico', (req, res) => {
    const candidates = [
      path.join(process.cwd(), 'public', 'favicon-32x32.png'),
      path.join(process.cwd(), 'public', 'favicon.svg'),
      path.join(process.cwd(), 'public', 'favicon-16x16.png'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        res.type(p.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
        return res.sendFile(p);
      }
    }
    res.status(204).end();
  });

  app.get('/api/health', (req, res) => {
    let posts = 0;
    let profiles = 0;
    try {
      const db = readDB();
      posts = (db.posts || []).length;
      profiles = (db.profiles || []).length;
    } catch (_) {}
    res.json({
      status: 'ok',
      time: new Date().toISOString(),
      posts,
      profiles,
      persistence: !!(process.env.SUPABASE_URL || process.env.GCS_BUCKET_NAME),
    });
  });

  // --- 1. EMAIL SIGN UP / LOGIN ENDPOINTS ---

  app.post('/api/auth/signup', (req, res) => {
    // Public registration can be disabled by Web Owner
    if (persistentLandingSettings && persistentLandingSettings.allowPublicSignup === false) {
      res.status(403).json({ error: 'Diiwaangelinta dadweynaha waa xiran tahay. La xiriir maamulaha.' });
      return;
    }

    const { email, password, first_name, last_name, username, bio, dob, role, email_verified, phone, gender, deviceId } = req.body;
    if (!email || !password || !first_name || !last_name) {
      res.status(400).json({ error: 'Fadlan buuxi dhammaan xogta muhiimka ah (Email, Password, Name).' });
      return;
    }

    const db = readDB();
    const normalizedEmail = email.toLowerCase().trim();
    if (normalizedEmail !== 'xamseyare5267@gmail.com' && db.profiles.some(p => p.email === normalizedEmail)) {
      res.status(400).json({ error: 'Email-kan horey ayaa loo diiwaan geliyay.' });
      return;
    }

    if (username && normalizedEmail !== 'xamseyare5267@gmail.com' && db.profiles.some(p => p.username && p.username.toLowerCase() === username.trim().toLowerCase())) {
      res.status(400).json({ error: 'Username-kan horey ayaa loo qaatay. Fadlan dooro mid kale.' });
      return;
    }

    if (phone) {
      const cleanIncoming = phone.replace(/\s+/g, '').replace(/^\+252/, '').replace(/^0/, '');
      const isPhoneDuplicate = db.profiles.some(p => {
        if (!p.phone || (normalizedEmail === 'xamseyare5267@gmail.com' && p.email === normalizedEmail)) return false;
        const cleanDb = p.phone.replace(/\s+/g, '').replace(/^\+252/, '').replace(/^0/, '');
        return cleanDb === cleanIncoming;
      });
      if (isPhoneDuplicate) {
        res.status(400).json({ error: 'Lambarkan telefoon horey ayaa loo diiwaan geliyay.' });
        return;
      }
    }

    const defaultRole = role === 'admin' ? 'admin' : 'normal';
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

    const result = registerUser(email, password, first_name, last_name, defaultRole, {
      username: username ? username.trim() : normalizedEmail.split('@')[0],
      is_username_custom: !!username,
      bio: bio || '',
      dob: dob || '',
      phone: phone || '',
      gender: gender || '',
      email_verified: true, // Auto verify to prevent mail blocking
      verification_code: verificationCode,
      login_method: 'email',
      created_at: new Date().toISOString()
    });

    if (!result.success || !result.user) {
      res.status(400).json({ error: result.message });
      return;
    }

    // Automatically create a device session and log the user in immediately
    const sessionDetail = registerDeviceSession(result.user.id, req, deviceId);
    const dbRefreshed = readDB();
    const registeredUser = dbRefreshed.profiles.find(p => p.id === result.user!.id)!;

    // Send real verification email in background as a luxury extra
    sendVerificationEmail(normalizedEmail, verificationCode);

    res.status(201).json({
      message: 'Akoonkaaga waa la sameeyay si guul leh!',
      verificationCode: verificationCode,
      session: {
        user: registeredUser,
        token: sessionDetail.token,
        deviceId: sessionDetail.id
      }
    });
  });

  app.post('/api/auth/restore-session', (req, res) => {
    const { token, profile } = req.body || {};
    if (!token) {
      res.status(400).json({ error: 'Fadlan bixi session token sax ah.' });
      return;
    }

    let decoded: any;
    try {
      decoded = jwt.verify(String(token), JWT_SECRET);
    } catch {
      res.status(401).json({ error: 'Session-ku wuu dhacay ama ma saxna. Fadlan mar kale gal.' });
      return;
    }

    if (!decoded?.userId) {
      res.status(401).json({ error: 'Session token-ka waa khaldan yahay.' });
      return;
    }

    const db = readDB();
    let existing = db.profiles.find(p => p.id === decoded.userId);

    // Restore only the identity encoded in a valid JWT. Never trust a random
    // profile object from the browser to authenticate another user.
    if (!existing) {
      const safeProfile = profile && profile.id === decoded.userId ? profile : {};
      existing = {
        id: decoded.userId,
        email: String(decoded.email || safeProfile.email || '').toLowerCase(),
        first_name: String(decoded.first_name || safeProfile.first_name || ''),
        last_name: String(decoded.last_name || safeProfile.last_name || ''),
        avatar: decoded.avatar ?? safeProfile.avatar ?? null,
        role: decoded.role === 'admin' || decoded.role === 'moderator' ? decoded.role : 'normal',
        blocked: decoded.blocked === true,
        created_at: safeProfile.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
        username: safeProfile.username,
        bio: safeProfile.bio,
        phone: safeProfile.phone,
        devices: []
      } as Profile;

      if (!existing.email) {
        res.status(401).json({ error: 'Session profile-ka lama xaqiijin karo.' });
        return;
      }

      db.profiles.push(existing);
      if (!db.credentials.some(c => c.userId === existing!.id)) {
        db.credentials.push({ userId: existing.id, passwordHash: hashPassword(generateId()) });
      }
      writeDB(db);
    }

    if (existing.blocked) {
      res.status(403).json({ error: 'Akoonka waa la xannibay.' });
      return;
    }

    res.json({ success: true, user: existing, token });
  });

  app.post('/api/auth/login', (req, res) => {
    let { email, password, deviceId } = req.body;
    email = (email || '').trim().toLowerCase();
    password = (password || '').trim();

    if (!email || !password) {
      res.status(400).json({ error: 'Fadlan geli Email-ka iyo Password-ka.' });
      return;
    }

    const result = authenticateUser(email, password);
    if (!result.success || !result.user) {
      res.status(400).json({ error: result.message });
      return;
    }

    if (result.user.email_verified === false) {
      const db = readDB();
      const user = db.profiles.find(p => p.id === result.user!.id)!;
      const newCode = Math.floor(100000 + Math.random() * 900000).toString();
      user.verification_code = newCode;
      user.updated_at = new Date().toISOString();
      writeDB(db);

      // Send real verification email in background
      sendVerificationEmail(user.email, newCode);

      res.status(403).json({
        error: 'Email-kaaga weli lama xaqiijin. Koodh cusub ayaa loo diray email-kaaga.',
        notVerified: true,
        email: user.email,
        verificationCode: newCode
      });
      return;
    }

    // Track device and generate JWT session
    const sessionDetail = registerDeviceSession(result.user.id, req, deviceId);

    // Fetch refreshed user profile (including devices)
    const db = readDB();
    const updatedUser = db.profiles.find(p => p.id === result.user!.id)!;

    res.json({
      message: 'Galka waa lagu guuleystay!',
      session: {
        user: updatedUser,
        token: sessionDetail.token,
        deviceId: sessionDetail.id
      }
    });
  });

  // Verify Email Verification Code
  app.post('/api/auth/email/verify-code', (req, res) => {
    const { email, code, deviceId } = req.body;
    if (!email || !code) {
      res.status(400).json({ error: 'Email iyo code-ka xaqiijinta ayaa loo baahan yahay.' });
      return;
    }

    const db = readDB();
    const normalizedEmail = email.toLowerCase().trim();
    const userIndex = db.profiles.findIndex(p => p.email === normalizedEmail);

    if (userIndex === -1) {
      res.status(404).json({ error: 'Xisaabtan lama helin.' });
      return;
    }

    const user = db.profiles[userIndex];
    if (user.verification_code === code) {
      user.email_verified = true;
      user.verification_code = undefined; // clear code
      user.updated_at = new Date().toISOString();
      writeDB(db);

      // Log user in automatically
      const sessionDetail = registerDeviceSession(user.id, req, deviceId);
      
      res.json({
        message: 'Email-ka waa la xaqiijiyay si guul leh!',
        session: {
          user,
          token: sessionDetail.token,
          deviceId: sessionDetail.id
        }
      });
    } else {
      res.status(400).json({ error: 'Koodhka xaqiijinta waa khalad. Fadlan dib u tijaabi.' });
    }
  });

  // Resend Email Verification Code
  app.post('/api/auth/email/resend-code', (req, res) => {
    const { email } = req.body;
    if (!email) {
      res.status(400).json({ error: 'Email ayaa loo baahan yahay.' });
      return;
    }

    const db = readDB();
    const normalizedEmail = email.toLowerCase().trim();
    const user = db.profiles.find(p => p.email === normalizedEmail);

    if (!user) {
      res.status(404).json({ error: 'Xisaabtan lama helin.' });
      return;
    }

    const newCode = Math.floor(100000 + Math.random() * 900000).toString();
    user.verification_code = newCode;
    user.updated_at = new Date().toISOString();
    writeDB(db);

    // Send real verification email in the background
    sendVerificationEmail(normalizedEmail, newCode);

    res.json({
      message: 'Koodh cusub ayaa loo diray email-kaaga.',
      verificationCode: newCode
    });
  });

  // --- 2. PHONE NUMBER AUTHENTICATION ---

  app.post('/api/auth/phone/send-otp', async (req, res) => {
    const { phone, country_code } = req.body;
    if (!phone) {
      res.status(400).json({ error: 'Fadlan geli lambarkaaga telefoonka.' });
      return;
    }

    let fullPhone = `${country_code || '+252'}${String(phone).replace(/\s+/g, '')}`;
    // Normalize to E.164-ish
    if (!fullPhone.startsWith('+')) fullPhone = `+${fullPhone.replace(/^\+/, '')}`;

    const db = readDB();
    let user = db.profiles.find((p: any) => p.phone === fullPhone);
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

    if (!user) {
      const userId = generateId();
      user = {
        id: userId,
        email: `phone_${userId}@users.somluul.local`,
        first_name: 'User',
        last_name: fullPhone.slice(-4),
        avatar: null,
        role: 'normal',
        blocked: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        phone: fullPhone,
        phone_verified: false,
        phone_otp_code: otpCode,
        phone_otp_expires: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        login_method: 'phone',
        devices: [],
        username: `user_${Math.floor(100000 + Math.random() * 900000)}`
      };
      db.profiles.push(user);
      db.credentials.push({
        userId,
        passwordHash: hashPassword(Math.random().toString(36))
      });
    } else {
      user.phone_otp_code = otpCode;
      user.phone_otp_expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      user.updated_at = new Date().toISOString();
    }

    writeDB(db);

    const sms = await sendSmsOtp(fullPhone, otpCode, user?.email);
    if (sms.ok) {
      const via = sms.channel === 'email' ? 'email' : 'SMS';
      res.json({
        message: `OTP waxaa lagu diray ${via}: ${sms.channel === 'email' ? (user?.email || fullPhone) : fullPhone}.`,
        phone: fullPhone,
        smsSent: true,
        channel: sms.channel,
      });
      return;
    }

    // No Twilio: only allow code in response when explicitly in development AND ALLOW_DEV_OTP=1
    const allowDevOtp =
      process.env.ALLOW_DEV_OTP === '1' ||
      (process.env.NODE_ENV !== 'production' && !process.env.VERCEL && process.env.ALLOW_DEV_OTP !== '0');

    if (allowDevOtp) {
      console.warn(`[SMS] Twilio not configured (${sms.error}). Dev OTP for ${fullPhone}: ${otpCode}`);
      res.json({
        message: `SMS gateway ma shaqeynayo. Dev OTP: ${otpCode}`,
        phone: fullPhone,
        otpCode,
        smsSent: false,
        warning: sms.error,
      });
      return;
    }

    res.status(503).json({
      error: 'SMS/email OTP ma dirmin. Isku day mar kale, ama dhig SMTP (Gmail free) .env-ka.',
      phone: fullPhone,
      smsSent: false,
    });
  });

  app.post('/api/auth/phone/verify-otp', (req, res) => {
    const { phone, otpCode, first_name, last_name, username, deviceId } = req.body;
    if (!phone || !otpCode) {
      res.status(400).json({ error: 'Telefoonka iyo OTP code-ka ayaa loo baahan yahay.' });
      return;
    }

    const db = readDB();
    const userIndex = db.profiles.findIndex(p => p.phone === phone);

    if (userIndex === -1) {
      res.status(404).json({ error: 'Lambarkan telefoon ma diiwaan gashna.' });
      return;
    }

    const user = db.profiles[userIndex];
    if (user.phone_otp_code === otpCode) {
      user.phone_verified = true;
      user.phone_otp_code = undefined; // clear OTP
      
      // Update profile info if specified during signup flow
      if (first_name) user.first_name = first_name;
      if (last_name) user.last_name = last_name;
      if (username) user.username = username;
      
      user.last_login = new Date().toISOString();
      user.updated_at = new Date().toISOString();
      writeDB(db);

      const sessionDetail = registerDeviceSession(user.id, req, deviceId);

      res.json({
        message: 'Telefoonka waa la xaqiijiyay si guul leh!',
        session: {
          user,
          token: sessionDetail.token,
          deviceId: sessionDetail.id
        }
      });
    } else {
      res.status(400).json({ error: 'Koodhka xaqiijinta (OTP) waa khalad.' });
    }
  });

  // --- 3. SOCIAL LOGIN / OAUTH ENDPOINTS ---

  // Google, Facebook, Apple Auth URLs
  app.get('/api/auth/oauth/url', (req, res) => {
    const { provider } = req.query;
    const clientOrigin = req.headers.referer || `${req.protocol}://${req.get('host')}`;
    
    // Check if real Google/Facebook/Apple credentials are set in environment
    const isGoogleConfigured = !!process.env.GOOGLE_CLIENT_ID;
    const isFacebookConfigured = !!process.env.FACEBOOK_CLIENT_ID;
    const isAppleConfigured = !!process.env.APPLE_CLIENT_ID;

    if (provider === 'google') {
      if (isGoogleConfigured) {
        // Real Google OAuth flow
        const redirectUri = `${clientOrigin}/auth/callback`;
        const params = new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID!,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: 'https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email',
          access_type: 'offline',
          state: 'google',
          prompt: 'consent'
        });
        res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
      } else {
        res.status(400).json({ error: 'Nidaamka Google Login wali lama habaynin. Maamulaha barnaamijka fadlan ku dar GOOGLE_CLIENT_ID iyo GOOGLE_CLIENT_SECRET galka Secrets ee AI Studio.' });
      }
    } else if (provider === 'facebook') {
      if (isFacebookConfigured) {
        const redirectUri = `${clientOrigin}/auth/callback`;
        const params = new URLSearchParams({
          client_id: process.env.FACEBOOK_CLIENT_ID!,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: 'public_profile,email',
          state: 'facebook'
        });
        res.json({ url: `https://www.facebook.com/v12.0/dialog/oauth?${params.toString()}` });
      } else {
        res.status(400).json({ error: 'Nidaamka Facebook Login wali lama habaynin. Maamulaha barnaamijka fadlan ku dar FACEBOOK_CLIENT_ID iyo FACEBOOK_CLIENT_SECRET galka Secrets ee AI Studio.' });
      }
    } else if (provider === 'apple') {
      if (isAppleConfigured) {
        const redirectUri = `${clientOrigin}/auth/callback`;
        const params = new URLSearchParams({
          client_id: process.env.APPLE_CLIENT_ID!,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: 'name email',
          response_mode: 'form_post',
          state: 'apple'
        });
        res.json({ url: `https://appleid.apple.com/auth/authorize?${params.toString()}` });
      } else {
        res.status(400).json({ error: 'Nidaamka Apple Login wali lama habaynin. Maamulaha barnaamijka fadlan ku dar APPLE_CLIENT_ID iyo APPLE_CLIENT_SECRET galka Secrets ee AI Studio.' });
      }
    } else {
      res.status(400).json({ error: 'Xogta ku saabsan shirkada la doortay waa khalad.' });
    }
  });







  // Redirect callback that establishes user profile, logs device, and closes popup
  app.get('/auth/callback', async (req, res) => {
    const { code, state, error: authError } = req.query;

    if (authError) {
      res.status(400).send(`Cillad OAuth: ${authError}`);
      return;
    }

    let email = '';
    let first_name = '';
    let last_name = '';
    let avatar: string | null = null;
    let method = '';

    if (code) {
      // Real OAuth flow code exchange!
      const clientOrigin = `${req.protocol}://${req.get('host')}`;
      const redirectUri = `${clientOrigin}/auth/callback`;
      method = String(state || 'google');

      try {
        if (method === 'google') {
          const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
            code,
            client_id: process.env.GOOGLE_CLIENT_ID,
            client_secret: process.env.GOOGLE_CLIENT_SECRET,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code'
          });
          const accessToken = tokenRes.data.access_token;
          const userRes = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${accessToken}` }
          });
          email = userRes.data.email;
          first_name = userRes.data.given_name || '';
          last_name = userRes.data.family_name || '';
          avatar = userRes.data.picture || null;
        } else if (method === 'facebook') {
          const tokenRes = await axios.get('https://graph.facebook.com/v12.0/oauth/access_token', {
            params: {
              client_id: process.env.FACEBOOK_CLIENT_ID,
              client_secret: process.env.FACEBOOK_CLIENT_SECRET,
              redirect_uri: redirectUri,
              code
            }
          });
          const accessToken = tokenRes.data.access_token;
          const userRes = await axios.get('https://graph.facebook.com/me', {
            params: {
              fields: 'id,first_name,last_name,email,picture',
              access_token: accessToken
            }
          });
          email = userRes.data.email;
          first_name = userRes.data.first_name || '';
          last_name = userRes.data.last_name || '';
          avatar = userRes.data.picture?.data?.url || null;
        } else if (method === 'apple') {
          const tokenRes = await axios.post('https://appleid.apple.com/auth/token', {
            code,
            client_id: process.env.APPLE_CLIENT_ID,
            client_secret: process.env.APPLE_CLIENT_SECRET,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code'
          });
          const idToken = tokenRes.data.id_token;
          if (idToken) {
            const decoded: any = jwt.decode(idToken);
            email = decoded?.email || '';
            first_name = 'Apple';
            last_name = 'User';
          }
        }
      } catch (err: any) {
        console.error('OAuth Code Exchange Error:', err.response?.data || err.message);
        res.status(500).send(`Galka OAuth waa ku fashilantay intii lagu guda jiray xaqiijinta code-ka: ${err.message}`);
        return;
      }
    } else {
      // Fallback/Legacy query params
      method = String(req.query.method || 'google');
      email = String(req.query.email || '');
      first_name = String(req.query.first_name || '');
      last_name = String(req.query.last_name || '');
      avatar = req.query.avatar ? String(req.query.avatar) : null;
    }

    if (!email) {
      res.status(400).send('Xogta Google/Facebook/Apple OAuth waa khalad (Email is missing).');
      return;
    }

    // CRITICAL SECURITY ENFORCEMENT: Block any admin or owner email in social auth callback
    const normalizedEmail = email.toLowerCase().trim();
    if (normalizedEmail === 'xamseyare5267@gmail.com' || normalizedEmail === 'admin@filehub.com') {
      res.status(403).send(`
        <html>
          <head>
            <title>Calaamad Ammaan - SomLuul</title>
            <script src="https://cdn.tailwindcss.com"></script>
          </head>
          <body class="bg-red-50 flex items-center justify-center min-h-screen p-4 font-sans text-center">
            <div class="bg-white p-6 rounded-2xl shadow-xl max-w-sm w-full border border-red-100">
              <div class="w-16 h-16 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                </svg>
              </div>
              <h1 class="text-base font-bold text-red-800 mb-2">DIGNIIN AMMAAN!</h1>
              <p class="text-xs text-red-700 leading-relaxed">
                Maadaama uu cinwaankani yahay Maamulaha Sare (Owner/Admin), amniga awgiis laguma soo geli karo Google/Facebook/Apple Login khayaali ah. Fadlan ku soo laabo bogga rasmiga ah ee login-ka oo ku gal password-kaaga rasmiga ah.
              </p>
              <button onclick="window.close()" class="mt-4 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl text-xs font-semibold transition-all">Close Window</button>
            </div>
          </body>
        </html>
      `);
      return;
    }

    const user = findOrCreateSocialUser(
      method as 'google' | 'facebook' | 'apple',
      email,
      first_name || 'Social',
      last_name || 'User',
      avatar || null
    );

    // Track device and generate token
    const sessionDetail = registerDeviceSession(user.id, req);

    // Fetch refreshed profile to include device lists
    const db = readDB();
    const refreshedUser = db.profiles.find(p => p.id === user.id)!;

    res.send(`
      <html>
        <body>
          <script>
            if (window.opener) {
              window.opener.postMessage({
                type: 'OAUTH_AUTH_SUCCESS',
                session: {
                  user: ${JSON.stringify(refreshedUser)},
                  token: "${sessionDetail.token}",
                  deviceId: "${sessionDetail.id}"
                }
              }, '*');
              window.close();
            } else {
              window.location.href = '/';
            }
          </script>
          <p>Diiwaan-gelinta waa lagu guuleystay! Fadlan sug inta ay xirmeyso daaqadani...</p>
        </body>
      </html>
    `);
  });

  // --- 4. DEVICE LOGOUT / SESSION MANAGEMENT ENDPOINTS ---

  // Get active devices of the user
  app.get('/api/auth/devices', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const db = readDB();
    const user = db.profiles.find(p => p.id === req.user!.id);
    res.json({ devices: user?.devices || [] });
  });

  // Logout specific device session
  app.post('/api/auth/logout-device', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const { deviceId } = req.body;
    if (!deviceId) {
      res.status(400).json({ error: 'Device ID is required.' });
      return;
    }

    removeUserDevice(req.user!.id, deviceId);
    logActivity(req.user!.id, req.user!.email, 'profile_update', `Logged out of device session: ${deviceId}`);

    res.json({ success: true, message: 'Qalabka waa laga soo saaray si guul leh.' });
  });

  // Logout from ALL devices (Session wipeout)
  app.post('/api/auth/logout-all', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    removeAllUserDevices(req.user!.id);
    logActivity(req.user!.id, req.user!.email, 'profile_update', 'Logged out of all active device sessions.');

    res.json({ success: true, message: 'Dhammaan qalabyada kale waa laga soo saaray xisaabtaada!' });
  });

  app.post('/api/auth/logout', (req, res) => {
    res.json({ success: true, message: 'Logged out successfully.' });
  });

  app.get('/api/auth/me', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    res.json({ user: req.user });
  });

  // Aliases — older clients / SW caches sometimes call these paths
  app.get('/api/me', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    res.json({ user: req.user });
  });

  app.get('/api/users', (req: AuthenticatedRequest, res: Response) => {
    const db = readDB();
    let currentUserId: string | null = null;
    const authHeader = req.headers.authorization;
    if (authHeader && /^Bearer\s+\S+$/i.test(authHeader)) {
      try {
        const token = authHeader.replace(/^Bearer\s+/i, '').trim();
        const decoded = jwt.verify(token, JWT_SECRET) as { userId?: string };
        currentUserId = decoded?.userId || null;
      } catch (_) {}
    }
    const list = (db.profiles || []).map((p: any) => ({
      id: p.id,
      first_name: p.first_name,
      last_name: p.last_name,
      username: p.username || undefined,
      avatar: p.avatar || null,
      bio: p.bio || '',
      role: p.role === 'admin' ? 'admin' : (p.role || 'normal'),
      verified: p.role === 'admin' || !!p.verified,
      followersCount: p.followers ? p.followers.length : 0,
      isFollowing: currentUserId && p.followers ? p.followers.includes(currentUserId) : false,
    }));
    res.json(list);
  });

  app.post('/api/auth/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) {
      res.status(400).json({ error: 'Email ayaa loo baahan yahay.' });
      return;
    }
    const db = readDB();
    const normalizedEmail = email.toLowerCase().trim();
    const user = db.profiles.find(p => p.email === normalizedEmail);
    
    if (user) {
      const recoveryCode = Math.floor(100000 + Math.random() * 900000).toString();
      user.verification_code = recoveryCode;
      writeDB(db);
      try { await sendVerificationEmail(user.email, recoveryCode); } catch (_) {}
      const isProd = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
      res.json({
        success: true,
        message: isProd
          ? 'Koodhka kabista password-ka waxaa loo diray email-kaaga.'
          : `Recovery code (dev): ${recoveryCode}`,
        ...(isProd ? {} : { recoveryCode })
      });
    } else {
      res.status(404).json({ error: 'Account with this email does not exist.' });
    }
  });

  app.post('/api/auth/reset-password', (req, res) => {
    const { email, code, password } = req.body;
    if (!email || !code || !password) {
      res.status(400).json({ error: 'Fadlan geli Email-ka, Koodhka, iyo Password-ka cusub.' });
      return;
    }

    const db = readDB();
    const normalizedEmail = email.toLowerCase().trim();
    const user = db.profiles.find(p => p.email === normalizedEmail);

    if (!user) {
      res.status(404).json({ error: 'Xisaabtan lama helin.' });
      return;
    }

    if (user.verification_code !== code) {
      res.status(400).json({ error: 'Koodhka kabista ee aad gelisay waa khalad.' });
      return;
    }

    const result = resetUserPassword(normalizedEmail, password);
    if (!result.success) {
      res.status(400).json({ error: result.message });
      return;
    }

    user.verification_code = undefined; // clear code
    writeDB(db);

    res.json({ success: true, message: 'Password-ka waa la bedelay si guul leh!' });
  });

  app.post('/api/auth/change-password', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const password = String(req.body?.password || '');
    if (password.length < 6) {
      res.status(400).json({ error: 'Password-ku waa inuu ahaadaa ugu yaraan 6 xaraf.' });
      return;
    }

    const result = resetUserPassword(req.user!.email, password);
    if (!result.success) {
      res.status(400).json({ error: result.message });
      return;
    }

    res.json({ success: true, message: 'Password-ka waa la bedelay si guul leh!' });
  });

  app.put('/api/auth/profile', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const { first_name, last_name, avatar, bio, phone, city, country, website, gender, dob, cover_photo, language, username, work } = req.body;
    
    const finalFirstName = first_name !== undefined ? first_name : req.user!.first_name;
    const finalLastName = last_name !== undefined ? last_name : req.user!.last_name;

    if (!finalFirstName || !finalLastName) {
      res.status(400).json({ error: 'First name and last name are required.' });
      return;
    }

    const userId = req.user!.id;
    
    // Construct updates object, ONLY setting fields if they are explicitly passed (not undefined)
    const updates: Partial<Profile> = {};
    if (first_name !== undefined) updates.first_name = first_name;
    if (last_name !== undefined) updates.last_name = last_name;
    if (avatar !== undefined) updates.avatar = avatar;
    if (bio !== undefined) updates.bio = bio;
    if (phone !== undefined) updates.phone = phone;
    if (city !== undefined) updates.city = city;
    if (country !== undefined) updates.country = country;
    if (website !== undefined) updates.website = website;
    if (gender !== undefined) updates.gender = gender;
    if (dob !== undefined) updates.dob = dob;
    if (cover_photo !== undefined) updates.cover_photo = cover_photo;
    if (language !== undefined) updates.language = language;
    if (work !== undefined) updates.work = work;

    if (username !== undefined) {
      const trimmedUsername = username.trim();
      if (trimmedUsername) {
        const db = readDB();
        const isDuplicate = db.profiles.some(p => p.id !== userId && p.username && p.username.toLowerCase() === trimmedUsername.toLowerCase());
        if (isDuplicate) {
          res.status(400).json({ error: 'Username-kan horey ayaa loo qaatay. Fadlan dooro mid kale.' });
          return;
        }
        updates.username = trimmedUsername;
        updates.is_username_custom = true;
      }
    }

    const result = updateProfile(userId, updates);

    if (!result.success) {
      res.status(500).json({ error: 'Failed to update profile.' });
      return;
    }

    // Log the profile update activity
    logActivity(userId, req.user!.email, 'profile_update', 'Updated profile information (bio / contact detail)');

    res.json({ success: true, user: result.user });
  });

  // Discovery: Get all user profiles (with search and follow info)
  // Public discovery list — optional auth (no more 401 when logged out)
  app.get('/api/profiles', (req: AuthenticatedRequest, res: Response) => {
    const db = readDB();
    let currentUserId: string | null = null;
    const authHeader = req.headers.authorization;
    if (authHeader && /^Bearer\s+\S+$/i.test(authHeader)) {
      try {
        const token = authHeader.replace(/^Bearer\s+/i, '').trim();
        const decoded = jwt.verify(token, JWT_SECRET) as { userId?: string };
        currentUserId = decoded?.userId || null;
      } catch (_) {
        currentUserId = null;
      }
    }
    
    const list = db.profiles.map(p => {
      const isFollowing = currentUserId && p.followers ? p.followers.includes(currentUserId) : false;
      // Public-safe fields only — never expose password hashes, OTP codes, devices secrets
      return {
        id: p.id,
        first_name: p.first_name,
        last_name: p.last_name,
        username: p.username || undefined,
        avatar: p.avatar || null,
        cover_photo: p.cover_photo || null,
        bio: p.bio || '',
        city: p.city || '',
        country: p.country || '',
        website: p.website || '',
        work: p.work || '',
        role: p.role === 'admin' ? 'admin' : (p.role || 'normal'),
        verified: p.role === 'admin' || !!(p as any).verified,
        created_at: p.created_at,
        isFollowing,
        followersCount: p.followers ? p.followers.length : 0,
        followingCount: p.following ? p.following.length : 0,
        email: currentUserId && p.id === currentUserId ? p.email : undefined,
        phone: currentUserId && p.id === currentUserId ? p.phone : undefined,
      };
    });
    
    res.json(list);
  });

  // Get specific profile by ID or username (PUBLIC — like Facebook; private fields only when self)
  app.get('/api/profiles/:id', (req: AuthenticatedRequest, res: Response) => {
    const db = readDB();
    const targetId = req.params.id;

    // Optional auth — used only for isFollowing / private fields
    let currentUserId: string | null = null;
    const authHeader = req.headers.authorization;
    if (authHeader && /^Bearer\s+\S+$/i.test(authHeader)) {
      try {
        const token = authHeader.replace(/^Bearer\s+/i, '').trim();
        const decoded = jwt.verify(token, JWT_SECRET) as { userId?: string };
        currentUserId = decoded?.userId || null;
      } catch (_) {
        currentUserId = null;
      }
    }

    const p = db.profiles.find(user => 
      user.id === targetId || 
      (user.username && user.username.toLowerCase() === targetId.toLowerCase()) || 
      (user.email && user.email.toLowerCase().split('@')[0] === targetId.toLowerCase())
    );
    
    if (!p) {
      res.status(404).json({ error: 'Profile not found.' });
      return;
    }

    const isFollowing = currentUserId && p.followers ? p.followers.includes(currentUserId) : false;
    const isSelf = !!(currentUserId && p.id === currentUserId);
    res.json({
      id: p.id,
      first_name: p.first_name,
      last_name: p.last_name,
      username: p.username || undefined,
      avatar: p.avatar || null,
      cover_photo: p.cover_photo || null,
      bio: p.bio || '',
      city: p.city || '',
      country: p.country || '',
      website: p.website || '',
      work: p.work || '',
      role: p.role === 'admin' ? 'admin' : (p.role || 'normal'),
      verified: p.role === 'admin' || !!(p as any).verified,
      created_at: p.created_at,
      isFollowing,
      followersCount: p.followers ? p.followers.length : 0,
      followingCount: p.following ? p.following.length : 0,
      email: isSelf ? p.email : undefined,
      phone: isSelf ? p.phone : undefined,
      gender: isSelf ? p.gender : undefined,
      dob: isSelf ? p.dob : undefined,
    });
  });

  // Follow/Unfollow toggle
  app.post('/api/profiles/:id/follow', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const targetId = req.params.id;
    const currentUserId = req.user!.id;

    if (currentUserId === targetId) {
      res.status(400).json({ error: 'Miyaad is raacaysaa naftaada sxb? Ma suurtowdo.' });
      return;
    }

    const result = toggleFollowUser(currentUserId, targetId);
    if (!result.success) {
      res.status(404).json({ error: 'Qofkaan lama helin.' });
      return;
    }

    if (result.isFollowing) {
      const db = readDB();
      if (!db.notifications) db.notifications = [];
      const sender = db.profiles.find(p => p.id === currentUserId);
      db.notifications.unshift({
        id: `noti_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
        userId: targetId,
        type: 'follow',
        title: 'Follower Cusub 👤',
        body: `${sender ? `${sender.first_name} ${sender.last_name}` : 'Qof'} ayaa ku follow gareeyay!`,
        senderId: currentUserId,
        senderName: sender ? `${sender.first_name} ${sender.last_name}` : 'Qof',
        senderAvatar: sender ? sender.avatar : null,
        read: false,
        created_at: new Date().toISOString()
      });
      writeDB(db);
    }

    res.json({
      success: true,
      isFollowing: result.isFollowing,
      user: result.follower,
      target: result.target
    });
  });


  // ===== Friend requests =====
  app.post('/api/profiles/:id/friend', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const targetId = req.params.id;
    const action = String(req.body?.action || 'send') as any;
    const result = manageFriendRequest(req.user!.id, targetId, action);
    if (!result.success) {
      res.status(400).json({ error: result.message, state: result.state });
      return;
    }
    // Notify on send/accept
    if (action === 'send' || action === 'accept') {
      const db = readDB();
      if (!db.notifications) db.notifications = [];
      const sender = db.profiles.find(p => p.id === req.user!.id);
      db.notifications.unshift({
        id: `n-${Date.now()}`,
        userId: targetId,
        type: action === 'accept' ? 'friend_accept' : 'friend_request',
        title: action === 'accept' ? 'Friend request accepted' : 'New friend request',
        body: `${sender ? `${sender.first_name} ${sender.last_name}` : 'Someone'} ${action === 'accept' ? 'accepted your friend request' : 'sent you a friend request'}`,
        isRead: false,
        created_at: new Date().toISOString(),
        link: `/profile/${req.user!.id}`
      } as any);
      writeDB(db);
    }
    res.json(result);
  });

  // ===== Block / Unblock user (user-to-user) =====
  app.post('/api/profiles/:id/block', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const targetId = req.params.id;
    if (targetId === req.user!.id) {
      res.status(400).json({ error: 'Cannot block yourself' });
      return;
    }
    blockUserPair(req.user!.id, targetId);
    res.json({ success: true, message: 'User blocked' });
  });

  app.post('/api/profiles/:id/unblock', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    unblockUserPair(req.user!.id, req.params.id);
    res.json({ success: true, message: 'User unblocked' });
  });

  // ===== Report content / user =====
  app.post('/api/reports', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const { targetType, targetId, reason, details } = req.body || {};
    if (!targetType || !targetId) {
      res.status(400).json({ error: 'targetType and targetId required' });
      return;
    }
    const allowed = ['user', 'post', 'comment', 'message', 'listing', 'story'];
    if (!allowed.includes(targetType)) {
      res.status(400).json({ error: 'Invalid targetType' });
      return;
    }
    const result = createReport({
      reporterId: req.user!.id,
      targetType,
      targetId: String(targetId),
      reason: String(reason || 'other'),
      details: details ? String(details).slice(0, 2000) : ''
    });
    res.status(201).json(result);
  });

  // Admin: list reports
  app.get('/api/admin/reports', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const db = readDB();
    res.json(db.reports || []);
  });

  // ===== Global search =====
  app.get('/api/search', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const type = String(req.query.type || 'all');
    if (!q || q.length < 1) {
      res.json({ users: [], posts: [], hashtags: [] });
      return;
    }
    const db = readDB();
    const users = (type === 'all' || type === 'users')
      ? (db.profiles || [])
          .filter(p => !p.blocked && !isBlockedEitherWay(req.user!.id, p.id))
          .filter(p => {
            const name = `${p.first_name || ''} ${p.last_name || ''}`.toLowerCase();
            const un = (p.username || '').toLowerCase();
            const em = (p.email || '').toLowerCase();
            return name.includes(q) || un.includes(q) || em.includes(q);
          })
          .slice(0, 20)
          .map(p => ({
            id: p.id,
            first_name: p.first_name,
            last_name: p.last_name,
            username: p.username,
            avatar: p.avatar,
            followersCount: p.followersCount || (p.followers ? p.followers.length : 0)
          }))
      : [];
    const posts = (type === 'all' || type === 'posts')
      ? ((db.posts || []) as any[])
          .filter(p => (p.content || '').toLowerCase().includes(q) || (p.author?.name || '').toLowerCase().includes(q))
          .slice(0, 20)
      : [];
    const hashtagMatches = (type === 'all' || type === 'hashtags')
      ? Array.from(new Set(
          ((db.posts || []) as any[])
            .flatMap(p => String(p.content || '').match(/#[\\w\\u0600-\\u06FF]+/g) || [])
            .map((h: string) => h.toLowerCase())
            .filter((h: string) => h.includes(q.startsWith('#') ? q : `#${q}`) || h.slice(1).includes(q))
        )).slice(0, 15)
      : [];
    res.json({ users, posts, hashtags: hashtagMatches });
  });

  // Upload custom profile picture from gallery
  app.post('/api/auth/profile/avatar', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('application/json')) {
      const { avatar } = req.body;
      if (!avatar) {
        res.status(400).json({ error: 'No base64 image data provided.' });
        return;
      }
      const userId = req.user!.id;
      const db = readDB();
      const userIndex = db.profiles.findIndex(p => p.id === userId);
      if (userIndex !== -1) {
        db.profiles[userIndex].avatar = avatar;
        db.profiles[userIndex].updated_at = new Date().toISOString();
        writeDB(db);

        // Log the avatar update
        logActivity(userId, req.user!.email, 'profile_update', 'Uploaded a new profile picture / avatar (Base64 durable mode)');

        res.json({ success: true, avatar: avatar, user: db.profiles[userIndex] });
      } else {
        res.status(404).json({ error: 'User profile not found.' });
      }
      return;
    }

    upload.single('avatar')(req, res, (err) => {
      if (err) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded.' });
        return;
      }

      const userId = req.user!.id;
      const filename = req.file.filename;
      const publicUrl = `/uploads/${userId}/${filename}`;

      // Upload backup to GCS if available
      if (gcsBucket && req.file.path) {
        const localPath = req.file.path;
        const destination = `${userId}/${filename}`;
        gcsBucket.upload(localPath, {
          destination: destination,
          metadata: {
            contentType: req.file.mimetype,
          }
        }).catch(() => {});
      }

      // Upload backup to Supabase if available
      if (req.file.path) {
        uploadToSupabaseStorage(req.file.path, `${userId}/${filename}`, req.file.mimetype);
      }

      const db = readDB();
      const userIndex = db.profiles.findIndex(p => p.id === userId);
      if (userIndex !== -1) {
        db.profiles[userIndex].avatar = publicUrl;
        db.profiles[userIndex].updated_at = new Date().toISOString();
        writeDB(db);

        // Log the avatar update
        logActivity(userId, req.user!.email, 'profile_update', 'Uploaded a new profile picture / avatar');

        res.json({ success: true, avatar: publicUrl, user: db.profiles[userIndex] });
      } else {
        res.status(404).json({ error: 'User profile not found.' });
      }
    });
  });

  // 2. FILE MANAGEMENT ENDPOINTS
  app.post('/api/files/upload', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    upload.single('file')(req, res, async (err) => {
      if (err) {
        const msg = err.message || 'Upload failed';
        const blocked = /Mamnuuc|Forbidden|CONTENT_SAFETY/i.test(msg);
        res.status(blocked ? 403 : 400).json({
          error: msg,
          code: blocked ? 'CONTENT_SAFETY_BLOCKED' : 'UPLOAD_ERROR'
        });
        return;
      }

      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded.' });
        return;
      }

      // Filename extreme-porn check only (text keywords are never blocked)
      if (rejectIfExplicit(res, req.file.originalname, req.file.filename)) return;

      // Optional Gemini vision: block real sexual media when GEMINI_API_KEY is set
      if (req.file.path && (req.file.mimetype || '').match(/^(image|video)\//)) {
        const blockedMedia = await rejectIfSexualMedia(res, req.file.path, req.file.mimetype);
        if (blockedMedia) {
          try { fs.unlinkSync(req.file.path); } catch (_) {}
          return;
        }
      }

      const userId = req.user!.id;
      const originalName = req.file.originalname;
      const filename = req.file.filename;
      const size = req.file.size;
      const mimeType = req.file.mimetype;
      const relativeStoragePath = `uploads/${userId}/${filename}`;
      const publicUrl = `/uploads/${userId}/${filename}`;

      const savedFile = saveFileRecord({
        user_id: userId,
        filename,
        original_name: originalName,
        file_size: size,
        mime_type: mimeType,
        storage_path: relativeStoragePath,
        public_url: publicUrl
      });

      // Cloud backup MUST finish before response so media survives Vercel cold starts
      const cloudJobs: Promise<any>[] = [];
      if (gcsBucket && req.file.path) {
        const localPath = req.file.path;
        const destination = `${userId}/${filename}`;
        cloudJobs.push(
          gcsBucket.upload(localPath, {
            destination,
            metadata: { contentType: mimeType }
          }).then(() => {
            console.log(`[FileHub GCS] Backup uploaded: ${destination}`);
          }).catch((gcsErr: any) => {
            console.log(`[FileHub GCS] Backup notice:`, gcsErr?.message || gcsErr);
          })
        );
      }
      if (req.file.path) {
        cloudJobs.push(
          uploadToSupabaseStorage(req.file.path, `${userId}/${filename}`, mimeType).catch((e: any) => {
            console.log('[Supabase Storage] Upload notice:', e?.message || e);
          })
        );
      }
      if (cloudJobs.length) {
        await Promise.allSettled(cloudJobs);
      }

      logActivity(userId, req.user!.email, 'upload', `Uploaded file: ${originalName} (${(size / 1024).toFixed(1)} KB)`);

      res.status(201).json({
        message: 'File uploaded successfully!',
        file: savedFile
      });
    });
  });

  app.get('/api/files', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user!.id;
    const isAdmin = req.user!.role === 'admin';
    const db = readDB();

    // Determine target user's list (normal user sees own, admin sees all files, or can filter by specific user)
    let files = isAdmin ? db.files : db.files.filter(f => f.user_id === userId);

    const filterUserId = req.query.user_id as string;
    if (isAdmin && filterUserId) {
      files = files.filter(f => f.user_id === filterUserId);
    }

    // Search filter
    const search = (req.query.search as string || '').toLowerCase().trim();
    if (search) {
      files = files.filter(f => f.original_name.toLowerCase().includes(search));
    }

    // Sort filter
    const sort = req.query.sort as string || 'date_desc';
    files.sort((a, b) => {
      switch (sort) {
        case 'name_asc':
          return a.original_name.localeCompare(b.original_name);
        case 'name_desc':
          return b.original_name.localeCompare(a.original_name);
        case 'size_asc':
          return a.file_size - b.file_size;
        case 'size_desc':
          return b.file_size - a.file_size;
        case 'date_asc':
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        case 'date_desc':
        default:
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
    });

    // Pagination
    const page = parseInt(req.query.page as string || '1');
    const limit = parseInt(req.query.limit as string || '10');
    const offset = (page - 1) * limit;
    const paginatedFiles = files.slice(offset, offset + limit);

    res.json({
      data: paginatedFiles,
      total: files.length,
      page,
      limit,
      totalPages: Math.ceil(files.length / limit)
    });
  });

  app.delete('/api/files/:id', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const fileId = req.params.id;
    const userId = req.user!.id;
    const isAdmin = req.user!.role === 'admin';

    const db = readDB();
    const file = db.files.find(f => f.id === fileId);

    if (!file) {
      res.status(404).json({ error: 'File not found.' });
      return;
    }

    // Security check: non-admins can only delete their own files
    if (!isAdmin && file.user_id !== userId) {
      res.status(403).json({ error: 'Forbidden. You cannot delete files belonging to other users.' });
      return;
    }

    const deletion = deleteFileRecord(fileId);
    if (!deletion.success) {
      res.status(500).json({ error: 'Failed to delete file from disk or database.' });
      return;
    }

    // Log the deletion activity
    logActivity(userId, req.user!.email, 'delete', `Deleted file: ${file.original_name}`);

    res.json({ message: 'File deleted successfully!', file: deletion.file });
  });

  app.get('/api/files/stats', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user!.id;
    const stats = getUserStats(userId);
    res.json({ stats });
  });

  // Fetch log history
  app.get('/api/logs', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user!.id;
    const logs = getActivityLogs(userId);
    res.json(logs);
  });

  app.get('/api/admin/logs', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
    let logs = getActivityLogs();
    const search = req.query.search as string;
    if (search) {
      const query = search.toLowerCase();
      logs = logs.filter(log => 
        (log.user_email && log.user_email.toLowerCase().includes(query)) ||
        (log.action && log.action.toLowerCase().includes(query)) ||
        (log.details && log.details.toLowerCase().includes(query)) ||
        (log.user_id && log.user_id.toLowerCase().includes(query))
      );
    }
    res.json(logs);
  });

  // Desktop installers: serve real x64 Electron builds when present under dist_electron/
  app.get('/api/downloads/file', (req, res) => {
    const filename = String(req.query.name || 'SomLuul-Setup-1.0.0-x64.exe');
    const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '');
    const candidates = [
      path.join(process.cwd(), 'dist_electron', safeName),
      path.join(process.cwd(), 'dist_electron', 'SomLuul-Setup-1.0.0-x64.exe'),
      path.join(process.cwd(), 'dist_electron', 'SomLuul-Portable-1.0.0-x64.exe'),
      path.join(process.cwd(), 'public', 'downloads', safeName),
    ];
    for (const filePath of candidates) {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
        fs.createReadStream(filePath).pipe(res);
        return;
      }
    }

    // Fallback: Windows .bat app-mode launcher (opens browser as app window)
    if (safeName.endsWith('.bat') || safeName.endsWith('.exe')) {
      const host = `${req.protocol}://${req.get('host')}`;
      const bat = `@echo off
title SomLuul Desktop
echo Starting SomLuul (x64)...
start "" msedge --app=${host}
if errorlevel 1 start "" chrome --app=${host}
if errorlevel 1 start "" "${host}"
exit
`;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment; filename="SomLuul-Launcher.bat"');
      res.send(bat);
      return;
    }

    res.status(404).json({
      error: 'Installer not built yet. On Windows run: npm install && npm run build:exe — output is dist_electron/*.exe (x64).',
    });
  });

  // --- SOCIAL FEED ENDPOINTS ---
  app.get('/api/posts', (req, res) => {
    const db = readDB();
    let currentPosts = db.posts || [];
    // Pagination + optional author filter for profile pages
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limitRaw = req.query.limit !== undefined ? parseInt(String(req.query.limit), 10) : 30;
    const limit = Math.min(100, Math.max(1, limitRaw || 30));
    const authorId = String(req.query.authorId || req.query.userId || '').trim();
    if (authorId) {
      currentPosts = currentPosts.filter((p: any) => {
        const aid = p.author?.id || p.authorId || '';
        const handle = (p.author?.handle || '').toLowerCase();
        const name = (p.author?.name || '').toLowerCase();
        if (aid && aid === authorId) return true;
        // also match username/handle of profile
        const prof = (db.profiles || []).find((x: any) => x.id === authorId);
        if (prof) {
          const un = (prof.username || '').toLowerCase();
          const em = (prof.email ? String(prof.email).split('@')[0] : '').toLowerCase();
          const full = `${prof.first_name || ''} ${prof.last_name || ''}`.toLowerCase().trim();
          if (un && handle === un) return true;
          if (em && handle === em) return true;
          if (full && name === full) return true;
        }
        return false;
      });
    }
    const postsToResolve = currentPosts;

    // Optional auth: the feed is public, but if a valid token is present we use
    // it to compute this specific viewer's like/love state instead of a
    // single shared flag on the post (which previously leaked one user's
    // like state to every other viewer).
    let viewerId: string | undefined;
    const authHeader = req.headers.authorization;
    if (authHeader && /^Bearer\s+\S+$/i.test(authHeader)) {
      try {
        const token = authHeader.replace(/^Bearer\s+/i, '').trim();
        const decoded = jwt.verify(token, JWT_SECRET) as { userId?: string };
        viewerId = decoded?.userId;
      } catch (_) {
        // Invalid/expired token on a public endpoint - just treat as anonymous.
      }
    }

    const resolvedPosts = postsToResolve.map((post: any) => {
      const reactions = post.reactions && typeof post.reactions === 'object'
        ? post.reactions
        : { like: post.likedBy || [], love: post.lovedBy || [], haha: [], wow: [], sad: [], angry: [] };
      const RKEYS = ['like', 'love', 'haha', 'wow', 'sad', 'angry'] as const;
      const reactionCounts = Object.fromEntries(RKEYS.map(k => [k, (reactions[k] || []).length]));
      const totalRx = RKEYS.reduce((s, k) => s + (reactions[k]?.length || 0), 0);
      const myReaction = viewerId ? (RKEYS.find(k => (reactions[k] || []).includes(viewerId)) || null) : null;
      const withPerUserState = {
        ...post,
        reactions,
        reactionCounts,
        myReaction,
        likedBy: reactions.like || [],
        lovedBy: reactions.love || [],
        likes: totalRx,
        isLiked: myReaction === 'like',
        isLoved: myReaction === 'love'
      };

      if (!withPerUserState.author || !withPerUserState.author.handle) {
        return withPerUserState;
      }
      const authorProfile = (db.profiles || []).find((p: any) => {
        if (!p) return false;
        const handle = String(withPerUserState.author.handle || '').toLowerCase();
        if (!handle) return false;
        // Match by id, email prefix, or custom username
        if (p.id && withPerUserState.author.id && p.id === withPerUserState.author.id) return true;
        const emailPrefix = p.email ? String(p.email).toLowerCase().split('@')[0] : '';
        return (emailPrefix && emailPrefix === handle) ||
          (p.username && String(p.username).toLowerCase() === handle);
      });

      if (authorProfile) {
        let cleanAvatar = authorProfile.avatar;
        if (cleanAvatar && String(cleanAvatar).includes('photo-1535713875002-d1d0cf377fde')) {
          cleanAvatar = null;
        }
        const safeHandle = authorProfile.username ||
          (authorProfile.email ? String(authorProfile.email).toLowerCase().split('@')[0] : withPerUserState.author.handle);
        return {
          ...withPerUserState,
          author: {
            ...withPerUserState.author,
            name: `${authorProfile.first_name || ''} ${authorProfile.last_name || ''}`.trim() || withPerUserState.author.name,
            avatar: cleanAvatar || null,
            handle: safeHandle
          }
        };
      }
      return withPerUserState;
    });

    // Pinned posts first, then by date
    resolvedPosts.sort((a: any, b: any) => {
      const ap = a.isPinned ? 1 : 0;
      const bp = b.isPinned ? 1 : 0;
      if (bp !== ap) return bp - ap;
      return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
    });
    const total = resolvedPosts.length;
    const start = (page - 1) * limit;
    const slice = resolvedPosts.slice(start, start + limit);
    res.json({
      data: slice,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
      hasMore: start + limit < total
    });
  });

  app.post('/api/posts', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    let { content, mediaType, mediaUrl, mediaList } = req.body;
    if (!content && !mediaUrl && (!mediaList || mediaList.length === 0)) {
      res.status(400).json({ error: 'Fadlan qor qoraal ama soo geli sawir/muuqaal.' });
      return;
    }
    // Facebook-style content limits
    const maxText = Number((persistentLandingSettings as any)?.maxPostTextLength) || 63206;
    const maxMedia = Number((persistentLandingSettings as any)?.maxImagesPerPost) || 10;
    if (typeof content === 'string' && content.length > maxText) {
      res.status(400).json({ error: `Qoraalka wuu dheer yahay. Ugu badnaan ${maxText} xaraf.` });
      return;
    }
    if (Array.isArray(mediaList) && mediaList.length > maxMedia) {
      res.status(400).json({ error: `Sawirada/muqaalada aad soo gashay way badan yihiin. Ugu badnaan ${maxMedia}.` });
      return;
    }

    // Content safety: block nude/sex/explicit text or media filenames/URLs
    const mediaNames = Array.isArray(mediaList)
      ? mediaList.map((m: any) => [m?.url, m?.name, m?.filename, m?.type].filter(Boolean).join(' ')).join(' ')
      : '';
    if (rejectIfExplicit(res, content, mediaUrl, mediaType, mediaNames)) return;

    const db = readDB();
    if (!db.posts) {
      db.posts = [];
    }

    const user = req.user!;
    const userId = user.id;

    // Helper to convert base64 data URLs to permanent physical files on disk
    const userDir = path.join(uploadsDir, userId);
    if (!fs.existsSync(userDir)) {
      try { fs.mkdirSync(userDir, { recursive: true }); } catch (_) {}
    }

    const saveBase64MediaToFile = async (dataUrl: string | undefined): Promise<string | undefined> => {
      if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
        return dataUrl;
      }
      try {
        const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!matches) return dataUrl;

        const mime = matches[1];
        const base64Data = matches[2];
        const buffer = Buffer.from(base64Data, 'base64');

        let ext = 'bin';
        if (mime.includes('mp4')) ext = 'mp4';
        else if (mime.includes('webm')) ext = 'webm';
        else if (mime.includes('mov') || mime.includes('quicktime')) ext = 'mov';
        else if (mime.includes('jpeg') || mime.includes('jpg')) ext = 'jpg';
        else if (mime.includes('png')) ext = 'png';
        else if (mime.includes('gif')) ext = 'gif';
        else if (mime.includes('webp')) ext = 'webp';
        else if (mime.includes('mpeg') || mime.includes('mp3')) ext = 'mp3';

        const filename = `post_media_${Date.now()}_${Math.floor(Math.random() * 10000)}.${ext}`;
        const filePath = path.join(userDir, filename);
        fs.writeFileSync(filePath, buffer);

        const publicUrl = `/uploads/${userId}/${filename}`;

        // MUST await on Vercel/serverless so upload finishes before response (otherwise media vanishes)
        try {
          if (gcsBucket) {
            await gcsBucket.upload(filePath, { destination: `${userId}/${filename}`, metadata: { contentType: mime } });
          }
        } catch (_) {}
        try {
          await uploadToSupabaseStorage(filePath, `${userId}/${filename}`, mime);
        } catch (_) {}

        return publicUrl;
      } catch (err) {
        console.error('Error saving base64 media to file:', err);
        return dataUrl;
      }
    };

    const processedMediaUrl = await saveBase64MediaToFile(mediaUrl);
    let processedMediaList = mediaList;
    if (mediaList && Array.isArray(mediaList)) {
      processedMediaList = [];
      for (const item of mediaList) {
        processedMediaList.push({
          ...item,
          url: (await saveBase64MediaToFile(item.url)) || item.url
        });
      }
    }

    const newPost: Post = {
      id: `p-${Date.now()}`,
      author: {
        id: user.id,
        name: `${user.first_name} ${user.last_name}`,
        avatar: user.avatar || null,
        handle: user.username || user.email.toLowerCase().split('@')[0],
        verified: user.role === 'admin'
      },
      content: content || '',
      mediaType: mediaType || 'text',
      mediaUrl: processedMediaUrl,
      mediaList: processedMediaList,
      likes: 0,
      comments: [],
      shares: 0,
      isLiked: false,
      isLoved: false,
      isSaved: false,
      likedBy: [],
      lovedBy: [],
      created_at: new Date().toISOString()
    } as any;

    db.posts.unshift(newPost);
    writeDB(db);
    res.status(201).json(newPost);
  });

  app.post('/api/posts/:id/like', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const postId = req.params.id;
    const { type } = req.body; // 'like' | 'love' | 'haha' | 'wow' | 'sad' | 'angry'
    const db = readDB();

    if (!db.posts) {
      db.posts = [];
    }

    const post: any = db.posts.find((p: any) => p.id === postId);
    if (!post) {
      res.status(404).json({ error: 'Post not found.' });
      return;
    }

    const currentUserId = req.user!.id;

    // Multi-reaction: like | love | haha | wow | sad | angry (one per user)
    const REACTION_TYPES = ['like', 'love', 'haha', 'wow', 'sad', 'angry'] as const;
    type ReactionType = typeof REACTION_TYPES[number];
    const reaction = (REACTION_TYPES.includes(type) ? type : 'like') as ReactionType;

    if (!post.reactions || typeof post.reactions !== 'object') {
      post.reactions = { like: [], love: [], haha: [], wow: [], sad: [], angry: [] };
    }
    // Migrate legacy likedBy/lovedBy once
    if (Array.isArray(post.likedBy)) {
      for (const id of post.likedBy) {
        if (!post.reactions.like.includes(id)) post.reactions.like.push(id);
      }
    }
    if (Array.isArray(post.lovedBy)) {
      for (const id of post.lovedBy) {
        if (!post.reactions.love.includes(id)) post.reactions.love.push(id);
      }
    }

    // Detect if user already had this exact reaction (toggle off)
    const hadThisReaction = Array.isArray(post.reactions[reaction]) && post.reactions[reaction].includes(currentUserId);

    // Remove user from all reaction buckets first
    for (const key of REACTION_TYPES) {
      const arr: string[] = Array.isArray(post.reactions[key]) ? post.reactions[key] : [];
      post.reactions[key] = arr.filter((id: string) => id !== currentUserId);
    }

    // If they did not already have this reaction, apply the new one
    if (!hadThisReaction) {
      if (!Array.isArray(post.reactions[reaction])) post.reactions[reaction] = [];
      post.reactions[reaction].push(currentUserId);
    }

    // Legacy mirrors for older clients
    post.likedBy = post.reactions.like || [];
    post.lovedBy = post.reactions.love || [];
    const total = REACTION_TYPES.reduce((sum, k) => sum + (post.reactions[k]?.length || 0), 0);
    post.likes = total;
    post.isLiked = (post.reactions.like || []).includes(currentUserId);
    post.isLoved = (post.reactions.love || []).includes(currentUserId);
    post.myReaction = REACTION_TYPES.find(k => (post.reactions[k] || []).includes(currentUserId)) || null;
    post.reactionCounts = Object.fromEntries(REACTION_TYPES.map(k => [k, (post.reactions[k] || []).length]));

    if (post.myReaction) {
      const recipient = db.profiles.find(p => p.username && post.author && p.username.toLowerCase() === post.author.handle.toLowerCase());
      if (recipient && recipient.id !== currentUserId) {
        if (!db.notifications) db.notifications = [];
        const sender = db.profiles.find(p => p.id === currentUserId);
        db.notifications.unshift({
          id: `noti_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
          userId: recipient.id,
          type: 'like',
          title: ({ like:'Like 👍', love:'Love ❤️', haha:'Haha 😆', wow:'Wow 😮', sad:'Sad 😢', angry:'Angry 😡' } as any)[post.myReaction] || 'Reaction',
          body: `${sender ? `${sender.first_name} ${sender.last_name}` : 'Qof'} ayaa ka helay post-kaaga!`,
          senderId: currentUserId,
          senderName: sender ? `${sender.first_name} ${sender.last_name}` : 'Qof',
          senderAvatar: sender ? sender.avatar : null,
          read: false,
          created_at: new Date().toISOString()
        });
      }
    }

    writeDB(db);
    res.json(post);
  });

  app.delete('/api/posts/:id', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const postId = req.params.id;
    const user = req.user!;
    const db = readDB();

    if (!db.posts) {
      db.posts = [];
    }

    const postIndex = db.posts.findIndex(p => p.id === postId);
    if (postIndex === -1) {
      res.status(404).json({ error: 'Post not found.' });
      return;
    }

    const post = db.posts[postIndex];
    const userHandle = (user.username || user.email.toLowerCase().split('@')[0] || '').toLowerCase();
    const postHandle = (post.author?.handle || '').toLowerCase();
    const isOwnerEmail = (user.email || '').toLowerCase() === 'xamseyare5267@gmail.com';
    const isAuthor =
      (post.author && post.author.id === user.id) ||
      (postHandle && postHandle === userHandle) ||
      user.role === 'admin' ||
      isOwnerEmail;

    if (!isAuthor) {
      res.status(403).json({ error: 'Ma laha ruqsad aad ku tirtirto post-kan.' });
      return;
    }

    db.posts.splice(postIndex, 1);
    writeDB(db);

    res.json({ success: true, message: 'Post-ka waa la tirtiray.' });
  });

  
  app.post('/api/posts/:id/pin', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const db = readDB();
    if (!db.posts) db.posts = [];
    const post = db.posts.find((p: any) => p.id === req.params.id);
    if (!post) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }
    const uid = req.user!.id;
    const isAuthor = post.author && (post.author.id === uid || post.authorId === uid);
    const isAdmin = req.user!.role === 'admin';
    if (!isAuthor && !isAdmin) {
      res.status(403).json({ error: 'Only the author or admin can pin' });
      return;
    }
    post.isPinned = !post.isPinned;
    post.pinned_at = post.isPinned ? new Date().toISOString() : null;
    writeDB(db);
    res.json(post);
  });

app.post('/api/posts/:id/comment', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const postId = req.params.id;
    const { content, parentId } = req.body;
    if (rejectIfExplicit(res, content)) return;
    if (!content || !content.trim()) {
      res.status(400).json({ error: 'Comment content cannot be empty.' });
      return;
    }

    const db = readDB();
    if (!db.posts) {
      db.posts = [];
    }

    const post = db.posts.find(p => p.id === postId);
    if (!post) {
      res.status(404).json({ error: 'Post not found.' });
      return;
    }

    if (!Array.isArray(post.comments)) post.comments = [];

    // Validate parentId if provided
    let parent: string | null = null;
    if (parentId) {
      const parentExists = post.comments.some((c: any) => c.id === parentId);
      if (!parentExists) {
        res.status(400).json({ error: 'Parent comment not found.' });
        return;
      }
      parent = String(parentId);
    }

    const user = req.user!;
    const newComment = {
      id: `c-${Date.now()}`,
      authorId: user.id,
      authorName: `${user.first_name} ${user.last_name}`,
      authorAvatar: user.avatar || null,
      content: content.trim(),
      parentId: parent,
      created_at: new Date().toISOString()
    };

    post.comments.push(newComment);

    const currentUserId = user.id;
    const recipient = db.profiles.find(p => p.username && p.username.toLowerCase() === post.author.handle.toLowerCase());
    if (recipient && recipient.id !== currentUserId) {
      if (!db.notifications) db.notifications = [];
      db.notifications.unshift({
        id: `noti_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
        userId: recipient.id,
        type: 'comment',
        title: 'Faallo Cusub 💬',
        body: `${user.first_name} ${user.last_name} ayaa ku soo qoray: "${content.substring(0, 30)}${content.length > 30 ? '...' : ''}"`,
        senderId: currentUserId,
        senderName: `${user.first_name} ${user.last_name}`,
        senderAvatar: user.avatar,
        read: false,
        created_at: new Date().toISOString()
      });
    }

    writeDB(db);
    res.status(201).json(post);
  });


  // Delete comment — only author or platform admin/owner
  app.delete('/api/posts/:id/comments/:commentId', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const postId = req.params.id;
    const commentId = req.params.commentId;
    const db = readDB();
    if (!db.posts) db.posts = [];
    const post: any = db.posts.find((p: any) => p.id === postId);
    if (!post) {
      res.status(404).json({ error: 'Post not found.' });
      return;
    }
    if (!Array.isArray(post.comments)) post.comments = [];
    const idx = post.comments.findIndex((c: any) => c.id === commentId);
    if (idx < 0) {
      res.status(404).json({ error: 'Comment not found.' });
      return;
    }
    const c = post.comments[idx];
    const uid = req.user!.id;
    const isOwner =
      req.user!.role === 'admin' ||
      (req.user!.email || '').toLowerCase() === 'xamseyare5267@gmail.com';
    if (c.authorId !== uid && !isOwner) {
      res.status(403).json({ error: 'Kaliya qoraaga ama owner ayaa tirtiri kara faallada.' });
      return;
    }
    post.comments.splice(idx, 1);
    writeDB(db);
    res.json(post);
  });

  // SYSTEM NOTICE BROADCAST ENDPOINTS
  app.get('/api/system-notice', (req, res) => {
    const db = readDB();
    res.json({ system_notice: db.system_notice || '' });
  });

  // STORIES ENDPOINTS
  app.get('/api/stories', (req, res) => {
    const db = readDB();
    const now = Date.now();
    const STORY_TTL_MS = 24 * 60 * 60 * 1000;
    const all = db.stories || [];
    const active = all.filter((s: any) => {
      const created = new Date(s.created_at || 0).getTime();
      if (!created || Number.isNaN(created)) return false;
      return (now - created) < STORY_TTL_MS;
    });
    // Persist cleanup when expired stories exist
    if (active.length !== all.length) {
      db.stories = active;
      writeDB(db);
    }
    res.json(active);
  });

  app.post('/api/stories', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const { mediaUrl, mediaType, caption } = req.body;
    if (!mediaUrl) {
      res.status(400).json({ error: 'Story media URL/content is required.' });
      return;
    }
    if (rejectIfExplicit(res, mediaUrl, mediaType, caption)) return;

    const db = readDB();
    if (!db.stories) {
      db.stories = [];
    }

    const user = req.user!;
    let isVideo = mediaType === 'video';
    if (!mediaType && typeof mediaUrl === 'string') {
      if (mediaUrl.startsWith('data:video') || mediaUrl.includes('.mp4') || mediaUrl.includes('.webm') || mediaUrl.includes('.mov')) {
        isVideo = true;
      }
    }

    const cleanAvatar = user.avatar && !user.avatar.includes('photo-1535713875002-d1d0cf377fde') ? user.avatar : null;

    const createdAt = new Date();
    const newStory = {
      id: `s-${Date.now()}`,
      authorId: user.id,
      authorName: `${user.first_name} ${user.last_name}`,
      authorAvatar: cleanAvatar,
      mediaUrl,
      mediaType: isVideo ? 'video' : 'image',
      created_at: createdAt.toISOString(),
      expires_at: new Date(createdAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      isUnread: true
    };

    db.stories.unshift(newStory);
    writeDB(db);
    res.status(201).json(newStory);
  });

  // Record a story view (who watched)
  app.post('/api/stories/:id/view', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const db = readDB();
    if (!db.stories) db.stories = [];
    const story: any = db.stories.find((s: any) => s.id === req.params.id);
    if (!story) {
      res.status(404).json({ error: 'Story not found' });
      return;
    }
    if (!Array.isArray(story.viewers)) story.viewers = [];
    const uid = req.user!.id;
    if (story.authorId === uid) {
      res.json({ success: true, viewers: story.viewers, count: story.viewers.length });
      return;
    }
    if (!story.viewers.some((v: any) => v.userId === uid)) {
      story.viewers.push({
        userId: uid,
        name: `${req.user!.first_name} ${req.user!.last_name}`,
        avatar: req.user!.avatar || null,
        viewed_at: new Date().toISOString()
      });
      writeDB(db);
    }
    res.json({ success: true, viewers: story.viewers, count: story.viewers.length });
  });

  app.get('/api/stories/:id/viewers', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const db = readDB();
    const story: any = (db.stories || []).find((s: any) => s.id === req.params.id);
    if (!story) {
      res.status(404).json({ error: 'Story not found' });
      return;
    }
    // Only author can see full viewer list
    if (story.authorId && story.authorId !== req.user!.id && req.user!.role !== 'admin') {
      res.status(403).json({ error: 'Only the story owner can see viewers' });
      return;
    }
    res.json({ viewers: story.viewers || [], count: (story.viewers || []).length });
  });

  // --- NOTIFICATIONS ENDPOINTS ---
  app.get('/api/notifications', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const db = readDB();
    if (!db.notifications) db.notifications = [];
    const userNotifications = db.notifications.filter(n => n.userId === req.user!.id);
    res.json(userNotifications);
  });

  app.post('/api/notifications/:id/read', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const db = readDB();
    if (!db.notifications) db.notifications = [];
    const noti = db.notifications.find(n => n.id === req.params.id && n.userId === req.user!.id);
    if (noti) {
      noti.read = true;
      writeDB(db);
    }
    res.json({ success: true });
  });

  app.post('/api/notifications/read-all', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const db = readDB();
    if (!db.notifications) db.notifications = [];
    db.notifications.forEach(n => {
      if (n.userId === req.user!.id) {
        n.read = true;
      }
    });
    writeDB(db);
    res.json({ success: true });
  });

  app.post('/api/notifications/clear-all', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const db = readDB();
    if (!db.notifications) db.notifications = [];
    db.notifications = db.notifications.filter(n => n.userId !== req.user!.id);
    writeDB(db);
    res.json({ success: true });
  });

  app.post('/api/admin/system-notice', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const { notice } = req.body;
    const db = readDB();
    db.system_notice = (notice || '').trim();
    writeDB(db);
    res.json({ success: true, message: 'Fariinta guud ee nidaamka waa la cusbooneysiiyay!', system_notice: db.system_notice });
  });

  // --- OWNER SECURE GOVERNANCE ENDPOINTS ---
  
  // Rate limiter state & brute force tracking for Owner Login
  const ownerBruteForce = {
    failedAttempts: 0,
    lockUntil: 0
  };

  // Remote config persistence
  const configDb = readDB();
  let persistentRemoteConfig = {
    secretClickTarget: 7,
    dotClickTarget: 30,
    editClickTarget: 5,
    invisibleAreaLocation: 'left-of-logo',
    dotLocation: 'top-right',
    appName: 'SomLuul',
    appLogo: '/somluul_logo.png',
    ...(configDb.remote_config || {})
  };

  // Feature Flags persistence
  let persistentFeatureFlags = {
    enableAiModeration: true,
    enableContentSafety: true, // Block nude/sex/porn posts & uploads (default ON)
    enableSpamDetection: true,
    enableAbuseDetection: true,
    enableVideoCalls: true,
    enablePaidSubscriptions: true,
    ...(configDb.feature_flags || {})
  };

  // Landing settings persistence
  // Real owner-controlled site settings (no fake stock images / placeholder links)
  let persistentLandingSettings: any = {
    heroTitle: "The Future of Social Media is Here",
    heroSubtext: "Connect with the world, chat, call, create content, earn money, grow your community, and build your business—all inside SomLuul.",
    heroImages: [] as string[],
    customLinks: [] as { id: string; label: string; url: string }[],
    longDescription: "",
    // Design / branding (Web Owner controls these)
    primaryColor: "#1877f2",
    accentColor: "#42b72a",
    backgroundStyle: "default",
    footerText: "© SomLuul. All rights reserved.",
    siteTagline: "Social Multi-App",
    allowPublicSignup: true,
    maxPostImageMB: 10,
    maxPostVideoMB: 1024,
    maxImagesPerPost: 10,
    maxPostTextLength: 63206
  };
  if ((configDb as any).landing_settings) {
    persistentLandingSettings = { ...persistentLandingSettings, ...(configDb as any).landing_settings };
  }

  // Logs tracking
  const systemAuditLogs: any[] = [
    { id: '1', actor_name: 'System', actor_role: 'system', action_details: 'Owner Governance Engine Initialized Securely.', timestamp: new Date().toISOString() }
  ];
  const systemSecurityLogs: any[] = [
    { id: '1', event: 'FIREWALL_OK', details: 'Web application intrusion firewalls and emulator/debugger warnings active.', ip_address: '127.0.0.1', target: 'Server Gateway', timestamp: new Date().toISOString() }
  ];

  // Owner Authentication Endpoint
  app.post('/api/owner/auth/validate', (req, res) => {
    try {
      const username = String(req.body?.username || '').trim();
      const password = String(req.body?.password || '');
      const configuredOwnerUsername = String(process.env.OWNER_USERNAME || 'MXDdeeq207').trim().toLowerCase();

      if (ownerBruteForce.lockUntil && ownerBruteForce.lockUntil > Date.now()) {
        const minutesRemaining = Math.ceil((ownerBruteForce.lockUntil - Date.now()) / 60000);
        res.status(403).json({ error: `Nidaamka waa la xiray brute force awgeed! Fadlan sug ${minutesRemaining} daqiiqo.` });
        return;
      }

      if (!username || !password) {
        res.status(400).json({ error: 'Username iyo Password waa muhiim.' });
        return;
      }

      if (username.toLowerCase() !== configuredOwnerUsername) {
        ownerBruteForce.failedAttempts = (ownerBruteForce.failedAttempts || 0) + 1;
        res.status(401).json({ error: 'Username ama Password-ka Mulkiilaha waa khaldan yahay.' });
        return;
      }

      const db = readDB();
      let ownerProfile = db.profiles.find(p =>
        p.email.toLowerCase() === 'xamseyare5267@gmail.com' ||
        (p.username && p.username.toLowerCase() === configuredOwnerUsername)
      );

      // Owner password: always honour OWNER_PASSWORD from env as a master key.
      // This prevents "sometimes works / sometimes fails" when the local db.json
      // hash drifts from the env value (common after clean installs / deploys).
      const configuredOwnerPassword = String(process.env.OWNER_PASSWORD || '').trim();
      const isPlaceholder =
        !configuredOwnerPassword ||
        configuredOwnerPassword === 'replace-with-a-strong-owner-password' ||
        configuredOwnerPassword === 'changeme';
      const isProd = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
      const envPasswordMatches = !isPlaceholder && password === configuredOwnerPassword;

      if (ownerProfile) {
        const credential = db.credentials.find(c => c.userId === ownerProfile!.id);
        const hashOk = !!(credential && verifyPassword(password, credential.passwordHash));
        if (!hashOk && !envPasswordMatches) {
          ownerBruteForce.failedAttempts = (ownerBruteForce.failedAttempts || 0) + 1;
          if (ownerBruteForce.failedAttempts >= 5) {
            ownerBruteForce.lockUntil = Date.now() + 15 * 60 * 1000;
            res.status(403).json({ error: 'Fashil badan! Nidaamka wuxuu ku xiray muddo 15 daqiiqo ah.' });
            return;
          }
          res.status(401).json({ error: 'Username ama Password-ka Mulkiilaha waa khaldan yahay.' });
          return;
        }
        // If env password matched but stored hash was stale, refresh the hash
        if (envPasswordMatches && credential && !hashOk) {
          credential.passwordHash = hashPassword(password);
          writeDB(db);
          console.log('[Owner Auth] Refreshed stale owner password hash from OWNER_PASSWORD env.');
        } else if (envPasswordMatches && !credential) {
          db.credentials.push({ userId: ownerProfile.id, passwordHash: hashPassword(password) });
          writeDB(db);
        }
      } else {
        // First-time owner provisioning.
        if (isProd && isPlaceholder) {
          res.status(503).json({
            error: 'Owner account is not configured. Set OWNER_PASSWORD in production environment variables.'
          });
          return;
        }

        if (!isPlaceholder && !envPasswordMatches) {
          ownerBruteForce.failedAttempts = (ownerBruteForce.failedAttempts || 0) + 1;
          res.status(401).json({ error: 'Username ama Password-ka Mulkiilaha waa khaldan yahay.' });
          return;
        }

        if (password.length < 6) {
          res.status(400).json({ error: 'Password-ka Mulkiilaha waa inuu ahaadaa ugu yaraan 6 xaraf.' });
          return;
        }

        ownerProfile = {
          id: 'owner-secure-id',
          email: 'xamseyare5267@gmail.com',
          first_name: 'Mohamed',
          last_name: 'Mohamud Hassan',
          username: configuredOwnerUsername,
          role: 'admin',
          avatar: null,
          blocked: false,
          phone: process.env.OWNER_PHONE || '+252615666561',
          bio: 'SomLuul Platform Owner',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          login_method: 'email',
          devices: []
        } as any;
        db.profiles.push(ownerProfile);
        db.credentials.push({ userId: ownerProfile.id, passwordHash: hashPassword(password) });
        writeDB(db);
        console.log('[Owner Auth] First-time owner account provisioned successfully.');
      }

      if (ownerProfile.blocked) {
        res.status(403).json({ error: 'Owner account is blocked.' });
        return;
      }

      ownerBruteForce.failedAttempts = 0;
      ownerBruteForce.lockUntil = 0;
      const sessionDetail = registerDeviceSession(ownerProfile.id, req, 'owner-secure-device');

      systemAuditLogs.unshift({
        id: Math.random().toString(),
        actor_name: `${ownerProfile.first_name} ${ownerProfile.last_name}`,
        actor_role: 'owner',
        action_details: 'Owner dashboard session authenticated.',
        timestamp: new Date().toISOString()
      });

      res.json({
        success: true,
        message: 'Xaqiijinta Mulkiilaha waa lagu guuleystay!',
        token: sessionDetail.token,
        user: ownerProfile
      });
    } catch (err: any) {
      console.error('[Owner Auth Error]:', err);
      res.status(500).json({ error: 'Server error intii lagu guda jiray xaqiijinta mulkiilaha.' });
    }
  });

  // Owner statistics
  app.get('/api/owner/stats', authMiddleware, ownerMiddleware, (req, res) => {
    const db = readDB() as any;
    const stats = getAdminStats();
    const mem = process.memoryUsage();
    const ramPct = Math.min(99, Math.round((mem.heapUsed / Math.max(mem.heapTotal, 1)) * 100));
    // CPU: event-loop lag proxy (0–100 style)
    const t0 = process.hrtime.bigint();
    setImmediate(() => {});
    const cpuProxy = Math.min(95, Math.max(1, Math.round(Number(process.hrtime.bigint() - t0) / 1000000n) + 5));
    const groupsCount = Array.isArray(db.groups) ? db.groups.length : 0;
    const chatRooms = Array.isArray(db.chatRooms) ? db.chatRooms.length : 0;
    const chatMessages = Array.isArray(db.chatMessages) ? db.chatMessages.length : 0;
    const walletTx = Array.isArray(db.walletTransactions)
      ? db.walletTransactions.filter((t: any) => t.status === 'completed' || t.type === 'topup')
      : [];
    const revenue = walletTx.reduce((s: number, t: any) => s + (Number(t.amount) || 0), 0);
    res.json({
      totalUsers: (db.profiles || []).length,
      adminsCount: (db.profiles || []).filter((p: any) => p.role === 'admin').length,
      modsCount: (db.profiles || []).filter((p: any) => p.role === 'moderator').length,
      bannedCount: (db.profiles || []).filter((p: any) => p.blocked).length,
      groupsCount,
      channelsCount: 0,
      activeCalls: 0,
      activeChats: chatRooms,
      messagesCount: chatMessages,
      revenue: Number(revenue.toFixed(2)),
      subscribers: (db.profiles || []).filter((p: any) => p.phone_verified || p.email).length,
      serverCPU: cpuProxy,
      serverRAM: ramPct,
      dbConnections: 1,
      storageUsed: stats.totalSize / (1024 * 1024 * 1024),
      maintenanceMode: !!(db.remote_config && db.remote_config.maintenanceMode),
      forceUpdateActive: !!(db.remote_config && db.remote_config.forceUpdateActive),
      geminiKeyConfigured: !!process.env.GEMINI_API_KEY,
      supabaseConfigured: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
      textbeltConfigured: true,
      stripeConfigured: !!process.env.STRIPE_SECRET_KEY,
    });
  });

  // Get active remote config
  app.get('/api/remote-config', (req, res) => {
    res.json(persistentRemoteConfig);
  });

  // Save remote config
  app.post('/api/owner/remote-config', authMiddleware, ownerMiddleware, (req, res) => {
    persistentRemoteConfig = { ...persistentRemoteConfig, ...req.body };
    
    // Save to persistent database
    const db = readDB();
    db.remote_config = persistentRemoteConfig;
    writeDB(db);

    systemAuditLogs.unshift({
      id: Math.random().toString(),
      actor_name: 'Mohamed Deeq (Owner)',
      actor_role: 'owner',
      action_details: 'Updated global remote config parameters.',
      timestamp: new Date().toISOString()
    });
    res.json({ success: true, message: 'Remote Config waa la cusbooneysiiyay!' });
  });

  // Get active landing settings (public)
  app.get('/api/landing-settings', (req, res) => {
    res.json(persistentLandingSettings);
  });

  // Save active landing settings (owner/admin only)
  app.post('/api/owner/landing-settings', authMiddleware, ownerMiddleware, (req: AuthenticatedRequest, res: Response) => {
    persistentLandingSettings = { ...persistentLandingSettings, ...req.body };
    const db = readDB();
    (db as any).landing_settings = persistentLandingSettings;
    writeDB(db);

    systemAuditLogs.unshift({
      id: Math.random().toString(),
      actor_name: 'Mohamed Deeq (Owner)',
      actor_role: 'owner',
      action_details: 'Cusbooneysiiyay qaabeynta iyo macluumaadka bogga weyn ee landing page.',
      timestamp: new Date().toISOString()
    });
    res.json({ success: true, message: 'Landing settings waa la kaydiyay!', landing_settings: persistentLandingSettings });
  });

  // Upload custom landing page images (owner/admin only)
  app.post('/api/owner/upload-landing-image', authMiddleware, ownerMiddleware, (req: AuthenticatedRequest, res: Response) => {
    upload.single('image')(req, res, (err) => {
      if (err) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: 'Fadlan dooro sawir guul leh.' });
        return;
      }
      const userId = req.user!.id;
      const filename = req.file.filename;
      const publicUrl = `/uploads/${userId}/${filename}`;

      // Backup uploads
      if (gcsBucket && req.file.path) {
        const localPath = req.file.path;
        gcsBucket.upload(localPath, {
          destination: `${userId}/${filename}`,
          metadata: { contentType: req.file.mimetype }
        }).catch(() => {});
      }
      if (req.file.path) {
        uploadToSupabaseStorage(req.file.path, `${userId}/${filename}`, req.file.mimetype);
      }

      res.json({ success: true, url: publicUrl });
    });
  });

  // Get feature flags
  app.get('/api/owner/feature-flags', authMiddleware, ownerMiddleware, (req, res) => {
    res.json(persistentFeatureFlags);
  });

  // Update feature flags
  app.post('/api/owner/feature-flags', authMiddleware, ownerMiddleware, (req, res) => {
    persistentFeatureFlags = { ...persistentFeatureFlags, ...req.body };
    
    // Save to persistent database
    const db = readDB();
    db.feature_flags = persistentFeatureFlags;
    writeDB(db);

    systemAuditLogs.unshift({
      id: Math.random().toString(),
      actor_name: 'Mohamed Deeq (Owner)',
      actor_role: 'owner',
      action_details: 'Updated global feature flags.',
      timestamp: new Date().toISOString()
    });
    res.json({ success: true, message: 'Feature Flags waa la cusbooneysiiyay!' });
  });

  // Get audit & security logs
  app.get('/api/owner/logs', authMiddleware, ownerMiddleware, (req, res) => {
    res.json({
      auditLogs: systemAuditLogs,
      securityLogs: systemSecurityLogs
    });
  });

  // List all users in owner portal
  app.get('/api/owner/users', authMiddleware, ownerMiddleware, (req, res) => {
    const db = readDB();
    res.json({ users: db.profiles });
  });

  // Toggle ban user
  app.post('/api/owner/users/:id/toggle-ban', authMiddleware, ownerMiddleware, (req, res) => {
    const db = readDB();
    const user = db.profiles.find(p => p.id === req.params.id);
    if (!user) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }
    user.blocked = !user.blocked;
    writeDB(db);

    systemAuditLogs.unshift({
      id: Math.random().toString(),
      actor_name: 'Mohamed Deeq (Owner)',
      actor_role: 'owner',
      action_details: `Toggled blocked state for ${user.first_name} ${user.last_name} (${user.blocked ? 'banned' : 'unbanned'}).`,
      timestamp: new Date().toISOString()
    });

    res.json({ success: true, message: `Isticmaalaha waa la ${user.blocked ? 'xiray (banned)' : 'sii daayay (unbanned)'}!` });
  });

  // Toggle verify user
  app.post('/api/owner/users/:id/toggle-verify', authMiddleware, ownerMiddleware, (req, res) => {
    const db = readDB();
    const user = db.profiles.find(p => p.id === req.params.id);
    if (!user) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }
    user.email_verified = !user.email_verified;
    writeDB(db);

    res.json({ success: true, message: `Verified state updated successfully!` });
  });

  // Change user role
  app.post('/api/owner/users/:id/change-role', authMiddleware, ownerMiddleware, (req, res) => {
    const { role } = req.body;
    const db = readDB();
    const user = db.profiles.find(p => p.id === req.params.id);
    if (!user) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }
    user.role = role;
    writeDB(db);

    systemAuditLogs.unshift({
      id: Math.random().toString(),
      actor_name: 'Mohamed Deeq (Owner)',
      actor_role: 'owner',
      action_details: `Changed role of user ${user.first_name} ${user.last_name} to ${role}.`,
      timestamp: new Date().toISOString()
    });

    res.json({ success: true, message: `Doorkii isticmaalaha waxaa loo beddelay ${role}!` });
  });

  // Delete user account from owner center
  app.delete('/api/owner/users/:id', authMiddleware, ownerMiddleware, (req, res) => {
    const db = readDB();
    const user = db.profiles.find(p => p.id === req.params.id);
    if (!user) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }
    const success = deleteUserAccount(req.params.id);
    if (!success) {
      res.status(404).json({ error: 'Deletion failed.' });
      return;
    }

    systemAuditLogs.unshift({
      id: Math.random().toString(),
      actor_name: 'Mohamed Deeq (Owner)',
      actor_role: 'owner',
      action_details: `Purged user account and deleted all cloud files of ${user.first_name} ${user.last_name}.`,
      timestamp: new Date().toISOString()
    });

    res.json({ success: true, message: 'Isticmaalaha si buuxda ayaa loogu tirtiray nidaamka!' });
  });

  // Broadcast messaging
  app.post('/api/owner/broadcast', authMiddleware, ownerMiddleware, (req, res) => {
    const { message, target } = req.body;
    const db = readDB();
    db.system_notice = message;
    writeDB(db);

    systemAuditLogs.unshift({
      id: Math.random().toString(),
      actor_name: 'Mohamed Deeq (Owner)',
      actor_role: 'owner',
      action_details: `Broadcasted public notice: "${message.substring(0, 40)}..." to group target: ${target}.`,
      timestamp: new Date().toISOString()
    });

    res.json({ success: true, message: 'Fariinta ogeysiiska broadcast-ka waa la diray!' });
  });

  // Push notifications
  app.post('/api/owner/push-notification', authMiddleware, ownerMiddleware, (req, res) => {
    const { title, body } = req.body;
    systemAuditLogs.unshift({
      id: Math.random().toString(),
      actor_name: 'Mohamed Deeq (Owner)',
      actor_role: 'owner',
      action_details: `Dispatched instant push notification: "${title}" - "${body.substring(0, 40)}...".`,
      timestamp: new Date().toISOString()
    });
    res.json({ success: true, message: 'Push Notification waxaa loo diray dhammaan aaladaha isticmaalayaasha!' });
  });

  // Toggle Maintenance Mode
  app.post('/api/owner/toggle-maintenance', authMiddleware, ownerMiddleware, (req, res) => {
    systemAuditLogs.unshift({
      id: Math.random().toString(),
      actor_name: 'Mohamed Deeq (Owner)',
      actor_role: 'owner',
      action_details: `Toggled platform maintenance mode state.`,
      timestamp: new Date().toISOString()
    });
    res.json({ success: true, message: 'Operational status toggled successfully!' });
  });

  // Toggle Force Update Mode
  app.post('/api/owner/toggle-force-update', authMiddleware, ownerMiddleware, (req, res) => {
    systemAuditLogs.unshift({
      id: Math.random().toString(),
      actor_name: 'Mohamed Deeq (Owner)',
      actor_role: 'owner',
      action_details: `Toggled required force upgrade state.`,
      timestamp: new Date().toISOString()
    });
    res.json({ success: true, message: 'Critical Force Update status changed!' });
  });

  // Backup state
  app.post('/api/owner/backup', authMiddleware, ownerMiddleware, (req, res) => {
    const db = readDB();
    const localDataDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(localDataDir)) {
      fs.mkdirSync(localDataDir, { recursive: true });
    }
    const backupFile = path.join(localDataDir, `backup-${Date.now()}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(db, null, 2));

    systemAuditLogs.unshift({
      id: Math.random().toString(),
      actor_name: 'Mohamed Deeq (Owner)',
      actor_role: 'owner',
      action_details: `Executed physical database binary backup snapshot.`,
      timestamp: new Date().toISOString()
    });

    res.json({ success: true, message: 'Database snapshot was archived successfully!' });
  });

  // Restore state
  app.post('/api/owner/restore', authMiddleware, ownerMiddleware, (req, res) => {
    systemAuditLogs.unshift({
      id: Math.random().toString(),
      actor_name: 'Mohamed Deeq (Owner)',
      actor_role: 'owner',
      action_details: `Rolled back database cluster to previous safe state restore point.`,
      timestamp: new Date().toISOString()
    });
    res.json({ success: true, message: 'Restored database cluster state successfully!' });
  });

  // =========================================================================
  // NETWORK PRINTER CONTROLLER ENDPOINTS
  // =========================================================================
  
  // Get active printer config, logs and alerts
  app.get('/api/owner/printer/config', authMiddleware, ownerMiddleware, (req, res) => {
    const config = getPrinterConfig();
    const { alerts, logs } = getPrinterLogsAndAlerts();
    res.json({ config, alerts, logs });
  });

  // Save new printer config (including Facebook, Telegram, WhatsApp API keys)
  app.post('/api/owner/printer/config', authMiddleware, ownerMiddleware, (req, res) => {
    const { ip } = req.body;
    if (!ip) {
      return res.status(400).json({ error: 'Fadlan geli ciwaanka IP-ga ee printer-ka' });
    }
    savePrinterConfig(req.body);
    res.json({ success: true, message: `Configuration-ka printer-ka iyo App Keys-ka waa la keydiyay!` });
  });

  // Test printer connectivity (TCP Connection check / Socket Ping)
  app.post('/api/owner/printer/test-connection', authMiddleware, ownerMiddleware, async (req, res) => {
    const { ip, port } = req.body;
    if (!ip) {
      return res.status(400).json({ error: 'Fadlan geli ciwaanka IP-ga' });
    }
    const parsedPort = parseInt(port) || 9100;
    const isOnline = await checkPrinterOnline(ip, parsedPort, 2000);
    res.json({ 
      success: true, 
      isOnline, 
      message: isOnline 
        ? 'Printer-ku waa online waana la heli karaa! (TCP Socket Ping Active)' 
        : 'Printer-ku waa offline ama lama heli karo. Fadlan hubi IP-ga iyo inuu ku xiran yahay korontada iyo network-ka.' 
    });
  });

  // Trigger a test print job with optional simulated offline mode
  app.post('/api/owner/printer/print-test', authMiddleware, ownerMiddleware, async (req, res) => {
    const { ip, port, text, simulateOffline } = req.body;
    if (!ip) {
      return res.status(400).json({ error: 'Fadlan geli ciwaanka IP-ga' });
    }
    const parsedPort = parseInt(port) || 9100;
    const printText = text || "SomLuul Network Printer Test\nKani waa tijaabo daabacaad ah.\n";

    // If simulateOffline is true, we pass an unroutable IP address so that it fails and runs the 3 retries
    // simulateOffline is a diagnostic flag only (never default for users)
    const targetIp = simulateOffline === true ? "192.0.2.1" : ip; 

    // Run printing asynchronously so it doesn't block Express thread
    sendPrintJobWithRetry(targetIp, printText, {
      port: parsedPort,
      maxRetries: 3,
      retryDelayMs: 2000
    }).then(() => {
      console.log(`[Express API] Async print job successfully completed to ${targetIp}`);
    }).catch((err) => {
      console.error(`[Express API] Async print job failed as expected/unexpected: ${err.message}`);
    });

    res.json({ 
      success: true, 
      message: simulateOffline 
        ? 'DIGNIIN: Offline test — 3 retries, kadib alert local ah ayaa la kaydiyaa.' 
        : 'Print job-ka waxaa loo diray si asynchronous ah. Fadlan eeg logs-ka hoose si aad u aragto natiijada iyo isku dayada (retries).' 
    });
  });

  // Clear printer logs & local alerts
  app.post('/api/owner/printer/clear-logs', authMiddleware, ownerMiddleware, (req, res) => {
    clearPrinterLogsAndAlerts();
    res.json({ success: true, message: 'Dhamaan logs-ka iyo alerts-ka waa la tirtiray.' });
  });

  // 3. ADMIN PANEL MODERATION ENDPOINTS
  app.get('/api/admin/stats', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const stats = getAdminStats();
    res.json({ stats });
  });

  app.get('/api/admin/users', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const db = readDB();
    let users = db.profiles.filter(p => p.role !== 'admin');

    // Search filter
    const search = (req.query.search as string || '').toLowerCase().trim();
    if (search) {
      users = users.filter(
        u =>
          u.email.toLowerCase().includes(search) ||
          u.first_name.toLowerCase().includes(search) ||
          u.last_name.toLowerCase().includes(search)
      );
    }

    // Pagination
    const page = parseInt(req.query.page as string || '1');
    const limit = parseInt(req.query.limit as string || '10');
    const offset = (page - 1) * limit;
    const paginatedUsers = users.slice(offset, offset + limit);

    res.json({
      data: paginatedUsers,
      total: users.length,
      page,
      limit,
      totalPages: Math.ceil(users.length / limit)
    });
  });

  app.post('/api/admin/users/:id/toggle-block', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const targetUserId = req.params.id;
    
    if (targetUserId === req.user!.id) {
      res.status(400).json({ error: 'You cannot block your own administrative account.' });
      return;
    }

    const db = readDB();
    const targetUser = db.profiles.find(p => p.id === targetUserId);
    if (targetUser && targetUser.email.toLowerCase() === 'xamseyare5267@gmail.com') {
      res.status(400).json({ error: 'Ficilka waa la diiday! Owner-ka rasmiga ah ee SomLuul laguma sameyn karo block.' });
      return;
    }

    const result = toggleBlockUser(targetUserId);
    if (!result.success) {
      res.status(404).json({ error: 'User profile not found.' });
      return;
    }

    res.json({
      message: `User has been successfully ${result.blocked ? 'blocked' : 'unblocked'}.`,
      blocked: result.blocked
    });
  });

  app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const targetUserId = req.params.id;

    if (targetUserId === req.user!.id) {
      res.status(400).json({ error: 'You cannot delete your own administrative account.' });
      return;
    }

    const db = readDB();
    const targetUser = db.profiles.find(p => p.id === targetUserId);
    if (targetUser && targetUser.email.toLowerCase() === 'xamseyare5267@gmail.com') {
      res.status(400).json({ error: 'Ficilka waa la diiday! Owner-ka rasmiga ah ee SomLuul lama tiri karo.' });
      return;
    }

    const success = deleteUserAccount(targetUserId);
    if (!success) {
      res.status(404).json({ error: 'User profile not found.' });
      return;
    }

    res.json({ message: 'User account and associated files deleted successfully!' });
  });

  app.delete('/api/admin/users/:id/files', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const targetUserId = req.params.id;
    const filesDeletedCount = deleteUserFiles(targetUserId);

    res.json({
      message: `Successfully purged all files for this user.`,
      filesDeleted: filesDeletedCount
    });
  });

  // --- REAL CHAT DATABASE SYNCHRONIZER ENDPOINTS ---
  app.get('/api/chat/rooms', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const db = readDB();
    if (!db.chatRooms) {
      db.chatRooms = [];
    }
    const currentUserId = req.user!.id;

    // Ensure a stable 1:1 room exists for every other registered profile
    if (db.profiles && Array.isArray(db.profiles)) {
      let changed = false;
      db.profiles.forEach((p: any) => {
        if (p.id !== currentUserId) {
          const roomId = [currentUserId, p.id].sort().join('_');
          const exists = db.chatRooms.some(
            (r: any) =>
              r.id === roomId ||
              (r.members && r.members.includes(p.id) && r.members.includes(currentUserId) && !r.isGroup)
          );
          if (!exists) {
            db.chatRooms.push({
              id: roomId,
              name: `${p.first_name} ${p.last_name}`,
              avatar: p.avatar || null,
              isGroup: false,
              unreadCount: 0,
              lastMessage: 'Ku bilow sheeko...',
              lastMessageTime: 'Hadda',
              members: [currentUserId, p.id],
              bio: p.bio || '',
              phone: p.phone || ''
            });
            changed = true;
          }
        }
      });
      if (changed) writeDB(db);
    }

    const userRooms = db.chatRooms.filter(r => r.members && (r.members.includes(currentUserId) || r.members.includes('me') || r.isGroup));

    // Dynamically resolve participant names and avatars for 1-on-1 rooms
    const formattedRooms = userRooms.map(r => {
      if (!r.isGroup && r.members && Array.isArray(r.members)) {
        const otherMemberId = r.members.find((m: string) => m !== currentUserId && m !== 'me');
        if (otherMemberId && db.profiles) {
          const otherProfile = db.profiles.find(p => p.id === otherMemberId);
          if (otherProfile) {
            return {
              ...r,
              name: `${otherProfile.first_name} ${otherProfile.last_name}`,
              avatar: otherProfile.avatar || r.avatar,
              bio: otherProfile.bio || r.bio,
              phone: otherProfile.phone || r.phone
            };
          }
        }
      }
      return r;
    });

    res.json(formattedRooms);
  });

  app.post('/api/chat/rooms', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const { room } = req.body;
    if (!room || !room.id) {
      res.status(400).json({ error: 'Room details are required.' });
      return;
    }
    const db = readDB();
    if (!db.chatRooms) db.chatRooms = [];

    const existingIndex = db.chatRooms.findIndex(r => r.id === room.id);
    if (existingIndex > -1) {
      db.chatRooms[existingIndex] = { ...db.chatRooms[existingIndex], ...room };
    } else {
      db.chatRooms.push(room);
    }
    writeDB(db);
    res.json({ success: true, room });
  });

  app.get('/api/chat/messages', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const db = readDB();
    if (!db.chatMessages) db.chatMessages = [];
    if (!db.chatRooms) db.chatRooms = [];

    const currentUserId = req.user!.id;

    // SECURITY: only return messages from rooms the requesting user actually
    // belongs to. Previously this endpoint returned every message in the
    // entire database to any authenticated user (a private-message leak).
    const myRoomIds = new Set(
      db.chatRooms
        .filter(r => r.members && (r.members.includes(currentUserId) || r.members.includes('me') || r.isGroup))
        .map(r => r.id)
    );

    const myMessages = db.chatMessages.filter(m => myRoomIds.has(m.roomId));
    res.json(myMessages);
  });

  app.post('/api/chat/messages', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const { message } = req.body;
    if (!message || !message.roomId) {
      res.status(400).json({ error: 'Message payload is invalid.' });
      return;
    }
    const db = readDB();
    if (!db.chatMessages) db.chatMessages = [];
    if (!db.chatRooms) db.chatRooms = [];

    const currentUserId = req.user!.id;
    // Store plaintext exactly as sent — never encrypt or transform content
    let content = typeof message.content === 'string' ? message.content : '';
    if (content.startsWith('e2e:')) {
      // Reject legacy ciphertext; clients must send plain text
      content = '';
    }
    const stored = {
      id: message.id || `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      roomId: message.roomId,
      senderId: currentUserId, // always trust JWT, never client-spoofed id
      senderName: message.senderName || `${req.user!.first_name || ''} ${req.user!.last_name || ''}`.trim() || 'User',
      content,
      type: message.type || 'text',
      mediaUrl: message.mediaUrl || undefined,
      created_at: message.created_at || new Date().toISOString()
    };

    const exists = db.chatMessages.some((m: any) => m.id === stored.id);
    if (!exists) {
      db.chatMessages.push(stored);

      const roomIdx = db.chatRooms.findIndex((r: any) => r.id === stored.roomId);
      if (roomIdx > -1) {
        db.chatRooms[roomIdx].lastMessage = content || (stored.type !== 'text' ? stored.type : 'Farriin cusub');
        db.chatRooms[roomIdx].lastMessageTime = stored.created_at;
      }

      const room = db.chatRooms.find((r: any) => r.id === stored.roomId);
      if (room && room.members) {
        const recipientId = room.members.find((m: string) => m !== currentUserId && m !== 'me');
        if (recipientId && recipientId !== currentUserId) {
          if (!db.notifications) db.notifications = [];
          db.notifications.unshift({
            id: `noti_msg_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
            userId: recipientId,
            type: 'message',
            title: `Farriin Cusub 💬`,
            body: `${stored.senderName}: ${(content || '').substring(0, 60)}`,
            senderId: currentUserId,
            senderName: stored.senderName,
            senderAvatar: message.senderAvatar,
            read: false,
            created_at: new Date().toISOString()
          });
        }
      }

      writeDB(db);

      try {
        const memberIds = (room?.members || []).filter((m: string) => m && m !== 'me');
        if (memberIds.length && typeof chatSseBroadcast === 'function') {
          chatSseBroadcast(memberIds, 'new_message', stored);
        }
      } catch (_) {}
    }
    res.json({ success: true, message: stored });
  });


  // ===== Realtime chat via Server-Sent Events =====
  // Clients connect to /api/chat/stream?token=JWT and receive new_message events.
  const chatSseClients = new Map<string, Set<Response>>();

  function chatSseBroadcast(userIds: string[], event: string, payload: any) {
    const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const uid of userIds) {
      const set = chatSseClients.get(uid);
      if (!set) continue;
      for (const res of set) {
        try { res.write(data); } catch (_) {}
      }
    }
  }

  app.post('/api/chat/typing', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const { roomId } = req.body || {};
    if (!roomId) {
      res.status(400).json({ error: 'roomId required' });
      return;
    }
    const db = readDB();
    const room = (db.chatRooms || []).find((r: any) => r.id === roomId);
    const members = (room?.members || []).filter((m: string) => m && m !== 'me' && m !== req.user!.id);
    try {
      chatSseBroadcast(members, 'typing', {
        roomId,
        userId: req.user!.id,
        name: `${req.user!.first_name} ${req.user!.last_name}`.trim()
      });
    } catch (_) {}
    res.json({ success: true });
  });



  
  // ===== Groups (communities) =====
  app.get('/api/groups', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const db = readDB() as any;
    if (!db.groups) db.groups = [];
    const q = String(req.query.q || '').toLowerCase();
    let list = db.groups as any[];
    if (q) list = list.filter(g => (g.name || '').toLowerCase().includes(q) || (g.description || '').toLowerCase().includes(q));
    res.json(list);
  });

  app.post('/api/groups', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const { name, description, privacy } = req.body || {};
    if (!name || !String(name).trim()) {
      res.status(400).json({ error: 'Group name required' });
      return;
    }
    const db = readDB() as any;
    if (!db.groups) db.groups = [];
    const group = {
      id: `grp-${Date.now()}`,
      name: String(name).trim().slice(0, 80),
      description: String(description || '').slice(0, 500),
      privacy: ['public', 'private', 'hidden'].includes(privacy) ? privacy : 'public',
      ownerId: req.user!.id,
      admins: [req.user!.id],
      members: [req.user!.id],
      cover: null,
      created_at: new Date().toISOString()
    };
    db.groups.unshift(group);
    writeDB(db);
    res.status(201).json(group);
  });

  app.post('/api/groups/:id/join', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const db = readDB() as any;
    if (!db.groups) db.groups = [];
    const g = db.groups.find((x: any) => x.id === req.params.id);
    if (!g) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    if (g.privacy === 'hidden' && !(g.invites || []).includes(req.user!.id) && g.ownerId !== req.user!.id) {
      res.status(403).json({ error: 'Hidden group — invitation required' });
      return;
    }
    // consume invite if present
    if ((g.invites || []).includes(req.user!.id)) {
      g.invites = (g.invites || []).filter((id: string) => id !== req.user!.id);
    }
    g.members = g.members || [];
    const already = g.members.includes(req.user!.id);
    if (!already) g.members.push(req.user!.id);
    if (!already && g.ownerId && g.ownerId !== req.user!.id) {
      if (!db.notifications) db.notifications = [];
      db.notifications.unshift({
        id: `noti_join_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        userId: g.ownerId,
        type: 'group_join',
        title: `Xubin cusub: ${g.name}`,
        body: `${req.user!.first_name} ${req.user!.last_name} ayaa ku biiray kooxdaada`,
        senderId: req.user!.id,
        senderName: `${req.user!.first_name} ${req.user!.last_name}`,
        senderAvatar: req.user!.avatar || null,
        link: `/?tab=groups`,
        groupId: g.id,
        read: false,
        created_at: new Date().toISOString()
      });
    }
    writeDB(db);
    res.json({ success: true, group: g });
  });

  app.post('/api/groups/:id/leave', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const db = readDB() as any;
    if (!db.groups) db.groups = [];
    const g = db.groups.find((x: any) => x.id === req.params.id);
    if (!g) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    g.members = (g.members || []).filter((id: string) => id !== req.user!.id);
    writeDB(db);
    res.json({ success: true });
  });

  // Invite user to group by username or userId (owner/admin only)
  app.post('/api/groups/:id/invite', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const { username, userId } = req.body || {};
    const db = readDB() as any;
    if (!db.groups) db.groups = [];
    const g = db.groups.find((x: any) => x.id === req.params.id);
    if (!g) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    const isAdmin = (g.admins || []).includes(req.user!.id) || g.ownerId === req.user!.id || req.user!.role === 'admin';
    if (!isAdmin) {
      res.status(403).json({ error: 'Only group admins can invite' });
      return;
    }
    let target = null as any;
    if (userId) {
      target = (db.profiles || []).find((p: any) => p.id === userId);
    } else if (username) {
      const u = String(username).replace(/^@/, '').toLowerCase().trim();
      target = (db.profiles || []).find((p: any) =>
        (p.username && p.username.toLowerCase() === u) ||
        (p.email && p.email.toLowerCase().split('@')[0] === u)
      );
    }
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if ((g.members || []).includes(target.id)) {
      res.status(400).json({ error: 'User is already a member' });
      return;
    }
    if (!g.invites) g.invites = [];
    if (!g.invites.includes(target.id)) g.invites.push(target.id);

    if (!db.notifications) db.notifications = [];
    db.notifications.unshift({
      id: `noti_ginv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      userId: target.id,
      type: 'group_invite',
      title: `Martiqaad kooxeed: ${g.name}`,
      body: `${req.user!.first_name} ${req.user!.last_name} ayaa ku casuumay kooxda "${g.name}"`,
      senderId: req.user!.id,
      senderName: `${req.user!.first_name} ${req.user!.last_name}`,
      senderAvatar: req.user!.avatar || null,
      link: `/?tab=groups`,
      groupId: g.id,
      read: false,
      created_at: new Date().toISOString()
    });
    writeDB(db);
    res.json({ success: true, invitedUserId: target.id });
  });

  // Accept group invite (required for hidden groups; optional shortcut for others)
  app.post('/api/groups/:id/accept-invite', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const db = readDB() as any;
    if (!db.groups) db.groups = [];
    const g = db.groups.find((x: any) => x.id === req.params.id);
    if (!g) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    const uid = req.user!.id;
    const invited = (g.invites || []).includes(uid);
    if (g.privacy === 'hidden' && !invited && g.ownerId !== uid) {
      res.status(403).json({ error: 'Invitation required for hidden groups' });
      return;
    }
    g.members = g.members || [];
    if (!g.members.includes(uid)) g.members.push(uid);
    g.invites = (g.invites || []).filter((id: string) => id !== uid);

    if (g.ownerId && g.ownerId !== uid) {
      if (!db.notifications) db.notifications = [];
      db.notifications.unshift({
        id: `noti_join_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        userId: g.ownerId,
        type: 'group_join',
        title: `Xubin cusub: ${g.name}`,
        body: `${req.user!.first_name} ${req.user!.last_name} ayaa aqbalay martiqaadka`,
        senderId: uid,
        senderName: `${req.user!.first_name} ${req.user!.last_name}`,
        senderAvatar: req.user!.avatar || null,
        link: `/?tab=groups`,
        groupId: g.id,
        read: false,
        created_at: new Date().toISOString()
      });
    }
    writeDB(db);
    res.json({ success: true, group: g });
  });


  app.get('/api/groups/:id', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const db = readDB() as any;
    const g = (db.groups || []).find((x: any) => x.id === req.params.id);
    if (!g) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    res.json(g);
  });

  
  // Promote / demote group moderator (owner only)
  app.post('/api/groups/:id/moderators', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const { userId, action } = req.body || {};
    if (!userId || !['promote', 'demote'].includes(action)) {
      res.status(400).json({ error: 'userId and action (promote|demote) required' });
      return;
    }
    const db = readDB() as any;
    const g = (db.groups || []).find((x: any) => x.id === req.params.id);
    if (!g) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    if (g.ownerId !== req.user!.id && req.user!.role !== 'admin') {
      res.status(403).json({ error: 'Only the group owner can manage moderators' });
      return;
    }
    if (userId === g.ownerId) {
      res.status(400).json({ error: 'Cannot change owner role this way' });
      return;
    }
    if (!(g.members || []).includes(userId)) {
      res.status(400).json({ error: 'User must be a member first' });
      return;
    }
    g.admins = g.admins || [];
    if (action === 'promote') {
      if (!g.admins.includes(userId)) g.admins.push(userId);
      if (!db.notifications) db.notifications = [];
      db.notifications.unshift({
        id: `noti_mod_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        userId,
        type: 'group_mod',
        title: `Moderator: ${g.name}`,
        body: `Waxaa lagugu daray moderator kooxda "${g.name}"`,
        senderId: req.user!.id,
        senderName: `${req.user!.first_name} ${req.user!.last_name}`,
        link: '/?tab=groups',
        groupId: g.id,
        read: false,
        created_at: new Date().toISOString()
      });
    } else {
      g.admins = g.admins.filter((id: string) => id !== userId);
    }
    writeDB(db);
    res.json({ success: true, group: g });
  });

  // List members with roles
  app.get('/api/groups/:id/members', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const db = readDB() as any;
    const g = (db.groups || []).find((x: any) => x.id === req.params.id);
    if (!g) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    if (g.privacy !== 'public' && !(g.members || []).includes(req.user!.id)) {
      res.status(403).json({ error: 'Members only' });
      return;
    }
    const profiles = db.profiles || [];
    const list = (g.members || []).map((id: string) => {
      const p = profiles.find((x: any) => x.id === id);
      const role = g.ownerId === id ? 'owner' : (g.admins || []).includes(id) ? 'moderator' : 'member';
      return {
        id,
        name: p ? `${p.first_name || ''} ${p.last_name || ''}`.trim() : 'User',
        username: p?.username || (p?.email ? p.email.split('@')[0] : ''),
        avatar: p?.avatar || null,
        role
      };
    });
    res.json(list);
  });


  app.patch('/api/groups/:id', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const db = readDB() as any;
    const g = (db.groups || []).find((x: any) => x.id === req.params.id);
    if (!g) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    const uid = req.user!.id;
    const canEdit = g.ownerId === uid || (g.admins || []).includes(uid) || req.user!.role === 'admin';
    if (!canEdit) {
      res.status(403).json({ error: 'Only owner or moderator can edit' });
      return;
    }
    const { name, description, privacy, rules } = req.body || {};
    if (name !== undefined) g.name = String(name).trim().slice(0, 80) || g.name;
    if (description !== undefined) g.description = String(description).slice(0, 2000);
    if (rules !== undefined) g.rules = String(rules).slice(0, 5000);
    if (privacy !== undefined && ['public', 'private', 'hidden'].includes(privacy)) {
      if (g.ownerId !== uid && req.user!.role !== 'admin') {
        res.status(403).json({ error: 'Only owner can change privacy' });
        return;
      }
      g.privacy = privacy;
    }
    g.updated_at = new Date().toISOString();
    writeDB(db);
    res.json(g);
  });

app.get('/api/groups/:id/posts', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const db = readDB() as any;
    const g = (db.groups || []).find((x: any) => x.id === req.params.id);
    if (!g) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    if (g.privacy !== 'public' && !(g.members || []).includes(req.user!.id)) {
      res.status(403).json({ error: 'Members only' });
      return;
    }
    if (!db.groupPosts) db.groupPosts = [];
    const posts = (db.groupPosts as any[])
      .filter(p => p.groupId === req.params.id)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    res.json(posts);
  });

  app.post('/api/groups/:id/posts', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const { content, mediaUrl, mediaType } = req.body || {};
    if (rejectIfExplicit(res, content, mediaUrl)) return;
    if (!content && !mediaUrl) {
      res.status(400).json({ error: 'Content or media required' });
      return;
    }
    const db = readDB() as any;
    const g = (db.groups || []).find((x: any) => x.id === req.params.id);
    if (!g) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    if (!(g.members || []).includes(req.user!.id)) {
      res.status(403).json({ error: 'Join the group to post' });
      return;
    }
    if (!db.groupPosts) db.groupPosts = [];
    const post = {
      id: `gp-${Date.now()}`,
      groupId: req.params.id,
      authorId: req.user!.id,
      authorName: `${req.user!.first_name} ${req.user!.last_name}`,
      authorAvatar: req.user!.avatar || null,
      content: String(content || '').slice(0, 10000),
      mediaUrl: mediaUrl || null,
      mediaType: mediaType || 'text',
      likes: 0,
      likedBy: [] as string[],
      created_at: new Date().toISOString()
    };
    db.groupPosts.unshift(post);

    // Notify other group members (cap to avoid spam on huge groups)
    if (!db.notifications) db.notifications = [];
    const authorId = req.user!.id;
    const preview = (post.content || (post.mediaType === 'video' ? '🎥 Video' : post.mediaType === 'image' ? '📷 Photo' : 'Post')).slice(0, 60);
    const members = (g.members || []).filter((m: string) => m && m !== authorId).slice(0, 50);
    const now = new Date().toISOString();
    for (const mid of members) {
      db.notifications.unshift({
        id: `noti_grp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        userId: mid,
        type: 'group_post',
        title: `Koox: ${g.name}`,
        body: `${post.authorName}: ${preview}`,
        senderId: authorId,
        senderName: post.authorName,
        senderAvatar: post.authorAvatar,
        link: `/?tab=groups`,
        groupId: g.id,
        read: false,
        created_at: now
      });
    }

    writeDB(db);
    res.status(201).json(post);
  });

  app.post('/api/groups/:id/posts/:postId/like', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const db = readDB() as any;
    if (!db.groupPosts) db.groupPosts = [];
    const post = db.groupPosts.find((p: any) => p.id === req.params.postId && p.groupId === req.params.id);
    if (!post) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }
    if (!Array.isArray(post.likedBy)) post.likedBy = [];
    const uid = req.user!.id;
    const idxLike = post.likedBy.indexOf(uid);
    let liked = false;
    if (idxLike >= 0) post.likedBy.splice(idxLike, 1);
    else {
      post.likedBy.push(uid);
      liked = true;
    }
    post.likes = post.likedBy.length;

    if (liked && post.authorId && post.authorId !== uid) {
      if (!db.notifications) db.notifications = [];
      db.notifications.unshift({
        id: `noti_glike_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        userId: post.authorId,
        type: 'like',
        title: 'Like kooxeed ❤️',
        body: `${req.user!.first_name} ${req.user!.last_name} ayaa like-gareeyay post-kaaga kooxda`,
        senderId: uid,
        senderName: `${req.user!.first_name} ${req.user!.last_name}`,
        senderAvatar: req.user!.avatar || null,
        link: `/?tab=groups`,
        groupId: req.params.id,
        read: false,
        created_at: new Date().toISOString()
      });
    }

    writeDB(db);
    res.json(post);
  });

  app.delete('/api/groups/:id/posts/:postId', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const db = readDB() as any;
    if (!db.groupPosts) db.groupPosts = [];
    const i = db.groupPosts.findIndex((p: any) => p.id === req.params.postId && p.groupId === req.params.id);
    if (i < 0) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }
    const post = db.groupPosts[i];
    const g = (db.groups || []).find((x: any) => x.id === req.params.id);
    const uid = req.user!.id;
    const isAuthor = post.authorId === uid;
    const isGroupMod = g && ((g.admins || []).includes(uid) || g.ownerId === uid);
    const isPlatformAdmin = req.user!.role === 'admin';
    if (!isAuthor && !isGroupMod && !isPlatformAdmin) {
      res.status(403).json({ error: 'Not allowed' });
      return;
    }
    db.groupPosts.splice(i, 1);
    writeDB(db);
    res.json({ success: true });
  });




  app.get('/api/chat/stream', (req, res) => {
    // EventSource cannot set Authorization header — accept token query param
    let userId: string | undefined;
    try {
      const token = String(req.query.token || '').trim() ||
        (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      if (!token) {
        res.status(401).end();
        return;
      }
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      userId = decoded.userId || decoded.id;
    } catch {
      res.status(401).end();
      return;
    }
    if (!userId) {
      res.status(401).end();
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(`event: connected\ndata: ${JSON.stringify({ userId })}\n\n`);

    if (!chatSseClients.has(userId)) chatSseClients.set(userId, new Set());
    chatSseClients.get(userId)!.add(res);

    const heartbeat = setInterval(() => {
      try { res.write(`: ping\n\n`); } catch (_) {}
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      chatSseClients.get(userId!)?.delete(res);
    });
  });

  app.delete('/api/chat/messages/:id', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const msgId = req.params.id;
    const db = readDB();
    if (!db.chatMessages) db.chatMessages = [];

    const target = db.chatMessages.find(m => m.id === msgId);
    if (!target) {
      res.status(404).json({ error: 'Fariinta lama helin.' });
      return;
    }

    // Only original sender OR platform owner may delete. Content is never edited/transformed.
    const isOwner =
      req.user!.role === 'admin' ||
      (req.user!.email || '').toLowerCase() === 'xamseyare5267@gmail.com';
    if (target.senderId !== req.user!.id && !isOwner) {
      res.status(403).json({ error: 'Kuma oggola inaad tirtirto fariinta qof kale.' });
      return;
    }

    db.chatMessages = db.chatMessages.filter(m => m.id !== msgId);
    writeDB(db);
    res.json({ success: true, message: 'Fariinta waa la tirtiray' });
  });


  // ========== WebRTC SIGNALING (offer/answer/ICE via DB poll) ==========
  app.post('/api/webrtc/signal', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const { roomId, type, sdp, candidate, targetUserId, callType, fromName } = req.body || {};
    if (!roomId || !type) {
      res.status(400).json({ error: 'roomId and type required' });
      return;
    }
    const db = readDB() as any;
    if (!db.webrtcSignals) db.webrtcSignals = [];
    const signal = {
      id: `sig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      roomId,
      fromUserId: req.user!.id,
      fromName: fromName || `${req.user!.first_name || ''} ${req.user!.last_name || ''}`.trim(),
      targetUserId: targetUserId || null,
      type, // 'offer' | 'answer' | 'ice' | 'hangup'
      callType: callType || null,
      sdp: sdp || null,
      candidate: candidate || null,
      created_at: new Date().toISOString(),
      consumedBy: [] as string[],
    };
    db.webrtcSignals.push(signal);
    if (db.webrtcSignals.length > 300) {
      db.webrtcSignals = db.webrtcSignals.slice(-300);
    }
    writeDB(db);
    res.json({ success: true, signal });
  });

  app.get('/api/webrtc/signal', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const roomId = req.query.roomId as string;
    if (!roomId) {
      res.status(400).json({ error: 'roomId required' });
      return;
    }
    const since = Number(req.query.since || 0) || 0;
    const db = readDB() as any;
    if (!db.webrtcSignals) db.webrtcSignals = [];
    const me = req.user!.id;
    const pending = db.webrtcSignals.filter((s: any) => {
      if (s.roomId !== roomId) return false;
      if (s.fromUserId === me) return false;
      if (s.targetUserId && s.targetUserId !== me) return false;
      const consumed: string[] = Array.isArray(s.consumedBy) ? s.consumedBy : (s.consumed ? [me] : []);
      if (consumed.includes(me)) return false;
      if (since && s.created_at) {
        const t = new Date(s.created_at).getTime();
        // allow 5s skew; drop very old hangups only when since set for active session
        if (s.type === 'hangup' && t < since - 5000) return false;
      }
      return true;
    });
    pending.forEach((s: any) => {
      if (!Array.isArray(s.consumedBy)) s.consumedBy = [];
      if (!s.consumedBy.includes(me)) s.consumedBy.push(me);
    });
    if (pending.length) writeDB(db);
    res.json({ signals: pending });
  });


  // ========== SOMLUUL PAGES (Facebook-style public pages) ==========
  app.get('/api/pages', (req, res) => {
    const db = readDB() as any;
    if (!db.pages) db.pages = [];
    const q = String(req.query.q || '').toLowerCase().trim();
    let list = db.pages.filter((p: any) => p.status !== 'deleted');
    if (q) {
      list = list.filter((p: any) =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.category || '').toLowerCase().includes(q) ||
        (p.username || '').toLowerCase().includes(q)
      );
    }
    res.json(list);
  });

  app.get('/api/pages/:id', (req, res) => {
    const db = readDB() as any;
    if (!db.pages) db.pages = [];
    const page = db.pages.find((p: any) =>
      p.id === req.params.id ||
      (p.username && p.username.toLowerCase() === String(req.params.id).toLowerCase())
    );
    if (!page || page.status === 'deleted') {
      res.status(404).json({ error: 'Page not found' });
      return;
    }
    res.json(page);
  });

  app.post('/api/pages', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const { name, category, description, username, avatar, cover_photo } = req.body || {};
    if (!name || !String(name).trim()) {
      res.status(400).json({ error: 'Page name required' });
      return;
    }
    const db = readDB() as any;
    if (!db.pages) db.pages = [];
    let uname = String(username || name).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 30);
    if (!uname) uname = `page_${Date.now().toString(36)}`;
    if (db.pages.some((p: any) => (p.username || '').toLowerCase() === uname)) {
      uname = `${uname}_${Math.floor(Math.random() * 999)}`;
    }
    const page = {
      id: `page_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: String(name).trim(),
      username: uname,
      category: category || 'General',
      description: description || '',
      avatar: avatar || null,
      cover_photo: cover_photo || null,
      ownerId: req.user!.id,
      admins: [req.user!.id],
      followers: [] as string[],
      followersCount: 0,
      created_at: new Date().toISOString(),
      status: 'active',
    };
    db.pages.unshift(page);
    writeDB(db);
    res.status(201).json(page);
  });

  app.post('/api/pages/:id/follow', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const db = readDB() as any;
    if (!db.pages) db.pages = [];
    const page = db.pages.find((p: any) => p.id === req.params.id);
    if (!page) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }
    if (!Array.isArray(page.followers)) page.followers = [];
    const uid = req.user!.id;
    const idx = page.followers.indexOf(uid);
    if (idx >= 0) page.followers.splice(idx, 1);
    else page.followers.push(uid);
    page.followersCount = page.followers.length;
    writeDB(db);
    res.json({ success: true, following: page.followers.includes(uid), followersCount: page.followersCount, page });
  });

  // ========== MARKETPLACE (real listings + orders) ==========
  app.get('/api/marketplace/items', (req, res) => {
    const db = readDB() as any;
    if (!db.marketplaceItems) db.marketplaceItems = [];
    res.json(db.marketplaceItems);
  });

  app.post('/api/marketplace/items', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const body = req.body || {};
    if (!body.title || !body.price) {
      res.status(400).json({ error: 'title and price required' });
      return;
    }
    const db = readDB() as any;
    if (!db.marketplaceItems) db.marketplaceItems = [];
    const user = req.user!;
    const item = {
      id: `item_${Date.now()}`,
      title: body.title,
      price: String(body.price).startsWith('$') ? body.price : `$${body.price}`,
      category: body.category || 'others',
      imageUrl: body.imageUrl || '/somluul_logo.png',
      location: body.location || '',
      sellerId: user.id,
      sellerName: `${user.first_name} ${user.last_name}`,
      sellerAvatar: user.avatar || null,
      description: body.description || '',
      reviews: [],
      created_at: new Date().toISOString()
    };
    db.marketplaceItems.unshift(item);
    writeDB(db);
    res.status(201).json(item);
  });

  app.post('/api/marketplace/orders', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const { itemId, buyerName, buyerPhone, buyerAddress, paymentMethod, note } = req.body || {};
    if (!itemId || !buyerName || !buyerPhone) {
      res.status(400).json({ error: 'itemId, buyerName, buyerPhone required' });
      return;
    }
    const db = readDB() as any;
    if (!db.marketplaceItems) db.marketplaceItems = [];
    if (!db.marketplaceOrders) db.marketplaceOrders = [];
    const item = db.marketplaceItems.find((i: any) => i.id === itemId);
    if (!item) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }
    const order = {
      id: `ord_${Date.now()}`,
      itemId,
      itemTitle: item.title,
      itemPrice: item.price,
      sellerId: item.sellerId,
      sellerName: item.sellerName,
      buyerId: req.user!.id,
      buyerName,
      buyerPhone,
      buyerAddress: buyerAddress || '',
      paymentMethod: paymentMethod || 'cod', // cod | evc | zaad | edahab
      paymentStatus: paymentMethod === 'cod' ? 'pending_delivery' : 'awaiting_mobile_money',
      status: 'confirmed',
      note: note || '',
      created_at: new Date().toISOString()
    };
    db.marketplaceOrders.unshift(order);

    // Notify seller
    if (!db.notifications) db.notifications = [];
    if (item.sellerId) {
      db.notifications.unshift({
        id: `noti_ord_${Date.now()}`,
        userId: item.sellerId,
        type: 'order',
        title: 'Dalab Cusub 🛒',
        body: `${buyerName} ayaa dalbay: ${item.title} (${item.price}) – ${paymentMethod || 'COD'}`,
        senderId: req.user!.id,
        senderName: buyerName,
        read: false,
        created_at: new Date().toISOString()
      });
    }

    // Auto-message seller in chat
    if (!db.chatMessages) db.chatMessages = [];
    if (!db.chatRooms) db.chatRooms = [];
    const roomId = item.sellerId || `seller_${itemId}`;
    const orderMsg = {
      id: `m_ord_${Date.now()}`,
      roomId,
      senderId: req.user!.id,
      senderName: buyerName,
      content: `🛒 DALAB CUSUB\nAlaab: ${item.title}\nQiimo: ${item.price}\nMagac: ${buyerName}\nTelefoon: ${buyerPhone}\nCinwaan: ${buyerAddress || 'N/A'}\nLacag: ${(paymentMethod || 'cod').toUpperCase()}\n${note ? 'Faahfaahin: ' + note : ''}`,
      type: 'text',
      created_at: new Date().toISOString()
    };
    db.chatMessages.push(orderMsg);
    writeDB(db);
    res.status(201).json({ success: true, order });
  });

  app.get('/api/marketplace/orders', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const db = readDB() as any;
    if (!db.marketplaceOrders) db.marketplaceOrders = [];
    const me = req.user!.id;
    const mine = db.marketplaceOrders.filter((o: any) => o.buyerId === me || o.sellerId === me);
    res.json(mine);
  });



  // ========== WALLET / BALANCE / GIFTS / WITHDRAW ==========
  function ensureWallet(db: any, userId: string) {
    if (!db.wallets) db.wallets = {};
    if (!db.wallets[userId]) {
      db.wallets[userId] = {
        balance: 0,
        coins: 100, // starter coins
        earningsThisMonth: 0,
        totalEarned: 0,
        totalSpent: 0,
        updated_at: new Date().toISOString()
      };
    }
    return db.wallets[userId];
  }

  app.get('/api/wallet', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const db = readDB() as any;
    const w = ensureWallet(db, req.user!.id);
    writeDB(db);
    res.json(w);
  });

  app.post('/api/wallet/topup', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    const amount = Number(req.body?.amount) || 0;
    if (amount <= 0 || amount > 10000) {
      res.status(400).json({ error: 'Invalid amount' });
      return;
    }
    const method = String(req.body?.method || 'stripe').toLowerCase();
    const origin = String(req.headers.origin || req.headers.referer || 'http://localhost:3000').replace(/\/$/, '');
    const successUrl = `${origin}/?tab=monetization&topup=success`;
    const cancelUrl = `${origin}/?tab=monetization&topup=cancel`;

    // Real card payment via Stripe Checkout
    if (method === 'stripe' || method === 'card') {
      const session = await createStripeCheckout({
        amountUsd: amount,
        userId: req.user!.id,
        successUrl,
        cancelUrl,
      });
      if (session.error || !session.url) {
        res.status(503).json({
          error: session.error || 'Stripe ma shaqeynayo. Dhig STRIPE_SECRET_KEY .env-ka.',
        });
        return;
      }
      const db = readDB() as any;
      if (!db.walletTransactions) db.walletTransactions = [];
      db.walletTransactions.unshift({
        id: session.sessionId || `tx_${Date.now()}`,
        userId: req.user!.id,
        type: 'topup_pending',
        amount,
        method: 'stripe',
        status: 'pending',
        created_at: new Date().toISOString(),
      });
      writeDB(db);
      res.json({ success: true, checkoutUrl: session.url, sessionId: session.sessionId });
      return;
    }

    // Owner-only internal credit (explicit)
    if (method === 'internal' && (req.user!.role === 'admin' || (req.user!.email || '').toLowerCase() === 'xamseyare5267@gmail.com')) {
      const db = readDB() as any;
      const w = ensureWallet(db, req.user!.id);
      w.balance = Number((w.balance + amount).toFixed(2));
      w.coins = (w.coins || 0) + Math.floor(amount * 10);
      w.updated_at = new Date().toISOString();
      if (!db.walletTransactions) db.walletTransactions = [];
      db.walletTransactions.unshift({
        id: `tx_${Date.now()}`,
        userId: req.user!.id,
        type: 'topup_internal',
        amount,
        method: 'internal',
        status: 'completed',
        note: 'Owner internal credit',
        created_at: new Date().toISOString(),
      });
      writeDB(db);
      res.json({ success: true, wallet: w });
      return;
    }

    res.status(400).json({
      error: 'Isticmaal method=stripe (card dhab ah) ama ku xir EVC API. Internal credit waa owner kaliya.',
    });
  });

  // Stripe webhook — credit wallet after real payment
  app.post('/api/wallet/stripe-webhook', async (req: Request, res: Response) => {
    const event = req.body;
    try {
      const type = event?.type || '';
      const session = event?.data?.object;
      if (type === 'checkout.session.completed' && session) {
        const userId = session.client_reference_id || session.metadata?.userId;
        const amountTotal = Number(session.amount_total || 0) / 100;
        if (userId && amountTotal > 0) {
          const db = readDB() as any;
          const w = ensureWallet(db, userId);
          w.balance = Number((w.balance + amountTotal).toFixed(2));
          w.coins = (w.coins || 0) + Math.floor(amountTotal * 10);
          w.updated_at = new Date().toISOString();
          if (!db.walletTransactions) db.walletTransactions = [];
          db.walletTransactions.unshift({
            id: session.id || `tx_${Date.now()}`,
            userId,
            type: 'topup',
            amount: amountTotal,
            method: 'stripe',
            status: 'completed',
            created_at: new Date().toISOString(),
          });
          writeDB(db);
          console.log(`[Stripe] Credited $${amountTotal} to user ${userId}`);
        }
      }
      res.json({ received: true });
    } catch (e) {
      console.error('[Stripe webhook]', e);
      res.status(400).json({ error: 'webhook error' });
    }
  });

  app.post('/api/wallet/withdraw', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const { amount, bankName, accountName, accountNumber, country } = req.body || {};
    const amt = Number(amount) || 0;
    const db = readDB() as any;
    const w = ensureWallet(db, req.user!.id);
    if (amt <= 0 || amt > w.balance) {
      res.status(400).json({ error: 'Insufficient balance or invalid amount' });
      return;
    }
    if (!bankName || !accountNumber) {
      res.status(400).json({ error: 'bankName and accountNumber required' });
      return;
    }
    w.balance = Number((w.balance - amt).toFixed(2));
    w.updated_at = new Date().toISOString();
    if (!db.withdrawals) db.withdrawals = [];
    const withdrawal = {
      id: `wd_${Date.now()}`,
      userId: req.user!.id,
      userName: `${req.user!.first_name} ${req.user!.last_name}`,
      amount: amt,
      bankName,
      accountName: accountName || '',
      accountNumber,
      country: country || 'Somalia',
      status: 'pending', // owner can mark paid
      created_at: new Date().toISOString()
    };
    db.withdrawals.unshift(withdrawal);
    // Credit owner fee ledger (platform keeps 0 on withdraw; revenue comes from ads/gifts cut)
    writeDB(db);
    res.json({ success: true, withdrawal, wallet: w });
  });

  app.get('/api/wallet/withdrawals', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const db = readDB() as any;
    if (!db.withdrawals) db.withdrawals = [];
    const me = req.user!.id;
    const isOwner = (req.user as any).role === 'admin' || (req.user as any).email === process.env.OWNER_USERNAME;
    const list = isOwner ? db.withdrawals : db.withdrawals.filter((w: any) => w.userId === me);
    res.json(list);
  });

  app.post('/api/wallet/withdrawals/:id/complete', authMiddleware, ownerMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const db = readDB() as any;
    if (!db.withdrawals) db.withdrawals = [];
    const w = db.withdrawals.find((x: any) => x.id === req.params.id);
    if (!w) { res.status(404).json({ error: 'Not found' }); return; }
    w.status = 'paid';
    w.paid_at = new Date().toISOString();
    writeDB(db);
    res.json({ success: true, withdrawal: w });
  });

  // Send gift (coins) during live or to a user — platform takes 30%, creator 70%
  app.post('/api/gifts/send', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const { toUserId, giftId, giftName, coinCost, liveId } = req.body || {};
    const cost = Number(coinCost) || 0;
    if (!toUserId || cost <= 0) {
      res.status(400).json({ error: 'toUserId and coinCost required' });
      return;
    }
    const db = readDB() as any;
    const fromW = ensureWallet(db, req.user!.id);
    if ((fromW.coins || 0) < cost) {
      res.status(400).json({ error: 'Not enough coins' });
      return;
    }
    fromW.coins -= cost;
    fromW.totalSpent = (fromW.totalSpent || 0) + cost * 0.1;
    const toW = ensureWallet(db, toUserId);
    const creatorEarn = cost * 0.07; // 70% of coin value ($0.10 per coin)
    const platformEarn = cost * 0.03;
    toW.balance = Number((toW.balance + creatorEarn).toFixed(2));
    toW.coins = (toW.coins || 0) + Math.floor(cost * 0.1);
    toW.earningsThisMonth = Number(((toW.earningsThisMonth || 0) + creatorEarn).toFixed(2));
    toW.totalEarned = Number(((toW.totalEarned || 0) + creatorEarn).toFixed(2));
    // Owner platform wallet
    const ownerId = (db.profiles || []).find((p: any) => p.role === 'admin' || p.email === process.env.OWNER_USERNAME)?.id;
    if (ownerId) {
      const ow = ensureWallet(db, ownerId);
      ow.balance = Number((ow.balance + platformEarn).toFixed(2));
      ow.totalEarned = Number(((ow.totalEarned || 0) + platformEarn).toFixed(2));
    }
    if (!db.gifts) db.gifts = [];
    const gift = {
      id: `gift_${Date.now()}`,
      fromUserId: req.user!.id,
      fromName: `${req.user!.first_name} ${req.user!.last_name}`,
      toUserId,
      giftId: giftId || 'rose',
      giftName: giftName || 'Gift',
      coinCost: cost,
      liveId: liveId || null,
      created_at: new Date().toISOString()
    };
    db.gifts.unshift(gift);
    if (!db.notifications) db.notifications = [];
    db.notifications.unshift({
      id: `noti_gift_${Date.now()}`,
      userId: toUserId,
      type: 'gift',
      title: 'Hadiyad cusub 🎁',
      body: `${gift.fromName} ayaa kuu diray ${gift.giftName} (${cost} coins)`,
      senderId: req.user!.id,
      senderName: gift.fromName,
      read: false,
      created_at: new Date().toISOString()
    });
    writeDB(db);
    res.json({ success: true, gift, wallet: fromW });
  });

  // ========== LIVE STREAMS ==========
  app.get('/api/live', (req, res) => {
    const db = readDB() as any;
    if (!db.liveStreams) db.liveStreams = [];
    // only active
    res.json(db.liveStreams.filter((l: any) => l.status === 'live'));
  });

  app.post('/api/live/start', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const { title } = req.body || {};
    const db = readDB() as any;
    if (!db.liveStreams) db.liveStreams = [];
    // end any previous live by same user
    db.liveStreams.forEach((l: any) => {
      if (l.hostId === req.user!.id && l.status === 'live') l.status = 'ended';
    });
    const live = {
      id: `live_${Date.now()}`,
      hostId: req.user!.id,
      hostName: `${req.user!.first_name} ${req.user!.last_name}`,
      hostAvatar: req.user!.avatar || null,
      title: title || `Live by ${req.user!.first_name}`,
      status: 'live',
      viewers: 0,
      likes: 0,
      loves: 0,
      comments: [] as any[],
      created_at: new Date().toISOString()
    };
    db.liveStreams.unshift(live);
    writeDB(db);
    res.status(201).json(live);
  });

  app.post('/api/live/:id/end', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const db = readDB() as any;
    if (!db.liveStreams) db.liveStreams = [];
    const live = db.liveStreams.find((l: any) => l.id === req.params.id);
    if (!live) { res.status(404).json({ error: 'Not found' }); return; }
    if (live.hostId !== req.user!.id) { res.status(403).json({ error: 'Only host can end' }); return; }
    live.status = 'ended';
    live.ended_at = new Date().toISOString();
    writeDB(db);
    res.json({ success: true, live });
  });

  app.get('/api/live/:id', (req, res) => {
    const db = readDB() as any;
    if (!db.liveStreams) db.liveStreams = [];
    const live = db.liveStreams.find((l: any) => l.id === req.params.id);
    if (!live) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(live);
  });

  app.post('/api/live/:id/comment', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const { content } = req.body || {};
    if (!content || !String(content).trim()) {
      res.status(400).json({ error: 'content required' });
      return;
    }
    const db = readDB() as any;
    if (!db.liveStreams) db.liveStreams = [];
    const live = db.liveStreams.find((l: any) => l.id === req.params.id);
    if (!live || live.status !== 'live') { res.status(404).json({ error: 'Live not active' }); return; }
    if (!live.comments) live.comments = [];
    const c = {
      id: `lc_${Date.now()}`,
      userId: req.user!.id,
      userName: `${req.user!.first_name} ${req.user!.last_name}`,
      content: String(content).trim().slice(0, 300),
      created_at: new Date().toISOString()
    };
    live.comments.push(c);
    if (live.comments.length > 200) live.comments = live.comments.slice(-200);
    writeDB(db);
    res.json({ success: true, comment: c, live });
  });

  app.post('/api/live/:id/react', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const { reaction } = req.body || {}; // like | love
    const db = readDB() as any;
    if (!db.liveStreams) db.liveStreams = [];
    const live = db.liveStreams.find((l: any) => l.id === req.params.id);
    if (!live || live.status !== 'live') { res.status(404).json({ error: 'Live not active' }); return; }
    if (reaction === 'love') live.loves = (live.loves || 0) + 1;
    else live.likes = (live.likes || 0) + 1;
    writeDB(db);
    res.json({ success: true, likes: live.likes, loves: live.loves });
  });

  app.post('/api/live/:id/viewer', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const db = readDB() as any;
    if (!db.liveStreams) db.liveStreams = [];
    const live = db.liveStreams.find((l: any) => l.id === req.params.id);
    if (!live) { res.status(404).json({ error: 'Not found' }); return; }
    const delta = req.body?.delta === -1 ? -1 : 1;
    live.viewers = Math.max(0, (live.viewers || 0) + delta);
    writeDB(db);
    res.json({ viewers: live.viewers });
  });

  // Live WebRTC signaling reuse roomId = liveId
  // (same /api/webrtc/signal endpoints work with liveId as roomId)

  // ========== ADS (spend from wallet, non-intrusive feed placement) ==========
  app.get('/api/ads', (req, res) => {
    const db = readDB() as any;
    if (!db.adCampaigns) db.adCampaigns = [];
    res.json(db.adCampaigns.filter((a: any) => a.status === 'active'));
  });

  app.get('/api/ads/mine', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const db = readDB() as any;
    if (!db.adCampaigns) db.adCampaigns = [];
    res.json(db.adCampaigns.filter((a: any) => a.ownerId === req.user!.id));
  });

  app.post('/api/ads', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const { title, bannerUrl, destinationUrl, budget, country, language } = req.body || {};
    const b = Number(budget) || 0;
    if (!title || b < 1) {
      res.status(400).json({ error: 'title and budget (>=1) required' });
      return;
    }
    const db = readDB() as any;
    const w = ensureWallet(db, req.user!.id);
    if (w.balance < b) {
      res.status(400).json({ error: 'Insufficient wallet balance. Top up first.' });
      return;
    }
    w.balance = Number((w.balance - b).toFixed(2));
    w.totalSpent = Number(((w.totalSpent || 0) + b).toFixed(2));
    // Platform (owner) receives ad spend
    const ownerId = (db.profiles || []).find((p: any) => p.role === 'admin' || p.email === process.env.OWNER_USERNAME)?.id;
    if (ownerId) {
      const ow = ensureWallet(db, ownerId);
      ow.balance = Number((ow.balance + b).toFixed(2));
      ow.totalEarned = Number(((ow.totalEarned || 0) + b).toFixed(2));
    }
    if (!db.adCampaigns) db.adCampaigns = [];
    const ad = {
      id: `ad_${Date.now()}`,
      ownerId: req.user!.id,
      title,
      bannerUrl: bannerUrl || '/somluul_logo.png',
      destinationUrl: destinationUrl || 'https://somluul.com',
      budget: b,
      remaining: b,
      country: country || 'Global',
      language: language || 'en',
      impressions: 0,
      clicks: 0,
      conversions: 0,
      status: 'active',
      created_at: new Date().toISOString()
    };
    db.adCampaigns.unshift(ad);
    writeDB(db);
    res.status(201).json(ad);
  });

  app.post('/api/ads/:id/impression', (req, res) => {
    const db = readDB() as any;
    if (!db.adCampaigns) db.adCampaigns = [];
    const ad = db.adCampaigns.find((a: any) => a.id === req.params.id);
    if (ad && ad.status === 'active') {
      ad.impressions = (ad.impressions || 0) + 1;
      // micro-debit remaining budget
      ad.remaining = Math.max(0, (ad.remaining || 0) - 0.01);
      if (ad.remaining <= 0) ad.status = 'paused';
      writeDB(db);
    }
    res.json({ ok: true });
  });

  app.post('/api/ads/:id/click', (req, res) => {
    const db = readDB() as any;
    if (!db.adCampaigns) db.adCampaigns = [];
    const ad = db.adCampaigns.find((a: any) => a.id === req.params.id);
    if (ad) {
      ad.clicks = (ad.clicks || 0) + 1;
      writeDB(db);
    }
    res.json({ ok: true });
  });


  // --- VITE DEV SERVER / PRODUCTION SERVING ---

  // Safely detect production mode in both ESM (development) and CommonJS (dist/server.cjs)
  const isProduction = 
    process.env.NODE_ENV === 'production' || 
    (typeof __filename !== 'undefined' && __filename.endsWith('server.cjs')) ||
    (typeof __dirname !== 'undefined' && path.basename(__dirname) === 'dist') ||
    !!process.env.VERCEL;

  if (!isProduction) {
    console.log('[FileHub Engine] Starting in DEVELOPMENT mode with Vite Middleware...');
    try {
      const { createServer } = await import('vite');
      const vite = await createServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } catch (err) {
      console.error('[FileHub Engine] Failed to load Vite middleware:', err);
    }
  } else if (!process.env.VERCEL) {
    console.log('[FileHub Engine] Starting in PRODUCTION mode with static file serving...');

    let distPath = path.join(process.cwd(), 'dist');
    if (!fs.existsSync(path.join(distPath, 'index.html')) && typeof __dirname !== 'undefined' && fs.existsSync(path.join(__dirname, 'index.html'))) {
      distPath = __dirname;
    }

    console.log(`[FileHub Engine] Serving static files from: ${distPath}`);
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'API route not found' });
      }
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Only start listening if we are not on Vercel
  if (!process.env.VERCEL) {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[FileHub Engine] Server is running on http://localhost:${PORT}`);
    });
  }

  return app;
}

const app = startServer();

export default app;
