/**
 * Media Service
 * Handles retrieval of Instagram public media (Reels, Posts, Carousels)
 * using the enhanced Python/curl_cffi extractor with yt-dlp fallback.
 */

const { execFile } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { validateSafeCdnUrl } = require('../utils/validateCdnUrl');

const PYTHON_BIN_CANDIDATES = [
  '/Library/Frameworks/Python.framework/Versions/3.14/bin/python3',
  '/opt/homebrew/bin/python3',
  '/usr/local/bin/python3',
  'python3'
];

let resolvedPythonPath = null;

function getPythonPath() {
  if (resolvedPythonPath) return resolvedPythonPath;
  for (const candidate of PYTHON_BIN_CANDIDATES) {
    if (candidate === 'python3') {
      resolvedPythonPath = 'python3';
      return resolvedPythonPath;
    }
    if (fs.existsSync(candidate)) {
      resolvedPythonPath = candidate;
      return resolvedPythonPath;
    }
  }
  return 'python3';
}

const FFMPEG_BIN_CANDIDATES = [
  '/opt/homebrew/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  '/usr/bin/ffmpeg',
  'ffmpeg'
];

let resolvedFfmpegPath = null;

function getFfmpegPath() {
  if (resolvedFfmpegPath) return resolvedFfmpegPath;
  for (const candidate of FFMPEG_BIN_CANDIDATES) {
    if (candidate === 'ffmpeg') {
      resolvedFfmpegPath = 'ffmpeg';
      return resolvedFfmpegPath;
    }
    if (fs.existsSync(candidate)) {
      resolvedFfmpegPath = candidate;
      return resolvedFfmpegPath;
    }
  }
  return 'ffmpeg';
}

function checkFfmpegHealth() {
  return new Promise((resolve) => {
    const ffmpeg = getFfmpegPath();
    execFile(ffmpeg, ['-version'], { timeout: 5000 }, (error, stdout) => {
      if (error) {
        resolve({ available: false, error: error.message, path: ffmpeg });
      } else {
        resolve({
          available: true,
          version: stdout.split('\n')[0].trim(),
          path: ffmpeg
        });
      }
    });
  });
}

const FFPROBE_BIN_CANDIDATES = [
  '/opt/homebrew/bin/ffprobe',
  '/usr/local/bin/ffprobe',
  '/usr/bin/ffprobe',
  'ffprobe'
];

let resolvedFfprobePath = null;

function getFfprobePath() {
  if (resolvedFfprobePath) return resolvedFfprobePath;
  for (const candidate of FFPROBE_BIN_CANDIDATES) {
    if (candidate === 'ffprobe') {
      resolvedFfprobePath = 'ffprobe';
      return resolvedFfprobePath;
    }
    if (fs.existsSync(candidate)) {
      resolvedFfprobePath = candidate;
      return resolvedFfprobePath;
    }
  }
  return 'ffprobe';
}

/**
 * Accurately classifies media quality based on authentic pixel dimensions.
 * Returns { qualityLabel, is4K, tier }.
 * Tier 1 = 4K, Tier 2 = 1440p, Tier 3 = Full HD, Tier 4 = HD, Tier 5 = Original/SD.
 * Never artificially upscales or labels 1080p/1440p as 4K.
 * @param {number|string} width
 * @param {number|string} height
 * @returns {{ qualityLabel: string, is4K: boolean, tier: number }}
 */
function classifyResolution(width, height) {
  if (!width || !height) return { qualityLabel: 'Original', is4K: false, tier: 5 };
  const w = parseInt(width, 10);
  const h = parseInt(height, 10);
  if (isNaN(w) || isNaN(h) || w <= 0 || h <= 0) {
    return { qualityLabel: 'Original', is4K: false, tier: 5 };
  }
  const minDim = Math.min(w, h);
  const maxDim = Math.max(w, h);
  const totalPixels = w * h;

  // 1. True 4K / UHD: minimum dimension >= 2160 or max dimension >= 3840 or total pixels >= 8,000,000
  if (minDim >= 2160 || maxDim >= 3840 || totalPixels >= 8000000) {
    return { qualityLabel: '4K', is4K: true, tier: 1 };
  }
  // 2. 1440p / QHD: minimum dimension >= 1440 or max dimension >= 2560 or total pixels >= 3,600,000
  if (minDim >= 1440 || maxDim >= 2560 || totalPixels >= 3600000) {
    return { qualityLabel: '1440p', is4K: false, tier: 2 };
  }
  // 3. Full HD (1080p): minimum dimension >= 1080 or max dimension >= 1920 or total pixels >= 1,900,000
  if (minDim >= 1080 || maxDim >= 1920 || totalPixels >= 1900000) {
    return { qualityLabel: 'Full HD', is4K: false, tier: 3 };
  }
  // 4. HD (720p): minimum dimension >= 720 or max dimension >= 1280
  if (minDim >= 720 || maxDim >= 1280) {
    return { qualityLabel: 'HD', is4K: false, tier: 4 };
  }
  // 5. Standard / Original
  return { qualityLabel: 'Original', is4K: false, tier: 5 };
}

/**
 * Detailed probe of video and audio streams inside a media file.
 * Evaluates full dimensions, video codec, pixel format, audio codec, and QuickTime/Apple device compatibility.
 * @param {string} filePath
 * @returns {Promise<{
 *   width: number|null,
 *   height: number|null,
 *   vcodec: string|null,
 *   pixFmt: string|null,
 *   acodec: string|null,
 *   hasAudio: boolean,
 *   isQuickTimeCompatible: boolean,
 *   qualityLabel: string,
 *   is4K: boolean,
 *   tier: number
 * }|null>}
 */
