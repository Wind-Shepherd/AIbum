from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import hashlib
import time

import numpy as np
from PIL import Image
import pytest
from fastapi.testclient import TestClient

from app.encoder import ChineseClipEncoder
from app.main import create_app
from app.photos import AnalysisWorker

HEADERS = {'X-AIbum-Request': '1'}
PASSWORD = 'test-password-123'


def test_create_admin_command(tmp_path, monkeypatch, capsys):
    import runpy
    import sys
    from pathlib import Path
    monkeypatch.setenv('AIBUM_DATA_DIR', str(tmp_path))
    monkeypatch.setattr(sys, 'argv', ['manage.py', 'create-admin', '  admin  '])
    monkeypatch.setattr('getpass.getpass', lambda prompt: PASSWORD)
    script = str(Path(__file__).resolve().parents[1] / 'scripts' / 'manage.py')
    runpy.run_path(script, run_name='__main__')
    output = capsys.readouterr().out
    assert 'recovery code' in output
    app = create_app(tmp_path, encoder=TestEncoder(), start_worker=False)
    with TestClient(app, headers=HEADERS) as client:
        response = client.post('/api/admin/login', json={'username': 'admin', 'password': PASSWORD})
        assert response.status_code == 200
        assert response.json()['is_admin']
        assert client.get('/api/admin/overview').status_code == 200
    with pytest.raises(SystemExit):
        runpy.run_path(script, run_name='__main__')


class TestEncoder:
    """Deterministic test double: proves plumbing, never model quality."""
    __test__ = False
    model_id = 'test-colors-v1'

    def image(self, image):
        return np.array(image.resize((1, 1)).getpixel((0, 0)), dtype=np.float32) + .001

    def text(self, text):
        return np.array([1., 0., 0.], dtype=np.float32)

    def tags(self, vector):
        return [{'name': '测试标签', 'kind': '物体', 'score': .8}]

    def status(self):
        return {'installed': True, 'ready': True, 'model': self.model_id}


def picture(color='red', size=(32, 24)):
    data = BytesIO()
    Image.new('RGB', size, color).save(data, 'PNG')
    return data.getvalue()


def test_personal_profile_avatar_isolation_and_persistence(tmp_path):
    app = create_app(tmp_path, encoder=TestEncoder(), start_worker=False)
    with TestClient(app, headers=HEADERS) as client:
        signup(client, 'profile_owner')
        assert client.get('/api/auth/avatar').status_code == 404
        assert client.patch('/api/auth/profile', json={'nickname':'  时光收藏家  '}).json()['nickname'] == '时光收藏家'
        assert client.patch('/api/auth/profile', json={'nickname':'x'*31}).status_code == 422
        assert client.patch('/api/auth/profile', json={'nickname':'bad\nname'}).status_code == 422
        assert client.post('/api/auth/avatar', files={'file':('bad.png',b'not an image')}).status_code == 415
        assert client.post('/api/auth/avatar', files={'file':('big.png',b'x'*(5*1024*1024+1))}).status_code == 413
        response = client.post('/api/auth/avatar', files={'file':('portrait.png',picture(size=(160,80)))})
        assert response.status_code == 200
        version = response.json()['avatar_version']
        avatar = client.get('/api/auth/avatar')
        assert avatar.headers['content-type'] == 'image/jpeg'
        assert avatar.headers['cache-control'] == 'no-store'
        assert Image.open(BytesIO(avatar.content)).size == (256,256)
        client.post('/api/auth/logout')
        assert client.get('/api/auth/avatar').status_code == 401
        signup(client, 'other_profile')
        assert client.get('/api/auth/avatar').status_code == 404
        assert client.get('/api/auth/me').json()['nickname'] == ''
    reopened = create_app(tmp_path, encoder=TestEncoder(), start_worker=False)
    with TestClient(reopened, headers=HEADERS) as client:
        user = client.post('/api/auth/login', json={'username':'profile_owner','password':PASSWORD}).json()
        assert user['nickname'] == '时光收藏家' and user['avatar_version'] == version
        assert client.get('/api/auth/avatar').status_code == 200


def signup(client, name='alice'):
    response = client.post('/api/auth/register', json={'username': name, 'password': PASSWORD})
    assert response.status_code == 201, response.text
    return response.json()


def upload(client, color='red', **fields):
    response = client.post('/api/photos', files={'file': ('photo.png', picture(color), 'image/png')}, data=fields)
    assert response.status_code == 201, response.text
    return response.json()


