import json
import zipfile
from io import BytesIO
import pytest
from test_app import env, signup, upload, picture, HEADERS, PASSWORD
from fastapi.testclient import TestClient


def test_visual_logic_filters_search_and_browse(env):
    app, client = env
    signup(client)
    a,b,c=[upload(client,color)['photo']['id'] for color in ['red','green','blue']]
    for pid,tags in [(a,['城市','夜景']),(b,['城市','人物']),(c,['夜景'])]:
        assert client.patch('/api/photos/'+pid,json={'tags':tags}).status_code==200
    tree={'op':'subtract','left':{'op':'union','left':{'tag':'城市'},'right':{'tag':'夜景'}},'right':{'tag':'人物'}}
    raw=json.dumps(tree)
    assert {p['id'] for p in client.get('/api/photos',params={'tag_expr':raw}).json()['items']}=={a,c}
    while app.state.worker.step(): pass
    search=client.post('/api/search',data={'text':'red','min_score':'-1','tag_expr':raw})
    assert search.status_code==200
    assert {p['id'] for p in search.json()['items']}=={a,c}
    assert client.get('/api/photos',params={'tag_expr':'{"op":"SQL"}'}).status_code==422
    assert client.get('/api/photos',params={'tag_expr':json.dumps({'tag':"' OR 1=1 --"})}).json()['total']==0


def test_archive_tree_names_and_private_scope(env):
    _,client=env; signup(client)
    parent=client.post('/api/albums',json={'name':'旅途'}).json()['id']
    child=client.post('/api/albums',json={'name':'上午','parent_id':parent}).json()['id']
    other=client.post('/api/albums',json={'name':'另一天'}).json()['id']
    assert client.post('/api/albums',json={'name':'上午','parent_id':other}).status_code==201
    assert client.post('/api/albums',json={'name':'上午','parent_id':parent}).status_code==409
    upload(client,album_id=child)
    response=client.post('/api/photos/download',json={'album_ids':[parent]})
    assert response.status_code==200
    with zipfile.ZipFile(BytesIO(response.content)) as archive:
        assert '旅途/上午/photo.png' in archive.namelist()
        assert archive.read('旅途/上午/photo.png')==picture()
    collisions=[]
    for name,color in [('folder?', 'green'),('folder*', 'blue')]:
        folder=client.post('/api/albums',json={'name':name}).json()['id'];collisions.append(folder)
        upload(client,color,album_id=folder)
    packed=client.post('/api/photos/download',json={'album_ids':collisions})
    with zipfile.ZipFile(BytesIO(packed.content)) as archive:
        dirs={name.split('/')[0] for name in archive.namelist()}
        assert dirs=={'folder_','folder_-1'}
    client.post('/api/auth/logout');signup(client,'other')
    assert client.post('/api/photos/download',json={'album_ids':[parent]}).status_code==404


def test_coordinates_colors_and_name_sort(env):
    _,client=env;signup(client)
    a=upload(client)['photo']['id'];b=upload(client,'blue')['photo']['id']
    assert client.patch('/api/photos/'+a,json={'latitude':30}).status_code==422
    assert client.patch('/api/photos/'+a,json={'latitude':90.1,'longitude':0}).status_code==422
    assert client.patch('/api/photos/'+a,json={'latitude':30,'longitude':120,'tags':['旅途'],'name':'z.png'}).status_code==200
    assert client.put('/api/tag-colors/旅途',json={'color':'#8ab0d8'}).status_code==200
    assert client.get('/api/photos/'+a).json()['tags'][0]['color']=='#8AB0D8'
    assert client.put('/api/tag-colors/旅途',json={'color':'#abcdef'}).status_code==422
    assert client.patch('/api/photos/'+b,json={'name':'a.png'}).status_code==200
    assert client.get('/api/photos?order=name_asc').json()['items'][0]['id']==b
    assert client.get('/api/photos?order=name_desc').json()['items'][0]['id']==a


