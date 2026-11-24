"""Isolated, reproducible catalog for the quiz search/export acceptance cases."""
import csv
import hashlib
import io
import json
import uuid

import pytest
from fastapi.testclient import TestClient

from keepstack import db, ingest
from keepstack.app import app
from keepstack.config import config


@pytest.fixture
def catalog(tmp_path, monkeypatch):
    # Keep both this fixture and TestClient's worker connections away from demo data.
    for name, value in {
        "data_dir": tmp_path, "db_path": tmp_path / "test.db",
        "blob_dir": tmp_path / "blobs", "thumb_dir": tmp_path / "thumbnails",
        "cache_dir": tmp_path / "cache", "secret_key": "search-test-secret",
        "admin_user": "admin", "admin_password": "admin", "ai_enabled": False,
        "ocr_enabled": False,
    }.items():
        monkeypatch.setattr(config, name, value)
    monkeypatch.setattr(db._local, "conn", None, raising=False)
    monkeypatch.setattr(ingest, "reindex_embedding", lambda _asset_id: None)
    with TestClient(app) as client:
        conn = db.get_conn()
        for cid in (1, 2):
            conn.execute("INSERT INTO collections (id,uuid,name,created_at) VALUES (?,?,?,?)",
                         (cid, str(uuid.uuid4()), f"Collection {cid}", "2026-01-01"))
        records = []
        for i in range(37):
            tags = ["approved", "campaign"]
            if i % 5 == 0:
                tags.append("internal")
            if i == 32:
                tags = ["approved-extra", "campaign"]
            if i == 33:
                tags = ["approved"]
            if i == 34:
                tags.append('审阅,"完成"')
            row = dict(uuid=str(uuid.uuid5(uuid.NAMESPACE_URL, f"quiz-asset-{i}")),
                       title=f"Harbor {i:02}", description=f'中文说明，逗号, "引号"\n第二行 {i}',
                       filename=f"asset-{i:02}.jpg", media_type="image" if i % 2 == 0 else "document",
                       status="archived" if i == 35 else "deleted" if i == 36 else "active",
                       created_at=f"2026-01-{1 + i // 6:02}T00:00:00Z", tags=tags,
                       collection_id=1 if i < 30 else 2)
            cur = conn.execute(
                "INSERT INTO assets (uuid,sha256,title,description,filename,media_type,status,"
                "storage_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (row["uuid"], hashlib.sha256(str(i).encode()).hexdigest(), row["title"],
                 row["description"], row["filename"], row["media_type"], row["status"],
                 f"fixture/{i}", row["created_at"], row["created_at"]))
            row["id"] = cur.lastrowid
            for name in tags:
                conn.execute("INSERT OR IGNORE INTO tags (name) VALUES (?)", (name,))
                conn.execute("INSERT INTO asset_tags (asset_id,tag_id,source) "
                             "SELECT ?,id,'manual' FROM tags WHERE name=?", (row["id"], name))
            conn.execute("INSERT INTO collection_assets (collection_id,asset_id) VALUES (?,?)",
                         (row["collection_id"], row["id"]))
            conn.commit()
            ingest.reindex_fts(row["id"])
            records.append(row)
        token = client.post("/api/auth/login", json={"username": "admin", "password": "admin"}).json()["token"]
        client.headers["Authorization"] = "Bearer " + token
        yield client, records
        conn.close()


def csv_rows(response):
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/csv")
    assert "attachment" in response.headers["content-disposition"]
    return list(csv.DictReader(io.StringIO(response.content.decode("utf-8-sig"))))


def test_combined_filters_use_all_includes_any_excludes_and_exact_names(catalog):
    client, records = catalog
    params = [("q", "harbor"), ("collection_id", 1), ("media_type", "image"),
              ("include_tag", "APPROVED"), ("include_tag", "campaign"),
              ("include_tag", "approved"), ("exclude_tag", "internal"),
              ("exclude_tag", "missing"), ("sort", "oldest")]
    expected = [r["uuid"] for r in records if r["collection_id"] == 1
                and r["media_type"] == "image" and "internal" not in r["tags"]]
    result = client.get("/api/assets", params=params).json()
    assert [r["uuid"] for r in result["items"]] == expected
    assert result["total"] == len(expected)
    assert [r["uuid"] for r in csv_rows(client.get("/api/assets/export.csv", params=params))] == expected
    # The legacy tag+collection combination also used to bind parameters incorrectly.
    legacy = client.get("/api/assets", params={"tag": "approved", "collection_id": 2}).json()
    assert legacy["total"] == 4
    conflict = client.get("/api/assets", params=[("include_tag", "approved"), ("exclude_tag", "APPROVED")])
    assert conflict.json()["total"] == 0
    assert client.get("/api/assets", params={"include_tag": "approv"}).json()["total"] == 0