@pytest.fixture
def env(tmp_path):
    app = create_app(tmp_path, TestEncoder(), start_worker=False)
    with TestClient(app, headers=HEADERS) as client:
        yield app, client


def test_auth_password_revoke_and_recovery(env):
    app, client = env
    user = signup(client)
    assert len(user['recovery_code']) > 30
    token = client.cookies.get('aibum_session')
    assert client.post('/api/auth/register', json={'username': 'alice', 'password': PASSWORD}).status_code == 409
    assert client.post('/api/auth/password', json={'current_password': 'wrong-pass', 'new_password': 'new-password'}).status_code == 400
    assert client.post('/api/auth/password', json={'current_password': PASSWORD, 'new_password': 'new-password'}).status_code == 200
    assert client.get('/api/auth/me').status_code == 401
    client.cookies.set('aibum_session', token)
    assert client.get('/api/auth/me').status_code == 401
    assert client.post('/api/auth/login', json={'username': 'alice', 'password': PASSWORD}).status_code == 401
    reset = client.post('/api/auth/reset-password', json={'username': 'alice', 'recovery_code': user['recovery_code'], 'new_password': PASSWORD})
    assert reset.status_code == 200
    assert reset.json()['recovery_code'] != user['recovery_code']
    assert client.post('/api/auth/reset-password', json={'username': 'alice', 'recovery_code': user['recovery_code'], 'new_password': PASSWORD}).status_code == 400
    assert client.post('/api/auth/login', json={'username': 'alice', 'password': PASSWORD}).status_code == 200
    assert client.post('/api/auth/logout').status_code == 200
    assert client.get('/api/auth/me').status_code == 401
    with app.state.database.connect() as db:
        row = db.execute('SELECT * FROM users').fetchone()
        assert PASSWORD not in row['password_hash']
        assert row['recovery_hash'] == hashlib.sha256(reset.json()['recovery_code'].encode()).hexdigest()


def test_photo_lifecycle_and_manual_tags(env):
    app, client = env
    signup(client)
    photo = upload(client)['photo']
    assert upload(client)['duplicate'] is True
    assert client.get(photo['original_url']).content == picture()
    assert client.get(photo['thumbnail_url']).headers['content-type'] == 'image/jpeg'
    assert app.state.worker.step()
    detail = client.get('/api/photos/' + photo['id']).json()
    assert detail['status'] == 'ready' and detail['tags'][0]['source'] == 'auto'
    album = client.post('/api/albums', json={'name': '旅行'}).json()
    patch = client.patch('/api/photos/' + photo['id'], json={'name': '假期', 'tags': ['旅行', '旅行'], 'favorite': True, 'album_id': album['id'], 'location': '北京'})
    assert patch.status_code == 200
    assert len(patch.json()['tags']) == 1
    query = client.get('/api/photos', params={'tag': '旅行', 'album_id': album['id'], 'favorite': True, 'location': '北京'})
    assert query.json()['total'] == 1
    assert client.get('/api/photos?start=2100-01-01').json()['total'] == 0
    assert client.get('/api/photos?start=2030-01-01&end=2020-01-01').status_code == 422
    client.patch('/api/photos/' + photo['id'], json={'tags': []})
    client.post('/api/photos/' + photo['id'] + '/retry')
    app.state.worker.step()
    assert client.get('/api/photos/' + photo['id']).json()['tags'] == []
    assert client.delete('/api/photos/' + photo['id']).status_code == 202
    assert client.get(photo['original_url']).status_code == 200
    assert client.get('/api/photos').json()['total'] == 0
    assert client.get('/api/photos?trash=true').json()['total'] == 1
    assert client.delete('/api/photos/' + photo['id'] + '/permanent').status_code == 202
    assert client.get(photo['original_url']).status_code == 404
    assert client.get('/api/photos').json()['total'] == 0
    app.state.worker.step()
    assert not app.state.database.original(photo['id']).exists()
    assert not app.state.database.thumbnail(photo['id']).exists()


