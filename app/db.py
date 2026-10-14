from contextlib import contextmanager
from pathlib import Path
import sqlite3


class Database:
    def __init__(self, root: Path):
        self.root = root
        self.files = root / 'photos'
        self.files.mkdir(parents=True, exist_ok=True)
        self.music_files = root / 'music'
        self.music_files.mkdir(parents=True, exist_ok=True)
        self.path = root / 'album.sqlite3'
        with self.connect() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.executescript('''
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
                    expires_at REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS albums (
                    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
                    name TEXT NOT NULL, UNIQUE(owner_id, name));
                CREATE TABLE IF NOT EXISTS photos (
                    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
                    album_id TEXT REFERENCES albums(id), name TEXT NOT NULL,
                    sha256 TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
                    width INTEGER NOT NULL, height INTEGER NOT NULL,
                    created_at TEXT NOT NULL, taken_at TEXT, camera TEXT NOT NULL DEFAULT '',
                    location TEXT NOT NULL DEFAULT '', favorite INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'pending', error TEXT,
                    embedding BLOB, model_id TEXT, UNIQUE(owner_id, sha256));
                CREATE INDEX IF NOT EXISTS photos_owner ON photos(owner_id, created_at);
                CREATE INDEX IF NOT EXISTS photos_status ON photos(status);
                CREATE TABLE IF NOT EXISTS photo_tags (
                    photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
                    name TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL,
                    score REAL, PRIMARY KEY(photo_id, name));
                CREATE TABLE IF NOT EXISTS music_tracks (
                    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
                    name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
                    created_at TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS music_owner ON music_tracks(owner_id, created_at);
            ''')
            additions = {
                'users': {'is_admin': 'INTEGER NOT NULL DEFAULT 0', 'active': 'INTEGER NOT NULL DEFAULT 1',
                          'recovery_hash': 'TEXT', 'nickname': "TEXT NOT NULL DEFAULT ''",
                          'avatar': 'BLOB', 'avatar_version': "TEXT NOT NULL DEFAULT ''"},
                 'photos': {'tags_edited': 'INTEGER NOT NULL DEFAULT 0', 'story': "TEXT NOT NULL DEFAULT ''", 'trashed_at': 'TEXT', 'latitude': 'REAL', 'longitude': 'REAL', 'date_source': "TEXT NOT NULL DEFAULT 'unknown'"},
                'albums': {'parent_id': 'TEXT', 'cover_id': 'TEXT'},
            }
            for table, columns in additions.items():
                existing = {r['name'] for r in db.execute(f'PRAGMA table_info({table})')}
                for name, definition in columns.items():
                    if name not in existing:
                        db.execute(f'ALTER TABLE {table} ADD COLUMN {name} {definition}')

            db.executescript("""
                CREATE TABLE IF NOT EXISTS tag_colors(owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, color TEXT NOT NULL, PRIMARY KEY(owner_id,name));
                CREATE TABLE IF NOT EXISTS feedback(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, claimed_by TEXT REFERENCES users(id), claimed_at TEXT, resolved_at TEXT, reply TEXT NOT NULL DEFAULT '', unread INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS feedback_images(id TEXT PRIMARY KEY, feedback_id TEXT NOT NULL REFERENCES feedback(id), is_reply INTEGER NOT NULL DEFAULT 0, data BLOB NOT NULL);
                CREATE TABLE IF NOT EXISTS ai_grants(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), photo_ids TEXT NOT NULL, created_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS activity(id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, created_at TEXT NOT NULL);
            """)

        # Rebuild the legacy global album-name constraint without renaming its references.
        with sqlite3.connect(self.path) as migration:
            sql = migration.execute("SELECT sql FROM sqlite_master WHERE name='albums'").fetchone()[0]
            if 'UNIQUE(owner_id, name)' in sql:
                migration.execute('PRAGMA foreign_keys=OFF')
                migration.execute('BEGIN IMMEDIATE')
                migration.execute('CREATE TABLE albums_new(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, parent_id TEXT, cover_id TEXT)')
                migration.execute('INSERT INTO albums_new SELECT id,owner_id,name,parent_id,cover_id FROM albums')
                migration.execute('DROP TABLE albums')
                migration.execute('ALTER TABLE albums_new RENAME TO albums')
                migration.execute("CREATE UNIQUE INDEX album_sibling_names ON albums(owner_id,COALESCE(parent_id,''),name)")
                migration.commit()
                migration.execute('PRAGMA foreign_keys=ON')
                if migration.execute('PRAGMA foreign_key_check').fetchall():
                    raise RuntimeError('Album migration foreign-key check failed')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=20)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        try:
            with db:
                yield db
        finally:
            db.close()

    def original(self, photo_id):
        return self.files / f'{photo_id}.original'

    def thumbnail(self, photo_id):
        return self.files / f'{photo_id}.jpg'
