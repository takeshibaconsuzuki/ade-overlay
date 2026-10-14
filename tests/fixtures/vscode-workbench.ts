// Minimal executable context for the pinned bundle's integration point.
export const workbenchFixture = `
var cK={serviceIds:new Map([['storageService',Symbol('storageService')]])};
var storage={},tracker={},invocations=0;
var me=cK.serviceIds.get('storageService');
var TLo=async()=>{},ke=()=>{};
globalThis.browserMain={
 initServices:async()=>({serviceCollection:{get:()=>storage},logService:{}}),
 createWorkbench(){return {startup(){globalThis.started=true;globalThis.start()}}},
 async open(){let[e]=await Promise.all([this.initServices(),TLo(ke(this.domElement))]),t=this.createWorkbench(this.domElement,e.serviceCollection,e.logService);t.startup()}
};
var g={invokeFunction(callback){
  invocations++;
  let valid=true;
  try{return callback({get(){if(!valid)throw new Error('Expired accessor');return storage}})}
  finally{valid=false}
}};
var RIe={INSTANCE:{getWorkbenchContribution(id){
  if(id!=='workbench.contrib.browserWorkingCopyBackupTracker')throw new Error('Unknown contribution');
  return tracker;
}}};
var r={executeCommand(){}};
var Ge={registerCommand(id, handler){globalThis.command=handler;return {dispose(){}}}};
globalThis.start=()=>{let C;return{commands:{executeCommand:(k,...D)=>r.executeCommand(k,...D)}}};
`
