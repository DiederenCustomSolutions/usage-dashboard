// Offline unit checks against the actual app.js functions; no DOM emulator or
// browser required. The headless integration check remains separate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
const data = JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures','usage-by-model.fixture.json'),'utf8'));
const storage = new Map();
const tileEvents = {}, documentEvents = {};
const classes = () => ({values:new Set(),toggle(name,on){if(on)this.values.add(name);else this.values.delete(name)}});
const fill = {style:{},classList:classes()}, label = {classList:classes()};
const at = Date.parse('2026-10-21T05:00:00Z');
const row = {dataset:{lastTurn:new Date(at).toISOString()},querySelector(selector){return selector==='.um-cst'?label:fill}};
const tile = {addEventListener(name,fn){tileEvents[name]=fn}};
let requests = [], renders = 0;
const context = vm.createContext({
    console, Date, Set, Map, AbortController,
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    document:{visibilityState:'visible',getElementById:()=>tile,querySelectorAll:()=>[row],addEventListener(name,fn){documentEvents[name]=fn}},
    fetch:async (url,options)=>{requests.push({url,options});return {ok:true,json:async()=>data}},
    countRender:()=>renders++
});
const usageStart = source.indexOf('let usageByModelData = null;');
const usageEnd = source.indexOf('const TILE_ORDER_KEY');
const orderEnd = source.indexOf('function currentTileKeys');
vm.runInContext(source.slice(usageStart,usageEnd)+source.slice(usageEnd,orderEnd),context);
const run = code=>vm.runInContext(code,context);
let checks = 0;
function check(labelText,code) {assert.equal(run(code),true,labelText);checks++;}

async function checkMonthlyReset() {
    const previousTZ = process.env.TZ;
    const now = Date.parse('2026-10-25T00:00:00Z');
    // The second 02:30 in Amsterdam, after the clock has gone back.
    const resetAt = Date.parse('2026-10-25T01:30:00Z');
    const monthlyWindow = {used_percent: 10, limit_window_seconds: 30 * 86400, reset_at: resetAt / 1000};
    const resetContext = vm.createContext({
        now,
        fetch: async url => {
            assert.ok(['/api/auth/session', '/backend-api/wham/usage'].includes(url));
            return {ok: true, json: async () => url === '/api/auth/session'
                ? {accessToken: 'fixture'}
                : {rate_limit: {primary_window: monthlyWindow}}};
        }
    });
    const loadFunction = (script, name) => {
        const start = script.indexOf('function ' + name + '(');
        assert.notEqual(start, -1, name);
        vm.runInContext(script.slice(start, script.indexOf('\n}', start) + 2), resetContext);
    };
    for (const name of ['formatWeeklyTimeMs', 'chatgptMonthlyTime', 'parseDateResetTime', 'computeProviderPace', 'escapeHtmlSafe']) {
        loadFunction(source, name);
    }
    try {
        process.env.TZ = 'Europe/Amsterdam';
        assert.equal(new Date(now).getTimezoneOffset(), -120);
        assert.equal(new Date(resetAt).getTimezoneOffset(), -60);
        for (const file of ['content.js', 'background.js', 'app.js']) {
            loadFunction(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), 'chatgptUsageInPageFetch');
            const result = await vm.runInContext('chatgptUsageInPageFetch()', resetContext);
            assert.equal(result.ok, true, file);
            assert.equal(result.monthly.resetMonthlyAbsoluteTs, resetAt, file);
            assert.equal(result.monthly.resetMonthly, 'Reset 25 Oct 2026 02:30', file);
            resetContext.monthly = JSON.parse(JSON.stringify({codex: result.monthly})).codex;
            checks++;
        }

        for (const [zone, offset, legacyTimer] of [
            ['Europe/Amsterdam', -60, '30m'],
            ['America/New_York', 240, '6u 30m']
        ]) {
            process.env.TZ = zone;
            assert.equal(new Date(resetAt).getTimezoneOffset(), offset);
            const pace = vm.runInContext('computeProviderPace("chatgpt", {}, now, monthly)[0]', resetContext);
            assert.equal(pace.resetLabel, '<span class="font-mono">1u 30m</span>', zone);
            const remainingMs = (pace.timePct / 100) * (31 * 86400 * 1000);
            assert.equal(now + Math.round(remainingMs), resetAt, zone);
            const legacy = vm.runInContext('chatgptMonthlyTime({resetMonthly: monthly.resetMonthly}, now)', resetContext);
            assert.equal(legacy.timerText, legacyTimer, zone);
            checks++;
        }
    } finally {
        if (previousTZ === undefined) delete process.env.TZ;
        else process.env.TZ = previousTZ;
    }
}

