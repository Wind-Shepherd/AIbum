"""Portable, credential-free demo bundles. Never export sessions or password hashes."""
import argparse
import hashlib
import json
import secrets
import shutil
import sqlite3
import sys
import uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from app.db import Database
from app.photos import save_photo,now


def hashed(password):
    salt=secrets.token_hex(16)
    return salt+':'+hashlib.scrypt(password.encode(),salt=bytes.fromhex(salt),n=16384,r=8,p=1).hex()


def export_bundle(source, username, destination):
    if destination.exists() and any(destination.iterdir()):raise ValueError('导出目录非空，请换一个新目录')
    destination.mkdir(parents=True,exist_ok=True);(destination/'photos').mkdir();(destination/'music').mkdir()
    database=Database(source)
    with database.connect() as db:
        user=db.execute('SELECT id FROM users WHERE username=?',(username,)).fetchone()
        if not user:raise ValueError('账户不存在')
        albums=[dict(r) for r in db.execute('SELECT id,name,parent_id,cover_id FROM albums WHERE owner_id=?',(user['id'],))]
        photos=[]
        for row in db.execute("SELECT * FROM photos WHERE owner_id=? AND status!='deleting'",(user['id'],)):
            item={key:row[key] for key in ['id','name','album_id','location','latitude','longitude','story','taken_at','date_source','favorite','trashed_at']}
            item['tags']=[r[0] for r in db.execute('SELECT name FROM photo_tags WHERE photo_id=?',(row['id'],))]
            suffix={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp'}[row['mime']]
            item['file']='photos/'+row['id']+suffix;shutil.copyfile(database.original(row['id']),destination/item['file']);photos.append(item)
        music=[]
        for row in db.execute('SELECT * FROM music_tracks WHERE owner_id=?',(user['id'],)):
            item={'name':row['name'],'mime':row['mime'],'file':'music/'+row['id']};shutil.copyfile(database.music_files/row['id'],destination/item['file']);music.append(item)
        colors=[dict(r) for r in db.execute('SELECT name,color FROM tag_colors WHERE owner_id=?',(user['id'],))]
    payload={'version':1,'note':'私有本地快照；公开前须审核所有照片、故事、定位与音乐权利。账号在导入时重新建立，不含原密码。','albums':albums,'photos':photos,'music':music,'tag_colors':colors}
    (destination/'manifest.json').write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding='utf-8')
    return len(photos),len(music)


def import_bundle(bundle,destination,use_test_account=False):
    if (destination/'album.sqlite3').exists():raise ValueError('目标已有数据库，为避免覆盖，请使用新的目录')
    payload=json.loads((bundle/'manifest.json').read_text(encoding='utf-8'))
    def safe_file(name):
        path=(bundle/name).resolve()
        if not path.is_relative_to(bundle.resolve()) or not path.is_file():raise ValueError('无效素材路径')
        return path
    # Validate paths before creating anything.
    for item in [*payload['photos'],*payload['music']]:safe_file(item['file'])
    database=Database(destination);owner=uuid.uuid4().hex;admin=uuid.uuid4().hex;mapping={}
    with database.connect() as db:
        for uid,name,password,role in [(owner,'test' if use_test_account else 'demo','123456789' if use_test_account else 'DemoAlbum2026!',0),(admin,'demo_admin','DemoAdmin2026!',1)]:
            db.execute('INSERT INTO users(id,username,password_hash,created_at,is_admin) VALUES(?,?,?,?,?)',(uid,name,hashed(password),now(),role))
        for album in payload['albums']:
            mapping[album['id']]=uuid.uuid4().hex
        pending=list(payload['albums']);created=set()
        while pending:
            ready=[a for a in pending if not a['parent_id'] or a['parent_id'] in created]
            if not ready:raise ValueError('文件夹存在循环或缺失父目录')
            for album in ready:
                db.execute('INSERT INTO albums(id,owner_id,name,parent_id) VALUES(?,?,?,?)',(mapping[album['id']],owner,album['name'],mapping.get(album['parent_id'])))
                created.add(album['id']);pending.remove(album)
    photo_map={}
    for item in payload['photos']:
        photo,_=save_photo(database,owner,item['name'],safe_file(item['file']).read_bytes(),mapping.get(item.get('album_id')))
        photo_map[item['id']]=photo['id']
        with database.connect() as db:
            for key in ['location','latitude','longitude','story','taken_at','date_source','favorite','trashed_at']:
                if key in item:db.execute(f'UPDATE photos SET {key}=? WHERE id=?',(item[key],photo['id']))
            if item.get('tags'):
                db.execute('UPDATE photos SET tags_edited=1 WHERE id=?',(photo['id'],))
                db.executemany('INSERT INTO photo_tags VALUES(?,?,?,?,NULL)',[(photo['id'],name,'演示','manual') for name in dict.fromkeys(item['tags'])])
    with database.connect() as db:
        for album in payload['albums']:
            if album.get('cover_id') in photo_map:db.execute('UPDATE albums SET cover_id=? WHERE id=?',(photo_map[album['cover_id']],mapping[album['id']]))
        for item in payload.get('tag_colors',[]):db.execute('INSERT OR REPLACE INTO tag_colors VALUES(?,?,?)',(owner,item['name'],item['color']))
        for item in payload['music']:
            track=uuid.uuid4().hex;content=safe_file(item['file']).read_bytes();(database.music_files/track).write_bytes(content)
            db.execute('INSERT INTO music_tracks VALUES(?,?,?,?,?,?)',(track,owner,item['name'],item['mime'],len(content),now()))
    return len(payload['photos'])


def main():
    parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='action',required=True)
    export=sub.add_parser('export');export.add_argument('--source',type=Path,default=ROOT/'data');export.add_argument('--username',required=True);export.add_argument('--output',type=Path,required=True)
    restore=sub.add_parser('import');restore.add_argument('--bundle',type=Path,default=ROOT/'demo');restore.add_argument('--output',type=Path,required=True)
    restore.add_argument('--use-test-account',action='store_true',help='创建公开协作账号 test / 123456789；仅用于隔离开发库')
    args=parser.parse_args()
    if args.action=='export':print('Exported photos/music:',export_bundle(args.source,args.username,args.output))
    else:
        print('Imported photos:',import_bundle(args.bundle,args.output,args.use_test_account))
        print('Demo accounts:', 'test / 123456789' if args.use_test_account else 'demo / DemoAlbum2026!', '; demo_admin / DemoAdmin2026!')

if __name__=='__main__':main()