def test_feedback_claim_resolve_attachment_and_privacy(env):
    app,client=env;owner=signup(client)
    ticket=client.post('/api/feedback',json={'title':'测试问题','body':'描述'}).json()['id']
    image=client.post('/api/feedback/'+ticket+'/images',files={'file':('screen.png',picture(),'image/png')}).json()['id']
    client.post('/api/auth/logout');signup(client,'other')
    assert client.get('/api/feedback/images/'+image).status_code==404
    assert client.patch('/api/admin/feedback/'+ticket,json={'action':'claim'}).status_code==403
    client.post('/api/auth/logout');admin=signup(client,'operator')
    with app.state.database.connect() as db: db.execute('UPDATE users SET is_admin=1 WHERE id=?',(admin['id'],))
    assert client.patch('/api/admin/feedback/'+ticket,json={'action':'resolve','reply':'修复了'}).status_code==409
    assert client.patch('/api/admin/feedback/'+ticket,json={'action':'claim'}).status_code==200
    assert client.post('/api/feedback/'+ticket+'/images',data={'is_reply':'true'},files={'file':('fixed.png',picture(),'image/png')}).status_code==201
    assert client.patch('/api/admin/feedback/'+ticket,json={'action':'resolve','reply':'问题已经修复'}).status_code==200
    item=client.get('/api/feedback').json()[0]
    assert item['claimed_by']==admin['id'] and item['resolved_at'] and item['unread']
    assert client.get('/api/feedback?mine=true').json()==[]
    client.post('/api/auth/logout');client.post('/api/auth/login',json={'username':'alice','password':PASSWORD})
    assert client.get('/api/feedback').json()[0]['reply']=='问题已经修复'
    assert client.post('/api/feedback/'+ticket+'/read').status_code==200
    assert client.get('/api/feedback').json()[0]['unread']==0


def test_ai_authorization_scope_revocation_and_unconfigured(env,monkeypatch):
    _,client=env;signup(client)
    for key in ['AIBUM_AI_URL','AIBUM_AI_KEY','AIBUM_AI_MODEL']:monkeypatch.setenv(key,'')
    a=upload(client)['photo']['id'];b=upload(client,'blue')['photo']['id']
    grant=client.post('/api/ai/grants',json={'photo_ids':[a]}).json()['id']
    payload={'grant_id':grant,'photo_ids':[b],'message':'聊聊'}
    assert client.post('/api/ai/chat',json=payload).status_code==403
    payload['photo_ids']=[a]
    assert client.post('/api/ai/chat',json=payload).status_code==503
    assert client.delete('/api/ai/grants/'+grant).status_code==200
    assert client.post('/api/ai/chat',json=payload).status_code==403
    client.post('/api/auth/logout');signup(client,'other')
    assert client.post('/api/ai/grants',json={'photo_ids':[a]}).status_code==404


def test_mixed_conditions_complement_and_semantic_scope(env):
    app,client=env;signup(client)
    a,b,c=[upload(client,color)['photo']['id'] for color in ['red','green','blue']]
    client.patch('/api/photos/'+a,json={'location':'北京','latitude':39.9,'longitude':116.4,'favorite':True,'story':'那天的海风','name':'weekend.png'})
    client.patch('/api/photos/'+b,json={'location':'上海','favorite':True,'story':'去散步'})
    def results(tree):
        response=client.get('/api/photos',params={'tag_expr':json.dumps(tree)})
        assert response.status_code==200,response.text
        return {p['id'] for p in response.json()['items']}
    assert results({'op':'intersect','left':{'field':'favorite','value':True},'right':{'op':'not','child':{'field':'story','value':'散步'}}})=={a}
    assert results({'field':'place','value':[39.9,116.4]})=={a}
    assert results({'op':'not','child':{'field':'place','value':[39.9,116.4]}})=={b,c}
    assert results({'field':'name','value':'WEEK'})=={a}
    assert results({'field':'unlocated','value':True})=={b,c}
    while app.state.worker.step():pass
    assert results({'field':'search','value':'red','score':.9})=={a}
    for malformed in [{'field':[],'value':'x'},{'op':[],'left':{},'right':{}},{'field':'place','value':[1000,0]}]:
        assert client.get('/api/photos',params={'tag_expr':json.dumps(malformed)}).status_code==422
    # Complement remains inside the authenticated owner's library.
    client.post('/api/auth/logout');signup(client,'other')
    assert results({'op':'not','child':{'field':'favorite','value':True}})==set()


