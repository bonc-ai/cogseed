#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, re, sys
from pathlib import Path

ALLOWED_MAPPINGS = {"exact","narrower","broader","related","local extension","local_extension"}
ALLOWED_ROLES = {"semantic_backbone","code_system","exchange_format","event_telemetry","provenance_credential","governance_reference","local_mapping"}
UPPER = {"Party","Role","Agent","Goal","Situation","Capability","Service/Product","Process/Case","Task/Action","Resource/Asset","Information Object","Event","Decision","Policy/Rule/Constraint","Agreement/Commitment","Observation/Evidence","Risk/Control","Outcome","Measure/KPI","Episode/Learning","System/Interface"}


def load_json(path: Path):
    with path.open(encoding='utf-8') as f:
        return json.load(f)


def main() -> int:
    ap=argparse.ArgumentParser()
    ap.add_argument('input')
    ap.add_argument('--schema', default=None)
    ap.add_argument('--strict', action='store_true')
    ap.add_argument('--out', default=None)
    args=ap.parse_args()
    p=Path(args.input)
    try:
        data=load_json(p)
    except Exception as e:
        print(f'ERROR: cannot read JSON: {e}', file=sys.stderr); return 2

    errors=[]; warnings=[]; checks=[]
    def err(code,msg,loc=''): errors.append({'code':code,'message':msg,'location':loc})
    def warn(code,msg,loc=''): warnings.append({'code':code,'message':msg,'location':loc})
    def ok(code,msg): checks.append({'code':code,'message':msg})

    # JSON Schema if available.
    schema_path=Path(args.schema) if args.schema else Path(__file__).resolve().parents[1]/'schemas/report-data.schema.json'
    try:
        import jsonschema
        schema=load_json(schema_path)
        validator=jsonschema.Draft202012Validator(schema)
        for e in sorted(validator.iter_errors(data), key=lambda x:list(x.path)):
            err('SCHEMA', e.message, '/'.join(map(str,e.path)))
        if not any(x['code']=='SCHEMA' for x in errors): ok('SCHEMA','JSON Schema validation passed')
    except ImportError:
        warn('SCHEMA_TOOL','jsonschema not installed; manual checks only')
    except Exception as e:
        err('SCHEMA_LOAD',f'cannot load/execute schema: {e}',str(schema_path))

    required=["meta","executive_summary","policy_context","methodology","research_assurance","modules","stakeholders","systems","concepts","semantic_confusions","relations","processes","events","decisions","rules_constraints","risk_controls","kpis","standards","upper_mappings","agent_governance","closed_loops","kstar_mapping","architecture_boundaries","implementation_priorities","review_questions","workbook_fields","workbook_examples","sources","material_treatment"]
    for k in required:
        if k not in data: err('MISSING_SECTION',f'missing top-level section {k}',k)
    if errors and any(e['code']=='MISSING_SECTION' for e in errors):
        report={'status':'failed','errors':errors,'warnings':warnings,'checks':checks,'score':0}
        out=Path(args.out) if args.out else p.with_name(p.stem+'-validation.json'); out.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8'); print(json.dumps(report,ensure_ascii=False,indent=2)); return 1

    meta=data.get('meta',{})
    for f in ['volume_number','domain_name_cn','domain_name_en','report_version','research_date','title','output_filename']:
        if not str(meta.get(f,'')).strip(): err('META',f'meta.{f} is required',f'meta.{f}')
    if not re.match(r'^\d{4}-\d{2}-\d{2}$',str(meta.get('research_date',''))): warn('DATE','research_date should be YYYY-MM-DD','meta.research_date')
    if meta.get('status') not in {'candidate','reviewed','approved','deprecated','synthetic_fixture'}: err('STATUS','invalid meta.status','meta.status')
    if not str(meta.get('output_filename','')).endswith('.docx'): err('OUTPUT_NAME','output_filename must end in .docx','meta.output_filename')

    # Mandatory research-gate assurance. Direct Word generation without this pass is prohibited.
    assurance=data.get('research_assurance',{})
    if assurance.get('gate_status')!='passed': err('RESEARCH_GATE','research_assurance.gate_status must be passed','research_assurance/gate_status')
    if assurance.get('research_date')!=meta.get('research_date'): err('RESEARCH_DATE','research assurance date must match meta.research_date','research_assurance/research_date')
    if int(assurance.get('unresolved_conflicts',-1))!=0: err('RESEARCH_CONFLICTS','unresolved research conflicts must be zero','research_assurance/unresolved_conflicts')
    for f in ['research_plan_id','research_ledger_id','gate_report_ref']:
        if not str(assurance.get(f,'')).strip(): err('RESEARCH_FIELD',f'missing {f}',f'research_assurance/{f}')
    for f in ['queries_executed','opened_sources','verified_primary_sources','official_policy_sources','official_standard_sources']:
        try: n=int(assurance.get(f,0))
        except Exception: n=0
        if n<1: err('RESEARCH_COUNT',f'{f} must be >= 1',f'research_assurance/{f}')
    if not any(e['code'].startswith('RESEARCH') for e in errors): ok('RESEARCH_GATE','mandatory website-research/source-verification gate passed')

    # counts
    count_rules=[('concepts',20,40),('processes',5,10),('stakeholders',6,None),('systems',6,None),('relations',30,None),('standards',8,None),('closed_loops',3,None),('sources',5,None)]
    counts={}
    for k,lo,hi in count_rules:
        n=len(data.get(k,[])); counts[k]=n
        if n<lo: err('COUNT',f'{k} count {n} < {lo}',k)
        if hi is not None and n>hi: err('COUNT',f'{k} count {n} > {hi}',k)
    if counts.get('concepts',0)<40 and meta.get('status')!='synthetic_fixture': warn('TARGET','full report target is 40 concepts','concepts')
    if counts.get('processes',0)<8: warn('TARGET','full report target is 8 processes','processes')
    if counts.get('relations',0)<45: warn('TARGET','recommended relation count is 45–70','relations')

    # source IDs and refs.
    source_ids=[]
    for i,s in enumerate(data.get('sources',[])):
        sid=str(s.get('id',''))
        if not re.match(r'^[PSEIAR]\d+$',sid): err('SOURCE_ID',f'invalid source id {sid}',f'sources/{i}/id')
        source_ids.append(sid)
        for f in ['title','verification_status','usage']:
            if not str(s.get(f,'')).strip(): err('SOURCE_FIELD',f'missing {f}',f'sources/{i}/{f}')
        if sid.startswith(('P','S')):
            for f in ['organization','version_or_date','url_or_file']:
                if not str(s.get(f,'')).strip(): err('SOURCE_FIELD',f'external source {sid} missing {f}',f'sources/{i}/{f}')
            if s.get('verification_status') not in {'verified','verified_with_caveat','synthetic'}:
                err('SOURCE_VERIFY',f'external source {sid} is not verified',f'sources/{i}/verification_status')
    if len(source_ids)!=len(set(source_ids)): err('SOURCE_DUP','duplicate source IDs','sources')
    source_set=set(source_ids)

    def iter_refs(obj,path=''):
        if isinstance(obj,dict):
            for k,v in obj.items():
                q=f'{path}/{k}' if path else k
                if k=='source_refs':
                    for r in v or []: yield str(r),q
                else: yield from iter_refs(v,q)
        elif isinstance(obj,list):
            for i,v in enumerate(obj): yield from iter_refs(v,f'{path}/{i}')
    for ref,loc in iter_refs(data):
        if ref not in source_set: err('DANGLING_SOURCE',f'source ref {ref} not found',loc)

    # concepts.
    ids=[]; names=[]
    for i,c in enumerate(data.get('concepts',[])):
        cid=str(c.get('id','')).strip(); cn=str(c.get('name_cn','')).strip()
        if not cid or not cn: err('CONCEPT_FIELD','concept id/name missing',f'concepts/{i}')
        ids.append(cid); names.append(cn)
        if c.get('upper_parent') not in UPPER: err('UPPER_PARENT',f"invalid upper parent {c.get('upper_parent')}",f'concepts/{i}/upper_parent')
        if c.get('maturity') not in {'candidate','reviewed','approved','deprecated'}: err('MATURITY','invalid maturity',f'concepts/{i}/maturity')
        if not str(c.get('definition','')).strip(): err('CONCEPT_DEF','empty definition',f'concepts/{i}/definition')
    if len(ids)!=len(set(ids)): err('CONCEPT_DUP','duplicate concept IDs','concepts')
    if len(names)!=len(set(names)): warn('CONCEPT_NAME_DUP','duplicate Chinese concept names','concepts')

    # relation endpoints and concept coverage.
    stakeholder_names=set()
    for s in data.get('stakeholders',[]): stakeholder_names.add(str(s.get('party','')))
    system_names=set(str(s.get('system','')) for s in data.get('systems',[]))
    allowed_endpoints=set(names)|stakeholder_names|system_names|UPPER|{'通知','身份系统记录','专业人员','人工审批人','服务机构'}
    used=set()
    for i,r in enumerate(data.get('relations',[])):
        subj=str(r.get('subject','')); obj=str(r.get('object',''))
        if subj not in allowed_endpoints: warn('REL_ENDPOINT',f'unknown subject {subj}',f'relations/{i}/subject')
        if obj not in allowed_endpoints: warn('REL_ENDPOINT',f'unknown object {obj}',f'relations/{i}/object')
        used.update([subj,obj])
        if not str(r.get('predicate','')).strip(): err('REL_PRED','empty predicate',f'relations/{i}/predicate')
    unused=[n for n in names if n not in used and not any(n in str(p) for p in data.get('processes',[]))]
    if unused: warn('CONCEPT_UNUSED',f'{len(unused)} concepts not seen in relations/processes: '+', '.join(unused[:12]),'concepts')

    # standards.
    for i,s in enumerate(data.get('standards',[])):
        if s.get('role') not in ALLOWED_ROLES: err('STD_ROLE',f"invalid standard role {s.get('role')}",f'standards/{i}/role')
        if s.get('mapping_relation') not in ALLOWED_MAPPINGS: err('STD_MAPPING',f"invalid mapping {s.get('mapping_relation')}",f'standards/{i}/mapping_relation')
        for f in ['organization','version_or_date','coverage','reusable_concepts','backbone_recommendation','strengths','gaps','local_extension']:
            if not str(s.get(f,'')).strip(): err('STD_FIELD',f'missing {f}',f'standards/{i}/{f}')
        ext_refs=[str(r) for r in s.get('source_refs',[]) if str(r).startswith(('P','S'))]
        if not ext_refs: err('STD_SOURCE',f'standard {s.get("name",i)} lacks an official P/S source reference',f'standards/{i}/source_refs')

    # upper mapping coverage.
    mapped=set(str(x.get('upper_construct','')) for x in data.get('upper_mappings',[]))
    missing=sorted(UPPER-mapped)
    if missing: err('UPPER_COVERAGE','missing upper mappings: '+', '.join(missing),'upper_mappings')

    # KSTAR and governance.
    stages=set(str(x.get('stage','')) for x in data.get('kstar_mapping',[]))
    missing_stages={'K_C','K_R','K_A','K_G','K_F','K_L'}-stages
    if missing_stages: err('KSTAR','missing KSTAR stages: '+', '.join(sorted(missing_stages)),'kstar_mapping')
    gov=data.get('agent_governance',{})
    levels=set(x.get('level') for x in gov.get('autonomy_levels',[]))
    if levels != {'A0','A1','A2','A3','A4'}: err('AUTONOMY','autonomy levels must contain A0–A4 exactly','agent_governance/autonomy_levels')
    if not gov.get('human_final_decisions'): err('HITL','human_final_decisions missing','agent_governance')

    # semantic confusions and materials.
    if len(data.get('semantic_confusions',[]))<3: err('CONFUSIONS','at least three semantic confusion statements required','semantic_confusions')
    if not data.get('material_treatment'): err('MATERIAL_TREATMENT','material treatment is required','material_treatment')

    # score.
    score=max(0,100-len(errors)*8-len(warnings)*1.5)
    status='passed' if not errors else 'failed'
    report={'status':status,'strict':args.strict,'counts':counts,'errors':errors,'warnings':warnings,'checks':checks,'score':round(score,1)}
    out=Path(args.out) if args.out else p.with_name(p.stem+'-validation.json')
    out.parent.mkdir(parents=True,exist_ok=True); out.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2))
    if errors: return 1
    if args.strict and warnings: return 3
    return 0

if __name__=='__main__': raise SystemExit(main())