function probeMediaDetails(filePath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(filePath)) return resolve(null);
    const ffprobe = getFfprobePath();
    execFile(
      ffprobe,
      [
        '-v', 'error',
        '-show_entries', 'stream=index,codec_type,codec_name,pix_fmt,profile,width,height',
        '-of', 'json',
        filePath
      ],
      { timeout: 10000 },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        try {
          const parsed = JSON.parse(stdout);
          const streams = parsed?.streams || [];
          const vStream = streams.find(s => s.codec_type === 'video');
          const aStream = streams.find(s => s.codec_type === 'audio');

          let width = null, height = null, vcodec = null, pixFmt = null, acodec = null;
          if (vStream) {
            width = parseInt(vStream.width, 10) || null;
            height = parseInt(vStream.height, 10) || null;
            vcodec = vStream.codec_name ? vStream.codec_name.toLowerCase() : null;
            pixFmt = vStream.pix_fmt ? vStream.pix_fmt.toLowerCase() : null;
          }
          if (aStream) {
            acodec = aStream.codec_name ? aStream.codec_name.toLowerCase() : null;
          }

          const cls = classifyResolution(width, height);

          // Standard Apple / QuickTime / iOS compatibility requirements:
          // 1. Video codec must be H.264 (avc1 / h264)
          // 2. Pixel format must be yuv420p (required for macOS QuickTime Player, iOS, and Safari)
          // 3. Audio codec (if present) must be AAC
          const isVideoCompatible = !vStream || (
            (vcodec === 'h264' || vcodec === 'avc1') &&
            (pixFmt === 'yuv420p' || !pixFmt)
          );
          const isAudioCompatible = !aStream || (
            acodec === 'aac' || acodec === 'mp4a'
          );
          const isQuickTimeCompatible = Boolean(vStream && isVideoCompatible && isAudioCompatible);

          resolve({
            width,
            height,
            vcodec,
            pixFmt,
            acodec,
            hasAudio: Boolean(aStream),
            isQuickTimeCompatible,
            qualityLabel: cls.qualityLabel,
            is4K: cls.is4K,
            tier: cls.tier
          });
        } catch (_) {
          resolve(null);
        }
      }
    );
  });
}

/**
 * Validates and measures the true pixel dimensions and codec of a local media file.
 * Used to verify authentic resolution (4K, 1440p, 1080p) without guessing.
 * @param {string} filePath
 * @returns {Promise<{ width: number, height: number, codec: string, pixFmt: string, audioCodec: string, isQuickTimeCompatible: boolean, qualityLabel: string, is4K: boolean, tier: number }|null>}
 */
function probeMediaDimensions(filePath) {
  return probeMediaDetails(filePath).then((details) => {
    if (!details) return null;
    return {
      width: details.width,
      height: details.height,
      codec: details.vcodec,
      pixFmt: details.pixFmt,
      audioCodec: details.acodec,
      isQuickTimeCompatible: details.isQuickTimeCompatible,
      qualityLabel: details.qualityLabel,
      is4K: details.is4K,
      tier: details.tier
    };
  });
}

/**
 * In-memory LRU store for recently retrieved media items.
 * Keys: mediaId (UUID)
 */
const mediaCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60 * 2; // 2 hours

function purgeOldCache() {
  const now = Date.now();
  for (const [id, record] of mediaCache.entries()) {
    if (now - record.timestamp > CACHE_TTL_MS) {
      mediaCache.delete(id);
    }
  }
}
setInterval(purgeOldCache, 1000 * 60 * 15).unref();

/**
 * Health check verification
 */
function checkYtDlpHealth() {
  return new Promise((resolve) => {
    const py = getPythonPath();
    execFile(py, ['--version'], { timeout: 5000 }, (error, stdout) => {
      if (error) {
        resolve({ available: false, error: error.message });
      } else {
        resolve({
          available: true,
          version: stdout.trim(),
          path: py,
          python: py
        });
      }
    });
  });
}

/**
 * Executes services/extractor.py safely
 * @param {string} targetUrl
 * @param {string} category
 * @param {string} [urlType]
 * @returns {Promise<any>}
 */
function runExtractor(targetUrl, category = 'video', urlType = '') {
  return new Promise((resolve, reject) => {
    const py = getPythonPath();
    const scriptPath = path.resolve(__dirname, 'extractor.py');

    const args = [scriptPath, targetUrl, category];
    if (urlType) {
      args.push(urlType);
    }

    execFile(py, args, { timeout: 35000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (stdout && stdout.trim()) {
        try {
          const parsed = JSON.parse(stdout.trim());
          return resolve(parsed);
        } catch (parseErr) {
          // Continue to error handler if stdout is not JSON
        }
      }

      if (error) {
        return reject({ error, stderr });
      }

      reject({ error: new Error('Empty output from extractor'), stderr });
    });
  });
}

/**
 * Ensures user-facing error messages are clean and descriptive.
 * Technical errors, curl codes, and external documentation URLs are stripped.
 * @param {string} rawError
 * @param {string} errorCode
 * @returns {string}
 */
