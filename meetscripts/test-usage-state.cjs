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
    for (const mutation of [
        'd.generated="invalid"', 'd.DATA.nacht.claude.model[0][2]=-1',
        'd.DATA.nacht.claude.model[0][3]=Infinity', 'd.DATA.nacht.claude.model[0][1]="red);alert(1)"',
        'd.KOUD.nacht[0]=1.2', 'd.SESSIES[0].lastTurn="invalid"',
        'd.DATA["7d"].gpt.wie=null'
    ]) check('Invalid schema rejected',`(()=>{const d=JSON.parse(JSON.stringify(sample));${mutation};return !validateUsageByModel(d)})()`);
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
    storage.set('ud_usage_model',JSON.stringify({period:'7d',view:'wie'}));
    await run('initUsageByModel()');
    assert.equal(requests.length,1); assert.equal(requests[0].options.cache,'no-store'); checks++;
    check('Preferences restored',"usageModelState.period==='7d' && usageModelState.view==='wie'");
    tileEvents.click({target:{closest:()=>({dataset:{umPeriod:'nacht'}})}});
    tileEvents.click({target:{closest:()=>({dataset:{umView:'model'}})}});
    tileEvents.pointerenter(); tileEvents.focusin(); documentEvents.visibilitychange();
    assert.equal(requests.length,1); assert.equal(renders,3); checks++;
    check('Clicks update view',"usageModelState.period==='nacht' && usageModelState.view==='model'");
    assert.equal(JSON.parse(storage.get('ud_usage_model')).view,'model');checks++;
    context.fetch=async()=>({ok:false});
    await run('initUsageByModel()');
    check('Missing JSON clears snapshot','usageByModelData===null');
    context.fetch=async()=>({ok:true,json:async()=>{throw new SyntaxError('Malformed')}});
    await run('initUsageByModel()');
    check('Malformed JSON clears snapshot','usageByModelData===null');
    console.log('Usage state: '+checks+' offline checks passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1});
