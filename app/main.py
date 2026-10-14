from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import date
import hashlib
import hmac
import logging
import os
from pathlib import Path
import secrets
import sqlite3
import threading
import time
import uuid
import zipfile
from io import BytesIO
from tempfile import SpooledTemporaryFile
from typing import Literal
from PIL import ImageOps

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from starlette.concurrency import run_in_threadpool
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .db import Database
from .encoder import ChineseClipEncoder, ModelUnavailable, ROOT, normalize
from .photos import (AnalysisWorker, MAX_BYTES, check_album, decode_image, filters,
                     now, owned, photo_dict, rank, save_photo, semantic_resolver, tag_color_value)

LOG = logging.getLogger('aibum')
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s %(message)s')
COOKIE = 'aibum_session'


class Credentials(BaseModel):
    username: str = Field(min_length=1, max_length=20)
    password: str = Field(min_length=8, max_length=128)

    @field_validator('username')
    @classmethod
    def clean_username(cls, value):
        value = value.strip()
        if not value or any(ord(c) < 32 for c in value):
            raise ValueError('用户名不能为空或包含控制字符')
        return value


class ProfileInput(BaseModel):
    nickname: str = Field(max_length=30)

    @field_validator('nickname')
    @classmethod
    def clean_nickname(cls, value):
        value = value.strip()
        if any(ord(c) < 32 for c in value):
            raise ValueError('昵称不能包含控制字符')
        return value


class AlbumInput(BaseModel):
    parent_id: str | None = None
    name: str = Field(min_length=1, max_length=80)

    @field_validator('name')
    @classmethod
    def clean_name(cls, value):
        if not value.strip():
            raise ValueError('名称不能为空')
        return value.strip()


class PasswordChange(BaseModel):
    current_password: str = Field(min_length=8, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)


class PasswordReset(BaseModel):
    username: str = Field(min_length=1, max_length=20)
    recovery_code: str = Field(min_length=10, max_length=200)
    new_password: str = Field(min_length=8, max_length=128)


class RecoveryRotate(BaseModel):
    password: str = Field(min_length=8, max_length=128)


class UserState(BaseModel):
    active: bool


class AlbumPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    parent_id: str | None = None
    cover_id: str | None = None


class PhotoPatch(BaseModel):
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    story: str | None = Field(default=None, max_length=4000)
    taken_at: date | None = None
    name: str | None = Field(default=None, min_length=1, max_length=200)
    favorite: bool | None = None
    album_id: str | None = None
    location: str | None = Field(default=None, max_length=200)
    tags: list[str] | None = Field(default=None, max_length=30)

    @field_validator('tags')
    @classmethod
    def clean_tags(cls, value):
        if value is None:
            return None
        names = list(dict.fromkeys(n.strip() for n in value))
        if any(not n or len(n) > 30 for n in names):
            raise ValueError('每个标签长度应为 1–30 字符')
        return names

    @field_validator('name')
    @classmethod
    def clean_name(cls, value):
        if value is not None and not value.strip():
            raise ValueError('名称不能为空')
        return value.strip() if value else value


class PhotoDownload(BaseModel):
    photo_ids: list[str] = Field(min_length=1, max_length=500)


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    hashed = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
    return salt + ':' + hashed


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


async def read_upload(file):
    try:
        data = await file.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise HTTPException(413, '单张图片不得超过 20 MiB')
        return data
    finally:
        await file.close()


