"""Local operator commands; does not expose an HTTP privilege-escalation endpoint."""
import argparse
import os
from pathlib import Path
import sys
import getpass
import secrets
import uuid
from datetime import datetime, timezone
import hashlib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app.db import Database

parser = argparse.ArgumentParser(description='AIbum 本地账户管理')
parser.add_argument('action', choices=['create-admin', 'make-admin', 'activate'])
parser.add_argument('username')
args = parser.parse_args()
args.username = args.username.strip()
if not args.username or len(args.username) > 20 or any(ord(c) < 32 for c in args.username):
    parser.error('用户名应为 1–20 个字符且不能含控制字符')
database = Database(Path(os.environ.get('AIBUM_DATA_DIR', ROOT / 'data')))
with database.connect() as db:
    row = db.execute('SELECT id FROM users WHERE username=?', (args.username,)).fetchone()
    if args.action == 'create-admin':
        if row:
            parser.error('账户已存在，若需授权请使用 make-admin；不会覆盖原账户密码')
        if not args.username.strip() or len(args.username) > 20:
            parser.error('用户名长度应为 1–20 个字符')
        password = getpass.getpass('Admin password (8-128 characters): ')
        if not 8 <= len(password) <= 128:
            parser.error('密码长度应为 8–128 个字符')
        if getpass.getpass('Confirm password: ') != password:
            parser.error('两次密码不一致')
        salt = secrets.token_hex(16)
        hashed = salt + ':' + hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
        recovery = secrets.token_urlsafe(32)
        db.execute('''INSERT INTO users (id,username,password_hash,created_at,is_admin,recovery_hash)
            VALUES (?,?,?,?,1,?)''', (uuid.uuid4().hex, args.username.strip(), hashed,
            datetime.now(timezone.utc).isoformat(), hashlib.sha256(recovery.encode()).hexdigest()))
        print('Save this one-time recovery code privately: ' + recovery)
    elif row is None:
        parser.error('账户不存在，请先在页面注册')
    elif args.action == 'make-admin':
        db.execute('UPDATE users SET is_admin=1,active=1 WHERE id=?', (row['id'],))
    else:
        db.execute('UPDATE users SET active=1 WHERE id=?', (row['id'],))
print('Account updated. Sign in again to refresh the page.')
