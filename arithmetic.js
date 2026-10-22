/* Shared exact, bounded arithmetic. No evaluation of JavaScript or model code. */
(function(root){
  'use strict';
  const LIMIT=1000000000000n;
  function gcd(a,b){a=a<0n?-a:a;while(b){const r=a%b;a=b;b=r;}return a||1n;}
  function rational(n,d=1n){
    if(!d) throw Error('zero denominator');
    if(d<0n){n=-n;d=-d;}
    const g=gcd(n,d);n/=g;d/=g;
    if(n>LIMIT||n< -LIMIT||d>LIMIT) throw Error('bound');
    return {n,d};
  }
  function parse(input){
    try{
      if(typeof input!=='string'||input.length>160||!input.trim())return null;
      if(/\d\s+\d|\d[.]\d|[,][\s]+\d/.test(input))return null;
      const s=input.replace(/\s/g,'').replace(/−/g,'-').replace(/[×·]/g,'*').replace(/[÷:]/g,'/');
      if(!/^[0-9,+\-*/()]+$/.test(s))return null;
      let i=0,ops=0;
      function atom(depth){
        if(depth>6)throw Error('depth');
        let sign=1n;
        if(s[i]==='-'||s[i]==='+'){if(s[i++]==='-')sign=-1n;}
        let v;
        if(s[i]==='('){i++;v=expr(depth+1);if(s[i++]!==')')throw Error('paren');}
        else{
          const m=s.slice(i).match(/^(?:0|[1-9]\d{0,5})(?:,\d{1,3})?/);
          if(!m)throw Error('number');i+=m[0].length;
          const parts=m[0].split(',');v=rational(BigInt(parts.join('')),10n**BigInt(parts[1]?.length||0));
        }
        return rational(sign*v.n,v.d);
      }
      function apply(a,b,op){
        if(++ops>20)throw Error('operations');
        if(op==='+')return rational(a.n*b.d+b.n*a.d,a.d*b.d);
        if(op==='-')return rational(a.n*b.d-b.n*a.d,a.d*b.d);
        if(op==='*')return rational(a.n*b.n,a.d*b.d);
        return rational(a.n*b.d,a.d*b.n);
      }
      function product(depth){let v=atom(depth);while(s[i]==='*'||s[i]==='/'){const op=s[i++];v=apply(v,atom(depth),op);}return v;}
      function expr(depth){let v=product(depth);while(s[i]==='+'||s[i]==='-'){const op=s[i++];v=apply(v,product(depth),op);}return v;}
      const v=expr(0);return i===s.length?{n:String(v.n),d:String(v.d)}:null;
    }catch{return null;}
  }
  function answer(input){return typeof input==='string'&&/^[+-]?(?:0|[1-9]\d{0,5})(?:,\d{1,3})?(?:\/[1-9]\d{0,5})?$/.test(input.trim())?parse(input.trim()):null;}
  function check(expression,response){const a=parse(expression),b=answer(response);return a&&b?{supported:true,ok:a.n===b.n&&a.d===b.d}: {supported:false};}
  function inspect(text){
    const markers=[...text.matchAll(/\[\[SJEKK:\s*([^\]]*)\]\]/g)];
    let invalid=/\[\[SJEKK:/i.test(text)&&!markers.length;
    const checks=markers.map(m=>{const parts=m[1].split('|').map(s=>s.trim());const v=parts.length===3?check(parts[0],parts[1]):{supported:false};const verdict=parts[2];if(!v.supported||!['riktig','feil'].includes(verdict))invalid=true;return {...v,expression:parts[0],answer:parts[1],contradiction:v.supported&&v.ok!==(verdict==='riktig')};});
    return {checks,repair:invalid||checks.some(c=>c.contradiction)};
  }
  root.SparkArithmetic={parse,answer,check,inspect};
})(globalThis);