def test_all_resources_are_private_including_admin(env):
    app, alice = env
    signup(alice)
    photo = upload(alice)['photo']
    album = alice.post('/api/albums', json={'name': '私有'}).json()
    app.state.worker.step()
    with TestClient(app, headers=HEADERS) as bob:
        user = signup(bob, 'bob')
        for path in ['', '/file', '/file?thumbnail=true', '/similar']:
            assert bob.get('/api/photos/' + photo['id'] + path).status_code == 404
        assert bob.patch('/api/photos/' + photo['id'], json={'name': 'stolen'}).status_code == 404
        assert bob.delete('/api/photos/' + photo['id']).status_code == 404
        assert bob.post('/api/photos/' + photo['id'] + '/retry').status_code == 404
        assert bob.get('/api/tags').json() == []
        assert bob.get('/api/albums').json() == []
        assert bob.post('/api/search', data={'text': '红色'}).json()['items'] == []
        assert bob.post('/api/photos', files={'file': ('x.png', picture())}, data={'album_id': album['id']}).status_code == 404
        assert upload(bob)['duplicate'] is False
        assert bob.get('/api/admin/users').status_code == 403
        with app.state.database.connect() as db:
            db.execute('UPDATE users SET is_admin=1 WHERE id=?', (user['id'],))
        assert bob.get('/api/admin/users').status_code == 200
        assert bob.get(photo['original_url']).status_code == 404
    with TestClient(app) as anonymous:
        assert anonymous.get(photo['thumbnail_url']).status_code == 401


def test_search_and_no_fusion(env):
    app, client = env
    signup(client)
    red = upload(client, 'red')['photo']
    blue = upload(client, 'blue')['photo']
    while app.state.worker.step():
        pass
    response = client.post('/api/search', data={'text': '红色'}).json()
    results = response['items']
    assert [r['id'] for r in results] == [red['id']]
    assert response['filtered_count'] == 1 and response['candidate_count'] == 2
    results = client.post('/api/search', files={'image': ('ref.png', picture('blue'))}).json()['items']
    assert results[0]['id'] == blue['id']
    assert [item['id'] for item in client.get(f'/api/photos/{red["id"]}/similar').json()['items']] == [red['id']]
    assert client.post('/api/search', data={'text': 'x'}, files={'image': ('x.png', picture())}).status_code == 422
    assert client.post('/api/search', data={'text': ' '}).status_code == 422
    assert client.post('/api/search', data={'text': 'x', 'tag': '没有'}).json()['items'] == []
    assert client.post('/api/search', data={'text': 'x', 'min_score': 'nan'}).status_code == 422


def test_relevance_floor_gap_and_strictness(env):
    app, client = env
    signup(client)
    ids = [upload(client, color)['photo']['id'] for color in ('red', 'green', 'blue')]
    while app.state.worker.step():
        pass
    with app.state.database.connect() as db:
        for photo_id, score in zip(ids, [.44, .38, .29]):
            vector = np.array([score, np.sqrt(1-score**2), 0], dtype=np.float32)
            db.execute('UPDATE photos SET embedding=? WHERE id=?', (vector.tobytes(), photo_id))
    broad = client.post('/api/search', data={'text': '测试', 'strictness': 'broad'}).json()
    balanced = client.post('/api/search', data={'text': '测试'}).json()
    assert len(broad['items']) == 2 and len(balanced['items']) == 1
    assert balanced['items'][0]['score'] == pytest.approx(.44)
    assert len(client.post('/api/search',data={'text':'测试','min_score':'.35'}).json()['items']) == 2
    assert len(client.post('/api/search',data={'text':'测试','min_score':'.2'}).json()['items']) == 3
    with app.state.database.connect() as db:
        vector = np.array([.20, np.sqrt(.96), 0], dtype=np.float32)
        db.execute('UPDATE photos SET embedding=?', (vector.tobytes(),))
    assert client.post('/api/search', data={'text': '无关'}).json()['items'] == []
    assert client.post('/api/search', data={'text': 'x', 'strictness': 'invalid'}).status_code == 422


def test_private_music_playlist(tmp_path):
    import wave
    sound = BytesIO()
    with wave.open(sound,'wb') as wav:
        wav.setnchannels(1); wav.setsampwidth(1); wav.setframerate(8000); wav.writeframes(b'\x80'*800)
    app = create_app(tmp_path, encoder=TestEncoder(), start_worker=False)
    with TestClient(app, headers=HEADERS) as alice, TestClient(app, headers=HEADERS) as bob:
        signup(alice,'music_alice'); signup(bob,'music_bob')
        assert alice.post('/api/music/tracks',files={'file':('bad.wav',b'not music')}).status_code == 415
        added = alice.post('/api/music/tracks',files={'file':('Afternoon.wav',sound.getvalue())})
        assert added.status_code == 201
        track = added.json()
        assert [item['id'] for item in alice.get('/api/music/tracks').json()] == [track['id']]
        assert bob.get('/api/music/tracks').json() == []
        url = f"/api/music/tracks/{track['id']}/file"
        assert alice.get(url).content == sound.getvalue()
        assert bob.get(url).status_code == 404
        assert bob.delete(f"/api/music/tracks/{track['id']}").status_code == 404
        assert alice.delete(f"/api/music/tracks/{track['id']}").status_code == 200
        assert alice.get(url).status_code == 404


