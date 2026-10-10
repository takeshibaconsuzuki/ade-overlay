// Minimal executable context for the pinned bundle's integration point.
export const workbenchFixture = `
var cK={serviceIds:new Map([['storageService',Symbol('storageService')]])};
var storage={},tracker={},invocations=0;
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
globalThis.start=()=>{let C;return{commands:{executeCommand:(k,...D)=>r.executeCommand(k,...D)}}};
`