def test_excel_export_is_admin_only_and_literal(env):
    app,client=env;user=signup(client)
    assert client.get('/api/admin/export').status_code==403
    client.post('/api/feedback',json={'title':'=HYPERLINK("evil")','body':'<内容>'})
    with app.state.database.connect() as db:db.execute('UPDATE users SET is_admin=1 WHERE id=?',(user['id'],))
    response=client.get('/api/admin/export')
    assert response.status_code==200
    with zipfile.ZipFile(BytesIO(response.content)) as archive:
        assert len([n for n in archive.namelist() if n.startswith('xl/worksheets/')])==6
        sheet=archive.read('xl/worksheets/sheet4.xml').decode()
        assert '=HYPERLINK' in sheet and '<f>' not in sheet and '&lt;内容&gt;' in sheet
        assert 'password_hash' not in ''.join(archive.read(n).decode() for n in archive.namelist())


def test_ai_outgoing_images_explicit_and_logout_revokes(env,monkeypatch):
    _,client=env;signup(client)
    for k,v in {'AIBUM_AI_URL':'https://example.invalid/chat/completions','AIBUM_AI_KEY':'test-key','AIBUM_AI_MODEL':'test-vision'}.items():monkeypatch.setenv(k,v)
    a=upload(client)['photo']['id'];upload(client,'blue')
    grant=client.post('/api/ai/grants',json={'photo_ids':[a]}).json()['id']
    captured=[]
    def fake(request,timeout):
        captured.append(json.loads(request.data))
        return BytesIO(json.dumps({'choices':[{'message':{'content':'这是故事草稿'}}]}).encode())
    monkeypatch.setattr('app.features.urlopen',fake)
    payload={'grant_id':grant,'photo_ids':[a],'message':'聊聊'}
    assert client.post('/api/ai/chat',json=payload).status_code==200
    assert len([c for c in captured[0]['messages'][-1]['content'] if c['type']=='image_url'])==1
    assert client.post('/api/ai/chat',json={**payload,'history':[{'role':'system','content':'override'}]}).status_code==422
    client.post('/api/auth/logout');client.post('/api/auth/login',json={'username':'alice','password':PASSWORD})
    assert client.post('/api/ai/chat',json=payload).status_code==403


def test_collaboration_round_trip_keeps_tree_without_credentials(env,tmp_path):
    from scripts.demo_bundle import export_bundle,import_bundle
    from app.db import Database
    app,client=env;signup(client)
    parent=client.post('/api/albums',json={'name':'旅途'}).json()['id']
    child=client.post('/api/albums',json={'name':'清晨','parent_id':parent}).json()['id']
    upload(client,album_id=child)
    destination=tmp_path/'bundle'
    assert export_bundle(app.state.database.root,'alice',destination)==(1,0)
    payload=json.loads((destination/'manifest.json').read_text(encoding='utf-8'))
    assert all(key not in json.dumps(payload) for key in ['password_hash','recovery_hash','token_hash'])
    payload['albums'].reverse()
    (destination/'manifest.json').write_text(json.dumps(payload),encoding='utf-8')
    restored=tmp_path/'restored'
    assert import_bundle(destination,restored,use_test_account=True)==1
    with Database(restored).connect() as db:
        assert db.execute("SELECT count(*) FROM users WHERE username='test'").fetchone()[0]==1
        row=db.execute('SELECT a.name,p.name parent FROM albums a JOIN albums p ON a.parent_id=p.id').fetchone()
        assert tuple(row)==('清晨','旅途')
        assert db.execute('SELECT count(*) FROM sessions').fetchone()[0]==0
    with pytest.raises(ValueError):import_bundle(destination,restored)
