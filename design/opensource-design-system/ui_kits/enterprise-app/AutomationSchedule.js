/* Local design-preview schedule model. No timer, IPC or scheduler is started. */
(function (root) {
  const frequencies = {one_time:'不重复',daily:'每天',weekly:'每周',monthly:'每月'};
  const weekdays = ['周日','周一','周二','周三','周四','周五','周六'];
  const pad = n => String(n).padStart(2,'0');
  const localDate = date => `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
  function defaults(now = new Date()) { return {type:'daily',date:localDate(now),hour:9,minute:0,weekday:1,day:1}; }
  function validate(schedule) {
    if (!Object.hasOwn(frequencies,schedule.type) || !Number.isInteger(schedule.hour) || schedule.hour<0 || schedule.hour>23 || !Number.isInteger(schedule.minute) || schedule.minute<0 || schedule.minute>59) return '请填写完整的触发时间';
    if (schedule.type==='weekly' && (!Number.isInteger(schedule.weekday) || schedule.weekday<0 || schedule.weekday>6)) return '请选择每周的触发日期';
    if (schedule.type==='monthly' && (!Number.isInteger(schedule.day) || schedule.day<1 || schedule.day>31)) return '请选择每月的触发日期';
    if (schedule.type==='one_time') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(schedule.date || '')) return '请选择触发日期';
      const [year,month,day] = schedule.date.split('-').map(Number);
      const date = new Date(year,month-1,day,schedule.hour,schedule.minute);
      if (date.getFullYear()!==year || date.getMonth()!==month-1 || date.getDate()!==day) return '请选择有效的触发日期';
    }
    return '';
  }
  function format(schedule) {
    const time = `${pad(schedule.hour)}:${pad(schedule.minute)}`;
    if (schedule.type==='one_time') return `${schedule.date} ${time}`;
    if (schedule.type==='weekly') return `每${weekdays[schedule.weekday]} ${time}`;
    if (schedule.type==='monthly') return `${schedule.day===31?'月底':`每月 ${schedule.day} 日`} ${time}`;
    return `每天 ${time}`;
  }
  function makeTask(draft,id) {
    const message = draft.message.trim();
    return {id,message,title:draft.title.trim() || message.split(/\r?\n/)[0],enabled:!!draft.enabled,schedule:{...draft.schedule},mentions:draft.mentions.map(item=>({...item})),attachments:draft.attachments.map(item=>({...item})),device:'本机',runs:draft.runs || []};
  }
  const model = {frequencies,weekdays,defaults,validate,format,makeTask};
  if (typeof module !== 'undefined' && module.exports) module.exports = model;
  if (root) root.AutomationSchedule = model;
})(typeof window === 'undefined' ? null : window);