@pytest.mark.parametrize("sort,reverse", [("oldest", False), ("newest", True)])
def test_multiple_pages_and_tied_timestamps_match_complete_export(catalog, sort, reverse):
    client, records = catalog
    filters = [("q", "harbor"), ("include_tag", "approved"), ("sort", sort)]
    expected = sorted([r for r in records if r["status"] == "active" and "approved" in r["tags"]],
                      key=lambda r: (r["created_at"], r["id"]), reverse=reverse)
    seen = []
    for offset in range(0, len(expected), 7):
        response = client.get("/api/assets", params=filters + [("limit", 7), ("offset", offset)])
        assert response.status_code == 200
        assert response.json()["total"] == len(expected)
        seen.extend(r["uuid"] for r in response.json()["items"])
    assert seen == [r["uuid"] for r in expected]
    assert len(seen) == len(set(seen))
    # Even a paged caller cannot accidentally limit the CSV.
    exported = csv_rows(client.get("/api/assets/export.csv", params=filters + [("limit", 1), ("offset", 14)]))
    assert [r["uuid"] for r in exported] == seen
    assert client.get("/api/assets", params=filters + [("offset", 9999)]).json()["items"] == []


def test_csv_roundtrips_unicode_commas_quotes_newlines_and_tag_names(catalog):
    client, records = catalog
    rows = csv_rows(client.get("/api/assets/export.csv", params={"include_tag": '审阅,"完成"'}))
    assert len(rows) == 1
    row = rows[0]
    assert row["description"] == records[34]["description"]
    assert json.loads(row["tags"]) == sorted(records[34]["tags"])
    assert list(row) == ["uuid", "title", "description", "filename", "media_type", "tags", "created_at"]
    empty = client.get("/api/assets/export.csv", params={"include_tag": "does-not-exist"})
    assert csv_rows(empty) == []
    assert empty.content.decode("utf-8-sig").startswith("uuid,title,description,")


@pytest.mark.parametrize("params", [
    {"limit": 0}, {"limit": -1}, {"limit": 201}, {"limit": "x"},
    {"offset": -1}, {"offset": "x"}, {"collection_id": 0}, {"sort": "unsafe SQL"},
    {"status": "deleted"}, {"mode": "semantic"},
])
def test_invalid_query_parameters_are_rejected(catalog, params):
    assert catalog[0].get("/api/assets", params=params).status_code == 422


@pytest.mark.parametrize("keyword", ['" OR * ( )', "' ; --", "你好", "harbor\" OR internal", "   "])
def test_special_keywords_do_not_crash_or_bypass_filters(catalog, keyword):
    client, _ = catalog
    response = client.get("/api/assets", params={"q": keyword, "include_tag": "missing"})
    assert response.status_code == 200
    assert response.json()["total"] == 0
    assert csv_rows(client.get("/api/assets/export.csv", params={"q": keyword, "include_tag": "missing"})) == []


def test_whitespace_is_unrestricted_but_punctuation_only_has_no_terms(catalog):
    client, _ = catalog
    assert client.get("/api/assets", params={"q": " \t "}).json()["total"] == 35
    assert client.get("/api/assets", params={"q": '"!*()'}).json()["total"] == 0


def test_query_and_export_require_authentication(catalog):
    client, _ = catalog
    client.headers.pop("Authorization")
    assert client.get("/api/assets").status_code == 401
    assert client.get("/api/assets/export.csv").status_code == 401


def test_existing_edit_routes_refresh_fts_filters_and_csv(catalog):
    client, records = catalog
    target = records[1]
    url = "/api/assets/" + target["uuid"]
    patch = client.patch(url, json={"title": "NeedleRenamed", "description": '新描述, "修改"\n换行'})
    assert patch.status_code == 200
    assert client.get("/api/assets", params={"q": "NeedleRenamed"}).json()["total"] == 1
    harbor = client.get("/api/assets", params={"q": "harbor", "limit": 200}).json()
    assert target["uuid"] not in [r["uuid"] for r in harbor["items"]]
    assert client.post(url + "/tags", json={"name": "FreshTag"}).status_code == 200
    filters = {"q": "NeedleRenamed", "include_tag": "freshtag"}
    assert client.get("/api/assets", params=filters).json()["total"] == 1
    exported = csv_rows(client.get("/api/assets/export.csv", params=filters))
    assert exported[0]["title"] == "NeedleRenamed"
    assert exported[0]["description"] == '新描述, "修改"\n换行'
    assert "freshtag" in json.loads(exported[0]["tags"])
    assert client.get("/api/assets", params={"q": "freshtag"}).json()["total"] == 1
    assert client.delete(url + "/tags/freshtag").status_code == 200
    assert client.get("/api/assets", params={"q": "freshtag"}).json()["total"] == 0
    assert csv_rows(client.get("/api/assets/export.csv", params=filters)) == []


def test_search_demo_is_reproducible_and_has_two_filtered_pages(catalog):
    from keepstack.seed_search import run_seed
    client, _ = catalog
    run_seed()
    conn = db.get_conn()
    cid = conn.execute("SELECT id FROM collections WHERE name='Search acceptance demo'").fetchone()["id"]
    params = [("collection_id", cid), ("q", "harbor"), ("include_tag", "approved"),
              ("include_tag", "campaign"), ("exclude_tag", "internal")]
    first = client.get("/api/assets", params=params).json()
    assert first["total"] == 25
    assert len(first["items"]) == 24
    second = client.get("/api/assets", params=params + [("offset", 24)]).json()
    assert len(second["items"]) == 1
    before = [r["uuid"] for r in csv_rows(client.get("/api/assets/export.csv", params=params))]
    assert len(before) == 25
    run_seed()
    assert client.get("/api/assets", params={"collection_id": cid}).json()["total"] == 36
    assert [r["uuid"] for r in csv_rows(client.get("/api/assets/export.csv", params=params))] == before
