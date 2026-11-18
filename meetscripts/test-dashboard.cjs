// Dependency-free offline integration check using headless Edge's CDP.
// All profiles, reports and screenshots stay inside the task workspace.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '..');
const workspace = path.resolve(repo, '..');
const fixturePath = path.join(__dirname, 'fixtures', 'usage-by-model.fixture.json');
const saveArtifacts = process.env.DASHBOARD_TEST_ARTIFACTS !== '0';
const measurementPath = path.join(repo, 'usage-by-model.json');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function loadMeasurement() {
    try {
        return {source:'local measurement', body:fs.readFileSync(measurementPath, 'utf8')};
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return {source:'fixture', body:fs.readFileSync(fixturePath, 'utf8')};
    }
}
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
    once(event, handler) {
        const wrapper = params => {
            this.handlers.set(event, this.handlers.get(event).filter(fn => fn !== wrapper));
            handler(params);
        };
        this.on(event, wrapper);
    }
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
function waitForChild(child) {
    return new Promise(resolve => {
        child.once('close', resolve);
        child.once('error', resolve);
    });
}
async function main() {
    const measurement = loadMeasurement();
    const port=await freePort(), debugPort=await freePort();
    const origin='http://127.0.0.1:'+port;
    const scratch=fs.mkdtempSync(path.join(workspace, '.verification-'));
    assert.equal(path.dirname(fs.realpathSync(scratch)),fs.realpathSync(workspace),'Temporary directory is inside the workspace');
    const edgeLogPath=path.join(scratch,'edge.stderr.log');
    const childEnv={...process.env,TEMP:scratch,TMP:scratch,PYTHONDONTWRITEBYTECODE:'1'};
    let server, serverClosed, edge, edgeClosed, ws, cdp;
    const report={measurement:measurement.source,checks:[],errors:[]};
    let usageRequests=0, mockResponse={code:200,body:measurement.body};
    try {
        server=spawn('python',['-B','-m','http.server',String(port),'--bind','127.0.0.1','--directory',repo],{cwd:repo,windowsHide:true,stdio:'ignore',env:childEnv});
        serverClosed=waitForChild(server);
        await until(async()=>{try{return (await fetch(origin+'/index.html')).ok}catch{return false}},'HTTP server');
        const edgeLog=fs.openSync(edgeLogPath,'w');
        try {
            edge=spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',[
                '--headless','--window-size=1400,900','--no-first-run','--no-default-browser-check',
                '--no-sandbox','--disable-gpu',
                '--disable-crash-reporter','--disable-breakpad','--noerrdialogs',
                '--disable-extensions','--disable-features=msSmartScreenProtection',
                '--disable-background-networking','--disable-component-update','--disable-sync',
                '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
                '--remote-debugging-address=127.0.0.1','--remote-debugging-port='+debugPort,
                '--user-data-dir='+path.join(scratch,'edge-profile'),'about:blank'
            ],{windowsHide:true,stdio:['ignore','ignore',edgeLog],env:childEnv});
        } finally {
            fs.closeSync(edgeLog);
        }
        edgeClosed=waitForChild(edge);
        edge.on('error',error=>console.error('Headless Edge spawn:',error.message));
        const target=await until(async()=>{
            if (edge.exitCode !== null) throw new Error('Headless Edge exited with code '+edge.exitCode);
            try { return (await(await fetch('http://127.0.0.1:'+debugPort+'/json')).json()).find(t=>t.type==='page'); }
            catch { return false; }
        },'headless Edge');
        ws=new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})});
        cdp=new CDP(ws);
        cdp.on('Runtime.exceptionThrown', e=>report.errors.push(e.exceptionDetails.exception?.description||e.exceptionDetails.text));
        await cdp.call('Runtime.enable');
        await cdp.call('Page.enable');
        await cdp.call('Network.enable');
        await cdp.call('Network.setBypassServiceWorker',{bypass:true});
        await cdp.call('Emulation.setTimezoneOverride',{timezoneId:'Europe/Amsterdam'});
        await cdp.call('Emulation.setDeviceMetricsOverride',{width:1400,height:900,deviceScaleFactor:1,mobile:false});
        cdp.on('Fetch.requestPaused', async e=> {
            try {
                if (!e.request.url.startsWith(origin+'/')) return await cdp.call('Fetch.failRequest',{requestId:e.requestId,errorReason:'BlockedByClient'});
                if (e.request.url === origin+'/usage-by-model.json') {
                    usageRequests++;
                    return await cdp.call('Fetch.fulfillRequest',{
                        requestId:e.requestId,responseCode:mockResponse.code,
                        responseHeaders:[{name:'Content-Type',value:'application/json'}],
                        body:Buffer.from(mockResponse.body).toString('base64')});
                }
                await cdp.call('Fetch.continueRequest',{requestId:e.requestId});
            } catch(error) { report.errors.push(error.message); }
        });
        await cdp.call('Fetch.enable',{patterns:[{urlPattern:'*'}]});
        await cdp.call('Page.addScriptToEvaluateOnNewDocument',{source:`
            // Keep the service worker from reloading the page while testing the tile.
            delete Navigator.prototype.serviceWorker;
            // Observe completion of the startup fetch and render, including error responses.
            document.addEventListener('DOMContentLoaded', () => {
                const init = window.initUsageByModel;
                if (typeof init === 'function') {
                    window.initUsageByModel = () => (window.dashboardUsageReady = init());
                }
            }, { once: true });
            if (!localStorage.getItem('verification-seeded')) {
                localStorage.setItem('verification-seeded','1');
                localStorage.setItem('lt_current_user',JSON.stringify('Local verification'));
            }
        `});
        async function navigate() {
            let loaded=false;
            const previousRequests=usageRequests;
            cdp.once('Page.loadEventFired',()=>{loaded=true});
            const navigation=await cdp.call('Page.navigate',{url:origin+'/index.html'});
            assert.equal(navigation.errorText,undefined,'Dashboard navigation');
            await until(()=>loaded,'page load');
            await until(()=>cdp.evaluate('window.dashboardUsageReady?.then(() => true)'), 'usage initialization');
            assert.equal(usageRequests,previousRequests+1,'One cache measurement request per page');
        }
        const check=async(label,expression)=>{
            assert.equal(await cdp.evaluate(expression),true,label);
            report.checks.push(label);
        };
        async function screenshot(filename) {
            if (!saveArtifacts) return;
            await cdp.evaluate("document.getElementById('usage-by-model').scrollIntoView({block:'center'})");
            await delay(300);
            const result=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
            fs.writeFileSync(path.join(workspace,filename),Buffer.from(result.data,'base64'));
        }
        await navigate();
        const expectedSessions = JSON.parse(measurement.body).SESSIES.map(session => session.name);
        await check('Cache snapshot rendered independently of profiles',`(() => {
            const tile = document.getElementById('usage-by-model');
            const labels = [...tile.querySelectorAll('.um-nm')].map(label => label.textContent);
            const expected = ${JSON.stringify(expectedSessions)};
            return tile.style.display !== 'none' &&
                !tile.querySelector('.um-cache').hidden && tile.querySelector('.um-foot').hidden &&
                !tile.querySelector('.um-row') && labels.length === expected.length &&
                labels.every((label, index) => label === expected[index]);
        })()`);
        const initialRequests = usageRequests;
        // Model and surface usage come from measured profiles, separate from the cache file.
        await cdp.evaluate(`
            state.cloudProfiles = {
                one: { label: 'Rob', syncStatus: {
                    chatgpt: { lastSynced: Date.now(), pctRemaining5h: 50, modelUsage: {
                        units: 'percent', checkedAt: Date.parse('2026-10-22'), days: [
                            { date: '2026-10-20', models: { 'gpt-6-sol': 3 } },
                            { date: '2026-10-21', models: { 'gpt-6-luna': 1 } },
                            { date: '2026-10-22', models: {} }
                        ]
                    } },
                    claude: { lastSynced: Date.now(), pctRemaining: 50, scopedWeekly: [{name:'Fable',pctUsed:11}], usageBreakdown: {
                        checkedAt: Date.now(), rows: [{ name: 'Claude Code', pct: 75 }, { name: 'Chats', pct: 25 }]
                    } }
                } }
            };
            state.selectedProfileId = 'one';
            applyBlockVisibility();
            renderMultiProfileCards();
        `);
        await check('Profile measurements render both providers',`(() => {
            const tile = document.getElementById('usage-by-model');
            const rows = [...tile.querySelectorAll('.um-row')];
            return rows.length === 2 && rows[0].querySelector('.um-who').textContent === 'GPT Robaccount1' && rows[1].querySelector('.um-who').textContent === 'Claude Rob' &&
                rows[0].textContent.includes('Sol 6 75%') && rows[1].textContent.includes('Claude Code 75%') &&
                !tile.querySelector('.um-foot').hidden &&
                tile.querySelector('.um-source').textContent === 'Share of usage per person';
        })()`);
        await check('Model percentages total 100',"[...document.querySelectorAll('.um-stack')].every(stack => Math.abs([...stack.children].reduce((n,s)=>n+parseFloat(s.style.width),0)-100)<0.001)");
        await screenshot('tegel.png');
        await cdp.evaluate(`document.querySelector('[data-um-period="day"]').click()`);
        await check('Last day uses the latest day with usage',`(() => {
            const rows = [...document.querySelectorAll('#usage-by-model .um-row')];
            return document.querySelector('[data-um-period="day"]').getAttribute('aria-pressed') === 'true' &&
                rows[0].querySelector('.um-stack').textContent === 'Luna 6 100%' &&
                rows[1].querySelector('.um-tot').textContent === 'this week';
        })()`);
        await screenshot('tegel-last-day.png');
        await check('Static tile uses Arrange tiles',"setTileArrangeMode(true); document.querySelector('#usage-by-model .tile-move') !== null && document.getElementById('fab-arrange-tiles') !== null");
        await check('Arrow order persists after render',`(() => {
            const grid = activeTileGrid();
            const index = currentTileKeys(grid).indexOf('usage-by-model');
            if (index < 1) return false;
            document.querySelector('#usage-by-model .tile-move [data-dir="-1"]').click();
            renderMultiProfileCards();
            return currentTileKeys(grid).indexOf('usage-by-model') === index - 1 &&
                loadTileOrder().indexOf('usage-by-model') === index - 1;
        })()`);
        await cdp.evaluate("state.cloudProfiles.two={label:'Two',syncStatus:{chatgpt:{lastSynced:Date.now(),pctRemaining5h:50}}}; state.selectedProfileId=null; renderMultiProfileCards()");
        await check('Combined view keeps one usage tile',"document.querySelectorAll('#usage-by-model').length===1 && document.getElementById('usage-by-model').parentElement.id==='multi-profile-grid' && document.querySelectorAll('#usage-by-model .tile-move').length===1");
        await check('Drag changes saved order',`(() => {
            const grid = activeTileGrid();
            const tile = document.getElementById('usage-by-model');
            const target = [...grid.querySelectorAll('.mp-card')].at(-1);
            const transfer = new DataTransfer();
            if (target === tile) return false;
            tile.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
            target.dispatchEvent(new DragEvent('drop', {
                bubbles: true, dataTransfer: transfer, clientX: target.getBoundingClientRect().right
            }));
            const keys = currentTileKeys(grid);
            return keys.at(-1) === 'usage-by-model' && loadTileOrder()[keys.length - 1] === 'usage-by-model';
        })()`);
        await cdp.evaluate("state.selectedProfileId='one'; applyBlockVisibility(); renderMultiProfileCards(); setTileArrangeMode(false)");
        await check('Single view restores tile and removes arrange controls',"document.querySelectorAll('#usage-by-model').length===1 && document.getElementById('usage-by-model').parentElement.id!=='multi-profile-grid' && document.querySelectorAll('.tile-move').length===0");
        assert.equal(usageRequests,initialRequests,'Period selection and arranging never fetch measurements');
        await cdp.call('Emulation.setDeviceMetricsOverride',{width:375,height:844,deviceScaleFactor:1,mobile:true});
        await check('Mobile tile fits viewport',"(()=>{const rect=document.getElementById('usage-by-model').getBoundingClientRect();return rect.width<=375 && document.querySelector('.um-stack').getBoundingClientRect().width>0})()");
        await cdp.evaluate("document.querySelector('.um-row').focus()");
        async function press(key, code, virtualKey) {
            for (const type of ['keyDown','keyUp']) await cdp.call('Input.dispatchKeyEvent', {
                type, key, code, windowsVirtualKeyCode:virtualKey, text:type === 'keyDown' ? (key === 'Enter' ? '\r' : key === ' ' ? ' ' : undefined) : undefined
            });
        }
        await press('Enter','Enter',13);
        await check('Enter opens the seven-day breakdown',`(() => {
            const button = document.querySelector('.um-row');
            const panel = document.getElementById(button.getAttribute('aria-controls'));
            return button.getAttribute('aria-expanded') === 'true' && !panel.hidden &&
                panel.querySelectorAll('.um-day-bar').length === 7 &&
                panel.querySelectorAll('.um-day-bar:empty').length === 5 &&
                panel.querySelectorAll('button.um-day-bar')[6].getAttribute('aria-pressed') === 'true' &&
                panel.querySelector('.um-hour-detail').textContent === 'No hourly data' &&
                !button.textContent.includes('No hourly data') &&
                panel.querySelector('.um-values').textContent === 'Sol 63%Luna 61%' &&
                button.querySelector('.um-tot').textContent === '21 Oct';
        })()`);
        await cdp.evaluate(`
            state.cloudProfiles.one.syncStatus.chatgpt.modelUsageLog = {
                checkedAt: Date.parse('2026-10-22T12:00:00Z'), days: [], hours: [
                    {t:'2026-10-20T22:00:00Z',models:{'gpt-6-sol':2}},
                    {t:'2026-10-21T22:00:00Z',models:{'gpt-6.2-astra':1200000,'gpt-6-sol':300000}}
                ]
            };
            renderUsageByModel();
        `);
        await check('Latest day opens with 24 local hours and model totals',`(() => {
            const bars = document.querySelectorAll('.um-hour-bar');
            return bars.length === 24 && bars[0].title === '00:00 · Astra 6.2 1.2M tok, Sol 6 300K tok' &&
                bars[0].firstElementChild.style.height === '80%' && bars[1].title === '01:00 · No usage' &&
                document.querySelector('.um-hours').textContent === '0003060912151821' &&
                bars[0].firstElementChild.getAttribute('data-tip') === '00:00 · Astra 6.2 1.2M tok · 80%';
        })()`);
        await cdp.evaluate("document.querySelectorAll('.um-day-bar')[5].click()");
        await check('Click switches the hourly breakdown',`document.querySelectorAll('.um-hour-bar').length === 24 &&
            document.querySelector('.um-hour-bar').title === '00:00 · Sol 6 2 tok' &&
            document.querySelectorAll('.um-day-bar[aria-pressed="true"]').length === 1 &&
            document.querySelectorAll('.um-day-bar')[5].getAttribute('aria-pressed') === 'true'`);
        await cdp.evaluate("document.querySelectorAll('.um-day-bar')[5].click()");
        await check('Second click closes the hourly breakdown',`document.querySelector('.um-hour-detail').hidden &&
            !document.querySelector('.um-hour-bar, .um-day-bar[aria-pressed="true"]')`);
        await cdp.evaluate("document.querySelectorAll('.um-day-bar')[5].focus()");
        await press('Enter','Enter',13);
        await check('Enter opens hours and keeps focus on the chosen day',`document.querySelectorAll('.um-hour-bar').length === 24 &&
            document.activeElement === document.querySelector('.um-day-bar[aria-pressed="true"]')`);
        for (const theme of ['light','dark']) {
            await cdp.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});
            await check('Expanded tile fits 375px in '+theme,`(() => {
                const tile = document.querySelector('#usage-by-model');
                const right = tile.getBoundingClientRect().right;
                return right <= 375 && tile.scrollWidth <= tile.clientWidth &&
                    document.querySelector('.um-week').getBoundingClientRect().right <= right &&
                    document.querySelector('.um-hours').getBoundingClientRect().right <= right;
            })()`);
        }
        await cdp.evaluate("document.querySelector('.um-row').focus()");
        await press(' ','Space',32);
        await check('Space closes the focused row',"document.querySelector('.um-row').getAttribute('aria-expanded') === 'false' && document.querySelector('.um-detail').hidden");
        await cdp.evaluate("document.querySelector('.um-row').click()");
        await check('Reopening the panel selects its latest day',`document.querySelectorAll('.um-day-bar')[6].getAttribute('aria-pressed') === 'true' &&
            document.querySelectorAll('.um-hour-bar').length === 24`);
        await cdp.evaluate("document.querySelectorAll('.um-row')[1].click()");
        await check('Claude detail shows shares and weekly limit',`(() => {
            const panel = document.querySelector('.um-detail:not([hidden])');
            return document.querySelectorAll('.um-row[aria-expanded="true"]').length === 1 &&
                panel.querySelector('progress').value === 11 &&
                panel.querySelector('.um-values').textContent === 'Claude Code75%Chats25%';
        })()`);
        await cdp.evaluate("document.querySelectorAll('.um-row')[1].click()");
        await screenshot('tegel-mobiel.png');
        await cdp.call('Emulation.setDeviceMetricsOverride',{width:1400,height:900,deviceScaleFactor:1,mobile:false});

        const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
        fixture.SESSIES[0].name = '<b>Cache session</b>';
        mockResponse = {code:200,body:JSON.stringify(fixture)};
        await navigate();
        await check('Period preference survives reload',`document.querySelector('[data-um-period="day"]').getAttribute('aria-pressed') === 'true'`);
        await check('Cache labels remain plain text',`document.querySelector('.um-nm').textContent === '<b>Cache session</b>' && !document.querySelector('.um-nm b')`);
        const requestsBeforeClock = usageRequests;
        await check('Cache expires from ISO timestamp',`(()=>{const first=document.querySelector('.um-crow'); updateUsageCache(Date.parse(first.dataset.lastTurn)+3600001); return first.querySelector('.um-cst').textContent==='cold' && parseFloat(first.querySelector('.um-ctrack div').style.width)===0})()`);
        await check('Cache turns yellow below ten minutes',`(()=>{const first=document.querySelector('.um-crow'); updateUsageCache(Date.parse(first.dataset.lastTurn)+51*60000); return first.querySelector('.um-cst').textContent==='9 min' && first.querySelector('.um-ctrack div').classList.contains('um-low')})()`);
        assert.equal(usageRequests,requestsBeforeClock,'Updating cache time never fetches measurements');
        report.checks.push('No extra measurement fetch from interactions or clock');

        const emptyTile = `(() => {
            const tile = document.getElementById('usage-by-model');
            return tile.style.display === 'none' &&
                tile.querySelector('.um-cache').hidden && tile.querySelector('.um-foot').hidden;
        })()`;
        mockResponse={code:404,body:'{}'};
        await navigate();
        await check('Missing data hides the empty tile',emptyTile);
        mockResponse={code:200,body:'{"SESSIES":null}'};
        await navigate();
        await check('Invalid schema hides the empty tile',emptyTile);
        assert.deepEqual(report.errors,[],'No uncaught browser errors');
        report.checks.push('No uncaught browser errors');
        if (saveArtifacts) fs.writeFileSync(path.join(workspace,'test-dashboard.json'),JSON.stringify(report,null,2));
        console.log('Headless Edge: '+report.checks.length+' checks passed.');
    } catch (error) {
        report.errors.push(error.message);
        if (!cdp && fs.existsSync(edgeLogPath)) {
            const stderr = fs.readFileSync(edgeLogPath, 'utf8').trim();
            if (stderr) { report.edgeStderr = stderr; if (!saveArtifacts) console.error(stderr); }
        }
        if (saveArtifacts) fs.writeFileSync(path.join(workspace,'test-dashboard.json'),JSON.stringify(report,null,2));
        throw error;
    } finally {
        if (cdp && ws.readyState === WebSocket.OPEN) {
            cdp.call('Browser.close').catch(()=>{});
            await Promise.race([edgeClosed, delay(2000)]);
        }
        ws?.close();
        edge?.kill();
        server?.kill();
        await Promise.all([edgeClosed, serverClosed]);
        fs.rmSync(scratch, {recursive:true,force:true,maxRetries:5,retryDelay:100});
    }
}
main().catch(error=>{console.error(error);process.exitCode=1});
