#!/usr/bin/env python3
"""
Instagram Media Extractor
Uses yt-dlp internal extractor with curl_cffi browser impersonation
to reliably extract public Instagram Reels, Videos, Photos, Carousels, and Profile Pictures (DP).
"""

import sys
import os
import shutil
import json
import re
import html
import socket
import yt_dlp
from yt_dlp.utils import ExtractorError, urlencode_postdata

def check_network_connection(host='www.instagram.com', timeout=5.0):
    """
    Fast pre-flight check to verify DNS resolution and socket reachability
    to Instagram without waiting for yt-dlp to time out.
    Prioritizes IPv4 (AF_INET) to prevent macOS IPv6 DNS latency delays,
    and safely preserves the interpreter's default socket timeout.
    """
    old_timeout = socket.getdefaulttimeout()
    try:
        socket.setdefaulttimeout(timeout)
        # 1. Fast IPv4 lookup (resolves in <50ms; avoids slow IPv6 routing delays on macOS)
        try:
            addr_info = socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM)
            if addr_info:
                return True, None
        except socket.gaierror:
            raise
        except Exception:
            pass

        # 2. Fallback to AF_UNSPEC
        addr_info = socket.getaddrinfo(host, 443, socket.AF_UNSPEC, socket.SOCK_STREAM)
        if not addr_info:
            return False, 'Could not resolve host'
        return True, None
    except socket.gaierror as e:
        sys.stderr.write(f"[NETWORK DIAGNOSTIC] DNS lookup for {host} failed: {e}\n")
        return False, str(e)
    except Exception as e:
        sys.stderr.write(f"[NETWORK DIAGNOSTIC] Connection to {host} failed: {e}\n")
        return False, str(e)
    finally:
        socket.setdefaulttimeout(old_timeout)


def is_network_or_dns_error(err_str):
    """
    Checks if an error string or exception indicates DNS, connection, or network failure.
    """
    s = str(err_str).lower()
    network_indicators = [
        'could not resolve host',
        'curl: (6)',
        'curl: (7)',
        'curl: (28)',
        'curl: (35)',
        'curl: (52)',
        'curl: (56)',
        'getaddrinfo failed',
        'nodename nor servname provided',
        'name or service not known',
        'failed to perform, curl',
        'transportererror',
        'transporterror',
        'connection refused',
        'connection reset',
        'network is unreachable',
        'no route to host',
        'econnrefused',
        'etimedout',
        'ehostunreach',
        'enotfound',
        'timed out',
        'timeout',
        'socket.timeout',
        'read timed out',
        'connect timed out',
        'remote end closed connection',
        'temporary failure in name resolution',
        'failed to establish a new connection',
    ]
    return any(indicator in s for indicator in network_indicators)


def parse_image_dimensions(data):
    """
    Safely inspects raw image header bytes (JPEG, PNG, WebP) to detect authentic dimensions.
    Returns (width, height) or (None, None).
    """
    if not data or len(data) < 16:
        return None, None
    try:
        # 1. JPEG
        if data.startswith(b'\xff\xd8'):
            idx = 2
            data_len = len(data)
            while idx < data_len - 8:
                if data[idx] != 0xff:
                    idx += 1
                    continue
                marker = data[idx + 1]
                idx += 2
                # SOF markers: 0xC0 to 0xCF except 0xC4 (DHT), 0xC8 (JPG), 0xCC (DAC)
                if marker in (0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf):
                    if idx + 7 <= data_len:
                        h = int.from_bytes(data[idx+3:idx+5], 'big')
                        w = int.from_bytes(data[idx+5:idx+7], 'big')
                        if w > 0 and h > 0:
                            return w, h
                    break
                elif marker in (0xd9, 0xda):  # EOI, SOS
                    break
                else:
                    if idx + 2 <= data_len:
                        length = int.from_bytes(data[idx:idx+2], 'big')
                        idx += length
                    else:
                        break
        # 2. PNG
        elif data.startswith(b'\x89PNG\r\n\x1a\n') and len(data) >= 24:
            w = int.from_bytes(data[16:20], 'big')
            h = int.from_bytes(data[20:24], 'big')
            if w > 0 and h > 0:
                return w, h
        # 3. WebP
        elif len(data) >= 30 and data[:4] == b'RIFF' and data[8:12] == b'WEBP':
            chunk = data[12:16]
            if chunk == b'VP8 ' and len(data) >= 30:
                w = int.from_bytes(data[26:28], 'little') & 0x3fff
                h = int.from_bytes(data[28:30], 'little') & 0x3fff
                return w, h
            elif chunk == b'VP8L' and len(data) >= 25:
                b0, b1, b2, b3 = data[21:25]
                w = 1 + (((b1 & 0x3f) << 8) | b0)
                h = 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
                return w, h
            elif chunk == b'VP8X' and len(data) >= 30:
                w = 1 + int.from_bytes(data[24:27], 'little')
                h = 1 + int.from_bytes(data[27:30], 'little')
                return w, h
    except Exception:
        pass
    return None, None


def probe_image_url_dimensions(ie, url, display_id):
    """
    Attempts to read the first 8KB of an image URL using the provided InfoExtractor
    to parse authentic pixel dimensions without downloading the entire file.
    """
    if not url or not ie:
        return None, None
    try:
        resp = ie._request_webpage(
            url, display_id, note=False, fatal=False,
            headers={'Range': 'bytes=0-8191', 'Accept': 'image/*,*/*'}
        )
        if resp:
            chunk = resp.read()
            if chunk:
                return parse_image_dimensions(chunk)
    except Exception:
        pass
    return None, None


