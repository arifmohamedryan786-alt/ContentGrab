/**
 * ContentGrab - Client Application Logic
 * Signature Instagram Brand Theme (Reels, Post, DP categories).
 * Features:
 * - Animated Welcome Screen on initial launch with 3D portal
 * - Dedicated URL Classification for Reels, Posts, and DP
 * - Live URL detection badge showing recognized content type
 * - Dynamic headings & contextual placeholders
 * - Clipboard Paste & Quick-Clear buttons
 * - Real-time processing states & honest error reporting
 * - Video player previews, HD photo previews, Carousel ZIPs, and DP Profile avatars
 * - Direct clean downloads without history tracking
 */

document.addEventListener('DOMContentLoaded', () => {
  // --- Animated Welcome Screen (Cinematic Brand Portal) ---
  const welcomeScreen = document.getElementById('welcome-screen');
  const SPLASH_SESSION_KEY = 'contentgrab_splash_shown';

  if (welcomeScreen) {
    if (sessionStorage.getItem(SPLASH_SESSION_KEY)) {
      // Already welcomed in this browser session
      welcomeScreen.style.display = 'none';
    } else {
      // Mark as shown for this session
      sessionStorage.setItem(SPLASH_SESSION_KEY, 'true');

      // Dismiss helper function for smooth exit
      let dismissed = false;
      const dismissWelcome = () => {
        if (dismissed) return;
        dismissed = true;
        welcomeScreen.classList.add('fade-out');
        setTimeout(() => {
          welcomeScreen.style.display = 'none';
        }, 600);
      };

      // 3-second choreographed cinematic brand sequence, then smooth exit
      const exitTimer = setTimeout(dismissWelcome, 2900);

      // Instant click, touch, or keypress to enter immediately
      welcomeScreen.addEventListener('click', () => {
        clearTimeout(exitTimer);
        dismissWelcome();
      }, { once: true });

      document.addEventListener('keydown', () => {
        if (!dismissed) {
          clearTimeout(exitTimer);
          dismissWelcome();
        }
      }, { once: true });
    }
  }

  // Purge any legacy history cached in browser localStorage
  try {
    localStorage.removeItem('ig_downloader_history');
  } catch (e) {
    // Ignore localStorage access restrictions if any
  }

  // --- Category Configurations ---
  const CATEGORIES = {
    reels: {
      heading: 'ContentGrab',
      subheading: 'Download Reels Here',
      placeholder: 'Paste Reel link here (e.g. instagram.com/reel/...)...',
      badge: 'REEL'
    },
    post: {
      heading: 'ContentGrab',
      subheading: 'Download Post Here',
      placeholder: 'Paste post link here (e.g. instagram.com/p/...)...',
      badge: 'POST'
    },
    dp: {
      heading: 'ContentGrab',
      subheading: 'Download DP Here',
      placeholder: 'Enter username (e.g. natgeo or @username) or profile link...',
      badge: 'PROFILE DP'
    }
  };
  // Backwards compatibility alias for photo
  CATEGORIES.photo = CATEGORIES.post;

  let activeCategory = 'reels';
  let currentMedia = null;

  // --- DOM Elements ---
  const categoryTabs = document.querySelectorAll('.category-tab');
  const mainHeading = document.getElementById('main-heading');
  const mainSubheading = document.getElementById('main-subheading');

  const downloaderForm = document.getElementById('downloader-form');
  const urlInput = document.getElementById('url-input');
  const pasteBtn = document.getElementById('paste-btn');
  const clearBtn = document.getElementById('clear-btn');

  const searchBtn = document.getElementById('search-btn');
  const searchBtnText = searchBtn.querySelector('.search-btn-text');
  const btnSpinner = searchBtn.querySelector('.btn-spinner');
  const searchArrowIcon = searchBtn.querySelector('.search-arrow-icon');

  const statusCard = document.getElementById('status-card');
  const statusHead = document.getElementById('status-head');
  const statusSub = document.getElementById('status-sub');

  const errorCard = document.getElementById('error-card');
  const errorTitle = document.getElementById('error-title');
  const errorBody = document.getElementById('error-body');
  const errorBadgeTag = document.getElementById('error-badge-tag');
  const errorDistinctionGrid = document.getElementById('error-distinction-grid');
  const distinctionUrlType = document.getElementById('distinction-url-type');
  const distinctionAccessStatus = document.getElementById('distinction-access-status');
  const errorDismissBtn = document.getElementById('error-dismiss-btn');

  const resultsSection = document.getElementById('results-section');
  const resultsBadge = document.getElementById('results-badge');
  const resultsTitle = document.getElementById('results-title');
  const resultsAuthor = document.getElementById('results-author');
  const resultsActions = document.getElementById('results-actions');
  const resultsContent = document.getElementById('results-content');

  const toastContainer = document.getElementById('toast-container');

  // --- Initialize ---
  initCategoryNavigation();
  verifyBackendHealth();

  // --- Category Navigation ---
  function initCategoryNavigation() {
    categoryTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const cat = tab.getAttribute('data-category');
        if (!cat || cat === activeCategory) return;
        selectCategory(cat);
      });
    });
  }

  function selectCategory(cat) {
    if (!CATEGORIES[cat]) return;
    activeCategory = cat;

    // Update Tab UI
    categoryTabs.forEach(t => {
      const isSelected = t.getAttribute('data-category') === cat;
      t.classList.toggle('active', isSelected);
      t.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    });

    // Update Headings & Placeholders
    const config = CATEGORIES[cat];
    mainHeading.textContent = config.heading;
    mainSubheading.textContent = config.subheading;
    urlInput.placeholder = config.placeholder;

    // Hide any previous error or stale results
    hideError();
    resultsSection.style.display = 'none';
  }

  // --- Live URL Classification Helper ---
  function classifyInputLocally(input) {
    const raw = (input || '').trim();
    if (!raw) return null;

    // Check DP handle
    if (activeCategory === 'dp') {
      if (/^@?[A-Za-z0-9._]+$/.test(raw) && !raw.includes('/') && !raw.includes('.')) {
        return { type: 'dp', label: 'Instagram Profile (@' + raw.replace('@', '') + ')', category: 'dp' };
      }
    }

    // Check unsupported Stories / Highlights
    if (/\/stories\/|\/s\/[A-Za-z0-9_-]+/i.test(raw)) {
      return {
        type: 'unsupported',
        label: 'Instagram Story/Highlight (Requires Login)',
        unsupported: true
      };
    }

    // Check Reels & Videos (unified into Reels)
    if (/\/(?:share\/)?(?:reels?|tv)\/[A-Za-z0-9_-]+/i.test(raw)) {
      return { type: 'reel', label: 'Instagram Reel', category: 'reels' };
    }

    // Check Standard Posts / Photos / Carousels
    if (/\/(?:share\/)?p\/[A-Za-z0-9_-]+/i.test(raw)) {
      const isPostOrPhoto = activeCategory === 'post' || activeCategory === 'photo';
      return {
        type: 'post',
        label: 'Instagram Post',
        category: isPostOrPhoto ? 'post' : 'reels'
      };
    }

    // Check Profile URL
    if (activeCategory === 'dp' && /\/([A-Za-z0-9._]+)\/?$/i.test(raw)) {
      return { type: 'dp', label: 'Instagram Profile', category: 'dp' };
    }

    return null;
  }

  // --- Input & Action Handlers ---
  urlInput.addEventListener('input', () => {
    hideError();
  });

  pasteBtn.addEventListener('click', async () => {
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        showToast('Clipboard access not supported. Please paste manually.', 'error');
        return;
      }
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        urlInput.value = text.trim();
        hideError();
        urlInput.focus();
        showToast('Pasted link from clipboard', 'info');
      } else {
        showToast('Clipboard is empty', 'info');
      }
    } catch (err) {
      showToast('Please grant clipboard permissions to paste automatically.', 'error');
    }
  });

  clearBtn.addEventListener('click', () => {
    urlInput.value = '';
    urlInput.focus();
    hideError();
  });

  errorDismissBtn.addEventListener('click', hideError);

  // --- Form Submission & Media Retrieval ---
  downloaderForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const rawInput = urlInput.value.trim();
    if (!rawInput) {
      showError('Input Required', 'Please enter a valid supported Instagram URL.');
      urlInput.focus();
      return;
    }

    const localDetected = classifyInputLocally(rawInput);

    // Reject unsupported Story and Highlight links upfront
    if (localDetected && localDetected.unsupported) {
      showError('Content Type Not Supported', 'Instagram Stories and Highlights require private account login and are not supported. ContentGrab supports public Videos, Reels, Photos, Carousels, and Profile Avatars.');
      return;
    }

    // Client-side quick check
    if (activeCategory === 'dp') {
      if (rawInput.includes(' ') || rawInput.length < 2) {
        showError('Invalid Username', 'Please enter a valid Instagram username (e.g. natgeo or @username) or profile link.');
        return;
      }
    } else if (!/instagram\.com|instagr\.am/i.test(rawInput)) {
      showError('Invalid Domain', 'Please enter a valid supported Instagram URL.');
      return;
    }

    // Begin Loading State
    const statusLabel = localDetected ? localDetected.label : (CATEGORIES[activeCategory]?.badge || 'Instagram Media');
    setLoading(true, `Analyzing ${statusLabel}...`, 'Connecting to Instagram and checking media access permissions.');
    hideError();
    resultsSection.style.display = 'none';

    try {
      const response = await fetch('/api/media', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: rawInput,
          category: activeCategory
        })
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        const detectedTitle = result.detectedLabel ? `${result.detectedLabel} Notice` : 'Media Retrieval Notice';
        
        // Use backend URL-specific error directly
        let errorMsg = result.error;
        if (!errorMsg) {
          if (result.urlType === 'story' || activeCategory === 'stories') {
            errorMsg = 'This Story URL was recognized, but Instagram may require authorized access to retrieve Story media.';
          } else if (result.urlType === 'highlight' || activeCategory === 'highlights') {
            errorMsg = 'This Highlight URL was recognized, but the media could not be retrieved through the currently available permitted access method.';
          } else {
            errorMsg = 'Please enter a valid supported Instagram URL.';
          }
        }
        
        showError(detectedTitle, errorMsg, {
          urlRecognized: Boolean(result.urlRecognized !== false),
          urlType: result.urlType || localDetected?.type,
          detectedLabel: result.detectedLabel || localDetected?.label || 'Instagram Content',
          errorCode: result.errorCode
        });
        return;
      }

      currentMedia = result.media;
      renderResults(currentMedia);
      showToast('Media successfully retrieved!', 'success');

      // Smooth scroll down to results section
      resultsSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    } catch (err) {
      console.error('Media retrieval error:', err);
      showError('Connection Error', 'Unable to connect to Instagram. Please check your internet connection and try again.');
    } finally {
      setLoading(false);
    }
  });

  // --- Render Results UI ---
  function renderResults(media) {
    if (!media) return;

    resultsSection.style.display = 'block';

    // Badge & Heading
    let badgeText = (CATEGORIES[activeCategory]?.badge || media.mediaType || 'MEDIA').toUpperCase();
    if (media.mediaType === 'carousel') {
      badgeText = `CAROUSEL (${media.itemCount} ITEMS)`;
    }
    resultsBadge.textContent = badgeText;
    resultsTitle.textContent = media.title || `Instagram Media (${media.shortcode || 'Ready'})`;

    const authorText = media.uploader ? `@${media.uploader}` : 'Public Instagram Content';
    const countText = media.itemCount > 1 ? `${media.itemCount} files available` : '1 file ready to download';
    resultsAuthor.textContent = `${authorText} • ${countText}`;

    // Header actions (e.g. Download All as ZIP for carousels)
    resultsActions.innerHTML = '';
    if (media.itemCount > 1 && media.zipDownloadUrl) {
      const zipBtn = document.createElement('button');
      zipBtn.type = 'button';
      zipBtn.className = 'purple-btn';
      zipBtn.style.width = 'auto';
      zipBtn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        <span>Download All as ZIP</span>
      `;
      zipBtn.addEventListener('click', () => triggerZipDownload(media));
      resultsActions.appendChild(zipBtn);
    }

    // Clear previous results content
    resultsContent.innerHTML = '';

    // Special View: Profile Picture (DP)
    if (activeCategory === 'dp' && media.items && media.items[0]) {
      resultsContent.className = 'results-grid single-layout';
      const dpCard = createDpCard(media, media.items[0]);
      resultsContent.appendChild(dpCard);
      return;
    }

    // Grid layout adjustment
    if (media.itemCount === 1) {
      resultsContent.className = 'results-grid single-layout';
    } else {
      resultsContent.className = 'results-grid';
    }

    // Standard media cards (Videos, Reels, Photos, Slides)
    media.items.forEach((item, index) => {
      const card = createMediaCard(media, item, index);
      resultsContent.appendChild(card);
    });
  }

  // --- Card Renderers ---
  function createDpCard(media, item) {
    const card = document.createElement('div');
    card.className = 'dp-profile-card';

    const avatar = document.createElement('img');
    avatar.className = 'dp-avatar-circle';
    avatar.src = item.previewUrl;
    avatar.alt = `${media.uploader || 'Instagram user'} avatar`;

    const info = document.createElement('div');
    info.className = 'dp-info-group';

    const name = document.createElement('h3');
    name.textContent = media.uploader ? `@${media.uploader}` : 'Instagram Profile';

    const desc = document.createElement('p');
    const hasDimensions = item.width && item.height;
    const resText = hasDimensions ? `${item.width} × ${item.height}` : 'Original Dimensions';
    const isHdQuality = item.qualityLabel === '4K' || item.qualityLabel === '1440p' || item.qualityLabel === 'Full HD' || item.qualityLabel === 'HD';
    const qualitySuffix = isHdQuality ? ` (${item.qualityLabel})` : '';
    desc.textContent = `${media.title || 'Profile Picture'} • ${resText}${qualitySuffix}`;

    info.appendChild(name);
    info.appendChild(desc);

    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'purple-btn';
    downloadBtn.style.maxWidth = '340px';
    const btnLabel = hasDimensions
      ? (isHdQuality ? `Download HD Profile Picture (${resText})` : `Download Profile Picture (${resText})`)
      : 'Download Profile Picture';
    downloadBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="7 10 12 15 17 10"></polyline>
        <line x1="12" y1="15" x2="12" y2="3"></line>
      </svg>
      <span>${btnLabel}</span>
    `;
    downloadBtn.addEventListener('click', () => triggerSingleDownload(media, item, downloadBtn));

    card.appendChild(avatar);
    card.appendChild(info);
    card.appendChild(downloadBtn);

    return card;
  }

  function createMediaCard(media, item, index) {
    const card = document.createElement('div');
    card.className = 'media-card';

    const frame = document.createElement('div');
    frame.className = 'media-frame';

    const isVideo = item.type === 'video';

    if (isVideo) {
      const video = document.createElement('video');
      video.className = 'media-video-player';
      video.controls = true;
      video.playsInline = true;
      video.preload = 'metadata';
      if (item.thumbnail) {
        video.poster = item.thumbnail;
      }
      video.src = item.previewUrl;
      frame.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.className = 'media-photo-view';
      img.alt = `Media item ${index + 1}`;
      img.loading = 'lazy';
      img.src = item.previewUrl;
      frame.appendChild(img);
    }

    const body = document.createElement('div');
    body.className = 'media-card-body';

    const specRow = document.createElement('div');
    specRow.className = 'media-spec-row';

    const slideTag = document.createElement('span');
    slideTag.className = 'slide-tag';
    slideTag.textContent = media.itemCount > 1 ? `Slide #${index + 1}` : (isVideo ? 'Video' : 'Photo');

    // Quality Badge (4K, 1440p, Full HD, HD, Original)
    const qualityLabel = item.qualityLabel || (item.is4K ? '4K' : (item.width >= 1920 || item.height >= 1920 ? 'Full HD' : 'Original'));
    const qualityBadge = document.createElement('span');
    const badgeModifier = qualityLabel.toLowerCase().replace(/\s+/g, '-');
    qualityBadge.className = `quality-badge quality-${badgeModifier}`;
    qualityBadge.textContent = qualityLabel;

    // Exact Resolution & Format
    const formatTag = document.createElement('span');
    formatTag.className = 'format-tag';
    const extName = (item.ext || (isVideo ? 'mp4' : 'jpg')).toUpperCase();
    const resolutionText = item.width && item.height ? `${item.width} × ${item.height}` : 'Original';
    formatTag.textContent = `${resolutionText} • ${extName}`;

    specRow.appendChild(slideTag);
    specRow.appendChild(qualityBadge);
    specRow.appendChild(formatTag);

    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'purple-btn';
    const qualityButtonPrefix = qualityLabel && qualityLabel !== 'Original' ? ` (${qualityLabel})` : '';
    downloadBtn.innerHTML = `
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="7 10 12 15 17 10"></polyline>
        <line x1="12" y1="15" x2="12" y2="3"></line>
      </svg>
      <span>Download ${isVideo ? 'Video' : 'Photo'}${qualityButtonPrefix}</span>
    `;
    downloadBtn.addEventListener('click', () => triggerSingleDownload(media, item, downloadBtn));

    body.appendChild(specRow);

    // Provide Download Audio option for video media with an available audio track
    if (isVideo && item.hasAudio !== false) {
      const actionsStack = document.createElement('div');
      actionsStack.className = 'media-actions-stack';

      const audioBtn = document.createElement('button');
      audioBtn.type = 'button';
      audioBtn.className = 'audio-download-btn';
      audioBtn.innerHTML = `
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 18V5l12-2v13"></path>
          <circle cx="6" cy="18" r="3"></circle>
          <circle cx="18" cy="16" r="3"></circle>
        </svg>
        <span>Download Audio (MP3)</span>
      `;
      audioBtn.addEventListener('click', () => triggerAudioDownload(media, item, audioBtn));

      actionsStack.appendChild(downloadBtn);
      actionsStack.appendChild(audioBtn);
      body.appendChild(actionsStack);
    } else {
      body.appendChild(downloadBtn);
    }

    card.appendChild(frame);
    card.appendChild(body);

    return card;
  }

  // --- Downloads ---
  async function triggerAudioDownload(media, item, btn) {
    const originalContent = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="btn-spinner"></span> <span>Preparing Audio...</span>`;

    try {
      const targetUrl = item.audioDownloadUrl || `/api/media/audio?mediaId=${media.id}&itemIndex=${item.index}`;
      const response = await fetch(targetUrl);

      if (!response.ok) {
        let errorMsg = 'Unable to prepare the audio from this Reel. Please try again or download the original video.';
        try {
          const data = await response.json();
          if (data && data.error) {
            errorMsg = data.error;
          }
        } catch (_) {}
        showToast(errorMsg, 'error');
        btn.disabled = false;
        btn.innerHTML = originalContent;
        return;
      }

      let filename = `instagram_${media.shortcode || 'reel'}_audio.mp3`;
      const disposition = response.headers.get('content-disposition');
      if (disposition && disposition.includes('filename=')) {
        const match = disposition.match(/filename="?([^";]+)"?/);
        if (match && match[1]) {
          filename = match[1];
        }
      }

      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);

      btn.disabled = false;
      btn.innerHTML = `
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <span>Audio Downloaded!</span>
      `;
      showToast(`Downloaded audio: ${filename}`, 'success');

      setTimeout(() => {
        btn.innerHTML = originalContent;
      }, 3000);
    } catch (err) {
      console.error('Audio download error:', err);
      showToast('Unable to prepare the audio from this Reel. Please try again or download the original video.', 'error');
      btn.disabled = false;
      btn.innerHTML = originalContent;
    }
  }

  // --- Downloads (Clean direct stream without history records) ---
  async function triggerSingleDownload(media, item, btn) {
    const originalContent = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="btn-spinner"></span> <span>Downloading...</span>`;

    try {
      const response = await fetch(item.downloadUrl);
      if (!response.ok) {
        throw new Error(`Download request failed with status ${response.status}`);
      }

      // Verify authentic resolution from backend probe headers if returned
      const verifiedRes = response.headers.get('x-media-resolution');
      const verifiedQuality = response.headers.get('x-media-quality');
      if (verifiedRes && verifiedRes !== 'Original') {
        const card = btn.closest('.media-card, .dp-profile-card');
        if (card) {
          const formatTag = card.querySelector('.format-tag');
          if (formatTag) {
            const extName = (item.ext || (item.type === 'video' ? 'mp4' : 'jpg')).toUpperCase();
            formatTag.textContent = `${verifiedRes.replace(/[×x]/, ' × ')} • ${extName}`;
          }
          const qualityBadge = card.querySelector('.quality-badge');
          if (qualityBadge && verifiedQuality) {
            qualityBadge.className = `quality-badge quality-${verifiedQuality.toLowerCase().replace(/\s+/g, '-')}`;
            qualityBadge.textContent = verifiedQuality;
          }
        }
      }

      let filename = item.suggestedFilename || 'instagram_media';
      const disposition = response.headers.get('content-disposition');
      if (disposition && disposition.includes('filename=')) {
        const match = disposition.match(/filename="?([^";]+)"?/);
        if (match && match[1]) {
          filename = match[1];
        }
      }

      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);

      btn.disabled = false;
      btn.innerHTML = `
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <span>Downloaded!</span>
      `;
      showToast(`Started downloading ${filename}`, 'success');

      setTimeout(() => {
        btn.innerHTML = originalContent;
      }, 3000);
    } catch (err) {
      // Fallback to standard anchor navigation if fetch or blob encounters limitation
      const a = document.createElement('a');
      a.href = item.downloadUrl;
      a.download = item.suggestedFilename || 'instagram_media';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = `
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          <span>Downloaded!</span>
        `;
        showToast(`Started downloading ${item.suggestedFilename || 'media'}`, 'success');

        setTimeout(() => {
          btn.innerHTML = originalContent;
        }, 3000);
      }, 1200);
    }
  }

  function triggerZipDownload(media) {
    if (!media.zipDownloadUrl) return;

    showToast('Preparing ZIP archive for download...', 'info');

    const a = document.createElement('a');
    a.href = media.zipDownloadUrl;
    a.download = `instagram_${media.shortcode}_carousel.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    showToast('Carousel ZIP archive download started!', 'success');
  }

  // --- Feedback & State Helpers ---
  function setLoading(isLoading, head = '', sub = '') {
    if (isLoading) {
      searchBtn.disabled = true;
      searchBtnText.style.display = 'none';
      searchArrowIcon.style.display = 'none';
      btnSpinner.style.display = 'inline-block';

      statusHead.textContent = head;
      statusSub.textContent = sub;
      statusCard.style.display = 'flex';
    } else {
      searchBtn.disabled = false;
      searchBtnText.style.display = 'inline';
      searchArrowIcon.style.display = 'inline-block';
      btnSpinner.style.display = 'none';
      statusCard.style.display = 'none';
    }
  }

  function showError(title, body, meta = null) {
    errorTitle.textContent = title;
    errorBody.textContent = body;

    const isRecognized = meta && (meta.urlRecognized || meta.urlType === 'story' || meta.urlType === 'highlight');
    if (isRecognized && errorBadgeTag && errorDistinctionGrid) {
      errorBadgeTag.style.display = 'inline-block';
      errorBadgeTag.textContent = 'URL RECOGNIZED';
      errorDistinctionGrid.style.display = 'grid';
      if (distinctionUrlType) {
        distinctionUrlType.textContent = meta.detectedLabel || 'Valid Instagram Link';
      }
      if (distinctionAccessStatus) {
        if (meta.errorCode === 'NETWORK_ERROR' || meta.errorCode === 'NETWORK_TIMEOUT') {
          distinctionAccessStatus.textContent = 'Network Unreachable';
        } else if (meta.urlType === 'story' || meta.urlType === 'highlight') {
          distinctionAccessStatus.textContent = 'Login Required by Instagram';
        } else {
          distinctionAccessStatus.textContent = 'Media Inaccessible';
        }
      }
    } else {
      if (errorBadgeTag) errorBadgeTag.style.display = 'none';
      if (errorDistinctionGrid) errorDistinctionGrid.style.display = 'none';
    }

    errorCard.style.display = 'flex';
  }

  function hideError() {
    errorCard.style.display = 'none';
    if (errorBadgeTag) errorBadgeTag.style.display = 'none';
    if (errorDistinctionGrid) errorDistinctionGrid.style.display = 'none';
  }

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.25s ease';
      setTimeout(() => {
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
        }
      }, 250);
    }, 3500);
  }

  async function verifyBackendHealth() {
    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        const data = await res.json();
        console.log('API health status:', data);
      }
    } catch {
      console.warn('Backend server is not responding at /api/health');
    }
  }
});
