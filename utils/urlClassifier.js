/**
 * Dedicated Instagram URL Parser and Classifier Module
 * 
 * Accurately identifies and parses specific Instagram URL types:
 * - Video posts (/p/{shortcode}/, /tv/{shortcode}/)
 * - Reels (/reel/{shortcode}/, /reels/{shortcode}/)
 * - Photo posts (/p/{shortcode}/)
 * - Stories (/stories/{username}/{story-id}/, /stories/{username}/)
 * - Highlights (/s/{share-token}, /stories/highlights/{id}/)
 * - DP / Profile pictures (/@{username}, /{username}/)
 */

const ALLOWED_HOSTS = new Set([
  'instagram.com',
  'www.instagram.com',
  'm.instagram.com',
  'instagr.am',
  'www.instagr.am'
]);

// Reserved system paths on Instagram that are not user profiles
const RESERVED_ROUTES = new Set([
  'explore',
  'direct',
  'accounts',
  'about',
  'developer',
  'legal',
  'api',
  'graphql',
  'reel',
  'reels',
  'p',
  'tv',
  'stories',
  's'
]);

/**
 * Classifies an incoming Instagram URL or identifier string.
 * @param {string} rawInput - Candidate URL or username
 * @param {string} [activeCategory='video'] - Active frontend tab context ('video' | 'reels' | 'photo' | 'dp' | 'stories' | 'highlights')
 * @returns {{
 *   isValid: boolean,
 *   urlType: 'video' | 'reel' | 'photo' | 'post' | 'tv' | 'story' | 'highlight' | 'dp' | 'invalid',
 *   category: 'video' | 'reels' | 'photo' | 'dp' | 'stories' | 'highlights',
 *   detectedLabel: string,
 *   normalizedUrl: string,
 *   originalUrl: string,
 *   shortcode: string | null,
 *   username: string | null,
 *   storyId: string | null,
 *   highlightId: string | null,
 *   error?: string
 * }}
 */
