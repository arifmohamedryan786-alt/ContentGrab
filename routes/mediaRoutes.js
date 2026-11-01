/**
 * Media Routes
 * Express router handling Instagram URL processing, preview streaming,
 * secure file downloads, carousel ZIP packaging, and download listing.
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const dns = require('dns');
const archiver = require('archiver');

const { validateInstagramUrl } = require('../utils/validateInstagramUrl');
const { classifyInstagramUrl } = require('../utils/urlClassifier');
const { validateSafeCdnUrl } = require('../utils/validateCdnUrl');
const {
  checkYtDlpHealth,
  checkFfmpegHealth,
  retrieveMedia,
  getCachedMedia,
  streamMediaDownload,
  downloadHighestQualityMedia,
  extractAudioTrack
} = require('../services/mediaService');

/**
 * Health check endpoint
 * GET /api/health
 */
router.get('/health', async (req, res) => {
  const [ytDlpHealth, ffmpegHealth, dnsCheck] = await Promise.all([
    checkYtDlpHealth(),
    checkFfmpegHealth(),
    new Promise((resolve) => {
      dns.lookup('www.instagram.com', (err, address) => {
        if (err) {
          resolve({ reachable: false, code: err.code || err.message });
        } else {
          resolve({ reachable: true, address });
        }
      });
    })
  ]);

  res.json({
    status: 'healthy',
    name: 'ContentGrab API',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    integrations: {
      ytDlp: ytDlpHealth,
      ffmpeg: ffmpegHealth
    },
    network: {
      instagramDns: dnsCheck
    }
  });
});

/**
 * URL Classification endpoint
 * GET /api/media/classify?url=...&category=...
 */
router.get('/media/classify', (req, res) => {
  const { url, category } = req.query;
  const classification = classifyInstagramUrl(url, category || 'video');
  res.json({
    success: classification.isValid,
    classification
  });
});

/**
 * Retrieve Instagram media metadata and prepare download references
 * POST /api/media
 * Body: { url: string, category?: string }
 */
router.post('/media', async (req, res) => {
  const { url, category } = req.body || {};
  const activeCategory = category || 'video';

  // 1. Validate & classify Instagram URL / username
  const classification = classifyInstagramUrl(url, activeCategory);
  if (!classification.isValid) {
    return res.status(400).json({
      success: false,
      errorCode: 'INVALID_URL',
      error: classification.error || 'Please enter a valid supported Instagram URL.',
      urlType: classification.urlType,
      detectedLabel: classification.detectedLabel
    });
  }

  // 2. Perform media retrieval with dedicated classification
  try {
    const result = await retrieveMedia(classification.normalizedUrl, classification, activeCategory);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        errorCode: result.errorCode || 'RETRIEVAL_FAILED',
        error: result.error,
        urlType: result.urlType || classification.urlType,
        detectedLabel: result.detectedLabel || classification.detectedLabel,
        urlRecognized: Boolean(result.urlRecognized !== false && classification.isValid),
        platformLimitation: result.platformLimitation || null,
        classification: {
          urlType: classification.urlType,
          detectedLabel: classification.detectedLabel,
          shortcode: classification.shortcode,
          username: classification.username,
          storyId: classification.storyId,
          highlightId: classification.highlightId
        }
      });
    }

    const { data } = result;

    const enhancedItems = data.items.map((item) => {
      const isVideo = item.type === 'video';
      const hasAudio = isVideo && item.hasAudio !== false;
      return {
        ...item,
        hasAudio,
        previewUrl: `/api/media/preview?mediaId=${data.id}&itemIndex=${item.index}`,
        downloadUrl: `/api/media/download?mediaId=${data.id}&itemIndex=${item.index}`,
        audioDownloadUrl: hasAudio ? `/api/media/audio?mediaId=${data.id}&itemIndex=${item.index}` : null
      };
    });

    return res.json({
      success: true,
      urlType: classification.urlType,
      detectedLabel: classification.detectedLabel,
      media: {
        ...data,
        items: enhancedItems,
        zipDownloadUrl: data.itemCount > 1 ? `/api/media/download-zip?mediaId=${data.id}` : null
      }
    });
  } catch (err) {
    console.error('Unexpected retrieval error:', err);
    return res.status(500).json({
      success: false,
      errorCode: 'INTERNAL_SERVER_ERROR',
      error: 'An internal error occurred while processing your request. Please try again.',
      urlType: classification.urlType,
      detectedLabel: classification.detectedLabel
    });
  }
});

