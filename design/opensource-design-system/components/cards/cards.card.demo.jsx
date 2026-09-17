const { Card, CardFooter, CardGrid, ResourceCard, StatusDot, Button } = window.CogSeedDesignSystem_f581b5;
function Demo() {
  const [message, setMessage] = React.useState('');
  const [enabled, setEnabled] = React.useState(true);
  const [expanded, setExpanded] = React.useState(false);
  const [connected, setConnected] = React.useState(false);
  const [width, setWidth] = React.useState('100%');
  const note = text => () => setMessage(text);
  const status = (label, tone = 'idle') => <StatusDot tone={tone} label={label} />;
  return <main className="card-review">
    <h1>卡片 · 基础与变体</h1>
    <p className="review-intro">待确认设计：一套结构，工作空间、自动化、能力与模板四类变体。能力卡包含智能体、技能、连接三种内容。</p>
    <div className="review-toolbar" aria-label="显示宽度">
      {['100%', '800px', '360px'].map((value, i) => <Button key={value} size="sm" aria-pressed={width === value} onClick={() => setWidth(value)}>{['跟随窗口', '800px 内容区', '360px 内容区'][i]}</Button>)}
    </div>
    <p className="review-feedback" role="status">{message}</p>
    <div style={{width, maxWidth:'100%'}}>
      <section><h2>01 基础组件</h2><p className="review-caption">普通卡片最大 400px；横向卡最大 800px。网格最大 1232px，最多三列，窄窗口自动减列。</p>
        <CardGrid>
          <Card><h3 className="review-card-title">Card · 基础容器</h3><p className="review-copy">白底、12px 圆角、16px 内边距。只负责承载内容。</p><CardFooter><span className="review-copy">CardFooter · 分隔线与页脚</span></CardFooter></Card>
          <Card hoverable onClick={note('已选择卡片。')}><h3 className="review-card-title">Card · 可点击</h3><p className="review-copy">项目材料已整理，待核验。</p><CardFooter>{status('支持键盘操作')}</CardFooter></Card>
          <ResourceCard title="ResourceCard · 资源骨架" description="一至两行说明，回答这个对象能做什么。" status={status('状态 / 辅助信息')} action="查看详情" onAction={note('资源骨架：查看详情。')} />
        </CardGrid>
      </section>
      <section><h2>02 业务变体</h2><p className="review-caption">统一标题、说明和页脚位置；每张卡只保留一个主要动作。</p>
        <CardGrid>
          <ResourceCard variant="workspace" icon="space" title="产品研发" menu={{
            details: [{label:'类型',value:'复杂项目'},{label:'角色模板',value:'项目分析师'},{label:'技能',value:'4 项'},{label:'智能体',value:'3 个'}],
            groups: [{items:[{label:'重命名',onSelect:note('已选择重命名「产品研发」。')}]},{danger:true,items:[{label:'删除空间',onSelect:note('已选择删除空间。')}]}]
          }} description="项目调研、客户关联风险分析与交付后监测。" workspace={{updatedAt:'2 分钟前',roles:['项目分析师'],recentTask:'项目材料清单核验'}} onOpen={note('工作空间：查看「产品研发」详情。')} action="继续工作" onAction={note('工作空间：接续「项目材料清单核验」。')} />
          <ResourceCard variant="automation" icon="automation" title="每日项目到期提醒" description="核对未来 60 天到期项目，汇总待跟进客户清单。" control={<Button size="sm" aria-pressed={enabled} onClick={() => setEnabled(!enabled)}>{enabled ? '暂停' : '启用'}</Button>} status={status(enabled ? '已启用' : '已暂停', enabled ? 'success' : 'idle')} action="查看记录" onAction={note('已选择查看运行记录。')} />
          <ResourceCard icon="file" title="项目分析师" description="核验调研材料，整理风险线索并草拟审批意见。" status={status('可使用', 'success')} action="使用智能体" onAction={note('智能体：已选择「项目分析师」，可用于新任务。')} />
          <ResourceCard icon="file" title="项目报告口径核验" description="对照财务报表，标记口径差异与需要补充的材料。" status={status('已启用', 'success')} action="使用技能" onAction={note('技能：已选择「项目报告口径核验」。')} />
          <ResourceCard icon="database" title="项目台账" description="读取客户项目余额、到期日期与担保信息。" status={status(connected ? '已连接 · 已启用' : '未连接', connected ? 'success' : 'idle')} action={connected ? '使用连接' : '连接账户'} onAction={() => {setConnected(true);setMessage(connected ? '连接：已选择项目台账。' : '连接已完成。');}} />
          <ResourceCard variant="template" icon="file" title="月度进展简报" description="按月汇总业务数据，核验统计口径并生成简报。" status="使用后配置空间与执行时间" action="使用模板" onAction={note('模板：预填配置，尚未创建或启用自动化。')} />
        </CardGrid>
      </section>
      <section><h2>03 自动化 · 横向展开变体</h2><p className="review-caption">适合查看运行历史。宽度上限 800px，展开内容仍在卡片内部。</p>
        <ResourceCard variant="automation" layout="row" icon="automation" title="每日项目到期提醒" description="核对未来 60 天到期项目，汇总待跟进客户清单。" status={status('已启用', 'success')} automation={{schedule:'每天 09:00',lastRun:'今天 09:00',device:'此设备',runCount:2,expanded}} onToggleRuns={() => setExpanded(!expanded)}>
          {expanded && <div className="review-history"><p>今天 09:00 · 已完成 · 发现 8 户到期项目</p><p>昨天 09:00 · 已完成 · 发现 6 户到期项目</p></div>}
        </ResourceCard>
      </section>
      <section><h2>04 状态与长内容</h2><p className="review-caption">停用不等于连接异常；恢复动作由业务状态决定，不能只用一个开关表达。</p>
        <CardGrid>
          <ResourceCard title="项目台账" description="暂时无法访问服务，原有授权仍然保留。" status={status('连接异常', 'attention')} action="重试连接" onAction={note('正在重试连接。')} />
          <ResourceCard title="项目报告口径核验" description="启用后可在任务中选择此技能。" status={status('已停用')} action="使用技能" disabled />
          <ResourceCard title="项目资料" description="正在验证授权账户与服务可用性。" status={status('连接中')} action="连接账户" loading />
          <ResourceCard title="跨团队集团客户项目集中度与关联风险监测工作空间" description="用于核验长文本在受限窗口中的表现，标题允许换行，说明最多两行，操作按钮不被挤出卡片边界。" status={status('最近更新 12:40')} action="进入空间" onAction={note('长标题卡片：进入空间。')} />
        </CardGrid>
      </section>
    </div>
  </main>;
}
ReactDOM.createRoot(document.getElementById('root')).render(<Demo />);
