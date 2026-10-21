// Offline unit checks against the actual app.js functions; no DOM emulator or
// browser required. The headless integration check remains separate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
const data = JSON.parse(fs.readFileSync(path.join(__dirname,'..','usage-by-model.json'),'utf8'));
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
async function main() {
    context.sample=data;
    check('Real measurement validates','validateUsageByModel(sample)');
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
    check('Preferences restored',"usageModelState.period==='day'");
    tileEvents.click({target:{closest:()=>({dataset:{umPeriod:'day'}})}});
    tileEvents.click({target:{closest:()=>({dataset:{umPeriod:'7d'}})}});
    tileEvents.pointerenter(); tileEvents.focusin(); documentEvents.visibilitychange();
    assert.equal(requests.length,1); assert.equal(renders,3); checks++;
    check('Clicks update period',"usageModelState.period==='7d'");
    assert.equal(JSON.parse(storage.get('ud_usage_model')).period,'7d');checks++;
    // Per-person rows from the measured profiles (the online data path).
    check('Model names readable',"usageModelLabel('gpt-6.1-sol').label==='Sol 6.1' && usageModelLabel('gpt-6-astra').colour==='astra' && usageModelLabel('x').colour==='other'");
    run(`state={selectedProfileId:null}; getAllProfilesForGrid=()=>[
        {id:'a',label:'Rob',syncStatus:{chatgpt:{modelUsage:{checkedAt:1,days:[{date:'2026-10-20',models:{'gpt-6-sol':2}},{date:'2026-10-21',models:{'gpt-6-luna':1}},{date:'2026-10-22',models:{}}]}},
            claude:{usageBreakdown:{checkedAt:2,rows:[{name:'Claude Code',pct:100},{name:'Chats',pct:0}]},scopedWeekly:[{name:'Fable',pctUsed:3}]}}},
        {id:'b',label:'Kevin',syncStatus:{chatgpt:{pctRemaining:50}}}]`);
    check('Rows per person, 7 days',"(()=>{usageModelState.period='7d';const r=usageRowsFromProfiles();return r.rows.length===2&&r.rows[0].segments.length===2&&r.rows[1].segments.length===1&&r.rows[1].extra[0]==='Fable limit 3% used'&&r.measuredAt===2})()");
    check('Last day uses the latest day with usage',"(()=>{usageModelState.period='day';const r=usageRowsFromProfiles();return r.rows[0].segments.length===1&&r.rows[0].segments[0].label==='Luna 6'})()");
    check('Selected profile filters rows',"(()=>{state.selectedProfileId='b';return usageRowsFromProfiles().rows.length===0})()");
    context.fetch=async()=>({ok:false});
    await run('initUsageByModel()');
    check('Missing JSON clears snapshot','usageByModelData===null');
    context.fetch=async()=>({ok:true,json:async()=>{throw new SyntaxError('Malformed')}});
    await run('initUsageByModel()');
    check('Malformed JSON clears snapshot','usageByModelData===null');
    console.log('Usage state: '+checks+' offline checks passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1});