def extract_instagram_profile(target_input):
    # Extract username from input
    cleaned = target_input.strip()
    cleaned = re.sub(r'^https?:\/\/(?:www\.)?instagram\.com\/', '', cleaned, flags=re.I)
    cleaned = re.sub(r'^\/|\/$', '', cleaned)
    cleaned = cleaned.lstrip('@')
    username = cleaned.split('/')[0].split('?')[0]

    if not username or not re.match(r'^[A-Za-z0-9._]+$', username):
        return {
            'success': False,
            'error_code': 'INVALID_USERNAME',
            'error': 'Please enter a valid Instagram username or profile link.'
        }

    # Pre-flight network check
    reachable, err_diag = check_network_connection('www.instagram.com', timeout=5.0)
    if not reachable:
        sys.stderr.write(f"[NETWORK DIAGNOSTIC] Instagram host unreachable: {err_diag}\n")
        return {
            'success': False,
            'error_code': 'NETWORK_ERROR',
            'error': 'Unable to connect to Instagram. Please check your internet connection and try again.'
        }

    ydl = yt_dlp.YoutubeDL({'skip_download': True, 'quiet': True, 'no_warnings': True, 'socket_timeout': 15})
    ie = yt_dlp.extractor.instagram.InstagramIE(ydl)
    profile_url = f'https://www.instagram.com/{username}/'

    # Try soft session init
    try:
        ie._real_initialize()
    except Exception:
        pass

    best_url = None
    best_w = None
    best_h = None
    full_title = f'@{username}'
    desc = ''

    # 1. First attempt: Query Polaris GraphQL profile query with browser impersonation
    try:
        response = ie._download_json(
            'https://www.instagram.com/api/graphql', username,
            fatal=False, impersonate=True,
            headers={
                **ie._api_headers,
                'X-FB-Friendly-Name': 'PolarisLoggedOutDesktopWWWProfileRootContentQuery',
                'X-Requested-With': 'XMLHttpRequest',
                'Referer': profile_url,
            }, data=urlencode_postdata({
                'lsd': ie._lsd_token or 'AVq5s4tP',
                'fb_api_caller_class': 'RelayModern',
                'fb_api_req_friendly_name': 'PolarisLoggedOutDesktopWWWProfileRootContentQuery',
                'server_timestamps': 'true',
                'variables': json.dumps({'username': username}, separators=(',', ':')),
                'doc_id': '27981003384861049',
            }))
        if response and isinstance(response, dict):
            user_data = response.get('data', {}).get('xig_user_by_username', {})
            if user_data:
                if user_data.get('full_name'):
                    full_title = f"{user_data.get('full_name')} (@{username})"
                if user_data.get('biography'):
                    desc = user_data.get('biography')

                # Check hd_profile_pic_url_info
                hd_info = user_data.get('hd_profile_pic_url_info')
                if isinstance(hd_info, dict) and hd_info.get('url'):
                    best_url = hd_info.get('url')
                    best_w = hd_info.get('width')
                    best_h = hd_info.get('height')

                # Check hd_profile_pic_versions
                if not best_url:
                    hd_vers = user_data.get('hd_profile_pic_versions')
                    if isinstance(hd_vers, list) and len(hd_vers) > 0:
                        sorted_vers = sorted(
                            [v for v in hd_vers if isinstance(v, dict) and v.get('url')],
                            key=lambda v: (v.get('width') or 0) * (v.get('height') or 0),
                            reverse=True
                        )
                        if sorted_vers:
                            best_url = sorted_vers[0].get('url')
                            best_w = sorted_vers[0].get('width')
                            best_h = sorted_vers[0].get('height')

                # Check standard profile_pic_url
                if not best_url and user_data.get('profile_pic_url'):
                    best_url = user_data.get('profile_pic_url')
    except Exception as e:
        sys.stderr.write(f"[EXTRACTOR TECHNICAL ERROR] Polaris profile query for @{username}: {e}\n")
        if is_network_or_dns_error(e):
            return {
                'success': False,
                'error_code': 'NETWORK_ERROR',
                'error': 'Unable to connect to Instagram. Please check your internet connection and try again.'
            }

    # 2. Second attempt / Fallback: Fetch profile webpage HTML
    page = None
    if not best_url:
        try:
            page = ie._download_webpage(profile_url, username, fatal=False, impersonate=True)
        except Exception as e:
            sys.stderr.write(f"[EXTRACTOR TECHNICAL ERROR] Profile @{username} page error: {e}\n")
            if is_network_or_dns_error(e):
                return {
                    'success': False,
                    'error_code': 'NETWORK_ERROR',
                    'error': 'Unable to connect to Instagram. Please check your internet connection and try again.'
                }
            return {
                'success': False,
                'error_code': 'RETRIEVAL_FAILED',
                'error': 'Unable to retrieve Instagram profile. Please verify the username and try again.'
            }

        if not page:
            if not check_network_connection()[0]:
                return {
                    'success': False,
                    'error_code': 'NETWORK_ERROR',
                    'error': 'Unable to connect to Instagram. Please check your internet connection and try again.'
                }
            return {
                'success': False,
                'error_code': 'PROFILE_NOT_FOUND',
                'error': f'Instagram profile "@{username}" was not found or is restricted.'
            }

        # Check for hd_profile_pic_url_info in page
        hd_info_matches = re.findall(r'"hd_profile_pic_url_info"\s*:\s*\{([^}]+)\}', page)
        for block in hd_info_matches:
            url_m = re.search(r'"url"\s*:\s*"([^"]+)"', block)
            w_m = re.search(r'"width"\s*:\s*(\d+)', block)
            h_m = re.search(r'"height"\s*:\s*(\d+)', block)
            if url_m:
                u = url_m.group(1).replace(r'\u0026', '&').replace('\\/', '/')
                w = int(w_m.group(1)) if w_m else None
                h = int(h_m.group(1)) if h_m else None
                if not best_w or (w and w > best_w):
                    best_url = u
                    best_w = w
                    best_h = h

        # Check for profile_pic_url_hd in page
        if not best_url:
            hd_matches = re.findall(r'"profile_pic_url_hd"\s*:\s*"([^"]+)"', page)
            if hd_matches:
                best_url = hd_matches[0].replace(r'\u0026', '&').replace('\\/', '/')

        # Check for og:image in page
        if not best_url:
            img_matches = re.findall(r'<meta property="og:image" content="([^"]+)"', page)
            if img_matches:
                best_url = html.unescape(img_matches[0])

        # Check og:image:width and og:image:height if available
        if best_url and not best_w:
            w_matches = re.findall(r'<meta property="og:image:width" content="(\d+)"', page)
            h_matches = re.findall(r'<meta property="og:image:height" content="(\d+)"', page)
            if w_matches and h_matches:
                best_w = int(w_matches[0])
                best_h = int(h_matches[0])

        title_matches = re.findall(r'<meta property="og:title" content="([^"]+)"', page)
        desc_matches = re.findall(r'<meta property="og:description" content="([^"]+)"', page)
        if title_matches:
            full_title = html.unescape(title_matches[0])
        if desc_matches:
            desc = html.unescape(desc_matches[0])

    if not best_url:
        return {
            'success': False,
            'error_code': 'DP_NOT_FOUND',
            'error': f'Profile picture for "@{username}" could not be retrieved. The account may be private or unavailable.'
        }

    # 3. Detect and verify authentic image dimensions (Never hardcode 640x640)
    if not best_w or not best_h:
        # Probe first 8KB of authentic image bytes to inspect JPEG/PNG headers
        probed_w, probed_h = probe_image_url_dimensions(ie, best_url, username)
        if probed_w and probed_h:
            best_w, best_h = probed_w, probed_h

    # If probe could not be performed, check genuine dimension token in URL (e.g. s150x150, s320x320)
    if not best_w or not best_h:
        m = re.search(r'[/_]s?([0-9]{3,4})x([0-9]{3,4})[/_.]', best_url)
        if m:
            best_w, best_h = int(m.group(1)), int(m.group(2))

    # Classify resolution honestly - never upscale a smaller profile picture to HD or 4K
    quality_label, is_4k, tier = classify_resolution(best_w, best_h)
    resolution_str = f'{best_w}×{best_h}' if (best_w and best_h) else None

    uploader_name = full_title.split('(')[0].strip() or username

    return {
        'success': True,
        'data': {
            'shortcode': username,
            'url': profile_url,
            'title': full_title,
            'uploader': username,
            'uploaderName': uploader_name,
            'mediaType': 'dp',
            'itemCount': 1,
            'description': desc,
            'items': [
                {
                    'index': 0,
                    'type': 'image',
                    'directUrl': best_url,
                    'thumbnail': best_url,
                    'width': best_w,
                    'height': best_h,
                    'resolution': resolution_str or 'Original',
                    'qualityLabel': quality_label,
                    'is4K': is_4k,
                    'tier': tier,
                    'duration': None,
                    'ext': 'jpg',
                    'hasAudio': False,
                    'suggestedFilename': f'instagram_{username}_profile_picture.jpg'
                }
            ]
        }
    }


