// Seeds FAKE demo data into a running TaskBoard (fresh DB only). Env: BASE_URL (default http://localhost:3111), KEY (ingest key for INGEST_KEYS=erp=<KEY>), DEMO_PASSWORD (min 8 chars).
const B=process.env.BASE_URL||'http://localhost:3111', KEY=process.env.KEY;
let jar={};
async function call(who,m,p,b,hdr={}){
  const r=await fetch(B+p,{method:m,headers:{'content-type':'application/json','x-requested-with':'taskboard',...(who?{cookie:jar[who]}:{}),...hdr},body:b?JSON.stringify(b):undefined});
  const sc=r.headers.get('set-cookie'); if(sc&&who!==null) jar[who]=sc.split(';')[0];
  const j=await r.json().catch(()=>({})); if(!r.ok) throw new Error(p+' '+r.status+' '+JSON.stringify(j)); return j;}
const PW=process.env.DEMO_PASSWORD; if(!PW||!KEY){console.error('set KEY and DEMO_PASSWORD');process.exit(1);}
jar.m=''; let r=await fetch(B+'/api/setup',{method:'POST',headers:{'content-type':'application/json','x-requested-with':'taskboard'},body:JSON.stringify({username:'somchai',name:'คุณสมชาย (ผู้จัดการ)',password:PW})});
jar.m=r.headers.get('set-cookie').split(';')[0];
const staff=[['napa','คุณนภา สุขใจ'],['wichai','คุณวิชัย ตั้งใจ'],['pimchanok','คุณพิมพ์ชนก ใจดี'],['anan','คุณอนันต์ รักงาน']];
const id={};
for(const [u,n] of staff){const j=await call('m','POST','/api/users',{username:u,name:n,role:'staff',password:PW});id[u]=j.user.id;}
const tasks=[
['ทำใบเสนอราคาลูกค้า A','เตรียมใบเสนอราคาระบบจัดการสต็อก ส่งให้ลูกค้าภายในสัปดาห์นี้','2026-10-12',['napa'],'todo'],
['นัดประชุมทีมขายประจำเดือน','จองห้องประชุมและส่งวาระล่วงหน้า','2026-10-14',['pimchanok','anan'],'todo'],
['อัปเดตรายชื่อซัพพลายเออร์','ตรวจสอบข้อมูลติดต่อและเงื่อนไขการชำระเงิน','2026-10-16',['anan'],'todo'],
['สรุปยอดขายประจำสัปดาห์','รวบรวมยอดขายจากทุกสาขาเป็นตารางเดียว','2026-10-10',['wichai'],'doing'],
['ออกแบบแบนเนอร์โปรโมชันปลายปี','ขนาด 1200x628 สำหรับเพจ Facebook','2026-10-15',['pimchanok'],'doing'],
['ตามเอกสารสัญญากับบริษัท B','ติดตามสัญญาที่รอลายเซ็นฝ่ายกฎหมาย','2026-10-09',['napa','wichai'],'doing'],
['เตรียมสต็อกสินค้าก่อนแคมเปญ','นับสต็อกคลังหลักและแจ้งยอดคงเหลือ','2026-10-13',['anan'],'doing'],
['ตรวจร่างรายงานต้นทุนไตรมาส 3','ตรวจตัวเลขก่อนส่งผู้บริหาร','2026-10-11',['wichai'],'review'],
['ปรับปรุงแบบฟอร์มรับออร์เดอร์','เพิ่มช่องหมายเหตุและวันที่ส่งของ','2026-10-12',['pimchanok','napa'],'review'],
['จัดทำคู่มือพนักงานใหม่','รวมขั้นตอนเริ่มงานวันแรกและสิทธิ์ใช้ระบบ','2026-10-05',['napa'],'done'],
['ปิดบัญชีรายรับเดือนกันยายน','กระทบยอดกับใบแจ้งหนี้ทั้งหมด','2026-10-07',['wichai','anan'],'done'],
['ส่งตัวอย่างสินค้าให้ลูกค้า C','จัดส่งพร้อมเลขพัสดุ','2026-10-08',['pimchanok'],'done']];
for(const [t,d,dl,mem,st] of tasks){
 const j=await call('m','POST','/api/tasks',{title:t,description:d,deadline:dl,members:mem.map(x=>id[x])});
 const tid=j.task.id;
 if(st!=='todo') await call('m','PATCH','/api/tasks/'+tid,{status:'doing'});
 if(st==='review'||st==='done') await call('m','PATCH','/api/tasks/'+tid,{status:'review'});
 if(st==='done') await call('m','PATCH','/api/tasks/'+tid,{status:'done'});
 if(t.startsWith('ตามเอกสาร')){
  await call('m','PATCH','/api/tasks/'+tid,{deadline:'2026-10-09',description:d+' (ฝ่ายกฎหมายขอแก้ข้อ 4 อีกครั้ง)'});
  await call('m','PATCH','/api/tasks/'+tid,{members:[id.napa,id.wichai,id.anan]});
  await call('m','PATCH','/api/tasks/'+tid,{title:'ตามเอกสารสัญญากับบริษัท B (ด่วน)'});
  globalThis.detail=tid; console.log('DETAIL',tid);}
}
// hours
const now=Date.now(), DAY=864e5, off=7*3600e3;
const ev=[]; const pat={napa:[[9,12],[13,17]],wichai:[[9,11.5],[12.5,16.5]],pimchanok:[[9.5,12],[13,16]],anan:[[9,12],[13.5,17]],somchai:[[9,10.5],[11,12],[13,16]]};
const ld=new Date(now+off); const today=Date.UTC(ld.getUTCFullYear(),ld.getUTCMonth(),ld.getUTCDate());
let k=0;
for(let back=0;back<=8;back++){ const day=today-back*DAY; const dow=new Date(day).getUTCDay(); if(dow===0||dow===6) continue;
 for(const u in pat){ k++; for(const [a,b] of pat[u]){ const j=(k%3)*0.1; for(let m=Math.round((a+j)*60);m<(b-j)*60;m+=6){ if(((m*7+k)%23)===0) continue; const at=day-off+m*60000; if(at<now-2*60000) ev.push({username:u,at}); } } } }
for(let i=0;i<ev.length;i+=400) console.log(JSON.stringify(await call(null,'POST','/api/ingest/activity',{events:ev.slice(i,i+400),extend_minutes:5},{authorization:'Bearer '+KEY})));