/**
 * Stream media inline for preview in video/img tags
 * Follows CDN redirects server-side to prevent cross-origin blocks in the browser.
 * GET /api/media/preview?mediaId=...&itemIndex=0
 */
router.get('/media/preview', async (req, res) => {
  const { mediaId, itemIndex } = req.query;

  const record = getCachedMedia(mediaId);
  if (!record) {
    return res.status(404).json({ error: 'Media preview session expired or not found. Please retrieve the post again.' });
  }

  const idx = parseInt(itemIndex, 10) || 0;
  const item = record.items[idx];
  if (!item || (!item.directUrl && !item.thumbnail)) {
    return res.status(404).json({ error: 'Requested media item not found.' });
  }

  const targetStreamUrl = item.directUrl || item.thumbnail;
  pipeMediaStream(targetStreamUrl, res, item.type);
});

/**
 * Internal helper to safely pipe media streams with redirect handling
 */
async function pipeMediaStream(streamUrl, res, mediaType) {
  const validation = await validateSafeCdnUrl(streamUrl);
  if (!validation.isValid) {
    return res.status(400).json({ error: validation.error || 'Untrusted media source.' });
  }

  const parsedUrl = new URL(streamUrl);
  const clientLib = parsedUrl.protocol === 'https:' ? https : http;

  const clientReq = clientLib.get(
    streamUrl,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': '*/*'
      },
      timeout: 25000
    },
    (remoteRes) => {
      // Follow redirects server-side
      if (remoteRes.statusCode === 301 || remoteRes.statusCode === 302 || remoteRes.statusCode === 307) {
        if (remoteRes.headers.location) {
          return pipeMediaStream(remoteRes.headers.location, res, mediaType);
        }
      }

      if (remoteRes.statusCode !== 200 && remoteRes.statusCode !== 206) {
        return res.status(remoteRes.statusCode).end();
      }

      res.setHeader('Content-Type', remoteRes.headers['content-type'] || (mediaType === 'video' ? 'video/mp4' : 'image/jpeg'));
      res.setHeader('Content-Disposition', 'inline');
      if (remoteRes.headers['content-length']) {
        res.setHeader('Content-Length', remoteRes.headers['content-length']);
      }

      remoteRes.pipe(res);
    }
  );

  clientReq.on('error', () => {
    if (!res.headersSent) res.status(502).end();
  });
  clientReq.on('timeout', () => {
    clientReq.destroy();
    if (!res.headersSent) res.status(504).end();
  });
}

/**
 * Download individual media file
 * GET /api/media/download?mediaId=...&itemIndex=0
 */
router.get('/media/download', async (req, res) => {
  const { mediaId, itemIndex } = req.query;

  const record = getCachedMedia(mediaId);
  if (!record) {
    return res.status(404).json({
      error: 'Media session expired. Please paste the Instagram URL and retrieve media again.'
    });
  }

  const idx = parseInt(itemIndex, 10) || 0;
  const item = record.items[idx];
  if (!item || (!item.directUrl && !item.thumbnail && !item.videoStreamUrl)) {
    return res.status(404).json({ error: 'Specified media item not found.' });
  }

  const filename = item.suggestedFilename || `instagram_${record.shortcode}_${idx + 1}.${item.ext || 'mp4'}`;

  await downloadHighestQualityMedia(record, idx, filename, res);
});

/**
 * Download extracted audio track for Reel / Video media
 * GET /api/media/audio?mediaId=...&itemIndex=0
 */
router.get('/media/audio', async (req, res) => {
  const { mediaId, itemIndex } = req.query;

  // 1. Validate download token / mediaId against cache (Never accept arbitrary URLs)
  const record = getCachedMedia(mediaId);
  if (!record) {
    return res.status(404).json({
      success: false,
      error: 'Media session expired. Please paste the Instagram Reel URL and retrieve media again.'
    });
  }

  // 2. Validate item index
  const idx = parseInt(itemIndex, 10) || 0;
  const item = record.items[idx];
  if (!item) {
    return res.status(404).json({
      success: false,
      error: 'Specified Reel media item not found.'
    });
  }

  // 3. Verify media is a video
  if (item.type !== 'video') {
    return res.status(400).json({
      success: false,
      error: 'Audio download is only available for video media.'
    });
  }

  // 4. Verify audio is not explicitly flagged as unavailable
  if (item.hasAudio === false) {
    return res.status(422).json({
      success: false,
      error: 'This Reel does not contain an audio track.'
    });
  }

  try {
    const audioResult = await extractAudioTrack(record, idx);

    if (!audioResult.success) {
      const status = audioResult.noAudio ? 422 : 500;
      return res.status(status).json({
        success: false,
        error: audioResult.error || 'Unable to prepare the audio from this Reel. Please try again or download the original video.'
      });
    }

    const { audioPath, audioFilename } = audioResult;
    const stats = fs.statSync(audioPath);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${audioFilename}"`);
    res.setHeader('Content-Length', stats.size);

    const stream = fs.createReadStream(audioPath);
    stream.pipe(res);

    stream.on('error', (err) => {
      console.error('Audio streaming error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to deliver audio stream.' });
      }
    });
  } catch (err) {
    console.error('Audio processing error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'Unable to prepare the audio from this Reel. Please try again or download the original video.'
      });
    }
  }
});