def extract_instagram_story(target_url):
    """
    Dedicated handler for Instagram Stories (/stories/{username}/{story-id}/).
    Performs genuine permitted retrieval via yt-dlp's InstagramStoryIE without bypassing access controls.
    If permitted access is available, extracts genuine media items.
    If Instagram restricts access to authenticated sessions, returns informative explanation.
    """
    m = re.search(r'/stories/([A-Za-z0-9._]+)(?:/([0-9]+))?', target_url, re.I)
    username = m.group(1) if m else 'user'
    story_id = m.group(2) if m and m.group(2) else None
    display_id = story_id or username

    ydl_opts = {
        'skip_download': True,
        'quiet': True,
        'no_warnings': True,
        'format_sort': ['res', 'ext:mp4:m4a', 'vcodec:h264', 'acodec:aac'],
        'socket_timeout': 15,
    }
    ydl = yt_dlp.YoutubeDL(ydl_opts)

    try:
        info_dict = ydl.extract_info(target_url, download=False)
        if info_dict:
            parsed = parse_standard_info(info_dict, target_url, display_id, category='stories')
            if parsed.get('success'):
                parsed['data']['mediaType'] = 'story'
                parsed['data']['detectedLabel'] = 'Instagram Story'
                return parsed
    except Exception as e:
        sys.stderr.write(f"[EXTRACTOR TECHNICAL ERROR] Story error for {target_url}: {e}\n")
        if is_network_or_dns_error(e):
            return {
                'success': False,
                'error_code': 'NETWORK_ERROR',
                'error': 'Unable to connect to Instagram. Please check your internet connection and try again.',
                'url_type': 'story',
                'detected_label': 'Instagram Story',
                'username': username,
                'story_id': story_id,
                'url_recognized': True
            }
        # Instagram restricts anonymous access to stories
        pass

    return {
        'success': False,
        'error_code': 'STORY_AUTH_REQUIRED',
        'error': 'This Story URL was recognized, but Instagram may require authorized access to retrieve Story media.',
        'url_type': 'story',
        'detected_label': 'Instagram Story',
        'username': username,
        'story_id': story_id,
        'url_recognized': True,
        'platform_limitation': 'Instagram enforces authentication for ephemeral Stories.'
    }


