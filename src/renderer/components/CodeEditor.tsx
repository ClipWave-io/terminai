import { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor/editor/editor.api.js'
import 'monaco-editor/features/register.all.js'
import 'monaco-editor/languages/definitions/typescript/register.js'
import 'monaco-editor/languages/definitions/javascript/register.js'
import 'monaco-editor/languages/definitions/python/register.js'
import 'monaco-editor/languages/definitions/markdown/register.js'
import 'monaco-editor/languages/definitions/css/register.js'
import 'monaco-editor/languages/definitions/html/register.js'
import 'monaco-editor/languages/definitions/shell/register.js'
import 'monaco-editor/languages/definitions/yaml/register.js'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker&inline'

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
const languages: Record<string, string> = { ts:'typescript', tsx:'typescript', js:'javascript', jsx:'javascript', mjs:'javascript', cjs:'javascript', py:'python', md:'markdown', css:'css', html:'html', sh:'shell', zsh:'shell', yml:'yaml', yaml:'yaml' }
export default function CodeEditor({path, value, readOnly, onChange, onSave}: {path:string;value:string;readOnly:boolean;onChange:(value:string)=>void;onSave:()=>void}) {
  const host=useRef<HTMLDivElement>(null), editor=useRef<monaco.editor.IStandaloneCodeEditor|null>(null)
  const callbacks=useRef({onChange,onSave});callbacks.current={onChange,onSave}
  useEffect(()=>{
    if(!host.current)return
    const model=monaco.editor.createModel(value,languages[path.split('.').pop()||'']||'plaintext')
    const instance=monaco.editor.create(host.current,{model,editContext:false,automaticLayout:true,fontSize:12,minimap:{enabled:false},scrollBeyondLastLine:false,wordWrap:'off',ariaLabel:`Edit ${path}`,readOnly,theme:document.documentElement.style.colorScheme==='light'?'vs':'vs-dark'})
    editor.current=instance
    const change=instance.onDidChangeModelContent(()=>callbacks.current.onChange(instance.getValue()))
    instance.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.KeyS,()=>callbacks.current.onSave())
    // Keep editor shortcuts from triggering the terminal's global shortcuts.
    const keys=(event:KeyboardEvent)=>{if((event.metaKey||event.ctrlKey)&&['s','f','h','z','y'].includes(event.key.toLowerCase()))event.stopPropagation()}
    host.current.addEventListener('keydown',keys)
    const theme=new MutationObserver(()=>monaco.editor.setTheme(document.documentElement.style.colorScheme==='light'?'vs':'vs-dark'))
    theme.observe(document.documentElement,{attributes:true,attributeFilter:['style']})
    return()=>{host.current?.removeEventListener('keydown',keys);theme.disconnect();change.dispose();instance.dispose();model.dispose();editor.current=null}
  },[path])
  useEffect(()=>{editor.current?.updateOptions({readOnly});if(editor.current&&editor.current.getValue()!==value)editor.current.setValue(value)},[value,readOnly])
  return <div ref={host} className="code-editor" />
}
