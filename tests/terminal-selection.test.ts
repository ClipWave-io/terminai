import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installSelectionOverride } from '../src/renderer/terminal-selection'
test('plain click forwards one pair, drags and modifier clicks do not, cleanup restores xterm',()=>{
 const handlers=new Map<string,Function>(),reports:any[]=[]
 const original=()=>false,selection={shouldForceSelection:original}
 const core={_selectionService:selection,coreMouseService:{areMouseEventsActive:true,triggerMouseEvent:(event:any)=>reports.push(event)},_mouseService:{getMouseReportCoords:()=>({col:3,row:4,x:30,y:40})}}
 const term:any={_core:core,hasSelection:()=>false},host:any={addEventListener:(name:string,fn:Function)=>handlers.set(name,fn),removeEventListener:(name:string)=>handlers.delete(name)}
 const dispose=installSelectionOverride(term,host),event={button:0,clientX:30,clientY:40,ctrlKey:false,altKey:false,shiftKey:false}
 const click=(patch:any={})=>{handlers.get('mousedown')!({...event,...patch});handlers.get('mouseup')!({...event,...patch})}
 click();assert.deepEqual(reports.map(e=>e.action),[1,0]);assert.equal(reports[0].col,3)
 click({ctrlKey:true});click({altKey:true});click({button:2});assert.equal(reports.length,2)
 handlers.get('mousedown')!(event);handlers.get('mouseup')!({...event,clientX:80});assert.equal(reports.length,2)
 term.hasSelection=()=>true;click();assert.equal(reports.length,2)
 assert.equal((selection.shouldForceSelection as any)(event),true)
 dispose();assert.equal(handlers.size,0);assert.equal(selection.shouldForceSelection,original)
})