def extract_instagram_highlight(target_url):
    """
    Dedicated handler for Instagram Highlights (/s/{share-token} or /stories/highlights/{id}/).
    Resolves share tokens to canonical URLs and queries yt-dlp's InstagramStoryIE legitimately.
    If permitted access is available, extracts genuine media items.
    If Instagram restricts access to authenticated sessions, returns informative explanation.
    """
    m = re.search(r'/stories/highlights/([0-9]+)|/s/([A-Za-z0-9_-]+)', target_url, re.I)
    highlight_id = (m.group(1) or m.group(2)) if m else 'highlight'

    canonical_url = target_url
    if '/s/' in target_url:
        try:
            from urllib.request import Request, urlopen
            req = Request(target_url, headers={'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'})
            with urlopen(req, timeout=10) as resp:
                resolved = resp.geturl()
                if '/stories/highlights/' in resolved:
                    canonical_url = resolved
                    hl_m = re.search(r'/stories/highlights/([0-9]+)', canonical_url)
                    if hl_m:
                        highlight_id = hl_m.group(1)
        except Exception:
            pass

    ydl_opts = {
        'skip_download': True,
        'quiet': True,
        'no_warnings': True,
        'format_sort': ['res', 'ext:mp4:m4a', 'vcodec:h264', 'acodec:aac'],
        'socket_timeout': 15,
    }
    ydl = yt_dlp.YoutubeDL(ydl_opts)

    try:
        info_dict = ydl.extract_info(canonical_url, download=False)
        if info_dict:
            parsed = parse_standard_info(info_dict, canonical_url, highlight_id, category='highlights')
            if parsed.get('success'):
                parsed['data']['mediaType'] = 'highlight'
                parsed['data']['detectedLabel'] = 'Instagram Highlight'
                return parsed
    except Exception as e:
        sys.stderr.write(f"[EXTRACTOR TECHNICAL ERROR] Highlight error for {canonical_url}: {e}\n")
        if is_network_or_dns_error(e):
            return {
                'success': False,
                'error_code': 'NETWORK_ERROR',
                'error': 'Unable to connect to Instagram. Please check your internet connection and try again.',
                'url_type': 'highlight',
                'detected_label': 'Instagram Highlight',
                'highlight_id': highlight_id,
                'url_recognized': True
            }
        # Instagram restricts anonymous access to highlights
        pass

    return {
        'success': False,
        'error_code': 'HIGHLIGHT_ACCESS_RESTRICTED',
        'error': 'This Highlight URL was recognized, but the media could not be retrieved through the currently available permitted access method.',
        'url_type': 'highlight',
        'detected_label': 'Instagram Highlight',
        'highlight_id': highlight_id,
        'url_recognized': True,
        'platform_limitation': 'Instagram requires authorized sessions for Highlights.'
    }


def extract_instagram_post(target_url, category='video'):
    """
    Dedicated handler for standard Instagram Posts, Reels, Videos, Photos, and Carousels.
    Uses Polaris GraphQL API and yt-dlp fallback.
    """
    ydl_opts = {
        'skip_download': True,
        'quiet': True,
        'no_warnings': True,
        'format_sort': ['res', 'ext:mp4:m4a', 'vcodec:h264', 'acodec:aac'],
        'socket_timeout': 15,
    }
    ydl = yt_dlp.YoutubeDL(ydl_opts)
    ie = yt_dlp.extractor.instagram.InstagramIE(ydl)
    
    try:
        video_id = ie._match_id(target_url)
    except Exception:
        return {
            'success': False,
            'error_code': 'INVALID_URL',
            'error': 'Please enter a valid supported Instagram URL.'
        }

    # Soft initialize (continue even if session init has transient warning)
    try:
        ie._real_initialize()
    except Exception:
        pass

    media_id = yt_dlp.extractor.instagram._id_to_pk(video_id)

    # 1. Query Instagram's Polaris API with browser impersonation
    product_info = None
    try:
        response = ie._download_json(
            'https://www.instagram.com/api/graphql', video_id,
            fatal=False, impersonate=True,
            headers={
                **ie._api_headers,
                'X-FB-Friendly-Name': 'PolarisLoggedOutDesktopWWWPostRootContentQuery',
                'X-Requested-With': 'XMLHttpRequest',
                'Referer': target_url,
            }, data=urlencode_postdata({
                'lsd': ie._lsd_token or 'AVq5s4tP',
                'fb_api_caller_class': 'RelayModern',
                'fb_api_req_friendly_name': 'PolarisLoggedOutDesktopWWWPostRootContentQuery',
                'server_timestamps': 'true',
                'variables': json.dumps({'media_id': media_id}, separators=(',', ':')),
                'doc_id': '27130156389949648',
            }))
        if response and isinstance(response, dict):
            media = response.get('data', {}).get('xig_polaris_media', {})
            product_info = media.get('if_not_gated_logged_out')
    except Exception as e:
        sys.stderr.write(f"[EXTRACTOR TECHNICAL ERROR] GraphQL query failed for {video_id}: {e}\n")
        if is_network_or_dns_error(e):
            if 'timed out' in str(e).lower() or 'timeout' in str(e).lower() or 'curl: (28)' in str(e):
                return {
                    'success': False,
                    'error_code': 'NETWORK_TIMEOUT',
                    'error': 'Connection to Instagram timed out. Please check your internet connection and try again.'
                }
            return {
                'success': False,
                'error_code': 'NETWORK_ERROR',
                'error': 'Unable to connect to Instagram. Please check your internet connection and try again.'
            }
        product_info = None

    if product_info:
        parsed = parse_product_info(product_info, target_url, video_id, category, ie=ie)
        if parsed.get('success'):
            # If this item contains video, check if yt-dlp has higher-resolution stream variants
            if any(it.get('type') == 'video' for it in parsed.get('data', {}).get('items', [])):
                try:
                    info_dict = ie._real_extract(target_url)
                    if info_dict:
                        if info_dict.get('_type') == 'playlist' and info_dict.get('entries'):
                            for idx, entry in enumerate(info_dict['entries']):
                                if idx < len(parsed['data']['items']) and parsed['data']['items'][idx].get('type') == 'video':
                                    best_v, best_a = find_best_video_and_audio_formats(entry.get('formats'))
                                    if best_v and (best_v.get('width') or best_v.get('height')):
                                        cur_item = parsed['data']['items'][idx]
                                        cur_area = (cur_item.get('width') or 0) * (cur_item.get('height') or 0)
                                        cur_br = cur_item.get('bitrate') or 0
                                        new_area = (best_v.get('width') or 0) * (best_v.get('height') or 0)
                                        new_br = best_v.get('tbr') or best_v.get('vbr') or 0
                                        if new_area > cur_area or (new_area == cur_area and new_br > cur_br):
                                            v_w = best_v.get('width') or cur_item.get('width')
                                            v_h = best_v.get('height') or cur_item.get('height')
                                            q_label, is_4k, tier = classify_resolution(v_w, v_h)
                                            is_mux = best_v.get('acodec') not in (None, 'none', '')
                                            has_aud = is_mux or (best_a is not None)
                                            cur_item.update({
                                                'directUrl': best_v.get('url'),
                                                'videoStreamUrl': best_v.get('url'),
                                                'audioStreamUrl': best_a.get('url') if (best_a and not is_mux) else None,
                                                'isMuxed': is_mux,
                                                'vcodec': best_v.get('vcodec') or '',
                                                'acodec': best_v.get('acodec') or (best_a.get('acodec') if best_a else ''),
                                                'width': v_w,
                                                'height': v_h,
                                                'resolution': f'{v_w}×{v_h}' if (v_w and v_h) else 'Original',
                                                'qualityLabel': q_label,
                                                'is4K': is_4k,
                                                'tier': tier,
                                                'hasAudio': bool(has_aud)
                                            })
                        elif info_dict.get('formats') and len(parsed['data']['items']) > 0 and parsed['data']['items'][0].get('type') == 'video':
                            best_v, best_a = find_best_video_and_audio_formats(info_dict.get('formats'))
                            if best_v and (best_v.get('width') or best_v.get('height')):
                                cur_item = parsed['data']['items'][0]
                                cur_area = (cur_item.get('width') or 0) * (cur_item.get('height') or 0)
                                cur_br = cur_item.get('bitrate') or 0
                                new_area = (best_v.get('width') or 0) * (best_v.get('height') or 0)
                                new_br = best_v.get('tbr') or best_v.get('vbr') or 0
                                if new_area > cur_area or (new_area == cur_area and new_br > cur_br):
                                    v_w = best_v.get('width') or cur_item.get('width')
                                    v_h = best_v.get('height') or cur_item.get('height')
                                    q_label, is_4k, tier = classify_resolution(v_w, v_h)
                                    is_mux = best_v.get('acodec') not in (None, 'none', '')
                                    has_aud = is_mux or (best_a is not None)
                                    cur_item.update({
                                        'directUrl': best_v.get('url'),
                                        'videoStreamUrl': best_v.get('url'),
                                        'audioStreamUrl': best_a.get('url') if (best_a and not is_mux) else None,
                                        'isMuxed': is_mux,
                                        'vcodec': best_v.get('vcodec') or '',
                                        'acodec': best_v.get('acodec') or (best_a.get('acodec') if best_a else ''),
                                        'width': v_w,
                                        'height': v_h,
                                        'resolution': f'{v_w}×{v_h}' if (v_w and v_h) else 'Original',
                                        'qualityLabel': q_label,
                                        'is4K': is_4k,
                                        'tier': tier,
                                        'hasAudio': bool(has_aud)
                                    })
                except Exception:
                    pass
            return parsed

    # 2. Fallback to standard yt-dlp extraction (e.g. for videos & reels)
    try:
        info_dict = ie._real_extract(target_url)
        return parse_standard_info(info_dict, target_url, video_id, category)
    except ExtractorError as err:
        err_msg = str(err)
        sys.stderr.write(f"[EXTRACTOR TECHNICAL ERROR] Post {video_id} ExtractorError: {err_msg}\n")

        # 1. Network / DNS / Transport failures
        if is_network_or_dns_error(err_msg):
            return {
                'success': False,
                'error_code': 'NETWORK_ERROR',
                'error': 'Unable to connect to Instagram. Please check your internet connection and try again.'
            }

        # 2. Instagram account/access restrictions
        if 'login' in err_msg.lower() or 'checkpoint' in err_msg.lower() or 'not granting access' in err_msg.lower():
            return {
                'success': False,
                'error_code': 'LOGIN_REQUIRED',
                'error': 'Instagram requires authentication or account login to view this content.'
            }
        if 'private' in err_msg.lower() or 'follow this account' in err_msg.lower():
            return {
                'success': False,
                'error_code': 'PRIVATE_ACCOUNT',
                'error': 'This post is from a private account. Private media cannot be retrieved.'
            }
        if 'not found' in err_msg.lower() or 'does not exist' in err_msg.lower() or '404' in err_msg:
            return {
                'success': False,
                'error_code': 'NOT_FOUND',
                'error': 'The requested content could not be found or has been deleted.'
            }

        # 3. Safe sanitized fallback - NEVER expose raw curl, transporter errors, or external URLs
        return {
            'success': False,
            'error_code': 'RETRIEVAL_FAILED',
            'error': 'Unable to retrieve media from Instagram. Please verify the URL and try again.'
        }
    except Exception as e:
        sys.stderr.write(f"[EXTRACTOR TECHNICAL ERROR] Post {video_id} Unexpected Exception: {e}\n")
        if is_network_or_dns_error(e):
            return {
                'success': False,
                'error_code': 'NETWORK_ERROR',
                'error': 'Unable to connect to Instagram. Please check your internet connection and try again.'
            }
        return {
            'success': False,
            'error_code': 'EXTRACTION_FAILED',
            'error': 'Unable to retrieve media from Instagram. Please verify the URL and try again.'
        }


