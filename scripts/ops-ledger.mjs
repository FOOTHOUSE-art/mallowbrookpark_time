// マローブルック・パーク 5分粒度 運営台帳
// index.html のシミュレーションモデルをそのまま読み込んで実行するため、
// アプリ側とサーバー側でモデルが二重管理になりません（値も完全一致します）。
import fs from "node:fs";
import vm from "node:vm";

const TZ="Asia/Tokyo";
const nowJST=()=>new Date(new Date().toLocaleString("en-US",{timeZone:TZ}));
const pad=n=>String(n).padStart(2,"0");
const dkey=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

function buildSandbox(){
  const html=fs.readFileSync("index.html","utf8");
  const src=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).join("\n");
  const store={};
  const el=new Proxy({},{get:(t,k)=>{
    if(k==="style")return new Proxy({},{get:()=>"",set:()=>true});
    if(k==="classList")return {add(){},remove(){},toggle(){},contains(){return false}};
    if(k==="dataset")return {};
    if(k==="querySelectorAll")return ()=>[];
    if(k==="querySelector")return ()=>el;
    if(k==="getContext")return ()=>new Proxy({},{get:()=>()=>{}});
    if(k==="getBoundingClientRect")return ()=>({width:600,height:300,left:0,top:0});
    if(k==="textContent"||k==="innerHTML"||k==="value")return "";
    return ()=>{};
  },set:()=>true});
  const doc={getElementById:()=>el,querySelector:()=>el,querySelectorAll:()=>[],createElement:()=>el,
    body:el,documentElement:el,addEventListener(){},hidden:false};
  const ctx={console,Math,Date,JSON,Object,Array,String,Number,Boolean,isNaN,parseInt,parseFloat,
    document:doc,setInterval:()=>0,setTimeout:()=>0,clearInterval(){},clearTimeout(){},
    requestAnimationFrame:()=>0,performance:{now:()=>Date.now()},
    localStorage:{getItem:k=>store[k]??null,setItem:(k,v)=>{store[k]=String(v)},removeItem:k=>{delete store[k]}},
    navigator:{language:"ja",clipboard:{writeText(){}}},
    location:{search:"",href:""},URLSearchParams,
    fetch:async()=>({ok:false,json:async()=>({}),text:async()=>""}),
    Audio:function(){return {play(){return Promise.resolve()},pause(){},addEventListener(){},volume:1}},
    Blob:function(){},URL:{createObjectURL:()=>"",revokeObjectURL(){}},
    DOMParser:function(){return {parseFromString:()=>({querySelectorAll:()=>[]})}},
    AbortController:function(){return {abort(){},signal:null}},
    matchMedia:()=>({matches:false,addEventListener(){}}),
    screen:{width:1366},innerWidth:1366,innerHeight:768,addEventListener(){},
    __store:store};
  ctx.window=ctx;ctx.self=ctx;
  vm.createContext(ctx);
  try{ vm.runInContext(src,ctx,{timeout:30000}); }catch(e){ /* 末尾のDOM配線は無視 */ }
  // const/let はコンテキストに露出しないため、必要なものを引き出す
  vm.runInContext(`globalThis.__M={SPOTS,CLOSE_H,MAX_CAP,TICKET_LABELS,OP_CODES,RIDE_SPEC};`,ctx);
  return ctx;
}

const ctx=buildSandbox();
const M=ctx.__M;
if (!M||!ctx.dailyAttendance){ console.log("model unavailable; skip ledger"); process.exit(0); }

let d=nowJST();
// 開園前の実行では前日分を確定させる（早朝に前日の台帳が完成する）
let finalizePrev=false;
{
  const probe=nowJST();
  const ohProbe=ctx.openH(probe);
  if (probe.getHours()+probe.getMinutes()/60<ohProbe){
    d=new Date(probe.getFullYear(),probe.getMonth(),probe.getDate()-1);
    finalizePrev=true;
  }
}
if (process.env.MB_LEDGER_DATE){
  const [y,m,dd]=process.env.MB_LEDGER_DATE.split("-").map(Number);
  d=new Date(y,m-1,dd);finalizePrev=true;
}
const key=dkey(d);

// 当日の天候をモデルへ反映（live.json があればそれを使う）
try{
  const live=JSON.parse(fs.readFileSync("data/live.json","utf8"));
  if (live.wx&&live.wx.current) Object.assign(ctx.WX,live.wx.current,{ok:true});
  if (live.wx&&live.wx.day) ctx.localStorage.setItem("mb_wxday_"+key,JSON.stringify(live.wx.day));
  if (live.news) Object.assign(ctx.NEWS_ATT??{},{});
}catch(e){}

const att=ctx.dailyAttendance(d);
const rw=ctx.restrictionWindow(d,att);
const oh=ctx.openH(d);
const closeH=M.CLOSE_H;
const realNow=nowJST();
const nowTT=finalizePrev?closeH+0.67:(realNow.getHours()+realNow.getMinutes()/60);
const upto=Math.min(nowTT,closeH+0.67);

// 主要アトラクション（人気上位6件）の待ち時間も記録
const spots=M.SPOTS.filter(s=>s.type==="a").sort((a,b)=>b.pop-a.pop).slice(0,6);

