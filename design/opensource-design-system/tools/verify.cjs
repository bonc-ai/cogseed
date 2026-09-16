/* Offline contract checks. Exercises React elements/callbacks with a hook dispatcher;
 * it deliberately does not claim DOM layout, native keyboard or browser acceptance. */
const fs=require('node:fs'), path=require('node:path'), vm=require('node:vm'), crypto=require('node:crypto'), assert=require('node:assert/strict');
require('./verify-source.cjs');
const root=path.resolve(__dirname,'..'), read=p=>fs.readFileSync(path.join(root,p),'utf8');
const registry=JSON.parse(read('components/registry.json')), manifest=JSON.parse(read('_ds_manifest.json'));
const bundle=read('_ds_bundle.js'), meta=JSON.parse(bundle.match(/\/\* @ds-bundle: (.*?) \*\//s)[1]);
assert.equal(meta.version,manifest.version);
assert.equal(meta.version,JSON.parse(read('version.json')).version);
assert.deepEqual(registry.components,manifest.components);
assert.deepEqual(registry.components,meta.components);
for(const [file,hash] of Object.entries(meta.sourceHashes))assert.equal(crypto.createHash('sha256').update(read(file)).digest('hex').slice(0,12),hash,file);
const context={console,setTimeout,clearTimeout,document:{activeElement:null,body:{},getElementById:()=>({dataset:{}})},location:{search:'',hash:''},URLSearchParams};
context.window=context;context.self=context;context.ReactDOM={createPortal:node=>node,createRoot:()=>({render:()=>{}})};
vm.createContext(context);vm.runInContext(read('vendor/react.production.min.js'),context);vm.runInContext(bundle,context);
const React=context.React, ds=context[registry.namespace];
function mount(component,initialProps){
  const state=[],refs=[],ids=[],effects=[];let index=0,props=initialProps;
  const dispatcher={useState(initial){const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return[state[i],v=>state[i]=typeof v==='function'?v(state[i]):v];},useRef(value){const i=index++;return refs[i]??(refs[i]={current:value});},useId(){const i=index++;return ids[i]??(ids[i]='test-'+i);},useEffect(fn){index++;effects.push(fn);},useLayoutEffect(){index++;},useMemo(fn){index++;return fn();},useCallback(fn){index++;return fn;}};
  return {flushEffects(){return effects.splice(0).map(fn=>fn()).filter(Boolean);},render(next=props){props=next;index=0;React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current=dispatcher;try{return component(props);}finally{React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current=null;}}};
}
function nodes(node,predicate){if(node==null||typeof node==='boolean')return[];if(Array.isArray(node))return node.flatMap(n=>nodes(n,predicate));if(typeof node!=='object')return[];return [...(predicate(node)?[node]:[]),...nodes(node.props?.children,predicate),...nodes(node.props?.search,predicate),...nodes(node.props?.actions,predicate),...nodes(node.props?.leading,predicate)];}
const native=(tree,type)=>nodes(tree,n=>n.type===type);
function key(key,more={}){return {key,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},stopPropagation(){},...more};}
let cases=0;
function check(name,fn){fn();cases++;process.stdout.write('PASS '+name+'\n');}
check('loading button blocks reactivation and exposes busy without changing geometry',()=>{
  const onClick=()=>{throw Error('loading click must be blocked');};
  const m=mount(ds.Button,{children:'提交材料',onClick});const idle=m.render(),busy=m.render({children:'提交材料',onClick,loading:true});
  assert.equal(busy.props.disabled,true);assert.equal(busy.props['aria-busy'],true);assert.equal(busy.props.onClick,undefined);assert.equal(busy.props.style.height,idle.props.style.height);assert.equal(busy.props.style.padding,idle.props.style.padding);
});
check('empty-state action uses shared Button and preserves callback',()=>{
  let count=0;const t=mount(ds.EmptyState,{title:'无结果',action:'清除筛选',onAction:()=>count++}).render();const b=nodes(t,n=>n.type===ds.Button)[0];assert.ok(b);b.props.onClick();assert.equal(count,1);
});
check('field associates explicit control id, error and existing descriptions',()=>{
  const t=mount(ds.Field,{label:'名称',error:'名称不能为空',children:React.createElement(ds.Input,{id:'name','aria-describedby':'existing'})}).render();
  const label=native(t,'label')[0], input=nodes(t,n=>n.type===ds.Input)[0],error=nodes(t,n=>n.props?.role==='alert')[0];
  assert.equal(label.props.htmlFor,'name');assert.equal(input.props['aria-invalid'],true);assert.equal(input.props['aria-describedby'],'existing '+error.props.id);
});
check('Select opens by keyboard, skips duplicated disabled values and preserves selection',()=>{
  let selected;const m=mount(ds.Select,{options:['允许','禁止'],disabledOptions:['禁止'],value:'允许',onChange:v=>selected=v,'aria-label':'范围'});
  let t=m.render();native(t,'button')[0].props.onKeyDown(key('ArrowDown',{isComposing:true}));assert.equal(native(m.render(),'button')[0].props['aria-expanded'],false);
  native(t,'button')[0].props.onKeyDown(key('ArrowDown'));t=m.render();const opts=nodes(t,n=>n.props?.role==='option');assert.equal(opts.length,2);assert.equal(opts[1].props.disabled,true);opts[0].props.onClick();assert.equal(selected,'允许');assert.equal(native(m.render(),'button')[0].props['aria-expanded'],false);
});
check('searchable selector keeps filtering and empty-result recovery',()=>{
  let selected;const m=mount(ds.SearchableSelect,{options:['华东','华北'],onChange:v=>selected=v});native(m.render(),'button')[0].props.onClick();let t=m.render();native(t,'input')[0].props.onChange({target:{value:'不存在'}});assert.equal(nodes(m.render(),n=>n.props?.role==='option').length,0);native(m.render(),'input')[0].props.onChange({target:{value:'华东'}});t=m.render();nodes(t,n=>n.props?.role==='option')[0].props.onClick();assert.equal(selected,'华东');
});
check('dropdown uncontrolled notifications do not prevent internal opening',()=>{
  const changes=[];let called=0;const m=mount(ds.DropdownMenu,{trigger:React.createElement(ds.IconButton,{title:'菜单'}),onOpenChange:v=>changes.push(v),groups:[{items:[{label:'设置',onSelect:()=>called++}]}]});
  nodes(m.render(),n=>n.type===ds.IconButton)[0].props.onClick(key(''));const item=nodes(m.render(),n=>n.props?.role==='menuitem')[0];assert.ok(item);item.props.onClick();assert.equal(called,1);assert.deepEqual(changes,[true,false]);
});
check('segmented filter exposes native buttons and selected state',()=>{
  let value;const t=mount(ds.SegmentedControl,{items:['全部','已归档'],value:0,onChange:v=>value=v}).render();const buttons=native(t,'button');assert.equal(buttons[0].props['aria-pressed'],true);buttons[1].props.onClick();assert.equal(value,1);
});
check('dialog has labelled modal semantics and shared destructive action',()=>{
  const t=mount(ds.Dialog,{title:'删除配置？',description:'其他配置保留。',confirmLabel:'删除配置',danger:true}).render();const dialog=nodes(t,n=>n.props?.role==='dialog')[0];assert.equal(String(dialog.props['aria-modal']),'true');assert.ok(nodes(t,n=>n.props?.id===dialog.props['aria-labelledby']).length);const buttons=nodes(t,n=>n.type===ds.Button);assert.equal(buttons[1].props.variant,'dangerSolid');assert.equal(buttons[1].props.children,'删除配置');
});
check('TagInput composition does not add or remove tags',()=>{
  let count=0;const t=mount(ds.TagInput,{tags:['华东'],onChange:()=>count++}).render();native(t,'input')[0].props.onKeyDown(key('Backspace',{isComposing:true}));assert.equal(count,0);
});
// Load generated page modules in the same order as the actual entry, then inspect composition.
const scripts=[...read('ui_kits/enterprise-app/index.html').matchAll(/<script src="([^"]+)"/g)].map(m=>m[1]).filter(s=>!s.startsWith('../../'));
for(const file of scripts)vm.runInContext(read('ui_kits/enterprise-app/'+file),context,{filename:file});
check('workspace empty result integrates the shared recovery action',()=>{
  const t=mount(context.SpaceHubScreen,{spaces:[],setSpaces:()=>{}}).render();const empty=nodes(t,n=>n.type===ds.EmptyState)[0];assert.equal(empty.props.action,'新建空间');empty.props.onAction();
});
check('workspace search filters created spaces and continues the selected task',()=>{
  const spaces=[{id:'active',name:'日常',sub:'',tasks:[],count:0},{id:'history',name:'历史',sub:'',tasks:[['idle','历史任务']],count:1}];
  let opened;const m=mount(context.SpaceHubScreen,{spaces,setSpaces:()=>{},onOpenTask:t=>opened=t});
  let page=m.render();assert.equal(nodes(page,n=>n.type===ds.SegmentedControl).length,0);
  nodes(page,n=>n.type===ds.Input)[0].props.onChange({target:{value:'历史'}});
  const cards=nodes(m.render(),n=>n.type===ds.ResourceCard&&n.props.variant==='workspace');assert.equal(cards.length,1);assert.equal(cards[0].props.title,'历史');cards[0].props.onAction();assert.equal(opened.spaceId,'history');assert.equal(opened.title,'历史任务');
});
check('settings selection forwards accessible name to the shared Select',()=>{
  const t=context.SettingsChoice({label:'语言',options:['简体中文'],value:'简体中文',onChange:()=>{}});assert.equal(nodes(t,n=>n.type===ds.Select)[0].props['aria-label'],'语言');
});
check('cognition page status uses the shared StatusPill contract',()=>{
  const t=context.CogStatus({children:'待确认',tone:'attention'});assert.equal(t.type,ds.StatusPill);assert.equal(t.props.tone,'attention');
});
check('settings and workspace confirmations share the same action surface',()=>{
  const onConfirm=()=>{};const t=context.SettingsConfirm({title:'撤销访问？',confirmLabel:'撤销访问',onConfirm});assert.equal(t.type,ds.InlineConfirm);assert.equal(t.props.confirmLabel,'撤销访问');assert.equal(t.props.onConfirm,onConfirm);
});
check('space detail restores asset tab and keeps new task in its space',()=>{
  context.location={search:'?page=space&space=space-0&view=assets',href:'https://preview.invalid/?page=space&space=space-0&view=assets'};
  context.URL=URL;context.history={pushState:(_,__,url)=>{context.location.search=url.search;}};
  let spaces=[{id:'space-0',name:'项目空间',tasks:[['idle','核验材料']],count:1}],opened;
  const m=mount(context.SpaceDetailScreen,{space:spaces[0],setSpaces:fn=>spaces=fn(spaces),onOpenTask:t=>opened=t});
  let t=m.render();assert.equal(nodes(t,n=>n.type===context.PageTabs)[0].props.value,2);
  nodes(t,n=>n.type===context.PageTabs)[0].props.onChange(0);t=m.render();
  assert.equal(new URLSearchParams(context.location.search).get('view'),'tasks');
  const header=nodes(t,n=>n.type===context.PageHeader)[0];
  nodes(header.props.actions,n=>n.type===ds.Button&&n.props.children==='新建任务')[0].props.onClick();
  assert.equal(spaces[0].tasks.length,2);assert.equal(spaces[0].count,2);assert.equal(opened.title,'新任务');
});
check('space list opens detail even when the space has no tasks',()=>{
  let opened;const space={id:'empty',name:'空空间',sub:'',tasks:[],count:0};
  const t=mount(context.SpaceHubScreen,{spaces:[space],setSpaces:()=>{},onOpenSpace:s=>opened=s}).render();
  nodes(t,n=>n.type===ds.ResourceCard&&n.props.title==='空空间')[0].props.onOpen();assert.equal(opened.id,'empty');
});
check('missing space has a recoverable return action',()=>{
  let back=false;const t=mount(context.SpaceDetailScreen,{space:null,onBack:()=>back=true}).render();
  nodes(t,n=>n.type===ds.EmptyState)[0].props.onAction();assert.equal(back,true);
});

check('global content search matches summaries and keeps same-title messages distinct',()=>{
 let selected;const m=mount(ds.CommandPalette,{groups:[{id:'chat',label:'任务',items:[{id:'m1',title:'核验任务',snippet:'到期材料'},{id:'m2',title:'核验任务',snippet:'到期提醒'}]}],onSelect:item=>selected=item});
 let t=m.render();assert.equal(nodes(t,n=>n.props?.['data-search-index']!==undefined).length,0);
 native(t,'input')[0].props.onChange({target:{value:'到期'}});t=m.render();assert.equal(nodes(t,n=>n.props?.['data-search-index']!==undefined).length,2);
 native(t,'input')[0].props.onKeyDown(key('Enter',{isComposing:true}));assert.equal(selected,undefined);
 native(t,'input')[0].props.onKeyDown(key('ArrowDown'));native(m.render(),'input')[0].props.onKeyDown(key('Enter'));assert.equal(selected.id,'m2');
});
check('home scenario selects the matching recipient and placeholder before submit',()=>{
 let submitted;const m=mount(context.HomeScreen,{onSubmit:v=>submitted=v});let t=m.render();
 nodes(t,n=>n.type===ds.Button&&n.props.children==='深度研究')[0].props.onClick();t=m.render();const composer=nodes(t,n=>n.type===ds.Composer)[0];
 assert.equal(composer.props.recipient.name,'DeepResearcher');assert.equal(composer.props.value.slice(composer.props.editorSelection.start,composer.props.editorSelection.end),'[主题]');composer.props.onSend();assert.equal(submitted.content,'empty');assert.ok(submitted.initialMessage.startsWith('深度研究'));
});
check('new workspace starts without fabricated artifacts or assets',()=>{
 const t=mount(context.SpaceDetailScreen,{space:{id:'new',name:'新空间',tasks:[['idle','新任务']]},setSpaces:()=>{}}).render();
 const tabs=nodes(t,n=>n.type===context.PageTabs)[0].props.items;assert.equal(tabs[1].count,0);assert.equal(tabs[2].count,0);
});

check('dynamic unknown icons warn only in explicit preview debug mode',()=>{
 const previous=context.console;let warnings=0;context.console={...previous,warn:()=>warnings++};
 try{context.COGSEED_DESIGN_DEBUG=true;assert.equal(mount(ds.Icon,{name:'toString'}).render(),null);assert.equal(warnings,1);context.COGSEED_DESIGN_DEBUG=false;assert.equal(mount(ds.Icon,{name:'not-an-icon'}).render(),null);assert.equal(warnings,1);assert.equal(mount(ds.Icon,{name:'check'}).render().type,'svg');}finally{context.console=previous;context.COGSEED_DESIGN_DEBUG=false;}
});
check('table preserves headers, sort direction and explicit row selection',()=>{
 let sorted,selected;const t=mount(ds.DataTable,{columns:[{key:'name',label:'名称',sortable:true}],rows:[{name:'材料'}],sortKey:'name',sortDir:-1,onSort:v=>sorted=v,onSelect:v=>selected=v}).render();
 assert.equal(native(t,'table').length,1);assert.equal(native(t,'th')[0].props.scope,'col');assert.equal(native(t,'th')[0].props['aria-sort'],'descending');
 const b=native(t,'button');b[0].props.onClick();b[1].props.onClick();assert.equal(sorted,'name');assert.equal(selected,0);
 assert.equal(native(mount(ds.DataTable,{columns:[],rows:[]}).render(),'button').length,0);
});
check('pagination exposes current middle page and bounded edge controls',()=>{
 let page;const t=mount(ds.Pagination,{page:6,pageCount:12,onChange:v=>page=v,total:12345,locale:'de-DE'}).render();
 const b=native(t,'button');assert.ok(b.some(n=>n.props['aria-current']==='page'&&n.props.children===6));b[b.length-1].props.onClick();assert.equal(page,7);
 assert.equal(native(mount(ds.Pagination,{page:1,pageCount:1,onChange:()=>{}}).render(),'button').filter(n=>n.props.disabled).length,2);
 const text=JSON.stringify(t);assert.ok(text.includes('12.345'));
});
check('radio and radio card expose native group identity and help',()=>{
 let changed=false;for(const c of [ds.Radio,ds.RadioCard]){
 const t=mount(c,{name:'access',value:'limited',label:'谨慎',title:'谨慎',help:'需确认',checked:false,onChange:v=>changed=v}).render();const input=native(t,'input')[0];assert.equal(input.props.type,'radio');assert.equal(input.props.name,'access');assert.equal(input.props.value,'limited');input.props.onChange();assert.equal(changed,true);
 }
 assert.equal(native(mount(ds.Radio,{disabled:true}).render(),'input')[0].props.disabled,true);
});
check('checkbox uses native checked and indeterminate state',()=>{
 let value;const m=mount(ds.Checkbox,{indeterminate:true,label:'选择材料',onChange:v=>value=v}),t=m.render(),input=native(t,'input')[0];input.ref.current={indeterminate:false};m.flushEffects();assert.equal(input.ref.current.indeterminate,true);input.props.onChange({target:{checked:true}});assert.equal(value,true);
});
check('accordion keeps a stable controlled panel when collapsed',()=>{
 const m=mount(ds.Accordion,{items:[{title:'材料',body:'详情'}],defaultOpen:[]});let t=m.render(),b=native(t,'button')[0];let panel=nodes(t,n=>n.props?.id===b.props['aria-controls'])[0];assert.equal(panel.props.hidden,true);b.props.onClick();t=m.render();assert.equal(native(t,'button')[0].props['aria-expanded'],true);
});
check('stepper disables bounds and clamps the next value',()=>{
 let value;const b=native(mount(ds.Stepper,{value:9,min:0,max:10,step:5,onChange:v=>value=v}).render(),'button');b[1].props.onClick();assert.equal(value,10);
 assert.equal(native(mount(ds.Stepper,{value:0,min:0,onChange:()=>{}}).render(),'button')[0].props.disabled,true);
});
check('feedback and file removal expose named native actions',()=>{
 for(const component of [ds.Alert,ds.Toast]){let closed=0,acted=0;const t=mount(component,{action:'查看',onAction:()=>acted++,onClose:()=>closed++}).render();const b=native(t,'button');b[0].props.onClick();b[1].props.onClick();assert.equal(acted,1);assert.equal(closed,1);assert.ok(b[1].props['aria-label']);}
 let removed=0;const b=native(mount(ds.FileRow,{name:'材料.pdf',onRemove:()=>removed++}).render(),'button')[0];assert.equal(b.props['aria-label'],'移除 材料.pdf');b.props.onClick();assert.equal(removed,1);
});
check('task and date presets expose selected state and preserve callbacks',()=>{
 let chosen;const t=mount(ds.TaskListItem,{title:'任务',selected:true,onClick:()=>chosen='task'}).render();assert.equal(t.type,'button');assert.equal(t.props['aria-pressed'],true);t.props.onClick();assert.equal(chosen,'task');
 const b=native(mount(ds.DateRangePicker,{value:'旧区间',presets:['近 7 天'],preset:'近 7 天',onPreset:v=>chosen=v}).render(),'button')[0];assert.equal(b.props['aria-pressed'],true);b.props.onClick();assert.equal(chosen,'近 7 天');
});
check('composer fits its containing conversation with a side pane open',()=>{
 const t=mount(ds.Composer,{}).render();assert.equal(t.props.style.minWidth,'min(100%, var(--cs-composer-width-min))');
 assert.equal(nodes(t,n=>n.props?.className==='cs-composer-toolbar')[0].props.style.flexWrap,undefined);
});
check('date range forwards native input values, rejects reversed ranges and resolves host presets',()=>{
 let changed;const t=mount(ds.DateRangePicker,{value:{start:'2026-09-01',end:'2026-09-15'},onChange:r=>changed=r,presets:['财年'],presetRanges:{'财年':{start:'2026-04-01',end:'2027-03-31'}}}).render();
 const fields=nodes(t,n=>n.type===ds.Input);assert.equal(fields.length,2);
 fields[0].props.onChange({target:{value:'2026-09-10',reportValidity:()=>true}});assert.equal(changed.start,'2026-09-10');
 changed=null;fields[0].props.onChange({target:{value:'2026-09-20',reportValidity:()=>true}});assert.equal(changed,null);
 fields[1].props.onChange({target:{value:'',validity:{badInput:true}}});assert.equal(changed,null);
 native(t,'button')[0].props.onClick();assert.equal(changed.end,'2027-03-31');
 assert.equal(nodes(mount(ds.DateRangePicker,{value:'旧区间'}).render(),n=>n.type===ds.Input).length,0);
});
check('date draft preserves invalid input, recovers across months and clears both bounds',()=>{
 let changed;const m=mount(ds.DateRangePicker,{value:{start:'2026-09-18',end:'2026-09-30'},presets:[],onChange:r=>changed=r});let t=m.render();
 let inputs=nodes(t,n=>n.type===ds.Input);inputs[0].props.onChange({target:{value:'2026-10-01'}});t=m.render();assert.equal(nodes(t,n=>n.type===ds.Input)[0].props.value,'2026-10-01');assert.equal(nodes(t,n=>n.props?.role==='alert').length,1);assert.equal(changed,undefined);
 nodes(t,n=>n.type===ds.Input)[1].props.onChange({target:{value:'2026-10-31'}});t=m.render();assert.equal(changed.start,'2026-10-01');assert.equal(nodes(t,n=>n.props?.role==='alert').length,0);
 nodes(t,n=>n.type===ds.Button)[0].props.onClick();assert.equal(changed.start,'');assert.equal(changed.end,'');
});
check('date validation rejects impossible leap dates and accepts real leap dates',()=>{
 let result;const m=mount(ds.DateRangePicker,{value:{start:'',end:''},presets:[],onChange:r=>result=r});let t=m.render();nodes(t,n=>n.type===ds.Input)[0].props.onChange({target:{value:'2026-02-29'}});t=m.render();assert.equal(result,undefined);assert.equal(nodes(t,n=>n.props?.role==='alert').length,1);
 nodes(t,n=>n.type===ds.Input)[0].props.onChange({target:{value:'2028-02-29'}});assert.equal(result.start,'2028-02-29');
});
check('artifact date filter preserves inclusive boundaries and supports empty recovery',()=>{
 const rows=[{name:'甲',due:'2026-09-18'},{name:'乙',due:'2026-09-30'},{name:'丙',due:'2026-10-01'}];const page=mount(context.TaskScreen,{initialPane:'artifact'}).render();const pane=nodes(page,n=>n.props?.pane==='artifact'&&n.props.rows)[0];const paneTree=mount(pane.type,{...pane.props,rows}).render();const table=nodes(paneTree,n=>n.props?.rows===rows)[0];const m=mount(table.type,table.props);let t=m.render();
 nodes(t,n=>n.type===ds.DateRangePicker)[0].props.onChange({start:'2026-09-30',end:'2026-10-01'});t=m.render();assert.equal(nodes(t,n=>n.type===ds.DataTable)[0].props.rows.length,2);
 nodes(t,n=>n.type===ds.DateRangePicker)[0].props.onChange({start:'2026-11-01',end:''});t=m.render();const empty=nodes(t,n=>n.type===ds.EmptyState)[0];assert.ok(empty);empty.props.onAction();t=m.render();assert.equal(nodes(t,n=>n.type===ds.DataTable)[0].props.rows.length,3);
});
check('calendar and breadcrumb use named native actions without fake terminal actions',()=>{
 let selected;const days=native(mount(ds.Calendar,{days:29,month:'2028 年 2 月',onSelect:d=>selected=d}).render(),'button');assert.equal(days.length,29);days[28].props.onClick();assert.equal(selected,29);
 assert.ok(native(mount(ds.Calendar,{}).render(),'button').every(n=>n.props.disabled));
 const t=mount(ds.Breadcrumb,{items:['工作空间','…','当前页'],onNavigate:(item,index)=>selected=[item,index]}).render();
 assert.equal(t.type,'nav');const b=native(t,'button');assert.equal(b.length,1);b[0].props.onClick();assert.equal(selected[1],0);assert.equal(nodes(t,n=>n.props?.['aria-current']==='page').length,1);
 assert.equal(native(mount(ds.Breadcrumb,{items:['只读','当前页']}).render(),'button').length,0);
});
check('alert text meets contrast after compositing at its actual opacity',()=>{
 const colors=Object.fromEntries([...read('tokens/colors.css').matchAll(/(--cs-[\w-]+):#([0-9A-Fa-f]{6})/g)].map(m=>[m[1],m[2]]));
 const rgb=h=>[0,2,4].map(i=>parseInt(h.slice(i,i+2),16)/255),lum=a=>a.reduce((s,c,i)=>s+[.2126,.7152,.0722][i]*(c<=.04045?c/12.92:((c+.055)/1.055)**2.4),0);
 for(const tone of ['attention','critical']){const t=mount(ds.Alert,{tone,children:'需要处理'}).render(),body=nodes(t,n=>n.props?.children==='需要处理')[0];const fg=rgb(colors[body.props.style.color.slice(4,-1)]),bg=rgb(colors[t.props.style.background.slice(4,-1)]),opacity=body.props.style.opacity??1;const l=[lum(fg.map((c,i)=>c*opacity+bg[i]*(1-opacity))),lum(bg)].sort((a,b)=>a-b);assert.ok((l[1]+.05)/(l[0]+.05)>=4.5,tone);}
});
check('settings permission cards share a native radio group in the real sample',()=>{
 const m=mount(context.SettingsGeneral,{});let cards=nodes(m.render(),n=>n.type===ds.RadioCard);assert.equal(cards.length,3);assert.equal(new Set(cards.map(n=>n.props.name)).size,1);assert.equal(cards[1].props.checked,true);cards[0].props.onChange(true);cards=nodes(m.render(),n=>n.type===ds.RadioCard);assert.equal(cards[0].props.checked,true);assert.equal(cards[1].props.checked,false);

});
check('modal isolation restores background, nested state, scroll and focus',()=>{
 const background={inert:false},alreadyInert={inert:true},listeners=new Set();let returned=0;
 context.document={body:{children:[background,alreadyInert],style:{overflow:'auto'}},activeElement:{isConnected:true,focus(){returned++;}},addEventListener(_,fn){listeners.add(fn);},removeEventListener(_,fn){listeners.delete(fn);}};
 context.MutationObserver=class{observe(){}disconnect(){}};
 const make=()=>{const m=mount(ds.Dialog,{title:'确认',confirmLabel:'继续',onCancel:()=>{}}),t=m.render(),panel=nodes(t,n=>n.props?.role==='dialog')[0];const backdrop={inert:false};context.document.body.children.push(backdrop);panel.ref.current={parentElement:backdrop};const cancel=native(t,'span').find(n=>n.ref);cancel.ref.current={querySelector:()=>({focus(){}})};const cleanup=m.flushEffects()[0];return{backdrop,cleanup};};
 const a=make();assert.equal(background.inert,true);assert.equal(a.backdrop.inert,false);assert.equal(context.document.body.style.overflow,'hidden');
 const b=make();assert.equal(a.backdrop.inert,true);assert.equal(b.backdrop.inert,false);b.cleanup();assert.equal(a.backdrop.inert,false);assert.equal(background.inert,true);a.cleanup();assert.equal(background.inert,false);assert.equal(alreadyInert.inert,true);assert.equal(context.document.body.style.overflow,'auto');assert.equal(listeners.size,0);assert.equal(returned,2);
});

process.stdout.write(`Verified ${cases} offline contracts and ${Object.keys(meta.sourceHashes).length} source hashes. Browser/DOM verification remains separate.\n`);