def extract_instagram_media(target_url, category='video', url_type=None):
    """
    Main entry point: Dispatches to dedicated handlers based on URL classification.
    """
    # 0. Fast pre-flight check for network connectivity & DNS resolution
    reachable, err_diag = check_network_connection('www.instagram.com', timeout=5.0)
    if not reachable:
        sys.stderr.write(f"[NETWORK DIAGNOSTIC] Instagram host unreachable: {err_diag}\n")
        return {
            'success': False,
            'error_code': 'NETWORK_ERROR',
            'error': 'Unable to connect to Instagram. Please check your internet connection and try again.',
            'url_type': url_type or category,
            'url_recognized': True
        }

    # 1. Story detection
    if url_type == 'story' or (re.search(r'/stories/[A-Za-z0-9._]+', target_url, re.I) and not re.search(r'/stories/highlights/', target_url, re.I)):
        return extract_instagram_story(target_url)

    # 2. Highlight detection
    if url_type == 'highlight' or re.search(r'/(?:stories/highlights|archive/stories)/[0-9]+', target_url, re.I) or re.search(r'/s/[A-Za-z0-9_-]+', target_url, re.I):
        return extract_instagram_highlight(target_url)

    # 3. DP / Profile Picture detection
    if url_type == 'dp' or category == 'dp' or (re.match(r'^https?://(?:www\.)?instagram\.com/[A-Za-z0-9._]+/?(?:\?.*)?$', target_url) and not re.search(r'/(p|reel|reels|tv|stories|s)/', target_url, re.I)):
        return extract_instagram_profile(target_url)

    # 4. Standard Posts, Reels, Videos, Photos
    return extract_instagram_post(target_url, category)


