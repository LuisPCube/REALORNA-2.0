#!/usr/bin/env python3
"""Bounded public-post downloader and local FFmpeg preparation.
JSON-lines on stdout are the only protocol; never print extractor errors/URLs.
Run in a new temporary directory per check. No cookies or account credentials.
"""
import contextlib
import datetime
from bisect import bisect_left
import ipaddress
import json
import logging
import math
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
from urllib.parse import urlsplit, urlunsplit, parse_qs

MAX_ITEMS = 20
MAX_VIDEOS = 3
MAX_SECONDS = 300
MAX_BYTES = 80_000_000
MAX_TOTAL_BYTES = 150_000_000
MAX_FRAMES = 24
TIME_LIMIT = 100
START = time.monotonic()

class MediaError(Exception):
    def __init__(self, code="media_unavailable", reason=None):
        self.code = code
        self.reason = reason
        super().__init__(code)

def emit(**data):
    print(json.dumps(data, ensure_ascii=False), flush=True)

def stage(name):
    emit(stage=name)

def remaining():
    value = TIME_LIMIT - (time.monotonic() - START)
    if value <= 0:
        raise MediaError("media_timeout")
    return value

def public_address(raw):
    try:
        value = ipaddress.ip_address(raw.split("%", 1)[0])
        if getattr(value, "ipv4_mapped", None):
            value = value.ipv4_mapped
        return value.is_global
    except ValueError:
        return False

def validate_remote(url, resolve=True):
    u = urlsplit(url)
    if u.scheme not in ("https", "http") or not u.hostname or u.username or u.password or u.port not in (None, 80, 443):
        raise MediaError("media_unavailable")
    host = u.hostname.lower()
    if host in ("localhost", "metadata.google.internal") or "." not in host or host.endswith((".local", ".internal", ".localhost")):
        raise MediaError("media_unavailable")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        if not public_address(host):
            raise MediaError("media_unavailable")
    if resolve:
        infos = socket.getaddrinfo(host, u.port or (443 if u.scheme == "https" else 80), type=socket.SOCK_STREAM)
        if not infos or any(not public_address(i[4][0]) for i in infos):
            raise MediaError("media_unavailable")
    return url

def canonical_url(raw):
    validate_remote(raw, resolve=False)
    u = urlsplit(raw)
    h, p = u.hostname.lower().removeprefix("www."), u.path.rstrip("/")
    if h in ("m.youtube.com", "music.youtube.com"):
        h = "youtube.com"
    if h == "youtu.be" and re.fullmatch(r"/[\w-]{11}", p):
        return "youtube", "https://www.youtube.com/watch?v=" + p[1:]
    if h == "youtube.com":
        vid = parse_qs(u.query).get("v", [""])[0] if p == "/watch" else p.split("/")[-1] if re.match(r"^/(shorts|embed)/", p) else ""
        if re.fullmatch(r"[\w-]{11}", vid):
            return "youtube", "https://www.youtube.com/watch?v=" + vid
    if h in ("instagram.com", "instagr.am") and re.fullmatch(r"/(p|reel|reels|tv)/[A-Za-z0-9_-]+", p):
        return "instagram", "https://www.instagram.com" + p + "/"
    if h in ("x.com", "twitter.com", "mobile.twitter.com", "m.twitter.com") and re.fullmatch(r"/[\w]+/status/\d+(?:/(?:photo|video)/\d+)?", p):
        return "twitter", "https://x.com" + re.sub(r"/(photo|video)/\d+$", "", p)
    if h in ("tiktok.com", "m.tiktok.com") and re.fullmatch(r"/@[\w.-]+/(video|photo)/\d+", p):
        return "tiktok", "https://www.tiktok.com" + p
    if h in ("vm.tiktok.com", "vt.tiktok.com") and re.fullmatch(r"/[A-Za-z0-9]+", p):
        return "tiktok", "https://" + h + p + "/"
    if h == "tiktok.com" and re.fullmatch(r"/t/[A-Za-z0-9]+", p):
        return "tiktok", "https://www.tiktok.com" + p + "/"
    if h in ("facebook.com", "m.facebook.com", "web.facebook.com"):
        if re.fullmatch(r"/(?:reel/\d+|[^/]+/videos/(?:[^/]+/)?\d+|share/[rv]/[A-Za-z0-9]+)", p):
            return "facebook", "https://www.facebook.com" + p + "/"
        vid = parse_qs(u.query).get("v", [""])[0]
        if p == "/watch" and vid.isdigit():
            return "facebook", "https://www.facebook.com/watch/?v=" + vid
    if h == "fb.watch" and re.fullmatch(r"/[A-Za-z0-9_-]+", p):
        return "facebook", "https://fb.watch" + p + "/"
    raise MediaError("media_unsupported")