async function checkDailyReport() {
    const report = {data: [{date: '2026-11-13', models: [
        {model: 'gpt-6.1-sol', credits: 24.17}, {model: 'gpt-6.1-sol', credits: 6.25},
        {model: 'gpt-6.2', credits: 0.004}, {model: 'gpt-6.2', credits: 0.004}
    ]}]};
    for (const file of ['app.js', 'content.js', 'background.js']) {
        const script = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        const start = script.indexOf('function chatgptUsageInPageFetch(');
        const fn = script.slice(start, script.indexOf('\n}', start) + 2);
        const fetch = async url => {
            let value;
            if (url === '/api/auth/session') value = {accessToken: 'fixture'};
            else if (url === '/backend-api/wham/usage') value = {rate_limit: {primary_window: {used_percent: 25, limit_window_seconds: 18000}}};
            else { assert.match(url, /daily-token-usage-breakdown/); value = report; }
            return {ok: true, json: async () => value};
        };
        const result = await vm.runInNewContext(fn + '; chatgptUsageInPageFetch()', {fetch});
        assert.equal(result.data.modelUsage.days[0].models['gpt-6.1-sol'], 30.42, file);
        assert.equal(result.data.modelUsage.days[0].models['gpt-6.2'], 0.01, file);
        checks++;
    }
}

async function checkSharedMetaConflict() {
    const start = source.indexOf('function cs2UpdateEnc(');
    const update = source.slice(start, source.indexOf('\n}', start) + 2);
    let reads = 0;
    const writes = [];
    const shared = {obj:{setting:1}, etag:'first'};
    const sandbox = {
        shared,
        cs2ReadEnc:async () => { reads++; return {obj:{setting:2}, etag:'second'}; },
        cs2WriteEnc:async (_cfg,_sub,obj,etag) => {
            writes.push([obj.setting, obj.refreshRequested, etag]);
            return {conflict: writes.length === 1};
        }
    };
    await vm.runInNewContext(update + `;cs2UpdateEnc({}, 'meta', m => {
        m.refreshRequested = true; return m;
    }, 5, Promise.resolve(shared))`, sandbox);
    assert.equal(reads,1);
    assert.deepEqual(writes,[[1,true,'first'],[2,true,'second']]);
    assert.deepEqual(shared.obj,{setting:1});
    checks++;
}

