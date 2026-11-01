/**
 * Utility to validate media URLs to protect against SSRF (Server-Side Request Forgery).
 * Strictly checks that remote media downloads only target legitimate Instagram / Meta CDN hostnames.
 */

const dns = require('dns').promises;
const net = require('net');

// Allowed CDN domains for Instagram / Meta media files
const ALLOWED_CDN_SUFFIXES = [
  'cdninstagram.com',
  'fbcdn.net',
  'instagram.com'
];

/**
 * Checks if a hostname matches legitimate Instagram CDN suffixes.
 * @param {string} hostname
 * @returns {boolean}
 */
function isAllowedCdnHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  const lower = hostname.toLowerCase();

  // Explicitly disallow IP address literals as hostnames
  if (net.isIP(lower)) return false;

  return ALLOWED_CDN_SUFFIXES.some(suffix => {
    return lower === suffix || lower.endsWith('.' + suffix);
  });
}

/**
 * Checks if an IP is private or restricted (loopback, RFC1918, link-local, carrier-grade NAT, multicast).
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateOrReservedIp(ip) {
  if (!net.isIP(ip)) return true;

  // IPv4 checks
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [b0, b1] = parts;

    // 0.0.0.0/8 (current network)
    if (b0 === 0) return true;
    // 127.0.0.0/8 (loopback)
    if (b0 === 127) return true;
    // 10.0.0.0/8 (private)
    if (b0 === 10) return true;
    // 172.16.0.0/12 (private)
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
    // 192.168.0.0/16 (private)
    if (b0 === 192 && b1 === 168) return true;
    // 169.254.0.0/16 (link-local / AWS metadata)
    if (b0 === 169 && b1 === 254) return true;
    // 100.64.0.0/10 (CGNAT)
    if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
    // Multicast & broadcast
    if (b0 >= 224) return true;

    return false;
  }

  // IPv6 checks
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    if (normalized === '::1' || normalized === '::') return true;
    if (normalized.startsWith('fe80:')) return true; // link-local
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique local
  }

  return false;
}

/**
 * Validates a remote URL for safe fetching.
 * @param {string} rawUrl
 * @returns {Promise<{ isValid: boolean, error?: string, parsedUrl?: URL }>}
 */
async function validateSafeCdnUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { isValid: false, error: 'Empty media URL provided.' };
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { isValid: false, error: 'Invalid media URL format.' };
  }

  if (parsed.protocol !== 'https:') {
    return { isValid: false, error: 'Only HTTPS media links are accepted.' };
  }

  if (parsed.username || parsed.password) {
    return { isValid: false, error: 'URL contains prohibited credentials.' };
  }

  if (!isAllowedCdnHost(parsed.hostname)) {
    return { isValid: false, error: `Host "${parsed.hostname}" is not an authorized Instagram CDN.` };
  }

  // Resolve hostname via DNS to ensure it doesn't map to a private or internal IP address
  try {
    const lookup = await dns.lookup(parsed.hostname);
    if (isPrivateOrReservedIp(lookup.address)) {
      return { isValid: false, error: 'The media host resolved to an unauthorized private network address.' };
    }
  } catch (err) {
    return { isValid: false, error: `Failed to resolve media host: ${err.message}` };
  }

  return { isValid: true, parsedUrl: parsed };
}

module.exports = {
  isAllowedCdnHost,
  isPrivateOrReservedIp,
  validateSafeCdnUrl
};

