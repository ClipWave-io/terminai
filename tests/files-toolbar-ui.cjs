// The Files header stays on one line, even when the pane is narrow.
const {app}=require('electron'),fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'terminai-filesbar-'));app.setPath('userData',dir);
fs.writeFileSync(path.join(dir,'prefs.json'),JSON.stringify({seenWelcome:true,voice:{enabled:false},newTabAgent:'none',tabs:[{cwd:os.homedir(),title:'a',customTitle:'One',notes:'',focusedMs:0}]}));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.on('browser-window-created',(_e,win)=>win.webContents.once('did-finish-load',()=>{void(async()=>{try{
  await delay(2200);const js=s=>win.webContents.executeJavaScript(s);
  await js(`document.querySelector('[aria-label="Files"]').click()`);await delay(600);
  for(const w of [1300,900,640]){win.setSize(w,820);await delay(500)
    const r=await js(`(()=>{const t=document.querySelector('.files-toolbar'),b=[...t.children].map(e=>e.getBoundingClientRect());return {h:t.getBoundingClientRect().height,w:t.getBoundingClientRect().width,tops:(Math.max(...b.map(x=>x.top))-Math.min(...b.map(x=>x.top)))<14?1:2}})()`)
    if(process.env.SHOT){const t=await js(`JSON.parse(JSON.stringify(document.querySelector('.files-toolbar').getBoundingClientRect()))`);fs.writeFileSync(process.env.SHOT.replace('.png',`-${w}.png`),(await win.webContents.capturePage({x:Math.floor(t.x),y:Math.floor(t.y),width:Math.ceil(t.width),height:Math.ceil(t.height)},{stayHidden:true})).toPNG())}
    console.log(w,JSON.stringify(r));assert.equal(r.tops,1,`one line at ${w}px (${r.w}px wide pane)`)}
  console.log('PASS files toolbar: one line at every width');app.exit(0)
}catch(e){console.error(e);app.exit(1)}})()}));
require(path.join(__dirname,'../out/main/index.js'));
