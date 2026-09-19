const net = require('net');

function validIp(value) {
  if (typeof value !== 'string') return null;
  const ip = value.trim();
  return net.isIP(ip) ? ip : null;
}

// The Cloudflare-to-origin shared secret makes CF-Connecting-IP trustworthy
// for protected traffic. Deliberately ignore X-Forwarded-For: direct callers
// can supply an arbitrary chain in that header.
function clientIp(req) {
  const cloudflareIp = validIp(req?.headers?.['cf-connecting-ip']);
  if (cloudflareIp) return cloudflareIp;
  return validIp(req?.socket?.remoteAddress) || 'unknown';
}

module.exports = { clientIp, validIp };

