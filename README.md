# ContentGrab

A clean, premium, locally-hosted web application for macOS to retrieve and download public Instagram Reels, posts, videos, photos, and carousels for personal use.

---

## 🌟 Highlights

- **Pure Local Execution**: Binds strictly to `127.0.0.1:3000` on your Mac. No accounts, external databases, or tracking.
- **Genuine Previews**: Renders working HTML5 video players (`<video>`) and images (`<img>`) directly from validated media streams.
- **Carousel & Multi-Item Support**: Inspects each individual slide in a carousel and offers individual file downloads or a single batch **ZIP archive**.
- **Dual Destination Saving**: Automatically saves files to your local `./downloads/` directory while streaming them directly to your browser's default `~/Downloads` folder.
- **Zero Fake Indicators**: No simulated percentages, fake testimonials, or mock buttons. Honest error reporting when Instagram restricts access.
- **SSRF & Security Protected**: Validates Instagram hostnames, restricts CDN downloads to authorized Meta infrastructure (`*.cdninstagram.com`, `*.fbcdn.net`), and verifies DNS records against private and reserved IP addresses.
- **Local Download History**: Tracks your recent downloads in your browser's `localStorage` with options to re-download or clear history anytime.

---

## 📁 Project Structure

```
Content Vault/
├── server.js                        # Express server entry point (127.0.0.1:3000)
├── package.json                     # Project manifest and scripts
├── .gitignore                       # Git ignore (excludes node_modules and downloads)
├── README.md                        # Documentation and user guide
├── services/
│   └── mediaService.js              # Media retrieval service (yt-dlp engine + fallback)
├── routes/
│   └── mediaRoutes.js               # API endpoints (/health, /media, /download, /download-zip)
├── utils/
│   ├── validateInstagramUrl.js      # URL syntax, domain, and path validator
│   └── validateCdnUrl.js            # SSRF protection and CDN host whitelist validator
├── public/
│   ├── index.html                   # Modern HTML5 frontend layout
│   ├── style.css                    # Polished, responsive CSS styling
│   └── script.js                    # Interactive vanilla JavaScript frontend logic
├── downloads/                       # Local directory where downloaded media is saved
└── test/
    └── test.js                      # Automated unit and integration test suite
```

---

## 🚀 Quick Start Guide

### 1. Prerequisites

The following tools are already installed on your Mac:
- **Node.js** (v18+ / v26.8.1 installed)
- **npm** (v11.19.0 installed)
- **yt-dlp** (installed at `/Library/Frameworks/Python.framework/Versions/3.14/bin/yt-dlp`)

### 2. Install Dependencies

In your terminal, navigate to the project directory:

```bash
cd "/Users/arifmohamed/Content Vault"
npm install
```

### 3. Start the Application

To start the server:

```bash
npm start
```

Or for development with automatic reload on file changes:

```bash
npm run dev
```

You will see the startup confirmation banner:

```text
======================================================
  ContentGrab - Local Server Active
  Local URL: http://127.0.0.1:3000
  Environment: Personal Local macOS Utility
  Saved Files: /Users/arifmohamed/Content Vault/downloads
======================================================
```

### 4. Open in Your Browser

Open your favorite web browser (Safari, Chrome, Brave, Arc, etc.) and visit:

**[http://127.0.0.1:3000](http://127.0.0.1:3000)**

---

## 🛑 How to Stop and Restart the Server

- **To Stop**: In the terminal window running the server, press `Ctrl + C`.
- **To Restart**: Run `npm start` again.

---

## 📥 Where Downloaded Files Are Saved on Your Mac

When you download a video, image, or ZIP archive:

1. **Browser Downloads Folder**: Your browser automatically saves the file to your Mac's default `~/Downloads` folder.
2. **Project Local Folder**: The backend server simultaneously writes a copy directly into:
   ```
   /Users/arifmohamed/Content Vault/downloads/
   ```
   You can view or open these files anytime via Finder or VS Code.

---

## 🧭 How to Use

1. **Copy Link**: On Instagram, copy the share link for any public Reel or post.
2. **Paste**: In ContentGrab, click the **Paste** button or paste directly into the URL input.
3. **Get Media**: Click **Get Media**. The application connects to Instagram's public endpoints and retrieves the media details.
4. **Preview**:
   - For **Videos/Reels**: Watch the actual video preview with browser controls.
   - For **Images**: View the high-resolution photo preview.
   - For **Carousels**: Browse each individual slide (photos and videos) with its slide index and resolution.
5. **Download**:
   - Click **Download Video** or **Download Image** for individual files.
   - Click **Download All (ZIP)** to bundle every slide in a carousel into a single zip file.
6. **Recent Downloads**: Check the recent downloads section to view your history or re-download files.

---

## ⚠️ Media Retrieval Limitations & Error Explanations

Instagram actively maintains bot mitigation and access boundaries. This personal utility respects these boundaries:

| Scenario | Application Response | Explanation |
|---|---|---|
| **Private Account** | `This post is from a private account.` | Private media requires account authentication and following permission, which cannot and should not be bypassed. |
| **Login Checkpoint** | `Instagram requires authentication or account login...` | Instagram periodically presents a login wall or CAPTCHA challenge for specific IP ranges or content types. |
| **Deleted / Expired Post** | `The requested post could not be found.` | The post has been removed by the creator or the link is invalid. |
| **Rate Limiting (429)** | `Instagram is temporarily rate-limiting requests.` | Too many rapid requests have been issued from your IP. Wait a couple of minutes and try again. |
| **Stories / Highlights** | `Unsupported Instagram link.` | Stories and Highlights require active user session cookies and expire after 24 hours. |

---

## 🧪 Running Automated Tests

Run the built-in test suite to verify all endpoints, security filters, and integrations:

```bash
npm test
```

### Verified Test Cases:
1. `validateInstagramUrl`: Sanitizes input, rejects unrelated domains and malformed URLs, rejects credentials.
2. `validateInstagramUrl`: Correctly parses Reels, Posts, IGTV, and short links (`instagr.am`).
3. `validateSafeCdnUrl`: Prevents SSRF attacks, disallows loopback (`127.0.0.1`), AWS metadata (`169.254.169.254`), and unauthorized domains; permits legitimate Meta CDNs (`*.cdninstagram.com`, `*.fbcdn.net`).
4. `checkYtDlpHealth`: Confirms `yt-dlp` is available and detects installed version.
5. `Express Server`: Confirms `/api/health`, static HTML/CSS/JS delivery, `/api/media/downloads`, input validation error handling (400), and expired media session handling (404).

---

## 🔒 Security & Privacy

- **Localhost Only**: Binds strictly to `127.0.0.1` preventing remote access over your local network.
- **SSRF Immunity**: The server never accepts arbitrary URLs for fetching; media downloads only access verified server-side cached items or verified Meta CDN hostnames.
- **Rate Limiting**: Built-in in-memory rate limiter prevents request flooding.
- **No Tracking**: No analytics, telemetry, or remote log collection.

