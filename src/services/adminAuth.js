// ═══════════════════════════════════════════════════════════════
// src/services/adminAuth.js
// نظام هوية حقيقي لكل أدمن/موظف — إضافي بالكامل فوق ADMIN_TOKEN
// المشترك القديم، اللي بيفضل شغال بدون أي تغيير. حساب لكل شخص
// (admin_users)، جلسات مؤقتة (admin_sessions)، وسجل نشاط عام
// (admin_activity_log). كلمات المرور بـ crypto.scryptSync — بدون
// أي مكتبة خارجية جديدة، نفس أسلوب requireAdmin الحالي اللي
// بيستخدم crypto.timingSafeEqual أصلاً.
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');
const supa = require('../clients/supabase');
const log = require('../utils/log');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 ساعة
const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return salt + ':' + hash;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || stored.indexOf(':') === -1) return false;
  const [salt, hash] = stored.split(':');
  try {
    const hashBuffer = Buffer.from(hash, 'hex');
    const candidateBuffer = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
    if (hashBuffer.length !== candidateBuffer.length) return false;
    return crypto.timingSafeEqual(hashBuffer, candidateBuffer);
  } catch (e) {
    return false;
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// [STAFF-PASSWORD-MIN] Same 8-char floor enforced here regardless of
// caller — createStaffUser is the only place a password is ever set
// (creation or reset both go through this), so this is the one place
// that needs the check.
async function createStaffUser({ email, name, password, role, createdByAdminId }) {
  if (!supa) throw Object.assign(new Error('Datenbank nicht verfügbar'), { status: 503 });
  if (!email || !name || !password) throw Object.assign(new Error('email, name und password sind erforderlich'), { status: 400 });
  if (String(password).length < 8) throw Object.assign(new Error('Passwort muss mindestens 8 Zeichen haben'), { status: 400 });
  const normalizedRole = role === 'admin' ? 'admin' : 'staff';
  const { data, error } = await supa.from('admin_users').insert({
    email: String(email).trim().toLowerCase(),
    name: String(name).trim(),
    password_hash: hashPassword(password),
    role: normalizedRole,
    created_by_admin_id: createdByAdminId || null,
  }).select().maybeSingle();
  if (error) {
    // Postgres unique_violation
    if (error.code === '23505') throw Object.assign(new Error('Diese E-Mail-Adresse ist bereits registriert'), { status: 409 });
    throw Object.assign(new Error(error.message), { status: 500 });
  }
  return data;
}

async function verifyStaffLogin(email, password) {
  if (!supa || !email || !password) return null;
  const { data } = await supa.from('admin_users').select('*').eq('email', String(email).trim().toLowerCase()).maybeSingle();
  if (!data || !data.active) return null;
  if (!verifyPassword(password, data.password_hash)) return null;
  return data;
}

async function createSession(adminUserId, role) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  if (supa) {
    await supa.from('admin_sessions').insert({
      token_hash: tokenHash, admin_user_id: adminUserId, role, expires_at: expiresAt,
    });
  }
  return token;
}

// Returns {adminUserId, role} for a still-valid session belonging to a
// still-active admin_users row, or null — checked in two steps (session
// existence+expiry, then the linked user's active flag) rather than a
// single FK-embedded query, so a staff account deactivated mid-session
// is locked out on its very next request.
async function resolveSession(token) {
  if (!supa || !token) return null;
  const tokenHash = hashToken(token);
  const { data: session } = await supa.from('admin_sessions').select('*').eq('token_hash', tokenHash).maybeSingle();
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) return null;
  const { data: user } = await supa.from('admin_users').select('active').eq('id', session.admin_user_id).maybeSingle();
  if (!user || !user.active) return null;
  return { adminUserId: session.admin_user_id, role: session.role };
}

async function revokeSession(token) {
  if (!supa || !token) return;
  await supa.from('admin_sessions').delete().eq('token_hash', hashToken(token));
}

// Fire-and-forget by design (mirrors recordSyncFailureEvent/
// recordCancellationEvent elsewhere) — a logging failure must never
// block the admin action that triggered it.
async function logAdminActivity(adminUserId, action, targetType, targetId, metadata) {
  if (!supa) return;
  try {
    await supa.from('admin_activity_log').insert({
      admin_user_id: adminUserId || null,
      action,
      target_type: targetType || null,
      target_id: targetId != null ? String(targetId) : null,
      metadata: metadata || null,
    });
  } catch (e) {
    log('warn', 'admin_activity_log_failed', { action, error: e.message });
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  createStaffUser,
  verifyStaffLogin,
  createSession,
  resolveSession,
  revokeSession,
  logAdminActivity,
};