const slots=[];
for (let x=Math.floor(oh*12)/12;x<=upto+1e-9;x+=1/12){
  const t=Math.round(x*720)/720;
  const inPark=ctx.inParkOf(d,t,att);
  const cum=t>=oh?ctx.cumEntriesModel(d,t,att,rw,1):0;
  const restricted=!!(rw&&((t>=rw.start&&(rw.release==null||t<rw.release))||
    (rw.reentry&&t>=rw.reentry.start&&(rw.reentry.release==null||t<rw.reentry.release))));
  const w={};
  for (const s of spots){
    const st=ctx.spotStatus(s,d,t+0.001);
    w[s.id]=st.st==="open"?Math.round(ctx.calcWait(s,d,t+0.001,inPark,ctx.redistFactor(d,t+0.001))):null;
  }
  slots.push({t:+t.toFixed(3),inPark,cum,restricted,w});
}

fs.mkdirSync("data/days",{recursive:true});
const dayFile=`data/days/${key}.json`;
let day={date:key,hours:{}};
try{day=JSON.parse(fs.readFileSync(dayFile,"utf8"));}catch(e){}
day.ops5={gen:Date.now(),interval:5,spots:spots.map(s=>({id:s.id,ja:s.ja})),slots};

// 全アトラクションの運営状態を5分粒度で記録(振り返り用)
if (ctx.opStateOf){
  const allA=M.SPOTS.filter(s=>s.type==="a");
  const states={};
  for (const s of allA){
    const sl=[];let downMin=0,maxWait=0,maxAt=null,ridden=0,evacN=0,evacDetail=[];
    const faults=new Set();
    for (let x=Math.floor(oh*12)/12;x<=upto+1e-9;x+=1/12){
      const t=Math.round(x*720)/720;
      const st=ctx.opStateOf(s,d,t+0.001);
      const code=(M.OP_CODES[st.id]||["--"])[0];
      const w=ctx.calcWait(s,d,t+0.001,ctx.inParkOf(d,t+0.001,att),ctx.redistFactor(d,t+0.001));
      if (w!=null&&w>maxWait){maxWait=w;maxAt=+t.toFixed(2);}
      const run=st.id==="OPEN"||st.id==="DELAYED"||st.id==="LIMITED_OPERATION";
      const spc=M.RIDE_SPEC[s.id]||{};
      if (run) ridden+=(spc.cap||0)/12;
      else if (["TEMP_CLOSED","OPERATIONAL_HOLD","WEATHER_HOLD","EVACUATING"].includes(st.id)) downMin+=5;
      if (st.id==="EVACUATING"){
        if (!sl.length||sl[sl.length-1].op!=="OP-80"){evacN++;evacDetail.push(`${String(Math.floor(t)).padStart(2,"0")}:${String(Math.round((t%1)*60)).padStart(2,"0")} ${st.evac?st.evac.label:""}`);}
      }
      if (st.fault) faults.add(st.fault[0]+" "+st.fault[1]);
      sl.push({t:+t.toFixed(3),op:code,w:w??null});
    }
    const elapsed=Math.max(0.1,Math.min(upto,closeH)-oh);
    const spc=M.RIDE_SPEC[s.id]||{};
    const pass=ctx.recoveryPassOf?ctx.recoveryPassOf(s,d,upto):null;
    states[s.id]={ja:s.ja,slots:sl,summary:{
      util:spc.cap?Math.round(ridden/(spc.cap*elapsed)*100):null,
      ridden:Math.round(ridden),downMin,maxWait,maxAt,
      faults:[...faults],
      evac:evacN?{count:evacN,detail:evacDetail.join("／")}:null,
      recoveryPass:pass?pass.issued:0,
    }};
  }
  day.opsStates=states;
}
// ショーの実施・中止も記録
if (ctx.todaysEntertainment&&ctx.showTimes&&ctx.weatherCancelled){
  const shows=[];
  ctx.todaysEntertainment(d).forEach(e=>{
    (ctx.showTimes(e,d)||[]).forEach(t=>{
      const c=ctx.weatherCancelled(e,t,closeH,d);
      shows.push({id:e.id,ja:e.ja,t:+t.toFixed(2),cancelled:!!c,
        reason:c&&ctx.cancelReason?ctx.cancelReason(e,t,closeH,d):null});
    });
  });
  day.shows=shows;
}
day.ledger={
  forecastTotal:att.total,
  actualTotal:ctx.actualTotalOf?ctx.actualTotalOf(d,att):att.total,
  restriction:rw?{start:rw.start,release:rw.release,soldOutDay:rw.soldOutDay}:null,
  peakInPark:slots.length?Math.max(...slots.map(s=>s.inPark)):0,
  entries:slots.length?slots[slots.length-1].cum:0,
  tickets:ctx.ticketTotals?ctx.ticketTotals(d,att):null,
};
fs.writeFileSync(dayFile,JSON.stringify(day));
console.log(`ops5 ledger: ${key} slots=${slots.length} peak=${day.ledger.peakInPark} ${finalizePrev?"(finalized)":""}`);