function sanitizeUserErrorMessage(rawError, errorCode) {
  if (!rawError || typeof rawError !== 'string') {
    return 'Unable to retrieve media from Instagram. Please try again.';
  }

  // Network, timeout, or DNS failure -> show consistent user-facing message
  if (
    errorCode === 'NETWORK_ERROR' ||
    errorCode === 'NETWORK_TIMEOUT' ||
    /could not resolve host|curl:\s*\(6\)|curl:\s*\(7\)|curl:\s*\(28\)|transporterror|getaddrinfo|nodename nor servname|name or service not known|failed to perform, curl|network is unreachable|connection refused|connection reset|econnrefused|enotfound|timed out|timeout|etimedout/i.test(rawError)
  ) {
    return 'Unable to connect to Instagram. Please check your internet connection and try again.';
  }

  // Strip raw curl, traceback, or documentation URLs
  if (/curl\.se|libcurl|transporterror|traceback|line \d+/i.test(rawError)) {
    return 'Unable to retrieve media from Instagram. Please verify the URL and try again.';
  }

  return rawError;
}

/**
 * Public method: Retrieves media for a verified Instagram URL.
 * @param {string} normalizedUrl
 * @param {string|object} shortcodeOrClassification
 * @param {string} category
 * @returns {Promise<{ success: boolean, data?: object, error?: string, errorCode?: string, urlType?: string, detectedLabel?: string }>}
 */
async function retrieveMedia(normalizedUrl, shortcodeOrClassification, category = 'video') {
  const isClassObj = typeof shortcodeOrClassification === 'object' && shortcodeOrClassification !== null;
  const shortcode = isClassObj
    ? (shortcodeOrClassification.shortcode || shortcodeOrClassification.username || shortcodeOrClassification.highlightId || 'item')
    : shortcodeOrClassification;
  const urlType = isClassObj ? (shortcodeOrClassification.urlType || category) : category;
  const detectedLabel = isClassObj ? shortcodeOrClassification.detectedLabel : `${category.toUpperCase()}`;

  console.log(`[MEDIA REQUEST] Initiating extraction for ${detectedLabel} (${shortcode}) in category: ${category}`);

  try {
    const result = await runExtractor(normalizedUrl, category, urlType);

    if (!result || !result.success) {
      const sanitizedMsg = sanitizeUserErrorMessage(result?.error, result?.error_code);
      const errCode = result?.error_code || 'EXTRACTION_FAILED';
      console.warn(`[MEDIA WARN] ${detectedLabel} (${shortcode}) retrieval notice: ${sanitizedMsg} (Code: ${errCode})`);

      return {
        success: false,
        errorCode: errCode,
        error: sanitizedMsg,
        urlType,
        detectedLabel,
        urlRecognized: Boolean(result?.url_recognized || isClassObj),
        platformLimitation: result?.platform_limitation || null
      };
    }

    const { data } = result;
    const mediaId = crypto.randomUUID();
    const downloadDir = path.resolve(__dirname, '..', 'downloads');

    // Verify each item's actual dimensions if already downloaded or verify with classifyResolution
    const verifiedItems = await Promise.all((data.items || []).map(async (item) => {
      let w = item.width;
      let h = item.height;
      let is4kVal = item.is4K;
      let qLabel = item.qualityLabel;
      let tierVal = item.tier;

      // Check if this item's file already exists on disk
      const localFilePath = path.join(downloadDir, item.suggestedFilename || `instagram_${data.shortcode || shortcode}.${item.ext || 'mp4'}`);
      if (fs.existsSync(localFilePath) && fs.statSync(localFilePath).size > 1000) {
        const probed = await probeMediaDimensions(localFilePath);
        if (probed && probed.width && probed.height) {
          w = probed.width;
          h = probed.height;
          is4kVal = probed.is4K;
          qLabel = probed.qualityLabel;
          tierVal = probed.tier;
        }
      }

      const cls = classifyResolution(w, h);
      const resolution = (w && h) ? `${w}×${h}` : (item.resolution || 'Original');
      const qualityLabel = qLabel || cls.qualityLabel;
      const is4K = (is4kVal !== undefined && is4kVal !== null) ? Boolean(is4kVal) : cls.is4K;
      const tier = tierVal || cls.tier;

      return {
        ...item,
        width: w,
        height: h,
        hasAudio: item.type === 'video' && item.hasAudio !== false,
        resolution,
        qualityLabel,
        is4K,
        tier
      };
    }));

    const record = {
      id: mediaId,
      shortcode: data.shortcode || shortcode,
      url: data.url || normalizedUrl,
      title: data.title || `${detectedLabel} (${shortcode})`,
      uploader: data.uploader || null,
      uploaderName: data.uploaderName || null,
      mediaType: data.mediaType || urlType || 'post',
      itemCount: data.itemCount || (verifiedItems.length || 1),
      items: verifiedItems,
      timestamp: Date.now()
    };

    // Cache in server memory for safe downloads
    mediaCache.set(mediaId, record);

    console.log(`[MEDIA SUCCESS] Shortcode ${shortcode} extracted successfully (${record.mediaType}, ${record.itemCount} item(s))`);

    return {
      success: true,
      data: {
        id: record.id,
        shortcode: record.shortcode,
        url: record.url,
        title: record.title,
        uploader: record.uploader,
        uploaderName: record.uploaderName,
        mediaType: record.mediaType,
        itemCount: record.itemCount,
        items: record.items.map(item => ({
          index: item.index,
          type: item.type,
          thumbnail: item.thumbnail,
          hasDirectStream: Boolean(item.directUrl),
          width: item.width,
          height: item.height,
          resolution: item.resolution,
          qualityLabel: item.qualityLabel,
          is4K: item.is4K,
          tier: item.tier,
          duration: item.duration,
          ext: item.ext,
          hasAudio: item.type === 'video' && item.hasAudio !== false,
          suggestedFilename: item.suggestedFilename
        }))
      }
    };
  } catch (errInfo) {
    const errObj = errInfo?.error || errInfo;
    const rawStderr = errInfo?.stderr || '';
    console.error(`[MEDIA ERROR] Extraction process failure on ${shortcode}:`, errObj?.message || errInfo, rawStderr ? `| stderr: ${rawStderr}` : '');

    const isTimeout = errObj?.killed || errObj?.signal === 'SIGTERM' || errObj?.code === 'ETIMEDOUT';
    const rawStr = `${errObj?.message || ''} ${rawStderr}`;
    const isNetwork = isTimeout || /could not resolve host|curl:\s*\(6\)|curl:\s*\(7\)|curl:\s*\(28\)|transporterror|nodename nor servname|getaddrinfo|network is unreachable|connection refused|econnrefused|enotfound|timed out|timeout/i.test(rawStr);

    if (isNetwork) {
      return {
        success: false,
        errorCode: 'NETWORK_ERROR',
        error: 'Unable to connect to Instagram. Please check your internet connection and try again.',
        urlType,
        detectedLabel,
        urlRecognized: Boolean(isClassObj)
      };
    }

    return {
      success: false,
      errorCode: 'INTERNAL_ERROR',
      error: 'Unable to retrieve media from Instagram. Please verify the URL and try again.',
      urlType,
      detectedLabel,
      urlRecognized: Boolean(isClassObj)
    };
  }
}

