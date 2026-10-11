from datetime import datetime, timezone
from io import BytesIO
import hashlib
import logging
import sqlite3
import threading
import uuid
import warnings

import numpy as np
from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError

from .encoder import normalize

LOG = logging.getLogger('aibum')
MAX_BYTES = 20 * 1024 * 1024
MAX_PIXELS = 40_000_000
PUBLIC_COLUMNS = ('id', 'album_id', 'name', 'mime', 'size', 'width', 'height', 'created_at',
                  'taken_at', 'camera', 'location', 'favorite', 'status', 'error', 'story', 'trashed_at')


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def decode_image(data):
    if not data or len(data) > MAX_BYTES:
        raise HTTPException(413, '图片不能为空且不得超过 20 MiB')
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as check:
                if check.format not in {'JPEG', 'PNG', 'WEBP'}:
                    raise HTTPException(415, '仅支持 JPG、PNG 和 WebP')
                if check.width * check.height > MAX_PIXELS:
                    raise HTTPException(413, '图片不能超过 4000 万像素')
                check.verify()
            with Image.open(BytesIO(data)) as source:
                mime = Image.MIME[source.format]
                exif = source.getexif()
                try:
                    exif_sub = exif.get_ifd(0x8769)
                    stamp = exif_sub.get(36867) or exif.get(306)
                    taken = datetime.strptime(str(stamp), '%Y:%m:%d %H:%M:%S').isoformat() if stamp else None
                except (ValueError, TypeError, OSError):
                    taken = None
                camera = str(exif.get(272, ''))[:200]
                image = ImageOps.exif_transpose(source).convert('RGB')
                image.load()
                return image, mime, taken, camera
    except HTTPException:
        raise
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError,
            Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise HTTPException(415, '文件不是完整、有效的受支持图片') from exc


def photo_dict(db, row):
    result = {k: row[k] for k in PUBLIC_COLUMNS}
    result['favorite'] = bool(result['favorite'])
    result['tags'] = [dict(t) for t in db.execute(
        'SELECT name,kind,source,score FROM photo_tags WHERE photo_id=? ORDER BY source DESC,name', (row['id'],))]
    result['thumbnail_url'] = f'/api/photos/{row["id"]}/file?thumbnail=true'
    result['original_url'] = f'/api/photos/{row["id"]}/file'
    return result


def owned(db, photo_id, user):
    row = db.execute("SELECT * FROM photos WHERE id=? AND owner_id=? AND status!='deleting'",
                     (photo_id, user)).fetchone()
    if row is None:
        raise HTTPException(404, '照片不存在')
    return row


def check_album(db, album_id, user):
    if album_id and not db.execute('SELECT 1 FROM albums WHERE id=? AND owner_id=?', (album_id, user)).fetchone():
        raise HTTPException(404, '相册不存在')


def save_photo(database, user, filename, data, album_id=None):
    with database.connect() as db:
        check_album(db, album_id, user)
    image, mime, taken, camera = decode_image(data)
    digest = hashlib.sha256(data).hexdigest()
    photo_id = uuid.uuid4().hex
    original, thumb = database.original(photo_id), database.thumbnail(photo_id)
    try:
        original.write_bytes(data)
        width, height = image.size
        image.thumbnail((480, 480))
        image.save(thumb, 'JPEG', quality=82)
        with database.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            check_album(db, album_id, user)
            duplicate = db.execute('SELECT * FROM photos WHERE owner_id=? AND sha256=?', (user, digest)).fetchone()
            if duplicate:
                original.unlink(missing_ok=True)
                thumb.unlink(missing_ok=True)
                if duplicate['status'] == 'deleting':
                    raise HTTPException(409, '同一照片正在删除，请稍后上传')
                if duplicate['trashed_at']:
                    raise HTTPException(409, '照片已在回收站，请先恢复')
                return photo_dict(db, duplicate), True
            if db.execute('SELECT count(*) FROM photos WHERE owner_id=?', (user,)).fetchone()[0] >= 500:
                raise HTTPException(409, '每个账户最多保存 500 张照片，请先整理照片库')
            db.execute('''INSERT INTO photos
                (id,owner_id,album_id,name,sha256,mime,size,width,height,created_at,taken_at,camera)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)''',
                (photo_id, user, album_id, filename[:200] or '未命名照片', digest, mime,
                 len(data), width, height, now(), taken, camera))
            result = photo_dict(db, owned(db, photo_id, user))
        LOG.info('action=upload user=%s photo=%s rows=1', user, photo_id)
        return result, False
    except Exception as exc:
        original.unlink(missing_ok=True)
        thumb.unlink(missing_ok=True)
        if isinstance(exc, sqlite3.IntegrityError):
            with database.connect() as db:
                row = db.execute('SELECT * FROM photos WHERE owner_id=? AND sha256=?', (user, digest)).fetchone()
                if row and row['status'] != 'deleting':
                    return photo_dict(db, row), True
                if row:
                    raise HTTPException(409, '同一照片正在删除，请稍后上传') from exc
        raise