function classifyInstagramUrl(rawInput, activeCategory = 'reels') {
  if (!rawInput || typeof rawInput !== 'string') {
    return {
      isValid: false,
      urlType: 'invalid',
      category: activeCategory,
      detectedLabel: 'Invalid Input',
      normalizedUrl: '',
      originalUrl: String(rawInput || ''),
      shortcode: null,
      username: null,
      storyId: null,
      highlightId: null,
      error: 'Please enter a valid supported Instagram URL.'
    };
  }

  const trimmed = rawInput.trim();
  if (trimmed.length === 0) {
    return {
      isValid: false,
      urlType: 'invalid',
      category: activeCategory,
      detectedLabel: 'Empty Input',
      normalizedUrl: '',
      originalUrl: trimmed,
      shortcode: null,
      username: null,
      storyId: null,
      highlightId: null,
      error: 'Please enter a valid supported Instagram URL.'
    };
  }

  if (trimmed.length > 2048) {
    return {
      isValid: false,
      urlType: 'invalid',
      category: activeCategory,
      detectedLabel: 'Input Too Long',
      normalizedUrl: '',
      originalUrl: trimmed,
      shortcode: null,
      username: null,
      storyId: null,
      highlightId: null,
      error: 'The provided link exceeds the maximum allowed length.'
    };
  }

  // Handle direct username input in DP category (e.g. '@natgeo' or 'natgeo')
  if (activeCategory === 'dp') {
    const handleMatch = trimmed.match(/^@?([A-Za-z0-9._]+)$/);
    if (handleMatch && !trimmed.includes('/') && !trimmed.includes('.')) {
      const username = handleMatch[1];
      return {
        isValid: true,
        urlType: 'dp',
        category: 'dp',
        detectedLabel: 'Instagram Profile',
        normalizedUrl: `https://www.instagram.com/${username}/`,
        originalUrl: trimmed,
        shortcode: username,
        username,
        storyId: null,
        highlightId: null
      };
    }
  }

  // Parse candidate URL safely
  let parsed;
  try {
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    parsed = new URL(withProtocol);
  } catch (err) {
    return {
      isValid: false,
      urlType: 'invalid',
      category: activeCategory,
      detectedLabel: 'Malformed URL',
      normalizedUrl: '',
      originalUrl: trimmed,
      shortcode: null,
      username: null,
      storyId: null,
      highlightId: null,
      error: 'Please enter a valid supported Instagram URL.'
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      isValid: false,
      urlType: 'invalid',
      category: activeCategory,
      detectedLabel: 'Unsupported Protocol',
      normalizedUrl: '',
      originalUrl: trimmed,
      shortcode: null,
      username: null,
      storyId: null,
      highlightId: null,
      error: 'Only HTTP and HTTPS URLs are permitted.'
    };
  }

  if (parsed.username || parsed.password) {
    return {
      isValid: false,
      urlType: 'invalid',
      category: activeCategory,
      detectedLabel: 'Credentials In URL',
      normalizedUrl: '',
      originalUrl: trimmed,
      shortcode: null,
      username: null,
      storyId: null,
      highlightId: null,
      error: 'URLs containing user credentials are not allowed.'
    };
  }

  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    return {
      isValid: false,
      urlType: 'invalid',
      category: activeCategory,
      detectedLabel: 'Unsupported Domain',
      normalizedUrl: '',
      originalUrl: trimmed,
      shortcode: null,
      username: null,
      storyId: null,
      highlightId: null,
      error: `Unsupported domain "${host}". Please enter a valid supported Instagram URL.`
    };
  }

  // Normalize path
  const pathname = parsed.pathname.replace(/\/+/g, '/').replace(/\/$/, '');

  // 1. Highlights: /stories/highlights/{id}/, /s/{share-token}, /archive/stories/{id}/
  const highlightLongMatch = pathname.match(/^\/stories\/highlights\/([0-9]+)/i) || pathname.match(/^\/archive\/stories\/([0-9]+)/i);
  if (highlightLongMatch) {
    const highlightId = highlightLongMatch[1];
    return {
      isValid: true,
      urlType: 'highlight',
      category: 'highlights',
      detectedLabel: 'Instagram Highlight',
      normalizedUrl: `https://www.instagram.com/stories/highlights/${highlightId}/`,
      originalUrl: trimmed,
      shortcode: null, // Highlights do NOT use post shortcodes
      username: null,
      storyId: null,
      highlightId
    };
  }

  const highlightShareMatch = pathname.match(/^\/s\/([A-Za-z0-9_-]+)/i);
  if (highlightShareMatch) {
    const shareToken = highlightShareMatch[1];
    return {
      isValid: true,
      urlType: 'highlight',
      category: 'highlights',
      detectedLabel: 'Instagram Highlight Share',
      normalizedUrl: `https://www.instagram.com/s/${shareToken}/`,
      originalUrl: trimmed,
      shortcode: null,
      username: null,
      storyId: null,
      highlightId: shareToken
    };
  }

  // 2. Stories: /stories/{username}/{story-id}/ or /stories/{username} (excluding /stories/highlights)
  const storyMatch = pathname.match(/^\/stories\/([A-Za-z0-9._]+)(?:\/([0-9]+))?/i);
  if (storyMatch && storyMatch[1].toLowerCase() !== 'highlights') {
    const username = storyMatch[1];
    const storyId = storyMatch[2] || null;
    return {
      isValid: true,
      urlType: 'story',
      category: 'stories',
      detectedLabel: 'Instagram Story',
      normalizedUrl: `https://www.instagram.com/stories/${username}/${storyId ? storyId + '/' : ''}`,
      originalUrl: trimmed,
      shortcode: null, // Stories do NOT use shortcodes
      username,
      storyId,
      highlightId: null
    };
  }

  // 3. Reels: /reel/{shortcode}/ or /reels/{shortcode}/ or /share/reel/{shortcode}/
  const reelMatch = pathname.match(/^\/(?:share\/)?reels?\/([A-Za-z0-9_-]+)/i);
  if (reelMatch) {
    const shortcode = reelMatch[1];
    return {
      isValid: true,
      urlType: 'reel',
      category: 'reels',
      detectedLabel: 'Instagram Reel',
      normalizedUrl: `https://www.instagram.com/reel/${shortcode}/`,
      originalUrl: trimmed,
      shortcode,
      username: null,
      storyId: null,
      highlightId: null
    };
  }

  // 4. IGTV: /tv/{shortcode}/
  const tvMatch = pathname.match(/^\/(?:share\/)?tv\/([A-Za-z0-9_-]+)/i);
  if (tvMatch) {
    const shortcode = tvMatch[1];
    return {
      isValid: true,
      urlType: 'tv',
      category: 'reels',
      detectedLabel: 'Instagram Video (IGTV)',
      normalizedUrl: `https://www.instagram.com/tv/${shortcode}/`,
      originalUrl: trimmed,
      shortcode,
      username: null,
      storyId: null,
      highlightId: null
    };
  }

  // 5. Standard Posts / Photos / Carousels: /p/{shortcode}/ or /share/p/{shortcode}/
  const postMatch = pathname.match(/^\/(?:share\/)?p\/([A-Za-z0-9_-]+)/i);
  if (postMatch) {
    const shortcode = postMatch[1];
    const isPhotoCategory = activeCategory === 'photo';
    const isPostCategory = activeCategory === 'post';
    return {
      isValid: true,
      urlType: isPhotoCategory ? 'photo' : 'post',
      category: isPhotoCategory ? 'photo' : (isPostCategory ? 'post' : 'reels'),
      detectedLabel: isPhotoCategory ? 'Instagram Photo' : 'Instagram Post',
      normalizedUrl: `https://www.instagram.com/p/${shortcode}/`,
      originalUrl: trimmed,
      shortcode,
      username: null,
      storyId: null,
      highlightId: null
    };
  }

  // 6. DP (Profile Picture): /{username}/
  // Only matched when on 'dp' category or if path is a single non-reserved segment
  if (activeCategory === 'dp') {
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length === 1) {
      const username = segments[0];
      if (!RESERVED_ROUTES.has(username.toLowerCase())) {
        return {
          isValid: true,
          urlType: 'dp',
          category: 'dp',
          detectedLabel: 'Instagram Profile',
          normalizedUrl: `https://www.instagram.com/${username}/`,
          originalUrl: trimmed,
          shortcode: username,
          username,
          storyId: null,
          highlightId: null
        };
      }
    }
  }

  // If path was unrecognized
  return {
    isValid: false,
    urlType: 'invalid',
    category: activeCategory,
    detectedLabel: 'Unrecognized URL Format',
    normalizedUrl: '',
    originalUrl: trimmed,
    shortcode: null,
    username: null,
    storyId: null,
    highlightId: null,
    error: 'Please enter a valid supported Instagram URL.'
  };
}

module.exports = {
  classifyInstagramUrl,
  ALLOWED_HOSTS,
  RESERVED_ROUTES
};