class BodyLimit:
    """Bound multipart bytes before the multipart parser can spool a huge request."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        consumed = 0

        async def limited_receive():
            nonlocal consumed
            message = await receive()
            consumed += len(message.get('body', b''))
            if consumed > MAX_BYTES + 1024 * 1024:
                raise HTTPException(413, '请求过大，请逐张上传图片')
            return message

        await self.app(scope, limited_receive, send)


def create_app(data_dir=None, encoder=None, start_worker=True):
    database = Database(Path(data_dir or os.environ.get('AIBUM_DATA_DIR', ROOT / 'data')))
    encoder = encoder or ChineseClipEncoder()
    worker = AnalysisWorker(database, encoder)

    @asynccontextmanager
    async def lifespan(app):
        if start_worker:
            worker.start()
        yield
        if start_worker:
            worker.close()

    app = FastAPI(title='AIbum 智慧相册', version='0.1.0', lifespan=lifespan)
    app.state.database, app.state.encoder, app.state.worker = database, encoder, worker
    app.add_middleware(BodyLimit)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=os.environ.get(
        'AIBUM_ALLOWED_HOSTS', 'localhost,127.0.0.1,testserver').split(','))
    attempts = defaultdict(deque)
    rate_lock = threading.Lock()

    @app.middleware('http')
    async def browser_safety(request, call_next):
        if request.method not in {'GET', 'HEAD', 'OPTIONS'}:
            if request.headers.get('x-aibum-request') != '1':
                return JSONResponse({'detail': '缺少同源请求校验头'}, status_code=403)
            origin = request.headers.get('origin')
            if origin and origin != f'{request.url.scheme}://{request.headers.get("host")}':
                return JSONResponse({'detail': '拒绝跨站请求'}, status_code=403)
            try:
                if int(request.headers.get('content-length', 0)) > MAX_BYTES + 1024 * 1024:
                    return JSONResponse({'detail': '请求过大'}, status_code=413)
            except ValueError:
                return JSONResponse({'detail': '无效的请求长度'}, status_code=400)
        response = await call_next(request)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'same-origin'
        if request.url.path not in {'/docs', '/redoc'}:
            response.headers['Content-Security-Policy'] = "default-src 'self'; img-src 'self' blob:; media-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'"
        if request.url.path.startswith('/api/'):
            response.headers['Cache-Control'] = 'no-store'
        return response

    @app.exception_handler(ModelUnavailable)
    async def model_unavailable(request, exc):
        LOG.warning('model unavailable: %s', exc, exc_info=True)
        return JSONResponse({'detail': str(exc)}, status_code=503)

    def current_user(request: Request):
        token = request.cookies.get(COOKIE, '')
        with database.connect() as db:
            row = db.execute('''SELECT u.id,u.username,u.is_admin,u.nickname,u.avatar_version,u.created_at FROM users u JOIN sessions s ON u.id=s.user_id
                WHERE s.token_hash=? AND s.expires_at>? AND u.active=1''', (token_hash(token), time.time())).fetchone()
        if row is None:
            raise HTTPException(401, '请先登录')
        return dict(row)

    def rate_limit(request):
        key = request.client.host if request.client else 'unknown'
        stamp = time.monotonic()
        with rate_lock:
            # Keep the in-memory single-process limiter bounded.
            for address in list(attempts):
                if not attempts[address] or attempts[address][-1] < stamp - 60:
                    del attempts[address]
            queue = attempts[key]
            while queue and queue[0] < stamp - 60:
                queue.popleft()
            if len(queue) >= 20:
                raise HTTPException(429, '操作过于频繁，请一分钟后重试')
            queue.append(stamp)

    def login_session(db, response, user_id, old_token):
        token = secrets.token_urlsafe(32)
        db.execute('DELETE FROM sessions WHERE expires_at<? OR token_hash=?', (time.time(), token_hash(old_token)))
        db.execute('INSERT INTO sessions VALUES (?,?,?)', (token_hash(token), user_id, time.time() + 7 * 86400))
        response.set_cookie(COOKIE, token, httponly=True, samesite='strict', max_age=7 * 86400,
                            secure=os.environ.get('AIBUM_SECURE_COOKIE') == '1')

    @app.post('/api/auth/register', status_code=201)
    def register(body: Credentials, request: Request, response: Response):
        rate_limit(request)
        user_id = uuid.uuid4().hex
        hashed = password_hash(body.password)
        recovery_code = secrets.token_urlsafe(32)
        try:
            with database.connect() as db:
                db.execute('INSERT INTO users (id,username,password_hash,created_at,recovery_hash) VALUES (?,?,?,?,?)',
                           (user_id, body.username, hashed, now(), token_hash(recovery_code)))
                login_session(db, response, user_id, request.cookies.get(COOKIE, ''))
        except sqlite3.IntegrityError:
            raise HTTPException(409, '用户名已存在')
        LOG.info('action=register user=%s rows=1', user_id)
        return {'id': user_id, 'username': body.username, 'is_admin': False, 'recovery_code': recovery_code}

    def authenticate(body, request, response, require_admin=False):
        rate_limit(request)
        with database.connect() as db:
            user = db.execute('SELECT * FROM users WHERE username=?', (body.username,)).fetchone()
        salt = user['password_hash'].split(':')[0] if user else '0' * 32
        candidate = password_hash(body.password, salt)
        if not user or not hmac.compare_digest(candidate, user['password_hash']):
            raise HTTPException(401, '用户名或密码错误')
        if not user['active']:
            raise HTTPException(403, '您的帐户已被停用，请联系管理员')
        if require_admin and not user['is_admin']:
            raise HTTPException(403, '此账号没有管理员权限，请使用普通用户入口')
        with database.connect() as db:
            login_session(db, response, user['id'], request.cookies.get(COOKIE, ''))
        LOG.info('action=login user=%s', user['id'])
        return {key: user[key] for key in ('id', 'username', 'is_admin', 'nickname', 'avatar_version', 'created_at')}

    @app.post('/api/auth/login')
    def login(body: Credentials, request: Request, response: Response):
        return authenticate(body, request, response)

    @app.post('/api/admin/login')
    def admin_login(body: Credentials, request: Request, response: Response):
        return authenticate(body, request, response, require_admin=True)

    @app.post('/api/auth/password')
    def change_password(body: PasswordChange, request: Request, response: Response, user=Depends(current_user)):
        rate_limit(request)
        with database.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT password_hash FROM users WHERE id=?', (user['id'],)).fetchone()
            if not hmac.compare_digest(password_hash(body.current_password, row[0].split(':')[0]), row[0]):
                raise HTTPException(400, '当前密码不正确')
            db.execute('UPDATE users SET password_hash=? WHERE id=?', (password_hash(body.new_password), user['id']))
            db.execute('DELETE FROM sessions WHERE user_id=?', (user['id'],))
        response.delete_cookie(COOKIE)
        LOG.info('action=change_password user=%s rows=1', user['id'])
        return {'ok': True}

    @app.patch('/api/auth/profile')
    def update_profile(body: ProfileInput, user=Depends(current_user)):
        with database.connect() as db:
            db.execute('UPDATE users SET nickname=? WHERE id=?', (body.nickname, user['id']))
        return {**user, 'nickname': body.nickname}

    @app.post('/api/auth/avatar')
    def upload_avatar(file: UploadFile = File(...), user=Depends(current_user)):
        content = file.file.read(5 * 1024 * 1024 + 1)
        if len(content) > 5 * 1024 * 1024:
            raise HTTPException(413, '头像不得超过 5 MiB')
        picture, *_ = decode_image(content)
        picture = ImageOps.fit(picture.convert('RGB'), (256, 256))
        output = BytesIO()
        picture.save(output, format='JPEG', quality=90)
        version = uuid.uuid4().hex
        with database.connect() as db:
            db.execute('UPDATE users SET avatar=?,avatar_version=? WHERE id=?',
                       (output.getvalue(), version, user['id']))
        return {**user, 'avatar_version': version}

    @app.get('/api/auth/avatar')
    def get_avatar(user=Depends(current_user)):
        with database.connect() as db:
            avatar = db.execute('SELECT avatar FROM users WHERE id=?', (user['id'],)).fetchone()[0]
        if avatar is None:
            raise HTTPException(404, '尚未设置头像')
        return Response(content=avatar, media_type='image/jpeg')

    @app.post('/api/auth/logout')
    def logout(request: Request, response: Response):
        with database.connect() as db:
            db.execute('DELETE FROM ai_grants WHERE owner_id IN (SELECT user_id FROM sessions WHERE token_hash=?)',
                       (token_hash(request.cookies.get(COOKIE, '')),))
            db.execute('DELETE FROM sessions WHERE token_hash=?', (token_hash(request.cookies.get(COOKIE, '')),))
        response.delete_cookie(COOKIE)
        return {'ok': True}

    @app.post('/api/auth/reset-password')
    def reset_password(body: PasswordReset, request: Request, response: Response):
        rate_limit(request)
        with database.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM users WHERE username=?', (body.username.strip(),)).fetchone()
            expected = row['recovery_hash'] if row and row['recovery_hash'] else '0' * 64
            valid = hmac.compare_digest(token_hash(body.recovery_code.strip()), expected)
            if not valid or not row or not row['active']:
                raise HTTPException(400, '用户名或恢复码无效')
            recovery_code = secrets.token_urlsafe(32)
            db.execute('UPDATE users SET password_hash=?,recovery_hash=? WHERE id=?',
                       (password_hash(body.new_password), token_hash(recovery_code), row['id']))
            db.execute('DELETE FROM sessions WHERE user_id=?', (row['id'],))
        response.delete_cookie(COOKIE)
        LOG.info('action=reset_password user=%s rows=1', row['id'])
        return {'ok': True, 'recovery_code': recovery_code}

    @app.post('/api/auth/recovery-code')
    def rotate_recovery(body: RecoveryRotate, request: Request, user=Depends(current_user)):
        rate_limit(request)
        with database.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT password_hash FROM users WHERE id=?', (user['id'],)).fetchone()
            if not hmac.compare_digest(password_hash(body.password, row[0].split(':')[0]), row[0]):
                raise HTTPException(400, '密码不正确')
            code = secrets.token_urlsafe(32)
            db.execute('UPDATE users SET recovery_hash=? WHERE id=?', (token_hash(code), user['id']))
        return {'recovery_code': code}

    def administrator(user=Depends(current_user)):
        if not user['is_admin']:
            raise HTTPException(403, '需要管理员权限')
        return user

    @app.get('/api/admin/users')
    def list_users(admin=Depends(administrator)):
        with database.connect() as db:
            return [dict(r) for r in db.execute('''SELECT u.id,u.username,u.created_at,u.active,u.is_admin,
                count(p.id) photo_count FROM users u LEFT JOIN photos p ON p.owner_id=u.id AND p.status!='deleting'
                GROUP BY u.id ORDER BY u.created_at,u.id''')]

    @app.get('/api/admin/overview')
    def admin_overview(admin=Depends(administrator)):
        with database.connect() as db:
            users = db.execute('SELECT count(*) total,COALESCE(sum(active),0) active FROM users').fetchone()
            photos = db.execute("""SELECT count(*) total,COALESCE(sum(size),0) bytes,
                COALESCE(sum(status='failed'),0) failed FROM photos WHERE status!='deleting'""").fetchone()
        return {'users': dict(users), 'photos': dict(photos), 'model': encoder.status()}

    @app.patch('/api/admin/users/{user_id}')
    def manage_user(user_id: str, body: UserState, admin=Depends(administrator)):
        with database.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT is_admin FROM users WHERE id=?', (user_id,)).fetchone()
            if not row:
                raise HTTPException(404, '用户不存在')
            if row['is_admin']:
                raise HTTPException(409, '不能在页面中停用管理员账户')
            db.execute('UPDATE users SET active=? WHERE id=?', (body.active, user_id))
            if not body.active:
                db.execute('DELETE FROM sessions WHERE user_id=?', (user_id,))
        LOG.info('action=manage_user admin=%s user=%s active=%s rows=1', admin['id'], user_id, body.active)
        return {'ok': True}

    @app.get('/api/auth/me')
    def me(user=Depends(current_user)):
        return user

    @app.get('/api/health')
    def health(user=Depends(current_user)):
        with database.connect() as db:
            counts = {r['status']: r['n'] for r in db.execute(
                'SELECT status,count(*) n FROM photos WHERE owner_id=? GROUP BY status', (user['id'],))}
        return {'model': encoder.status(), 'photos': counts}

    @app.post('/api/albums', status_code=201)
    def add_album(body: AlbumInput, user=Depends(current_user)):
        album_id = uuid.uuid4().hex
        try:
            with database.connect() as db:
                check_album(db, body.parent_id, user['id'])
                db.execute('INSERT INTO albums (id,owner_id,name,parent_id) VALUES (?,?,?,?)', (album_id, user['id'], body.name, body.parent_id))
        except sqlite3.IntegrityError:
            raise HTTPException(409, '同名相册已存在')
        return {'id': album_id, 'name': body.name, 'count': 0}

    @app.get('/api/albums')
    def albums(user=Depends(current_user)):
        with database.connect() as db:
            result = []
            for row in db.execute('''SELECT a.id,a.name,a.parent_id,a.cover_id,count(p.id) count FROM albums a
                LEFT JOIN photos p ON p.album_id=a.id AND p.status!='deleting' AND p.trashed_at IS NULL
                WHERE a.owner_id=? GROUP BY a.id ORDER BY a.name''', (user['id'],)):
                item = dict(row)
                item['previews'] = [p[0] for p in db.execute('''SELECT id FROM photos WHERE album_id=?
                    AND owner_id=? AND trashed_at IS NULL AND status!='deleting'
                    ORDER BY (id=?) DESC,created_at DESC LIMIT 3''', (row['id'], user['id'], row['cover_id']))]
                result.append(item)
            return result

    @app.patch('/api/albums/{album_id}')
    def edit_album(album_id: str, body: AlbumPatch, user=Depends(current_user)):
        fields = body.model_dump(exclude_unset=True)
        with database.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            check_album(db, album_id, user['id'])
            if 'parent_id' in fields:
                check_album(db, fields['parent_id'], user['id'])
                ancestor = fields['parent_id']
                visited = {album_id}
                while ancestor:
                    if ancestor in visited:
                        raise HTTPException(409, '不能把文件夹移入自身或其子文件夹')
                    visited.add(ancestor)
                    ancestor = db.execute('SELECT parent_id FROM albums WHERE id=?', (ancestor,)).fetchone()[0]
            if fields.get('cover_id'):
                photo = owned(db, fields['cover_id'], user['id'])
                if photo['album_id'] != album_id or photo['trashed_at']:
                    raise HTTPException(409, '封面须选择此文件夹内的有效照片')
            if 'name' in fields:
                if not fields['name'] or not fields['name'].strip():
                    raise HTTPException(422, '文件夹名称不能为空')
                fields['name'] = fields['name'].strip()
            try:
                for key, value in fields.items():
                    db.execute(f'UPDATE albums SET {key}=? WHERE id=?', (value, album_id))
            except sqlite3.IntegrityError:
                raise HTTPException(409, '同名文件夹已存在')
        return {'ok': True}

    @app.delete('/api/albums/{album_id}')
    def remove_album(album_id: str, user=Depends(current_user)):
        with database.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            check_album(db, album_id, user['id'])
            parent = db.execute('SELECT parent_id FROM albums WHERE id=?', (album_id,)).fetchone()[0]
            db.execute('UPDATE photos SET album_id=NULL WHERE album_id=? AND owner_id=?', (album_id, user['id']))
            db.execute('UPDATE albums SET parent_id=? WHERE parent_id=? AND owner_id=?', (parent, album_id, user['id']))
            db.execute('DELETE FROM albums WHERE id=? AND owner_id=?', (album_id, user['id']))
        return {'ok': True}

    @app.get('/api/memories/random')
    def random_memory(exclude: str = '', user=Depends(current_user)):
        with database.connect() as db:
            row = db.execute("""SELECT * FROM photos WHERE owner_id=? AND trashed_at IS NULL
                AND status!='deleting' ORDER BY (id=?) ASC,random() LIMIT 1""", (user['id'], exclude)).fetchone()
            if row is None:
                raise HTTPException(404, '还没有可以拾起的回忆，先收藏一些照片吧')
            return photo_dict(db, row)

    @app.post('/api/photos/{photo_id}/restore')
    def restore_photo(photo_id: str, user=Depends(current_user)):
        with database.connect() as db:
            owned(db, photo_id, user['id'])
            db.execute('UPDATE photos SET trashed_at=NULL WHERE id=? AND owner_id=?', (photo_id, user['id']))
        return {'ok': True}

    @app.delete('/api/photos/{photo_id}/permanent', status_code=202)
    def purge_photo(photo_id: str, user=Depends(current_user)):
        with database.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = owned(db, photo_id, user['id'])
            if not row['trashed_at']:
                raise HTTPException(409, '请先将照片移入回收站')
            db.execute("UPDATE photos SET status='deleting',embedding=NULL WHERE id=?", (photo_id,))
        worker.wake.set()
        return {'ok': True}

    @app.get('/api/tags')
    def tags(user=Depends(current_user)):
        with database.connect() as db:
            return [{**dict(r),'color':tag_color_value(r['name'],r['color'])} for r in db.execute('''SELECT t.name,count(*) count,c.color FROM photo_tags t
                JOIN photos p ON p.id=t.photo_id LEFT JOIN tag_colors c ON c.name=t.name AND c.owner_id=p.owner_id
                WHERE p.owner_id=? AND p.status!='deleting' AND p.trashed_at IS NULL
                GROUP BY t.name ORDER BY count DESC,t.name''', (user['id'],))]

    @app.post('/api/photos', status_code=201)
    async def upload(file: UploadFile = File(...), album_id: str | None = Form(None), user=Depends(current_user)):
        data = await read_upload(file)
        name = (file.filename or '未命名照片').replace('\\', '/').split('/')[-1]
        result, duplicate = await run_in_threadpool(save_photo, database, user['id'], name, data, album_id)
        worker.wake.set()
        return {'photo': result, 'duplicate': duplicate}

    @app.get('/api/photos')
    def list_photos(tag: str = '', album_id: str = '', favorite: bool = False, location: str = '',
                    tags: list[str] = Query(default=[], max_length=30), trash: bool = False, tag_expr: str = Query('', max_length=12000),
                    start: date | None = None, end: date | None = None,
                    page: int = Query(1, ge=1), page_size: int = Query(40, ge=1, le=100),
                    order: str = Query('newest', pattern='^(newest|oldest|name_asc|name_desc)$'), user=Depends(current_user)):
        if start and end and start > end:
            raise HTTPException(422, '开始日期不能晚于结束日期')
        where, values = filters(user['id'], tag, album_id, favorite, location, start, end, tags=tags, trash=trash, tag_expr=tag_expr,
                               resolve_search=semantic_resolver(database, encoder, user['id']))
        with database.connect() as db:
            total = db.execute(f'SELECT count(*) FROM photos p WHERE {where}', values).fetchone()[0]
            direction = 'DESC' if order in {'newest','name_desc'} else 'ASC'
            sort_column = 'p.name COLLATE NOCASE' if order.startswith('name_') else 'COALESCE(p.taken_at,p.created_at)'
            rows = db.execute(f'''SELECT p.* FROM photos p WHERE {where}
                ORDER BY {sort_column} {direction},p.id LIMIT ? OFFSET ?''',
                [*values, page_size, (page - 1) * page_size]).fetchall()
            return {'items': [photo_dict(db, r) for r in rows], 'total': total, 'page': page}

    @app.get('/api/photos/{photo_id}')
    def get_photo(photo_id: str, user=Depends(current_user)):
        with database.connect() as db:
            return photo_dict(db, owned(db, photo_id, user['id']))

    @app.get('/api/photos/{photo_id}/file')
    def photo_file(photo_id: str, thumbnail: bool = False, download: bool = False, user=Depends(current_user)):
        with database.connect() as db:
            row = owned(db, photo_id, user['id'])
        path = database.thumbnail(row['id']) if thumbnail else database.original(row['id'])
        if not path.exists():
            raise HTTPException(404, '照片文件暂不可用')
        return FileResponse(path, media_type='image/jpeg' if thumbnail else row['mime'],
                            filename=row['name'] if download else None)

    @app.patch('/api/photos/{photo_id}')
    def patch_photo(photo_id: str, body: PhotoPatch, user=Depends(current_user)):
        fields = body.model_dump(exclude_unset=True)
        if ('latitude' in fields) != ('longitude' in fields) or ((fields.get('latitude') is None) != (fields.get('longitude') is None)):
            raise HTTPException(422, '经纬度须同时填写或清空')
        if 'taken_at' in fields:
            fields['date_source'] = 'manual' if fields['taken_at'] else 'upload'
        with database.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = owned(db, photo_id, user['id'])
            if row['trashed_at']:
                raise HTTPException(409, '请先恢复照片再编辑')
            if 'album_id' in fields:
                check_album(db, fields['album_id'], user['id'])
                fields['album_id'] = fields['album_id'] or None
            manual = fields.pop('tags', None)
            for field, value in fields.items():
                if value is None and field not in {'album_id','taken_at','latitude','longitude'}:
                    raise HTTPException(422, '该字段不可为空')
                if field == 'taken_at' and value is not None:
                    value = value.isoformat()
                db.execute(f'UPDATE photos SET {field}=? WHERE id=? AND owner_id=?', (value, photo_id, user['id']))
            if manual is not None:
                db.execute('UPDATE photos SET tags_edited=1 WHERE id=?', (photo_id,))
                db.execute('DELETE FROM photo_tags WHERE photo_id=?', (photo_id,))
                db.executemany('INSERT INTO photo_tags VALUES (?,?,?,?,NULL)',
                               [(photo_id, name, '自定义', 'manual') for name in manual])
            result = photo_dict(db, owned(db, photo_id, user['id']))
        LOG.info('action=edit user=%s photo=%s rows=1', user['id'], photo_id)
        return result

    @app.delete('/api/photos/{photo_id}', status_code=202)
    def delete_photo(photo_id: str, user=Depends(current_user)):
        with database.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            owned(db, photo_id, user['id'])
            db.execute('UPDATE photos SET trashed_at=COALESCE(trashed_at,?) WHERE id=? AND owner_id=?', (now(), photo_id, user['id']))
        worker.wake.set()
        return {'ok': True}

    @app.post('/api/photos/{photo_id}/retry', status_code=202)
    def retry_photo(photo_id: str, user=Depends(current_user)):
        with database.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = owned(db, photo_id, user['id'])
            if row['trashed_at'] or row['status'] not in {'failed', 'ready'}:
                raise HTTPException(409, '照片已在分析队列中')
            db.execute("UPDATE photos SET status='pending',error=NULL,embedding=NULL WHERE id=?", (photo_id,))
        worker.wake.set()
        return {'ok': True}

    @app.get('/api/photos/{photo_id}/similar')
    def similar(photo_id: str, limit: int = Query(30, ge=1, le=100),
                min_score: float | None = Query(None, ge=-1, le=1), tag_expr: str = Query('', max_length=12000),
                strictness: Literal['broad', 'balanced', 'strict'] = 'balanced',
                tags: list[str] = Query(default=[], max_length=30), album_id: str = '',
                favorite: bool = False, location: str = '', start: date | None = None,
                end: date | None = None, user=Depends(current_user)):
        if start and end and start > end:
            raise HTTPException(422, '开始日期不能晚于结束日期')
        with database.connect() as db:
            row = owned(db, photo_id, user['id'])
        if row['trashed_at'] or row['status'] != 'ready' or row['model_id'] != encoder.model_id:
            raise HTTPException(409, '该照片尚未完成当前模型的分析')
        import numpy as np
        return rank(database, encoder, user['id'], np.frombuffer(row['embedding'], dtype=np.float32),
                    limit=limit, min_score=min_score, mode='image', strictness=strictness,
                    tags=tags, tag_expr=tag_expr, album_id=album_id, favorite=favorite, location=location, start=start, end=end)

    @app.post('/api/search')
    async def search(text: str = Form('', max_length=500), image: UploadFile | None = File(None),
                     limit: int = Form(30, ge=1, le=100),
                     min_score: float | None = Form(None, ge=-1, le=1), tag_expr: str = Form('', max_length=12000), tag: str = Form(''),
                     tags: list[str] = Form(default=[], max_length=30),
                     strictness: Literal['broad', 'balanced', 'strict'] = Form('balanced'),
                     album_id: str = Form(''), favorite: bool = Form(False), location: str = Form(''),
                     start: date | None = Form(None), end: date | None = Form(None), user=Depends(current_user)):
        if start and end and start > end:
            raise HTTPException(422, '开始日期不能晚于结束日期')
        text = text.strip()
        if not text and image is None:
            raise HTTPException(422, '请输入描述或选择参考图片')
        if text and image is not None:
            await image.close()
            raise HTTPException(422, '文搜图和图搜图请分别使用，不能同时提交文字与图片')
        data = await read_upload(image) if image is not None else None

        def execute():
            started = time.perf_counter()
            image_vector = encoder.image(decode_image(data)[0]) if data is not None else None
            text_vector = encoder.text(text) if text else None
            vector = text_vector if image_vector is None else image_vector
            results = rank(database, encoder, user['id'], vector, limit, min_score, tag=tag,
                           album_id=album_id, favorite=favorite, location=location, start=start, end=end,
                           tags=tags, tag_expr=tag_expr, mode='text' if text else 'image', strictness=strictness)
            return {**results, 'elapsed_ms': round((time.perf_counter() - started) * 1000),
                    'mode': 'text' if text else 'image'}

        return await run_in_threadpool(execute)

    @app.get('/api/music/tracks')
    def list_music(user=Depends(current_user)):
        with database.connect() as db:
            return [dict(row) for row in db.execute(
                'SELECT id,name,mime,size,created_at FROM music_tracks WHERE owner_id=? ORDER BY created_at,id',
                (user['id'],))]

    @app.post('/api/music/tracks', status_code=201)
    async def add_music(file: UploadFile = File(...), user=Depends(current_user)):
        data = await read_upload(file)
        if not data or len(data) > 15 * 1024 * 1024:
            raise HTTPException(413, '歌曲不能为空且不得超过 15 MiB')
        suffix = Path(file.filename or '').suffix.lower()
        signatures = {
            '.mp3': ('audio/mpeg', lambda value: value.startswith(b'ID3') or len(value) > 1 and value[0] == 255 and value[1] & 224 == 224),
            '.wav': ('audio/wav', lambda value: value.startswith(b'RIFF') and value[8:12] == b'WAVE'),
            '.ogg': ('audio/ogg', lambda value: value.startswith(b'OggS')),
        }
        if suffix not in signatures or not signatures[suffix][1](data):
            raise HTTPException(415, '仅支持有效的 MP3、WAV、OGG 歌曲')
        track_id = uuid.uuid4().hex
        name = Path(file.filename or '未命名歌曲').stem.strip()[:120] or '未命名歌曲'
        mime = signatures[suffix][0]
        path = database.music_files / track_id
        try:
            with database.connect() as db:
                db.execute('BEGIN IMMEDIATE')
                if db.execute('SELECT count(*) FROM music_tracks WHERE owner_id=?', (user['id'],)).fetchone()[0] >= 50:
                    raise HTTPException(409, '每个账户最多保存 50 首歌曲')
                path.write_bytes(data)
                db.execute('INSERT INTO music_tracks(id,owner_id,name,mime,size,created_at) VALUES(?,?,?,?,?,?)',
                           (track_id,user['id'],name,mime,len(data),now()))
        except Exception:
            path.unlink(missing_ok=True)
            raise
        return {'id': track_id, 'name': name, 'mime': mime, 'size': len(data)}

    @app.get('/api/music/tracks/{track_id}/file')
    def music_file(track_id: str, user=Depends(current_user)):
        with database.connect() as db:
            row = db.execute('SELECT mime FROM music_tracks WHERE id=? AND owner_id=?', (track_id,user['id'])).fetchone()
        if not row:
            raise HTTPException(404, '歌曲不存在')
        path = database.music_files / track_id
        if not path.is_file():
            raise HTTPException(404, '歌曲文件丢失')
        return FileResponse(path, media_type=row['mime'], headers={'Accept-Ranges': 'bytes'})

    @app.delete('/api/music/tracks/{track_id}')
    def delete_music(track_id: str, user=Depends(current_user)):
        with database.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT 1 FROM music_tracks WHERE id=? AND owner_id=?', (track_id,user['id'])).fetchone()
            if not row:
                raise HTTPException(404, '歌曲不存在')
            db.execute('DELETE FROM music_tracks WHERE id=? AND owner_id=?', (track_id,user['id']))
        (database.music_files / track_id).unlink(missing_ok=True)
        return {'ok': True}

    @app.get('/')
    @app.get('/admin')
    def index():
        return FileResponse(ROOT / 'web' / 'index.html')

    from .features import install_features
    install_features(app, database, current_user, administrator, worker, ROOT)

    app.mount('/static', StaticFiles(directory=ROOT / 'web'), name='static')
    return app


app = create_app()
