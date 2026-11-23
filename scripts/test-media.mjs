import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
if (process.env.DATABASE_URL?.trim() || process.env.VERCEL) throw new Error('Run media fixtures without production configuration.');
process.env.OPENAI_API_KEYS = 'fixture-key'; delete process.env.OPENAI_API_KEY;
for (const key of ['OPENAI_TEXT_MODEL','OPENAI_MEDIA_MODEL','OPENAI_VIDEO_MODEL','OPENAI_TRANSCRIBE_MODEL','OPENAI_REGULAR_MODEL']) delete process.env[key];
process.env.OPENAI_ADVANCE_MODEL = 'legacy-sol-must-be-ignored';
process.env.OPENAI_MIN_INTERVAL_MS = '1000'; process.env.OPENAI_MAX_QUEUE_WAIT_MS = '5000';
const folder = await mkdtemp(join(tmpdir(), 'realorna-media-fixture-'));
const python = process.env.MEDIA_PYTHON || resolve('.media-venv/bin/python3');
process.env.MEDIA_PYTHON = python;
// Actual JPEG/MP3 assets. Fixture worker replaces only platform retrieval.
execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','color=c=blue:s=320x240','-frames:v','1','-threads','1',join(folder,'fixture.jpg')]);
execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','sine=frequency=440:duration=1','-b:a','48k',join(folder,'fixture.mp3')]);
await writeFile(join(folder,'worker.py'), `import sys,json,pathlib,shutil\ndata=json.load(sys.stdin)\nif data.get('action')=='health':\n print(json.dumps({'ok':True}));sys.exit(0)\nw=pathlib.Path(data['workdir']);source=pathlib.Path(__file__).parent\nprint(json.dumps({'stage':'downloading'}),flush=True)\nif 'partial' in data['url']:\n print(json.dumps({'ok':False,'error':'media_partial'}));sys.exit(2)\nprint(json.dumps({'stage':'preparing_media'}),flush=True)\nif 'prepare-failed' in data['url']:\n print(json.dumps({'ok':False,'error':'media_partial'}));sys.exit(2)\nshutil.copyfile(source/'fixture.jpg',w/'image-01.jpg')\nshutil.copyfile(source/'fixture.jpg',w/'image-02.jpg')\nshutil.copyfile(source/'fixture.mp3',w/'audio-01.mp3')\nvideo='/reel/' in data['url']\nimages=[{'path':'image-01.jpg','item':1,'type':'frame' if video else 'slide','timestamp':0}]\nif not video and 'missing' not in data['url']:images.append({'path':'image-02.jpg','item':2,'type':'slide'})\nprint(json.dumps({'ok':True,'complete':True,'platform':'instagram','url':data['url'],'title':'Synthetic media fixture','caption':'Synthetic caption','author':'fixture','published_at':'2020-01-02','expected_items':1 if video else 2,'items':1 if video else 2,'videos':1 if video else 0,'duration_seconds':1 if video else 0,'images':images,'audio':[{'path':'audio-01.mp3','item':1,'duration':1}] if video else []}))\n`);
process.env.MEDIA_SCRIPT_PATH = join(folder,'worker.py');
const { createServer } = await import('vite');
const server = await createServer({ server:{ middlewareMode:true },logLevel:'error' });
const originalFetch=globalThis.fetch;
let count=0;
try {
 const { getSql }=await server.ssrLoadModule('/src/lib/db.ts'); const sql=await getSql();
 const { isSupportedMediaLink }=await server.ssrLoadModule('/src/realorna/safety.ts');
 const flow=await server.ssrLoadModule('/src/realorna/backend/factcheck.ts');
 const media=await server.ssrLoadModule('/src/realorna/backend/media.ts');
 const orders=await server.ssrLoadModule('/src/realorna/backend/orders.ts');
 const { Report,Scan,Fail }=await server.ssrLoadModule('/src/realorna/RealornaApp.tsx');
 const { translate }=await server.ssrLoadModule('/src/realorna/i18n.ts');
 const React=await import('react'); const { renderToStaticMarkup }=await import('react-dom/server');
 const evidence='https://example.org/record/2020-01-02';
 const fixture=(review=true)=>({verdict:'FAKTA',summary:'Synthetic fixture only.',claims:[{text:'Synthetic checked claim',status:'benar',explanation:'Supported by fixture record.',correction:'',importance:'utama',source_urls:[evidence]}],red_flags:[],sources:[],meta:{title:'',platform:'',author:'',published_at:''},reference_date:'2020-01-02',content_review:{all_items_read:review,all_core_claims_covered:review,issues:review?[]:['Some slide text is illegible.']}});
 function provider(fx=fixture()) {return new Response(JSON.stringify({status:'completed',output:[{type:'web_search_call',status:'completed',action:{type:'search',sources:[{url:evidence,title:'Fixture record'}]}},{type:'message',content:[{type:'output_text',text:JSON.stringify(fx)}]}]}));}
 async function test(name,fn){await sql`delete from fact_ai_throttle`;await sql`delete from fact_ai_key_cooldowns`;globalThis.fetch=async()=>{throw Error('Unexpected external fixture request')};await fn();count++;console.log('PASS '+name);}
 await test('Direct media link validation rejects profiles and accepts all intended platforms',async()=>{
  for(const url of ['https://www.youtube.com/watch?v=jNQXAC9IVRw','https://instagram.com/p/fixture/?img_index=2','https://twitter.com/fixture/status/123/video/1','https://www.tiktok.com/@fixture/video/123','https://facebook.com/reel/123/'])assert.equal(isSupportedMediaLink(new URL(url)),true,url);
  for(const url of ['https://instagram.com/fixture','https://youtube.com/playlist?list=ABC','https://x.com/fixture','https://user:pass@instagram.com/p/fixture/'])assert.equal(isSupportedMediaLink(new URL(url)),false,url);
 });
 await test('All carousel images and caption reach Terra with required web search',async()=>{
  const sent=[];const stages=[];
  globalThis.fetch=async(url,options)=>{assert.equal(String(url),'https://api.openai.com/v1/responses');const b=JSON.parse(options.body);sent.push(b);return provider();};
  const out=await flow.checkOrder({url:'https://www.instagram.com/p/fixture/',plan:'advance',lang:'id'},async s=>{stages.push(s)});
  assert.equal(sent.length,1);const body=sent[0];assert.equal(body.model,'gpt-6.1-terra');assert.equal(body.tool_choice,'required');
  assert.equal(body.reasoning,undefined);
  const parts=body.input[0].content;assert.equal(parts.filter(i=>i.type==='input_image').length,2);assert.ok(parts.filter(i=>i.type==='input_image').every(i=>i.image_url.startsWith('data:image/jpeg;base64,')&&i.detail==='high'));
  assert.match(parts[0].text,/Synthetic caption/);assert.match(parts.find(i=>i.text?.includes('slide 2')).text,/slide 2 of 2/);
  assert.deepEqual(stages,['reading','downloading','preparing_media','verifying']);assert.equal(out.report.coverage.slides,2);assert.equal(out.report.verdict,'FAKTA');
 });
 await test('Video audio uploads to GPT Transcribe, then its transcript and frames reach GPT-6.2 Sol at high effort',async()=>{
  const calls=[];
  globalThis.fetch=async(url,options)=>{calls.push(String(url));if(String(url).endsWith('/transcriptions')){assert.ok(options.body instanceof FormData);assert.equal(options.body.get('model'),'gpt-transcribe');assert.equal(options.body.get('file').name,'speech.mp3');assert.ok(options.body.get('file').size>1000);return new Response(JSON.stringify({text:'Synthetic speech claim for the test.'}));}const b=JSON.parse(options.body);assert.equal(b.model,'gpt-6.2-sol');assert.equal(b.reasoning.effort,'high');assert.match(b.input[0].content[0].text,/Synthetic speech claim/);assert.equal(b.input[0].content.filter(i=>i.type==='input_image').length,1);return provider();};
  const stages=[];const out=await flow.checkOrder({url:'https://www.instagram.com/reel/fixture/',plan:'advance',lang:'id'},async s=>{stages.push(s)});
  assert.equal(calls.length,2);assert.ok(calls[0].endsWith('/transcriptions'));assert.ok(stages.includes('transcribing'));assert.equal(out.report.coverage.transcribed_tracks,1);assert.equal(out.report.coverage.sampled_frames,true);
 });
 await test('Media failures report their stage and stop before ASR or verification requests',async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;return provider()};
  const failures = { partial: 'downloading', 'prepare-failed': 'preparing_media', missing: 'incomplete_manifest' };
  for (const [tail, reason] of Object.entries(failures)) {
    await assert.rejects(
      () => flow.checkOrder({url:`https://www.instagram.com/p/${tail}/`,plan:'advance',lang:'id'}),
      error => {
        assert.equal(error.code, 'media_partial');
        assert.deepEqual(error.diagnostic, { origin: 'media', reason });
        return true;
      },
    );
  }
  assert.equal(calls,0);
 });
 await test('Transcription quota errors cannot become caption-only verified reports',async()=>{
  let calls=0;globalThis.fetch=async url=>{calls++;assert.ok(String(url).endsWith('/transcriptions'));return new Response(JSON.stringify({error:{code:'insufficient_quota'}}),{status:429})};
  await assert.rejects(()=>flow.checkOrder({url:'https://www.instagram.com/reel/fixture/',plan:'advance',lang:'id'}),e=>e.code==='ai_quota');assert.equal(calls,1);
 });
 await test('Illegible visual content stays unverified despite supported visible claims',async()=>{
  globalThis.fetch=async()=>provider(fixture(false));
  const out=await flow.checkOrder({url:'https://www.instagram.com/p/fixture/',plan:'advance',lang:'id'});
  assert.equal(out.report.verdict,'BELUM_TERVERIFIKASI');assert.match(out.report.red_flags.join(' '),/illegible/);
 });
 await test('Media files cannot escape the temporary directory through paths or symlinks',async()=>{
  const root=join(folder,'confined');await (await import('node:fs/promises')).mkdir(root);
  await symlink(join(folder,'fixture.jpg'),join(root,'escape.jpg'));
  await assert.rejects(()=>media.readConfinedFile(root,'escape.jpg',1e6),e=>e.code==='media_partial');
  await assert.rejects(()=>media.readConfinedFile(root,'../fixture.jpg',1e6),e=>e.code==='media_partial');
  await assert.rejects(()=>media.readConfinedFile(root,'missing.jpg',1e6),e=>e.code==='media_partial');
 });
 await test('Progress updates require the active claim token and never overwrite a completed report',async()=>{
  const account={id:'media-fixture-admin',admin:true,username:'fixture',email:'fixture@example.invalid'};
  await sql.query('insert into "user" (id,name,email,"emailVerified",username,"displayUsername") values ($1,$1,$2,true,$1,$1)',[account.id,account.email]);
  const order=await orders.createCheck(account,{url:'https://example.com/article',plan:'regular',lang:'id',key:crypto.randomUUID()});
  const claimed=await orders.claimRetry(order.order_id);await orders.updateProgress(order.order_id,claimed.claim_token,'verifying');assert.equal((await orders.getOrder(order.order_id)).progress_stage,'verifying');
  await assert.rejects(()=>orders.updateProgress(order.order_id,'stale-token','downloading'));
  await orders.markFailed(order.order_id,'media_partial',claimed.claim_token);assert.equal((await orders.getOrder(order.order_id)).progress_stage,null);
 });
 await test('Media capacity is shared, exclusive, and stale releases cannot unlock it',async()=>{
  const token=await media.acquireMediaSlot();await assert.rejects(()=>media.acquireMediaSlot(),e=>e.code==='ai_busy'&&e.retryAfterSeconds===3);
  await media.releaseMediaSlot('stale-token');await assert.rejects(()=>media.acquireMediaSlot(),e=>e.code==='ai_busy');
  await media.releaseMediaSlot(token);const next=await media.acquireMediaSlot();assert.notEqual(next,token);await media.releaseMediaSlot(next);
 });
 await test('A timed-out verification saves its inputs and the original attempt resumes without another download or transcription', async () => {
  const user = { id: 'media-retry-user', username: 'media-retry-user', email: 'retry@example.invalid', admin: false };
  await sql.query('insert into "user" (id,name,email,"emailVerified",username,"displayUsername") values ($1,$1,$2,true,$1,$1)', [user.id, user.email]);
  const attempt = await orders.grantAttempt({ id: 'media-fixture-admin' }, user.username, 'advance', crypto.randomUUID());
  const url = 'https://www.instagram.com/reel/resumefixture/';
  const order = await orders.createCheck(user, { url, plan: 'advance', lang: 'id', key: crypto.randomUUID(), attemptId: attempt.attempt_id });
  const calls = [];
  let originalVerification;
  globalThis.fetch = async (endpoint, options) => {
   calls.push(String(endpoint).split('/').at(-1));
   if (String(endpoint).endsWith('/transcriptions')) return new Response(JSON.stringify({ text: 'Saved synthetic speech.' }));
   originalVerification = JSON.parse(options.body).input[0].content;
   const [state] = await sql`select extract(epoch from (lease_until - clock_timestamp())) as lease_seconds from fact_ai_throttle where scope = 'openai'`;
   assert.ok(state.lease_seconds > 120 && state.lease_seconds <= 130);
   return new Response(JSON.stringify({ error: { code: 'request_timeout' } }), { status: 408 });
  };
  await assert.rejects(() => flow.retryCheck(order.order_id), error => {
   assert.equal(error.code, 'ai_timeout');
   assert.equal(error.diagnostic.operation, 'verification');
   assert.equal(error.diagnostic.provider_status, 408);
   assert.equal(error.diagnostic.timeout_ms, 120_000);
   return true;
  });
  const [saved] = await sql`select payload, expires_at > now() as fresh from fact_media_checkpoints where order_id = ${order.order_id}`;
  assert.equal(saved.fresh, true);
  assert.equal(JSON.parse(saved.payload).media.audio, undefined);
  assert.equal((await orders.getOrder(order.order_id)).status, 'failed');

  const worker = process.env.MEDIA_SCRIPT_PATH;
  process.env.MEDIA_SCRIPT_PATH = join(folder, 'unavailable-worker.py');
  try {
   globalThis.fetch = async (endpoint, options) => {
    calls.push(String(endpoint).split('/').at(-1));
    assert.ok(String(endpoint).endsWith('/responses'));
    const content = JSON.parse(options.body).input[0].content;
    assert.match(content[0].text, /Saved synthetic speech\./);
    assert.deepEqual(content.slice(1), originalVerification.slice(1));
    return provider();
   };
   const result = await flow.retryCheck(order.order_id);
   assert.equal(result.order.status, 'processed');
   assert.equal(result.report.coverage.transcribed_tracks, 1);
   assert.deepEqual(calls, ['transcriptions', 'responses', 'responses']);
   assert.equal((await sql`select 1 from fact_media_checkpoints where order_id = ${order.order_id}`).length, 0);
   assert.deepEqual(await sql`select status, used_order_id from fact_attempts where user_id = ${user.id}`,
    [{ status: 'used', used_order_id: order.order_id }]);
  } finally { process.env.MEDIA_SCRIPT_PATH = worker; }
 });
 await test('Checkpoint reads expire inputs and respect claim tokens and the resolved URL', async () => {
  const checkpoints = await server.ssrLoadModule('/src/realorna/backend/media-checkpoints.ts');
  const account = { id: 'media-fixture-admin', admin: true };
  const url = 'https://www.instagram.com/reel/expiryfixture/';
  const order = await orders.createCheck(account, { url, plan: 'advance', lang: 'id', key: crypto.randomUUID() });
  const claim = await orders.claimRetry(order.order_id);
  const { audio: _, ...input } = await media.prepareMedia(url, Date.now() + 270_000);
  const stale = { order_id: order.order_id, claim_token: 'stale-token' };
  await checkpoints.saveMediaCheckpoint(stale, url, { ...input, transcripts: ['stale input'] });
  assert.equal(await checkpoints.readMediaCheckpoint(claim, url), null);
  await checkpoints.saveMediaCheckpoint(claim, url, { ...input, transcripts: ['fixture'] });
  assert.equal(await checkpoints.readMediaCheckpoint(stale, url), null);
  assert.equal(await checkpoints.readMediaCheckpoint(claim, 'https://www.instagram.com/reel/different/'), null);
  assert.deepEqual((await checkpoints.readMediaCheckpoint(claim, url)).transcripts, ['fixture']);
  await sql`update fact_media_checkpoints set expires_at = now() - interval '1 second' where order_id = ${order.order_id}`;
  assert.equal(await checkpoints.readMediaCheckpoint(claim, url), null);
  assert.equal((await sql`select 1 from fact_media_checkpoints where order_id = ${order.order_id}`).length, 0);
 });
 await test('Report coverage, real progress and media failures render in both languages',async()=>{
  for(const lang of ['en','id']){const t=(k,p)=>translate(lang,k,p);
   const progress=renderToStaticMarkup(React.createElement(Scan,{host:'instagram.com',video:true,stage:'transcribing',t}));assert.match(progress,/Transcribing|Mentranskripsikan/);
   const failure=renderToStaticMarkup(React.createElement(Fail,{code:'media_partial',onRetry:()=>{},t}));assert.match(failure,/completely|lengkap/);assert.match(failure,/Retry for free|Coba lagi gratis/);
  }
 });
 console.log(JSON.stringify({ok:true,media_checks:count,live_platform_called:false,live_provider_called:false}));
}finally{globalThis.fetch=originalFetch;await server.close();await rm(folder,{recursive:true,force:true});}
