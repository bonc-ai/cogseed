/* Offline contract checks. Exercises React elements/callbacks with a hook dispatcher;
 * it deliberately does not claim DOM layout, native keyboard or browser acceptance. */
const fs=require('node:fs'), path=require('node:path'), vm=require('node:vm'), crypto=require('node:crypto'), assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'), read=p=>fs.readFileSync(path.join(root,p),'utf8');
const registry=JSON.parse(read('components/registry.json')), manifest=JSON.parse(read('_ds_manifest.json'));
const bundle=read('_ds_bundle.js'), meta=JSON.parse(bundle.match(/\/\* @ds-bundle: (.*?) \*\//s)[1]);
assert.deepEqual(registry.components,manifest.components);
assert.deepEqual(registry.components,meta.components);
for(const [file,hash] of Object.entries(meta.sourceHashes))assert.equal(crypto.createHash('sha256').update(read(file)).digest('hex').slice(0,12),hash,file);
const context={console,setTimeout,clearTimeout,document:{activeElement:null,body:{},getElementById:()=>({dataset:{}})},location:{search:'',hash:'',href:'https://preview.invalid/index.html?page=capabilities'},URLSearchParams,URL};
context.window=context;context.self=context;context.ReactDOM={createPortal:node=>node,createRoot:()=>({render:()=>{}})};
vm.createContext(context);vm.runInContext(read('vendor/react.production.min.js'),context);vm.runInContext(bundle,context);
const React=context.React, ds=context[registry.namespace];
function mount(component,initialProps){
  const state=[],refs=[],ids=[];let index=0,props=initialProps;
  const dispatcher={useState(initial){const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return[state[i],v=>state[i]=typeof v==='function'?v(state[i]):v];},useRef(value){const i=index++;return refs[i]??(refs[i]={current:value});},useId(){const i=index++;return ids[i]??(ids[i]='test-'+i);},useEffect(){index++;},useLayoutEffect(){index++;},useMemo(fn){index++;return fn();},useCallback(fn){index++;return fn;}};
  return {render(next=props){props=next;index=0;React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current=dispatcher;try{return component(props);}finally{React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current=null;}}};
}
function nodes(node,predicate){if(node==null||typeof node==='boolean')return[];if(Array.isArray(node))return node.flatMap(n=>nodes(n,predicate));if(typeof node!=='object')return[];return [...(predicate(node)?[node]:[]),...nodes(node.props?.children,predicate)];}
const native=(tree,type)=>nodes(tree,n=>n.type===type);
function key(key,more={}){return {key,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},stopPropagation(){},...more};}
let cases=0;
function check(name,fn){fn();cases++;process.stdout.write('PASS '+name+'\n');}

const scripts=[...read('ui_kits/enterprise-app/index.html').matchAll(/<script src="([^"]+)"/g)].map(m=>m[1]).filter(s=>!s.startsWith('../../'));
for(const file of scripts)vm.runInContext(read('ui_kits/enterprise-app/'+file),context,{filename:file});
const button=(tree,label)=>nodes(tree,n=>n.type===ds.Button&&n.props.children===label)[0];
const section=(tree,title)=>nodes(tree,n=>n.type===ds.SettingsSection&&n.props.title===title)[0];
const props=id=>({item:{id,name:id,enabled:true},editing:false,onPatch:()=>{},onEdit:()=>{},onBack:()=>{},onUse:()=>{},onRemove:()=>{}});
check('custom agent composes execution, cognition, input/output and workflow',()=>{
 const t=mount(context.AgentWorkbench,props('credit')).render();
 for(const title of ['默认执行配置','出生时继承','输入输出','工作流程'])assert.ok(section(t,title));
});
check('external agent has project directory without internal execution or edit chat',()=>{
 const t=mount(context.AgentWorkbench,{...props('codex'),editing:true}).render();
 assert.ok(section(t,'项目目录'));assert.ok(section(t,'P3394 Gateway'));
 for(const title of ['默认执行配置','输入输出','工作流程'])assert.equal(section(t,title),undefined);
 assert.equal(native(t,'aside').length,0);
});
check('platform edits only memory, with immutable definition and output format',()=>{
 const t=mount(context.AgentWorkbench,{...props('compliance'),editing:true}).render();
 assert.equal(nodes(t,n=>n.type===ds.Input).length,0);assert.equal(nodes(t,n=>n.type===ds.Textarea).length,0);
 assert.equal(nodes(t,n=>n.type===ds.Select)[0].props.disabled,true);
 const lists=nodes(t,n=>n.props?.title==='核心记忆'||n.props?.title==='擅长能力');
 assert.equal(lists.find(n=>n.props.title==='核心记忆').props.editable,true);
 assert.equal(lists.find(n=>n.props.title==='擅长能力').props.editable,false);
});
check('commander cannot be disabled or uninstalled and has no output preference',()=>{
 const t=mount(context.AgentWorkbench,props('commander')).render();
 assert.equal(button(t,'停用'),undefined);assert.equal(button(t,'卸载'),undefined);
 assert.equal(section(t,'输入输出'),undefined);assert.equal(section(t,'出生时继承'),undefined);
});
check('disabled custom agent remains manageable, but cannot start work',()=>{
 const t=mount(context.AgentWorkbench,{...props('credit'),item:{id:'credit',name:'授信分析师',enabled:false}}).render();
 assert.equal(button(t,'使用智能体').props.disabled,true);assert.ok(button(t,'编辑'));assert.ok(button(t,'启用'));
});
check('name validation and provider change preserve edit invariants',()=>{
 let change;const m=mount(context.AgentWorkbench,{...props('credit'),editing:true,item:{id:'credit',name:' ',enabled:true},onPatch:v=>change=v});const t=m.render();
 assert.equal(button(t,'完成编辑').props.disabled,true);
 nodes(t,n=>n.type===ds.Select&&n.props['aria-label']==='默认提供方')[0].props.onChange('DeepSeek');
 assert.equal(change.provider,'DeepSeek');assert.equal(change.model,'跟随全局默认');
});
check('inheritance distinguishes missing historical record from known empty snapshot',()=>{
 const absent=section(mount(context.AgentWorkbench,props('credit')).render(),'出生时继承');
 const empty=section(mount(context.AgentWorkbench,props('report')).render(),'出生时继承');
 assert.ok(JSON.stringify(absent).includes('尚未记录出生认知'));assert.ok(JSON.stringify(empty).includes('没有可继承的认知'));
});
check('uninstall requires explicit confirmation and supports cancellation',()=>{
 let removed=0;const m=mount(context.AgentWorkbench,{...props('credit'),onRemove:()=>removed++});button(m.render(),'卸载').props.onClick();assert.equal(removed,0);
 let dialog=nodes(m.render(),n=>n.type===ds.InlineConfirm)[0];dialog.props.onCancel();assert.equal(nodes(m.render(),n=>n.type===ds.InlineConfirm).length,0);
 button(m.render(),'卸载').props.onClick();nodes(m.render(),n=>n.type===ds.InlineConfirm)[0].props.onConfirm();assert.equal(removed,1);
});
check('direct editor URL resolves and return clears both agent and editing state',()=>{
 context.location.search='?page=capabilities&tab=0&agent=credit&edit=1';context.location.href='https://preview.invalid/index.html'+context.location.search;
 context.history={pushState:(_,__,url)=>{context.location.href=String(url);context.location.search=new URL(url).search;}};
 const m=mount(context.CapabilitiesScreen,{});let t=m.render();let workbench=nodes(t,n=>n.type===context.AgentWorkbench)[0];assert.equal(workbench.props.item.id,'credit');assert.equal(workbench.props.editing,true);
 workbench.props.onBack();assert.equal(nodes(m.render(),n=>n.type===context.AgentWorkbench).length,0);assert.equal(new URL(context.location.href).searchParams.has('agent'),false);assert.equal(new URL(context.location.href).searchParams.has('edit'),false);
 const disabled=nodes(m.render(),n=>n.type===ds.ResourceCard&&n.props.title==='经营分析师')[0];assert.equal(disabled.props.disabled,true);disabled.props.onOpen();assert.equal(nodes(m.render(),n=>n.type===context.AgentWorkbench)[0].props.item.id,'report');
});
check('missing agent URL offers recovery rather than another agent',()=>{
 context.location.search='?page=capabilities&agent=missing';const t=mount(context.CapabilitiesScreen,{}).render();assert.equal(nodes(t,n=>n.type===context.AgentWorkbench).length,0);assert.equal(nodes(t,n=>n.type===ds.EmptyState)[0].props.action,'返回列表');
});
process.stdout.write(`Verified ${cases} agent offline contracts. No browser or business-execution claim.\n`);
