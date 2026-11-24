"""Reproducible search demo: python -m keepstack seed-search.

Only generated demo assets are refreshed on reruns. No external files or models.
"""
import io

from PIL import Image, ImageDraw

from . import ingest
from .audit import now_iso
from .auth import hash_password
from .config import config
from .db import get_conn, init_db


def run_seed() -> None:
    init_db()
    conn = get_conn()
    if not conn.execute("SELECT 1 FROM users LIMIT 1").fetchone():
        conn.execute("INSERT INTO users (username,password_hash,role,is_active,created_at) VALUES (?,?, 'admin',1,?)",
                     (config.admin_user, hash_password(config.admin_password), now_iso()))
        conn.commit()
    user = dict(conn.execute("SELECT * FROM users WHERE role='admin' AND is_active=1 ORDER BY id LIMIT 1").fetchone())
    name = "Search acceptance demo"
    collection = conn.execute("SELECT id FROM collections WHERE name=? ORDER BY id LIMIT 1", (name,)).fetchone()
    if collection:
        cid = collection["id"]
    else:
        import uuid
        cid = conn.execute("INSERT INTO collections (uuid,name,description,created_by,created_at) VALUES (?,?,?,?,?)",
            (str(uuid.uuid4()), name, "36 generated assets; 25 match approved + campaign without internal.", user["id"], now_iso())).lastrowid
        conn.commit()
    for i in range(36):
        image = Image.new("RGB", (640, 400), ((40 + i * 23) % 200, (70 + i * 37) % 200, (100 + i * 17) % 200))
        draw = ImageDraw.Draw(image)
        draw.rectangle((0, 270, 640, 400), fill=(20, 25, 38))
        draw.text((30, 300), f"Harbor search demo {i + 1:02}", fill="white", font_size=30)
        data = io.BytesIO()
        image.save(data, format="PNG")
        title = f"Harbor search demo {i + 1:02}"
        asset = ingest.ingest_stream(io.BytesIO(data.getvalue()), f"search-demo-{i + 1:02}.png",
                                     title=title, user=user, run_ai=False)
        tags = ["approved"]
        if i % 9 != 0:
            tags.append("campaign")
        if i % 5 == 0:
            tags.append("internal")
        created = f"2026-01-{1 + i // 6:02}T00:00:00Z"
        conn.execute("UPDATE assets SET title=?,description=?,created_at=?,status='active' WHERE id=?",
                     (title, f'港口演示素材 {i + 1}，包含逗号, "引号"\n第二行描述', created, asset["id"]))
        conn.execute("DELETE FROM asset_tags WHERE asset_id=?", (asset["id"],))
        ingest._set_tags(conn, asset["id"], [(tag, 1.0) for tag in tags], "manual")
        conn.execute("INSERT OR IGNORE INTO collection_assets (collection_id,asset_id,added_at) VALUES (?,?,?)",
                     (cid, asset["id"], now_iso()))
        conn.commit()
        ingest.reindex_fts(asset["id"])
        ingest.reindex_embedding(asset["id"])
    print(f"Search demo ready: collection {cid} ({name}), 36 assets.")
    print("Search harbor; include approved and campaign; exclude internal: 25 matches, 2 pages, 25 CSV rows.")


if __name__ == "__main__":
    run_seed()