/**
 * Looks up a cached media record by its unique ID.
 * @param {string} mediaId
 * @returns {object|null}
 */
function getCachedMedia(mediaId) {
  if (!mediaId || typeof mediaId !== 'string') return null;
  return mediaCache.get(mediaId) || null;
}

/**
 * Stores or updates a cached media record (used by retrieval & test harness).
 * @param {string} mediaId
 * @param {object} record
 */
function setCachedMedia(mediaId, record) {
  if (mediaId && record) {
    mediaCache.set(mediaId, record);
  }
}

/**
 * Safely streams a remote file from an authorized Instagram CDN to the client.
 * Also saves a copy to the local downloads folder and verifies resolution with ffprobe upon completion.
 * @param {string} remoteUrl
 * @param {string} filename
 * @param {import('express').Response} res
 * @param {boolean} saveLocally
 * @param {object} [item]
 */
async function streamMediaDownload(remoteUrl, filename, res, saveLocally = true, item = null) {
  const validation = await validateSafeCdnUrl(remoteUrl);
  if (!validation.isValid) {
    res.status(400).json({ error: validation.error || 'Invalid or untrusted media source.' });
    return;
  }

  const downloadDir = path.resolve(__dirname, '..', 'downloads');
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
  }

  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const localFilePath = path.join(downloadDir, safeFilename);

  const parsedUrl = new URL(remoteUrl);
  const clientLib = parsedUrl.protocol === 'https:' ? https : http;

  const req = clientLib.get(
    remoteUrl,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': '*/*'
      },
      timeout: 30000
    },
    (remoteRes) => {
      // Follow redirects (Instagram CDNs frequently redirect to video.xx.fbcdn.net)
      if (remoteRes.statusCode === 301 || remoteRes.statusCode === 302 || remoteRes.statusCode === 307) {
        const redirectUrl = remoteRes.headers.location;
        if (redirectUrl) {
          return streamMediaDownload(redirectUrl, filename, res, saveLocally, item);
        }
      }

      if (remoteRes.statusCode !== 200 && remoteRes.statusCode !== 206) {
        if (!res.headersSent) {
          res.status(502).json({
            error: `Instagram CDN returned status ${remoteRes.statusCode}. Stream expired or unavailable.`
          });
        }
        return;
      }

      const contentType = remoteRes.headers['content-type'] ||
        (safeFilename.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg');
      const contentLength = remoteRes.headers['content-length'];

      res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
      res.setHeader('Content-Type', contentType);
      if (contentLength) {
        res.setHeader('Content-Length', contentLength);
      }
      if (item && item.resolution) {
        res.setHeader('X-Media-Resolution', item.resolution.replace(/×/g, 'x'));
        res.setHeader('X-Media-Quality', item.qualityLabel || 'Original');
        if (item.width) res.setHeader('X-Media-Width', item.width);
        if (item.height) res.setHeader('X-Media-Height', item.height);
        res.setHeader('X-Media-Is-4K', item.is4K ? 'true' : 'false');
      }

      remoteRes.pipe(res);

      if (saveLocally) {
        const fileStream = fs.createWriteStream(localFilePath);
        remoteRes.pipe(fileStream);
        fileStream.on('finish', async () => {
          fileStream.close();
          if (fs.existsSync(localFilePath)) {
            const probed = await probeMediaDimensions(localFilePath);
            if (probed && probed.width && probed.height && item) {
              item.width = probed.width;
              item.height = probed.height;
              item.resolution = `${probed.width}×${probed.height}`;
              item.qualityLabel = probed.qualityLabel;
              item.is4K = probed.is4K;
              item.tier = probed.tier;
              console.log(`[PROBE VERIFIED] Downloaded ${safeFilename} verified actual resolution: ${item.resolution} (${item.qualityLabel})`);
            }
          }
        });
        fileStream.on('error', (err) => {
          console.error(`Local save warning for ${safeFilename}:`, err.message);
        });
      }
    }
  );

  req.on('timeout', () => {
    req.destroy();
    if (!res.headersSent) {
      res.status(504).json({ error: 'Instagram CDN request timed out.' });
    }
  });

  req.on('error', (err) => {
    console.error(`[CDN ERROR] Failed to stream ${safeFilename}:`, err.message);
    if (!res.headersSent) {
      const isDnsOrNetwork = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET/i.test(err.code || err.message);
      res.status(502).json({
        error: isDnsOrNetwork
          ? 'Unable to connect to Instagram. Please check your internet connection and try again.'
          : 'Failed to download media file from Instagram.'
      });
    }
  });
}

/**
 * Merges separate video and audio streams into a universally compatible MP4.
 * Uses stream copy (-c copy) when codecs are already compatible (H.264 + AAC + yuv420p).
 * Transcodes with visually lossless quality (libx264 -crf 18 -pix_fmt yuv420p) only when necessary.
 * Preserves audio quality, ensures synchronization, and enables +faststart.
 * @param {string} videoPath
 * @param {string} audioPath
 * @param {string} outputPath
 * @returns {Promise<string>}
 */
function mergeStreamsToCompatibleMp4(videoPath, audioPath, outputPath) {
  return new Promise(async (resolve, reject) => {
    try {
      const [vDetails, aDetails] = await Promise.all([
        probeMediaDetails(videoPath),
        probeMediaDetails(audioPath)
      ]);

      const ffmpeg = getFfmpegPath();
      const args = ['-y', '-i', videoPath, '-i', audioPath];

      // Video codec evaluation:
      // If video is already H.264 with yuv420p -> lossless stream copy (-c:v copy)
      const isVideoH264Yuv420 = vDetails &&
        (vDetails.vcodec === 'h264' || vDetails.vcodec === 'avc1') &&
        (vDetails.pixFmt === 'yuv420p' || !vDetails.pixFmt);

      if (isVideoH264Yuv420) {
        console.log(`[COMPATIBILITY COPY] Video stream (${vDetails?.vcodec}) is already H.264 / yuv420p compliant. Using lossless stream copy.`);
        args.push('-c:v', 'copy');
      } else {
        console.log(`[COMPATIBILITY CONVERT] Video stream (${vDetails?.vcodec || 'unknown'}) requires conversion. Encoding with libx264 (CRF 18, yuv420p) for QuickTime / Apple compatibility.`);
        args.push(
          '-c:v', 'libx264',
          '-preset', 'medium',
          '-crf', '18',
          '-pix_fmt', 'yuv420p'
        );
      }

      // Audio codec evaluation:
      // If audio is already AAC -> lossless stream copy (-c:a copy)
      const isAudioAac = aDetails && (aDetails.acodec === 'aac' || aDetails.acodec === 'mp4a');
      if (isAudioAac) {
        args.push('-c:a', 'copy');
      } else {
        console.log(`[COMPATIBILITY CONVERT] Audio stream (${aDetails?.acodec || 'unknown'}) requires conversion. Encoding with AAC (192 kbps).`);
        args.push('-c:a', 'aac', '-b:a', '192k');
      }

      // Container settings: +faststart places moov atom at beginning of file for instant playback
      // -shortest ensures video and audio are synchronized and cut to identical duration
      args.push('-movflags', '+faststart', '-shortest', outputPath);

      execFile(ffmpeg, args, { timeout: 60000 }, (err) => {
        if (err) return reject(err);
        resolve(outputPath);
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Ensures an existing video file is universally compatible with macOS QuickTime Player, iOS, and Safari.
 * If already H.264 + AAC + yuv420p, simply remuxes with +faststart.
 * Otherwise, transcodes with libx264 (CRF 18) and standard AAC without quality degradation.
 * @param {string} inputPath
 * @param {string} outputPath
 * @returns {Promise<string>}
 */
function transcodeVideoToCompatibleMp4(inputPath, outputPath) {
  return new Promise(async (resolve, reject) => {
    try {
      const details = await probeMediaDetails(inputPath);
      const ffmpeg = getFfmpegPath();
      const args = ['-y', '-i', inputPath];

      const isVideoH264Yuv420 = details &&
        (details.vcodec === 'h264' || details.vcodec === 'avc1') &&
        (details.pixFmt === 'yuv420p' || !details.pixFmt);

      if (isVideoH264Yuv420) {
        args.push('-c:v', 'copy');
      } else {
        console.log(`[COMPATIBILITY CONVERT] Transcoding ${path.basename(inputPath)} (${details?.vcodec || 'unknown'}) to H.264 (libx264 CRF 18, yuv420p).`);
        args.push(
          '-c:v', 'libx264',
          '-preset', 'medium',
          '-crf', '18',
          '-pix_fmt', 'yuv420p'
        );
      }

      if (details && details.hasAudio) {
        if (details.acodec === 'aac' || details.acodec === 'mp4a') {
          args.push('-c:a', 'copy');
        } else {
          args.push('-c:a', 'aac', '-b:a', '192k');
        }
      } else {
        args.push('-an');
      }

      args.push('-movflags', '+faststart', outputPath);

      execFile(ffmpeg, args, { timeout: 60000 }, (err) => {
        if (err) return reject(err);
        resolve(outputPath);
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Uses yt-dlp to download the highest-quality video stream (bestvideo)
 * and merge it with the best available audio stream (bestaudio) into a clean MP4.
 * Falls back to best single format (/best) if separate streams are unavailable.
 * @param {string} targetUrl
 * @param {string} outputPath
 * @returns {Promise<boolean>}
 */
function runYtDlpDownload(targetUrl, outputPath) {
  return new Promise((resolve) => {
    const py = getPythonPath();
    const scriptPath = path.resolve(__dirname, 'extractor.py');
    const args = [scriptPath, '--download', targetUrl, outputPath];

    execFile(py, args, { timeout: 75000 }, (error, stdout) => {
      if (error) {
        console.warn(`[YTDLP DOWNLOAD FALLBACK] yt-dlp download notice: ${error.message}`);
        return resolve(false);
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        if (parsed && parsed.success && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 500) {
          return resolve(true);
        }
      } catch (_) {}
      resolve(false);
    });
  });
}

/**
 * Downloads and serves the highest quality media item available.
 * If separate high-res video and audio streams are provided (e.g. 4K, 1440p, or 1080p DASH),
 * uses yt-dlp to merge bestvideo+bestaudio with FFmpeg into an MP4 container, with fallbacks.
 * Probes and verifies actual resolution on the real downloaded file.
 * @param {object} mediaRecord 
 * @param {number} itemIndex 
 * @param {string} filename 
 * @param {import('express').Response} res 
 */
async function downloadHighestQualityMedia(mediaRecord, itemIndex, filename, res) {
  const idx = parseInt(itemIndex, 10) || 0;
  const item = mediaRecord.items && mediaRecord.items[idx];
  if (!item) {
    return res.status(404).json({ error: 'Specified media item not found.' });
  }

  const downloadDir = path.resolve(__dirname, '..', 'downloads');
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
  }

  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const localFilePath = path.join(downloadDir, safeFilename);

  // 1. If file already exists locally, verify quality and QuickTime compatibility
  if (fs.existsSync(localFilePath) && fs.statSync(localFilePath).size > 500) {
    let isValidQuality = true;
    const existingDetails = await probeMediaDetails(localFilePath);
    if (existingDetails && existingDetails.width && existingDetails.height) {
      if (item.width && item.height && (existingDetails.width < item.width || existingDetails.height < item.height)) {
        isValidQuality = false; // Outdated lower-resolution cache, re-fetch full quality
      } else if (item.type === 'video' && !existingDetails.isQuickTimeCompatible) {
        // The cached file contains an incompatible video codec (e.g. VP9) or unsupported pixel format
        console.log(`[COMPATIBILITY FIX] Cached file ${safeFilename} (${existingDetails.vcodec}/${existingDetails.acodec}) is not QuickTime compatible. Converting...`);
        const tempTranscodePath = path.join(downloadDir, `.tmp_transcode_${Date.now()}_${safeFilename}`);
        try {
          await transcodeVideoToCompatibleMp4(localFilePath, tempTranscodePath);
          if (fs.existsSync(tempTranscodePath) && fs.statSync(tempTranscodePath).size > 500) {
            fs.unlinkSync(localFilePath);
            fs.renameSync(tempTranscodePath, localFilePath);
            const refreshed = await probeMediaDetails(localFilePath);
            if (refreshed) {
              existingDetails.vcodec = refreshed.vcodec;
              existingDetails.pixFmt = refreshed.pixFmt;
              existingDetails.acodec = refreshed.acodec;
              existingDetails.isQuickTimeCompatible = true;
            }
          }
        } catch (transcodeErr) {
          console.warn(`[TRANSCODE WARN] In-place compatibility conversion failed: ${transcodeErr.message}`);
          try { if (fs.existsSync(tempTranscodePath)) fs.unlinkSync(tempTranscodePath); } catch (_) {}
        }
      } else {
        // Update item with verified dimensions of the local file
        item.width = existingDetails.width;
        item.height = existingDetails.height;
        item.resolution = `${existingDetails.width}×${existingDetails.height}`;
        item.qualityLabel = existingDetails.qualityLabel;
        item.is4K = existingDetails.is4K;
        item.tier = existingDetails.tier;
      }
    }
    if (isValidQuality) {
      const stats = fs.statSync(localFilePath);
      res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
      res.setHeader('Content-Type', safeFilename.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg');
      res.setHeader('Content-Length', stats.size);
      res.setHeader('X-Media-Resolution', (item.resolution || 'Original').replace(/×/g, 'x'));
      res.setHeader('X-Media-Quality', item.qualityLabel || 'Original');
      if (item.width) res.setHeader('X-Media-Width', item.width);
      if (item.height) res.setHeader('X-Media-Height', item.height);
      res.setHeader('X-Media-Is-4K', item.is4K ? 'true' : 'false');
      fs.createReadStream(localFilePath).pipe(res);
      return;
    }
  }

  // 2. Video items: Use yt-dlp to select the highest available video quality and merge with the best audio stream
  if (item.type === 'video') {
    const targetUrl = mediaRecord.url || item.directUrl;
    const tempYtDlpPath = path.join(downloadDir, `.tmp_ytdlp_${mediaRecord.id}_${idx}.mp4`);
    console.log(`[QUALITY DOWNLOAD] Fetching highest available video and audio streams for ${safeFilename} via yt-dlp...`);

    let ytDlpSuccess = await runYtDlpDownload(targetUrl, tempYtDlpPath);

    if (ytDlpSuccess) {
      // Ensure the merged MP4 is universally compatible with macOS QuickTime Player, iOS, Safari
      await transcodeVideoToCompatibleMp4(tempYtDlpPath, localFilePath);
      try { if (fs.existsSync(tempYtDlpPath)) fs.unlinkSync(tempYtDlpPath); } catch (_) {}
    } else {
      // Fallback 1: If yt-dlp direct download failed, use separate stream URLs if available
      const hasSeparateStreams = item.videoStreamUrl && item.audioStreamUrl && item.isMuxed === false;
      if (hasSeparateStreams) {
        try {
          console.log(`[QUALITY FALLBACK] Downloading separate high-res video and audio streams for ${safeFilename}...`);
          const tempVideoPath = path.join(downloadDir, `.tmp_v_${mediaRecord.id}_${idx}.mp4`);
          const tempAudioPath = path.join(downloadDir, `.tmp_a_${mediaRecord.id}_${idx}.m4a`);

          await Promise.all([
            downloadRemoteFile(item.videoStreamUrl, tempVideoPath),
            downloadRemoteFile(item.audioStreamUrl, tempAudioPath)
          ]);

          await mergeStreamsToCompatibleMp4(tempVideoPath, tempAudioPath, localFilePath);
          try { if (fs.existsSync(tempVideoPath)) fs.unlinkSync(tempVideoPath); } catch (_) {}
          try { if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath); } catch (_) {}
        } catch (streamErr) {
          console.warn(`[QUALITY FALLBACK] Stream download failed: ${streamErr.message}. Falling back to progressive.`);
        }
      }

      // Fallback 2: If localFilePath still not created, use directUrl or fallback progressive stream
      if (!fs.existsSync(localFilePath) || fs.statSync(localFilePath).size < 500) {
        const fallbackUrl = item.directUrl || item.videoStreamUrl || item.thumbnail;
        const tempDlPath = path.join(downloadDir, `.tmp_dl_${mediaRecord.id}_${idx}.mp4`);
        await downloadRemoteFile(fallbackUrl, tempDlPath);
        await transcodeVideoToCompatibleMp4(tempDlPath, localFilePath);
        try { if (fs.existsSync(tempDlPath)) fs.unlinkSync(tempDlPath); } catch (_) {}
      }
    }

    // Verify and deliver the final video
    if (fs.existsSync(localFilePath)) {
      const stats = fs.statSync(localFilePath);
      const probed = await probeMediaDetails(localFilePath);
      if (probed && probed.width && probed.height) {
        item.width = probed.width;
        item.height = probed.height;
        item.resolution = `${probed.width}×${probed.height}`;
        item.qualityLabel = probed.qualityLabel;
        item.is4K = probed.is4K;
        item.tier = probed.tier;
      }

      res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', stats.size);
      res.setHeader('X-Media-Resolution', (item.resolution || 'Original').replace(/×/g, 'x'));
      res.setHeader('X-Media-Quality', item.qualityLabel || 'Original');
      if (item.width) res.setHeader('X-Media-Width', item.width);
      if (item.height) res.setHeader('X-Media-Height', item.height);
      res.setHeader('X-Media-Is-4K', item.is4K ? 'true' : 'false');
      fs.createReadStream(localFilePath).pipe(res);
      console.log(`[QUALITY SUCCESS] Successfully delivered authentic ${item.resolution || item.qualityLabel} video (${stats.size} bytes)`);
      return;
    }
  }

  // 3. Photos / Profile pictures / Direct image streaming
  const fallbackUrl = item.directUrl || item.thumbnail;
  await streamMediaDownload(fallbackUrl, safeFilename, res, true, item);
}

/**
 * Downloads a remote file from an authorized Instagram CDN to a local path.
 * Supports HTTP/HTTPS redirects.
 * @param {string} remoteUrl
 * @param {string} localPath
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
function downloadRemoteFile(remoteUrl, localPath, timeoutMs = 35000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(remoteUrl);
    const clientLib = parsed.protocol === 'https:' ? https : http;

    const req = clientLib.get(
      remoteUrl,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Accept': '*/*'
        },
        timeout: timeoutMs
      },
      (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
          if (res.headers.location) {
            return downloadRemoteFile(res.headers.location, localPath, timeoutMs)
              .then(resolve)
              .catch(reject);
          }
        }

        if (res.statusCode !== 200 && res.statusCode !== 206) {
          return reject(new Error(`CDN returned HTTP ${res.statusCode}`));
        }

        const fileStream = fs.createWriteStream(localPath);
        res.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close(() => resolve(localPath));
        });

        fileStream.on('error', (err) => {
          if (fs.existsSync(localPath)) {
            try { fs.unlinkSync(localPath); } catch (_) {}
          }
          reject(err);
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      if (fs.existsSync(localPath)) {
        try { fs.unlinkSync(localPath); } catch (_) {}
      }
      reject(new Error('CDN download timed out.'));
    });

    req.on('error', (err) => {
      if (fs.existsSync(localPath)) {
        try { fs.unlinkSync(localPath); } catch (_) {}
      }
      reject(err);
    });
  });
}

/**
 * Extracts the audio track from a cached Reel/video item into an MP3 file.
 * Uses local FFmpeg with libmp3lame at 192k bitrate.
 * @param {object} mediaRecord Cached media record
 * @param {number} itemIndex Index of media item
 * @returns {Promise<{ success: boolean, audioPath?: string, audioFilename?: string, noAudio?: boolean, cached?: boolean, error?: string, errorCode?: string }>}
 */
async function extractAudioTrack(mediaRecord, itemIndex = 0) {
  if (!mediaRecord || !mediaRecord.items) {
    return {
      success: false,
      errorCode: 'SESSION_EXPIRED',
      error: 'Media session expired. Please retrieve the Reel again.'
    };
  }

  const idx = parseInt(itemIndex, 10) || 0;
  const item = mediaRecord.items[idx];
  if (!item) {
    return {
      success: false,
      errorCode: 'ITEM_NOT_FOUND',
      error: 'Requested media item not found.'
    };
  }

  if (item.type !== 'video') {
    return {
      success: false,
      errorCode: 'NOT_A_VIDEO',
      error: 'Audio extraction is only available for video media.'
    };
  }

  if (item.hasAudio === false) {
    return {
      success: false,
      noAudio: true,
      errorCode: 'NO_AUDIO_TRACK',
      error: 'This Reel does not contain an audio track.'
    };
  }

  // Check FFmpeg availability
  const ffmpegHealth = await checkFfmpegHealth();
  if (!ffmpegHealth.available) {
    return {
      success: false,
      errorCode: 'FFMPEG_MISSING',
      error: 'FFmpeg is required for audio extraction. Please install FFmpeg (e.g. brew install ffmpeg).'
    };
  }

  const downloadDir = path.resolve(__dirname, '..', 'downloads');
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
  }

  // Safe filename sanitized against path traversal
  const safeShortcode = (mediaRecord.shortcode || 'reel').replace(/[^a-zA-Z0-9_-]/g, '_');
  const audioFilename = idx > 0
    ? `instagram_${safeShortcode}_${idx + 1}_audio.mp3`
    : `instagram_${safeShortcode}_audio.mp3`;
  const audioPath = path.join(downloadDir, audioFilename);

  // If already extracted and valid, return cached file immediately
  if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1024) {
    return {
      success: true,
      audioPath,
      audioFilename,
      cached: true
    };
  }

  // Find or fetch the input video file
  const existingVideoPath = path.join(downloadDir, item.suggestedFilename || `instagram_${safeShortcode}.mp4`);
  let inputVideoPath = null;
  let isTempVideo = false;

  if (fs.existsSync(existingVideoPath) && fs.statSync(existingVideoPath).size > 500) {
    inputVideoPath = existingVideoPath;
  } else {
    const streamSource = item.directUrl || item.thumbnail;
    if (!streamSource) {
      return {
        success: false,
        errorCode: 'SOURCE_UNAVAILABLE',
        error: 'Video source stream is unavailable for audio extraction.'
      };
    }

    const validation = await validateSafeCdnUrl(streamSource);
    if (!validation.isValid) {
      return {
        success: false,
        errorCode: 'UNTRUSTED_CDN',
        error: validation.error || 'Untrusted media source for audio extraction.'
      };
    }

    const tempFilename = `.temp_video_${crypto.randomUUID()}.mp4`;
    inputVideoPath = path.join(downloadDir, tempFilename);
    isTempVideo = true;

    try {
      await downloadRemoteFile(streamSource, inputVideoPath);
    } catch (dlErr) {
      if (fs.existsSync(inputVideoPath)) {
        try { fs.unlinkSync(inputVideoPath); } catch (_) {}
      }
      return {
        success: false,
        errorCode: 'CDN_DOWNLOAD_FAILED',
        error: 'Unable to stream the Reel media from Instagram to prepare audio.'
      };
    }
  }

  // Run FFmpeg to extract audio into MP3
  const ffmpegBin = ffmpegHealth.path;
  const tempAudioFilename = `.temp_audio_${crypto.randomUUID()}.mp3`;
  const tempAudioPath = path.join(downloadDir, tempAudioFilename);

  const ffmpegArgs = [
    '-i', inputVideoPath,
    '-vn',                  // Extract audio only
    '-c:a', 'libmp3lame',   // Encode with MP3 codec
    '-b:a', '192k',         // Standard high-quality 192k bitrate
    '-ar', '44100',         // Standard 44.1 kHz sample rate
    '-y',                   // Overwrite if exists
    tempAudioPath
  ];

  return new Promise((resolve) => {
    execFile(ffmpegBin, ffmpegArgs, { timeout: 45000 }, (error, stdout, stderr) => {
      // Always cleanup intermediate temp video if created
      if (isTempVideo && fs.existsSync(inputVideoPath)) {
        try { fs.unlinkSync(inputVideoPath); } catch (_) {}
      }

      if (error) {
        // Cleanup temp audio file if created
        if (fs.existsSync(tempAudioPath)) {
          try { fs.unlinkSync(tempAudioPath); } catch (_) {}
        }

        const errOutput = `${error.message || ''} ${stderr || ''}`.toLowerCase();
        if (
          errOutput.includes('does not contain any stream') ||
          errOutput.includes('matches no streams') ||
          errOutput.includes('does not contain any audio stream')
        ) {
          return resolve({
            success: false,
            noAudio: true,
            errorCode: 'NO_AUDIO_STREAM',
            error: 'This Reel does not contain an audio track.'
          });
        }

        console.error(`[AUDIO ERROR] FFmpeg failed for ${safeShortcode}:`, error.message);
        return resolve({
          success: false,
          errorCode: 'EXTRACTION_FAILED',
          error: 'Unable to prepare the audio from this Reel. Please try again or download the original video.'
        });
      }

      // Rename temp audio file to final audio path atomically
      try {
        if (!fs.existsSync(tempAudioPath) || fs.statSync(tempAudioPath).size === 0) {
          if (fs.existsSync(tempAudioPath)) {
            try { fs.unlinkSync(tempAudioPath); } catch (_) {}
          }
          return resolve({
            success: false,
            noAudio: true,
            errorCode: 'EMPTY_AUDIO',
            error: 'This Reel does not contain an audio track.'
          });
        }

        fs.renameSync(tempAudioPath, audioPath);

        console.log(`[AUDIO SUCCESS] Extracted audio for ${safeShortcode} -> ${audioFilename}`);
        resolve({
          success: true,
          audioPath,
          audioFilename
        });
      } catch (renameErr) {
        if (fs.existsSync(tempAudioPath)) {
          try { fs.unlinkSync(tempAudioPath); } catch (_) {}
        }
        resolve({
          success: false,
          errorCode: 'FILE_ERROR',
          error: 'Failed to finalize audio file.'
        });
      }
    });
  });
}

module.exports = {
  checkYtDlpHealth,
  checkFfmpegHealth,
  getFfmpegPath,
  getFfprobePath,
  retrieveMedia,
  getCachedMedia,
  setCachedMedia,
  streamMediaDownload,
  downloadHighestQualityMedia,
  downloadRemoteFile,
  extractAudioTrack,
  probeMediaDimensions
};
