from app.media import audio_options, build_response, display_res, video_options


def fmt(fid, w=None, h=None, vcodec="avc1.640028", acodec="none", tbr=1000, **kw):
    return {"format_id": fid, "width": w, "height": h, "vcodec": vcodec, "acodec": acodec, "tbr": tbr, "protocol": "https", "ext": "mp4", **kw}


def test_display_res():
    assert display_res(1920, 1080) == 1080
    assert display_res(1920, 804) == 1080      # cinematic
    assert display_res(1080, 1920) == 1080     # portrait
    assert display_res(728, 720) == 720
    assert display_res(None, 480) == 480


def test_video_options_groups_and_labels():
    info = {
        "duration": 100,
        "formats": [
            fmt("sb0", 48, 27, vcodec="none", acodec="none", format_note="storyboard"),
            fmt("140", vcodec="none", acodec="mp4a.40.2", abr=128, tbr=128),
            fmt("137", 1920, 1080, fps=30, tbr=4000),
            fmt("248", 1920, 1080, vcodec="vp9", fps=30, tbr=3000),
            fmt("299", 1920, 1080, fps=60, tbr=6000),
            fmt("136", 1280, 720, fps=30, tbr=2000),
            fmt("401", 3840, 2160, vcodec="av01.0.12M.10", fps=60, tbr=20000, dynamic_range="HDR10"),
        ],
    }
    opts = video_options(info)
    assert [o["label"] for o in opts] == ["2160p60", "1080p60", "720p"]
    top = opts[0]
    assert top["badge"] == "4K" and top["hdr"] is True and top["codec"] == "AV1"
    fhd = opts[1]
    assert fhd["id"] == "1080" and fhd["codec"] == "H.264" and set(fhd["codecs"]) == {"H.264", "VP9"}
    # size = best h264 video (6000 kbps) + audio (128 kbps) for 100 s
    assert fhd["size"] == int(6000 * 1000 / 8 * 100) + int(128 * 1000 / 8 * 100)


def test_video_options_without_dimensions_falls_back_to_best():
    info = {"duration": 10, "formats": [fmt("sd", vcodec=None, acodec=None), fmt("hd", vcodec=None, acodec=None, tbr=2000)]}
    opts = video_options(info)
    assert len(opts) == 1 and opts[0]["id"] == "best"


def test_audio_options():
    info = {"duration": 60, "formats": [fmt("140", vcodec="none", acodec="mp4a.40.2", abr=129, tbr=129), fmt("18", 640, 360, acodec="mp4a")]}
    opts = {o["id"]: o for o in audio_options(info)}
    assert set(opts) == {"mp3-320", "mp3-256", "mp3-192", "mp3-128", "m4a", "opus", "flac", "wav"}
    assert opts["mp3-320"]["size"] == 320 * 1000 // 8 * 60 and opts["mp3-320"]["popular"]
    assert opts["m4a"]["src_kbps"] == 129 and opts["mp3-320"]["src_kbps"] == 129 and opts["flac"]["tier"] == "lossless"
    silent = {"duration": 5, "formats": [fmt("0", 720, 1280), fmt("1", 480, 854)]}
    assert audio_options(silent) == []


def test_build_response_single_and_playlist():
    single = {"id": "x", "title": "Video by someone", "description": "Real caption\nmore", "duration": 5,
              "formats": [fmt("a", 1280, 720, acodec="aac")], "thumbnails": [{"url": "https://cdn.example/t.jpg", "width": 640, "height": 360}],
              "_mg_platform": "instagram"}
    r = build_response(single, "https://www.instagram.com/reel/x/")
    assert r["type"] == "video" and r["title"] == "Real caption" and r["platform"] == "instagram"
    assert r["thumbnails"][0]["url"].startswith("/api/thumb?")

    pl = {"_type": "playlist", "id": "PL1", "title": "Mix", "_mg_platform": "youtube",
          "entries": [{"id": f"v{i}", "title": f"Song {i}", "url": f"https://www.youtube.com/watch?v=v{i}", "duration": 60} for i in range(3)]}
    r = build_response(pl, "https://www.youtube.com/playlist?list=PL1")
    assert r["type"] == "playlist" and r["count"] == 3 and r["entries"][0]["url"].endswith("v0")

    carousel_one = {"_type": "playlist", "entries": [dict(single)], "_mg_platform": "twitter"}
    assert build_response(carousel_one, "https://x.com/a/status/1")["type"] == "video"