def install_network_guard():
    # All DNS answers must be public. Guard actual connects too, including
    # downloader redirects. A configured operator proxy may be private, but
    # target URLs still pass the public-host checks below.
    original_dns = socket.getaddrinfo
    proxy_addresses = set()
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        if not os.environ.get(key):
            continue
        u = urlsplit(os.environ[key])
        if u.hostname and u.port:
            try:
                proxy_addresses.update((i[4][0], u.port) for i in original_dns(u.hostname, u.port, type=socket.SOCK_STREAM))
            except OSError:
                pass
    def guarded_dns(host, port, *args, **kwargs):
        infos = original_dns(host, port, *args, **kwargs)
        for info in infos:
            if not public_address(info[4][0]) and (info[4][0], int(port or 0)) not in proxy_addresses:
                raise MediaError()
        return infos
    socket.getaddrinfo = guarded_dns
    def audit(event, args):
        if event == "socket.connect":
            address = args[1]
            if isinstance(address, tuple):
                host, port = address[:2]
                if not public_address(str(host)) and (host, port) not in proxy_addresses:
                    raise MediaError()
    sys.addaudithook(audit)
    import requests
    request = requests.sessions.Session.request
    def checked_request(self, method, url, *args, **kwargs):
        validate_remote(url)
        return request(self, method, url, *args, **kwargs)
    requests.sessions.Session.request = checked_request
    send = requests.sessions.Session.send
    def checked_send(self, request, *args, **kwargs):
        validate_remote(request.url)
        return send(self, request, *args, **kwargs)
    requests.sessions.Session.send = checked_send
    import yt_dlp
    urlopen = yt_dlp.YoutubeDL.urlopen
    def checked_open(self, request):
        validate_remote(request if isinstance(request, str) else request.url)
        return urlopen(self, request)
    yt_dlp.YoutubeDL.urlopen = checked_open

class QuietLogger:
    def debug(self, *args): pass
    def warning(self, *args): pass
    def error(self, *args): pass

def command(args, limit=30):
    try:
        proc = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True,
                              timeout=min(limit, remaining()), check=False)
    except subprocess.TimeoutExpired:
        raise MediaError("media_timeout") from None
    if proc.returncode:
        raise MediaError("media_partial")
    return proc.stdout

