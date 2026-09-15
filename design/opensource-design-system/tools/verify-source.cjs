/* Source guard: JSX semantics and token references. Run by verify.cjs. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const parser=require('@babel/parser');
const root=path.resolve(__dirname,'..');
const files=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(d,e.name)):[path.join(d,e.name)]);
const errors=[];
function walk(n,fn){if(!n||typeof n!=='object')return;fn(n);for(const [k,v] of Object.entries(n)){if(k==='loc')continue;if(Array.isArray(v))v.forEach(x=>walk(x,fn));else if(v&&typeof v==='object')walk(v,fn);}}
const icons=JSON.parse(fs.readFileSync(path.join(root,'assets/lucide/manifest.json'))).icons;
function inspectJsx(s,rel){
 const failures=[];
 walk(parser.parse(s,{sourceType:'module',plugins:['jsx']}),n=>{
  const fail=msg=>failures.push(`${rel}:${n.loc.start.line}: ${msg}`);
  if(n.type==='StringLiteral'&&/#[0-9a-fA-F]{3,8}\b/.test(n.value))fail('raw hex; use a token');
  if(n.type==='ObjectProperty'&&n.key.name==='outline'&&n.value.type==='StringLiteral'&&n.value.value==='none')fail('inline focus suppression');
  if(n.type==='ObjectProperty'&&/^(gap|rowGap|columnGap|padding(?:Top|Bottom|Left|Right|Block|Inline)?|margin(?:Top|Bottom|Left|Right|Block|Inline)?)$/.test(n.key.name)){
    const value=n.value;
    if(value.type==='NumericLiteral'&&value.value>0&&value.value<=88)fail('layout spacing must use a token');
    if(value.type==='StringLiteral'&&/^(?:[\d.]+px|0)(?:\s+(?:[\d.]+px|0))*$/.test(value.value)&&/px/.test(value.value))fail('layout spacing must use a token');
  }
  if(n.type!=='JSXOpeningElement')return;
  const tag=n.name.name,attrs=Object.fromEntries(n.attributes.filter(a=>a.type==='JSXAttribute').map(a=>[a.name.name,a.value]));
  if(tag==='Icon'&&attrs.name?.type==='StringLiteral'&&!icons[attrs.name.value])fail('unknown icon '+attrs.name.value);
  // Dialog backdrop dismissal/propagation are pointer containment, not action controls.
  const containment=(rel==='components/feedback/Dialog.jsx'&&tag==='div') || (rel==='components/retrieval/CommandPalette.jsx'&&tag==='div'&&attrs.className?.value==='cs-search-backdrop') || (rel==='components/navigation/SidebarTasks.jsx'&&tag==='dialog') || (rel==='ui_kits/enterprise-app/App.jsx'&&tag==='div'&&['backdrop','panel'].includes(attrs['data-cs-pointer-containment']?.value));
  if(attrs.onClick&&/^[a-z]/.test(tag)&&!['button','input','select','textarea','a','summary'].includes(tag)&&!containment){
   if(!attrs.role||!attrs.tabIndex||!attrs.onKeyDown)fail('click-only non-native action');
  }
 });
 return failures;
}

for(const fixture of [
 {source:'const x=<button onClick={()=>{}}>执行</button>',valid:true},
 {source:'const x=<span onClick={()=>{}}>执行</span>',valid:false},
 {source:'const x=<div role="button" tabIndex={0} onClick={()=>{}}>执行</div>',valid:false},
 {source:'const x=<input type="radio" name="group" />',valid:true},
 {source:'const x=<div style={{gap:10}} />',valid:false},
 {source:'const x=<button style={{outline:"none"}}>执行</button>',valid:false},
 {source:'const x=<div style={{gap:"var(--cs-space-2)"}} />',valid:true},
 {source:'const x=<Icon name="not-a-real-icon" />',valid:false},
 {source:'const x=<Icon name="check" />',valid:true},
 {source:'const x=<span style={{color:"#fff"}}>内容</span>',valid:false}
])assert.equal(inspectJsx(fixture.source,'fixture.jsx').length===0,fixture.valid,fixture.source);
for(const file of [...files(path.join(root,'components')),...files(path.join(root,'ui_kits'))].filter(f=>f.endsWith('.jsx'))){
 errors.push(...inspectJsx(fs.readFileSync(file,'utf8'),path.relative(root,file)));
}
const css=files(path.join(root,'tokens')).filter(f=>f.endsWith('.css')).map(f=>fs.readFileSync(f,'utf8')).join('\n');
const definitions=new Set([...css.matchAll(/(--cs-[\w-]+)\s*:/g)].map(m=>m[1]));
for(const file of files(root).filter(f=>/\.(jsx|css|html)$/.test(f)&&!f.includes('/vendor/'))){
 for(const match of fs.readFileSync(file,'utf8').matchAll(/var\(\s*(--cs-[\w-]+)/g))if(!definitions.has(match[1])&&!['--cs-button-bg','--cs-button-shadow','--cs-card-shadow'].includes(match[1]))errors.push(`${path.relative(root,file)}: missing token ${match[1]}`);
}

const reserved=JSON.parse(fs.readFileSync(path.join(root,'tokens/reserved.json')));
const content=files(root).filter(f=>/\.(jsx|css|html)$/.test(f)&&!f.includes('/vendor/')).map(f=>fs.readFileSync(f,'utf8')).join('\n');
const references=new Set([...content.matchAll(/var\(\s*(--cs-[\w-]+)/g)].map(m=>m[1]));
for(const token of definitions)if(!references.has(token)&&!reserved[token])errors.push(`Unused token ${token}; connect it or document a reserved contract`);
const postcss=require('postcss');
for(const file of files(root).filter(f=>f.endsWith('.css')&&!f.includes('/vendor/'))){
 const tree=postcss.parse(fs.readFileSync(file,'utf8'),{from:file});
 tree.walkDecls(d=>{if(!file.includes('/tokens/')&&/^(gap|row-gap|column-gap|padding|margin)(-(top|bottom|left|right|block|inline))?$/.test(d.prop)&&/^(?:[\d.]+px|0)(?:\s+(?:[\d.]+px|0))*$/.test(d.value)&&/px/.test(d.value))errors.push(`${file}: raw layout spacing ${d.prop}`);if(d.value.includes('var(--cs-var('))errors.push(`${file}: malformed token reference`);});
}
// Conservative one-way drift guard for page composition CSS. Class hooks need not
// own styles. Literal fragments cover template prefixes; runtime DOM still needs QA.
function missingClasses(selector,source){
 const prefixes=[...source.matchAll(/\b((?:cs|cg|rd|aw)-[\w-]*)\$\{/g)].map(m=>m[1]);
 return [...selector.matchAll(/\.((?:cs|cg|rd|aw)-[\w-]+)/g)].map(m=>m[1]).filter(name=>!source.includes(name)&&!prefixes.some(prefix=>name.startsWith(prefix)));
}
assert.deepEqual(missingClasses('.rd-old .cs-button','<div className="cs-button"/>'),['rd-old']);
assert.deepEqual(missingClasses('.rd-row:hover','<div className="rd-row"/>'),[]);
assert.deepEqual(missingClasses('.rd-state-open','const x=`rd-state-${state}`'),[]);
const markup=files(root).filter(f=>/\.(jsx|html)$/.test(f)&&!f.includes('/vendor/')).map(f=>fs.readFileSync(f,'utf8')).join('\n');
const guardedCss = [
 ...files(path.join(root,'ui_kits')).filter(file=>file.endsWith('.css')),
 ...['composer.css','composer-gallery.css'].map(name=>path.join(root,'components/composer',name))
];
for(const file of guardedCss){
 postcss.parse(fs.readFileSync(file,'utf8')).walkRules(rule=>{
  for(const name of missingClasses(rule.selector,markup))errors.push(`${file}: selector has no source reference .${name}`);
 });
}
const ts=require('typescript'),registry=JSON.parse(fs.readFileSync(path.join(root,'components/registry.json')));
for(const item of [...registry.components,...registry.unexposedExports]){
 const file=path.join(root,item.sourcePath.replace(/\.jsx$/,'.d.ts'));
 const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
 const names=source.statements.flatMap(n=>n.name?[n.name.text]:n.declarationList?.declarations.map(d=>d.name.text)||[]);
 if(source.parseDiagnostics.length || !names.includes(item.name))errors.push(`${file}: missing or invalid exported declaration ${item.name}`);
}
const config=JSON.parse(fs.readFileSync(path.join(root,'_adherence.oxlintrc.json')));
assert.ok(config.rules['no-restricted-syntax'].some(r=>r.message?.startsWith('Raw hex')));
assert.ok(!config.rules['no-restricted-syntax'].some(r=>r.selector?.startsWith('JSXOpeningElement')),'Prop contracts come from .d.ts, never a stale duplicate lint list');

assert.deepEqual(errors,[],errors.join('\n'));
console.log('PASS source semantics, icons, colors, spacing, CSS syntax, token usage and exported declarations (13 rule fixtures; page CSS source-reference guard)');