/**
 * Download all carousel media items as a single ZIP archive
 * GET or POST /api/media/download-zip?mediaId=...
 */
router.all('/media/download-zip', async (req, res) => {
  const mediaId = req.query.mediaId || req.body?.mediaId;

  const record = getCachedMedia(mediaId);
  if (!record) {
    return res.status(404).json({
      error: 'Media session expired. Please paste the Instagram URL and retrieve media again.'
    });
  }

  const zipFilename = `instagram_${record.shortcode}_carousel.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

  const archive = archiver('zip', {
    zlib: { level: 6 }
  });

  archive.on('error', (err) => {
    console.error('ZIP archive generation error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to generate carousel ZIP archive.' });
    }
  });

  archive.pipe(res);

  // Fetch each item in sequence and append to archive
  for (const item of record.items) {
    const streamSource = item.directUrl || item.thumbnail;
    if (!streamSource) continue;

    const validation = await validateSafeCdnUrl(streamSource);
    if (!validation.isValid) continue;

    try {
      const buffer = await fetchBuffer(streamSource);
      if (buffer) {
        archive.append(buffer, { name: item.suggestedFilename });
      }
    } catch (err) {
      console.warn(`Could not add ${item.suggestedFilename} to ZIP:`, err.message);
    }
  }

  await archive.finalize();
});

/**
 * List files saved in the local downloads/ directory
 * GET /api/media/downloads
 */
router.get('/media/downloads', (req, res) => {
  const downloadDir = path.resolve(__dirname, '..', 'downloads');
  if (!fs.existsSync(downloadDir)) {
    return res.json({ files: [] });
  }

  fs.readdir(downloadDir, { withFileTypes: true }, (err, entries) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to inspect local downloads folder.' });
    }

    const files = entries
      .filter(e => e.isFile() && !e.name.startsWith('.'))
      .map(e => {
        const filePath = path.join(downloadDir, e.name);
        const stats = fs.statSync(filePath);
        return {
          filename: e.name,
          sizeBytes: stats.size,
          createdAt: stats.mtime
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);

    res.json({ files });
  });
});

/**
 * Helper to fetch remote media buffer for ZIP packaging
 * @param {string} remoteUrl
 * @returns {Promise<Buffer|null>}
 */
function fetchBuffer(remoteUrl) {
  return new Promise((resolve) => {
    const parsed = new URL(remoteUrl);
    const clientLib = parsed.protocol === 'https:' ? https : http;

    const req = clientLib.get(
      remoteUrl,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
        },
        timeout: 25000
      },
      (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
          if (res.headers.location) {
            return fetchBuffer(res.headers.location).then(resolve);
          }
        }
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          return resolve(null);
        }

        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );

    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

module.exports = router;
