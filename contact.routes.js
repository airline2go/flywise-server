// ═══════════════════════════════════════════════════════════════
// src/routes/contact.routes.js
// نموذج التواصل — بيبعت الرسالة فعلياً لإيميل الدعم عن طريق Brevo.
// ═══════════════════════════════════════════════════════════════

const env = require('../config/env');
const log = require('../utils/log');
const rateLimit = require('../middleware/rateLimit');
const { sendEmail } = require('../services/email');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = (app) => {

app.post('/contact', rateLimit('contact', 5, 60000), async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ ok: false, error: 'Name, E-Mail und Nachricht sind erforderlich' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Ungültige E-Mail-Adresse' });
    }
    const safeName = String(name).slice(0, 200);
    const safeSubject = String(subject || 'Kontaktformular').slice(0, 200);
    const safeMessage = String(message).slice(0, 5000);

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#0FB5A0">📩 Neue Nachricht über das Kontaktformular</h2>
        <p><strong>Von:</strong> ${escapeHtml(safeName)} (${escapeHtml(email)})</p>
        <p><strong>Betreff:</strong> ${escapeHtml(safeSubject)}</p>
        <div style="background:#f6f8fa;border-radius:8px;padding:14px;margin-top:10px;white-space:pre-wrap">${escapeHtml(safeMessage)}</div>
      </div>`;

    const sent = await sendEmail(env.SUPPORT_EMAIL, `Kontaktformular: ${safeSubject}`, html);
    if (!sent) return res.status(502).json({ ok: false, error: 'Nachricht konnte nicht gesendet werden' });
    log('info', 'contact_form_sent', { from: email });
    res.json({ ok: true });
  } catch (err) {
    log('error', 'contact_form_failed', { error: err.message });
    res.status(500).json({ ok: false, error: 'Interner Fehler' });
  }
});
};