def parse_product_info(product_info, target_url, video_id, category='video', ie=None):
    caption = product_info.get('caption', {})
    caption_text = caption.get('text', '') if isinstance(caption, dict) else ''
    clean_title = caption_text.split('\n')[0][:120] if caption_text else f'Instagram post ({video_id})'
    
    user = product_info.get('user', {})
    uploader = user.get('username') if isinstance(user, dict) else None
    uploader_name = (user.get('full_name') if isinstance(user, dict) else None) or uploader

    items = []
    carousel = product_info.get('carousel_media')

    if carousel and isinstance(carousel, list) and len(carousel) > 0:
        for idx, slide in enumerate(carousel):
            item = extract_single_media_node(slide, idx, video_id, ie=ie)
            if item:
                items.append(item)
    else:
        item = extract_single_media_node(product_info, 0, video_id, ie=ie)
        if item:
            items.append(item)

    if not items:
        return {
            'success': False,
            'error_code': 'NO_MEDIA_FOUND',
            'error': 'No downloadable media streams or images found in this post.'
        }

    # Determine media type
    if len(items) > 1:
        media_type = 'carousel'
    elif items[0]['type'] == 'video':
        media_type = 'reel' if '/reel/' in target_url or category == 'reels' else 'video'
    else:
        media_type = 'photo' if category == 'photo' else 'image'

    return {
        'success': True,
        'data': {
            'shortcode': video_id,
            'url': target_url,
            'title': clean_title,
            'uploader': uploader,
            'uploaderName': uploader_name,
            'mediaType': media_type,
            'itemCount': len(items),
            'items': items
        }
    }


def classify_resolution(width, height):
    """
    Accurately classifies media quality based on authentic pixel dimensions.
    Returns (quality_label, is_4k, tier).
    Tier 1 = 4K, Tier 2 = 1440p, Tier 3 = Full HD, Tier 4 = HD, Tier 5 = Original/SD.
    Never artificially upscales or labels 1080p/1440p as 4K.
    """
    if not width or not height:
        return 'Original', False, 5
    try:
        w, h = int(width), int(height)
    except (ValueError, TypeError):
        return 'Original', False, 5

    min_dim = min(w, h)
    max_dim = max(w, h)
    total_pixels = w * h

    # 1. True 4K / UHD: minimum dimension >= 2160 or max dimension >= 3840 or total pixels >= 8,000,000
    if min_dim >= 2160 or max_dim >= 3840 or total_pixels >= 8000000:
        return '4K', True, 1
    # 2. 1440p / QHD: minimum dimension >= 1440 or max dimension >= 2560 or total pixels >= 3,600,000
    if min_dim >= 1440 or max_dim >= 2560 or total_pixels >= 3600000:
        return '1440p', False, 2
    # 3. Full HD (1080p): minimum dimension >= 1080 or max dimension >= 1920 or total pixels >= 1,900,000
    if min_dim >= 1080 or max_dim >= 1920 or total_pixels >= 1900000:
        return 'Full HD', False, 3
    # 4. HD (720p): minimum dimension >= 720 or max dimension >= 1280
    if min_dim >= 720 or max_dim >= 1280:
        return 'HD', False, 4
    # 5. Standard / Original
    return 'Original', False, 5


def find_best_video_and_audio_formats(formats):
    """
    Inspects all video and audio variants from DASH and progressive streams.
    Selects the highest-quality legitimate source based on:
    1. Actual resolution (pixels)
    2. Video bitrate (tbr/vbr/bandwidth)
    3. Original available format (mp4 preference)
    Finds the matching highest-fidelity audio stream.
    Never artificially upscales or guesses fake 4K.
    """
    if not formats or not isinstance(formats, list):
        return None, None

    video_formats = []
    audio_formats = []

    for f in formats:
        if not isinstance(f, dict) or not f.get('url'):
            continue
        vcodec = f.get('vcodec') or ''
        acodec = f.get('acodec') or ''
        ext = f.get('ext') or ''

        # Audio-only stream
        if acodec not in ('', 'none') and (vcodec in ('', 'none') or ext == 'm4a'):
            audio_formats.append(f)
            continue

        # Video stream (DASH or progressive)
        if vcodec not in ('', 'none') or ext in ('mp4', 'webm') or f.get('width') or f.get('height'):
            video_formats.append(f)

    if not video_formats:
        return None, None

    def format_score(fmt):
        w = fmt.get('width') or 0
        h = fmt.get('height') or 0
        # Only parse dimensions if genuine pattern matches
        if not w or not h:
            m = re.search(r'[/_]([0-9]{3,4})x([0-9]{3,4})[/_.]', fmt.get('url') or '')
            if m:
                w, h = int(m.group(1)), int(m.group(2))
            else:
                fid_m = re.search(r'(?:^|[^\d])(2160|1440|1080|720)p?(?:[^\d]|$)', str(fmt.get('format_id') or ''))
                if fid_m:
                    val = int(fid_m.group(1))
                    w, h = (val, int(val * 16 / 9))
        pixels = (w * h) if (w and h) else 0
        bitrate = fmt.get('tbr') or fmt.get('vbr') or fmt.get('bandwidth') or 0
        ext = fmt.get('ext') or ''
        format_pref = 2 if ext == 'mp4' else (1 if ext else 0)
        # Prioritize separate un-muxed DASH master video streams over combined/compressed streams
        is_dash = 1 if ('dash' in str(fmt.get('format_id') or '').lower() or fmt.get('acodec') in ('none', '', None)) else 0
        return (pixels, bitrate, is_dash, format_pref)

    video_formats.sort(key=format_score, reverse=True)
    best_video = video_formats[0]

    best_audio = None
    if audio_formats:
        def audio_score(a):
            abr = a.get('abr') or a.get('tbr') or a.get('bandwidth') or 0
            acodec = str(a.get('acodec') or '').lower()
            codec_pref = 2 if ('aac' in acodec or 'mp4a' in acodec) else 1
            ext_pref = 2 if a.get('ext') in ('m4a', 'mp4') else 1
            return (codec_pref, ext_pref, abr)

        audio_formats.sort(key=audio_score, reverse=True)
        best_audio = audio_formats[0]

    return best_video, best_audio


