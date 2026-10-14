/* Shared, DOM-free expression grammar for text and the visual canvas. */
const ConditionCore = (() => {
  const symbols = {union:'∪', intersect:'∩', subtract:'−', not:'¬'};
  const fields = {'标签':'tag','地点':'location','名称':'name','故事':'story','搜索':'search','位置':'place'};
  function label(node) {
    if (node.tag) return node.tag;
    if (node.op) return symbols[node.op];
    if (node.field === 'favorite') return '收藏';
    if (node.field === 'unlocated') return '未定位';
    if (node.field === 'place') return '位置 ' + node.value.map(v=>Number(v).toFixed(2)).join(', ');
    return ({location:'地点',name:'名称',story:'故事',search:'搜索'}[node.field] || '') + ' · ' + node.value;
  }
  function format(node) {
    if (!node) return '';
    if (node.tag) return '标签(' + JSON.stringify(node.tag) + ')';
    if (node.op === 'not') return '¬(' + format(node.child) + ')';
    if (node.op) return '(' + format(node.left) + ' ' + symbols[node.op] + ' ' + format(node.right) + ')';
    if (node.field === 'favorite' || node.field === 'unlocated') return (node.value?'':'¬') + (node.field==='favorite'?'收藏':'未定位');
    if (node.field === 'place') return '位置(' + node.value.join(',') + ')';
    const name = Object.keys(fields).find(k=>fields[k] === node.field);
    return name + '(' + JSON.stringify(node.value) + (node.field==='search'?','+(node.score??.30):'') + ')';
  }
  function parse(text) {
    if (text.length > 10000) throw new Error('公式过长');
    const tokens = []; let i=0;
    while (i<text.length) {
      if (/\s/.test(text[i])) { i++; continue; }
      const c=text[i];
      const number=text.slice(i).match(/^-?(?:\d+(?:\.\d*)?|\.\d+)(?=\s*[,)、）]|$)/);if(number){tokens.push(number[0]);i+=number[0].length;continue;}
      if ('()（）∪∩−-¬!补交并差,&|'.includes(c)) {tokens.push({'（':'(', '）':')','-':'−','!':'¬','补':'¬','交':'∩','并':'∪','差':'−','&':'∩','|':'∪'}[c]||c);i++;continue;}
      if (c==='"') {
        const start=i++; let escaped=false;
        while(i<text.length) {const next=text[i++];if(next==='"'&&!escaped)break;escaped=next==='\\'&&!escaped;}
        try { tokens.push({string:JSON.parse(text.slice(start,i))}); } catch {throw new Error('引号没有闭合，请用英文双引号');}
      } else {
        const start=i;while(i<text.length&&!/[\s()（）∪∩−¬!,&|]/.test(text[i]))i++;
        if(start===i)throw new Error('无法识别公式');tokens.push(text.slice(start,i));
      }
    }
    let at=0,count=0;
    const peek=()=>tokens[at], take=()=>tokens[at++];
    function expect(value){if(take()!==value)throw new Error('这里需要 '+value);}
    function atom(depth=0) {
      if (depth>128) throw new Error('分组过深');
      if(peek()==='¬'){if(++count>63)throw new Error('最多63个节点');take();return {op:'not',child:atom(depth+1)};}
      if(peek()==='('){take();const result=expression(0,depth+1);expect(')');return result;}
      if(++count>63)throw new Error('最多63个节点');
      const token=take();if(!token||[')',',','∪','∩','−'].includes(token))throw new Error('缺少条件');
      if(typeof token==='object')return {tag:token.string};
      if(token==='收藏')return {field:'favorite',value:true};
      if(token==='未定位')return {field:'unlocated',value:true};
      if(peek()!=='(')return {tag:token};
      if(!fields[token])throw new Error('支持：标签、地点、名称、故事、搜索、位置');
      take();const first=take();
      if(token==='位置') {expect(',');const second=take();expect(')');const value=[Number(first),Number(second)];if(!value.every(Number.isFinite)||Math.abs(value[0])>90||Math.abs(value[1])>180)throw new Error('经纬度无效');return {field:'place',value};}
      const value=typeof first==='object'?first.string:first;
      if(typeof value!=='string'||!value.trim()||[')',',','∪','∩','−'].includes(value))throw new Error('请填写条件内容');
      const leaf=token==='标签'?{tag:value}:{field:fields[token],value};
      if(token==='搜索'&&peek()===','){take();leaf.score=Number(take());if(!Number.isFinite(leaf.score)||leaf.score < -1||leaf.score>1)throw new Error('搜索分数无效');}
      expect(')');return leaf;
    }
    function expression(minimum=0,depth=0) {
      let left=atom(depth);
      const priority={'∪':1,'∩':2,'−':2};
      while(priority[peek()]>=minimum&&peek() in priority) {
        if(++count>63)throw new Error('最多63个节点');
        const op=take(),right=expression(priority[op]+1,depth+1);
        left={op:{'∪':'union','∩':'intersect','−':'subtract'}[op],left,right};
      }
      return left;
    }
    if(!tokens.length)return null;
    const result=expression();if(at!==tokens.length)throw new Error('条件之间需要交、并、差运算符');
    function checkDepth(node,depth=0){if(depth>32)throw new Error('最多32层分组');if(node.op==='not')checkDepth(node.child,depth+1);else if(node.op){checkDepth(node.left,depth+1);checkDepth(node.right,depth+1);}}
    checkDepth(result);return result;
  }
  function compile(nodes, root) {
    if(!nodes.length)return null;
    const byId=new Map(nodes.map(n=>[n.id,n])),used=new Set(),path=new Set();let count=0;
    const incoming=new Set(nodes.flatMap(n=>n.inputs||[]).filter(Boolean));
    const roots=nodes.filter(n=>!incoming.has(n.id));
    root=root|| (roots.length===1?roots[0].id:null);
    if(!root)throw new Error('请把各个条件连成一幅图，只保留一个结果出口');
    function visit(id,depth=0){
      if(++count>63)throw new Error('展开后的关系最多63个节点');
      if(depth>32||path.has(id))throw new Error('不能形成循环连线');
      const node=byId.get(id);if(!node)throw new Error('有运算符尚未连接完整');
      path.add(id);used.add(id);let value;
      if(node.value.op){const op=node.value.op;value=op==='not'?{op,child:visit(node.inputs[0],depth+1)}:{op,left:visit(node.inputs[0],depth+1),right:visit(node.inputs[1],depth+1)};}else value={...node.value};
      path.delete(id);return value;
    }
    const result=visit(root);if(used.size!==nodes.length)throw new Error('还有未接入结果的节点，请连接或删除');
    if(JSON.stringify(result).length>12000)throw new Error('条件图过大');return result;
  }
  return {parse,format,label,compile,symbols};
})();
if(typeof module!=='undefined')module.exports=ConditionCore;
