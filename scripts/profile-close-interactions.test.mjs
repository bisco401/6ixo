import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source=readFileSync(new URL('../app.js',import.meta.url),'utf8');
function element() {
 const classes=new Set();
 return { dataset:{}, classList:{add:n=>classes.add(n),remove:n=>classes.delete(n),contains:n=>classes.has(n)}, listeners:{}, addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);}, emit(name){for(const fn of this.listeners[name]||[]) fn({preventDefault(){},stopPropagation(){},stopImmediatePropagation(){}});} };
}
for (const [id,buttonId,setup] of [
 ['profile-modal','profile-modal-close','setupProfileModalControls'],
 ['seller-profile-modal','seller-profile-close','setupSellerProfileModalControls'],
 ['marketplace-item-modal','marketplace-item-close','setupMarketplaceItemModalControls'],
 ['service-modal','service-modal-close','bindServiceModal'],
 ['realestate-modal','realestate-modal-close','bindRealestateModal']
]) {
 test(`${id}: touch closes immediately even when history navigation is pending`,()=>{
  const modal=element(),button=element(),elements=new Map([[id,modal],[buttonId,button]]);
  const context={console,window:{},document:{getElementById:id=>elements.get(id)||null,querySelector:()=>null,addEventListener(){},removeEventListener(){}}};
  vm.runInNewContext(source.slice(0,source.indexOf('// Initialize the app when the page loads'))+'\nglobalThis.App=DatingApp;',context);
  const app=Object.create(context.App.prototype);
  app.syncOverlayViewportMeta=()=>{};
  let historyCalls=0;
  app.popModalHistoryState=()=>{historyCalls++;return true;};
  app[setup]();
  button.emit('touchend');
  assert.equal(modal.classList.contains('hidden'),true);
  assert.equal(historyCalls,1);
  button.emit('click');
  assert.equal(historyCalls,1,'the synthetic click must not navigate back twice');
 });
}
