// Dependency-free offline integration check using headless Edge's CDP.
// All profiles, reports and screenshots stay inside the task workspace.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '..');
const workspace = path.resolve(repo, '..');
const scratch = path.join(workspace, '.verification');
fs.mkdirSync(scratch, {recursive:true});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}
async function until(fn, label) {
    for (let i=0;i<100;i++) {
        const result = await fn();
        if (result) return result;
        await delay(100);
    }
    throw new Error('Timeout: '+label);
}
class CDP {
    constructor(ws) {
        this.ws=ws; this.seq=0; this.pending=new Map(); this.handlers=new Map();
        ws.addEventListener('message', event => {
            const message=JSON.parse(event.data);
            if (message.id) {
                const pending=this.pending.get(message.id);
                this.pending.delete(message.id);
                if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
                else pending.resolve(message.result);
            } else for (const handle of this.handlers.get(message.method)||[]) handle(message.params);
        });
    }
    on(event, handler) { this.handlers.set(event, [...(this.handlers.get(event)||[]), handler]); }
    call(method, params={}) {
        const id=++this.seq;
        return new Promise((resolve,reject) => {
            this.pending.set(id,{resolve,reject});
            this.ws.send(JSON.stringify({id,method,params}));
        });
    }
    async evaluate(expression) {
        const result=await this.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text+': '+result.exceptionDetails.exception?.description);
        return result.result.value;
    }
}
async function main() {
    const port=await freePort(), debugPort=await freePort();
    const origin='http://127.0.0.1:'+port;
    const childEnv={...process.env,TEMP:scratch,TMP:scratch,PYTHONDONTWRITEBYTECODE:'1'};
    const server=spawn('python',['-B','-m','http.server',String(port),'--bind','127.0.0.1','--directory',repo],{cwd:repo,windowsHide:true,stdio:'ignore',env:childEnv});
    let edge, cdp;
    const report={checks:[],errors:[]};
    let usageRequests=0, mockResponse=null;
    try {
        await until(async()=>{try{return (await fetch(origin+'/index.html')).ok}catch{return false}},'HTTP server');
        const edgeLog=fs.openSync(path.join(scratch,'edge.stderr.log'),'w');
        edge=spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',[
            '--headless','--window-size=1400,900','--no-first-run','--no-default-browser-check',
            '--no-sandbox','--disable-gpu',
            '--disable-crash-reporter','--disable-breakpad','--noerrdialogs',
            '--disable-extensions','--disable-features=msSmartScreenProtection',
            '--disable-background-networking','--disable-component-update','--disable-sync',
            '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
            '--remote-debugging-address=127.0.0.1','--remote-debugging-port='+debugPort,
            '--user-data-dir='+path.join(scratch,'edge-profile-'+Date.now()),'about:blank'
        ],{windowsHide:true,stdio:['ignore','ignore',edgeLog],env:childEnv});
        edge.on('error',error=>console.error('Headless Edge spawn:',error.message));
        const target=await until(async()=>{try{return (await(await fetch('http://127.0.0.1:'+debugPort+'/json')).json()).find(t=>t.type==='page')}catch{return false}},'headless Edge');
        const ws=new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})});
        cdp=new CDP(ws);
        cdp.on('Runtime.exceptionThrown', e=>report.errors.push(e.exceptionDetails.exception?.description||e.exceptionDetails.text));
        await cdp.call('Runtime.enable');
        await cdp.call('Page.enable');
        await cdp.call('Network.enable');
        await cdp.call('Network.setBypassServiceWorker',{bypass:true});
        await cdp.call('Emulation.setDeviceMetricsOverride',{width:1400,height:900,deviceScaleFactor:1,mobile:false});
        cdp.on('Fetch.requestPaused', async e=> {
            try {
                if (!e.request.url.startsWith(origin+'/')) return await cdp.call('Fetch.failRequest',{requestId:e.requestId,errorReason:'BlockedByClient'});
                if (e.request.url.endsWith('/usage-by-model.json')) {
                    usageRequests++;
                    if (mockResponse) return await cdp.call('Fetch.fulfillRequest',{
                        requestId:e.requestId,responseCode:mockResponse.code,
                        responseHeaders:[{name:'Content-Type',value:'application/json'}],
                        body:Buffer.from(mockResponse.body).toString('base64')});
                }
                await cdp.call('Fetch.continueRequest',{requestId:e.requestId});
            } catch(error) { report.errors.push(error.message); }
        });
        await cdp.call('Fetch.enable',{patterns:[{urlPattern:'*'}]});
        await cdp.call('Page.addScriptToEvaluateOnNewDocument',{source:`
            if (!localStorage.getItem('verification-seeded')) {
                localStorage.setItem('verification-seeded','1');
                localStorage.setItem('lt_current_user',JSON.stringify('Local verification'));
                localStorage.setItem('ud_usage_model',JSON.stringify({period:'nacht',view:'model'}));
            }
        `});
        async function navigate() {
            let loaded=false;
            cdp.on('Page.loadEventFired',()=>{loaded=true});
            await cdp.call('Page.navigate',{url:origin+'/index.html'});
            await until(()=>loaded,'page load');
            await until(()=>cdp.evaluate("document.readyState === 'complete' && typeof usageByModelData !== 'undefined' && document.querySelector('#usage-by-model .um-rows') !== null"),'dashboard loaded');
        }
        const check=async(label,expression)=>{
            assert.equal(await cdp.evaluate(expression),true,label);
            report.checks.push(label);
        };
        async function screenshot(filename) {
            await cdp.evaluate("document.getElementById('usage-by-model').scrollIntoView({block:'center'})");
            await delay(300);
            const result=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
            fs.writeFileSync(path.join(workspace,filename),Buffer.from(result.data,'base64'));
        }
        await navigate();
        await until(()=>cdp.evaluate('usageByModelData !== null'),'real measurement');
        await new Promise(r=>setTimeout(r,1500)); usageRequests=0;
        await check('Real JSON rendered with two providers',"document.querySelectorAll('.um-row').length === 2 && document.querySelector('.um-source').textContent.includes('Output tokens')");
        await check('Model percentages total 100',"[...document.querySelectorAll('.um-stack')].every(stack => Math.abs([...stack.children].reduce((n,s)=>n+parseFloat(s.style.width),0)-100)<0.001)");
        await screenshot('tegel.png');
        await cdp.evaluate("document.querySelector('[data-um-period=\"7d\"]').click(); document.querySelector('[data-um-view=\"wie\"]').click()");
        await check('7 days / Who toggles and totals',"usageModelState.period === '7d' && usageModelState.view === 'wie' && document.querySelector('[data-um-view=\"wie\"]').getAttribute('aria-pressed') === 'true' && document.querySelector('.um-rows').textContent.includes('account')");
        await screenshot('tegel-who-7days.png');
        await check('Cache expires from ISO timestamp',`(()=>{const first=document.querySelector('.um-crow'); updateUsageCache(Date.parse(first.dataset.lastTurn)+3600001); return first.querySelector('.um-cst').textContent==='cold' && parseFloat(first.querySelector('.um-ctrack div').style.width)===0})()`);
        await check('Cache turns yellow below ten minutes',`(()=>{const first=document.querySelector('.um-crow'); updateUsageCache(Date.parse(first.dataset.lastTurn)+51*60000); return first.querySelector('.um-cst').textContent==='9 min' && first.querySelector('.um-ctrack div').classList.contains('um-low')})()`);
        await cdp.evaluate('updateUsageCache()');
        await check('Static tile uses Arrange tiles',"setTileArrangeMode(true); document.querySelector('#usage-by-model .tile-move') !== null && document.getElementById('fab-arrange-tiles') !== null");
        // Add a local test-only subscription to verify movement against another card.
        await cdp.evaluate("state.syncStatus.claude={lastSynced:Date.now(),pctRemaining:50}; applyBlockVisibility(); renderMultiProfileCards()");
        await check('Arrow order persists after render',"(()=>{moveTile('usage-by-model',-1); const before=JSON.stringify(currentTileKeys(activeTileGrid())); renderMultiProfileCards(); return before===JSON.stringify(currentTileKeys(activeTileGrid())) && loadTileOrder()[0]==='usage-by-model'})()");
        await cdp.evaluate("state.cloudProfiles={one:{label:'One',syncStatus:{claude:{lastSynced:Date.now(),pctRemaining:50}}},two:{label:'Two',syncStatus:{chatgpt:{lastSynced:Date.now(),pctRemaining5h:50}}}}; state.selectedProfileId=null; renderMultiProfileCards()");
        await check('Combined view keeps one usage tile',"document.querySelectorAll('#usage-by-model').length===1 && document.getElementById('usage-by-model').parentElement.id==='multi-profile-grid' && document.querySelectorAll('#usage-by-model .tile-move').length===1");
        await check('Drag changes saved order',`(()=>{const tile=document.getElementById('usage-by-model'),target=[...activeTileGrid().querySelectorAll('.mp-card')].find(t=>t!==tile),transfer=new DataTransfer(); tile.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:transfer,clientX:target.getBoundingClientRect().right}));return loadTileOrder().indexOf('usage-by-model')>0})()`);
        await cdp.evaluate("state.selectedProfileId='one'; applyBlockVisibility(); renderMultiProfileCards(); setTileArrangeMode(false)");
        await check('Single view restores tile and removes arrange controls',"document.querySelectorAll('#usage-by-model').length===1 && document.getElementById('usage-by-model').parentElement.id!=='multi-profile-grid' && document.querySelectorAll('.tile-move').length===0");
        await check('Balanced notices for balanced data',`(()=>{const saved=usageByModelData;usageByModelData=structuredClone(saved);const d=usageByModelData.DATA[usageModelState.period]; d.claude.model=[['Opus','opus',1,1],['Haiku','haiku',1,1]];d.gpt.wie=[['account1','acc1',1,1],['account2','acc2',1,1]];renderUsageByModel();const ok=[...document.querySelectorAll('.um-row .um-chip')].every(c=>c.textContent==='✓ Balanced' && !c.classList.contains('um-warn'));usageByModelData=saved;renderUsageByModel();return ok})()`);
        await check('Untrusted labels remain plain text',`(()=>{const saved=usageByModelData;usageByModelData=structuredClone(saved);usageByModelData.SESSIES[0].name='<img src=x onerror=alert(1)>';renderUsageByModel();const ok=!document.querySelector('.um-cache img') && document.querySelector('.um-nm').textContent.startsWith('<img');usageByModelData=saved;renderUsageByModel();return ok})()`);
        assert.equal(usageRequests,0,'Toggles, clock and arranging never fetch measurements');
        report.checks.push('No extra measurement fetch from interactions or clock');
        await cdp.call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
        await check('Mobile tile fits viewport',"(()=>{const rect=document.getElementById('usage-by-model').getBoundingClientRect();return rect.width<=390 && document.querySelector('.um-stack').getBoundingClientRect().width>0})()");
        await screenshot('tegel-mobiel.png');
        await cdp.call('Emulation.setDeviceMetricsOverride',{width:1400,height:900,deviceScaleFactor:1,mobile:false});
        await navigate();
        await until(()=>cdp.evaluate('usageByModelData !== null'),'persisted view');
        await check('Toggle preferences survive reload',"usageModelState.period==='7d' && usageModelState.view==='wie'");
        mockResponse={code:404,body:'{}'};
        await navigate();
        await until(()=>cdp.evaluate("document.querySelector('.um-rows').textContent==='No data yet'"),'missing data');
        await check('Missing data hides cache',"document.querySelector('.um-cache').hidden && document.querySelector('.um-foot').hidden");
        mockResponse={code:200,body:'{"DATA":{}}'};
        await navigate();
        await check('Malformed schema falls back safely',"usageByModelData===null && document.querySelector('.um-rows').textContent==='No data yet'");
        assert.deepEqual(report.errors,[],'No uncaught browser errors');
        report.checks.push('No uncaught browser errors');
        fs.writeFileSync(path.join(workspace,'test-dashboard.json'),JSON.stringify(report,null,2));
        console.log('Headless Edge: '+report.checks.length+' checks passed; screenshots saved.');
    } catch (error) {
        report.errors.push(error.message);
        fs.writeFileSync(path.join(workspace,'test-dashboard.json'),JSON.stringify(report,null,2));
        throw error;
    } finally {
        if (cdp) {
            try { await cdp.call('Browser.close'); } catch {}
            cdp.ws.close();
        }
        if (edge) edge.kill();
        server.kill();
    }
}
main().catch(error=>{console.error(error);process.exitCode=1});