def test_tag_checkboxes_match_any_selected_and_admin_entry(env):
    app, client = env
    user = signup(client)
    red, blue = upload(client)['photo'], upload(client, 'blue')['photo']
    client.patch('/api/photos/' + red['id'], json={'tags': ['猫']})
    client.patch('/api/photos/' + blue['id'], json={'tags': ['风景']})
    assert client.get('/api/photos', params={'tags': ['猫','风景']}).json()['total'] == 2
    assert client.get('/api/photos', params={'tags': ['猫']}).json()['total'] == 1
    client.post('/api/auth/logout')
    assert client.post('/api/admin/login', json={'username':'alice','password':PASSWORD}).status_code == 403
    assert client.get('/api/auth/me').status_code == 401
    assert client.get('/api/admin/overview').status_code == 401
    with app.state.database.connect() as db:
        db.execute('UPDATE users SET is_admin=1 WHERE id=?', (user['id'],))
    assert client.post('/api/admin/login', json={'username':'alice','password':PASSWORD}).status_code == 200
    overview = client.get('/api/admin/overview').json()
    assert overview['users']['total'] == 1 and overview['photos']['total'] == 2
    assert client.get('/admin').status_code == 200


def test_invalid_inputs_and_csrf(env):
    app, client = env
    signup(client)
    assert client.post('/api/photos', files={'file': ('evil.jpg', b'<script>1</script>')}).status_code == 415
    assert client.post('/api/photos', files={'file': ('bad.png', picture()[:20])}).status_code == 415
    assert client.post('/api/photos', files={'file': ('empty.png', b'')}).status_code == 413
    assert client.post('/api/auth/logout', headers={'X-AIbum-Request': ''}).status_code == 403
    assert client.post('/api/auth/logout', headers={'Origin': 'https://evil.example'}).status_code == 403
    assert client.post('/api/photos', content=b'0', headers={'Content-Length': str(22*1024*1024)}).status_code == 413
    assert client.get('/api/photos?page=0').status_code == 422
    assert client.get('/api/photos', headers={'Host': 'evil.example'}).status_code == 400


def test_model_failure_and_retry(env, tmp_path):
    app, client = env
    signup(client)
    photo = upload(client)['photo']
    missing = ChineseClipEncoder()
    missing.path = tmp_path / 'no-model'
    app.state.worker.encoder = missing
    app.state.worker.step()
    assert client.get('/api/photos/' + photo['id']).json()['status'] == 'failed'
    assert client.get(photo['original_url']).status_code == 200
    app.state.worker.encoder = app.state.encoder
    assert client.post('/api/photos/' + photo['id'] + '/retry').status_code == 202
    app.state.worker.step()
    assert client.get('/api/photos/' + photo['id']).json()['status'] == 'ready'
    missing_app = create_app(tmp_path / 'missing', missing, start_worker=False)
    with TestClient(missing_app, headers=HEADERS) as other:
        signup(other)
        assert other.post('/api/search', data={'text': '猫'}).status_code == 503


def test_worker_restart(env):
    app, client = env
    signup(client)
    photo = upload(client)['photo']
    with app.state.database.connect() as db:
        db.execute("UPDATE photos SET status='processing' WHERE id=?", (photo['id'],))
    worker = AnalysisWorker(app.state.database, app.state.encoder)
    worker.start()
    try:
        for _ in range(100):
            if client.get('/api/photos/' + photo['id']).json()['status'] == 'ready':
                break
            time.sleep(.02)
        assert client.get('/api/photos/' + photo['id']).json()['status'] == 'ready'
    finally:
        worker.close()


def test_admin_suspend_revokes_sessions(env):
    app, admin = env
    user = signup(admin)
    with app.state.database.connect() as db:
        db.execute('UPDATE users SET is_admin=1 WHERE id=?', (user['id'],))
    with TestClient(app, headers=HEADERS) as bob:
        target = signup(bob, 'bob')
        assert admin.patch('/api/admin/users/' + target['id'], json={'active': False}).status_code == 200
        assert bob.get('/api/auth/me').status_code == 401
        assert bob.post('/api/auth/login', json={'username': 'bob', 'password': PASSWORD}).status_code == 401
        assert admin.patch('/api/admin/users/' + user['id'], json={'active': False}).status_code == 409
        assert admin.patch('/api/admin/users/' + target['id'], json={'active': True}).status_code == 200
        assert bob.post('/api/auth/login', json={'username': 'bob', 'password': PASSWORD}).status_code == 200