async function main() {
    context.sample=data;
    check('Populated measurement validates','sample.SESSIES.length > 0 && validateUsageByModel(sample)');
    for (const mutation of ['d.generated="invalid"', 'd.SESSIES[0].lastTurn="invalid"', 'd.SESSIES=null']) check('Invalid schema rejected',`(()=>{const d=JSON.parse(JSON.stringify(sample));${mutation};return !validateUsageByModel(d)})()`);
    context.testAt=at;
    check('Full cache at last turn','updateUsageCache(testAt); true');
    assert.equal(fill.style.width,'100%'); assert.equal(label.textContent,'60 min'); checks++;
    run('updateUsageCache(testAt+51*60000)');
    assert.equal(label.textContent,'9 min'); assert.equal(fill.classList.values.has('um-low'),true); checks++;
    run('updateUsageCache(testAt+61*60000)');
    assert.equal(label.textContent,'cold'); assert.equal(fill.style.width,'0%');assert.equal(label.classList.values.has('um-cold'),true); checks++;
    run('saveTileOrder(["b","a"])');
    check('Saved order, then new tiles',`sortTilesBySavedOrder([{key:'a'},{key:'b'},{key:'c'}]).map(x=>x.key).join(',')==='b,a,c'`);
    storage.set('ud_tile_order','bad JSON');
    check('Invalid saved order is safe','loadTileOrder().length===0');
    // Exercise the actual initialization and input event handlers, replacing
    // only rendering (which requires a real browser) with a counting sink.
    run('renderUsageByModel = countRender');
    storage.set('ud_usage_model',JSON.stringify({period:'day'}));
    await run('initUsageByModel()');
    assert.equal(requests.length,1); assert.equal(requests[0].options.cache,'no-store'); checks++;
    check('Populated measurement loaded','usageByModelData === sample');
    check('Preferences restored',"usageModelState.period==='day'");
    tileEvents.click({target:{closest:()=>({dataset:{umPeriod:'day'}})}});
    tileEvents.click({target:{closest:()=>({dataset:{umPeriod:'7d'}})}});
    tileEvents.pointerenter(); tileEvents.focusin(); documentEvents.visibilitychange();
    assert.equal(requests.length,1); assert.equal(renders,3); checks++;
    check('Clicks update period',"usageModelState.period==='7d'");
    assert.equal(JSON.parse(storage.get('ud_usage_model')).period,'7d');checks++;
    // Per-person rows from the measured profiles (the online data path).
    for (const [model, label, colour] of [
        ['gpt-6.2', 'GPT 6.2', 'other'], ['gpt-6.2-astra', 'Astra 6.2', 'astra'],
        ['gpt-6.2-astra-mini', 'Astra 6.2 mini', 'astra'], ['gpt-6.2-sol', 'Sol 6.2', 'sol'],
        ['gpt-6.1-terra', 'Terra 6.1', 'terra'], ['codex-auto-review', 'Auto review', 'other'],
        ['gpt-9-future', 'gpt-9-future', 'other'], ['x', 'x', 'other']
    ]) {
        const result = context.usageModelLabel(model);
        assert.deepEqual({...result}, {label, colour});
        checks++;
    }
    run(`state={selectedProfileId:null};
        const sampleStatus = {chatgpt:{modelUsage:{checkedAt:Date.parse('2026-10-22'),days:[{date:'2026-10-20',models:{'gpt-6-sol':2}},{date:'2026-10-21',models:{'gpt-6-luna':1}},{date:'2026-10-22',models:{}}]}},
            claude:{usageBreakdown:{rows:[{name:'Claude Code',pct:100},{name:'Chats',pct:0}]},scopedWeekly:[{name:'Fable',pctUsed:3}]}};
        getAllProfilesForGrid=()=>['Rob','Kevin','Kevin – LXDG-DCS','Unknown'].map((label,i)=>({id:String(i),label,syncStatus:sampleStatus}))`);
    const rows = run('usageRowsFromProfiles().rows');
    assert.deepEqual(Array.from(rows, r => [r.who, r.account]), [
        ['GPT Rob','account1'], ['Claude Rob',undefined], ['GPT KB PRO','account2'], ['Claude Kevin',undefined],
        ['GPT Kevin','account3'], ['Claude Kevin – LXDG-DCS',undefined], ['Unknown',undefined], ['Claude Unknown',undefined]
    ]); checks++;
    assert.deepEqual(Array.from(rows[0].week, d => d.total), [0,0,0,0,2,1,0]); checks++;
    assert.deepEqual(Array.from(rows[0].totals, s => [s.label,s.value]), [['Sol 6',2],['Luna 6',1]]); checks++;
    assert.equal(rows[1].surfaces.length, 2); assert.equal(rows[1].limits[0].pctUsed, 3); checks++;
    const panel = {hidden:true, hasChildNodes:()=>true};
    const button = {nextElementSibling:panel, setAttribute(key,value){this[key]=value}};
    const container = {querySelector:()=>button['aria-expanded']==='true' ? button : null};
    context.toggleUsageDetails(container, button, panel, rows[0]);
    assert.equal(button['aria-expanded'],'true'); assert.equal(panel.hidden,false); checks++;
    context.toggleUsageDetails(container, button, panel, rows[0]);
    assert.equal(button['aria-expanded'],'false'); assert.equal(panel.hidden,true); checks++;
    check('Last day uses the latest day with usage',"(()=>{usageModelState.period='day';const r=usageRowsFromProfiles();return r.rows[0].segments.length===1&&r.rows[0].segments[0].label==='Luna 6'})()");
    check('Frozen report is flagged',"(()=>{const g=sampleStatus.chatgpt.modelUsage;const old=g.checkedAt;g.checkedAt=Date.parse('2026-10-24T13:00:00Z');const s1=usageRowsFromProfiles().rows[0].stale;g.checkedAt=Date.parse('2026-10-22T20:00:00Z');const s2=usageRowsFromProfiles().rows[0].stale;g.checkedAt=old;return s1==='No model data after 21 Oct'&&s2===''})()");
    check('Selected profile filters rows',"(()=>{state.selectedProfileId='b';return usageRowsFromProfiles().rows.length===0})()");
    context.emptySample={...data,SESSIES:[]};
    context.fetch=async()=>({ok:true,json:async()=>context.emptySample});
    await run('initUsageByModel()');
    check('Empty measurement loaded','usageByModelData === emptySample && usageByModelData.SESSIES.length === 0');
    context.fetch=async()=>({ok:false});
    await run('initUsageByModel()');
    check('Missing JSON clears snapshot','usageByModelData===null');
    context.fetch=async()=>({ok:true,json:async()=>{throw new SyntaxError('Malformed')}});
    await run('initUsageByModel()');
    check('Malformed JSON clears snapshot','usageByModelData===null');
    await checkSharedMetaConflict();
    await checkDailyReport();
    await checkMonthlyReset();
    console.log('Usage state: '+checks+' offline checks passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1});
