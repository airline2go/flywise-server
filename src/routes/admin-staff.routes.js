// ═══════════════════════════════════════════════════════════════
// src/routes/admin-staff.routes.js
// [STAFF] تسجيل دخول/خروج الموظفين + إدارة حسابات الفريق —
// كل شي هنا إضافي فوق تسجيل دخول ADMIN_TOKEN القديم (اللي بيفضل
// شغال زي ما هو في admin.routes.js). فقط صاحب دور 'admin' (المالك
// أو ADMIN_TOKEN) يقدر يدير الموظفين — موظف staff ما بيقدر ينشئ
// موظف تاني أو يرفع صلاحياته لحاله.
// ═══════════════════════════════════════════════════════════════

const log = require('../utils/log');
const supa = require('../clients/supabase');
const rateLimit = require('../middleware/rateLimit');
const { requireAdmin, requireFullAdmin } = require('../middleware/auth');
const { createStaffUser, verifyStaffLogin, createSession, revokeSession, logAdminActivity, hashPassword } = require('../services/adminAuth');

module.exports = (app) => {

// ─── POST /admin/staff-login ───────────────────────────────
// عام تماماً (زي /admin/login القديم) — هاد هو تسجيل الدخول نفسه،
// مش محمي بـ requireAdmin. rate limit أشد من الباقي عمداً — فرصة
// تخمين كلمة مرور أقل بكثير.
app.post('/admin/staff-login', rateLimit('staff_login', 5, 15 * 60000), async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok: false, error: 'E-Mail und Passwort erforderlich' });
    const user = await verifyStaffLogin(email, password);
    if (!user) {
      log('warn', 'staff_login_failed', { email: String(email).toLowerCase(), ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress });
      return res.status(401).json({ ok: false, error: 'Ungültige Anmeldedaten' });
    }
    const token = await createSession(user.id, user.role);
    log('info', 'staff_login_success', { adminUserId: user.id, role: user.role });
    res.json({ ok: true, token, role: user.role, name: user.name });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/staff-logout', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    // لو كان ADMIN_TOKEN القديم (adminUserId=null) فما فيه جلسة
    // نمسحها أصلاً — بس بنرجع نجاح برضو، تسجيل الخروج آمن دايماً.
    if (req.adminUserId) await revokeSession(token);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Staff management — كلها requireFullAdmin ────────────────
app.get('/admin/staff', rateLimit('admin', 120, 60000), requireFullAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data, error } = await supa.from('admin_users')
      .select('id,email,name,role,active,created_at,created_by_admin_id')
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    res.json({ ok: true, staff: data || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/staff', rateLimit('admin', 120, 60000), requireFullAdmin, async (req, res) => {
  try {
    const { email, name, password, role } = req.body || {};
    const user = await createStaffUser({ email, name, password, role, createdByAdminId: req.adminUserId });
    logAdminActivity(req.adminUserId, 'staff_created', 'admin_user', user.id, { email: user.email, role: user.role });
    res.json({ ok: true, staff: { id: user.id, email: user.email, name: user.name, role: user.role, active: user.active } });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

app.put('/admin/staff/:id', rateLimit('admin', 120, 60000), requireFullAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { name, role, active, password } = req.body || {};
    const updates = {};
    if (typeof name === 'string' && name.trim()) updates.name = name.trim();
    if (role === 'admin' || role === 'staff') updates.role = role;
    if (typeof active === 'boolean') updates.active = active;
    if (typeof password === 'string' && password) {
      if (password.length < 8) return res.status(400).json({ ok: false, error: 'Passwort muss mindestens 8 Zeichen haben' });
      updates.password_hash = hashPassword(password);
    }

    // [LAST-ADMIN-GUARD] رفض أي تعديل ممكن يسيب لوحة التحكم بدون
    // أي حساب 'admin' فعال — سواء بإلغاء تفعيل آخر حساب admin أو
    // بتخفيض دوره لـ staff. ADMIN_TOKEN بيفضل موجود كـ fallback
    // دايماً، بس القاعدة هون عشان جدول admin_users نفسه ما يوصلش
    // لحالة بدون أي admin فعال.
    const demotingOrDeactivatingAdmin = (updates.role === 'staff') || (updates.active === false);
    if (demotingOrDeactivatingAdmin) {
      const { data: target } = await supa.from('admin_users').select('role,active').eq('id', req.params.id).maybeSingle();
      if (target && target.role === 'admin' && target.active) {
        const { count } = await supa.from('admin_users').select('id', { count: 'exact', head: true }).eq('role', 'admin').eq('active', true);
        if ((count || 0) <= 1) {
          return res.status(400).json({ ok: false, error: 'Der letzte aktive Administrator kann nicht entfernt werden' });
        }
      }
    }

    const { data, error } = await supa.from('admin_users').update(updates).eq('id', req.params.id).select('id,email,name,role,active').maybeSingle();
    if (error) throw new Error(error.message);
    logAdminActivity(req.adminUserId, 'staff_updated', 'admin_user', req.params.id, { updates: Object.keys(updates) });
    res.json({ ok: true, staff: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/admin/staff/:id', rateLimit('admin', 120, 60000), requireFullAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data: target } = await supa.from('admin_users').select('role,active').eq('id', req.params.id).maybeSingle();
    if (target && target.role === 'admin' && target.active) {
      const { count } = await supa.from('admin_users').select('id', { count: 'exact', head: true }).eq('role', 'admin').eq('active', true);
      if ((count || 0) <= 1) {
        return res.status(400).json({ ok: false, error: 'Der letzte aktive Administrator kann nicht entfernt werden' });
      }
    }
    const { error } = await supa.from('admin_users').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    logAdminActivity(req.adminUserId, 'staff_deleted', 'admin_user', req.params.id, {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

};
