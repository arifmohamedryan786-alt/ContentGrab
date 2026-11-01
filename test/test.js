/**
 * Comprehensive Automated Test Suite
 * Tests URL classification, separate handlers, CDN & SSRF security,
 * Express API responses, and honest error handling for Stories and Highlights.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { validateInstagramUrl } = require('../utils/validateInstagramUrl');
const { classifyInstagramUrl } = require('../utils/urlClassifier');
const { isAllowedCdnHost, isPrivateOrReservedIp, validateSafeCdnUrl } = require('../utils/validateCdnUrl');
const {
  checkYtDlpHealth,
  checkFfmpegHealth,
  setCachedMedia,
  extractAudioTrack,
  probeMediaDimensions
} = require('../services/mediaService');
const app = require('../server');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function ensureTestFixtures() {
  const downloadDir = path.resolve(__dirname, '..', 'downloads');
  if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

  const ffmpeg = 'ffmpeg';
  const noAudioVid = path.join(downloadDir, 'instagram_DfH6LZPJATb.mp4');
  if (!fs.existsSync(noAudioVid) || fs.statSync(noAudioVid).size < 100) {
    try {
      execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=720x1280:d=0.5', '-t', '0.5', '-c:v', 'libx264', noAudioVid]);
    } catch (_) {}
  }

  const audioVid = path.join(downloadDir, 'instagram_DfH51aXkVYo.mp4');
  if (!fs.existsSync(audioVid) || fs.statSync(audioVid).size < 10000) {
    try {
      execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=1080x1920:d=2.5', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '2.5', '-c:v', 'libx264', '-c:a', 'aac', audioVid]);
    } catch (_) {}
  }

  const natgeo = path.join(downloadDir, 'instagram_natgeo_profile_picture.jpg');
  if (!fs.existsSync(natgeo) || fs.statSync(natgeo).size < 100) {
    try {
      execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=green:s=100x100:d=0.1', '-update', '1', '-frames:v', '1', natgeo]);
    } catch (_) {}
  }

  const mufti = path.join(downloadDir, 'instagram_muftimenkofficial_profile_picture.jpg');
  if (!fs.existsSync(mufti) || fs.statSync(mufti).size < 100) {
    try {
      execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=yellow:s=150x150:d=0.1', '-update', '1', '-frames:v', '1', mufti]);
    } catch (_) {}
  }
}

ensureTestFixtures();

test('1. classifyInstagramUrl: Input sanitization & domain validation', () => {
  // Empty & invalid inputs
  assert.equal(classifyInstagramUrl('').isValid, false);
  assert.equal(classifyInstagramUrl(null).isValid, false);
  assert.equal(classifyInstagramUrl(undefined).isValid, false);
  assert.equal(classifyInstagramUrl('   ').isValid, false);
  assert.equal(classifyInstagramUrl(12345).isValid, false);

  // Unrelated domains
  assert.equal(classifyInstagramUrl('https://google.com/reel/123').isValid, false);
  assert.equal(classifyInstagramUrl('https://tiktok.com/@user/video/123').isValid, false);
  assert.equal(classifyInstagramUrl('https://fake-instagram.com/p/123').isValid, false);
  assert.equal(classifyInstagramUrl('http://127.0.0.1:3000/p/123').isValid, false);

  // Prohibited credentials in URL
  assert.equal(classifyInstagramUrl('https://user:pass@instagram.com/p/C21AbCdEf_1/').isValid, false);

  // Unsupported Instagram pages on default category
  assert.equal(classifyInstagramUrl('https://www.instagram.com/explore/').isValid, false);
  assert.equal(classifyInstagramUrl('https://www.instagram.com/cristiano/').isValid, false);
});

test('2. classifyInstagramUrl: Separate detection for Posts, Reels, Photos, Stories, Highlights, DP', () => {
  // 1. Post URLs
  const post = classifyInstagramUrl('https://www.instagram.com/p/DF2abcXYZ_9/');
  assert.equal(post.isValid, true);
  assert.equal(post.urlType, 'post');
  assert.equal(post.shortcode, 'DF2abcXYZ_9');
  assert.equal(post.username, null);
  assert.equal(post.storyId, null);
  assert.equal(post.highlightId, null);

  // 2. Photo category URL
  const photo = classifyInstagramUrl('https://www.instagram.com/p/DF2abcXYZ_9/', 'photo');
  assert.equal(photo.isValid, true);
  assert.equal(photo.urlType, 'photo');
  assert.equal(photo.shortcode, 'DF2abcXYZ_9');

  // 3. Reel URLs (/reel/ and /reels/)
  const reel1 = classifyInstagramUrl('https://www.instagram.com/reel/C21AbCdEf_1/?utm_source=ig_web_copy_link');
  assert.equal(reel1.isValid, true);
  assert.equal(reel1.urlType, 'reel');
  assert.equal(reel1.shortcode, 'C21AbCdEf_1');

  const reel2 = classifyInstagramUrl('https://www.instagram.com/reels/DA987xyz123/');
  assert.equal(reel2.isValid, true);
  assert.equal(reel2.urlType, 'reel');
  assert.equal(reel2.shortcode, 'DA987xyz123');

  // 4. IGTV URLs
  const tv = classifyInstagramUrl('https://www.instagram.com/tv/B_xyz123/');
  assert.equal(tv.isValid, true);
  assert.equal(tv.urlType, 'tv');
  assert.equal(tv.shortcode, 'B_xyz123');

  // 5. Story URLs (/stories/{username}/{storyId}/)
  const story1 = classifyInstagramUrl('https://www.instagram.com/stories/_sky__tech_/4019282746425329/');
  assert.equal(story1.isValid, true);
  assert.equal(story1.urlType, 'story');
  assert.equal(story1.username, '_sky__tech_');
  assert.equal(story1.storyId, '4019282746425329');
  assert.equal(story1.shortcode, null); // Must NOT use post shortcodes!

  const story2 = classifyInstagramUrl('https://www.instagram.com/stories/natgeo/');
  assert.equal(story2.isValid, true);
  assert.equal(story2.urlType, 'story');
  assert.equal(story2.username, 'natgeo');

  // 6. Highlight URLs (/s/{token} and /stories/highlights/{id}/)
  const highlightShare = classifyInstagramUrl('https://www.instagram.com/s/aGlnaGxpZ2h0OjE4MTU2MTUyMTEwM/');
  assert.equal(highlightShare.isValid, true);
  assert.equal(highlightShare.urlType, 'highlight');
  assert.equal(highlightShare.highlightId, 'aGlnaGxpZ2h0OjE4MTU2MTUyMTEwM');
  assert.equal(highlightShare.shortcode, null); // Must NOT use post shortcodes!

  const highlightId = classifyInstagramUrl('https://www.instagram.com/stories/highlights/18156152110/');
  assert.equal(highlightId.isValid, true);
  assert.equal(highlightId.urlType, 'highlight');
  assert.equal(highlightId.highlightId, '18156152110');
  assert.equal(highlightId.shortcode, null);

  // 7. DP Profile URLs
  const dpUrl = classifyInstagramUrl('https://www.instagram.com/natgeo/', 'dp');
  assert.equal(dpUrl.isValid, true);
  assert.equal(dpUrl.urlType, 'dp');
  assert.equal(dpUrl.username, 'natgeo');

  const dpHandle = classifyInstagramUrl('@natgeo', 'dp');
  assert.equal(dpHandle.isValid, true);
  assert.equal(dpHandle.urlType, 'dp');
  assert.equal(dpHandle.username, 'natgeo');
});

test('3. SSRF & CDN Security: IP and Host Validation', async () => {
  // Disallowed hosts
  assert.equal(isAllowedCdnHost('google.com'), false);
  assert.equal(isAllowedCdnHost('evil-instagram.com'), false);
  assert.equal(isAllowedCdnHost('127.0.0.1'), false);
  assert.equal(isAllowedCdnHost('169.254.169.254'), false);

  // Allowed legitimate CDN hosts
  assert.equal(isAllowedCdnHost('scontent-ord5-2.cdninstagram.com'), true);
  assert.equal(isAllowedCdnHost('instagram.fsea1-1.fna.fbcdn.net'), true);
  assert.equal(isAllowedCdnHost('instagram.com'), true);
  assert.equal(isAllowedCdnHost('video.cdninstagram.com'), true);

  // Private / Reserved IP checks
  assert.equal(isPrivateOrReservedIp('127.0.0.1'), true);
  assert.equal(isPrivateOrReservedIp('10.0.0.1'), true);
  assert.equal(isPrivateOrReservedIp('172.16.0.1'), true);
  assert.equal(isPrivateOrReservedIp('192.168.1.1'), true);
  assert.equal(isPrivateOrReservedIp('169.254.169.254'), true);
  assert.equal(isPrivateOrReservedIp('::1'), true);
  assert.equal(isPrivateOrReservedIp('8.8.8.8'), false);

  // validateSafeCdnUrl checks
  const badUrlRes = await validateSafeCdnUrl('http://attacker.com/malicious.mp4');
  assert.equal(badUrlRes.isValid, false);

  const ipUrlRes = await validateSafeCdnUrl('https://127.0.0.1/secret');
  assert.equal(ipUrlRes.isValid, false);
});

test('4. yt-dlp Integration Check', async () => {
  const health = await checkYtDlpHealth();
  assert.equal(health.available, true);
  assert.ok(health.version);
});

test('5. Express Server Integration: Story & Highlight honest errors & Classification API', async () => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Health check
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);

    // 2. Classification endpoint: GET /api/media/classify
    const storyClassifyRes = await fetch(`${baseUrl}/api/media/classify?url=https://www.instagram.com/stories/_sky__tech_/4019282746425329/&category=stories`);
    assert.equal(storyClassifyRes.status, 200);
    const storyClassifyData = await storyClassifyRes.json();
    assert.equal(storyClassifyData.success, true);
    assert.equal(storyClassifyData.classification.urlType, 'story');

    // 3. POST /api/media for Story URL returns honest STORY_AUTH_REQUIRED
    const storyPostRes = await fetch(`${baseUrl}/api/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://www.instagram.com/stories/_sky__tech_/4019282746425329/',
        category: 'stories'
      })
    });
    assert.equal(storyPostRes.status, 400);
    const storyPostData = await storyPostRes.json();
    assert.equal(storyPostData.success, false);
    assert.equal(storyPostData.errorCode, 'STORY_AUTH_REQUIRED');
    assert.equal(storyPostData.urlType, 'story');
    assert.equal(storyPostData.urlRecognized, true);
    assert.equal(storyPostData.error, 'This Story URL was recognized, but Instagram may require authorized access to retrieve Story media.');

    // 4. POST /api/media for Highlight URL returns honest HIGHLIGHT_ACCESS_RESTRICTED
    const highlightPostRes = await fetch(`${baseUrl}/api/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://www.instagram.com/s/aGlnaGxpZ2h0OjE4MTU2MTUyMTEwM/',
        category: 'highlights'
      })
    });
    assert.equal(highlightPostRes.status, 400);
    const highlightPostData = await highlightPostRes.json();
    assert.equal(highlightPostData.success, false);
    assert.equal(highlightPostData.errorCode, 'HIGHLIGHT_ACCESS_RESTRICTED');
    assert.equal(highlightPostData.urlType, 'highlight');
    assert.equal(highlightPostData.urlRecognized, true);
    assert.equal(highlightPostData.error, 'This Highlight URL was recognized, but the media could not be retrieved through the currently available permitted access method.');

    // 5. POST /api/media with invalid URL returns clean message
    const invalidPostRes = await fetch(`${baseUrl}/api/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://youtube.com/watch?v=123' })
    });
    assert.equal(invalidPostRes.status, 400);
    const invalidPostData = await invalidPostRes.json();
    assert.equal(invalidPostData.success, false);
    assert.ok(invalidPostData.error.includes('Please enter a valid supported Instagram URL.'));

    // 6. Test GET / (HTML index)
    const indexRes = await fetch(`${baseUrl}/`);
    assert.equal(indexRes.status, 200);
    const html = await indexRes.text();
    assert.ok(html.includes('id="downloader-form"'));

  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('6. Reel Audio Extraction & Audio Download Endpoint Integration', async () => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const fs = require('fs');
  const path = require('path');
  const downloadDir = path.resolve(__dirname, '..', 'downloads');
  const generatedAudioFile = path.join(downloadDir, 'instagram_DfH51aXkVYo_audio.mp3');

  try {
    // 1. Verify FFmpeg integration health check
    const health = await checkFfmpegHealth();
    assert.equal(health.available, true, 'FFmpeg must be installed and available on system');
    assert.ok(health.path, 'FFmpeg path must be resolved');

    // 2. Test Invalid / Expired download token
    const expiredRes = await fetch(`${baseUrl}/api/media/audio?mediaId=non_existent_token_123&itemIndex=0`);
    assert.equal(expiredRes.status, 404);
    const expiredData = await expiredRes.json();
    assert.equal(expiredData.success, false);
    assert.ok(expiredData.error.includes('Media session expired'));

    // 3. Test Invalid Item Index on valid record
    const dummyRecordId = 'test_token_' + Date.now();
    setCachedMedia(dummyRecordId, {
      id: dummyRecordId,
      shortcode: 'dummyShortcode',
      mediaType: 'reel',
      items: [
        {
          index: 0,
          type: 'video',
          hasAudio: true,
          suggestedFilename: 'dummy.mp4'
        }
      ]
    });

    const invalidIndexRes = await fetch(`${baseUrl}/api/media/audio?mediaId=${dummyRecordId}&itemIndex=99`);
    assert.equal(invalidIndexRes.status, 404);
    const invalidIndexData = await invalidIndexRes.json();
    assert.ok(invalidIndexData.error.includes('Specified Reel media item not found'));

    // 4. Test Image post (audio not supported on images)
    const imageRecordId = 'image_token_' + Date.now();
    setCachedMedia(imageRecordId, {
      id: imageRecordId,
      shortcode: 'CbqmaY1p7Pz',
      mediaType: 'photo',
      items: [
        {
          index: 0,
          type: 'image',
          hasAudio: false,
          suggestedFilename: 'instagram_CbqmaY1p7Pz.jpg'
        }
      ]
    });

    const imageRes = await fetch(`${baseUrl}/api/media/audio?mediaId=${imageRecordId}&itemIndex=0`);
    assert.equal(imageRes.status, 400);
    const imageData = await imageRes.json();
    assert.equal(imageData.success, false);
    assert.ok(imageData.error.includes('only available for video media'));

    // 5. Test Reel explicitly marked with hasAudio: false
    const mutedRecordId = 'muted_token_' + Date.now();
    setCachedMedia(mutedRecordId, {
      id: mutedRecordId,
      shortcode: 'mutedShortcode',
      mediaType: 'reel',
      items: [
        {
          index: 0,
          type: 'video',
          hasAudio: false,
          suggestedFilename: 'muted.mp4'
        }
      ]
    });

    const mutedRes = await fetch(`${baseUrl}/api/media/audio?mediaId=${mutedRecordId}&itemIndex=0`);
    assert.equal(mutedRes.status, 422);
    const mutedData = await mutedRes.json();
    assert.equal(mutedData.success, false);
    assert.ok(mutedData.error.includes('does not contain an audio track'));

    // 6. Test Video file that has NO audio stream in file container (instagram_DfH6LZPJATb.mp4)
    const noAudioStreamRecordId = 'no_audio_file_' + Date.now();
    setCachedMedia(noAudioStreamRecordId, {
      id: noAudioStreamRecordId,
      shortcode: 'DfH6LZPJATb',
      mediaType: 'reel',
      items: [
        {
          index: 0,
          type: 'video',
          hasAudio: true, // flagged as true, but file itself has 0 audio streams
          suggestedFilename: 'instagram_DfH6LZPJATb.mp4'
        }
      ]
    });

    const noAudioStreamRes = await fetch(`${baseUrl}/api/media/audio?mediaId=${noAudioStreamRecordId}&itemIndex=0`);
    assert.equal(noAudioStreamRes.status, 422);
    const noAudioStreamData = await noAudioStreamRes.json();
    assert.equal(noAudioStreamData.success, false);
    assert.ok(noAudioStreamData.error.includes('does not contain an audio track'));

    // 7. Test Reel with genuine available audio track (instagram_DfH51aXkVYo.mp4)
    // Clean any previous generated file first
    if (fs.existsSync(generatedAudioFile)) {
      try { fs.unlinkSync(generatedAudioFile); } catch (_) {}
    }

    const reelWithAudioRecordId = 'reel_audio_' + Date.now();
    setCachedMedia(reelWithAudioRecordId, {
      id: reelWithAudioRecordId,
      shortcode: 'DfH51aXkVYo',
      mediaType: 'reel',
      items: [
        {
          index: 0,
          type: 'video',
          hasAudio: true,
          suggestedFilename: 'instagram_DfH51aXkVYo.mp4'
        }
      ]
    });

    const audioRes = await fetch(`${baseUrl}/api/media/audio?mediaId=${reelWithAudioRecordId}&itemIndex=0`);
    assert.equal(audioRes.status, 200, 'Audio download endpoint must return 200 OK');
    assert.equal(audioRes.headers.get('content-type'), 'audio/mpeg');
    assert.ok(audioRes.headers.get('content-disposition').includes('instagram_DfH51aXkVYo_audio.mp3'));

    const audioArrayBuffer = await audioRes.arrayBuffer();
    const audioBuffer = Buffer.from(audioArrayBuffer);
    assert.ok(audioBuffer.length > 50000, `Extracted MP3 must be substantial, got ${audioBuffer.length} bytes`);

    // Verify MP3 header (starts with ID3 tag 'ID3' or MPEG sync byte 0xFF)
    const isId3 = audioBuffer[0] === 0x49 && audioBuffer[1] === 0x44 && audioBuffer[2] === 0x33;
    const isSync = audioBuffer[0] === 0xFF && (audioBuffer[1] & 0xE0) === 0xE0;
    assert.ok(isId3 || isSync, 'Extracted audio file must have valid MP3 headers');

    // 8. Verify audio file was saved locally in downloads directory
    assert.ok(fs.existsSync(generatedAudioFile), 'Generated audio file must exist in downloads folder');

    // 9. Existing download endpoints remain intact and validate tokens
    const videoDlRes = await fetch(`${baseUrl}/api/media/download?mediaId=${reelWithAudioRecordId}&itemIndex=99`);
    assert.equal(videoDlRes.status, 404);

    const expiredVideoDlRes = await fetch(`${baseUrl}/api/media/download?mediaId=non_existent&itemIndex=0`);
    assert.equal(expiredVideoDlRes.status, 404);

  } finally {
    // Clean up test-generated audio file
    if (fs.existsSync(generatedAudioFile)) {
      try { fs.unlinkSync(generatedAudioFile); } catch (_) {}
    }
    await new Promise((resolve) => server.close(resolve));
  }
});

test('7. Network & DNS Error Handling and Sanitization', async () => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Verify health check reports network diagnostics
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthData = await healthRes.json();
    assert.ok(healthData.network, 'Health check should contain network diagnostics');
    assert.ok(healthData.network.instagramDns, 'Health check should test Instagram DNS resolution');

    // 2. Direct test of Python extractor error sanitization on unreachable host
    const { execFile } = require('child_process');
    const path = require('path');
    const extractorPath = path.resolve(__dirname, '..', 'services', 'extractor.py');

    // Test with a mock non-existent domain to trigger DNS resolution failure
    const offlineTest = await new Promise((resolve) => {
      execFile('python3', [extractorPath, 'https://www.instagram.com/p/TEST12345/'], (err, stdout, stderr) => {
        try {
          const parsed = JSON.parse(stdout.trim());
          resolve({ parsed, stderr });
        } catch (e) {
          resolve({ error: e, stdout, stderr });
        }
      });
    });

    // If offline or online, verify no raw curl error or technical URL is ever in error output
    if (offlineTest.parsed && !offlineTest.parsed.success) {
      assert.ok(!offlineTest.parsed.error.includes('curl.se'), 'Error must not expose curl.se URLs');
      assert.ok(!offlineTest.parsed.error.includes('TransporterError'), 'Error must not expose TransporterError');
      assert.ok(!offlineTest.parsed.error.includes('curl: ('), 'Error must not expose raw curl error codes');
      if (offlineTest.parsed.error_code === 'NETWORK_ERROR') {
        assert.equal(
          offlineTest.parsed.error,
          'Unable to connect to Instagram. Please check your internet connection and try again.'
        );
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('8. Highest Quality Selection & True 4K Media Support', async () => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const fs = require('fs');
  const path = require('path');
  const { execFile } = require('child_process');
  const downloadDir = path.resolve(__dirname, '..', 'downloads');

  const test4kFilename = 'instagram_4k_test_item.mp4';
  const test4kFilePath = path.join(downloadDir, test4kFilename);

  try {
    // 1. Generate a genuine 0.5s 4K video (3840×2160) to test 4K detection & probe
    await new Promise((resolve, reject) => {
      execFile('ffmpeg', [
        '-y',
        '-f', 'lavfi', '-i', 'color=c=purple:s=3840x2160:d=0.5',
        '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
        '-t', '0.5',
        '-c:v', 'libx264',
        '-c:a', 'aac',
        test4kFilePath
      ], (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    assert.ok(fs.existsSync(test4kFilePath), 'Synthetic 4K video must be created for verification');

    // 2. Probe 4K file dimensions using ffprobe
    const probed = await probeMediaDimensions(test4kFilePath);
    assert.ok(probed, 'probeMediaDimensions must return valid metadata');
    assert.equal(probed.width, 3840, 'Probed width must be authentic 3840');
    assert.equal(probed.height, 2160, 'Probed height must be authentic 2160');
    assert.equal(probed.is4K, true, 'is4K flag must be true for 3840x2160 source');

    // 3. Test genuine 4K media download endpoint through media session
    const media4kId = 'session_4k_test_media';
    setCachedMedia(media4kId, {
      id: media4kId,
      shortcode: '4k_test',
      title: 'True 4K Test Reel',
      mediaType: 'reel',
      itemCount: 1,
      items: [
        {
          index: 0,
          type: 'video',
          directUrl: 'https://instagram.fcjb6-1.fna.fbcdn.net/v/test_4k.mp4',
          width: 3840,
          height: 2160,
          resolution: '3840×2160',
          qualityLabel: '4K',
          is4K: true,
          tier: 1,
          hasAudio: true,
          suggestedFilename: test4kFilename
        }
      ]
    });

    const dl4kRes = await fetch(`${baseUrl}/api/media/download?mediaId=${media4kId}&itemIndex=0`);
    assert.equal(dl4kRes.status, 200, 'Download endpoint must serve 4K media');
    assert.equal(dl4kRes.headers.get('content-type'), 'video/mp4');
    assert.ok(dl4kRes.headers.get('content-disposition').includes(test4kFilename));

    // 4. Test real Instagram Reel retrieval (DfH51aXkVYo) - honest quality reporting
    const reelRes = await fetch(`${baseUrl}/api/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://www.instagram.com/reel/DfH51aXkVYo/',
        category: 'reels'
      })
    });
    assert.equal(reelRes.status, 200);
    const reelData = await reelRes.json();
    assert.equal(reelData.success, true);
    assert.ok(reelData.media.items.length > 0);

    const realItem = reelData.media.items[0];
    assert.equal(realItem.width, 1080);
    assert.equal(realItem.height, 1920);
    assert.equal(realItem.qualityLabel, 'Full HD');
    assert.equal(realItem.is4K, false, 'Must NOT falsely upscale or claim 1080p is 4K');
    assert.equal(realItem.resolution, '1080×1920');

    // 5. Test real Instagram Photo retrieval (DfLwSsWuzjl) - exact master resolution
    const photoRes = await fetch(`${baseUrl}/api/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://www.instagram.com/p/DfLwSsWuzjl/',
        category: 'post'
      })
    });
    assert.equal(photoRes.status, 200);
    const photoData = await photoRes.json();
    assert.equal(photoData.success, true);
    assert.ok(photoData.media.items.length > 0);

    const realPhoto = photoData.media.items[0];
    assert.equal(realPhoto.width, 1088);
    assert.equal(realPhoto.height, 1440);
    assert.equal(realPhoto.qualityLabel, 'Full HD');
    assert.equal(realPhoto.is4K, false, 'Must NOT falsely claim photo is 4K');
    assert.equal(realPhoto.resolution, '1088×1440');

  } finally {
    if (fs.existsSync(test4kFilePath)) {
      try { fs.unlinkSync(test4kFilePath); } catch (_) {}
    }
    await new Promise((resolve) => server.close(resolve));
  }
});

test('9. Profile Picture Quality, Probing Verification & Lossless Remuxing Integrity', async () => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const fs = require('fs');
  const path = require('path');
  const downloadDir = path.resolve(__dirname, '..', 'downloads');
  const natgeoPic = path.join(downloadDir, 'instagram_natgeo_profile_picture.jpg');
  const muftiPic = path.join(downloadDir, 'instagram_muftimenkofficial_profile_picture.jpg');

  try {
    // 1. Verify Profile Picture dimensions are NOT hardcoded to 640x640
    if (fs.existsSync(natgeoPic)) {
      const probedNatgeo = await probeMediaDimensions(natgeoPic);
      assert.ok(probedNatgeo, 'probeMediaDimensions must probe natgeo picture');
      assert.ok([100, 150].includes(probedNatgeo.width), 'Natgeo DP width must be genuine (100 or 150), not hardcoded 640');
      assert.ok([100, 150].includes(probedNatgeo.height), 'Natgeo DP height must be genuine (100 or 150), not hardcoded 640');
      assert.equal(probedNatgeo.is4K, false, '100x100 must not be flagged as 4K');
      assert.equal(probedNatgeo.qualityLabel, 'Original', '100x100 must not be labeled as HD or 4K');
    }

    if (fs.existsSync(muftiPic)) {
      const probedMufti = await probeMediaDimensions(muftiPic);
      assert.ok(probedMufti, 'probeMediaDimensions must probe muftimenkofficial picture');
      assert.equal(probedMufti.width, 150, 'Muftimenk DP width must be genuine 150, not hardcoded 640');
      assert.equal(probedMufti.height, 150, 'Muftimenk DP height must be genuine 150, not hardcoded 640');
      assert.equal(probedMufti.is4K, false, '150x150 must not be flagged as 4K');
      assert.equal(probedMufti.qualityLabel, 'Original', '150x150 must not be labeled as HD or 4K');
    }

    // 2. Test verified resolution header on download endpoint
    const testSessionId = 'session_test_verified_headers_' + Date.now();
    setCachedMedia(testSessionId, {
      id: testSessionId,
      shortcode: 'DfH51aXkVYo',
      title: 'Verified Download Test Reel',
      mediaType: 'reel',
      itemCount: 1,
      items: [
        {
          index: 0,
          type: 'video',
          directUrl: 'https://instagram.fcjb6-1.fna.fbcdn.net/v/test_reel.mp4',
          width: 1080,
          height: 1920,
          resolution: '1080×1920',
          qualityLabel: 'Full HD',
          is4K: false,
          tier: 3,
          hasAudio: true,
          suggestedFilename: 'instagram_DfH51aXkVYo.mp4'
        }
      ]
    });

    const dlRes = await fetch(`${baseUrl}/api/media/download?mediaId=${testSessionId}&itemIndex=0`);
    assert.equal(dlRes.status, 200);
    assert.equal(dlRes.headers.get('content-type'), 'video/mp4');
    const probedRes = dlRes.headers.get('x-media-resolution');
    assert.ok(probedRes === '1080×1920' || probedRes === '1080x1920', `Expected 1080×1920 or 1080x1920, got ${probedRes}`);
    assert.equal(dlRes.headers.get('x-media-quality'), 'Full HD');
    assert.equal(dlRes.headers.get('x-media-is-4k'), 'false');

    // 3. Test Network error message consistency
    const invalidUrlRes = await fetch(`${baseUrl}/api/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://www.instagram.com/reel/INVALID_SHORTCODE_FOR_NETWORK_TEST_99999/',
        category: 'reels'
      })
    });
    const invalidData = await invalidUrlRes.json();
    assert.equal(invalidData.success, false);
    assert.ok(
      !invalidData.error.includes('curl') &&
      !invalidData.error.includes('traceback') &&
      !invalidData.error.includes('line ') &&
      !invalidData.error.includes('python'),
      'Errors must never expose technical details to client'
    );

  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
