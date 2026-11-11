"""Photo engine: normalisation of platform data (no network)."""
import io
import zipfile

from app import gallery as G


def _img(w, h, name="a"):
    return {"url": f"https://scontent.cdninstagram.com/{name}_{w}.jpg?stp=x", "width": w, "height": h}


def test_instagram_single_photo_picks_largest_candidate():
    info = {"id": "X", "_mg_ig": {"media_type": 1, "code": "ABC", "images": [_img(320, 400), _img(1080, 1350), _img(640, 800)],
                                  "videos": [], "carousel": [], "username": "nasa", "caption": "Pillars of Creation\nmore", "taken_at": 1700000000}}
    g = G.from_instagram(info, "https://www.instagram.com/p/ABC/")
    assert g["media_type"] == "photo" and len(g["items"]) == 1
    it = g["items"][0]
    assert (it["width"], it["height"]) == (1080, 1350) and it["ext"] == "jpg" and it["index"] == 1
    assert g["title"] == "Pillars of Creation" and g["uploader"] == "nasa" and g["upload_date"] == "2023-11-14"


def test_instagram_mixed_carousel_and_single_video():
    video = {"media_type": 2, "images": [_img(640, 640, "c")], "videos": [{"url": "https://scontent.cdninstagram.com/v.mp4", "width": 720, "height": 720}]}
    photo = {"media_type": 1, "images": [_img(1080, 1080, "p")], "videos": []}
    info = {"_mg_ig": {"media_type": 8, "images": [], "videos": [], "carousel": [photo, video], "username": "u", "caption": ""}}
    g = G.from_instagram(info, "u")
    assert g["media_type"] == "mixed" and [i["type"] for i in g["items"]] == ["image", "video"]
    assert g["items"][1]["preview"].endswith("c_640.jpg?stp=x")
    # a post that is just one video goes to the normal video flow
    assert G.from_instagram({"_mg_ig": {**video, "carousel": []}}, "u") is None


def test_url_helpers():
    assert G.tiktok_video_url("https://www.tiktok.com/@a/photo/123456789") == "https://www.tiktok.com/@a/video/123456789"
    assert G._tw_orig("https://pbs.twimg.com/media/ABC.jpg") == "https://pbs.twimg.com/media/ABC?format=jpg&name=orig"
    assert G._ext_from_url("https://p16.tiktokcdn-us.com/x~tplv-photomode-image.jpeg?a=1") == "jpg"
    assert G._ext_from_url("https://pbs.twimg.com/media/X?format=png&name=orig") == "png"
    assert G.is_facebook_photo_url("https://www.facebook.com/photo/?fbid=1&set=a.2")
    assert G.is_facebook_photo_url("https://www.facebook.com/media/set/?set=a.10152716010956729&type=3")
    assert not G.is_facebook_photo_url("https://www.facebook.com/cnn/videos/10155529876156509/")


def test_facebook_post_uses_only_the_posts_own_photos():
    node = lambda n: '{"media":{"__typename":"Photo","id":"%d","viewer_image":{"height":1536,"width":2048,"uri":"https:\\/\\/scontent.xx.fbcdn.net\\/v\\/%d_n.jpg?x=1"}}}' % (n, n)
    other = '"viewer_image":{"height":10,"width":10,"uri":"https:\\/\\/scontent.xx.fbcdn.net\\/v\\/999_n.jpg"}'
    page = 'junk ' + other + ' "all_subattachments":{"count":40,"nodes":[' + ",".join(node(n) for n in (1, 2, 3)) + ']} ' + other
    items, total = G._fb_parse_page(page, album=False)
    assert total == 40 and [i["width"] for i in items] == [2048] * 3
    assert all("999_n" not in i["url"] for i in items) and items[0]["url"].startswith("https://scontent.xx.fbcdn.net/v/1_n.jpg")
    album_items, total = G._fb_parse_page('x ' + other.replace("999", "5") + ' ' + other.replace("999", "6"), album=True)
    assert total == 0 and len(album_items) == 2


def test_finish_media_type_and_filenames(tmp_path):
    g = G._finish({"platform": "twitter", "id": "1", "url": "u", "title": "Hello world", "uploader": "nasa",
                   "items": [{"type": "image", "url": "https://pbs.twimg.com/media/A.jpg"}, {"type": "image", "url": "https://pbs.twimg.com/media/B.png"}]})
    assert g["media_type"] == "carousel" and g["referer"] == "https://x.com/"
    assert G.item_filename(g, g["items"][1], single=False) == "nasa - Hello world (02 of 02)"
    assert G.zip_name(g, 2) == "nasa - Hello world (2 files).zip"
    a, b = tmp_path / "a.jpg", tmp_path / "b.jpg"
    a.write_bytes(b"\xff\xd8\xff" + b"1" * 100)
    b.write_bytes(b"\xff\xd8\xff" + b"2" * 50)
    out = G.build_zip([(a, "same.jpg"), (b, "same.jpg")], tmp_path / "out.zip")
    names = zipfile.ZipFile(io.BytesIO(out.read_bytes())).namelist()
    assert names == ["same.jpg", "same (2).jpg"]
