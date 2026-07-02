// ═══════════════════════════════════════════════════════════════
// src/clients/stripe.js
// عميل Stripe — null لو المفتاح مش موجود (يبقى الدفع معطّل، مش
// كراش)، بالظبط زي سلوك الملف الأصلي.
// ═══════════════════════════════════════════════════════════════

const env = require('./env');

const stripe = env.STRIPE_SECRET_KEY ? require('stripe')(env.STRIPE_SECRET_KEY) : null;

module.exports = stripe;
