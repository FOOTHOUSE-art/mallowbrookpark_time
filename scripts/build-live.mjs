// マローブルック・パーク 共有データ生成(GitHub Actionsで毎時実行)
// 出力: data/live.json(最新) + data/days/YYYY-MM-DD.json(日次天候タイムライン)
import fs from "node:fs";

const TZ="Asia/Tokyo";
const nowJST=()=>new Date(new Date().toLocaleString("en-US",{timeZone:TZ}));
const pad=n=>String(n).padStart(2,"0");
const dkey=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

// ---- 天候(Open-Meteo・東京) ----
const WMO={0:"sunny",1:"sunny",2:"cloudy",3:"cloudy",45:"fog",48:"fog",
  51:"rain",53:"rain",55:"rain",61:"rain",63:"rain",65:"heavyrain",
  80:"rain",81:"rain",82:"heavyrain",95:"storm",96:"storm",99:"storm",
  71:"snow",73:"snow",75:"snow",85:"snow",86:"snow"};
function wxMul(cond,temp){
  let m={sunny:1.0,cloudy:0.97,fog:0.94,rain:0.85,heavyrain:0.72,storm:0.62,snow:0.78}[cond]??1;
  if (temp!=null&&temp>=35) m*=0.93;
  if (temp!=null&&temp<=2)  m*=0.93;
  return Math.round(m*100)/100;
}
async function fetchWx(){
  const url="https://api.open-meteo.com/v1/forecast?latitude=35.6895&longitude=139.6917"
    +"&current=temperature_2m,weather_code,wind_speed_10m,precipitation"
    +"&daily=weather_code,temperature_2m_max,precipitation_probability_max&forecast_days=1&timezone=Asia%2FTokyo";
  const j=await (await fetch(url)).json();
  const cc=WMO[j.current.weather_code]??"cloudy";
  const dc=WMO[j.daily.weather_code[0]]??"cloudy";
  const tmax=j.daily.temperature_2m_max[0];
  return {
    current:{condKey:cc,temp:j.current.temperature_2m,wind:j.current.wind_speed_10m,
             mul:wxMul(cc,j.current.temperature_2m),precip:j.current.precipitation},
    day:{mul:wxMul(dc,tmax),tempMax:tmax,cond:dc},
  };
}

// ---- ニュース(NHK+Yahoo RSS・サーバー側なのでCORS不要) ----
const SOURCES=[
  {s:"NHKニュース",url:"https://www3.nhk.or.jp/rss/news/cat0.xml"},
  {s:"NHK経済",url:"https://www3.nhk.or.jp/rss/news/cat5.xml"},
  {s:"NHKスポーツ",url:"https://www3.nhk.or.jp/rss/news/cat7.xml"},
  {s:"NHK科学・医療",url:"https://www3.nhk.or.jp/rss/news/cat3.xml"},
  {s:"Yahoo!トピックス",url:"https://news.yahoo.co.jp/rss/topics/top-picks.xml"},
];
const NG=/事故|事件|死|殺|逮捕|不明|災害|地震|噴火|感染|訃報|死去|被害|火災|遺体|虐待|暴行|戦争|攻撃|ミサイル|テロ|容疑|摘発|中毒|墜落|衝突|沈没/;
async function fetchNews(){
  const heads=[],raw=[];
  for (const src of SOURCES){
    try{
      const txt=await (await fetch(src.url,{headers:{"user-agent":"mallowbrook-bot"}})).text();
      const titles=[...txt.matchAll(/<title>(?:<!\[CDATA\[)?([^<\]]+)/g)].map(m=>m[1].trim()).slice(1,9);
      raw.push(...titles);
      titles.filter(t=>!NG.test(t)).slice(0,4)
        .forEach(t=>heads.push({t:t.length>22?t.slice(0,22)+"…":t,s:src.s}));
    }catch(e){}
  }
  // 観光係数(クライアントと同一ルール)+4日持続イベント
  const all=raw.join("／");
  let evFile="data/newsfx.json";
  let evs=[];try{evs=JSON.parse(fs.readFileSync(evFile,"utf8"));}catch(e){}
  const rules=[
    [/(訪日|インバウンド).{0,12}(増|最多|回復|好調)|円安/,{dom:1.03,inb:1.12,r:"訪日需要増の報道"}],
    [/(大型連休|帰省ラッシュ|行楽|旅行需要.{0,6}(増|好調)|観光地.{0,6}にぎ)/,{dom:1.08,inb:1.0,r:"行楽・帰省の報道"}],
    [/円高|海外旅行.{0,8}(人気|増)/,{dom:1.0,inb:0.92,r:"円高・海外志向の報道"}],
    [/(ガソリン|燃料|運賃|料金).{0,8}(高騰|値上)/,{dom:0.95,inb:1.0,r:"交通コスト上昇の報道"}],
    [/台風.{0,10}(接近|上陸|直撃)|計画運休/,{dom:0.88,inb:0.88,r:"台風・運休の報道"}],
  ];
  const nowT=Date.now();
  rules.forEach(([re,fx])=>{
    if (re.test(all)&&!evs.some(e=>e.reason===fx.r&&nowT-e.t<86400000))
      evs.push({t:nowT,dom:fx.dom,inb:fx.inb,reason:fx.r});
  });
  evs=evs.filter(e=>nowT-e.t<4*86400000).slice(-10);
  fs.writeFileSync(evFile,JSON.stringify(evs));
  let dom=1,inb=1;const rs=[];
  evs.forEach(e=>{const w=Math.max(0,1-(nowT-e.t)/86400000/4);dom*=1+(e.dom-1)*w;inb*=1+(e.inb-1)*w;rs.push(e.reason);});
  const cap=v=>Math.max(0.85,Math.min(1.15,Math.round(v*1000)/1000));
  return {headlines:heads.slice(0,18),dom:cap(dom),inb:cap(inb),reason:rs.length?[...new Set(rs)].join("・"):null};
}

// ---- 生成 ----
const d=nowJST();
const key=dkey(d);
let wx=null,news=null;
try{wx=await fetchWx();}catch(e){console.log("wx failed",e.message);}
try{news=await fetchNews();}catch(e){console.log("news failed",e.message);}

// 日次天候タイムラインへ追記
fs.mkdirSync("data/days",{recursive:true});
const dayFile=`data/days/${key}.json`;
let day={date:key,hours:{}};
try{day=JSON.parse(fs.readFileSync(dayFile,"utf8"));}catch(e){}
if (wx){
  day.hours[String(d.getHours())]={cond:wx.current.condKey,temp:Math.round(wx.current.temp*10)/10,
    mul:wx.current.mul,precip:wx.current.precip??0};
  fs.writeFileSync(dayFile,JSON.stringify(day));
}
const live={gen:Date.now(),date:key,wx,news,today:day};
fs.writeFileSync("data/live.json",JSON.stringify(live));
console.log("live.json updated",key,d.getHours()+":00");