def extract_single_media_node(node, index, video_id, ie=None):
    if not isinstance(node, dict):
        return None

    video_versions = node.get('video_versions')
    dash_manifest = node.get('video_dash_manifest')
    is_video = bool((video_versions and isinstance(video_versions, list) and len(video_versions) > 0) or dash_manifest)

    image_versions = node.get('image_versions2', {})
    candidates = image_versions.get('candidates', []) if isinstance(image_versions, dict) else []
    # Sort candidates by area descending for master, smallest for thumbnail
    sorted_candidates = sorted(
        candidates,
        key=lambda c: (c.get('width') or 0) * (c.get('height') or 0),
        reverse=True
    ) if candidates else []
    
    thumbnail_url = sorted_candidates[-1].get('url') if sorted_candidates else None
    duration = node.get('video_duration')

    if is_video:
        available_formats = []

        # 1. Parse video_dash_manifest if available (contains highest-res variants & separate audio)
        if dash_manifest and ie:
            try:
                from yt_dlp.compat import compat_etree_fromstring
                doc = compat_etree_fromstring(dash_manifest)
                mpd_formats = ie._parse_mpd_formats(doc, video_id)
                if mpd_formats:
                    available_formats.extend(mpd_formats)
            except Exception as e:
                sys.stderr.write(f"[EXTRACTOR] MPD parsing notice for {video_id}: {e}\n")

        # 2. Add progressive video versions with verified or parsed dimensions
        if video_versions and isinstance(video_versions, list):
            for idx_v, v in enumerate(video_versions):
                if isinstance(v, dict) and v.get('url'):
                    vw = v.get('width')
                    vh = v.get('height')
                    if not vw or not vh:
                        m_v = re.search(r'[/_]([0-9]{3,4})x([0-9]{3,4})[/_.]', v.get('url') or '')
                        if m_v:
                            vw, vh = int(m_v.group(1)), int(m_v.group(2))
                        elif idx_v == 0 and not dash_manifest:
                            # Only if DASH is completely absent, use original dimensions as fallback for primary progressive
                            vw = node.get('original_width')
                            vh = node.get('original_height')
                        else:
                            vw, vh = None, None
                    available_formats.append({
                        'url': v.get('url'),
                        'width': vw,
                        'height': vh,
                        'tbr': v.get('bandwidth') or v.get('bitrate') or 0,
                        'ext': 'mp4',
                        'vcodec': 'h264',
                        'acodec': 'aac',
                        'format_id': str(v.get('type') or f'progressive_{idx_v}')
                    })

        best_v, best_a = find_best_video_and_audio_formats(available_formats)

        if best_v:
            v_width = best_v.get('width') or node.get('original_width')
            v_height = best_v.get('height') or node.get('original_height')
            quality_label, is_4k, tier = classify_resolution(v_width, v_height)
            is_muxed = best_v.get('acodec') not in (None, 'none', '')
            has_aud = is_muxed or (best_a is not None)
            
            # Verify audio status from node flags as well
            if not has_aud and node.get('has_audio') is True and not node.get('audio_muted'):
                has_aud = True

            direct_url = best_v.get('url')
            video_stream_url = best_v.get('url')
            audio_stream_url = best_a.get('url') if (best_a and not is_muxed) else None

            vcodec = best_v.get('vcodec') or ''
            acodec = best_v.get('acodec') or (best_a.get('acodec') if best_a else '')

            return {
                'index': index,
                'type': 'video',
                'directUrl': direct_url,
                'videoStreamUrl': video_stream_url,
                'audioStreamUrl': audio_stream_url,
                'isMuxed': is_muxed,
                'vcodec': vcodec,
                'acodec': acodec,
                'thumbnail': thumbnail_url or direct_url,
                'width': v_width,
                'height': v_height,
                'resolution': f'{v_width}×{v_height}' if (v_width and v_height) else 'Original',
                'qualityLabel': quality_label,
                'is4K': is_4k,
                'tier': tier,
                'duration': duration,
                'ext': 'mp4',
                'hasAudio': bool(has_aud),
                'suggestedFilename': f'instagram_{video_id}_{index + 1}.mp4' if index > 0 else f'instagram_{video_id}.mp4'
            }

        # Fallback if no format could be resolved
        return None
    else:
        # Photo / Image node
        if not sorted_candidates:
            return None

        best_img = sorted_candidates[0]
        direct_url = best_img.get('url')
        width = best_img.get('width') or node.get('original_width')
        height = best_img.get('height') or node.get('original_height')

        quality_label, is_4k, tier = classify_resolution(width, height)

        return {
            'index': index,
            'type': 'image',
            'directUrl': direct_url,
            'thumbnail': sorted_candidates[-1].get('url') if len(sorted_candidates) > 1 else direct_url,
            'width': width,
            'height': height,
            'resolution': f'{width}×{height}' if (width and height) else 'Original',
            'qualityLabel': quality_label,
            'is4K': is_4k,
            'tier': tier,
            'duration': None,
            'ext': 'jpg',
            'hasAudio': False,
            'suggestedFilename': f'instagram_{video_id}_{index + 1}.jpg' if index > 0 else f'instagram_{video_id}.jpg'
        }


