"""Offline fixtures exercise real FFmpeg; no platform/API success is implied."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("media_job", Path(__file__).with_name("media_job.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class MediaTests(unittest.TestCase):
    def setUp(self):
        m.START = time.monotonic()
        m.TIME_LIMIT = 100
    def test_platform_normalization_and_video_suffix(self):
        cases = {
            "https://youtu.be/jNQXAC9IVRw?list=ignored": ("youtube", "https://www.youtube.com/watch?v=jNQXAC9IVRw"),
            "https://m.youtube.com/shorts/jNQXAC9IVRw": ("youtube", "https://www.youtube.com/watch?v=jNQXAC9IVRw"),
            "https://instagram.com/p/Example123/?img_index=2": ("instagram", "https://www.instagram.com/p/Example123/"),
            "https://twitter.com/fixture/status/123/video/1": ("twitter", "https://x.com/fixture/status/123"),
            "https://www.tiktok.com/@fixture/photo/123": ("tiktok", "https://www.tiktok.com/@fixture/photo/123"),
            "https://vm.tiktok.com/ABC123/": ("tiktok", "https://vm.tiktok.com/ABC123/"),
            "https://www.facebook.com/watch/?v=123": ("facebook", "https://www.facebook.com/watch/?v=123"),
            "https://www.facebook.com/fixture/videos/123/": ("facebook", "https://www.facebook.com/fixture/videos/123/"),
        }
        for url, expected in cases.items():
            with self.subTest(url=url): self.assertEqual(m.canonical_url(url), expected)
    def test_profiles_playlists_credentials_and_private_addresses_rejected(self):
        for url in ["file:///etc/passwd", "https://127.0.0.1/post", "https://[::1]/", "https://169.254.169.254/", "https://user:password@instagram.com/p/ABC/", "https://instagram.com/fixture", "https://www.youtube.com/playlist?list=ABC", "https://instagram.com.evil.com/p/ABC/", "https://youtube.com:8080/watch?v=jNQXAC9IVRw"]:
            with self.subTest(url=url), self.assertRaises(m.MediaError): m.canonical_url(url)
        for ip in ["127.0.0.1", "169.254.169.254", "10.0.0.1", "::1", "::ffff:127.0.0.1", "fe80::1", "192.168.1.1"]:
            self.assertFalse(m.public_address(ip))
    def test_dns_answers_cannot_mix_private_addresses(self):
        with patch.object(m.socket, "getaddrinfo", return_value=[(2, 1, 6, "", ("127.0.0.1", 443))]):
            with self.assertRaises(m.MediaError): m.validate_remote("https://example.com/media")
    def test_uniform_and_scene_frames_cover_both_ends(self):
        times = m.frame_times(120, [1.1, 4.1, 70.2, 99.8], 16)
        self.assertEqual(times[0], 0)
        self.assertAlmostEqual(times[-1], 119.9)
        self.assertIn(70.2, times)
        self.assertLessEqual(len(times), 16)
        self.assertEqual(times, sorted(set(times)))
    def fake_gallery(self, count, actual, indices=None, queue=False):
        from gallery_dl import extractor
        from gallery_dl.extractor.message import Message
        class Fake:
            category = "twitter"
            subcategory = "tweet"
            def __iter__(self):
                yield Message.Directory, "", {"count": count}
                for i in range(actual):
                    yield Message.Url, f"https://pbs.twimg.com/fixture-{i}.jpg", {"count": count, "num": indices[i] if indices else i + 1, "description": "Fixture caption"}
                if queue: yield Message.Queue, "https://example.com/other", {}
        with patch.object(extractor, "find", return_value=Fake()):
            return m.gallery_manifest("https://x.com/fixture/status/123", "twitter")
    def test_carousel_order_and_caption_are_preserved(self):
        entries, meta = self.fake_gallery(3, 3)
        self.assertEqual([e["info"]["num"] for e in entries], [1, 2, 3])
        self.assertEqual(meta["expected_items"], 3)
        self.assertEqual(meta["caption"], "Fixture caption")
    def test_missing_last_slide_reordered_slides_and_queued_posts_fail_closed(self):
        for options in [(3, 2, None, False), (3, 3, [1, 3, 2], False), (1, 1, None, True), (21, 21, None, False)]:
            with self.subTest(options=options), self.assertRaises(m.MediaError): self.fake_gallery(*options)
    def test_real_ffmpeg_audio_frames_and_two_slides(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            video = root / "synthetic.mp4"
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "mpeg4", "-c:a", "aac", "-threads", "1", str(video)], check=True)
            for i in (1, 2):
                subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", f"color=c={'red' if i == 1 else 'blue'}:s=640x480", "-frames:v", "1", "-threads", "1", str(root/f"slide{i}.jpg")], check=True)
            result = m.prepare([root/"slide1.jpg", video, root/"slide2.jpg"], root)
            self.assertTrue(result["complete"])
            self.assertEqual(result["items"], 3)
            self.assertEqual(result["videos"], 1)
            self.assertEqual(len(result["audio"]), 1)
            self.assertEqual(result["audio"][0]["item"], 2)
            self.assertEqual({i["item"] for i in result["images"]}, {1, 2, 3})
            self.assertGreaterEqual(len([i for i in result["images"] if i["type"] == "frame"]), 2)
            for image in result["images"]:
                self.assertTrue((root/image["path"]).read_bytes().startswith(b"\xff\xd8"))
            self.assertGreater((root/result["audio"][0]["path"]).stat().st_size, 1000)
    def test_video_limit_rejects_instead_of_truncating(self):
        with tempfile.TemporaryDirectory() as temp:
            fake = {"streams": [{"codec_type": "video", "codec_name": "h264", "width": 320, "height": 240}], "format": {"duration": "301"}}
            with patch.object(m, "probe", return_value=fake), self.assertRaisesRegex(m.MediaError, "media_limit"):
                m.prepare([Path(temp)/"unused.mp4"], Path(temp))
    def test_real_ytdlp_downloads_and_merges_separate_audio_video(self):
        import yt_dlp
        from yt_dlp.networking.common import Response
        import io
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            video = root/"fixture-video.mp4"
            audio = root/"fixture-audio.mp3"
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10:duration=1", "-an", "-c:v", "mpeg4", "-threads", "1", str(video)], check=True)
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-b:a", "48k", str(audio)], check=True)
            fixtures = {"https://fixture.example/video.mp4": video.read_bytes(), "https://fixture.example/audio.mp3": audio.read_bytes()}
            class OfflineYDL(yt_dlp.YoutubeDL):
                def extract_info(self, url, download=False, **kwargs):
                    return self.process_ie_result({"id": "fixture", "title": "Synthetic", "duration": 1, "description": "Offline download fixture", "formats": [
                        {"format_id": "v", "url": "https://fixture.example/video.mp4", "ext": "mp4", "vcodec": "mpeg4", "acodec": "none", "height": 240, "protocol": "https"},
                        {"format_id": "a", "url": "https://fixture.example/audio.mp3", "ext": "mp3", "vcodec": "none", "acodec": "mp3", "protocol": "https"},
                    ]}, download=download)
                def urlopen(self, request):
                    url = request if isinstance(request, str) else request.url
                    blob = fixtures[url]
                    return Response(io.BytesIO(blob), url, {"Content-Length": str(len(blob))}, 200)
            with patch.object(yt_dlp, "YoutubeDL", OfflineYDL), patch.object(m, "validate_remote", side_effect=lambda url: url):
                paths, meta = m.ytdlp_download("https://www.youtube.com/watch?v=jNQXAC9IVRw", root)
            self.assertEqual(len(paths), 1)
            self.assertTrue(paths[0].is_file())
            streams = m.probe(paths[0])["streams"]
            self.assertIn("audio", [stream["codec_type"] for stream in streams])
            self.assertIn("video", [stream["codec_type"] for stream in streams])
            self.assertEqual(meta["caption"], "Offline download fixture")

    def test_untrusted_media_cannot_make_ffmpeg_fetch_a_remote_playlist(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp)/"fake.mp4"
            source.write_text('#EXTM3U\n#EXTINF:3,\nhttp://127.0.0.1:9/private.ts\n')
            with self.assertRaises(m.MediaError): m.probe(source)

if __name__ == "__main__": unittest.main(verbosity=2)
