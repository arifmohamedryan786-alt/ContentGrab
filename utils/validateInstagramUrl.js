/**
 * Utility to validate and parse Instagram URLs
 * Delegates to the dedicated urlClassifier module for separate URL classification.
 */

const { classifyInstagramUrl, ALLOWED_HOSTS, RESERVED_ROUTES } = require('./urlClassifier');

/**
 * Validates and extracts details from a candidate Instagram URL string or username.
 * @param {string} rawUrl - The user submitted URL or username string.
 * @param {string} category - Selected category: 'video' | 'reels' | 'photo' | 'dp' | 'stories' | 'highlights'
 * @returns {{
 *   isValid: boolean,
 *   error?: string,
 *   url?: string,
 *   shortcode?: string,
 *   mediaType?: string,
 *   urlType?: string,
 *   detectedLabel?: string,
 *   normalizedUrl?: string,
 *   originalUrl?: string,
 *   username?: string,
 *   storyId?: string,
 *   highlightId?: string
 * }}
 */
function validateInstagramUrl(rawUrl, category = 'video') {
  const classified = classifyInstagramUrl(rawUrl, category);

  return {
    isValid: classified.isValid,
    error: classified.error,
    url: classified.normalizedUrl,
    shortcode: classified.shortcode,
    mediaType: classified.urlType,
    urlType: classified.urlType,
    detectedLabel: classified.detectedLabel,
    normalizedUrl: classified.normalizedUrl,
    originalUrl: classified.originalUrl,
    username: classified.username,
    storyId: classified.storyId,
    highlightId: classified.highlightId
  };
}

module.exports = {
  validateInstagramUrl,
  classifyInstagramUrl,
  ALLOWED_HOSTS,
  RESERVED_ROUTES
};