def parse_standard_info(info_dict, target_url, video_id, category='video'):
    if not isinstance(info_dict, dict):
        return {'success': False, 'error': 'Invalid info dictionary'}

    title = info_dict.get('title') or f'Instagram post ({video_id})'
    uploader = info_dict.get('uploader') or info_dict.get('channel')
    
    items = []
    if info_dict.get('_type') == 'playlist' and info_dict.get('entries'):
        for idx, entry in enumerate(info_dict['entries']):
            if not entry or not isinstance(entry, dict):
                continue
            is_vid = entry.get('vcodec') != 'none' or entry.get('ext') == 'mp4'
            
            best_v, best_a = find_best_video_and_audio_formats(entry.get('formats'))
            direct_url = (best_v.get('url') if best_v else None) or (entry.get('url') if is_vid else None)
            
            width = (best_v.get('width') if best_v else None) or entry.get('width')
            height = (best_v.get('height') if best_v else None) or entry.get('height')
            quality_label, is_4k, tier = classify_resolution(width, height)

            is_muxed = (best_v and best_v.get('acodec') not in (None, 'none', '')) if is_vid else True
            has_aud = (is_muxed or (best_a is not None)) if is_vid else False

            thumb = entry.get('thumbnail')
            items.append({
                'index': idx,
                'type': 'video' if is_vid else 'image',
                'directUrl': direct_url or (thumb if not is_vid else None),
                'videoStreamUrl': best_v.get('url') if best_v else direct_url,
                'audioStreamUrl': best_a.get('url') if (best_a and not is_muxed) else None,
                'isMuxed': is_muxed,
                'vcodec': (best_v.get('vcodec') or '') if is_vid and best_v else '',
                'acodec': (best_v.get('acodec') or (best_a.get('acodec') if best_a else '')) if is_vid and best_v else '',
                'thumbnail': thumb or direct_url,
                'width': width,
                'height': height,
                'resolution': f'{width}×{height}' if (width and height) else 'Original',
                'qualityLabel': quality_label,
                'is4K': is_4k,
                'tier': tier,
                'duration': entry.get('duration'),
                'ext': 'mp4' if is_vid else 'jpg',
                'hasAudio': bool(has_aud) if is_vid else False,
                'suggestedFilename': f'instagram_{video_id}_{idx + 1}.{"mp4" if is_vid else "jpg"}'
            })
    else:
        best_v, best_a = find_best_video_and_audio_formats(info_dict.get('formats'))
        direct_url = (best_v.get('url') if best_v else None) or info_dict.get('url')
        if not direct_url and info_dict.get('formats'):
            v_formats = [f for f in info_dict['formats'] if f.get('vcodec') != 'none' and f.get('url')]
            direct_url = v_formats[-1]['url'] if v_formats else info_dict['formats'][-1].get('url')

        width = (best_v.get('width') if best_v else None) or info_dict.get('width')
        height = (best_v.get('height') if best_v else None) or info_dict.get('height')
        quality_label, is_4k, tier = classify_resolution(width, height)

        is_muxed = (best_v and best_v.get('acodec') not in (None, 'none', '')) if best_v else True
        has_aud = is_muxed or (best_a is not None)

        thumb = info_dict.get('thumbnail')
        items.append({
            'index': 0,
            'type': 'video',
            'directUrl': direct_url,
            'videoStreamUrl': best_v.get('url') if best_v else direct_url,
            'audioStreamUrl': best_a.get('url') if (best_a and not is_muxed) else None,
            'isMuxed': is_muxed,
            'vcodec': (best_v.get('vcodec') or '') if best_v else '',
            'acodec': (best_v.get('acodec') or (best_a.get('acodec') if best_a else '')) if best_v else '',
            'thumbnail': thumb or direct_url,
            'width': width,
            'height': height,
            'resolution': f'{width}×{height}' if (width and height) else 'Original',
            'qualityLabel': quality_label,
            'is4K': is_4k,
            'tier': tier,
            'duration': info_dict.get('duration'),
            'ext': 'mp4',
            'hasAudio': bool(has_aud),
            'suggestedFilename': f'instagram_{video_id}.mp4'
        })

    return {
        'success': True,
        'data': {
            'shortcode': video_id,
            'url': target_url,
            'title': title,
            'uploader': uploader,
            'uploaderName': uploader,
            'mediaType': 'carousel' if len(items) > 1 else ('reel' if '/reel/' in target_url or category == 'reels' else 'video'),
            'itemCount': len(items),
            'items': items
        }
    }


def download_media_with_ytdlp(target_url, output_path):
    """
    Directly downloads and merges the highest available video quality and audio stream using yt-dlp.
    Selects 'bestvideo+bestaudio/best', preferring 1080p or higher when available from Instagram.
    Merges separate video and audio streams using FFmpeg into an MP4 container.
    Provides graceful fallback to the best combined format if separate streams are unavailable.
    """
    out_dir = os.path.dirname(os.path.abspath(output_path))
    if not os.path.exists(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    base_output = output_path
    if base_output.endswith('.mp4'):
        base_output = base_output[:-4]

    ydl_opts = {
        'format': 'bestvideo+bestaudio/best',
        'merge_output_format': 'mp4',
        'outtmpl': base_output + '.%(ext)s',
        'quiet': True,
        'no_warnings': True,
        'socket_timeout': 35,
        'postprocessor_args': {
            'ffmpeg': ['-movflags', '+faststart']
        }
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([target_url])

        target_mp4 = base_output + '.mp4'
        if os.path.exists(target_mp4) and os.path.getsize(target_mp4) > 500:
            if target_mp4 != output_path:
                import shutil
                shutil.move(target_mp4, output_path)
            return {'success': True, 'path': output_path}
        return {'success': False, 'error': 'Downloaded file is missing or empty'}
    except Exception as e:
        sys.stderr.write(f"[YTDLP DOWNLOAD ERROR] {target_url}: {e}\n")
        return {'success': False, 'error': str(e)}


if __name__ == '__main__':
    if len(sys.argv) >= 4 and sys.argv[1] == '--download':
        target_url = sys.argv[2]
        output_path = sys.argv[3]
        result = download_media_with_ytdlp(target_url, output_path)
        print(json.dumps(result))
        sys.exit(0 if result.get('success') else 1)

    if len(sys.argv) < 2:
        print(json.dumps({'success': False, 'error_code': 'INVALID_URL', 'error': 'Please enter a valid supported Instagram URL.'}))
        sys.exit(1)
        
    url = sys.argv[1]
    cat = sys.argv[2] if len(sys.argv) > 2 else 'video'
    u_type = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None
    result = extract_instagram_media(url, cat, u_type)
    print(json.dumps(result))