def test_concurrent_dedup_and_quota(env):
    app, client = env
    user = signup(client)
    from app.photos import save_photo
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: save_photo(app.state.database, user['id'], 'x.png', picture()), range(4)))
    assert sum(not duplicate for _, duplicate in results) == 1
    assert len(list(app.state.database.files.iterdir())) == 2
    with app.state.database.connect() as db:
        for i in range(499):
            db.execute('''INSERT INTO photos (id,owner_id,name,sha256,mime,size,width,height,created_at)
                VALUES (?,?,?,?,?,?,?,?,?)''', (f'quota-{i}', user['id'], 'x', str(i), 'image/png', 1, 1, 1, '2026-10-10'))
    assert upload(client)['duplicate'] is True
    assert client.post('/api/photos', files={'file': ('b.png', picture('blue'))}).status_code == 409
    assert len(list(app.state.database.files.iterdir())) == 2


def test_folders_stories_trash_and_random(env):
    app, client = env
    signup(client)
    root = client.post('/api/albums', json={'name':'Chapter'}).json()['id']
    child = client.post('/api/albums', json={'name':'Page', 'parent_id':root}).json()['id']
    assert client.patch('/api/albums/'+root,json={'parent_id':child}).status_code == 409
    assert client.patch('/api/albums/'+root,json={'parent_id':root}).status_code == 409
    assert client.patch('/api/albums/'+root,json={'name':'   '}).status_code == 422
    photo = upload(client)['photo']; pid = photo['id']
    other = upload(client,'blue')['photo']; oid = other['id']
    app.state.worker.step(); app.state.worker.step()
    patch = client.patch('/api/photos/'+pid,json={'album_id':child,'story':'那年夏天\n风轻轻地吹','taken_at':'2020-06-20'})
    assert patch.status_code == 200 and patch.json()['taken_at'] == '2020-06-20'
    assert client.patch('/api/photos/'+pid,json={'taken_at':'2020-99-99'}).status_code == 422
    assert client.patch('/api/photos/'+pid,json={'story':'字'*4001}).status_code == 422
    assert client.patch('/api/albums/'+child,json={'cover_id':oid}).status_code == 409
    assert client.patch('/api/albums/'+child,json={'cover_id':pid}).status_code == 200
    assert next(a for a in client.get('/api/albums').json() if a['id']==child)['previews'][0] == pid
    assert client.get('/api/memories/random?exclude='+pid).json()['id'] == oid
    assert client.delete('/api/photos/'+pid+'/permanent').status_code == 409
    client.delete('/api/photos/'+pid)
    assert client.get('/api/photos?trash=true').json()['items'][0]['story'] == '那年夏天\n风轻轻地吹'
    assert client.get('/api/photos').json()['total'] == 1
    assert client.get('/api/memories/random').json()['id'] == oid
    assert all(p['id']!=pid for p in client.post('/api/search',data={'text':'red'}).json()['items'])
    assert client.patch('/api/photos/'+pid,json={'story':'overwrite'}).status_code == 409
    assert client.post('/api/photos/'+pid+'/retry').status_code == 409
    assert upload_duplicate_status(client) == 409
    assert client.delete('/api/albums/'+root).status_code == 200
    assert next(a for a in client.get('/api/albums').json() if a['id']==child)['parent_id'] is None
    assert client.delete('/api/albums/'+child).status_code == 200
    assert client.post('/api/photos/'+pid+'/restore').status_code == 200
    restored=client.get('/api/photos/'+pid).json()
    assert restored['album_id'] is None and restored['story'].startswith('那年夏天') and restored['taken_at']=='2020-06-20'
    assert client.get(photo['original_url']).content == picture()
    assert client.patch('/api/photos/'+pid,json={'taken_at':None}).status_code == 200
    with TestClient(app, headers=HEADERS) as second:
        signup(second,'folder_intruder')
        for path in ['/restore']:
            assert second.post('/api/photos/'+pid+path).status_code == 404
        assert second.delete('/api/photos/'+pid+'/permanent').status_code == 404
        assert second.get('/api/memories/random').status_code == 404
        ownfolder=second.post('/api/albums',json={'name':'Private'}).json()['id']
        assert client.patch('/api/photos/'+pid,json={'album_id':ownfolder}).status_code == 404
        assert client.patch('/api/albums/'+ownfolder,json={'name':'Steal'}).status_code == 404


def upload_duplicate_status(client):
    return client.post('/api/photos',files={'file':('same.png',picture(),'image/png')}).status_code
