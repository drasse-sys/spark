/* Only validated numeric data reaches these deterministic SVG templates. */
(function(root){
  'use strict';
  const integer=(x,a,b)=>Number.isInteger(x)&&x>=a&&x<=b;
  function validate(v){
    if(!v||typeof v!=='object'||Array.isArray(v))return null;
    switch(v.type){
      case 'tallinje':{
        if(!integer(v.min,-100,1000)||!integer(v.max,-99,1000)||v.max<=v.min||v.max-v.min>100||!integer(v.start,v.min,v.max)||!Array.isArray(v.jumps)||v.jumps.length>8)return null;
        let x=v.start;for(const jump of v.jumps){if(!integer(jump,-100,100))return null;x+=jump;if(x<v.min||x>v.max)return null;}
        return {type:v.type,min:v.min,max:v.max,start:v.start,jumps:v.jumps.slice()};
      }
      case 'tierramme':return integer(v.n,0,10)?{type:v.type,n:v.n}:null;
      case 'tiere':return integer(v.tens,0,9)&&integer(v.ones,0,9)?{type:v.type,tens:v.tens,ones:v.ones}:null;
      case 'rutenett':return integer(v.rows,1,10)&&integer(v.cols,1,10)?{type:v.type,rows:v.rows,cols:v.cols}:null;
      case 'brøk':return integer(v.denominator,1,12)&&integer(v.numerator,0,v.denominator)?{type:v.type,numerator:v.numerator,denominator:v.denominator}:null;
      case 'klokke':return integer(v.hour,0,23)&&integer(v.minute,0,59)?{type:v.type,hour:v.hour,minute:v.minute}:null;
      case 'penger':return Array.isArray(v.coins)&&v.coins.length>0&&v.coins.length<=20&&v.coins.every(n=>[1,5,10,20].includes(n))?{type:v.type,coins:v.coins.slice()}:null;
      default:return null;
    }
  }
  // JSON arrays can contain single brackets, so use the closing marker pair.
  function extract(text){return [...text.matchAll(/\[\[VIS:\s*([\s\S]*?)\]\]/g)].slice(0,2).map(m=>{try{return validate(JSON.parse(m[1]));}catch{return null;}}).filter(Boolean);}
  function render(input,hideAnswer=false){
    const v=validate(input);if(!v)return '';
    let body='',label='',height=130;
    const rect=(x,y,w,h,fill='#ddd4fa')=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${fill}" stroke="#504076"/>`;
    const text=(x,y,t)=>`<text x="${x}" y="${y}" text-anchor="middle" font-size="14" fill="#292338">${t}</text>`;
    const circle=(x,y,r=9)=>`<circle cx="${x}" cy="${y}" r="${r}" fill="#7051a8"/>`;
    if(v.type==='tierramme'){
      label=`Tierramme: ${v.n} fylte ruter av 10.`;
      for(let i=0;i<10;i++){body+=rect(20+(i%5)*51,15+Math.floor(i/5)*49,46,44,'#fff');if(i<v.n)body+=circle(43+(i%5)*51,37+Math.floor(i/5)*49,14);}
    }else if(v.type==='tiere'){
      label=`${v.tens} tiere og ${v.ones} enere: ${v.tens*10+v.ones}.`;
      for(let i=0;i<v.tens;i++)for(let j=0;j<10;j++)body+=rect(12+i*21,10+j*10,17,9);
      for(let i=0;i<v.ones;i++)body+=rect(210+(i%3)*22,10+Math.floor(i/3)*24,18,18,'#ffa878');
    }else if(v.type==='rutenett'){
      label=`${v.rows} rader med ${v.cols} i hver: ${v.rows*v.cols} til sammen.`;height=Math.max(90,v.rows*24+20);
      for(let y=0;y<v.rows;y++)for(let x=0;x<v.cols;x++)body+=circle(20+x*26,20+y*24,8);
    }else if(v.type==='brøk'){
      label=`${v.numerator} av ${v.denominator} like deler er farget.`;
      for(let i=0;i<v.denominator;i++)body+=rect(10+i*270/v.denominator,25,270/v.denominator,55,i<v.numerator?'#a78bfa':'#fff');
      body+=text(145,110,`${v.numerator}/${v.denominator}`);
    }else if(v.type==='penger'){
      label=hideAnswer?`Mynter: ${v.coins.join(', ')} kroner.`:`Mynter: ${v.coins.join(', ')} kroner. Sum ${v.coins.reduce((a,b)=>a+b,0)} kroner.`;
      height=Math.ceil(v.coins.length/5)*47+10;
      v.coins.forEach((n,i)=>{const x=28+i%5*55,y=25+Math.floor(i/5)*47;body+=`<circle cx="${x}" cy="${y}" r="20" fill="#f3d890" stroke="#785e19"/>`+text(x,y+5,n);});
    }else if(v.type==='klokke'){
      const h=v.hour%12||12,next=h%12+1,dial=Math.floor(v.minute/5)||12;
      const short=v.minute===0?`på ${h}`:`mellom ${h} og ${next}`;
      const long=v.minute%5===0?`på ${dial}`:`${v.minute%5} små streker etter ${dial}`;
      height=200;label=hideAnswer?`Analog klokke. Den korte viseren peker ${short}. Den lange viseren peker ${long}.`:`Klokka er ${String(v.hour).padStart(2,'0')}:${String(v.minute).padStart(2,'0')}.`;
      body='<circle cx="145" cy="100" r="88" fill="white" stroke="#504076" stroke-width="2"/>';
      for(let n=1;n<=12;n++){const a=n*Math.PI/6;body+=text(145+Math.sin(a)*73,105-Math.cos(a)*73,n);}
      const hand=(angle,length,width)=>`<line x1="145" y1="100" x2="${145+Math.sin(angle)*length}" y2="${100-Math.cos(angle)*length}" stroke="#40305d" stroke-width="${width}" stroke-linecap="round"/>`;
      body+=hand((v.hour%12+v.minute/60)*Math.PI/6,45,5)+hand(v.minute*Math.PI/30,64,3)+circle(145,100,4);
    }else{
      const x=n=>15+(n-v.min)/(v.max-v.min)*260;
      label=`Tallinje ${v.min} til ${v.max}. Start ${v.start}. Hopp ${v.jumps.join(', ')||'ingen'}. Slutt ${v.start+v.jumps.reduce((a,b)=>a+b,0)}.`;
      body='<line x1="15" y1="95" x2="275" y2="95" stroke="#504076" stroke-width="2"/>';
      const ticks=new Set([v.min,v.max,v.start]);let n=v.start;
      for(const jump of v.jumps){const next=n+jump;ticks.add(next);body+=`<path d="M ${x(n)} 90 Q ${(x(n)+x(next))/2} 8 ${x(next)} 90" fill="none" stroke="#7051a8" stroke-width="2"/>`+text((x(n)+x(next))/2,38,jump>=0?'+'+jump:jump);n=next;}
      for(const t of ticks)body+=`<line x1="${x(t)}" y1="90" x2="${x(t)}" y2="100" stroke="#504076"/>`+text(x(t),119,t);
    }
    return `<figure class="math-visual"><svg role="img" aria-label="${label}" viewBox="0 0 290 ${height}" xmlns="http://www.w3.org/2000/svg"><title>${label}</title>${body}</svg><figcaption>${label}</figcaption></figure>`;
  }
  root.SparkVisuals={validate,extract,render};
})(globalThis);