def filters(user, tag='', album_id='', favorite=False, location='', start=None, end=None, tags=None, trash=False):
    clauses = ["p.owner_id=?", "p.status!='deleting'", "p.trashed_at IS NOT NULL" if trash else "p.trashed_at IS NULL"]
    values = [user]
    if tag:
        clauses.append('EXISTS (SELECT 1 FROM photo_tags t WHERE t.photo_id=p.id AND t.name=?)')
        values.append(tag)
    if tags:
        # Multiple checked tags mean any selected tag, like faceted library search.
        clauses.append('EXISTS (SELECT 1 FROM photo_tags t WHERE t.photo_id=p.id AND t.name IN ('
                       + ','.join('?' for _ in tags) + '))')
        values.extend(tags)
    if album_id == '__unfiled__':
        clauses.append('p.album_id IS NULL')
    elif album_id:
        clauses.append('p.album_id=?')
        values.append(album_id)
    if favorite:
        clauses.append('p.favorite=1')
    if location:
        clauses.append('instr(lower(p.location),lower(?))>0')
        values.append(location)
    if start:
        clauses.append('substr(COALESCE(p.taken_at,p.created_at),1,10)>=?')
        values.append(str(start))
    if end:
        clauses.append('substr(COALESCE(p.taken_at,p.created_at),1,10)<=?')
        values.append(str(end))
    return ' AND '.join(clauses), values


MATCHING_RULES = {
    'text': {'broad': (.24, .10), 'balanced': (.30, .045), 'strict': (.34, .025)},
    'image': {'broad': (.62, .22), 'balanced': (.72, .12), 'strict': (.82, .08)},
}


def rank(database, encoder, user, vector, limit=30, min_score=None, exclude=None,
         mode='text', strictness='balanced', **kwargs):
    where, values = filters(user, **kwargs)
    with database.connect() as db:
        # shortcut: exact scan is the baseline; switch to ANN after measuring a larger library.
        rows = db.execute(f'''SELECT p.* FROM photos p WHERE {where} AND p.status='ready'
            AND p.model_id=? ORDER BY p.id''', [*values, encoder.model_id]).fetchall()
        rows = [r for r in rows if r['id'] != exclude]
        floor, max_gap = MATCHING_RULES[mode][strictness]
        # An explicit slider value is the whole cutoff, without the relative top-score gate.
        floor = min_score if min_score is not None else floor
        if not rows:
            return {'items': [], 'candidate_count': 0, 'matched_count': 0,
                    'filtered_count': 0, 'threshold': floor, 'strictness': strictness}
        matrix = np.stack([np.frombuffer(r['embedding'], dtype=np.float32) for r in rows])
        scores = matrix @ normalize(vector)
        # shortcut: heuristic rejection gates; calibrate on the team's labeled photos.
        cutoff = floor if min_score is not None else max(floor, float(scores.max()) - max_gap)
        matching = [int(i) for i in np.argsort(-scores, kind='stable') if scores[i] >= cutoff]
        result = []
        for i in matching[:limit]:
            item = photo_dict(db, rows[i])
            item['score'] = float(scores[i])
            result.append(item)
        return {'items': result, 'candidate_count': len(rows), 'matched_count': len(matching),
                'filtered_count': len(rows) - len(matching), 'threshold': cutoff, 'strictness': strictness}


class AnalysisWorker:
    def __init__(self, database, encoder):
        self.database, self.encoder = database, encoder
        self.stop = threading.Event()
        self.wake = threading.Event()
        self.thread = threading.Thread(target=self.run, name='photo-analysis', daemon=True)

    def start(self):
        with self.database.connect() as db:
            db.execute("UPDATE photos SET status='pending' WHERE status='processing'")
            db.execute("UPDATE photos SET status='pending',embedding=NULL WHERE status='ready' AND model_id!=?",
                       (self.encoder.model_id,))
        self.thread.start()

    def close(self):
        self.stop.set()
        self.wake.set()
        self.thread.join(timeout=30)

    def run(self):
        while not self.stop.is_set():
            try:
                if self.step():
                    continue
            except Exception:
                LOG.exception('Background task failed')
            self.wake.wait(2)
            self.wake.clear()

    def step(self):
        with self.database.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute("SELECT * FROM photos WHERE status IN ('deleting','pending') ORDER BY status,created_at LIMIT 1").fetchone()
            if row is None:
                return False
            photo_id = row['id']
            if row['status'] == 'pending':
                db.execute("UPDATE photos SET status='processing',error=NULL WHERE id=?", (photo_id,))
        if row['status'] == 'deleting':
            self.database.original(photo_id).unlink(missing_ok=True)
            self.database.thumbnail(photo_id).unlink(missing_ok=True)
            with self.database.connect() as db:
                db.execute('BEGIN IMMEDIATE')
                db.execute('DELETE FROM photos WHERE id=?', (photo_id,))
            LOG.info('action=delete user=%s photo=%s rows=1', row['owner_id'], photo_id)
            return True
        try:
            image, *_ = decode_image(self.database.original(photo_id).read_bytes())
            vector = normalize(self.encoder.image(image))
            tags = self.encoder.tags(vector)
            with self.database.connect() as db:
                updated = db.execute("""UPDATE photos SET status='ready',error=NULL,embedding=?,model_id=?
                    WHERE id=? AND status='processing'""", (vector.tobytes(), self.encoder.model_id, photo_id))
                edited = db.execute('SELECT tags_edited FROM photos WHERE id=?', (photo_id,)).fetchone()
                if updated.rowcount and edited and not edited['tags_edited']:
                    db.execute("DELETE FROM photo_tags WHERE photo_id=? AND source='auto'", (photo_id,))
                    db.executemany('INSERT OR IGNORE INTO photo_tags VALUES (?,?,?,?,?)',
                                   [(photo_id, t['name'], t['kind'], 'auto', t['score']) for t in tags])
        except Exception:
            LOG.exception('action=analysis user=%s photo=%s', row['owner_id'], photo_id)
            with self.database.connect() as db:
                db.execute("""UPDATE photos SET status='failed',error=? WHERE id=? AND status='processing'""",
                           ('分析失败：请检查本地模型与服务日志，然后点击重试。原图已保存。', photo_id))
        return True