def probe(path):
    data = json.loads(command(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-show_format", "-of", "json", str(path)], 10))
    return data

def date_text(value):
    if isinstance(value, datetime.datetime):
        return value.isoformat()
    return str(value or "")[:80]

def gallery_manifest(url, platform):
    from gallery_dl import config, extractor
    from gallery_dl.extractor.message import Message
    config.clear()
    config.set(("extractor",), "retries", 0)
    config.set(("extractor",), "timeout", 10)
    config.set(("extractor",), "sleep-request", 0)
    config.set(("extractor", "instagram"), "videos", "merged")
    config.set(("extractor", "instagram"), "previews", False)
    config.set(("extractor", "instagram"), "audio", False)
    config.set(("extractor", "twitter"), "quoted", False)
    config.set(("extractor", "twitter"), "retweets", False)
    config.set(("extractor", "twitter"), "videos", True)
    if platform == "instagram":
        # gallery-dl otherwise sets count AFTER skipping malformed slide data.
        # Validate the original platform collection before that transformation.
        from gallery_dl.extractor.instagram import InstagramExtractor
        original_parse = InstagramExtractor._parse_post
        def checked_parse(self, post):
            original_items = post.get("carousel_media")
            expected = int(post.get("carousel_media_count") or len(original_items or []) or 1)
            if original_items is not None and len(original_items) != expected:
                raise MediaError("media_partial")
            parsed = original_parse(self, post)
            if len(parsed.get("_files", [])) != expected:
                raise MediaError("media_partial")
            return parsed
        InstagramExtractor._parse_post = checked_parse
    ext = extractor.find(url)
    if ext is None or ext.category not in (platform, "twitter") or ext.subcategory not in ("post", "tweet", "vmpost"):
        raise MediaError("media_unsupported")
    entries, meta = [], {}
    # Do not follow profile feeds, quoted posts, arbitrary queued extractors.
    for message in ext:
        remaining()
        if message[0] == Message.Directory:
            if entries:
                raise MediaError("media_partial")
            meta = message[-1]
        elif message[0] == Message.Url:
            info = message[-1]
            remote = message[1]
            if remote.startswith("ytdl:"):
                remote = info.get("video_url") or info.get("_fallback", [None])[0]
            if not remote:
                raise MediaError("media_partial")
            entries.append({"url": remote, "info": info})
            if len(entries) > MAX_ITEMS:
                raise MediaError("media_limit")
        elif message[0] == Message.Queue:
            raise MediaError("media_partial")
    if not entries:
        raise MediaError()
    expected = int(meta.get("count") or entries[0]["info"].get("count") or 0)
    if not expected or expected != len(entries):
        raise MediaError("media_partial")
    if any(e["info"].get("user", {}).get("is_private") for e in entries):
        raise MediaError()
    # Never silently drop/reorder a missing slide. Native indices are 1-based.
    indices = [int(e["info"].get("num") or n) for n, e in enumerate(entries, 1)]
    if indices != list(range(1, expected + 1)):
        raise MediaError("media_partial")
    info = entries[0]["info"]
    caption = str(info.get("description") or info.get("content") or "")
    if len(caption) > 32000:
        raise MediaError("media_limit")
    author = info.get("user") or info.get("author") or {}
    if isinstance(author, dict):
        author = author.get("username") or author.get("name") or author.get("nick") or ""
    return entries, {"caption": caption, "title": caption[:220], "author": str(author or info.get("username") or info.get("fullname") or "")[:160],
                     "published_at": date_text(info.get("date")), "expected_items": expected}

def twitter_guest_manifest(url):
    # Fallback using yt-dlp's pinned GraphQL extractor. Syndication explicitly
    # omits media/metadata, so it is rejected instead of silently accepted.
    import yt_dlp
    from yt_dlp.extractor.twitter import TwitterIE
    class CompleteTwitterIE(TwitterIE):
        def _call_syndication_api(self, twid):
            raise MediaError("media_partial")
    with yt_dlp.YoutubeDL({"quiet": True, "logger": QuietLogger(), "socket_timeout": 8, "retries": 0,
                           "extractor_args": {"twitter": {"api": ["graphql"]}}}) as ydl:
        ext = CompleteTwitterIE(ydl)
        ext.initialize()
        status = ext._extract_status(re.search(r"/status/(\d+)", url)[1])
    if status.get("truncated") or not status.get("full_text"):
        raise MediaError("media_partial")
    raw = status.get("extended_entities", {}).get("media") or []
    if not raw or len(raw) > MAX_ITEMS:
        raise MediaError("media_unavailable" if not raw else "media_limit")
    entries = []
    for n, item in enumerate(raw, 1):
        if item.get("type") == "photo":
            remote = item.get("media_url_https")
            if remote:
                remote += "?name=orig"
        elif item.get("type") in ("video", "animated_gif"):
            variants = [v for v in item.get("video_info", {}).get("variants", []) if v.get("content_type") == "video/mp4" and v.get("url")]
            if not variants:
                raise MediaError("media_partial")
            bounded = [v for v in variants if v.get("bitrate", 0) <= 3_000_000]
            remote = max(bounded or variants, key=lambda v: v.get("bitrate", 0))["url"]
        else:
            raise MediaError("media_partial")
        if not remote:
            raise MediaError("media_partial")
        entries.append({"url": remote, "info": {"num": n}})
    caption = status["full_text"]
    if len(caption) > 32000:
        raise MediaError("media_limit")
    return entries, {"title": caption[:220], "caption": caption, "author": str(status.get("user", {}).get("screen_name") or "")[:160],
                     "published_at": str(status.get("created_at") or "")[:80], "expected_items": len(entries)}

def fetch_gallery(entries, folder):
    import requests
    total = 0
    paths = []
    for n, entry in enumerate(entries, 1):
        remaining()
        validate_remote(entry["url"])
        path = folder / f"source-{n:02d}.bin"
        # Only fixed headers; never accept arbitrary extractor Authorization.
        with requests.get(entry["url"], headers={"User-Agent": "Mozilla/5.0"}, stream=True, timeout=(5, 10)) as response:
            if not response.ok:
                raise MediaError("media_partial")
            size = 0
            with path.open("wb") as target:
                for chunk in response.iter_content(64 * 1024):
                    remaining()
                    size += len(chunk)
                    total += len(chunk)
                    if size > MAX_BYTES or total > MAX_TOTAL_BYTES:
                        raise MediaError("media_limit")
                    target.write(chunk)
        if size < 64:
            raise MediaError("media_partial")
        paths.append(path)
    return paths

def ytdlp_failure(error, phase):
    from yt_dlp.networking.exceptions import HTTPError, TransportError
    from yt_dlp.utils import DownloadError, ExtractorError, GeoRestrictedError

    if isinstance(error, DownloadError) and error.exc_info and error.exc_info[1]:
        error = error.exc_info[1]
    if isinstance(error, GeoRestrictedError):
        return MediaError(reason="platform_region_restricted")
    if isinstance(error, ExtractorError):
        if error.orig_msg.startswith("The webpage request was redirected to the login page"):
            return MediaError(reason="platform_login_required")
        if error.orig_msg.startswith("Instagram sent an empty media response"):
            return MediaError(reason="platform_empty_media")
        if error.orig_msg.startswith(("Requested format is not available", "No video formats found", "There is no video in this post")):
            return MediaError(reason="platform_no_playable_formats")
        error = error.cause or error
    if isinstance(error, HTTPError) and 400 <= error.status < 600:
        return MediaError(reason=f"{phase}_http_{error.status}")
    if isinstance(error, (TransportError, socket.gaierror)):
        return MediaError(reason=f"{phase}_network")
    return MediaError(reason=f"{phase}_failed")

def ytdlp_download(url, folder):
    import yt_dlp
    from yt_dlp.networking.exceptions import RequestError
    from yt_dlp.utils import YoutubeDLError

    downloaded = []
    total = [0]
    def progress(data):
        remaining()
        if data.get("downloaded_bytes", 0) > MAX_BYTES:
            raise MediaError("media_limit")
    options = {
        "quiet": True, "no_warnings": True, "logger": QuietLogger(),
        "noplaylist": True, "extract_flat": False, "ignoreerrors": False,
        "socket_timeout": 10, "retries": 1, "fragment_retries": 1,
        "skip_unavailable_fragments": False,
        "concurrent_fragment_downloads": 1,
        "js_runtimes": {"node": {}},
        "format": "bv*[height<=720]+ba/b[height<=720]/b",
        "merge_output_format": "mp4",
        "postprocessor_args": {"ffmpeg_i": ["-protocol_whitelist", "file,pipe"]},
        "outtmpl": str(folder / "source-%(autonumber)02d.%(ext)s"),
        "max_filesize": MAX_BYTES,
        "progress_hooks": [progress], "cachedir": False,
        # Prevent FFmpeg subprocesses fetching network URLs. Native HTTP/HLS/DASH only.
        "hls_prefer_native": True, "external_downloader": {"default": "native"},
        "overwrites": False, "writethumbnail": False,
    }
    with yt_dlp.YoutubeDL(options) as ydl:
        try:
            info = ydl.extract_info(url, download=False)
        except (YoutubeDLError, RequestError, socket.gaierror) as error:
            raise ytdlp_failure(error, "extractor") from error
        if not info:
            raise MediaError(reason="platform_empty_media")
        raw = list(info.get("entries") or [info])
        if not raw or len(raw) > MAX_VIDEOS:
            raise MediaError("media_limit")
        if info.get("playlist_count") and int(info["playlist_count"]) != len(raw):
            raise MediaError("media_partial")
        for item in raw:
            if not item or item.get("is_live") or item.get("live_status") in ("is_live", "is_upcoming", "post_live"):
                raise MediaError("media_limit")
            if item.get("availability") in ("private", "premium_only", "subscriber_only", "needs_auth"):
                raise MediaError(reason="platform_access_restricted")
            # Public video metadata can omit duration; prepare() verifies the file with ffprobe.
            duration = float(item.get("duration") or 0)
            if not 0 <= duration <= MAX_SECONDS:
                raise MediaError("media_limit")
            if item.get("ext") in ("mhtml", "html"):
                raise MediaError("media_partial")
            for selected in item.get("requested_formats") or [item]:
                protocol = str(selected.get("protocol") or "")
                if not re.fullmatch(r"https?|m3u8_native|http_dash_segments", protocol):
                    raise MediaError("media_partial")
            # A format with separate silent video would omit speech: fail closed.
            if not item.get("requested_formats") and item.get("acodec") == "none" and any(f.get("acodec") not in (None, "none") for f in item.get("formats", [])):
                raise MediaError("media_partial")
            for f in item.get("requested_formats") or [item]:
                validate_remote(f.get("url", ""))
            try:
                ydl.process_info(item)
            except (YoutubeDLError, RequestError, socket.gaierror) as error:
                raise ytdlp_failure(error, "download") from error
            filename = item.get("filepath") or item.get("_filename") or ydl.prepare_filename(item)
            path = Path(filename).resolve()
            if not path.is_relative_to(folder.resolve()):
                raise MediaError("media_partial")
            if not path.is_file() or path.stat().st_size > MAX_BYTES:
                raise MediaError("media_partial")
            total[0] += path.stat().st_size
            if total[0] > MAX_TOTAL_BYTES:
                raise MediaError("media_limit")
            downloaded.append(path)
    caption = str(info.get("description") or "")
    if len(caption) > 32000:
        raise MediaError("media_limit")
    return downloaded, {"title": str(info.get("title") or "")[:220], "caption": caption,
                        "author": str(info.get("uploader") or info.get("channel") or "")[:160],
                        "published_at": date_text(info.get("upload_date")), "expected_items": len(downloaded)}

def jpeg(source, target):
    command(["ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", str(source),
             "-frames:v", "1", "-vf", "scale=1600:1600:force_original_aspect_ratio=decrease", "-q:v", "3", "-threads", "1", str(target)], 12)
    if not target.is_file() or not 64 <= target.stat().st_size <= 1_800_000:
        raise MediaError("media_partial")

def frame_times(timestamps, changes=(), budget=12):
    if len(timestamps) < 2:
        return timestamps
    first, last = timestamps[0], timestamps[-1]
    count = min(budget, max(2, math.ceil((last - first) / 12)))
    step = (last - first) / (count - 1)
    uniform = {timestamps[bisect_left(timestamps, first + i * step)] for i in range(count - 1)}
    uniform.add(last)
    extra = [t for t in changes if first < t < last and all(abs(t - x) > 0.35 for x in uniform)]
    slots = budget - len(uniform)
    if len(extra) > slots:
        extra = [extra[i * len(extra) // slots] for i in range(slots)]
    return sorted(uniform.union(extra))

def prepare(paths, folder):
    results, audio, video_count, duration_total = [], [], 0, 0.0
    probes = [probe(path) for path in paths]
    counts = [any(s.get("codec_type") == "video" and s.get("codec_name") not in ("mjpeg", "png", "webp", "gif", "bmp") for s in p.get("streams", [])) for p in probes]
    video_count = sum(counts)
    if video_count > MAX_VIDEOS:
        raise MediaError("media_limit")
    # Each image gets one input; distribute the remaining frame budget evenly.
    frame_budget = min(16, (MAX_FRAMES - (len(paths) - video_count)) // max(1, video_count))
    for n, (path, info, is_video) in enumerate(zip(paths, probes, counts), 1):
        streams = info.get("streams", [])
        visuals = [s for s in streams if s.get("codec_type") == "video"]
        if not visuals:
            raise MediaError("media_partial")
        if any(int(s.get("width") or 0) * int(s.get("height") or 0) > 40_000_000 for s in visuals):
            raise MediaError("media_limit")
        if not is_video:
            if any(int(v.get("nb_frames") or 1) > 1 for v in visuals) or any(v.get("codec_name") == "gif" for v in visuals):
                raise MediaError("media_partial")
            target = folder / f"image-{n:02d}.jpg"
            jpeg(path, target)
            results.append({"path": target.name, "item": n, "type": "slide"})
            continue
        duration = float(info.get("format", {}).get("duration") or 0)
        duration_total += duration
        if not 0 < duration <= MAX_SECONDS or duration_total > MAX_SECONDS or frame_budget < 2:
            raise MediaError("media_limit")
        if any(s.get("codec_type") == "audio" for s in streams):
            target = folder / f"audio-{n:02d}.mp3"
            command(["ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", str(path),
                     "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", "-threads", "1", str(target)], 25)
            if not target.is_file() or target.stat().st_size > 6_000_000:
                raise MediaError("media_limit")
            audio.append({"path": target.name, "item": n, "duration": round(duration, 2)})
        # Measure the picture timeline during scene detection. The container may
        # run longer than the picture, and variable-rate video may have gaps.
        scan = command(["ffmpeg", "-nostdin", "-v", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-i", str(path),
                        "-map", "0:V:0", "-an", "-vf", "scale=320:-2,select='gte(scene,0)',metadata=print:key=lavfi.scene_score:file=-",
                        "-vsync", "vfr", "-f", "null", "-"], 25)
        scores = [
            (float(pts), float(score))
            for pts, score in re.findall(rb"pts_time:([0-9.eE+-]+)\r?\nlavfi\.scene_score=([0-9.]+)", scan)
        ]
        timestamps = sorted({pts for pts, _ in scores if 0 <= pts <= duration})
        if not timestamps:
            raise MediaError("media_partial")
        changes = [pts for pts, score in scores if score > 0.32]
        for j, timestamp in enumerate(frame_times(timestamps, changes, frame_budget), 1):
            target = folder / f"frame-{n:02d}-{j:02d}.jpg"
            # FFmpeg rounds printed timestamps. Seek slightly before the frame.
            seek = f"{max(0, timestamp - 0.001):.6f}"
            command(["ffmpeg", "-nostdin", "-v", "error", "-ss", seek, "-protocol_whitelist", "file,pipe", "-i", str(path), "-map", "0:V:0",
                     "-frames:v", "1", "-vf", "scale=1600:1600:force_original_aspect_ratio=decrease", "-q:v", "3", "-threads", "1", str(target)], 10)
            if not target.is_file() or not 64 <= target.stat().st_size <= 1_800_000:
                raise MediaError("media_partial")
            results.append({"path": target.name, "item": n, "type": "frame", "timestamp": timestamp})
    if not results or len(results) > MAX_FRAMES:
        raise MediaError("media_partial")
    return {"images": results, "audio": audio, "items": len(paths), "videos": video_count,
            "duration_seconds": round(duration_total, 2), "complete": True}

def main():
    global TIME_LIMIT, START
    data = json.load(sys.stdin)
    TIME_LIMIT = max(10, min(100, float(data.get("timeout_seconds", 100))))
    START = time.monotonic()
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(MediaError("media_timeout")))
    signal.alarm(math.ceil(TIME_LIMIT))
    import yt_dlp, gallery_dl  # noqa: F401 -- preflight checks installation
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe") or not shutil.which("node"):
        raise MediaError("media_setup")
    if data.get("action") == "health":
        emit(ok=True)
        return
    folder = Path(data["workdir"]).resolve(strict=True)
    if not folder.is_dir():
        raise MediaError("media_setup")
    platform, url = canonical_url(data["url"])
    logging.disable(logging.CRITICAL)
    install_network_guard()
    stage("downloading")
    # Instagram posts MUST use a collection extractor: a reel or a single
    # og:image fallback can silently discard the rest of a carousel.
    if platform == "twitter":
        try:
            entries, meta = gallery_manifest(url, platform)
        except MediaError as error:
            if error.code != "media_unavailable":
                raise
            remaining()
            entries, meta = twitter_guest_manifest(url)
        except Exception:
            remaining()
            entries, meta = twitter_guest_manifest(url)
        paths = fetch_gallery(entries, folder)
    elif platform == "instagram" and "/p/" in url or platform == "tiktok" and "/photo/" in url:
        entries, meta = gallery_manifest(url, platform)
        paths = fetch_gallery(entries, folder)
    else:
        paths, meta = ytdlp_download(url, folder)
    if len(paths) != meta["expected_items"]:
        raise MediaError("media_partial")
    stage("preparing_media")
    result = prepare(paths, folder)
    emit(ok=True, platform=platform, url=url, **meta, **result)

if __name__ == "__main__":
    try:
        main()
    except MediaError as error:
        emit(ok=False, error=error.code, reason=error.reason)
        sys.exit(2)
    except ModuleNotFoundError:
        emit(ok=False, error="media_setup")
        sys.exit(2)
    except Exception:
        emit(ok=False, error="media_unavailable")
        sys.exit(2)
